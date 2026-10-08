// ============================================
// Z-REPORT -- end-of-day cash count and cash adjustment
// ============================================
// Expected cash = the Cash in Hand (1111) balance in the general ledger at
// the end of the chosen day. Staff count the physical cash, type it in, and
// "Post" books the difference:
//   cash over  -> Dr 1111 Cash in Hand   / Cr 6190 Cash Over/Short
//   cash short -> Dr 6190 Cash Over/Short / Cr 1111 Cash in Hand
// as a journal entry dated the Z-report day. After that the 1111 balance
// equals the physical cash.
//
// All maths and posting happen in two database functions:
//   z_report_day(date)                     -> opening / in / out / expected + breakdown
//   post_z_report(date, counted, expected_seen, notes, denominations)
// post_z_report re-computes the expected cash itself and refuses to post if it
// no longer matches what the screen showed (e.g. a sale was made while counting),
// so a stale screen can never post a wrong adjustment. Every post is stored in
// the z_reports table (history + print).
// ============================================

(function initZReport() {
    console.log('Z-Report initializing...');

    if (typeof supabaseClient === 'undefined') {
        console.error('supabaseClient is not defined.');
        return;
    }

    const DENOMS = [200, 100, 50, 20, 10, 5, 2, 1, 0.5];

    const state = {
        date: null,
        day: null,        // result of z_report_day
        history: [],
        posting: false
    };

    const $ = (id) => document.getElementById(id);

    function esc(v) {
        return String(v == null ? '' : v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
    function fmt(n) {
        return (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    function money(n) { return 'K ' + fmt(n); }
    function todayKey() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    function prettyDate(key) {
        if (!key) return '';
        const d = new Date(key + 'T00:00:00');
        return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    }
    function toast(msg, isErr) {
        const t = document.createElement('div');
        t.className = 'zrep-toast' + (isErr ? ' err' : '');
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(() => t.remove(), isErr ? 6000 : 3500);
    }

    // ------------------------------------------------
    // Denomination grid
    // ------------------------------------------------
    function buildDenomGrid() {
        $('zrepDenomBody').innerHTML = DENOMS.map(d => `
            <tr>
                <td>${d >= 1 ? 'K ' + d : (d * 100) + ' ngwee'}</td>
                <td><input type="number" min="0" step="1" data-denom="${d}" placeholder="0"></td>
                <td class="zrep-num" id="zrepDenomAmt_${String(d).replace('.', '_')}">0.00</td>
            </tr>`).join('');
        $('zrepDenomBody').querySelectorAll('input[data-denom]').forEach(inp => {
            inp.addEventListener('input', onDenomChange);
        });
    }

    function readDenoms() {
        const out = {};
        let any = false;
        $('zrepDenomBody').querySelectorAll('input[data-denom]').forEach(inp => {
            const qty = parseInt(inp.value, 10);
            if (qty > 0) { out[inp.dataset.denom] = qty; any = true; }
        });
        return any ? out : null;
    }

    function onDenomChange() {
        let total = 0;
        let any = false;
        $('zrepDenomBody').querySelectorAll('input[data-denom]').forEach(inp => {
            const d = parseFloat(inp.dataset.denom);
            const qty = Math.max(0, parseInt(inp.value, 10) || 0);
            if (qty > 0) any = true;
            const amt = round2(d * qty);
            total += amt;
            const cell = $('zrepDenomAmt_' + String(inp.dataset.denom).replace('.', '_'));
            if (cell) cell.textContent = fmt(amt);
        });
        if (any) $('zrepCounted').value = round2(total).toFixed(2);
        else $('zrepCounted').value = '';
        refreshDiff();
    }

    function onCountedTyped() {
        // A typed total replaces the note/coin breakdown.
        $('zrepDenomBody').querySelectorAll('input[data-denom]').forEach(inp => { inp.value = ''; });
        $('zrepDenomBody').querySelectorAll('td[id^="zrepDenomAmt_"]').forEach(td => { td.textContent = '0.00'; });
        refreshDiff();
    }

    function numField(id) {
        const raw = $(id).value;
        if (raw === '' || raw == null) return null;
        const n = parseFloat(raw);
        return isFinite(n) && n >= 0 ? round2(n) : null;
    }
    function cashValue() { return numField('zrepCounted'); }
    function airtelValue() { return numField('zrepAirtel'); }

    // Total physical count = cash (notes & coins) + Airtel Money balance.
    // Airtel Money receipts are booked into Cash in Hand (1111) by the sale
    // posting, so the Z-report compares the combined count with that account.
    function countedValue() {
        const c = cashValue(), a = airtelValue();
        if (c === null && a === null) return null;
        return round2((c || 0) + (a || 0));
    }

    // ------------------------------------------------
    // Difference box
    // ------------------------------------------------
    function refreshDiff() {
        const box = $('zrepDiffBox');
        const counted = countedValue();
        box.classList.remove('zrep-balanced', 'zrep-over', 'zrep-short');
        const btn = $('zrepPostBtn');
        $('zrepTotalCounted').textContent = money(countedValue() || 0);

        if (!state.day || counted === null) {
            $('zrepDiffValue').textContent = 'K 0.00';
            $('zrepDiffMsg').textContent = 'Enter the counted cash to see the difference.';
            btn.disabled = true;
            return;
        }
        const diff = round2(counted - round2(state.day.expected));
        $('zrepDiffValue').textContent = (diff > 0 ? '+' : diff < 0 ? '-' : '') + 'K ' + fmt(Math.abs(diff));
        if (diff === 0) {
            box.classList.add('zrep-balanced');
            $('zrepDiffMsg').textContent = 'Cash balances -- nothing to adjust. Posting just records the Z-report.';
        } else if (diff > 0) {
            box.classList.add('zrep-over');
            $('zrepDiffMsg').textContent = `Cash OVER by K ${fmt(diff)} -- will be added to Cash in Hand (credit 6190 Cash Over/Short).`;
        } else {
            box.classList.add('zrep-short');
            $('zrepDiffMsg').textContent = `Cash SHORT by K ${fmt(-diff)} -- will be deducted from Cash in Hand (debit 6190 Cash Over/Short).`;
        }
        btn.disabled = state.posting;
    }

    // ------------------------------------------------
    // Load day
    // ------------------------------------------------
    async function loadDay() {
        const date = $('zrepDate').value;
        if (!date) { toast('Pick a date first.', true); return; }
        const btn = $('zrepLoadBtn');
        btn.disabled = true;
        try {
            const { data, error } = await supabaseClient.rpc('z_report_day', { p_date: date });
            if (error) throw error;
            state.date = date;
            state.day = data;
            renderDay();
            await loadHistory();
        } catch (e) {
            console.error('Z-Report load failed:', e);
            toast('Could not load the Z-report: ' + (e.message || e), true);
        } finally {
            btn.disabled = false;
        }
    }

    function renderDay() {
        const d = state.day;
        $('zrepOpening').textContent = money(d.opening);
        $('zrepIn').textContent = money(d.cash_in);
        $('zrepOut').textContent = money(d.cash_out);
        $('zrepExpected').textContent = money(d.expected);

        const lines = d.lines || [];
        $('zrepInSub').textContent = lines.filter(l => Number(l.cash_in) > 0).length + ' receipt(s)';
        $('zrepOutSub').textContent = lines.filter(l => Number(l.cash_out) > 0).length + ' payment(s)';
        $('zrepMoveCount').textContent = lines.length + (lines.length === 1 ? ' entry on ' : ' entries on ') + prettyDate(state.date);

        const sum = d.summary || [];
        $('zrepSummaryBody').innerHTML = sum.length ? sum.map(s => `
            <tr>
                <td>${esc(s.counter_name || 'Other')} <span class="zrep-muted">${esc(s.counter_code || '')}</span></td>
                <td class="zrep-num">${s.count}</td>
                <td class="zrep-num ${Number(s.cash_in) ? 'zrep-in-val' : 'zrep-muted'}">${Number(s.cash_in) ? fmt(s.cash_in) : '-'}</td>
                <td class="zrep-num ${Number(s.cash_out) ? 'zrep-out-val' : 'zrep-muted'}">${Number(s.cash_out) ? fmt(s.cash_out) : '-'}</td>
            </tr>`).join('') : `<tr><td colspan="4" class="zrep-empty">No cash movements on this date.</td></tr>`;

        $('zrepDetailBody').innerHTML = lines.length ? lines.map(l => `
            <tr>
                <td>${esc(l.reference || '')}</td>
                <td>${esc(l.description || '')}</td>
                <td>${esc(l.counter_name || '')}</td>
                <td class="zrep-num ${Number(l.cash_in) ? 'zrep-in-val' : 'zrep-muted'}">${Number(l.cash_in) ? fmt(l.cash_in) : '-'}</td>
                <td class="zrep-num ${Number(l.cash_out) ? 'zrep-out-val' : 'zrep-muted'}">${Number(l.cash_out) ? fmt(l.cash_out) : '-'}</td>
            </tr>`).join('') : `<tr><td colspan="5" class="zrep-empty">Nothing to show.</td></tr>`;

        // Notice: past date / already counted
        const notes = [];
        if (state.date < todayKey()) {
            notes.push('Expected cash is the balance at the end of ' + prettyDate(state.date) + '.');
        }
        $('zrepNotice').textContent = notes.join(' ');

        // Fresh count for this load
        $('zrepCounted').value = '';
        $('zrepAirtel').value = '';
        $('zrepNotes').value = '';
        $('zrepDenomBody').querySelectorAll('input[data-denom]').forEach(inp => { inp.value = ''; });
        $('zrepDenomBody').querySelectorAll('td[id^="zrepDenomAmt_"]').forEach(td => { td.textContent = '0.00'; });
        refreshDiff();
    }

    // ------------------------------------------------
    // History
    // ------------------------------------------------
    async function loadHistory() {
        try {
            const { data, error } = await supabaseClient
                .from('z_reports')
                .select('*')
                .order('created_at', { ascending: false })
                .limit(40);
            if (error) throw error;
            state.history = data || [];
        } catch (e) {
            console.error('Z-Report history failed:', e);
            state.history = [];
        }
        renderHistory();
        const sameDay = state.history.filter(h => h.report_date === state.date);
        if (sameDay.length) {
            const extra = `A Z-report (${sameDay[0].z_number}) is already posted for this date; the expected cash above already includes its adjustment.`;
            $('zrepNotice').textContent = ($('zrepNotice').textContent + ' ' + extra).trim();
        }
    }

    function renderHistory() {
        const body = $('zrepHistoryBody');
        if (!state.history.length) {
            body.innerHTML = `<tr><td colspan="8" class="zrep-empty">No Z-reports posted yet.</td></tr>`;
            return;
        }
        body.innerHTML = state.history.map(h => {
            const diff = Number(h.difference);
            const badge = diff === 0 ? '<span class="zrep-badge bal">Balanced</span>'
                : diff > 0 ? '<span class="zrep-badge over">Over</span>' : '<span class="zrep-badge short">Short</span>';
            const posted = h.created_at ? new Date(h.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
            return `
            <tr>
                <td><strong>${esc(h.z_number)}</strong></td>
                <td>${esc(prettyDate(h.report_date))}</td>
                <td class="zrep-num">${fmt(h.expected_cash)}</td>
                <td class="zrep-num">${fmt(h.counted_cash)}</td>
                <td class="zrep-num">${diff > 0 ? '+' : ''}${fmt(diff)} ${badge}</td>
                <td>${h.denominations && Number(h.denominations.airtel) ? '<span class="zrep-muted">Cash ' + fmt(h.denominations.cash) + ' + Airtel ' + fmt(h.denominations.airtel) + '</span><br>' : ''}${esc(h.notes || '')}</td>
                <td>${esc(posted)}</td>
                <td><button class="zrep-link-btn" data-print="${esc(h.id)}"><i class="fa-solid fa-print"></i> Print</button></td>
            </tr>`;
        }).join('');
        body.querySelectorAll('button[data-print]').forEach(b => {
            b.addEventListener('click', () => {
                const row = state.history.find(h => h.id === b.dataset.print);
                if (row) printSlip(slipFromRow(row));
            });
        });
    }

    // ------------------------------------------------
    // Post
    // ------------------------------------------------
    async function postZReport() {
        if (state.posting || !state.day) return;
        const counted = countedValue();
        if (counted === null) { toast('Enter the counted cash first.', true); return; }
        const expected = round2(state.day.expected);
        const diff = round2(counted - expected);
        const msg = `Post Z-report for ${prettyDate(state.date)}?\n\n` +
            `System cash:   K ${fmt(expected)}\n` +
            `Counted:       K ${fmt(counted)}  (cash K ${fmt(cashValue() || 0)} + Airtel K ${fmt(airtelValue() || 0)})\n` +
            `Difference:    ${diff > 0 ? '+' : diff < 0 ? '-' : ''}K ${fmt(Math.abs(diff))}\n\n` +
            (diff === 0 ? 'No adjustment is needed.' :
                `Cash in Hand will be ${diff > 0 ? 'increased' : 'reduced'} by K ${fmt(Math.abs(diff))} (Cash Over/Short).`);
        if (!window.confirm(msg)) return;

        state.posting = true;
        $('zrepPostBtn').disabled = true;
        const notes = $('zrepNotes').value.trim();
        const denoms = { notes: readDenoms(), cash: cashValue() || 0, airtel: airtelValue() || 0 };
        const snapshot = {
            date: state.date, opening: state.day.opening, cash_in: state.day.cash_in, cash_out: state.day.cash_out,
            expected, counted, diff, notes, denoms, summary: state.day.summary || []
        };
        try {
            const { data, error } = await supabaseClient.rpc('post_z_report', {
                p_date: state.date,
                p_counted: counted,
                p_expected_seen: expected,
                p_notes: notes || null,
                p_denominations: denoms
            });
            if (error) throw error;
            snapshot.z_number = data.z_number;
            toast(`${data.z_number} posted` + (data.difference === 0 ? ' -- cash balanced.' : ` -- cash adjusted by ${data.difference > 0 ? '+' : '-'}K ${fmt(Math.abs(data.difference))}.`));
            await loadDay();
            if (window.confirm('Z-report posted. Print the slip now?')) printSlip(snapshot);
        } catch (e) {
            console.error('Z-Report post failed:', e);
            toast('Not posted: ' + (e.message || e), true);
            // The screen may be stale -- reload the figures but keep what was typed
            const keepCounted = $('zrepCounted').value, keepAirtel = $('zrepAirtel').value, keepNotes = $('zrepNotes').value;
            await loadDay();
            $('zrepCounted').value = keepCounted; $('zrepAirtel').value = keepAirtel; $('zrepNotes').value = keepNotes;
            refreshDiff();
        } finally {
            state.posting = false;
            refreshDiff();
        }
    }

    // ------------------------------------------------
    // Printing
    // ------------------------------------------------
    function slipFromRow(h) {
        return {
            z_number: h.z_number, date: h.report_date, opening: h.opening_cash, cash_in: h.cash_in, cash_out: h.cash_out,
            expected: h.expected_cash, counted: h.counted_cash, diff: h.difference, notes: h.notes, denoms: h.denominations, summary: null
        };
    }

    function currentSlip() {
        const counted = countedValue();
        if (!state.day) return null;
        const expected = round2(state.day.expected);
        return {
            z_number: null, date: state.date, opening: state.day.opening, cash_in: state.day.cash_in, cash_out: state.day.cash_out,
            expected, counted, diff: counted === null ? null : round2(counted - expected),
            notes: $('zrepNotes').value.trim(), denoms: { notes: readDenoms(), cash: cashValue() || 0, airtel: airtelValue() || 0 }, summary: state.day.summary || []
        };
    }

    function printSlip(s) {
        if (!s) return;
        const dn = (s.denoms && s.denoms.notes) || null;
        const cashPart = s.denoms ? Number(s.denoms.cash || 0) : null;
        const airtelPart = s.denoms ? Number(s.denoms.airtel || 0) : null;
        const denomRows = dn ? Object.keys(dn).sort((a, b) => b - a).map(k => {
            const qty = dn[k];
            return `<tr><td>${Number(k) >= 1 ? 'K ' + k : (k * 100) + ' ngwee'}</td><td class="r">${qty}</td><td class="r">${fmt(Number(k) * qty)}</td></tr>`;
        }).join('') : '';
        const sumRows = (s.summary || []).map(x => `
            <tr><td>${esc(x.counter_name || 'Other')}</td><td class="r">${Number(x.cash_in) ? fmt(x.cash_in) : '-'}</td><td class="r">${Number(x.cash_out) ? fmt(x.cash_out) : '-'}</td></tr>`).join('');
        const diff = s.diff;
        const diffLabel = diff === null ? '-' : diff === 0 ? 'Balanced' : (diff > 0 ? 'Over +' : 'Short -') + 'K ' + fmt(Math.abs(diff));
        const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(s.z_number || 'Z-Report')}</title>
<style>
 body{font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#111;margin:24px;max-width:420px}
 h2{margin:0 0 2px;font-size:16px} .sub{color:#555;margin-bottom:12px}
 table{width:100%;border-collapse:collapse;margin:6px 0 12px}
 th{font-size:10px;text-transform:uppercase;text-align:left;border-bottom:1px solid #999;padding:3px 0}
 td{padding:3px 0;border-bottom:1px dotted #ccc} .r{text-align:right} th.r{text-align:right}
 .tot td{font-weight:bold;border-top:1px solid #111;border-bottom:none}
 .sig{margin-top:34px;display:flex;justify-content:space-between} .sig div{width:45%;border-top:1px solid #111;padding-top:3px;font-size:10px}
</style></head><body>
<h2>Z-Report ${s.z_number ? '&ndash; ' + esc(s.z_number) : '(draft -- not posted)'}</h2>
<div class="sub">Date: ${esc(prettyDate(s.date))} &nbsp;|&nbsp; Account: Cash in Hand (1111)</div>
<table>
 <tr><td>Opening cash</td><td class="r">${fmt(s.opening)}</td></tr>
 <tr><td>Cash in</td><td class="r">${fmt(s.cash_in)}</td></tr>
 <tr><td>Cash out</td><td class="r">${fmt(s.cash_out)}</td></tr>
 <tr class="tot"><td>Expected cash (system)</td><td class="r">${fmt(s.expected)}</td></tr>
 ${cashPart !== null ? `<tr><td>&nbsp;&nbsp;Cash (notes &amp; coins)</td><td class="r">${fmt(cashPart)}</td></tr><tr><td>&nbsp;&nbsp;Airtel Money</td><td class="r">${fmt(airtelPart)}</td></tr>` : ''}
 <tr><td>Total counted (physical)</td><td class="r">${s.counted === null ? '-' : fmt(s.counted)}</td></tr>
 <tr class="tot"><td>Difference</td><td class="r">${esc(diffLabel)}</td></tr>
</table>
${sumRows ? `<table><tr><th>Source / use</th><th class="r">In</th><th class="r">Out</th></tr>${sumRows}</table>` : ''}
${denomRows ? `<table><tr><th>Note / coin</th><th class="r">Qty</th><th class="r">Amount</th></tr>${denomRows}</table>` : ''}
${s.notes ? `<div><strong>Notes:</strong> ${esc(s.notes)}</div>` : ''}
<div class="sig"><div>Counted by</div><div>Checked by</div></div>
</body></html>`;

        const frame = document.createElement('iframe');
        frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
        document.body.appendChild(frame);
        const doc = frame.contentWindow.document;
        doc.open(); doc.write(html); doc.close();
        setTimeout(() => {
            try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch (e) { console.error(e); }
            setTimeout(() => frame.remove(), 2000);
        }, 250);
    }

    // ------------------------------------------------
    // INIT
    // ------------------------------------------------
    (function init() {
        try {
            buildDenomGrid();
            $('zrepDate').value = todayKey();
            $('zrepDate').max = todayKey();
            $('zrepLoadBtn').addEventListener('click', loadDay);
            $('zrepDate').addEventListener('change', loadDay);
            $('zrepCounted').addEventListener('input', onCountedTyped);
            $('zrepAirtel').addEventListener('input', refreshDiff);
            $('zrepPostBtn').addEventListener('click', postZReport);
            $('zrepPrintDraftBtn').addEventListener('click', () => {
                const s = currentSlip();
                if (!s) { toast('Load a date first.', true); return; }
                printSlip(s);
            });
            $('zrepDetailToggle').addEventListener('click', () => {
                const w = $('zrepDetailWrap');
                const open = w.style.display === 'none';
                w.style.display = open ? 'block' : 'none';
                $('zrepDetailToggle').innerHTML = open
                    ? '<i class="fa-solid fa-chevron-up"></i> Hide entries'
                    : '<i class="fa-solid fa-chevron-down"></i> Show every entry';
            });
            loadDay();
            console.log('Z-Report initialized.');
        } catch (e) {
            console.error('Error loading Z-Report:', e);
        }
    })();
})();
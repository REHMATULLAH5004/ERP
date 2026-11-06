// ============================================
// NHIMA AMOUNT CHECK (Report > NHIMA Amount Check)
// ============================================
// Lists every NHIMA invoice in the ERP and, next to it, the Gross Amount NHIMA
// itself shows for the same claim number. The NHIMA amount comes from the
// nhima_claim_results table (filled automatically by the Griffins NHIMA Chrome
// helper). If the helper never saw a claim, the amount staff typed on the Retail
// page (sales.payment.nhima_gross_amount) is used instead.
//
// Result per invoice:
//   OK                 - ERP total equals NHIMA gross (within K0.01)
//   MISMATCH           - the two amounts differ
//   NOT SEEN ON NHIMA  - claim number is in the ERP, but NHIMA has no such claim
//                        (typo in the claim number, or the helper was not running)
//   BYPASS ONLY        - bypass number only, real claim number not added yet
// Member check compares the member + dependant code on NHIMA with the invoice's.
// The second table shows claims NHIMA has but the ERP has no invoice for.
// ============================================
(function initNhimaAmountCheck() {
    if (typeof supabaseClient === 'undefined') { console.error('supabaseClient is not defined.'); return; }
    const $ = (id) => document.getElementById(id);
    if (!$('nacBody')) return;

    const state = { rows: [], orphans: [], filter: 'ALL' };

    const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const fmt = (n) => (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
    const key = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const when = (iso) => iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };

    function setDefaults() {
        const to = new Date(); const from = new Date(); from.setDate(from.getDate() - 6);
        $('nacFrom').value = key(from); $('nacTo').value = key(to);
    }

    async function load() {
        $('nacBody').innerHTML = '<tr><td colspan="9" class="nac-empty">Loading...</td></tr>';
        $('nacOrphans').innerHTML = '<tr><td colspan="5" class="nac-empty">Loading...</td></tr>';
        const fromD = new Date($('nacFrom').value + 'T00:00:00');
        const toD = new Date($('nacTo').value + 'T00:00:00'); toD.setDate(toD.getDate() + 1);
        if (isNaN(fromD) || isNaN(toD)) { $('nacBody').innerHTML = '<tr><td colspan="9" class="nac-empty">Pick a From and To date.</td></tr>'; return; }

        const { data: sales, error } = await supabaseClient.from('sales')
            .select('sale_id, created_at, status, claim_number, bypass_number, grand_total, customer_data, payment')
            .eq('client_sub_type', 'NHIMA').neq('is_quotation', true)
            .gte('created_at', fromD.toISOString()).lt('created_at', toD.toISOString())
            .order('created_at', { ascending: false }).limit(2000);
        if (error) { $('nacBody').innerHTML = '<tr><td colspan="9" class="nac-empty">Could not load: ' + esc(error.message) + '</td></tr>'; return; }

        const claimNos = [...new Set((sales || []).map(s => s.claim_number).filter(Boolean))];
        const nhimaMap = {};
        for (const part of chunk(claimNos, 150)) {
            const { data } = await supabaseClient.from('nhima_claim_results').select('*').in('claim_number', part);
            (data || []).forEach(r => { nhimaMap[r.claim_number] = r; });
        }

        state.rows = (sales || []).map(s => {
            const n = nhimaMap[s.claim_number];
            const typed = s.payment && s.payment.nhima_gross_amount != null ? Number(s.payment.nhima_gross_amount) : null;
            const erp = r2(s.grand_total);
            let nhima = null, src = '';
            if (n) { nhima = r2(n.gross_amount); src = 'NHIMA'; } else if (typed != null) { nhima = r2(typed); src = 'typed'; }
            let result;
            if (!s.claim_number) result = 'BYPASS';
            else if (!n && typed == null) result = 'NOTSEEN';
            else result = Math.abs(erp - nhima) <= 0.01 ? 'OK' : 'MISMATCH';
            const ermember = String((s.customer_data && s.customer_data.nhima_number) || '');
            let member = '';
            if (n && n.member_number) {
                const nm = n.member_number + '/' + (n.dependant_code || '00');
                const same = ermember.replace(/\s+/g, '') === nm;
                member = same ? 'OK' : 'DIFF';
                var nhimaMember = nm;
            }
            return { s, n, erp, nhima, src, diff: nhima == null ? null : r2(erp - nhima), result, ermember, member, nhimaMember: member ? nhimaMember : '' };
        });

        // claims NHIMA has in this period that the ERP has no invoice for
        const { data: nh } = await supabaseClient.from('nhima_claim_results').select('*')
            .gte('claim_time', fromD.toISOString()).lt('claim_time', toD.toISOString()).order('claim_time', { ascending: false }).limit(2000);
        const inRange = new Set(claimNos);
        let cand = (nh || []).filter(r => !inRange.has(r.claim_number));
        const found = new Set();
        for (const part of chunk(cand.map(r => r.claim_number), 150)) {
            const { data } = await supabaseClient.from('sales').select('claim_number').in('claim_number', part);
            (data || []).forEach(x => found.add(x.claim_number));
        }
        state.orphans = cand.filter(r => !found.has(r.claim_number));
        render();
    }

    function pill(r) {
        return { OK: '<span class="nac-pill ok">OK</span>', MISMATCH: '<span class="nac-pill bad">MISMATCH</span>',
            NOTSEEN: '<span class="nac-pill warn">NOT SEEN ON NHIMA</span>', BYPASS: '<span class="nac-pill grey">BYPASS ONLY</span>' }[r];
    }

    function visibleRows() {
        const q = ($('nacSearch').value || '').trim().toLowerCase();
        return state.rows.filter(x => {
            if (state.filter === 'MEMBER') { if (x.member !== 'DIFF') return false; }
            else if (state.filter !== 'ALL' && x.result !== state.filter) return false;
            if (!q) return true;
            const c = x.s.customer_data || {};
            return [x.s.sale_id, x.s.claim_number, x.s.bypass_number, c.full_name, x.ermember].join(' ').toLowerCase().includes(q);
        });
    }

    function render() {
        const rows = state.rows;
        const cnt = (f) => rows.filter(f).length;
        const tiles = [
            ['ALL', 'All NHIMA invoices', rows.length, ''],
            ['OK', 'Amounts match', cnt(x => x.result === 'OK'), 'good'],
            ['MISMATCH', 'Amount mismatch', cnt(x => x.result === 'MISMATCH'), 'bad'],
            ['NOTSEEN', 'Not seen on NHIMA', cnt(x => x.result === 'NOTSEEN'), 'warn'],
            ['MEMBER', 'Member / dependant differs', cnt(x => x.member === 'DIFF'), 'warn'],
            ['BYPASS', 'Bypass only (no claim yet)', cnt(x => x.result === 'BYPASS'), '']
        ];
        $('nacTiles').innerHTML = tiles.map(t => `<div class="nac-tile ${t[3]} ${state.filter === t[0] ? 'on' : ''}" data-f="${t[0]}"><div class="n">${t[2]}</div><div class="t">${t[1]}</div></div>`).join('');
        $('nacTiles').querySelectorAll('.nac-tile').forEach(el => el.onclick = () => { state.filter = el.dataset.f; render(); });

        const vis = visibleRows();
        $('nacBody').innerHTML = vis.length ? vis.map(x => {
            const c = x.s.customer_data || {};
            const cls = x.result === 'MISMATCH' ? 'nac-bad' : (x.result === 'NOTSEEN' || x.member === 'DIFF' ? 'nac-warn' : '');
            const diffTxt = x.diff == null ? '' : (x.diff === 0 ? '0.00' : (x.diff > 0 ? '+' : '') + fmt(x.diff));
            const memTxt = x.member === 'DIFF' ? `<span class="nac-pill warn">DIFFERENT</span><div class="nac-sub">ERP ${esc(x.ermember)}<br>NHIMA ${esc(x.nhimaMember)}</div>` : (x.member === 'OK' ? '<span class="nac-sub">OK</span>' : '<span class="nac-sub">-</span>');
            return `<tr class="${cls}"><td>${esc(when(x.s.created_at))}</td><td>${esc(x.s.sale_id)}</td><td>${esc(c.full_name || '')}<div class="nac-sub">${esc(x.ermember)}</div></td>
                <td>${esc(x.s.claim_number || (x.s.bypass_number ? 'Bypass ' + x.s.bypass_number : '-'))}</td>
                <td class="r">${fmt(x.erp)}</td><td class="r">${x.nhima == null ? '-' : fmt(x.nhima)}${x.src === 'typed' ? '<div class="nac-sub">typed by staff</div>' : ''}</td>
                <td class="r"><b>${diffTxt}</b></td><td>${pill(x.result)}</td><td>${memTxt}</td></tr>`;
        }).join('') : '<tr><td colspan="9" class="nac-empty">Nothing to show for this filter.</td></tr>';

        $('nacOrphans').innerHTML = state.orphans.length ? state.orphans.map(r =>
            `<tr class="nac-warn"><td>${esc(when(r.claim_time))}</td><td>${esc(r.claim_number)}</td><td>${esc(r.member_number)}/${esc(r.dependant_code || '')}</td><td class="r">${fmt(r.gross_amount)}</td>
             <td class="nac-sub">${esc((r.items || []).map(i => i.name).filter(Boolean).join('; ').slice(0, 160))}</td></tr>`).join('')
            : '<tr><td colspan="5" class="nac-empty">None. Every claim NHIMA has in this period has an ERP invoice.</td></tr>';
    }

    function exportCsv() {
        const lines = [['Invoice time', 'Invoice', 'Patient', 'ERP member', 'Claim number', 'ERP amount', 'NHIMA amount', 'Difference', 'Result', 'Member check', 'NHIMA member']];
        visibleRows().forEach(x => lines.push([x.s.created_at, x.s.sale_id, (x.s.customer_data || {}).full_name || '', x.ermember, x.s.claim_number || '', x.erp, x.nhima == null ? '' : x.nhima, x.diff == null ? '' : x.diff, x.result, x.member, x.nhimaMember]));
        const csv = lines.map(l => l.map(v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"').join(',')).join('\r\n');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
        a.download = 'NHIMA_Amount_Check_' + $('nacFrom').value + '_to_' + $('nacTo').value + '.csv';
        a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }

    setDefaults();
    $('nacApply').onclick = load; $('nacRefresh').onclick = load; $('nacExport').onclick = exportCsv;
    $('nacSearch').oninput = () => render();
    load();
})();

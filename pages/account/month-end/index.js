// ============================================
// MONTH-END RECORDS MODULE
// Bank statements + reconciliation, filed returns, collection notes,
// accruals & prepayments. Needs sql/03_month_end_records.sql run once.
// ============================================
(async function initMonthEnd() {
    console.log('Month-End Records initializing...');
    if (typeof supabaseClient === 'undefined') { console.error('supabaseClient is not defined.'); return; }
    if (!document.getElementById('monthEndRoot')) return;

    const $ = id => document.getElementById(id);
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const num = v => Number(v) || 0;
    const r2 = v => Math.round(num(v) * 100) / 100;
    const fmt = v => num(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const monthEnd = ym => { const [y, m] = ym.split('-').map(Number); return ymd(new Date(y, m, 0)); };
    const addMonths = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };
    const today = ymd(new Date());
    const thisMonth = today.slice(0, 7);

    const EXPENSE_ACCOUNTS = [
        ['6101', 'Administrative'], ['6102', 'Utilities'], ['6103', 'Rent'], ['6105', 'Office Supplies'], ['6106', 'Maintenance'],
        ['6107', 'Transport'], ['6108', 'Marketing'], ['6109', 'Insurance'], ['6110', 'Licenses'], ['6111', 'Professional Fees'],
        ['6112', 'Bank Charges'], ['6199', 'Other']
    ];
    $('meAcExp').innerHTML = EXPENSE_ACCOUNTS.map(a => `<option value="${a[0]}">${a[1]} (${a[0]})</option>`).join('');
    $('meBankDate').value = today;
    $('meRetMonth').value = addMonths(thisMonth, -1);
    $('meAcStart').value = thisMonth;
    $('meRelMonth').value = thisMonth;

    function warn(msg) { const w = $('meSetupWarning'); w.style.display = 'block'; w.innerHTML = msg; }
    function dbError(e) {
        console.error(e);
        if (e && (e.code === '42P01' || /does not exist|schema cache/i.test(e.message || ''))) {
            warn('<i class="fa-solid fa-triangle-exclamation"></i> The tables for this page are not created yet. Run <strong>03_month_end_records.sql</strong> once in the Supabase SQL Editor, then reload.');
        } else {
            alert('Error: ' + (e && e.message ? e.message : e));
        }
    }

    // ---------- tabs ----------
    window.meShowTab = function (tab) {
        document.querySelectorAll('.me-pane').forEach(p => p.style.display = 'none');
        $('meTab_' + tab).style.display = 'block';
        document.querySelectorAll('.me-tab').forEach(b => { b.classList.toggle('btn-primary', b.dataset.tab === tab); b.classList.toggle('btn-outline', b.dataset.tab !== tab); });
        if (tab === 'bank') loadBank(); if (tab === 'returns') loadReturns(); if (tab === 'collect') loadNotes(); if (tab === 'accr') loadAccruals();
    };

    // ============================================
    // BANK STATEMENTS
    // ============================================
    let bankCache = { stmts: [], items: [] };

    async function bookBalanceAt(code, date) {
        const { data, error } = await supabaseClient.rpc('account_balance_at', { p_code: code, p_date: date });
        if (error) throw error;
        return num(data);
    }
    function reconcile(stmt, items, book) {
        const stmtSide = ['Deposit in transit', 'Cheque / payment not yet cleared', 'Other'];
        const open = items.filter(i => !i.cleared);
        const adjStmt = r2(num(stmt.statement_balance) + open.filter(i => stmtSide.includes(i.item_type)).reduce((s, i) => s + num(i.amount), 0));
        const adjBook = r2(book + open.filter(i => !stmtSide.includes(i.item_type)).reduce((s, i) => s + num(i.amount), 0));
        return { adjStmt, adjBook, unexplained: r2(adjStmt - adjBook), openCount: open.length };
    }

    async function loadBank() {
        try {
            const [s, i] = await Promise.all([
                supabaseClient.from('bank_statements').select('*').order('statement_date', { ascending: false }).limit(60),
                supabaseClient.from('bank_reconciling_items').select('*')
            ]);
            if (s.error) throw s.error; if (i.error) throw i.error;
            bankCache = { stmts: s.data || [], items: i.data || [] };
            const rows = [];
            for (const st of bankCache.stmts) {
                let book = null, rec = null;
                try { book = await bookBalanceAt(st.account_code, st.statement_date); rec = reconcile(st, bankCache.items.filter(x => x.statement_id === st.id), book); } catch (e) { /* function may be missing */ }
                const bad = rec && Math.abs(rec.unexplained) > 0.01;
                rows.push(`<tr>
                    <td style="padding-left:16px;">${esc(st.statement_date)}</td><td>${st.account_code === '1121' ? 'Bank - ZMW' : 'Bank - USD'}</td>
                    <td style="text-align:right;">K${fmt(st.statement_balance)}</td>
                    <td style="text-align:right;">${book === null ? '-' : 'K' + fmt(book)}</td>
                    <td style="text-align:right;">${rec ? rec.openCount : '-'}</td>
                    <td style="text-align:right; font-weight:600; color:${bad ? '#dc2626' : '#059669'};">${rec ? 'K' + fmt(rec.unexplained) : '-'}</td>
                    <td><button class="btn btn-outline btn-sm" onclick="meOpenBank('${st.id}')">Reconcile</button></td></tr>`);
            }
            $('meBankBody').innerHTML = rows.join('') || '<tr><td colspan="7" style="text-align:center;padding:20px;color:#94a3b8;">No statements entered yet.</td></tr>';
        } catch (e) { dbError(e); }
    }

    window.meSaveBankStatement = async function () {
        const bal = $('meBankBal').value;
        if (!$('meBankDate').value || bal === '') { alert('Enter the statement date and closing balance.'); return; }
        const { error } = await supabaseClient.from('bank_statements').upsert({
            account_code: $('meBankAccount').value, statement_date: $('meBankDate').value,
            statement_balance: r2(bal), note: $('meBankNote').value.trim() || null
        }, { onConflict: 'account_code,statement_date' });
        if (error) return dbError(error);
        $('meBankBal').value = ''; $('meBankNote').value = '';
        loadBank();
    };

    window.meOpenBank = async function (id) {
        const st = bankCache.stmts.find(x => x.id === id); if (!st) return;
        const items = bankCache.items.filter(x => x.statement_id === id);
        let book = 0; try { book = await bookBalanceAt(st.account_code, st.statement_date); } catch (e) { return dbError(e); }
        const rec = reconcile(st, items, book);
        const box = $('meBankDetail'); box.style.display = 'block';
        box.innerHTML = `
            <strong>${st.account_code === '1121' ? 'Bank - ZMW' : 'Bank - USD'} on ${esc(st.statement_date)}</strong>
            <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:10px; margin:12px 0;">
                <div>Statement balance<br><strong>K${fmt(st.statement_balance)}</strong></div>
                <div>Adjusted statement<br><strong>K${fmt(rec.adjStmt)}</strong></div>
                <div>Books (ledger)<br><strong>K${fmt(book)}</strong></div>
                <div>Adjusted books<br><strong>K${fmt(rec.adjBook)}</strong></div>
                <div>Unexplained<br><strong style="color:${Math.abs(rec.unexplained) > 0.01 ? '#dc2626' : '#059669'};">K${fmt(rec.unexplained)}</strong></div>
            </div>
            <table class="table-minimal" style="width:100%;"><thead><tr><th>Type</th><th>Description</th><th style="text-align:right;">Amount</th><th>Cleared</th><th></th></tr></thead><tbody>
            ${items.map(i => `<tr><td>${esc(i.item_type)}</td><td>${esc(i.description)}</td><td style="text-align:right;">K${fmt(i.amount)}</td>
                <td><input type="checkbox" ${i.cleared ? 'checked' : ''} onchange="meToggleCleared('${i.id}', this.checked, '${id}')"></td>
                <td><button class="btn btn-outline btn-sm" onclick="meDeleteBankItem('${i.id}', '${id}')">Remove</button></td></tr>`).join('') || '<tr><td colspan="5" style="color:#94a3b8;">No items.</td></tr>'}
            </tbody></table>
            <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; align-items:end;">
                <select id="meItType" class="form-control"><option>Deposit in transit</option><option>Cheque / payment not yet cleared</option><option>Bank charge not yet booked</option><option>Bank interest not yet booked</option><option>Other</option></select>
                <input id="meItDesc" class="form-control" placeholder="Description" style="min-width:220px;">
                <input id="meItAmt" type="number" step="0.01" class="form-control" placeholder="Amount (positive)">
                <button class="btn btn-primary" onclick="meAddBankItem('${id}')">Add item</button>
            </div>
            <div style="font-size:0.75rem;color:#94a3b8;margin-top:8px;">Deposit in transit adds to the statement; cheque / payment not cleared takes away from it; bank charge takes away from the books; interest adds to the books. For "Other" type a negative amount to reduce the statement.</div>`;
    };

    window.meAddBankItem = async function (stmtId) {
        const type = $('meItType').value; let amt = r2($('meItAmt').value);
        if (!amt) { alert('Enter an amount.'); return; }
        if (type === 'Cheque / payment not yet cleared' || type === 'Bank charge not yet booked') amt = -Math.abs(amt);
        else if (type !== 'Other') amt = Math.abs(amt);
        const { error } = await supabaseClient.from('bank_reconciling_items').insert({ statement_id: stmtId, item_type: type, description: $('meItDesc').value.trim() || null, amount: amt });
        if (error) return dbError(error);
        await loadBank(); meOpenBank(stmtId);
    };
    window.meToggleCleared = async function (itemId, val, stmtId) {
        const { error } = await supabaseClient.from('bank_reconciling_items').update({ cleared: val }).eq('id', itemId);
        if (error) return dbError(error);
        await loadBank(); meOpenBank(stmtId);
    };
    window.meDeleteBankItem = async function (itemId, stmtId) {
        if (!confirm('Remove this item?')) return;
        const { error } = await supabaseClient.from('bank_reconciling_items').delete().eq('id', itemId);
        if (error) return dbError(error);
        await loadBank(); meOpenBank(stmtId);
    };

    // ============================================
    // FILED RETURNS
    // ============================================
    async function loadReturns() {
        const { data, error } = await supabaseClient.from('statutory_returns').select('*').order('period_month', { ascending: false }).limit(200);
        if (error) return dbError(error);
        $('meRetBody').innerHTML = (data || []).map(r => {
            const left = r2(num(r.amount_declared) - num(r.amount_paid));
            return `<tr><td style="padding-left:16px;">${esc(r.period_month)}</td><td>${esc(r.tax_type)}</td><td style="text-align:right;">K${fmt(r.amount_declared)}</td>
                <td>${esc(r.filed_date || '-')}</td><td>${esc(r.receipt_number || '-')}</td><td style="text-align:right;">K${fmt(r.amount_paid)}</td>
                <td>${esc(r.paid_date || '-')}</td><td style="text-align:right; color:${left > 0.01 ? '#dc2626' : '#059669'}; font-weight:600;">K${fmt(left)}</td></tr>`;
        }).join('') || '<tr><td colspan="8" style="text-align:center;padding:20px;color:#94a3b8;">No returns recorded yet.</td></tr>';
    }
    window.meSaveReturn = async function () {
        if (!$('meRetMonth').value) { alert('Choose the month.'); return; }
        const { error } = await supabaseClient.from('statutory_returns').insert({
            tax_type: $('meRetType').value, period_month: $('meRetMonth').value, amount_declared: r2($('meRetDeclared').value),
            filed_date: $('meRetFiled').value || null, receipt_number: $('meRetReceipt').value.trim() || null,
            amount_paid: r2($('meRetPaid').value), paid_date: $('meRetPaidDate').value || null
        });
        if (error) return dbError(error);
        ['meRetDeclared', 'meRetFiled', 'meRetReceipt', 'meRetPaid', 'meRetPaidDate'].forEach(i => $(i).value = '');
        loadReturns();
    };

    // ============================================
    // COLLECTION NOTES
    // ============================================
    async function loadNotes() {
        const { data, error } = await supabaseClient.from('collection_notes').select('*').order('note_date', { ascending: false }).limit(300);
        if (error) return dbError(error);
        $('meColBody').innerHTML = (data || []).map(n => `<tr style="${n.resolved ? 'opacity:0.55;' : ''}">
            <td style="padding-left:16px;">${esc(n.note_date)}</td><td>${esc(n.party_name)}<br><span style="font-size:0.72rem;color:#94a3b8;">${esc(n.party_type)}</span></td>
            <td>${esc(n.reference || '-')}</td><td>${esc(n.contact_person || '-')}</td><td>${esc(n.what_was_said)}</td>
            <td style="text-align:right;">${n.promised_amount ? 'K' + fmt(n.promised_amount) : '-'}</td><td>${esc(n.promised_date || '-')}</td>
            <td style="${n.next_follow_up && n.next_follow_up <= today && !n.resolved ? 'color:#dc2626;font-weight:600;' : ''}">${esc(n.next_follow_up || '-')}</td>
            <td>${n.resolved ? 'Done' : `<button class="btn btn-outline btn-sm" onclick="meResolveNote('${n.id}')">Done</button>`}</td></tr>`).join('')
            || '<tr><td colspan="9" style="text-align:center;padding:20px;color:#94a3b8;">No notes yet.</td></tr>';
    }
    window.meSaveNote = async function () {
        if (!$('meColName').value.trim() || !$('meColSaid').value.trim()) { alert('Enter who you spoke about and what was said.'); return; }
        const { error } = await supabaseClient.from('collection_notes').insert({
            party_type: $('meColType').value, party_name: $('meColName').value.trim(), reference: $('meColRef').value.trim() || null,
            contact_person: $('meColContact').value.trim() || null, what_was_said: $('meColSaid').value.trim(),
            promised_amount: $('meColAmt').value ? r2($('meColAmt').value) : null, promised_date: $('meColPromDate').value || null, next_follow_up: $('meColNext').value || null
        });
        if (error) return dbError(error);
        ['meColName', 'meColRef', 'meColContact', 'meColSaid', 'meColAmt', 'meColPromDate', 'meColNext'].forEach(i => $(i).value = '');
        loadNotes();
    };
    window.meResolveNote = async function (id) {
        const { error } = await supabaseClient.from('collection_notes').update({ resolved: true }).eq('id', id);
        if (error) return dbError(error); loadNotes();
    };

    // ============================================
    // ACCRUALS & PREPAYMENTS
    // ============================================
    async function ensureAccounts() {
        const need = [['1150', 'Prepayments', 'Asset', 'Current Asset', 'Debit'], ['2180', 'Accrued Expenses', 'Liability', 'Current Liability', 'Credit']];
        const { data } = await supabaseClient.from('chart_of_accounts').select('code').in('code', need.map(n => n[0]));
        const have = new Set((data || []).map(d => d.code));
        const missing = need.filter(n => !have.has(n[0]));
        if (missing.length) await supabaseClient.from('chart_of_accounts').insert(missing.map(n => ({ code: n[0], name: n[1], type: n[2], category: n[3], normal_balance: n[4], is_active: true })));
    }
    async function postJournal(date, ref, desc, lines) {
        const total = r2(lines.reduce((s, l) => s + num(l.debit), 0));
        if (Math.abs(total - r2(lines.reduce((s, l) => s + num(l.credit), 0))) > 0.005) throw new Error('Journal does not balance.');
        const { data: je, error } = await supabaseClient.from('journal_entries').insert([{
            entry_date: date, reference: ref, description: desc, status: 'Posted', created_at: new Date().toISOString(),
            journal_number: `ME-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 100000)).padStart(5, '0')}`
        }]).select();
        if (error) throw error;
        const { error: le } = await supabaseClient.from('journal_lines').insert(lines.map(l => ({ journal_entry_id: je[0].id, account_code: l.account, description: l.description || desc, debit: r2(l.debit), credit: r2(l.credit) })));
        if (le) { await supabaseClient.from('journal_entries').update({ status: 'Voided' }).eq('id', je[0].id); throw le; }
        return je[0].id;
    }
    function schedule(item) {   // [{period, amount}] equal split, remainder on the last month
        const n = item.months, each = r2(num(item.total_amount) / n); const out = [];
        let used = 0;
        for (let k = 0; k < n; k++) { const amt = k === n - 1 ? r2(num(item.total_amount) - used) : each; used = r2(used + amt); out.push({ period: addMonths(item.start_month, k), amount: amt }); }
        return out;
    }

    async function loadAccruals() {
        const [a, r] = await Promise.all([
            supabaseClient.from('accrual_prepayments').select('*').order('created_at', { ascending: false }),
            supabaseClient.from('accrual_prepayment_releases').select('*')
        ]);
        if (a.error) return dbError(a.error); if (r.error) return dbError(r.error);
        const rel = {}; (r.data || []).forEach(x => { rel[x.item_id] = (rel[x.item_id] || 0) + num(x.amount); });
        $('meAcBody').innerHTML = (a.data || []).map(i => {
            const released = i.kind === 'Accrual' ? num(i.total_amount) : (rel[i.id] || 0);
            const left = r2(num(i.total_amount) - released);
            const expName = (EXPENSE_ACCOUNTS.find(e => e[0] === i.expense_account) || [i.expense_account, i.expense_account])[1];
            return `<tr><td style="padding-left:16px;">${esc(i.kind)}</td><td>${esc(i.description)}</td><td>${esc(expName)}</td><td style="text-align:right;">K${fmt(i.total_amount)}</td>
                <td>${i.kind === 'Prepayment' ? esc(i.start_month) : esc(i.start_month)}</td><td>${i.months}</td>
                <td style="text-align:right;">K${fmt(released)}</td><td style="text-align:right;">K${fmt(left)}</td><td>${esc(i.status)}</td>
                <td>${i.kind === 'Accrual' && i.status === 'Active' ? `<button class="btn btn-outline btn-sm" onclick="meSettleAccrual('${i.id}')">Paid</button>` : ''}</td></tr>`;
        }).join('') || '<tr><td colspan="10" style="text-align:center;padding:20px;color:#94a3b8;">Nothing recorded yet.</td></tr>';
    }

    window.meSaveAccrual = async function () {
        const kind = $('meAcKind').value, desc = $('meAcDesc').value.trim(), total = r2($('meAcAmt').value);
        const start = $('meAcStart').value, months = kind === 'Accrual' ? 1 : Math.max(1, parseInt($('meAcMonths').value, 10) || 1);
        const from = $('meAcFrom').value, exp = $('meAcExp').value;
        if (!desc || total <= 0 || !start) { alert('Enter a description, an amount and the first month.'); return; }
        const msg = kind === 'Prepayment'
            ? `Save prepayment "${desc}" K${fmt(total)} over ${months} month(s) from ${start}?` + (from ? `\nThe payment (K${fmt(total)}) will be posted: Prepayments / ${from === '1121' ? 'Bank' : 'Cash'}.` : '\nNo payment journal will be posted (already in the books).')
            : `Save accrual "${desc}" K${fmt(total)} for ${start}?\nThis books the expense now: ${EXPENSE_ACCOUNTS.find(e => e[0] === exp)[1]} / Accrued Expenses.`;
        if (!confirm(msg)) return;
        try {
            await ensureAccounts();
            const { data, error } = await supabaseClient.from('accrual_prepayments').insert({ kind, description: desc, expense_account: exp, total_amount: total, start_month: start, months, paid_from_account: from || null }).select();
            if (error) throw error;
            if (kind === 'Prepayment' && from) {
                await postJournal(today, `PREPAY-${data[0].id.slice(0, 8)}`, `Prepayment: ${desc}`, [
                    { account: '1150', debit: total, credit: 0, description: `Prepaid: ${desc}` },
                    { account: from, debit: 0, credit: total, description: `Paid: ${desc}` }]);
            }
            if (kind === 'Accrual') {
                await postJournal(monthEnd(start), `ACCRUAL-${data[0].id.slice(0, 8)}`, `Accrual: ${desc}`, [
                    { account: exp, debit: total, credit: 0, description: `Accrued: ${desc}` },
                    { account: '2180', debit: 0, credit: total, description: `Accrued: ${desc}` }]);
            }
            ['meAcDesc', 'meAcAmt'].forEach(i => $(i).value = '');
            loadAccruals();
        } catch (e) { dbError(e); }
    };

    window.meRunReleases = async function () {
        const upto = $('meRelMonth').value; if (!upto) { alert('Choose the month.'); return; }
        try {
            await ensureAccounts();
            const [a, r] = await Promise.all([
                supabaseClient.from('accrual_prepayments').select('*').eq('kind', 'Prepayment').eq('status', 'Active'),
                supabaseClient.from('accrual_prepayment_releases').select('item_id, period_month')
            ]);
            if (a.error) throw a.error; if (r.error) throw r.error;
            const done = new Set((r.data || []).map(x => x.item_id + '|' + x.period_month));
            const todo = [];
            (a.data || []).forEach(it => schedule(it).forEach(s => { if (s.period <= upto && !done.has(it.id + '|' + s.period) && s.amount > 0) todo.push({ it, ...s }); }));
            if (!todo.length) { alert('Nothing to release up to ' + upto + '.'); return; }
            const total = r2(todo.reduce((s, t) => s + t.amount, 0));
            if (!confirm(`Post ${todo.length} monthly release(s) totalling K${fmt(total)}?\nEach one: expense / Prepayments, dated month-end.`)) return;
            for (const t of todo) {
                const jid = await postJournal(monthEnd(t.period), `PREPAY-REL-${t.it.id.slice(0, 8)}-${t.period}`, `Prepayment release ${t.period}: ${t.it.description}`, [
                    { account: t.it.expense_account, debit: t.amount, credit: 0 },
                    { account: '1150', debit: 0, credit: t.amount }]);
                const { error } = await supabaseClient.from('accrual_prepayment_releases').insert({ item_id: t.it.id, period_month: t.period, amount: t.amount, journal_entry_id: jid });
                if (error) throw error;
            }
            // mark completed prepayments
            for (const it of (a.data || [])) {
                const last = schedule(it).slice(-1)[0].period;
                if (last <= upto) await supabaseClient.from('accrual_prepayments').update({ status: 'Completed' }).eq('id', it.id);
            }
            alert('Done.'); loadAccruals();
        } catch (e) { dbError(e); }
    };

    window.meSettleAccrual = async function (id) {
        const { data, error } = await supabaseClient.from('accrual_prepayments').select('*').eq('id', id).single();
        if (error) return dbError(error);
        const from = prompt('Paid from? Type 1121 for Bank or 1111 for Cash:', '1121');
        if (from !== '1121' && from !== '1111') { if (from !== null) alert('Type 1121 or 1111.'); return; }
        if (!confirm(`Record that "${data.description}" K${fmt(data.total_amount)} was paid from ${from === '1121' ? 'Bank' : 'Cash'}?`)) return;
        try {
            await postJournal(today, `ACCRUAL-PAID-${id.slice(0, 8)}`, `Accrual paid: ${data.description}`, [
                { account: '2180', debit: data.total_amount, credit: 0 }, { account: from, debit: 0, credit: data.total_amount }]);
            await supabaseClient.from('accrual_prepayments').update({ status: 'Completed' }).eq('id', id);
            loadAccruals();
        } catch (e) { dbError(e); }
    };

    meShowTab('bank');
    console.log('Month-End Records ready');
})();

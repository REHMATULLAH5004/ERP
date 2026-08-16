// ============================================
// UNIFIED DAILY REPORT
// ============================================
// Six sections, matching the closing-report spec exactly:
//   1. Stock (at cost)          4. Bank (USD)
//   2. Cash in Hand             5. Today's Sale (by category, cash/credit)
//   3. Bank (ZMW)               6. Today's Purchase (cash/credit x currency)
//
// Opening/Closing per account (1400/1111/1121/1120) is still derived
// purely from journal_lines -- that number can never drift from the real
// ledger, no matter how the Inward/Outward breakdown below it is built.
//
// Transfers between 1111/1121/1120 are classified by looking at BOTH
// lines of the same journal_entry_id (the "Transfer In:"/"Transfer Out:"
// pair), instead of guessing from one side's description alone -- this is
// the only way to tell a same-currency Cash<->Bank(ZMW) move apart from a
// genuine ZMW<->USD transfer, since Cash & Bank's saveTransfer() doesn't
// encode the counterpart account in the line's own description.
//
// Any GL movement that isn't accounted for by a known category shows up
// as "Other / Uncategorized" rather than being silently absorbed into an
// existing bucket -- so the breakdown can never look complete when it
// isn't.
// ============================================

(async function initUnifiedReport() {
    console.log("Unified Daily Report initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    function formatNumber(num) {
        return (num || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    function packMultiplier(packSize) {
        if (!packSize || packSize === 'EACH') return 1;
        const parsed = parseInt(packSize);
        return isNaN(parsed) ? 1 : parsed;
    }

    let lastResults = null;

    // ============================================
    // 1. GL-BASED OPENING/CLOSING (ground truth -- unchanged approach)
    // ============================================
    async function computeGLTotals(reportDate) {
        const ACCOUNTS = ['1400', '1111', '1121', '1120'];

        const { data: entries, error: entriesError } = await supabaseClient
            .from('journal_entries')
            .select('id, entry_date')
            .lte('entry_date', reportDate);
        if (entriesError) throw entriesError;

        const allEntryIds = new Set((entries || []).map(e => e.id));
        const todayEntryIds = new Set((entries || []).filter(e => e.entry_date === reportDate).map(e => e.id));

        const { data: lines, error: linesError } = await supabaseClient
            .from('journal_lines')
            .select('journal_entry_id, account_code, debit, credit, description')
            .in('account_code', ACCOUNTS);
        if (linesError) throw linesError;

        const results = {};
        ACCOUNTS.forEach(code => { results[code] = { closing: 0, inward: 0, outward: 0 }; });

        (lines || []).forEach(l => {
            const r = results[l.account_code];
            if (!r || !allEntryIds.has(l.journal_entry_id)) return;

            r.closing += (l.debit || 0) - (l.credit || 0);
            if (todayEntryIds.has(l.journal_entry_id)) {
                r.inward += (l.debit || 0);
                r.outward += (l.credit || 0);
            }
        });

        ACCOUNTS.forEach(code => {
            const r = results[code];
            r.opening = r.closing - r.inward + r.outward;
        });

        return { results, todayEntryIds };
    }

    // ============================================
    // 1b. TRANSFER / INTER-ACCOUNT MOVEMENT CLASSIFICATION
    // ============================================
    // For every journal_entry_id posted today that touches 1111/1121/1120
    // via a "Transfer In:"/"Transfer Out:" line, look at BOTH lines to find
    // the counterpart account -- that's the only reliable way to tell
    // Cash<->BankZMW, Cash<->BankUSD, and BankZMW<->BankUSD apart, since
    // the description text alone never names the other side.
    async function computeMovementPairing(todayEntryIds) {
        const CODES = ['1111', '1121', '1120'];
        const pairing = {
            '1111': { to1121: 0, from1121: 0, to1120: 0, from1120: 0 },
            '1121': { to1111: 0, from1111: 0, to1120: 0, from1120: 0 },
            '1120': { to1111: 0, from1111: 0, to1121: 0, from1121: 0 }
        };
        const advance = { given: { '1111': 0, '1121': 0 }, settled: { '1111': 0, '1121': 0 } };

        const entryIds = Array.from(todayEntryIds);
        if (entryIds.length === 0) return { pairing, advance };

        const { data: lines, error } = await supabaseClient
            .from('journal_lines')
            .select('journal_entry_id, account_code, debit, credit, description')
            .in('journal_entry_id', entryIds)
            .in('account_code', CODES);
        if (error) throw error;

        // Advance given/settled: single line per side, no pairing needed --
        // just match on description + account.
        (lines || []).forEach(l => {
            const desc = l.description || '';
            if (desc === 'Advance given') advance.given[l.account_code] += (l.credit || 0);
            else if (desc === 'Advance settled') advance.settled[l.account_code] += (l.debit || 0);
        });

        // Transfer pairing: group Transfer In:/Transfer Out: lines by entry.
        const byEntry = {};
        (lines || []).forEach(l => {
            const desc = l.description || '';
            if (desc.startsWith('Transfer In:') || desc.startsWith('Transfer Out:')) {
                (byEntry[l.journal_entry_id] = byEntry[l.journal_entry_id] || []).push(l);
            }
        });

        Object.values(byEntry).forEach(pairLines => {
            if (pairLines.length !== 2) return; // malformed/unexpected -- skip rather than misclassify
            const [a, b] = pairLines;
            [[a, b], [b, a]].forEach(([self, other]) => {
                const p = pairing[self.account_code];
                if (!p) return;
                if (self.credit > 0) {
                    const field = 'to' + other.account_code;
                    if (p[field] !== undefined) p[field] += self.credit;
                }
                if (self.debit > 0) {
                    const field = 'from' + other.account_code;
                    if (p[field] !== undefined) p[field] += self.debit;
                }
            });
        });

        return { pairing, advance };
    }

    // ============================================
    // 2. STOCK OUTWARD BREAKDOWN
    // ============================================
    async function computeStockOutwardBreakdown(reportDate) {
        const dayStart = `${reportDate}T00:00:00`;
        const dayEnd = `${reportDate}T23:59:59`;

        const breakdown = { NHIMA: 0, REGULAR: 0, ONLINE: 0, STAFF: 0, WHOLESALE: 0, DONATION: 0, WRITEOFF: 0 };

        const { data: sales } = await supabaseClient
            .from('sales')
            .select('client_type, client_sub_type, items')
            .in('client_type', ['RETAIL', 'WHOLESALE', 'DONATION'])
            .neq('is_quotation', true)
            .gte('created_at', dayStart).lte('created_at', dayEnd);

        (sales || []).forEach(sale => {
            const cogs = (sale.items || []).reduce((sum, item) => {
                const cost = item.cost_per_unit || 0;
                return sum + (cost * (item.qty || 0) * packMultiplier(item.pack_size));
            }, 0);

            if (sale.client_type === 'DONATION') { breakdown.DONATION += cogs; return; }
            if (sale.client_type === 'WHOLESALE') { breakdown.WHOLESALE += cogs; return; }
            const subType = sale.client_sub_type;
            if (breakdown.hasOwnProperty(subType)) breakdown[subType] += cogs;
            else breakdown.REGULAR += cogs;
        });

        const { data: writeoffs } = await supabaseClient
            .from('write_offs')
            .select('total_cost_written_off')
            .gte('created_at', dayStart).lte('created_at', dayEnd);

        (writeoffs || []).forEach(w => { breakdown.WRITEOFF += (w.total_cost_written_off || 0); });

        return breakdown;
    }

    // ============================================
    // 3. CASH IN HAND BREAKDOWN
    // ============================================
    async function computeCashBreakdown(reportDate, pairing, advance) {
        const dayStart = `${reportDate}T00:00:00`;
        const dayEnd = `${reportDate}T23:59:59`;

        const inward = {
            retailCash: 0, wholesaleCash: 0, receivableCash: 0,
            withdrawnFromBankZmw: pairing['1111'].from1121,
            withdrawnFromBankUsd: pairing['1111'].from1120,
            advanceSettled: advance.settled['1111']
        };
        const outward = {
            expense: 0, purchase: 0, payable: 0, salary: 0,
            advanceGiven: advance.given['1111'],
            depositedToBankZmw: pairing['1111'].to1121,
            depositedToBankUsd: pairing['1111'].to1120
        };

        const { data: sales } = await supabaseClient
            .from('sales')
            .select('client_type, payment, grand_total')
            .in('client_type', ['RETAIL', 'WHOLESALE'])
            .neq('is_quotation', true)
            .gte('created_at', dayStart).lte('created_at', dayEnd);

        (sales || []).forEach(s => {
            if (s.payment?.type !== 'Cash') return;
            if (s.client_type === 'WHOLESALE') inward.wholesaleCash += s.grand_total || 0;
            else inward.retailCash += s.grand_total || 0;
        });

        const { data: receipts } = await supabaseClient
            .from('customer_receipts')
            .select('payment_method, amount')
            .gte('created_at', dayStart).lte('created_at', dayEnd);
        (receipts || []).forEach(r => {
            if (r.payment_method !== 'Bank Transfer') inward.receivableCash += r.amount || 0;
        });

        const { data: expenses } = await supabaseClient
            .from('cash_transactions')
            .select('account, amount')
            .eq('type', 'Payment')
            .not('expense_category', 'is', null)
            .gte('transaction_date', reportDate).lte('transaction_date', reportDate);
        (expenses || []).forEach(e => {
            if (e.account !== 'Bank (ZMW)') outward.expense += e.amount || 0;
        });

        const { data: grns } = await supabaseClient
            .from('goods_receipt_notes')
            .select('id, invoice_total')
            .eq('entry_date', reportDate);
        if (grns && grns.length > 0) {
            const grnIds = grns.map(g => g.id);
            const { data: payables } = await supabaseClient
                .from('supplier_payables')
                .select('grn_id')
                .in('grn_id', grnIds);
            const payableGrnIds = new Set((payables || []).map(p => p.grn_id));
            grns.forEach(g => {
                if (!payableGrnIds.has(g.id)) outward.purchase += g.invoice_total || 0;
            });
        }

        const { data: payments } = await supabaseClient
            .from('payments')
            .select('payment_method, currency, amount_zmw')
            .eq('currency', 'ZMW')
            .gte('payment_date', reportDate).lte('payment_date', reportDate);
        (payments || []).forEach(p => {
            if (p.payment_method !== 'Bank Transfer') outward.payable += p.amount_zmw || 0;
        });

        const { data: payroll } = await supabaseClient
            .from('payroll_records')
            .select('paid_from, net_pay, paid_at')
            .eq('paid_from', '1111');
        (payroll || []).forEach(p => {
            if (p.paid_at && p.paid_at.startsWith(reportDate)) outward.salary += p.net_pay || 0;
        });

        return { inward, outward };
    }

    // ============================================
    // 4. BANK (ZMW) BREAKDOWN
    // ============================================
    async function computeBankZmwBreakdown(reportDate, pairing, advance) {
        const dayStart = `${reportDate}T00:00:00`;
        const dayEnd = `${reportDate}T23:59:59`;

        const inward = {
            retailBank: 0, wholesaleBank: 0, receivableBank: 0,
            depositedFromCash: pairing['1121'].from1111,
            transferFromUsd: pairing['1121'].from1120,
            advanceSettled: advance.settled['1121']
        };
        const outward = {
            expense: 0, payable: 0, salary: 0,
            advanceGiven: advance.given['1121'],
            withdrawnToCash: pairing['1121'].to1111,
            transferToUsd: pairing['1121'].to1120
        };

        const { data: sales } = await supabaseClient
            .from('sales')
            .select('client_type, payment, grand_total')
            .in('client_type', ['RETAIL', 'WHOLESALE'])
            .neq('is_quotation', true)
            .gte('created_at', dayStart).lte('created_at', dayEnd);
        (sales || []).forEach(s => {
            if (s.payment?.type !== 'Bank Transfer') return;
            if (s.client_type === 'WHOLESALE') inward.wholesaleBank += s.grand_total || 0;
            else inward.retailBank += s.grand_total || 0;
        });

        const { data: receipts } = await supabaseClient
            .from('customer_receipts')
            .select('payment_method, amount')
            .gte('created_at', dayStart).lte('created_at', dayEnd);
        (receipts || []).forEach(r => {
            if (r.payment_method === 'Bank Transfer') inward.receivableBank += r.amount || 0;
        });

        const { data: expenses } = await supabaseClient
            .from('cash_transactions')
            .select('account, amount')
            .eq('type', 'Payment')
            .not('expense_category', 'is', null)
            .gte('transaction_date', reportDate).lte('transaction_date', reportDate);
        (expenses || []).forEach(e => {
            if (e.account === 'Bank (ZMW)') outward.expense += e.amount || 0;
        });

        const { data: payments } = await supabaseClient
            .from('payments')
            .select('payment_method, currency, amount_zmw')
            .eq('currency', 'ZMW')
            .gte('payment_date', reportDate).lte('payment_date', reportDate);
        (payments || []).forEach(p => {
            if (p.payment_method === 'Bank Transfer') outward.payable += p.amount_zmw || 0;
        });

        const { data: payroll } = await supabaseClient
            .from('payroll_records')
            .select('paid_from, net_pay, paid_at')
            .eq('paid_from', '1121');
        (payroll || []).forEach(p => {
            if (p.paid_at && p.paid_at.startsWith(reportDate)) outward.salary += p.net_pay || 0;
        });

        return { inward, outward };
    }

    // ============================================
    // 5. BANK (USD) BREAKDOWN
    // ============================================
    async function computeBankUsdBreakdown(reportDate, pairing) {
        const inward = {
            depositedFromCash: pairing['1120'].from1111,
            transferFromZmw: pairing['1120'].from1121
        };
        const outward = {
            paidUsd: 0,
            withdrawnToCash: pairing['1120'].to1111,
            transferToZmw: pairing['1120'].to1121
        };

        const { data: payments } = await supabaseClient
            .from('payments')
            .select('currency, amount_usd')
            .eq('currency', 'USD')
            .gte('payment_date', reportDate).lte('payment_date', reportDate);
        (payments || []).forEach(p => { outward.paidUsd += p.amount_usd || 0; });

        return { inward, outward };
    }

    // ============================================
    // 6. TODAY'S SALE -- revenue by category, cash vs credit
    // ============================================
    // "Cash" here means settled today (Cash or Bank Transfer payment);
    // "Credit" means invoiced to the customer's account, collected later.
    async function computeTodaySaleBreakdown(reportDate) {
        const dayStart = `${reportDate}T00:00:00`;
        const dayEnd = `${reportDate}T23:59:59`;

        const breakdown = {
            NHIMA: { cash: 0, credit: 0 }, REGULAR: { cash: 0, credit: 0 },
            STAFF: { cash: 0, credit: 0 }, ONLINE: { cash: 0, credit: 0 },
            WHOLESALE: { cash: 0, credit: 0 }
        };

        const { data: sales } = await supabaseClient
            .from('sales')
            .select('client_type, client_sub_type, payment, grand_total')
            .in('client_type', ['RETAIL', 'WHOLESALE'])
            .neq('is_quotation', true)
            .gte('created_at', dayStart).lte('created_at', dayEnd);

        (sales || []).forEach(s => {
            const bucketKey = s.client_type === 'WHOLESALE'
                ? 'WHOLESALE'
                : (breakdown.hasOwnProperty(s.client_sub_type) ? s.client_sub_type : 'REGULAR');
            const bucket = breakdown[bucketKey];
            const isCredit = s.payment?.type === 'Credit';
            bucket[isCredit ? 'credit' : 'cash'] += s.grand_total || 0;
        });

        return breakdown;
    }

    // ============================================
    // 7. TODAY'S PURCHASE -- cash vs credit, ZMW vs USD (original currency,
    //    unconverted -- deliberately not blended into one number)
    // ============================================
    async function computeTodayPurchaseBreakdown(reportDate) {
        const breakdown = { cash: { ZMW: 0, USD: 0 }, credit: { ZMW: 0, USD: 0 } };

        const { data: grns } = await supabaseClient
            .from('goods_receipt_notes')
            .select('id, currency, invoice_total')
            .eq('entry_date', reportDate);
        if (!grns || grns.length === 0) return breakdown;

        const grnIds = grns.map(g => g.id);
        const { data: payables } = await supabaseClient
            .from('supplier_payables')
            .select('grn_id')
            .in('grn_id', grnIds);
        const payableGrnIds = new Set((payables || []).map(p => p.grn_id));

        grns.forEach(g => {
            const cur = g.currency === 'USD' ? 'USD' : 'ZMW';
            const bucket = payableGrnIds.has(g.id) ? 'credit' : 'cash';
            breakdown[bucket][cur] += g.invoice_total || 0;
        });

        return breakdown;
    }

    // ============================================
    // MAIN
    // ============================================
    async function computeUnifiedReport(reportDate) {
        const { results: gl, todayEntryIds } = await computeGLTotals(reportDate);
        const { pairing, advance } = await computeMovementPairing(todayEntryIds);

        const stockOutward = await computeStockOutwardBreakdown(reportDate);
        const cash = await computeCashBreakdown(reportDate, pairing, advance);
        const bankZmw = await computeBankZmwBreakdown(reportDate, pairing, advance);
        const bankUsd = await computeBankUsdBreakdown(reportDate, pairing);
        const todaySale = await computeTodaySaleBreakdown(reportDate);
        const todayPurchase = await computeTodayPurchaseBreakdown(reportDate);

        // Anything on 1111/1121/1120 today that isn't accounted for by a
        // known category -- surfaced rather than silently dropped.
        function leftover(total, breakdownObj) {
            const categorized = Object.values(breakdownObj).reduce((s, v) => s + v, 0);
            const diff = total - categorized;
            return Math.abs(diff) < 0.01 ? 0 : diff;
        }
        cash.outward.other = leftover(gl['1111'].outward, {
            expense: cash.outward.expense, purchase: cash.outward.purchase, payable: cash.outward.payable,
            salary: cash.outward.salary, advanceGiven: cash.outward.advanceGiven,
            depositedToBankZmw: cash.outward.depositedToBankZmw, depositedToBankUsd: cash.outward.depositedToBankUsd
        });
        cash.inward.other = leftover(gl['1111'].inward, {
            retailCash: cash.inward.retailCash, wholesaleCash: cash.inward.wholesaleCash,
            receivableCash: cash.inward.receivableCash, withdrawnFromBankZmw: cash.inward.withdrawnFromBankZmw,
            withdrawnFromBankUsd: cash.inward.withdrawnFromBankUsd, advanceSettled: cash.inward.advanceSettled
        });
        bankZmw.outward.other = leftover(gl['1121'].outward, {
            expense: bankZmw.outward.expense, payable: bankZmw.outward.payable, salary: bankZmw.outward.salary,
            advanceGiven: bankZmw.outward.advanceGiven, withdrawnToCash: bankZmw.outward.withdrawnToCash,
            transferToUsd: bankZmw.outward.transferToUsd
        });
        bankZmw.inward.other = leftover(gl['1121'].inward, {
            retailBank: bankZmw.inward.retailBank, wholesaleBank: bankZmw.inward.wholesaleBank,
            receivableBank: bankZmw.inward.receivableBank, depositedFromCash: bankZmw.inward.depositedFromCash,
            transferFromUsd: bankZmw.inward.transferFromUsd, advanceSettled: bankZmw.inward.advanceSettled
        });
        bankUsd.outward.other = leftover(gl['1120'].outward, {
            paidUsd: bankUsd.outward.paidUsd, withdrawnToCash: bankUsd.outward.withdrawnToCash,
            transferToZmw: bankUsd.outward.transferToZmw
        });
        bankUsd.inward.other = leftover(gl['1120'].inward, {
            depositedFromCash: bankUsd.inward.depositedFromCash, transferFromZmw: bankUsd.inward.transferFromZmw
        });

        return { gl, stockOutward, cash, bankZmw, bankUsd, todaySale, todayPurchase };
    }

    // ============================================
    // RENDER
    // ============================================
    function breakdownRow(label, value, color) {
        if (Math.abs(value) < 0.01) return '';
        return `<div style="display:flex; justify-content:space-between; padding:3px 0 3px 16px; font-size:0.82rem; color:${color || '#64748b'};"><span>${label}</span><span>K${formatNumber(value)}</span></div>`;
    }
    function breakdownRowRaw(label, value, symbol, color) {
        if (Math.abs(value) < 0.01) return '';
        return `<div style="display:flex; justify-content:space-between; padding:3px 0 3px 16px; font-size:0.82rem; color:${color || '#64748b'};"><span>${label}</span><span>${symbol}${formatNumber(value)}</span></div>`;
    }

    function renderAccountCard(title, icon, color, opening, inwardTotal, outwardTotal, closing, inwardBreakdown, outwardBreakdown, symbol) {
        const s = symbol || 'K';
        return `
            <div class="card" style="padding:20px;">
                <h4 style="margin:0 0 15px 0;"><i class="fa-solid ${icon}" style="color:${color};"></i> ${title}</h4>
                <div style="display:flex; justify-content:space-between; padding:4px 0;"><span>Opening</span><span>${s}${formatNumber(opening)}</span></div>

                <div style="display:flex; justify-content:space-between; padding:4px 0; font-weight:600; color:#059669; margin-top:6px;"><span>Inward (+)</span><span>${s}${formatNumber(inwardTotal)}</span></div>
                ${inwardBreakdown}

                <div style="display:flex; justify-content:space-between; padding:4px 0; font-weight:600; color:#dc2626; margin-top:6px;"><span>Outward (-)</span><span>${s}${formatNumber(outwardTotal)}</span></div>
                ${outwardBreakdown}

                <div style="display:flex; justify-content:space-between; padding:6px 0; margin-top:8px; border-top:2px solid #0f172a; font-weight:700;"><span>Closing</span><span>${s}${formatNumber(closing)}</span></div>
            </div>
        `;
    }

    function renderSaleCard(todaySale) {
        const CATS = [
            ['NHIMA', 'NHIMA'], ['REGULAR', 'Regular'], ['STAFF', 'Staff'],
            ['ONLINE', 'Online'], ['WHOLESALE', 'Wholesale']
        ];
        let grandCash = 0, grandCredit = 0;
        const rows = CATS.map(([key, label]) => {
            const b = todaySale[key];
            grandCash += b.cash; grandCredit += b.credit;
            const total = b.cash + b.credit;
            if (Math.abs(total) < 0.01) return '';
            return `
                <div style="padding:6px 0; border-bottom:1px solid #f1f5f9;">
                    <div style="display:flex; justify-content:space-between; font-weight:600;"><span>${label}</span><span>K${formatNumber(total)}</span></div>
                    ${breakdownRow('Cash', b.cash, '#059669')}
                    ${breakdownRow('Credit', b.credit, '#dc2626')}
                </div>
            `;
        }).join('');
        return `
            <div class="card" style="padding:20px;">
                <h4 style="margin:0 0 15px 0;"><i class="fa-solid fa-cash-register" style="color:#0ea5e9;"></i> Today's Sale</h4>
                ${rows || '<div style="color:#94a3b8; font-size:0.85rem;">No sales recorded.</div>'}
                <div style="display:flex; justify-content:space-between; padding:6px 0; margin-top:8px; border-top:2px solid #0f172a; font-weight:700;"><span>Total (Cash / Credit)</span><span>K${formatNumber(grandCash)} / K${formatNumber(grandCredit)}</span></div>
            </div>
        `;
    }

    function renderPurchaseCard(todayPurchase) {
        const rows = [
            breakdownRowRaw('Cash Purchase (ZMW)', todayPurchase.cash.ZMW, 'K', '#059669'),
            breakdownRowRaw('Cash Purchase (USD)', todayPurchase.cash.USD, '$', '#059669'),
            breakdownRowRaw('Credit Purchase (ZMW)', todayPurchase.credit.ZMW, 'K', '#dc2626'),
            breakdownRowRaw('Credit Purchase (USD)', todayPurchase.credit.USD, '$', '#dc2626')
        ].join('');
        const totalZmw = todayPurchase.cash.ZMW + todayPurchase.credit.ZMW;
        const totalUsd = todayPurchase.cash.USD + todayPurchase.credit.USD;
        return `
            <div class="card" style="padding:20px;">
                <h4 style="margin:0 0 15px 0;"><i class="fa-solid fa-truck-ramp-box" style="color:#f97316;"></i> Today's Purchase</h4>
                ${rows || '<div style="color:#94a3b8; font-size:0.85rem;">No purchases recorded.</div>'}
                <div style="display:flex; justify-content:space-between; padding:6px 0; margin-top:8px; border-top:2px solid #0f172a; font-weight:700;"><span>Total</span><span>K${formatNumber(totalZmw)} + $${formatNumber(totalUsd)}</span></div>
            </div>
        `;
    }

    function render(data) {
        const { gl, stockOutward, cash, bankZmw, bankUsd, todaySale, todayPurchase } = data;

        const stockCard = renderAccountCard(
            'Stock (Cost Value)', 'fa-boxes-stacked', '#2563eb',
            gl['1400'].opening, gl['1400'].inward, gl['1400'].outward, gl['1400'].closing,
            breakdownRow('Purchase', gl['1400'].inward, '#059669'),
            [
                breakdownRow('NHIMA Sale', stockOutward.NHIMA),
                breakdownRow('Regular Sale', stockOutward.REGULAR),
                breakdownRow('Online Sale', stockOutward.ONLINE),
                breakdownRow('Staff Sale', stockOutward.STAFF),
                breakdownRow('Wholesale', stockOutward.WHOLESALE),
                breakdownRow('Donation', stockOutward.DONATION),
                breakdownRow('Write-Off', stockOutward.WRITEOFF)
            ].join('')
        );

        const cashCard = renderAccountCard(
            'Cash in Hand', 'fa-money-bill-wave', '#059669',
            gl['1111'].opening, gl['1111'].inward, gl['1111'].outward, gl['1111'].closing,
            [
                breakdownRow('Retail Cash Sales', cash.inward.retailCash, '#059669'),
                breakdownRow('Wholesale Cash Sales', cash.inward.wholesaleCash, '#059669'),
                breakdownRow('Receivable Collections', cash.inward.receivableCash, '#059669'),
                breakdownRow('Advance Settled', cash.inward.advanceSettled, '#059669'),
                breakdownRow('Withdrawn from Bank (ZMW)', cash.inward.withdrawnFromBankZmw, '#059669'),
                breakdownRow('Withdrawn from Bank (USD)', cash.inward.withdrawnFromBankUsd, '#059669'),
                breakdownRow('Other / Uncategorized', cash.inward.other, '#059669')
            ].join(''),
            [
                breakdownRow('Expenses', cash.outward.expense),
                breakdownRow('Purchases (Cash)', cash.outward.purchase),
                breakdownRow('Payables Paid', cash.outward.payable),
                breakdownRow('Salaries Paid', cash.outward.salary),
                breakdownRow('Advance Given', cash.outward.advanceGiven),
                breakdownRow('Deposited to Bank (ZMW)', cash.outward.depositedToBankZmw),
                breakdownRow('Deposited to Bank (USD)', cash.outward.depositedToBankUsd),
                breakdownRow('Other / Uncategorized', cash.outward.other)
            ].join('')
        );

        const bankZmwCard = renderAccountCard(
            'Bank (ZMW)', 'fa-building-columns', '#8b5cf6',
            gl['1121'].opening, gl['1121'].inward, gl['1121'].outward, gl['1121'].closing,
            [
                breakdownRow('Retail Bank Sales', bankZmw.inward.retailBank, '#059669'),
                breakdownRow('Wholesale Bank Sales', bankZmw.inward.wholesaleBank, '#059669'),
                breakdownRow('Receivable Collections', bankZmw.inward.receivableBank, '#059669'),
                breakdownRow('Advance Settled', bankZmw.inward.advanceSettled, '#059669'),
                breakdownRow('Deposited from Cash', bankZmw.inward.depositedFromCash, '#059669'),
                breakdownRow('Transfer from USD', bankZmw.inward.transferFromUsd, '#059669'),
                breakdownRow('Other / Uncategorized', bankZmw.inward.other, '#059669')
            ].join(''),
            [
                breakdownRow('Expenses', bankZmw.outward.expense),
                breakdownRow('Payables Paid', bankZmw.outward.payable),
                breakdownRow('Salaries Paid', bankZmw.outward.salary),
                breakdownRow('Advance Given', bankZmw.outward.advanceGiven),
                breakdownRow('Withdrawn to Cash', bankZmw.outward.withdrawnToCash),
                breakdownRow('Transfer to USD', bankZmw.outward.transferToUsd),
                breakdownRow('Other / Uncategorized', bankZmw.outward.other)
            ].join('')
        );

        const bankUsdCard = renderAccountCard(
            'Bank (USD)', 'fa-building-columns', '#f59e0b',
            gl['1120'].opening, gl['1120'].inward, gl['1120'].outward, gl['1120'].closing,
            [
                breakdownRowRaw('Deposited from Cash', bankUsd.inward.depositedFromCash, '$', '#059669'),
                breakdownRowRaw('Transfer from Bank (ZMW)', bankUsd.inward.transferFromZmw, '$', '#059669'),
                breakdownRowRaw('Other / Uncategorized', bankUsd.inward.other, '$', '#059669')
            ].join(''),
            [
                breakdownRowRaw('Paid to Suppliers (USD)', bankUsd.outward.paidUsd, '$'),
                breakdownRowRaw('Withdrawn to Cash', bankUsd.outward.withdrawnToCash, '$'),
                breakdownRowRaw('Transfer to Bank (ZMW)', bankUsd.outward.transferToZmw, '$'),
                breakdownRowRaw('Other / Uncategorized', bankUsd.outward.other, '$')
            ].join(''),
            '$'
        );

        const saleCard = renderSaleCard(todaySale);
        const purchaseCard = renderPurchaseCard(todayPurchase);

        document.getElementById('unifiedReportContent').innerHTML = `
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:20px;">
                ${stockCard}
                ${cashCard}
                ${bankZmwCard}
                ${bankUsdCard}
                ${saleCard}
                ${purchaseCard}
            </div>
        `;
    }

    window.loadUnifiedReport = async function () {
        const reportDate = document.getElementById('unifiedReportDatePicker').value;
        if (!reportDate) { alert('Please pick a date.'); return; }

        const container = document.getElementById('unifiedReportContent');
        container.innerHTML = `<div style="text-align:center; padding:40px; color:#94a3b8;"><i class="fa-solid fa-spinner fa-spin"></i> Generating...</div>`;

        try {
            const data = await computeUnifiedReport(reportDate);
            lastResults = { reportDate, data };
            render(data);
        } catch (error) {
            console.error('Error generating unified report:', error);
            container.innerHTML = `<div style="text-align:center; padding:40px; color:#dc2626;">Error: ${error.message}</div>`;
        }
    };

    // ============================================
    // PRINT -- one document, everything for the day
    // ============================================
    window.printUnifiedReport = function () {
        if (!lastResults) { alert('Generate the report first.'); return; }
        const { reportDate, data } = lastResults;
        const { gl, stockOutward, cash, bankZmw, bankUsd, todaySale, todayPurchase } = data;
        const dateLabel = new Date(reportDate + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

        function printBreakdownLines(pairs, symbol) {
            const s = symbol || 'K';
            return pairs.filter(([, v]) => Math.abs(v) >= 0.01)
                .map(([label, v]) => `<div class="subline">${label}: ${s}${formatNumber(v)}</div>`).join('');
        }

        function printSection(title, opening, inwardTotal, outwardTotal, closing, inwardLines, outwardLines, symbol) {
            const s = symbol || 'K';
            return `
                <div class="section">
                    <h2>${title}</h2>
                    <table>
                        <tr><td>Opening</td><td class="right">${s}${formatNumber(opening)}</td></tr>
                        <tr><td class="green">Inward (+)</td><td class="right green">${s}${formatNumber(inwardTotal)}</td></tr>
                        <tr><td colspan="2">${inwardLines}</td></tr>
                        <tr><td class="red">Outward (-)</td><td class="right red">${s}${formatNumber(outwardTotal)}</td></tr>
                        <tr><td colspan="2">${outwardLines}</td></tr>
                        <tr class="closing"><td>Closing</td><td class="right">${s}${formatNumber(closing)}</td></tr>
                    </table>
                </div>
            `;
        }

        const stockSection = printSection('Stock (Cost Value)',
            gl['1400'].opening, gl['1400'].inward, gl['1400'].outward, gl['1400'].closing,
            printBreakdownLines([['Purchase', gl['1400'].inward]]),
            printBreakdownLines([
                ['NHIMA Sale', stockOutward.NHIMA], ['Regular Sale', stockOutward.REGULAR],
                ['Online Sale', stockOutward.ONLINE], ['Staff Sale', stockOutward.STAFF],
                ['Wholesale', stockOutward.WHOLESALE], ['Donation', stockOutward.DONATION],
                ['Write-Off', stockOutward.WRITEOFF]
            ])
        );

        const cashSection = printSection('Cash in Hand',
            gl['1111'].opening, gl['1111'].inward, gl['1111'].outward, gl['1111'].closing,
            printBreakdownLines([
                ['Retail Cash Sales', cash.inward.retailCash], ['Wholesale Cash Sales', cash.inward.wholesaleCash],
                ['Receivable Collections', cash.inward.receivableCash], ['Advance Settled', cash.inward.advanceSettled],
                ['Withdrawn from Bank (ZMW)', cash.inward.withdrawnFromBankZmw], ['Withdrawn from Bank (USD)', cash.inward.withdrawnFromBankUsd],
                ['Other / Uncategorized', cash.inward.other]
            ]),
            printBreakdownLines([
                ['Expenses', cash.outward.expense], ['Purchases (Cash)', cash.outward.purchase],
                ['Payables Paid', cash.outward.payable], ['Salaries Paid', cash.outward.salary],
                ['Advance Given', cash.outward.advanceGiven],
                ['Deposited to Bank (ZMW)', cash.outward.depositedToBankZmw], ['Deposited to Bank (USD)', cash.outward.depositedToBankUsd],
                ['Other / Uncategorized', cash.outward.other]
            ])
        );

        const bankZmwSection = printSection('Bank (ZMW)',
            gl['1121'].opening, gl['1121'].inward, gl['1121'].outward, gl['1121'].closing,
            printBreakdownLines([
                ['Retail Bank Sales', bankZmw.inward.retailBank], ['Wholesale Bank Sales', bankZmw.inward.wholesaleBank],
                ['Receivable Collections', bankZmw.inward.receivableBank], ['Advance Settled', bankZmw.inward.advanceSettled],
                ['Deposited from Cash', bankZmw.inward.depositedFromCash], ['Transfer from USD', bankZmw.inward.transferFromUsd],
                ['Other / Uncategorized', bankZmw.inward.other]
            ]),
            printBreakdownLines([
                ['Expenses', bankZmw.outward.expense], ['Payables Paid', bankZmw.outward.payable],
                ['Salaries Paid', bankZmw.outward.salary], ['Advance Given', bankZmw.outward.advanceGiven],
                ['Withdrawn to Cash', bankZmw.outward.withdrawnToCash], ['Transfer to USD', bankZmw.outward.transferToUsd],
                ['Other / Uncategorized', bankZmw.outward.other]
            ])
        );

        const bankUsdSection = printSection('Bank (USD)',
            gl['1120'].opening, gl['1120'].inward, gl['1120'].outward, gl['1120'].closing,
            printBreakdownLines([
                ['Deposited from Cash', bankUsd.inward.depositedFromCash], ['Transfer from Bank (ZMW)', bankUsd.inward.transferFromZmw],
                ['Other / Uncategorized', bankUsd.inward.other]
            ], '$'),
            printBreakdownLines([
                ['Paid to Suppliers (USD)', bankUsd.outward.paidUsd], ['Withdrawn to Cash', bankUsd.outward.withdrawnToCash],
                ['Transfer to Bank (ZMW)', bankUsd.outward.transferToZmw], ['Other / Uncategorized', bankUsd.outward.other]
            ], '$'),
            '$'
        );

        function printSaleSection() {
            const CATS = [
                ['NHIMA', 'NHIMA'], ['REGULAR', 'Regular'], ['STAFF', 'Staff'],
                ['ONLINE', 'Online'], ['WHOLESALE', 'Wholesale']
            ];
            const rows = CATS.map(([key, label]) => {
                const b = todaySale[key];
                const total = b.cash + b.credit;
                if (Math.abs(total) < 0.01) return '';
                return `<tr><td>${label}</td><td class="right">K${formatNumber(b.cash)}</td><td class="right">K${formatNumber(b.credit)}</td><td class="right">K${formatNumber(total)}</td></tr>`;
            }).join('');
            return `
                <div class="section">
                    <h2>Today's Sale</h2>
                    <table>
                        <tr><td><strong>Category</strong></td><td class="right"><strong>Cash</strong></td><td class="right"><strong>Credit</strong></td><td class="right"><strong>Total</strong></td></tr>
                        ${rows}
                    </table>
                </div>
            `;
        }

        function printPurchaseSection() {
            const rows = [
                Math.abs(todayPurchase.cash.ZMW) >= 0.01 ? `<tr><td>Cash Purchase (ZMW)</td><td class="right">K${formatNumber(todayPurchase.cash.ZMW)}</td></tr>` : '',
                Math.abs(todayPurchase.cash.USD) >= 0.01 ? `<tr><td>Cash Purchase (USD)</td><td class="right">$${formatNumber(todayPurchase.cash.USD)}</td></tr>` : '',
                Math.abs(todayPurchase.credit.ZMW) >= 0.01 ? `<tr><td>Credit Purchase (ZMW)</td><td class="right">K${formatNumber(todayPurchase.credit.ZMW)}</td></tr>` : '',
                Math.abs(todayPurchase.credit.USD) >= 0.01 ? `<tr><td>Credit Purchase (USD)</td><td class="right">$${formatNumber(todayPurchase.credit.USD)}</td></tr>` : ''
            ].join('');
            return `
                <div class="section">
                    <h2>Today's Purchase</h2>
                    <table>
                        ${rows || '<tr><td>No purchases recorded.</td></tr>'}
                    </table>
                </div>
            `;
        }

        const printWindow = window.open('', '_blank', 'width=850,height=900');
        if (!printWindow) { alert('Please allow popups to print.'); return; }

        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Daily Report - ${reportDate}</title>
                <style>
                    body { font-family: Arial, sans-serif; padding: 30px; color: #0f172a; }
                    h1 { margin-bottom: 2px; font-size: 1.4rem; }
                    .subtitle { color: #64748b; margin-top: 0; margin-bottom: 20px; font-size: 0.9rem; }
                    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
                    .section { border: 1px solid #e2e8f0; border-radius: 6px; padding: 14px; page-break-inside: avoid; }
                    .section h2 { font-size: 1rem; margin: 0 0 10px 0; }
                    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
                    td { padding: 3px 0; }
                    .right { text-align: right; }
                    .green { color: #059669; font-weight: 600; }
                    .red { color: #dc2626; font-weight: 600; }
                    .subline { font-size: 0.78rem; color: #64748b; padding-left: 14px; }
                    .closing td { border-top: 2px solid #0f172a; font-weight: 700; padding-top: 6px; }
                    .footer { margin-top: 20px; font-size: 0.75rem; color: #94a3b8; }
                    @media print { .grid { grid-template-columns: 1fr 1fr; } }
                </style>
            </head>
            <body>
                <h1>Daily Report</h1>
                <p class="subtitle">${dateLabel} &middot; Generated ${new Date().toLocaleString()}</p>
                <div class="grid">
                    ${stockSection}
                    ${cashSection}
                    ${bankZmwSection}
                    ${bankUsdSection}
                    ${printSaleSection()}
                    ${printPurchaseSection()}
                </div>
                <p class="footer">Stock shown at cost value. Bank (USD) shown in raw dollars, not converted to ZMW. All figures derived directly from posted transactions and the accounting ledger.</p>
                <script>window.onload = function() { window.print(); };<\/script>
            </body>
            </html>
        `);
        printWindow.document.close();
    };

    // ============================================
    // INIT
    // ============================================
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    document.getElementById('unifiedReportDatePicker').value = todayStr;
    await window.loadUnifiedReport();

    console.log("✅ Unified Daily Report initialized successfully!");
})();

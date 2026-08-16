// ============================================
// TRANSACTION OVERVIEW - TODAY'S TRANSACTIONS
// ============================================
// Unifies 6 transaction types into one feed: Sale, Purchase, Write-Off,
// Payment, Donation, Receipt. Clicking a row navigates into that
// transaction's own module and, where an edit function actually exists,
// deep-links straight into editing that specific record.
//
// Confirmed by reading each module's code directly (not guessed):
//   Sale/Wholesale/Donation/Write-Off -> loadSaleForEdit(saleData) etc.,
//     each expects the RAW sales/write_offs table row as-is.
//   Purchase -> editPO(orderId), expects just the id.
//   Payment / Receipt -> NO edit function exists in either module.
//     Clicking these just opens the module; nothing to auto-populate,
//     since payments/receipts are normally reversed rather than edited.
// ============================================

(async function initTransactionOverview() {
    console.log("Transaction Overview initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    let allTransactions = [];

    function todayRange() {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const end = new Date();
        end.setHours(23, 59, 59, 999);
        return { start: start.toISOString(), end: end.toISOString() };
    }

    function formatNumber(num) {
        return (num || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    function formatTime(dateStr) {
        try { return new Date(dateStr).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }); }
        catch { return '-'; }
    }
    function esc(str) {
        return (str || '').toString().replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ============================================
    // LOAD TODAY'S DATA FROM ALL 6 SOURCES
    // ============================================
    async function loadTodaysTransactions() {
        const { start, end } = todayRange();
        allTransactions = [];

        // 🔥 FIX: purchase_orders/payments/customer_receipts store
        // supplier_id/customer_id (foreign keys), not a denormalized
        // name column -- these lookup maps resolve the actual name
        // instead of guessing a column that doesn't exist.
        const [suppliersRes, customersRes, wholesaleRes, nhimaRes] = await Promise.all([
            supabaseClient.from('suppliers').select('id, name'),
            supabaseClient.from('customers').select('id, full_name'),
            supabaseClient.from('wholesale_customers').select('id, customer_name'),
            supabaseClient.from('nhima_members').select('id, full_name')
        ]);
        const supplierMap = {}, customerMap = {};
        (suppliersRes.data || []).forEach(s => { supplierMap[s.id] = s.name; });
        (customersRes.data || []).forEach(c => { customerMap[c.id] = c.full_name; });
        (wholesaleRes.data || []).forEach(c => { customerMap[c.id] = c.customer_name; });
        (nhimaRes.data || []).forEach(c => { customerMap[c.id] = c.full_name; });

        // ---- SALE (retail + wholesale share the sales table) ----
        const { data: sales } = await supabaseClient
            .from('sales')
            .select('*')
            .in('client_type', ['RETAIL', 'WHOLESALE'])
            .neq('is_quotation', true)
            .gte('created_at', start).lte('created_at', end);
        (sales || []).forEach(s => allTransactions.push({
            // 🔥 FIX: confirmed against real data that Wholesale sales
            // store the party's name under customer_data.customer_name,
            // not full_name -- Retail's own field. Every Wholesale row
            // was silently falling through to 'N/A' because full_name
            // never existed on those records at all. Checks Retail's
            // field first, falls back to Wholesale's.
            type: 'Sale', reference: s.sale_id,
            party: s.customer_data?.full_name || s.customer_data?.customer_name || 'N/A',
            time: s.created_at, amount: s.grand_total || 0,
            folder: s.client_type === 'WHOLESALE' ? 'wholesale' : 'retail',
            editFn: s.client_type === 'WHOLESALE' ? 'loadWholesaleForEdit' : 'loadSaleForEdit',
            editArg: s
        }));

        // ---- DONATION ----
        const { data: donations } = await supabaseClient
            .from('sales')
            .select('*')
            .eq('client_type', 'DONATION')
            .neq('is_quotation', true)
            .gte('created_at', start).lte('created_at', end);
        (donations || []).forEach(d => allTransactions.push({
            type: 'Donation', reference: d.sale_id, party: d.customer_data?.full_name || 'N/A',
            time: d.created_at, amount: d.grand_total || 0,
            folder: 'donation', editFn: 'loadDonationForEdit', editArg: d
        }));

        // ---- WRITE-OFF ----
        const { data: writeoffs } = await supabaseClient
            .from('write_offs')
            .select('*')
            .gte('created_at', start).lte('created_at', end);
        (writeoffs || []).forEach(w => allTransactions.push({
            type: 'Write-Off', reference: w.reference_number, party: w.reason || 'N/A',
            time: w.created_at, amount: w.total_cost_written_off || 0,
            folder: 'writeoff', editFn: 'loadWriteOffForEdit', editArg: w
        }));

        // ---- PURCHASE (purchase orders created today) ----
        const { data: purchases } = await supabaseClient
            .from('purchase_orders')
            .select('*')
            .gte('created_at', start).lte('created_at', end);
        (purchases || []).forEach(p => allTransactions.push({
            type: 'Purchase', reference: p.po_number, party: supplierMap[p.supplier_id] || 'N/A',
            time: p.created_at, amount: p.total_amount || 0,
            folder: 'purchase', editFn: 'editPO', editArg: p.id
        }));

        // ---- PAYMENT ----
        const { data: payments } = await supabaseClient
            .from('payments')
            .select('*')
            .gte('created_at', start).lte('created_at', end);
        (payments || []).forEach(pm => allTransactions.push({
            type: 'Payment', reference: pm.payment_number, party: supplierMap[pm.supplier_id] || 'N/A',
            time: pm.created_at || pm.payment_date, amount: pm.amount || 0,
            folder: 'payments', editFn: null, editArg: null
        }));

        // ---- RECEIPT ----
        const { data: receipts } = await supabaseClient
            .from('customer_receipts')
            .select('*')
            .gte('created_at', start).lte('created_at', end);
        (receipts || []).forEach(r => allTransactions.push({
            type: 'Receipt', reference: r.receipt_number,
            party: customerMap[r.customer_id] || customerMap[r.wholesale_customer_id] || 'N/A',
            time: r.created_at || r.receipt_date, amount: r.amount || 0,
            folder: 'receipts', editFn: null, editArg: null
        }));

        allTransactions.sort((a, b) => new Date(b.time) - new Date(a.time));
    }

    // ============================================
    // RENDER
    // ============================================
    const TYPE_COLORS = {
        'Sale': '#059669', 'Purchase': '#2563eb', 'Write-Off': '#dc2626',
        'Payment': '#f59e0b', 'Donation': '#8b5cf6', 'Receipt': '#0891b2'
    };

    function render() {
        const tbody = document.getElementById('txnTableBody');
        if (!tbody) return;

        const searchTerm = (document.getElementById('txnSearchInput')?.value || '').toLowerCase();
        const typeFilter = document.getElementById('txnTypeFilter')?.value || 'all';

        let filtered = allTransactions;
        if (typeFilter !== 'all') filtered = filtered.filter(t => t.type === typeFilter);
        if (searchTerm) {
            filtered = filtered.filter(t =>
                (t.reference || '').toLowerCase().includes(searchTerm) ||
                (t.party || '').toLowerCase().includes(searchTerm) ||
                (t.amount || '').toString().includes(searchTerm)
            );
        }

        if (filtered.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:30px;color:#94a3b8;">No transactions found${searchTerm ? ' matching your search' : ' for today'}.</td></tr>`;
            return;
        }

        tbody.innerHTML = filtered.map((t, idx) => `
            <tr style="cursor:pointer;" onclick="openTransactionRow(${idx})" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background=''">
                <td style="padding-left:20px;">
                    <span style="background:${TYPE_COLORS[t.type]}20; color:${TYPE_COLORS[t.type]}; padding:3px 10px; border-radius:10px; font-size:0.75rem; font-weight:600;">${t.type}</span>
                </td>
                <td style="font-weight:500;">${esc(t.reference)}</td>
                <td>${esc(t.party)}</td>
                <td>${formatTime(t.time)}</td>
                <td style="text-align:right; padding-right:20px; font-weight:600;">K${formatNumber(t.amount)}</td>
            </tr>
        `).join('');

        // Store the filtered list for row-click lookups by index
        window.__txnFilteredList = filtered;
    }

    // ============================================
    // DEEP-LINK INTO THE TARGET MODULE
    // ============================================
    function waitForFunction(fnName, timeoutMs = 5000) {
        return new Promise((resolve, reject) => {
            const start = Date.now();
            (function check() {
                if (typeof window[fnName] === 'function') {
                    resolve(window[fnName]);
                } else if (Date.now() - start > timeoutMs) {
                    reject(new Error(`Timed out waiting for window.${fnName}`));
                } else {
                    setTimeout(check, 100);
                }
            })();
        });
    }

    window.openTransactionRow = async function (index) {
        const record = window.__txnFilteredList[index];
        if (!record) return;

        loadSubModule('transaction', record.folder);

        if (!record.editFn) {
            // Payment / Receipt -- no edit entry point exists in either
            // module, so just land on the module itself.
            return;
        }

        try {
            const fn = await waitForFunction(record.editFn);
            fn(record.editArg);
        } catch (error) {
            console.warn(`Could not auto-open ${record.type} for edit:`, error);
        }
    };

    window.refreshTransactionOverview = async function () {
        const tbody = document.getElementById('txnTableBody');
        if (tbody) tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:30px;color:#94a3b8;"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</td></tr>`;
        await loadTodaysTransactions();
        render();
    };

    // ============================================
    // INIT
    // ============================================
    await loadTodaysTransactions();
    render();

    document.getElementById('txnSearchInput')?.addEventListener('input', render);
    document.getElementById('txnTypeFilter')?.addEventListener('change', render);

    console.log("✅ Transaction Overview initialized successfully!");
})();
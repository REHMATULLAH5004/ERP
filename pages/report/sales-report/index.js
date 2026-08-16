// ============================================
// SALES REPORT
// ============================================
// Replaces the old single-date "Daily Sales Breakdown" (pages/report/
// daily-sales/index.js, never linked in the Report sidebar). That
// version could only ever look at one calendar day and only broke sales
// down by payment method. This version:
//   - takes a date RANGE (From/To) instead of a single date
//   - lets you filter down to one sale type instead of always showing all
//   - adds two more breakdowns on top of the original payment one:
//     Item-Wise (what sold, how much, how many invoices) and
//     Customer-Wise (who bought, how many invoices, how much)
//
// Payment classification (classifyRow/classifyColumn below) is carried
// over UNCHANGED from the old report -- it was already verified against
// retail.js/wholesale.js's own accounting code:
//   NHIMA sales -> ALWAYS Accounts Receivable, unconditionally, regardless
//     of whatever payment.type says (NHIMA authority pays later, never
//     immediate cash).
//   Everything else -> payment.type drives it: 'Cash' -> Cash In Hand,
//     'Bank Transfer' -> Bank Transfer (already received, NOT the same
//     as owed), 'Credit' -> Accounts Receivable. Anything else defaults
//     to Cash In Hand, matching the fallback in the accounting code itself.
//   Write-Off/Donation -> genuinely has no payment side (donations are
//     given away, write-offs are pure inventory loss), so it stays at
//     zero by design, not because it's being hidden.
//
// 🔥 FIX: the old report's query filtered client_type to
// ['RETAIL', 'WHOLESALE', 'DONATION'] -- but write-offs are saved with
// client_type = 'WRITEOFF' (a different value from 'DONATION'; verified
// directly against the sales table), so every write-off silently never
// appeared in the "Write-Off / Donation" row despite that row existing
// specifically for them. 'WRITEOFF' is now included in the filter.
// ============================================

(async function initSalesReport() {
    console.log("Sales Report initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    const ROWS = [
        { key: 'NHIMA', label: 'NHIMA Sale' },
        { key: 'REGULAR', label: 'Regular Sale' },
        { key: 'ONLINE', label: 'Online Sale' },
        { key: 'STAFF', label: 'Staff Sale' },
        { key: 'WHOLESALE', label: 'Wholesale (Internal or Regular)' },
        { key: 'WRITEOFF_DONATION', label: 'Write-Off / Donation' }
    ];

    const state = {
        fromDate: '',
        toDate: '',
        typeFilter: 'ALL',
        activeView: 'breakdown',   // 'breakdown' | 'item' | 'customer'
        sales: [],                 // filtered sales for the last Generate
        itemRows: [],               // aggregated, cached so tab switches/sorts don't re-fetch
        itemRowsRendered: [],       // last-rendered (sorted) copy of itemRows -- what row click handlers index into
        itemSort: { field: 'revenue', dir: 'desc' },
        customerRows: [],
        customerRowsRendered: [],
        customerSort: { field: 'revenue', dir: 'desc' }
    };

    function formatNumber(num) {
        return (num || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    // ============================================
    // CLASSIFICATION (unchanged from the old report)
    // ============================================

    function classifyRow(sale) {
        if (sale.client_type === 'DONATION' || sale.client_type === 'WRITEOFF') return 'WRITEOFF_DONATION';
        if (sale.client_sub_type === 'NHIMA') return 'NHIMA';
        if (sale.client_type === 'WHOLESALE') return 'WHOLESALE';
        if (sale.client_sub_type === 'ONLINE') return 'ONLINE';
        if (sale.client_sub_type === 'STAFF') return 'STAFF';
        return 'REGULAR';
    }

    function classifyColumn(sale) {
        if (sale.client_sub_type === 'NHIMA') return 'receivable';
        const paymentType = sale.payment?.type;
        if (paymentType === 'Bank Transfer') return 'bank';
        if (paymentType === 'Credit') return 'receivable';
        return 'cash';
    }

    // ============================================
    // FETCH + FILTER
    // ============================================

    async function fetchSales(fromDate, toDate) {
        const rangeStart = `${fromDate}T00:00:00`;
        const rangeEnd = `${toDate}T23:59:59`;

        const { data: sales, error } = await supabaseClient
            .from('sales')
            .select('id, sale_id, client_type, client_sub_type, payment, grand_total, items, customer_data, customer_id, created_at')
            .in('client_type', ['RETAIL', 'WHOLESALE', 'DONATION', 'WRITEOFF'])
            .neq('is_quotation', true)
            .gte('created_at', rangeStart)
            .lte('created_at', rangeEnd);

        if (error) throw error;
        return sales || [];
    }

    // ============================================
    // AGGREGATION
    // ============================================

    function computeBreakdown(sales) {
        const results = {};
        ROWS.forEach(r => { results[r.key] = { cash: 0, bank: 0, receivable: 0 }; });

        sales.forEach(sale => {
            const row = classifyRow(sale);
            const col = classifyColumn(sale);
            results[row][col] += parseFloat(sale.grand_total) || 0;
        });

        return results;
    }

    function computeItemWise(sales) {
        const map = new Map(); // product key -> { name, qty, revenue, sales: Set, lines: [] }

        sales.forEach(sale => {
            const typeLabel = (ROWS.find(r => r.key === classifyRow(sale)) || {}).label || 'Sale';
            // Same full_name / customer_name fallback as computeCustomerWise
            // below -- Wholesale saves the name under a different key than
            // everyone else.
            const customerName = sale.customer_data?.full_name || sale.customer_data?.customer_name || 'Unknown Customer';
            (sale.items || []).forEach(item => {
                const key = item.product_id || item.product_name || 'unknown';
                if (!map.has(key)) {
                    map.set(key, { name: item.product_name || 'Unknown Product', qty: 0, revenue: 0, sales: new Set(), lines: [] });
                }
                const entry = map.get(key);
                entry.qty += parseFloat(item.qty) || 0;
                entry.revenue += parseFloat(item.total) || 0;
                entry.sales.add(sale.id);
                // Kept per-line (not just per-invoice) so clicking a product
                // shows every invoice it appeared on, and who bought it --
                // see showSalesReportItemInvoices().
                entry.lines.push({
                    saleId: sale.sale_id || sale.id,
                    createdAt: sale.created_at,
                    typeLabel,
                    customerName,
                    qty: parseFloat(item.qty) || 0,
                    rate: parseFloat(item.rate) || 0,
                    total: parseFloat(item.total) || 0
                });
            });
        });

        return Array.from(map.entries()).map(([key, e]) => ({
            key,
            name: e.name,
            qty: e.qty,
            revenue: e.revenue,
            txns: e.sales.size,
            lines: e.lines
        }));
    }

    function computeCustomerWise(sales) {
        const map = new Map(); // customer key -> { name, phone, revenue, sales: Set, invoices: [] }

        sales.forEach(sale => {
            // 🔥 FIX: Retail/NHIMA/Donation/Write-Off save the customer's
            // name under customer_data.full_name, but Wholesale saves it
            // under customer_data.customer_name instead (verified against
            // wholesale/index.js's own customer object, and against real
            // sales rows -- wholesale sales were grouping into "Unknown
            // Customer" before this fallback was added). Try both.
            const customerName = sale.customer_data?.full_name || sale.customer_data?.customer_name || 'Unknown Customer';
            const key = sale.customer_id || customerName || sale.id;
            if (!map.has(key)) {
                map.set(key, {
                    name: customerName,
                    phone: sale.customer_data?.phone || '-',
                    revenue: 0,
                    sales: new Set(),
                    invoices: []
                });
            }
            const entry = map.get(key);
            entry.revenue += parseFloat(sale.grand_total) || 0;
            entry.sales.add(sale.id);
            // Kept so clicking a customer shows exactly which invoices make
            // up their total, AND what was actually on each one -- see
            // showSalesReportCustomerInvoices().
            const itemsSummary = (sale.items || [])
                .map(item => `${item.product_name || 'Unknown'} (x${formatNumber(parseFloat(item.qty) || 0)})`)
                .join(', ') || '-';
            entry.invoices.push({
                saleId: sale.sale_id || sale.id,
                createdAt: sale.created_at,
                typeLabel: (ROWS.find(r => r.key === classifyRow(sale)) || {}).label || 'Sale',
                paymentType: sale.payment?.type || (sale.client_sub_type === 'NHIMA' ? 'NHIMA (Credit)' : '-'),
                itemsSummary,
                total: parseFloat(sale.grand_total) || 0
            });
        });

        return Array.from(map.entries()).map(([key, e]) => ({
            key,
            name: e.name,
            phone: e.phone,
            revenue: e.revenue,
            txns: e.sales.size,
            invoices: e.invoices
        }));
    }

    // ============================================
    // SORTING (client-side, over the already-aggregated rows -- no re-fetch)
    // ============================================

    function sortRows(rows, sort) {
        const factor = sort.dir === 'asc' ? 1 : -1;
        return [...rows].sort((a, b) => (a[sort.field] - b[sort.field]) * factor);
    }

    window.sortSalesReportItems = function (field) {
        if (state.itemSort.field === field) {
            state.itemSort.dir = state.itemSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
            state.itemSort = { field, dir: 'desc' };
        }
        renderItemTable();
    };

    window.sortSalesReportCustomers = function (field) {
        if (state.customerSort.field === field) {
            state.customerSort.dir = state.customerSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
            state.customerSort = { field, dir: 'desc' };
        }
        renderCustomerTable();
    };

    // ============================================
    // RENDER -- BREAKDOWN
    // ============================================

    function renderBreakdown() {
        const tbody = document.getElementById('salesRepBreakdownBody');
        const results = computeBreakdown(state.sales);
        let grandCash = 0, grandBank = 0, grandReceivable = 0;

        const rowsHtml = ROWS.map(r => {
            const d = results[r.key];
            const total = d.cash + d.bank + d.receivable;
            grandCash += d.cash; grandBank += d.bank; grandReceivable += d.receivable;

            return `
                <tr>
                    <td style="padding-left:20px; font-weight:500;">${r.label}</td>
                    <td style="text-align:right;">K${formatNumber(d.cash)}</td>
                    <td style="text-align:right;">K${formatNumber(d.bank)}</td>
                    <td style="text-align:right;">K${formatNumber(d.receivable)}</td>
                    <td style="text-align:right; padding-right:20px; font-weight:600;">K${formatNumber(total)}</td>
                </tr>
            `;
        }).join('');

        const grandTotal = grandCash + grandBank + grandReceivable;
        const totalRow = `
            <tr style="border-top:2px solid #0f172a; font-weight:700;">
                <td style="padding-left:20px;">Total</td>
                <td style="text-align:right;">K${formatNumber(grandCash)}</td>
                <td style="text-align:right;">K${formatNumber(grandBank)}</td>
                <td style="text-align:right;">K${formatNumber(grandReceivable)}</td>
                <td style="text-align:right; padding-right:20px;">K${formatNumber(grandTotal)}</td>
            </tr>
        `;

        tbody.innerHTML = rowsHtml + totalRow;
    }

    // ============================================
    // RENDER -- ITEM-WISE
    // ============================================

    function renderItemTable() {
        const tbody = document.getElementById('salesRepItemBody');
        if (state.itemRows.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:30px;color:#94a3b8;">No items sold in this range.</td></tr>`;
            return;
        }

        // Stored so a row's onclick can look itself up by index without
        // re-sorting or embedding the product name (which can contain
        // quotes/apostrophes) directly into an inline attribute.
        state.itemRowsRendered = sortRows(state.itemRows, state.itemSort);
        tbody.innerHTML = state.itemRowsRendered.map((row, i) => `
            <tr class="salesrep-clickable-row" onclick="showSalesReportItemInvoices(${i})" title="Click to see which invoices this product sold on">
                <td style="padding-left:20px;">${row.name}</td>
                <td style="text-align:right;">${formatNumber(row.qty)}</td>
                <td style="text-align:right;">${row.txns}</td>
                <td style="text-align:right; padding-right:20px; font-weight:600;">K${formatNumber(row.revenue)}</td>
            </tr>
        `).join('');
    }

    // ============================================
    // RENDER -- CUSTOMER-WISE
    // ============================================

    function renderCustomerTable() {
        const tbody = document.getElementById('salesRepCustomerBody');
        if (state.customerRows.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:30px;color:#94a3b8;">No customers in this range.</td></tr>`;
            return;
        }

        // Same index-lookup approach as the item table -- see the comment
        // there.
        state.customerRowsRendered = sortRows(state.customerRows, state.customerSort);
        tbody.innerHTML = state.customerRowsRendered.map((row, i) => `
            <tr class="salesrep-clickable-row" onclick="showSalesReportCustomerInvoices(${i})" title="Click to see this customer's invoices">
                <td style="padding-left:20px;">${row.name}</td>
                <td>${row.phone}</td>
                <td style="text-align:right;">${row.txns}</td>
                <td style="text-align:right; padding-right:20px; font-weight:600;">K${formatNumber(row.revenue)}</td>
            </tr>
        `).join('');
    }

    // ============================================
    // DRILL-DOWN MODAL -- "click a customer/item to see the invoices
    // behind that total" (this is the whole point of a breakdown report;
    // without it the numbers can't actually be checked against anything).
    // ============================================

    function formatDate(dateStr) {
        return dateStr ? new Date(dateStr).toLocaleString() : 'N/A';
    }

    function openDrillModal(title, theadHtml, rowsHtml) {
        document.getElementById('salesRepDrillTitle').innerHTML = `<i class="fa-solid fa-receipt"></i> ${title}`;
        document.getElementById('salesRepDrillTableContainer').innerHTML = `
            <table class="table-minimal" style="width:100%;">
                <thead>${theadHtml}</thead>
                <tbody>${rowsHtml}</tbody>
            </table>
        `;
        document.getElementById('salesRepDrillModal').classList.add('show');
    }

    window.showSalesReportItemInvoices = function (index) {
        const row = state.itemRowsRendered?.[index];
        if (!row) return;

        const lines = [...row.lines].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        const theadHtml = `<tr><th style="padding-left:20px;">Invoice #</th><th>Date</th><th>Customer</th><th>Sale Type</th><th style="text-align:right;">Qty</th><th style="text-align:right;">Rate</th><th style="text-align:right; padding-right:20px;">Line Total</th></tr>`;
        const rowsHtml = lines.map(l => `
            <tr>
                <td style="padding-left:20px;">${l.saleId}</td>
                <td>${formatDate(l.createdAt)}</td>
                <td>${l.customerName}</td>
                <td><span class="category-badge">${l.typeLabel}</span></td>
                <td style="text-align:right;">${formatNumber(l.qty)}</td>
                <td style="text-align:right;">K${formatNumber(l.rate)}</td>
                <td style="text-align:right; padding-right:20px; font-weight:600;">K${formatNumber(l.total)}</td>
            </tr>
        `).join('') + `
            <tr style="border-top:2px solid #0f172a; font-weight:700;">
                <td style="padding-left:20px;" colspan="6">Total (${row.txns} invoice${row.txns === 1 ? '' : 's'})</td>
                <td style="text-align:right; padding-right:20px;">K${formatNumber(row.revenue)}</td>
            </tr>
        `;

        openDrillModal(`Invoices -- ${row.name}`, theadHtml, rowsHtml);
    };

    window.showSalesReportCustomerInvoices = function (index) {
        const row = state.customerRowsRendered?.[index];
        if (!row) return;

        const invoices = [...row.invoices].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        const theadHtml = `<tr><th style="padding-left:20px;">Invoice #</th><th>Date</th><th>Sale Type</th><th>Items</th><th>Payment</th><th style="text-align:right; padding-right:20px;">Amount</th></tr>`;
        const rowsHtml = invoices.map(inv => `
            <tr>
                <td style="padding-left:20px;">${inv.saleId}</td>
                <td>${formatDate(inv.createdAt)}</td>
                <td><span class="category-badge">${inv.typeLabel}</span></td>
                <td style="font-size:0.8rem; color:#475569; max-width:260px;">${inv.itemsSummary}</td>
                <td>${inv.paymentType}</td>
                <td style="text-align:right; padding-right:20px; font-weight:600;">K${formatNumber(inv.total)}</td>
            </tr>
        `).join('') + `
            <tr style="border-top:2px solid #0f172a; font-weight:700;">
                <td style="padding-left:20px;" colspan="5">Total (${row.txns} invoice${row.txns === 1 ? '' : 's'})</td>
                <td style="text-align:right; padding-right:20px;">K${formatNumber(row.revenue)}</td>
            </tr>
        `;

        openDrillModal(`Invoices -- ${row.name}`, theadHtml, rowsHtml);
    };

    window.closeSalesReportDrillModal = function () {
        document.getElementById('salesRepDrillModal').classList.remove('show');
    };

    // ============================================
    // GENERATE
    // ============================================

    window.loadSalesReport = async function () {
        const fromDate = document.getElementById('salesRepFromDate').value;
        const toDate = document.getElementById('salesRepToDate').value;

        if (!fromDate || !toDate) { alert('Please pick both a From and To date.'); return; }
        if (fromDate > toDate) { alert('The From date must be on or before the To date.'); return; }

        state.fromDate = fromDate;
        state.toDate = toDate;
        state.typeFilter = document.getElementById('salesRepTypeFilter').value;

        ['salesRepBreakdownBody', 'salesRepItemBody', 'salesRepCustomerBody'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:30px;color:#94a3b8;"><i class="fa-solid fa-spinner fa-spin"></i> Generating...</td></tr>`;
        });

        try {
            const allSales = await fetchSales(fromDate, toDate);
            state.sales = state.typeFilter === 'ALL'
                ? allSales
                : allSales.filter(sale => classifyRow(sale) === state.typeFilter);

            state.itemRows = computeItemWise(state.sales);
            state.customerRows = computeCustomerWise(state.sales);

            renderBreakdown();
            renderItemTable();
            renderCustomerTable();
        } catch (error) {
            console.error('Error generating sales report:', error);
            ['salesRepBreakdownBody', 'salesRepItemBody', 'salesRepCustomerBody'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:30px;color:#dc2626;">Error: ${error.message}</td></tr>`;
            });
        }
    };

    // ============================================
    // TABS
    // ============================================

    window.switchSalesReportView = function (view) {
        state.activeView = view;

        document.getElementById('salesRepTabBreakdown').classList.toggle('active', view === 'breakdown');
        document.getElementById('salesRepTabItem').classList.toggle('active', view === 'item');
        document.getElementById('salesRepTabCustomer').classList.toggle('active', view === 'customer');

        document.getElementById('salesRepBreakdownView').style.display = view === 'breakdown' ? '' : 'none';
        document.getElementById('salesRepItemView').style.display = view === 'item' ? '' : 'none';
        document.getElementById('salesRepCustomerView').style.display = view === 'customer' ? '' : 'none';
    };

    // ============================================
    // EXCEL EXPORT -- exports whichever view is currently active, over
    // the currently generated date range/type filter.
    // ============================================

    window.exportSalesReportToExcel = function () {
        if (state.sales.length === 0 && state.itemRows.length === 0 && state.customerRows.length === 0) {
            alert('Generate the report first.');
            return;
        }

        let exportRows = [];
        let sheetName = 'Sales Report';

        if (state.activeView === 'breakdown') {
            const results = computeBreakdown(state.sales);
            exportRows = ROWS.map(r => {
                const d = results[r.key];
                return {
                    'Sale Type': r.label,
                    'Cash In Hand (K)': d.cash,
                    'Bank Transfer (K)': d.bank,
                    'Accounts Receivable (K)': d.receivable,
                    'Total (K)': d.cash + d.bank + d.receivable
                };
            });
            sheetName = 'Payment Breakdown';
        } else if (state.activeView === 'item') {
            exportRows = sortRows(state.itemRows, state.itemSort).map(row => ({
                'Product': row.name,
                'Qty Sold': row.qty,
                'Invoices': row.txns,
                'Revenue (K)': row.revenue
            }));
            sheetName = 'Item-Wise Sale';
        } else if (state.activeView === 'customer') {
            exportRows = sortRows(state.customerRows, state.customerSort).map(row => ({
                'Customer': row.name,
                'Phone': row.phone,
                'Invoices': row.txns,
                'Total Sales (K)': row.revenue
            }));
            sheetName = 'Customer-Wise Sale';
        }

        if (exportRows.length === 0) {
            alert('Nothing to export for the current view.');
            return;
        }

        const filename = `Sales_Report_${state.fromDate}_to_${state.toDate}_${sheetName.replace(/\s+/g, '_')}.xlsx`;
        const ok = typeof exportRowsToExcel === 'function'
            ? exportRowsToExcel(filename, sheetName, exportRows)
            : false;

        if (!ok) {
            alert('Excel export failed -- check the browser console for details.');
        }
    };

    // ============================================
    // PRINT -- prints whichever view is currently active
    // ============================================

    window.printSalesReport = function () {
        if (state.sales.length === 0 && state.itemRows.length === 0 && state.customerRows.length === 0) {
            alert('Generate the report first.');
            return;
        }

        const rangeLabel = state.fromDate === state.toDate
            ? new Date(state.fromDate + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
            : `${new Date(state.fromDate + 'T00:00:00').toLocaleDateString()} to ${new Date(state.toDate + 'T00:00:00').toLocaleDateString()}`;

        let title, theadHtml, rowsHtml;

        if (state.activeView === 'breakdown') {
            const results = computeBreakdown(state.sales);
            let grandCash = 0, grandBank = 0, grandReceivable = 0;
            title = 'Payment Breakdown';
            theadHtml = `<tr><th>Sale Type</th><th style="text-align:right;">Cash In Hand</th><th style="text-align:right;">Bank Transfer</th><th style="text-align:right;">Accounts Receivable</th><th style="text-align:right;">Total</th></tr>`;
            rowsHtml = ROWS.map(r => {
                const d = results[r.key];
                const total = d.cash + d.bank + d.receivable;
                grandCash += d.cash; grandBank += d.bank; grandReceivable += d.receivable;
                return `<tr><td>${r.label}</td><td style="text-align:right;">K${formatNumber(d.cash)}</td><td style="text-align:right;">K${formatNumber(d.bank)}</td><td style="text-align:right;">K${formatNumber(d.receivable)}</td><td style="text-align:right;font-weight:700;">K${formatNumber(total)}</td></tr>`;
            }).join('');
            const grandTotal = grandCash + grandBank + grandReceivable;
            rowsHtml += `<tr style="font-weight:700; border-top:2px solid #0f172a;"><td>Total</td><td style="text-align:right;">K${formatNumber(grandCash)}</td><td style="text-align:right;">K${formatNumber(grandBank)}</td><td style="text-align:right;">K${formatNumber(grandReceivable)}</td><td style="text-align:right;">K${formatNumber(grandTotal)}</td></tr>`;
        } else if (state.activeView === 'item') {
            title = 'Item-Wise Sale';
            theadHtml = `<tr><th>Product</th><th style="text-align:right;">Qty Sold</th><th style="text-align:right;">Invoices</th><th style="text-align:right;">Revenue</th></tr>`;
            rowsHtml = sortRows(state.itemRows, state.itemSort).map(row =>
                `<tr><td>${row.name}</td><td style="text-align:right;">${formatNumber(row.qty)}</td><td style="text-align:right;">${row.txns}</td><td style="text-align:right;font-weight:700;">K${formatNumber(row.revenue)}</td></tr>`
            ).join('');
        } else {
            title = 'Customer-Wise Sale';
            theadHtml = `<tr><th>Customer</th><th>Phone</th><th style="text-align:right;">Invoices</th><th style="text-align:right;">Total Sales</th></tr>`;
            rowsHtml = sortRows(state.customerRows, state.customerSort).map(row =>
                `<tr><td>${row.name}</td><td>${row.phone}</td><td style="text-align:right;">${row.txns}</td><td style="text-align:right;font-weight:700;">K${formatNumber(row.revenue)}</td></tr>`
            ).join('');
        }

        const printWindow = window.open('', '_blank', 'width=800,height=700');
        if (!printWindow) { alert('Please allow popups to print.'); return; }

        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Sales Report - ${title}</title>
                <style>
                    body { font-family: Arial, sans-serif; padding: 30px; color: #0f172a; }
                    h1 { margin-bottom: 2px; font-size: 1.3rem; }
                    .subtitle { color: #64748b; margin-top: 0; margin-bottom: 24px; font-size: 0.9rem; }
                    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
                    th, td { padding: 8px 10px; border: 1px solid #e2e8f0; text-align: left; }
                    th { background: #f1f5f9; }
                </style>
            </head>
            <body>
                <h1>Sales Report -- ${title}</h1>
                <p class="subtitle">${rangeLabel}${state.typeFilter !== 'ALL' ? ' &middot; ' + (ROWS.find(r => r.key === state.typeFilter)?.label || state.typeFilter) + ' only' : ''} &middot; Generated ${new Date().toLocaleString()}</p>
                <table>
                    <thead>${theadHtml}</thead>
                    <tbody>${rowsHtml}</tbody>
                </table>
                <script>window.onload = function() { window.print(); };<\/script>
            </body>
            </html>
        `);
        printWindow.document.close();
    };

    // ============================================
    // MODAL DISMISS -- Escape key or clicking the dark backdrop
    // ============================================
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') window.closeSalesReportDrillModal();
    });
    document.getElementById('salesRepDrillModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'salesRepDrillModal') window.closeSalesReportDrillModal();
    });

    // ============================================
    // INIT -- defaults both dates to today, matching the old report's
    // default of "today" so Generate-on-load behaves the same way.
    // ============================================
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    document.getElementById('salesRepFromDate').value = todayStr;
    document.getElementById('salesRepToDate').value = todayStr;

    await window.loadSalesReport();

    console.log("✅ Sales Report initialized successfully!");
})();
// ============================================
// PURCHASE REPORT
// ============================================
// Replaces the old single-date "Daily Purchase Report" (pages/report/
// daily-purchase/index.js, never linked in the Report sidebar). Same
// upgrade the Sales Report got: a date RANGE instead of one day, filters
// (Supplier / Currency / Payment Type) instead of always showing
// everything, and two new breakdowns -- Supplier-Wise and Item-Wise,
// both click-through to the actual GRNs -- on top of the original Cash
// vs Credit summary.
//
// Paid vs Payable classification is carried over UNCHANGED from the old
// report -- verified directly against purchase/index.js's own code:
// createSupplierPayable() is called ONLY when the GRN's payment type was
// 'Credit'; a Cash GRN never creates a payable row at all (and
// goods_receipt_notes itself has no payment-type column). So "does a
// supplier_payables row exist for this GRN" IS the Cash/Credit signal.
//
// 🔥 FIX: the old report added every Cash-paid GRN's invoice_total into
// one "paidTotal" number and printed it with a "K" (Kwacha) prefix --
// but invoice_total is in the GRN's OWN currency, so a USD cash purchase
// would get added into that ZMW-labeled total in raw dollar amount, no
// conversion, no distinction. Every total in this version is kept
// strictly per-currency (ZMW and USD never combined), matching how the
// old report already (correctly) kept Payable ZMW and Payable USD apart.
// ============================================

(async function initPurchaseReport() {
    console.log("Purchase Report initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    const state = {
        fromDate: '',
        toDate: '',
        supplierFilter: 'all',
        currencyFilter: 'all',
        paymentFilter: 'all',
        activeView: 'breakdown',   // 'breakdown' | 'supplier' | 'item'
        suppliers: [],
        grns: [],                  // filtered GRNs for the last Generate
        supplierRows: [],
        supplierRowsRendered: [],
        supplierSort: { field: 'zmwTotal', dir: 'desc' },
        itemRows: [],
        itemRowsRendered: [],
        itemSort: { field: 'zmwSpend', dir: 'desc' }
    };

    function formatNumber(num) {
        return (num || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function formatDate(dateStr) {
        return dateStr ? new Date(dateStr).toLocaleDateString() : 'N/A';
    }

    // ============================================
    // LOAD SUPPLIERS (for the filter dropdown)
    // ============================================

    async function loadSuppliers() {
        try {
            const { data, error } = await supabaseClient
                .from('suppliers')
                .select('id, name')
                .order('name');

            if (error) throw error;
            state.suppliers = data || [];

            const sel = document.getElementById('purchRepSupplierFilter');
            if (sel) {
                state.suppliers.forEach(s => {
                    const opt = document.createElement('option');
                    opt.value = s.id;
                    opt.textContent = s.name;
                    sel.appendChild(opt);
                });
            }
        } catch (error) {
            console.error('Error loading suppliers:', error);
        }
    }

    // ============================================
    // FETCH
    // ============================================

    async function fetchGRNs(fromDate, toDate) {
        const { data: grns, error } = await supabaseClient
            .from('goods_receipt_notes')
            .select('id, grn_number, entry_date, currency, invoice_total, supplier_id, suppliers ( name )')
            .gte('entry_date', fromDate)
            .lte('entry_date', toDate);

        if (error) throw error;
        if (!grns || grns.length === 0) return [];

        const grnIds = grns.map(g => g.id);
        const { data: payables, error: payableError } = await supabaseClient
            .from('supplier_payables')
            .select('grn_id, currency, total_amount')
            .in('grn_id', grnIds);

        if (payableError) throw payableError;

        const payableByGrnId = {};
        (payables || []).forEach(p => { payableByGrnId[p.grn_id] = p; });

        return grns.map(grn => {
            const payable = payableByGrnId[grn.id];
            return {
                id: grn.id,
                grnNumber: grn.grn_number,
                entryDate: grn.entry_date,
                currency: grn.currency,
                amount: parseFloat(grn.invoice_total) || 0,
                supplierId: grn.supplier_id,
                supplierName: grn.suppliers?.name || 'Unknown Supplier',
                // No payable row for this GRN -> it was paid in cash. See
                // the module header comment for why this is the correct
                // signal (verified against purchase/index.js itself).
                paymentType: payable ? 'CREDIT' : 'CASH'
            };
        });
    }

    async function fetchLines(grnIds) {
        if (grnIds.length === 0) return [];
        const { data, error } = await supabaseClient
            .from('goods_receipt_lines')
            .select('grn_id, product_id, product_name, received_quantity, purchase_rate, batch_number, total_amount')
            .in('grn_id', grnIds);

        if (error) throw error;
        return data || [];
    }

    // ============================================
    // AGGREGATION
    // ============================================

    function computeBreakdown(grns) {
        const results = {
            CASH: { zmw: 0, usd: 0, count: 0 },
            CREDIT: { zmw: 0, usd: 0, count: 0 }
        };

        grns.forEach(grn => {
            const bucket = results[grn.paymentType];
            if (grn.currency === 'USD') bucket.usd += grn.amount;
            else bucket.zmw += grn.amount;
            bucket.count += 1;
        });

        return results;
    }

    function computeSupplierWise(grns) {
        const map = new Map(); // supplier key -> { name, zmwTotal, usdTotal, grns: [] }

        grns.forEach(grn => {
            const key = grn.supplierId || grn.supplierName;
            if (!map.has(key)) {
                map.set(key, { name: grn.supplierName, zmwTotal: 0, usdTotal: 0, grns: [] });
            }
            const entry = map.get(key);
            if (grn.currency === 'USD') entry.usdTotal += grn.amount;
            else entry.zmwTotal += grn.amount;
            entry.grns.push(grn);
        });

        return Array.from(map.entries()).map(([key, e]) => ({
            key,
            name: e.name,
            zmwTotal: e.zmwTotal,
            usdTotal: e.usdTotal,
            grnCount: e.grns.length,
            grns: e.grns
        }));
    }

    function computeItemWise(lines, grnById) {
        const map = new Map(); // product key -> { name, qty, zmwSpend, usdSpend, grnIds: Set, lines: [] }

        lines.forEach(line => {
            const grn = grnById.get(line.grn_id);
            if (!grn) return; // line belongs to a GRN outside the current filters -- skip

            const key = line.product_id || line.product_name || 'unknown';
            if (!map.has(key)) {
                map.set(key, { name: line.product_name || 'Unknown Product', qty: 0, zmwSpend: 0, usdSpend: 0, grnIds: new Set(), lines: [] });
            }
            const entry = map.get(key);
            const qty = parseFloat(line.received_quantity) || 0;
            const total = parseFloat(line.total_amount) || 0;

            entry.qty += qty;
            if (grn.currency === 'USD') entry.usdSpend += total;
            else entry.zmwSpend += total;
            entry.grnIds.add(grn.id);
            entry.lines.push({
                grnNumber: grn.grnNumber,
                entryDate: grn.entryDate,
                supplierName: grn.supplierName,
                paymentType: grn.paymentType,
                currency: grn.currency,
                batchNumber: line.batch_number,
                qty,
                rate: parseFloat(line.purchase_rate) || 0,
                total
            });
        });

        return Array.from(map.entries()).map(([key, e]) => ({
            key,
            name: e.name,
            qty: e.qty,
            zmwSpend: e.zmwSpend,
            usdSpend: e.usdSpend,
            grnCount: e.grnIds.size,
            lines: e.lines
        }));
    }

    // ============================================
    // SORTING
    // ============================================

    function sortRows(rows, sort) {
        const factor = sort.dir === 'asc' ? 1 : -1;
        return [...rows].sort((a, b) => (a[sort.field] - b[sort.field]) * factor);
    }

    window.sortPurchaseReportSuppliers = function (field) {
        if (state.supplierSort.field === field) {
            state.supplierSort.dir = state.supplierSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
            state.supplierSort = { field, dir: 'desc' };
        }
        renderSupplierTable();
    };

    window.sortPurchaseReportItems = function (field) {
        if (state.itemSort.field === field) {
            state.itemSort.dir = state.itemSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
            state.itemSort = { field, dir: 'desc' };
        }
        renderItemTable();
    };

    // ============================================
    // RENDER -- BREAKDOWN
    // ============================================

    const PAYMENT_LABELS = { CASH: 'Cash Purchase', CREDIT: 'Credit Purchase' };

    function renderBreakdown() {
        const tbody = document.getElementById('purchRepBreakdownBody');
        const results = computeBreakdown(state.grns);
        let grandZmw = 0, grandUsd = 0, grandCount = 0;

        const rowsHtml = ['CASH', 'CREDIT'].map(key => {
            const d = results[key];
            grandZmw += d.zmw; grandUsd += d.usd; grandCount += d.count;
            return `
                <tr>
                    <td style="padding-left:20px; font-weight:500;">${PAYMENT_LABELS[key]}</td>
                    <td style="text-align:right;">K${formatNumber(d.zmw)}</td>
                    <td style="text-align:right;">$${formatNumber(d.usd)}</td>
                    <td style="text-align:right; padding-right:20px; font-weight:600;">${d.count}</td>
                </tr>
            `;
        }).join('');

        const totalRow = `
            <tr style="border-top:2px solid #0f172a; font-weight:700;">
                <td style="padding-left:20px;">Total</td>
                <td style="text-align:right;">K${formatNumber(grandZmw)}</td>
                <td style="text-align:right;">$${formatNumber(grandUsd)}</td>
                <td style="text-align:right; padding-right:20px;">${grandCount}</td>
            </tr>
        `;

        tbody.innerHTML = rowsHtml + totalRow;
    }

    // ============================================
    // RENDER -- SUPPLIER-WISE
    // ============================================

    function renderSupplierTable() {
        const tbody = document.getElementById('purchRepSupplierBody');
        if (state.supplierRows.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:30px;color:#94a3b8;">No purchases in this range.</td></tr>`;
            return;
        }

        state.supplierRowsRendered = sortRows(state.supplierRows, state.supplierSort);
        tbody.innerHTML = state.supplierRowsRendered.map((row, i) => `
            <tr class="purchrep-clickable-row" onclick="showPurchaseReportSupplierGrns(${i})" title="Click to see this supplier's GRNs">
                <td style="padding-left:20px;">${row.name}</td>
                <td style="text-align:right;">${row.grnCount}</td>
                <td style="text-align:right;">K${formatNumber(row.zmwTotal)}</td>
                <td style="text-align:right; padding-right:20px; font-weight:600;">$${formatNumber(row.usdTotal)}</td>
            </tr>
        `).join('');
    }

    // ============================================
    // RENDER -- ITEM-WISE
    // ============================================

    function renderItemTable() {
        const tbody = document.getElementById('purchRepItemBody');
        if (state.itemRows.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:30px;color:#94a3b8;">No items received in this range.</td></tr>`;
            return;
        }

        state.itemRowsRendered = sortRows(state.itemRows, state.itemSort);
        tbody.innerHTML = state.itemRowsRendered.map((row, i) => `
            <tr class="purchrep-clickable-row" onclick="showPurchaseReportItemGrns(${i})" title="Click to see which GRNs this product was received on">
                <td style="padding-left:20px;">${row.name}</td>
                <td style="text-align:right;">${formatNumber(row.qty)}</td>
                <td style="text-align:right;">${row.grnCount}</td>
                <td style="text-align:right;">K${formatNumber(row.zmwSpend)}</td>
                <td style="text-align:right; padding-right:20px; font-weight:600;">$${formatNumber(row.usdSpend)}</td>
            </tr>
        `).join('');
    }

    // ============================================
    // DRILL-DOWN MODAL -- "click a supplier/item to see the GRNs behind
    // that total", same pattern as the Sales Report's invoice drill-down.
    // ============================================

    function openDrillModal(title, theadHtml, rowsHtml) {
        document.getElementById('purchRepDrillTitle').innerHTML = `<i class="fa-solid fa-receipt"></i> ${title}`;
        document.getElementById('purchRepDrillTableContainer').innerHTML = `
            <table class="table-minimal" style="width:100%;">
                <thead>${theadHtml}</thead>
                <tbody>${rowsHtml}</tbody>
            </table>
        `;
        document.getElementById('purchRepDrillModal').classList.add('show');
    }

    window.showPurchaseReportSupplierGrns = function (index) {
        const row = state.supplierRowsRendered?.[index];
        if (!row) return;

        const grns = [...row.grns].sort((a, b) => new Date(b.entryDate) - new Date(a.entryDate));
        const theadHtml = `<tr><th style="padding-left:20px;">GRN #</th><th>Date</th><th>Items</th><th>Payment</th><th style="text-align:right; padding-right:20px;">Amount</th></tr>`;
        const rowsHtml = grns.map(g => `
            <tr>
                <td style="padding-left:20px;">${g.grnNumber}</td>
                <td>${formatDate(g.entryDate)}</td>
                <td style="font-size:0.8rem; color:#475569; max-width:260px;">${g.itemsSummary || '-'}</td>
                <td><span class="category-badge">${PAYMENT_LABELS[g.paymentType]}</span></td>
                <td style="text-align:right; padding-right:20px; font-weight:600;">${g.currency === 'USD' ? '$' : 'K'}${formatNumber(g.amount)}</td>
            </tr>
        `).join('') + `
            <tr style="border-top:2px solid #0f172a; font-weight:700;">
                <td style="padding-left:20px;" colspan="4">Total (${row.grnCount} GRN${row.grnCount === 1 ? '' : 's'})</td>
                <td style="text-align:right; padding-right:20px;">K${formatNumber(row.zmwTotal)} / $${formatNumber(row.usdTotal)}</td>
            </tr>
        `;

        openDrillModal(`GRNs -- ${row.name}`, theadHtml, rowsHtml);
    };

    window.showPurchaseReportItemGrns = function (index) {
        const row = state.itemRowsRendered?.[index];
        if (!row) return;

        const lines = [...row.lines].sort((a, b) => new Date(b.entryDate) - new Date(a.entryDate));
        const theadHtml = `<tr><th style="padding-left:20px;">GRN #</th><th>Date</th><th>Supplier</th><th>Batch</th><th style="text-align:right;">Qty</th><th style="text-align:right;">Rate</th><th style="text-align:right; padding-right:20px;">Line Total</th></tr>`;
        const rowsHtml = lines.map(l => `
            <tr>
                <td style="padding-left:20px;">${l.grnNumber}</td>
                <td>${formatDate(l.entryDate)}</td>
                <td>${l.supplierName}</td>
                <td style="font-family:monospace;">${l.batchNumber || '-'}</td>
                <td style="text-align:right;">${formatNumber(l.qty)}</td>
                <td style="text-align:right;">${l.currency === 'USD' ? '$' : 'K'}${formatNumber(l.rate)}</td>
                <td style="text-align:right; padding-right:20px; font-weight:600;">${l.currency === 'USD' ? '$' : 'K'}${formatNumber(l.total)}</td>
            </tr>
        `).join('') + `
            <tr style="border-top:2px solid #0f172a; font-weight:700;">
                <td style="padding-left:20px;" colspan="6">Total (${row.grnCount} GRN${row.grnCount === 1 ? '' : 's'})</td>
                <td style="text-align:right; padding-right:20px;">K${formatNumber(row.zmwSpend)} / $${formatNumber(row.usdSpend)}</td>
            </tr>
        `;

        openDrillModal(`GRNs -- ${row.name}`, theadHtml, rowsHtml);
    };

    window.closePurchaseReportDrillModal = function () {
        document.getElementById('purchRepDrillModal').classList.remove('show');
    };

    // ============================================
    // GENERATE
    // ============================================

    window.loadPurchaseReport = async function () {
        const fromDate = document.getElementById('purchRepFromDate').value;
        const toDate = document.getElementById('purchRepToDate').value;

        if (!fromDate || !toDate) { alert('Please pick both a From and To date.'); return; }
        if (fromDate > toDate) { alert('The From date must be on or before the To date.'); return; }

        state.fromDate = fromDate;
        state.toDate = toDate;
        state.supplierFilter = document.getElementById('purchRepSupplierFilter').value;
        state.currencyFilter = document.getElementById('purchRepCurrencyFilter').value;
        state.paymentFilter = document.getElementById('purchRepPaymentFilter').value;

        ['purchRepBreakdownBody', 'purchRepSupplierBody', 'purchRepItemBody'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:30px;color:#94a3b8;"><i class="fa-solid fa-spinner fa-spin"></i> Generating...</td></tr>`;
        });

        try {
            const allGrns = await fetchGRNs(fromDate, toDate);
            state.grns = allGrns.filter(grn => {
                if (state.supplierFilter !== 'all' && grn.supplierId !== state.supplierFilter) return false;
                if (state.currencyFilter !== 'all' && grn.currency !== state.currencyFilter) return false;
                if (state.paymentFilter !== 'all' && grn.paymentType !== state.paymentFilter) return false;
                return true;
            });

            const grnById = new Map(state.grns.map(g => [g.id, g]));
            const lines = await fetchLines(state.grns.map(g => g.id));

            // Attach an items summary to each GRN BEFORE computing
            // supplier-wise rows, so a supplier's drill-down modal can
            // show what was actually on each GRN, not just the amount --
            // same thing the Sales Report's customer-wise drill-down
            // needed items for.
            const itemsByGrnId = new Map();
            lines.forEach(line => {
                const summary = `${line.product_name || 'Unknown'} (x${formatNumber(parseFloat(line.received_quantity) || 0)})`;
                if (!itemsByGrnId.has(line.grn_id)) itemsByGrnId.set(line.grn_id, []);
                itemsByGrnId.get(line.grn_id).push(summary);
            });
            state.grns.forEach(grn => {
                grn.itemsSummary = (itemsByGrnId.get(grn.id) || []).join(', ') || '-';
            });

            state.supplierRows = computeSupplierWise(state.grns);
            state.itemRows = computeItemWise(lines, grnById);

            renderBreakdown();
            renderSupplierTable();
            renderItemTable();
        } catch (error) {
            console.error('Error generating purchase report:', error);
            ['purchRepBreakdownBody', 'purchRepSupplierBody', 'purchRepItemBody'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:30px;color:#dc2626;">Error: ${error.message}</td></tr>`;
            });
        }
    };

    // ============================================
    // TABS
    // ============================================

    window.switchPurchaseReportView = function (view) {
        state.activeView = view;

        document.getElementById('purchRepTabBreakdown').classList.toggle('active', view === 'breakdown');
        document.getElementById('purchRepTabSupplier').classList.toggle('active', view === 'supplier');
        document.getElementById('purchRepTabItem').classList.toggle('active', view === 'item');

        document.getElementById('purchRepBreakdownView').style.display = view === 'breakdown' ? '' : 'none';
        document.getElementById('purchRepSupplierView').style.display = view === 'supplier' ? '' : 'none';
        document.getElementById('purchRepItemView').style.display = view === 'item' ? '' : 'none';
    };

    // ============================================
    // EXCEL EXPORT -- exports whichever view is currently active
    // ============================================

    window.exportPurchaseReportToExcel = function () {
        if (state.grns.length === 0) {
            alert('Generate the report first.');
            return;
        }

        let exportRows = [];
        let sheetName = 'Purchase Report';

        if (state.activeView === 'breakdown') {
            const results = computeBreakdown(state.grns);
            exportRows = ['CASH', 'CREDIT'].map(key => {
                const d = results[key];
                return {
                    'Payment Type': PAYMENT_LABELS[key],
                    'ZMW Amount': d.zmw,
                    'USD Amount': d.usd,
                    'GRNs': d.count
                };
            });
            sheetName = 'Payment Breakdown';
        } else if (state.activeView === 'supplier') {
            exportRows = sortRows(state.supplierRows, state.supplierSort).map(row => ({
                'Supplier': row.name,
                'GRNs': row.grnCount,
                'ZMW Total': row.zmwTotal,
                'USD Total': row.usdTotal
            }));
            sheetName = 'Supplier-Wise Purchase';
        } else if (state.activeView === 'item') {
            exportRows = sortRows(state.itemRows, state.itemSort).map(row => ({
                'Product': row.name,
                'Qty Received': row.qty,
                'GRNs': row.grnCount,
                'ZMW Spend': row.zmwSpend,
                'USD Spend': row.usdSpend
            }));
            sheetName = 'Item-Wise Purchase';
        }

        if (exportRows.length === 0) {
            alert('Nothing to export for the current view.');
            return;
        }

        const filename = `Purchase_Report_${state.fromDate}_to_${state.toDate}_${sheetName.replace(/\s+/g, '_')}.xlsx`;
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

    window.printPurchaseReport = function () {
        if (state.grns.length === 0) {
            alert('Generate the report first.');
            return;
        }

        const rangeLabel = state.fromDate === state.toDate
            ? new Date(state.fromDate + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
            : `${new Date(state.fromDate + 'T00:00:00').toLocaleDateString()} to ${new Date(state.toDate + 'T00:00:00').toLocaleDateString()}`;

        let title, theadHtml, rowsHtml;

        if (state.activeView === 'breakdown') {
            const results = computeBreakdown(state.grns);
            let grandZmw = 0, grandUsd = 0, grandCount = 0;
            title = 'Payment Breakdown';
            theadHtml = `<tr><th>Payment Type</th><th style="text-align:right;">ZMW Amount</th><th style="text-align:right;">USD Amount</th><th style="text-align:right;">GRNs</th></tr>`;
            rowsHtml = ['CASH', 'CREDIT'].map(key => {
                const d = results[key];
                grandZmw += d.zmw; grandUsd += d.usd; grandCount += d.count;
                return `<tr><td>${PAYMENT_LABELS[key]}</td><td style="text-align:right;">K${formatNumber(d.zmw)}</td><td style="text-align:right;">$${formatNumber(d.usd)}</td><td style="text-align:right;font-weight:700;">${d.count}</td></tr>`;
            }).join('');
            rowsHtml += `<tr style="font-weight:700; border-top:2px solid #0f172a;"><td>Total</td><td style="text-align:right;">K${formatNumber(grandZmw)}</td><td style="text-align:right;">$${formatNumber(grandUsd)}</td><td style="text-align:right;">${grandCount}</td></tr>`;
        } else if (state.activeView === 'supplier') {
            title = 'Supplier-Wise Purchase';
            theadHtml = `<tr><th>Supplier</th><th style="text-align:right;">GRNs</th><th style="text-align:right;">ZMW Total</th><th style="text-align:right;">USD Total</th></tr>`;
            rowsHtml = sortRows(state.supplierRows, state.supplierSort).map(row =>
                `<tr><td>${row.name}</td><td style="text-align:right;">${row.grnCount}</td><td style="text-align:right;">K${formatNumber(row.zmwTotal)}</td><td style="text-align:right;font-weight:700;">$${formatNumber(row.usdTotal)}</td></tr>`
            ).join('');
        } else {
            title = 'Item-Wise Purchase';
            theadHtml = `<tr><th>Product</th><th style="text-align:right;">Qty Received</th><th style="text-align:right;">GRNs</th><th style="text-align:right;">ZMW Spend</th><th style="text-align:right;">USD Spend</th></tr>`;
            rowsHtml = sortRows(state.itemRows, state.itemSort).map(row =>
                `<tr><td>${row.name}</td><td style="text-align:right;">${formatNumber(row.qty)}</td><td style="text-align:right;">${row.grnCount}</td><td style="text-align:right;">K${formatNumber(row.zmwSpend)}</td><td style="text-align:right;font-weight:700;">$${formatNumber(row.usdSpend)}</td></tr>`
            ).join('');
        }

        const printWindow = window.open('', '_blank', 'width=850,height=700');
        if (!printWindow) { alert('Please allow popups to print.'); return; }

        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Purchase Report - ${title}</title>
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
                <h1>Purchase Report -- ${title}</h1>
                <p class="subtitle">${rangeLabel}${state.supplierFilter !== 'all' ? ' &middot; ' + (state.suppliers.find(s => s.id === state.supplierFilter)?.name || '') : ''}${state.currencyFilter !== 'all' ? ' &middot; ' + state.currencyFilter + ' only' : ''}${state.paymentFilter !== 'all' ? ' &middot; ' + PAYMENT_LABELS[state.paymentFilter] + ' only' : ''} &middot; Generated ${new Date().toLocaleString()}</p>
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
        if (e.key === 'Escape') window.closePurchaseReportDrillModal();
    });
    document.getElementById('purchRepDrillModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'purchRepDrillModal') window.closePurchaseReportDrillModal();
    });

    // ============================================
    // INIT -- defaults both dates to today, matching the old report's
    // default of "today" so Generate-on-load behaves the same way.
    // ============================================
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    document.getElementById('purchRepFromDate').value = todayStr;
    document.getElementById('purchRepToDate').value = todayStr;

    await loadSuppliers();
    await window.loadPurchaseReport();

    console.log("✅ Purchase Report initialized successfully!");
})();
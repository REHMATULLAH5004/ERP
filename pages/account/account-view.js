// ============================================
// ACCOUNT OVERVIEW - PROFIT & LOSS (day-wise / item-wise)
// ============================================
// Retail + Wholesale sales only -- donations and write-offs are pure
// cost with no revenue side, so they don't belong in a profit view.
//
// COST BASIS, verified against retail.js directly before building this:
// item.cost_per_unit is always the batch's TRUE per-unit cost. item.qty
// represents PACKS for every sale type except NHIMA (same distinction
// established in Stock Movement's sales-quantity fix). Naively computing
// cost as qty * cost_per_unit understates true cost of goods sold for
// every non-NHIMA sale by a factor of the pack size -- confirmed
// concretely: a 3-pack sale of 10-unit packs at K2/unit cost showed K6
// instead of the true K60. The same getSaleQtyMultiplier() used
// elsewhere is required here too.
// ============================================

(async function initAccountOverview() {
    console.log("Account P&L Overview initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    let allSales = [];

    function getSaleQtyMultiplier(sale, item) {
        if (sale.client_sub_type === 'NHIMA') return 1;
        const parsed = parseInt(item.pack_size);
        return isNaN(parsed) || parsed <= 0 ? 1 : parsed;
    }

    function formatNumber(num) {
        return (num || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    function esc(str) {
        return (str || '').toString().replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ============================================
    // LOAD DATA
    // ============================================
    async function loadSales(days) {
        const since = new Date();
        since.setDate(since.getDate() - days);
        since.setHours(0, 0, 0, 0);

        const { data, error } = await supabaseClient
            .from('sales')
            .select('*')
            .in('client_type', ['RETAIL', 'WHOLESALE'])
            .neq('is_quotation', true)
            .gte('created_at', since.toISOString())
            .order('created_at', { ascending: true });

        if (error) {
            console.error('Error loading sales:', error);
            allSales = [];
            return;
        }
        allSales = data || [];
    }

    // ============================================
    // COMPUTE: line-level revenue/cost/profit for any array of sales
    // ============================================
    // Standalone (not closed over allSales) so the print flow can reuse
    // this exact same cost-basis logic against a different month's data
    // without duplicating it.
    function computeLinesFor(salesArray) {
        const lines = [];
        salesArray.forEach(sale => {
            const items = sale.items || [];
            const dateKey = new Date(sale.created_at).toISOString().split('T')[0];
            items.forEach(item => {
                const multiplier = getSaleQtyMultiplier(sale, item);
                const revenue = item.total || 0;
                const cost = (item.qty || 0) * (item.cost_per_unit || 0) * multiplier;
                lines.push({
                    date: dateKey,
                    productId: item.product_id,
                    productName: item.product_name || 'Unknown',
                    revenue, cost, profit: revenue - cost
                });
            });
        });
        return lines;
    }
    function computeLines() {
        return computeLinesFor(allSales);
    }

    // ============================================
    // RENDER: DAY-WISE
    // ============================================
    function renderDayWise(lines) {
        const byDay = {};
        lines.forEach(l => {
            if (!byDay[l.date]) byDay[l.date] = { revenue: 0, cost: 0, profit: 0 };
            byDay[l.date].revenue += l.revenue;
            byDay[l.date].cost += l.cost;
            byDay[l.date].profit += l.profit;
        });

        const days = Object.keys(byDay).sort((a, b) => new Date(b) - new Date(a));
        const tbody = document.getElementById('plDayBody');
        if (!tbody) return;

        if (days.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:20px;color:#94a3b8;">No sales in this period.</td></tr>`;
        } else {
            tbody.innerHTML = days.map(d => {
                const row = byDay[d];
                return `
                    <tr>
                        <td style="padding-left:20px;">${new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</td>
                        <td style="text-align:right;">K${formatNumber(row.revenue)}</td>
                        <td style="text-align:right;color:#dc2626;">K${formatNumber(row.cost)}</td>
                        <td style="text-align:right;padding-right:20px;font-weight:600;color:${row.profit >= 0 ? '#059669' : '#dc2626'};">K${formatNumber(row.profit)}</td>
                    </tr>
                `;
            }).join('');
        }

        // Period summary
        const totalRevenue = lines.reduce((s, l) => s + l.revenue, 0);
        const totalCost = lines.reduce((s, l) => s + l.cost, 0);
        const totalProfit = totalRevenue - totalCost;
        const margin = totalRevenue > 0 ? (totalProfit / totalRevenue * 100) : 0;

        const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
        set('plTotalRevenue', `K${formatNumber(totalRevenue)}`);
        set('plTotalCost', `K${formatNumber(totalCost)}`);
        set('plTotalProfit', `K${formatNumber(totalProfit)}`);
        set('plMargin', `${margin.toFixed(1)}% margin`);
        const profitEl = document.getElementById('plTotalProfit');
        if (profitEl) profitEl.style.color = totalProfit >= 0 ? '#059669' : '#dc2626';
    }

    // ============================================
    // RENDER: ITEM-WISE
    // ============================================
    function renderItemWise(lines) {
        const byItem = {};
        lines.forEach(l => {
            if (!byItem[l.productId]) byItem[l.productId] = { name: l.productName, revenue: 0, cost: 0, profit: 0 };
            byItem[l.productId].revenue += l.revenue;
            byItem[l.productId].cost += l.cost;
            byItem[l.productId].profit += l.profit;
        });

        const items = Object.values(byItem);
        const topItems = [...items].sort((a, b) => b.profit - a.profit).slice(0, 10);
        const bottomItems = [...items].sort((a, b) => a.profit - b.profit).slice(0, 10);

        const renderTable = (id, rows) => {
            const tbody = document.getElementById(id);
            if (!tbody) return;
            if (rows.length === 0) {
                tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:20px;color:#94a3b8;">No sales in this period.</td></tr>`;
                return;
            }
            tbody.innerHTML = rows.map(r => {
                // Guard against divide-by-zero if revenue is 0 (e.g. a
                // fully donated/discounted line that still shows a cost).
                const margin = r.revenue > 0 ? (r.profit / r.revenue * 100) : 0;
                return `
                <tr>
                    <td style="padding-left:20px;">${esc(r.name)}</td>
                    <td style="text-align:right;">K${formatNumber(r.revenue)}</td>
                    <td style="text-align:right;font-weight:600;color:${r.profit >= 0 ? '#059669' : '#dc2626'};">K${formatNumber(r.profit)}</td>
                    <td style="text-align:right;padding-right:20px;color:${margin >= 0 ? '#059669' : '#dc2626'};">${margin.toFixed(1)}%</td>
                </tr>
            `; }).join('');
        };

        renderTable('plTopItemsBody', topItems);
        renderTable('plBottomItemsBody', bottomItems);
    }

    // ============================================
    // PRINT: MONTHLY REPORT
    // ============================================
    window.printMonthlyPL = async function () {
        const monthInput = document.getElementById('plMonthPicker');
        const monthValue = monthInput?.value; // "YYYY-MM"
        if (!monthValue) {
            alert('Please pick a month first.');
            return;
        }

        const [year, month] = monthValue.split('-').map(Number);
        const startDate = new Date(year, month - 1, 1);
        const endDate = new Date(year, month, 0, 23, 59, 59, 999); // last day of that month

        const { data: monthSales, error } = await supabaseClient
            .from('sales')
            .select('*')
            .in('client_type', ['RETAIL', 'WHOLESALE'])
            .neq('is_quotation', true)
            .gte('created_at', startDate.toISOString())
            .lte('created_at', endDate.toISOString())
            .order('created_at', { ascending: true });

        if (error) {
            alert('Error loading data for that month: ' + error.message);
            return;
        }

        const lines = computeLinesFor(monthSales || []);
        const monthLabel = startDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

        // Day-wise
        const byDay = {};
        lines.forEach(l => {
            if (!byDay[l.date]) byDay[l.date] = { revenue: 0, cost: 0, profit: 0 };
            byDay[l.date].revenue += l.revenue;
            byDay[l.date].cost += l.cost;
            byDay[l.date].profit += l.profit;
        });
        const dayRows = Object.keys(byDay).sort((a, b) => new Date(a) - new Date(b)).map(d => {
            const r = byDay[d];
            return `<tr><td>${new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</td><td style="text-align:right;">K${formatNumber(r.revenue)}</td><td style="text-align:right;">K${formatNumber(r.cost)}</td><td style="text-align:right;">K${formatNumber(r.profit)}</td></tr>`;
        }).join('');

        // Item-wise
        const byItem = {};
        lines.forEach(l => {
            if (!byItem[l.productId]) byItem[l.productId] = { name: l.productName, revenue: 0, cost: 0, profit: 0 };
            byItem[l.productId].revenue += l.revenue;
            byItem[l.productId].cost += l.cost;
            byItem[l.productId].profit += l.profit;
        });
        const itemRows = Object.values(byItem).sort((a, b) => b.profit - a.profit).map(r => {
            const margin = r.revenue > 0 ? (r.profit / r.revenue * 100) : 0;
            return `<tr><td>${r.name}</td><td style="text-align:right;">K${formatNumber(r.revenue)}</td><td style="text-align:right;">K${formatNumber(r.profit)}</td><td style="text-align:right;">${margin.toFixed(1)}%</td></tr>`;
        }).join('');

        const totalRevenue = lines.reduce((s, l) => s + l.revenue, 0);
        const totalCost = lines.reduce((s, l) => s + l.cost, 0);
        const totalProfit = totalRevenue - totalCost;
        const margin = totalRevenue > 0 ? (totalProfit / totalRevenue * 100) : 0;

        const printWindow = window.open('', '_blank', 'width=900,height=700');
        if (!printWindow) {
            alert('Please allow popups to print.');
            return;
        }
        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Profit & Loss - ${monthLabel}</title>
                <style>
                    body { font-family: Arial, sans-serif; padding: 30px; color: #0f172a; }
                    h1 { margin-bottom: 4px; }
                    .subtitle { color: #64748b; margin-top: 0; margin-bottom: 24px; }
                    .summary { display: flex; gap: 30px; margin-bottom: 24px; padding: 16px 20px; background: #f8fafc; border-radius: 8px; }
                    .summary div span { display: block; }
                    .summary .label { font-size: 0.75rem; color: #64748b; text-transform: uppercase; }
                    .summary .value { font-size: 1.3rem; font-weight: 700; }
                    table { width: 100%; border-collapse: collapse; margin: 10px 0 24px 0; font-size: 0.85rem; }
                    th, td { padding: 8px; border: 1px solid #e2e8f0; text-align: left; }
                    th { background: #f1f5f9; }
                    h3 { margin-top: 30px; }
                </style>
            </head>
            <body>
                <h1>Profit & Loss Report</h1>
                <p class="subtitle">${monthLabel} &middot; Retail + Wholesale sales &middot; Generated ${new Date().toLocaleString()}</p>

                <div class="summary">
                    <div><span class="label">Total Revenue</span><span class="value">K${formatNumber(totalRevenue)}</span></div>
                    <div><span class="label">Total Cost</span><span class="value" style="color:#dc2626;">K${formatNumber(totalCost)}</span></div>
                    <div><span class="label">Net Profit</span><span class="value" style="color:${totalProfit >= 0 ? '#059669' : '#dc2626'};">K${formatNumber(totalProfit)}</span></div>
                    <div><span class="label">Margin</span><span class="value">${margin.toFixed(1)}%</span></div>
                </div>

                <h3>Day-by-Day</h3>
                <table>
                    <thead><tr><th>Date</th><th style="text-align:right;">Revenue</th><th style="text-align:right;">Cost</th><th style="text-align:right;">Profit</th></tr></thead>
                    <tbody>${dayRows || '<tr><td colspan="4" style="text-align:center;color:#94a3b8;">No sales this month.</td></tr>'}</tbody>
                </table>

                <h3>By Item</h3>
                <table>
                    <thead><tr><th>Item</th><th style="text-align:right;">Revenue</th><th style="text-align:right;">Profit</th><th style="text-align:right;">Margin</th></tr></thead>
                    <tbody>${itemRows || '<tr><td colspan="4" style="text-align:center;color:#94a3b8;">No sales this month.</td></tr>'}</tbody>
                </table>

                <script>window.onload = function() { window.print(); };<\/script>
            </body>
            </html>
        `);
        printWindow.document.close();
    };

    // ============================================
    // REFRESH / INIT
    // ============================================
    async function refresh() {
        const days = parseInt(document.getElementById('plPeriodSelect')?.value) || 14;
        await loadSales(days);
        const lines = computeLines();
        renderDayWise(lines);
        renderItemWise(lines);
    }

    // Default the month picker to the current month
    const monthPicker = document.getElementById('plMonthPicker');
    if (monthPicker) {
        const now = new Date();
        monthPicker.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }

    await refresh();
    document.getElementById('plPeriodSelect')?.addEventListener('change', refresh);

    console.log("✅ Account P&L Overview initialized successfully!");
})();
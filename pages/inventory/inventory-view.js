// ============================================
// INVENTORY OVERVIEW DASHBOARD (view-only)
// ============================================
// Loaded by app.js's loadModule() as a top-level view script (see the
// {module}-view.js pattern added there). Purely read-only -- no
// create/edit/delete anywhere in this file.
// ============================================

(async function initInventoryView() {
    console.log("Inventory Overview initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    const state = { products: [], batches: [], sales: [] };

    // ============================================
    // 🔥 Same sale-quantity logic validated in Stock Movement, reused
    // here so "units sold" figures stay consistent between pages: NHIMA
    // sales record qty as actual units already; every other sub-type
    // records qty as packs.
    // ============================================
    function getSaleQtyMultiplier(sale, item) {
        if (sale.client_sub_type === 'NHIMA') return 1;
        const parsed = parseInt(item.pack_size);
        return isNaN(parsed) || parsed <= 0 ? 1 : parsed;
    }

    // ============================================
    // LOAD DATA
    // ============================================
    async function loadData() {
        const [productsRes, batchesRes, salesRes] = await Promise.all([
            supabaseClient.from('products').select('id, product_name, min_order_qty, conversion_rate'),
            supabaseClient.from('batches').select('product_id, total_qty, cost_price, expiry_date, batch_number'),
            // Same exclusions as Stock Movement's loadSales(): real
            // completed sales only, not quotations, donations, or
            // write-off audit rows.
            supabaseClient.from('sales').select('client_type, client_sub_type, items')
                .neq('is_quotation', true)
                .neq('client_type', 'DONATION')
                .neq('client_type', 'WRITEOFF')
        ]);

        state.products = productsRes.data || [];
        state.batches = batchesRes.data || [];
        state.sales = salesRes.data || [];

        if (productsRes.error) console.warn('Error loading products:', productsRes.error);
        if (batchesRes.error) console.warn('Error loading batches:', batchesRes.error);
        if (salesRes.error) console.warn('Error loading sales:', salesRes.error);
    }

    // ============================================
    // COMPUTE PER-PRODUCT METRICS (once, shared by all 5 sections)
    // ============================================
    function computeMetrics() {
        const metrics = {};
        state.products.forEach(p => {
            metrics[p.id] = {
                id: p.id,
                name: p.product_name,
                packSize: p.conversion_rate || 1,
                minOrderQty: p.min_order_qty || 0,
                currentStock: 0,
                totalValue: 0,
                unitsSold: 0,
                saleFrequency: 0,
                nearestExpiryDays: null
            };
        });

        // Stock + value from batches
        state.batches.forEach(b => {
            const m = metrics[b.product_id];
            if (!m) return;
            const qty = b.total_qty || 0;
            m.currentStock += qty;
            m.totalValue += qty * (b.cost_price || 0);
        });

        // Sales activity
        state.sales.forEach(sale => {
            const items = sale.items || [];
            const touchedProducts = new Set();
            items.forEach(item => {
                const m = metrics[item.product_id];
                if (!m) return;
                const multiplier = getSaleQtyMultiplier(sale, item);
                m.unitsSold += (item.qty || 0) * multiplier;
                touchedProducts.add(item.product_id);
            });
            // Frequency = number of distinct sales this product appeared
            // in, not number of line items -- one sale touches a product
            // at most once here even if it somehow had duplicate lines.
            touchedProducts.forEach(pid => {
                if (metrics[pid]) metrics[pid].saleFrequency += 1;
            });
        });

        return Object.values(metrics);
    }

    // ============================================
    // UTILITIES
    // ============================================
    function formatNumber(num) {
        return (num || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    function esc(str) {
        return (str || '').toString().replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function setBody(id, html) {
        const el = document.getElementById(id);
        // 🔥 Stale-navigation guard, same pattern as the Category fix --
        // if the user has already moved on by the time this resolves,
        // don't touch DOM that isn't there anymore.
        if (el) el.innerHTML = html;
    }

    // ============================================
    // RENDER: MOST EXPENSIVE STOCK
    // ============================================
    function renderExpensiveStock(metrics, criteria) {
        const withStock = metrics.filter(m => m.currentStock > 0);
        let sorted, valueFn;

        if (criteria === 'perPack') {
            sorted = withStock.map(m => ({
                ...m,
                displayValue: (m.currentStock > 0 ? (m.totalValue / m.currentStock) : 0) * m.packSize
            })).sort((a, b) => b.displayValue - a.displayValue);
        } else {
            sorted = withStock.map(m => ({ ...m, displayValue: m.totalValue }))
                .sort((a, b) => b.displayValue - a.displayValue);
        }

        const top = sorted.slice(0, 10);
        if (top.length === 0) {
            setBody('expensiveStockBody', `<tr><td colspan="2" style="text-align:center;padding:20px;color:#94a3b8;">No stock on hand.</td></tr>`);
            return;
        }
        setBody('expensiveStockBody', top.map(m => `
            <tr>
                <td style="padding-left:20px;">${esc(m.name)}</td>
                <td style="text-align:right;padding-right:20px;font-weight:600;">K${formatNumber(m.displayValue)}</td>
            </tr>
        `).join(''));
    }

    // ============================================
    // RENDER: FAST MOVING
    // ============================================
    function renderFastMoving(metrics, criteria) {
        const sorted = criteria === 'frequency'
            ? [...metrics].sort((a, b) => b.saleFrequency - a.saleFrequency)
            : [...metrics].sort((a, b) => b.unitsSold - a.unitsSold);

        const top = sorted.filter(m => (criteria === 'frequency' ? m.saleFrequency : m.unitsSold) > 0).slice(0, 10);
        if (top.length === 0) {
            setBody('fastMovingBody', `<tr><td colspan="2" style="text-align:center;padding:20px;color:#94a3b8;">No sales recorded yet.</td></tr>`);
            return;
        }
        setBody('fastMovingBody', top.map(m => `
            <tr>
                <td style="padding-left:20px;">${esc(m.name)}</td>
                <td style="text-align:right;padding-right:20px;font-weight:600;color:#059669;">
                    ${criteria === 'frequency' ? `${m.saleFrequency} sale(s)` : `${formatNumber(m.unitsSold)} units`}
                </td>
            </tr>
        `).join(''));
    }

    // ============================================
    // RENDER: SLOW MOVING (in stock, lowest sales activity)
    // ============================================
    function renderSlowMoving(metrics) {
        const withStock = metrics.filter(m => m.currentStock > 0);
        const sorted = [...withStock].sort((a, b) => a.unitsSold - b.unitsSold).slice(0, 10);

        if (sorted.length === 0) {
            setBody('slowMovingBody', `<tr><td colspan="3" style="text-align:center;padding:20px;color:#94a3b8;">No stock on hand.</td></tr>`);
            return;
        }
        setBody('slowMovingBody', sorted.map(m => `
            <tr>
                <td style="padding-left:20px;">${esc(m.name)}</td>
                <td style="text-align:right;color:${m.unitsSold === 0 ? '#dc2626' : '#0f172a'};">${formatNumber(m.unitsSold)}</td>
                <td style="text-align:right;padding-right:20px;">${formatNumber(m.currentStock)}</td>
            </tr>
        `).join(''));
    }

    // ============================================
    // RENDER: NEAR EXPIRY (batch-level, within 90 days)
    // ============================================
    function renderNearExpiry() {
        const productMap = {};
        state.products.forEach(p => { productMap[p.id] = p.product_name; });

        const today = new Date();
        const rows = state.batches
            .filter(b => (b.total_qty || 0) > 0 && b.expiry_date)
            .map(b => {
                const days = Math.ceil((new Date(b.expiry_date) - today) / (1000 * 60 * 60 * 24));
                return { ...b, days, productName: productMap[b.product_id] || 'Unknown' };
            })
            .filter(b => b.days <= 90)
            .sort((a, b) => a.days - b.days)
            .slice(0, 10);

        if (rows.length === 0) {
            setBody('nearExpiryBody', `<tr><td colspan="4" style="text-align:center;padding:20px;color:#94a3b8;">Nothing expiring within 90 days.</td></tr>`);
            return;
        }
        setBody('nearExpiryBody', rows.map(b => `
            <tr>
                <td style="padding-left:20px;">${esc(b.productName)}</td>
                <td>${esc(b.batch_number)}</td>
                <td style="text-align:right;">${formatNumber(b.total_qty)}</td>
                <td style="text-align:right;padding-right:20px;color:${b.days < 30 ? '#dc2626' : '#b45309'};font-weight:600;">
                    ${b.days < 0 ? 'Expired' : b.days + 'd'}
                </td>
            </tr>
        `).join(''));
    }

    // ============================================
    // RENDER: BELOW MINIMUM ORDER QTY
    // ============================================
    function renderBelowMin(metrics) {
        const rows = metrics
            .filter(m => m.minOrderQty > 0 && m.currentStock <= m.minOrderQty)
            .sort((a, b) => (a.currentStock - a.minOrderQty) - (b.currentStock - b.minOrderQty));

        if (rows.length === 0) {
            setBody('belowMinBody', `<tr><td colspan="3" style="text-align:center;padding:20px;color:#94a3b8;">Everything is above its minimum order quantity.</td></tr>`);
            return;
        }
        setBody('belowMinBody', rows.map(m => `
            <tr>
                <td style="padding-left:20px;">${esc(m.name)}</td>
                <td style="text-align:right;color:${m.currentStock === 0 ? '#dc2626' : '#b45309'};font-weight:600;">${formatNumber(m.currentStock)}</td>
                <td style="text-align:right;padding-right:20px;">${formatNumber(m.minOrderQty)}</td>
            </tr>
        `).join(''));
    }

    // ============================================
    // INIT
    // ============================================
    await loadData();
    const metrics = computeMetrics();

    renderExpensiveStock(metrics, 'totalValue');
    renderFastMoving(metrics, 'qty');
    renderSlowMoving(metrics);
    renderNearExpiry();
    renderBelowMin(metrics);

    document.getElementById('expensiveCriteria')?.addEventListener('change', function () {
        renderExpensiveStock(metrics, this.value);
    });
    document.getElementById('fastMovingCriteria')?.addEventListener('change', function () {
        renderFastMoving(metrics, this.value);
    });

    console.log("✅ Inventory Overview initialized successfully!");
})();
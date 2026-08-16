// ============================================
// INVENTORY REPORT MODULE
// ============================================
// Batch-level stock report: category / expiry-status / product-batch
// search filters, plus an Excel download of whatever's currently
// filtered. Same underlying `batches` + `products` + `categories` data
// Batch Management and Expiry Management already read (see
// pages/inventory/batch-management/index.js and
// pages/inventory/expiry-management/index.js) -- this just presents it
// as a report instead of an editable list, and adds the category/
// expiry-bucket filtering and export those screens don't have.
// Valued at cost price, matching the "Stock shown at cost value"
// convention already established on the Daily Report.

(async function initInventoryReport() {
    console.log("📦 Inventory Report initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    // ============================================
    // GLOBAL STATE
    // ============================================
    const state = {
        allBatches: [],     // every batch, regardless of stock level -- the zero-stock checkbox and all other filters are applied client-side on top of this
        categories: []
    };

    // ============================================
    // LOAD DATA
    // ============================================

    async function loadCategories() {
        try {
            const { data, error } = await supabaseClient
                .from('categories')
                .select('id, name')
                .order('name');

            if (error) throw error;
            state.categories = data || [];

            const sel = document.getElementById('invrepCategoryFilter');
            if (sel) {
                state.categories.forEach(c => {
                    const opt = document.createElement('option');
                    opt.value = c.id;
                    opt.textContent = c.name;
                    sel.appendChild(opt);
                });
            }
        } catch (error) {
            console.error('Error loading categories:', error);
        }
    }

    async function loadBatches() {
        const tbody = document.getElementById('invrepTableBody');
        try {
            const { data, error } = await supabaseClient
                .from('batches')
                .select(`
                    id,
                    batch_number,
                    expiry_date,
                    cost_price,
                    total_qty,
                    products:product_id (
                        id,
                        product_name,
                        category_id,
                        categories ( name )
                    )
                `)
                .order('expiry_date', { ascending: true });

            if (error) throw error;

            // Load everything -- whether zero-stock batches show up in the
            // report is a display choice (the checkbox), not a data-load
            // choice, so it needs to be toggleable without a re-fetch.
            state.allBatches = data || [];
            console.log(`✅ Loaded ${state.allBatches.length} batches`);
        } catch (error) {
            console.error('Error loading inventory report data:', error);
            state.allBatches = [];
            if (tbody) {
                tbody.innerHTML = `<tr><td colspan="8" class="text-center" style="padding: 40px; color: #dc2626;">
                    Error loading inventory: ${error.message || error}
                </td></tr>`;
            }
        }
    }

    // ============================================
    // EXPIRY HELPERS
    // ============================================

    function daysUntilExpiry(dateStr) {
        const expiry = new Date(dateStr);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        expiry.setHours(0, 0, 0, 0);
        return Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));
    }

    function getExpiryStatus(days) {
        if (days < 0) return { key: 'expired', label: 'Expired', cls: 'invrep-status-expired' };
        if (days <= 30) return { key: '30', label: 'Expiring Soon', cls: 'invrep-status-expiring' };
        if (days <= 90) return { key: '90', label: 'Watch', cls: 'invrep-status-watch' };
        return { key: 'ok', label: 'OK', cls: 'invrep-status-ok' };
    }

    // ============================================
    // SCOPE -- zero-stock batches are excluded by default (same "active
    // batch" convention Stock Management/Expiry Management use); the
    // "Include out-of-stock batches" checkbox opts back in. This is the
    // base every other filter, the stats, and the Excel export build on.
    // ============================================

    function getScopedBatches() {
        const includeZeroStock = document.getElementById('invrepIncludeZeroStock')?.checked || false;
        return includeZeroStock
            ? state.allBatches
            : state.allBatches.filter(b => (b.total_qty || 0) > 0);
    }

    // ============================================
    // STATS -- always over the full scoped set (zero-stock checkbox
    // applied, but not the search/category/expiry filters below --
    // same convention as Expense's stat cards: the cards show the full
    // picture, the table shows the filtered slice).
    // ============================================

    function renderStats() {
        const scoped = getScopedBatches();
        const totalValue = scoped.reduce((sum, b) => sum + (b.total_qty || 0) * parseFloat(b.cost_price || 0), 0);
        const expiredCount = scoped.filter(b => daysUntilExpiry(b.expiry_date) < 0).length;
        const expiringSoonCount = scoped.filter(b => {
            const d = daysUntilExpiry(b.expiry_date);
            return d >= 0 && d <= 30;
        }).length;

        document.getElementById('invrepStatValue').textContent = `ZK ${formatNumber(totalValue)}`;
        document.getElementById('invrepStatBatches').textContent = scoped.length;
        document.getElementById('invrepStatExpiring').textContent = expiringSoonCount;
        document.getElementById('invrepStatExpired').textContent = expiredCount;
    }

    // ============================================
    // FILTERING (shared by the on-screen table AND the Excel export, so
    // "download excel" always matches exactly what's on screen)
    // ============================================

    function getFilteredBatches() {
        const search = document.getElementById('invrepSearch')?.value?.toLowerCase().trim() || '';
        const categoryFilter = document.getElementById('invrepCategoryFilter')?.value || 'all';
        const expiryFilter = document.getElementById('invrepExpiryFilter')?.value || 'all';

        return getScopedBatches().filter(b => {
            if (search) {
                const productName = (b.products?.product_name || '').toLowerCase();
                const batchNo = (b.batch_number || '').toLowerCase();
                if (!productName.includes(search) && !batchNo.includes(search)) return false;
            }

            if (categoryFilter !== 'all') {
                if (String(b.products?.category_id || '') !== String(categoryFilter)) return false;
            }

            if (expiryFilter !== 'all') {
                const days = daysUntilExpiry(b.expiry_date);
                if (expiryFilter === 'expired' && !(days < 0)) return false;
                if (expiryFilter === '30' && !(days >= 0 && days <= 30)) return false;
                if (expiryFilter === '90' && !(days >= 0 && days <= 90)) return false;
                if (expiryFilter === 'ok' && !(days > 90)) return false;
            }

            return true;
        });
    }

    // ============================================
    // RENDER TABLE
    // ============================================

    function renderTable() {
        const tbody = document.getElementById('invrepTableBody');
        const countBadge = document.getElementById('invrepListCount');
        if (!tbody) return;

        const rows = getFilteredBatches();

        if (rows.length === 0) {
            tbody.innerHTML = `<tr><td colspan="8" class="text-center" style="padding: 40px; color: #94a3b8;">
                <i class="fa-regular fa-circle-check" style="font-size: 2rem; display: block; margin-bottom: 10px;"></i>
                ${getScopedBatches().length === 0 ? 'No stock on hand.' : 'No batches match the current filters.'}
            </td></tr>`;
            if (countBadge) countBadge.textContent = '0 batches';
            return;
        }

        tbody.innerHTML = rows.map(b => {
            const days = daysUntilExpiry(b.expiry_date);
            const status = getExpiryStatus(days);
            const qty = b.total_qty || 0;
            const cost = parseFloat(b.cost_price || 0);
            const value = qty * cost;
            const categoryName = b.products?.categories?.name || 'Uncategorized';
            const daysLabel = days < 0 ? `${Math.abs(days)}d overdue` : `${days}d left`;

            return `
            <tr>
                <td style="padding-left: 20px;">${b.products?.product_name || 'Unknown Product'}</td>
                <td><span class="category-badge">${categoryName}</span></td>
                <td style="font-family: monospace;">${b.batch_number}</td>
                <td>${new Date(b.expiry_date).toLocaleDateString()}</td>
                <td class="text-center">
                    <span class="invrep-status-badge ${status.cls}">${status.label}</span><br>
                    <span style="font-size: 0.7rem; color: #94a3b8;">${daysLabel}</span>
                </td>
                <td class="text-right">${qty}</td>
                <td class="text-right">ZK ${formatNumber(cost)}</td>
                <td class="text-right" style="padding-right: 20px; font-weight: 600;">ZK ${formatNumber(value)}</td>
            </tr>
            `;
        }).join('');

        if (countBadge) countBadge.textContent = `${rows.length} batch${rows.length === 1 ? '' : 'es'}`;
    }

    function applyInventoryReportFilters() {
        renderTable();
    }

    // ============================================
    // EXCEL EXPORT -- exports exactly the currently filtered rows, via
    // the shared SheetJS wrapper in assets/js/shared-excel-export.js.
    // ============================================

    function exportInventoryReportToExcel() {
        const rows = getFilteredBatches();

        if (rows.length === 0) {
            showToast('No batches match the current filters -- nothing to export.', 'error');
            return;
        }

        const exportRows = rows.map(b => {
            const days = daysUntilExpiry(b.expiry_date);
            const status = getExpiryStatus(days);
            const qty = b.total_qty || 0;
            const cost = parseFloat(b.cost_price || 0);

            return {
                'Product': b.products?.product_name || 'Unknown Product',
                'Category': b.products?.categories?.name || 'Uncategorized',
                'Batch Number': b.batch_number,
                'Expiry Date': b.expiry_date,
                'Days To Expiry': days,
                'Status': status.label,
                'Qty In Stock': qty,
                'Cost Price (ZK)': cost,
                'Stock Value (ZK)': qty * cost
            };
        });

        const filename = `Inventory_Report_${new Date().toISOString().split('T')[0]}.xlsx`;
        const ok = typeof exportRowsToExcel === 'function'
            ? exportRowsToExcel(filename, 'Inventory Report', exportRows)
            : false;

        if (ok) {
            showToast(`Exported ${exportRows.length} batch${exportRows.length === 1 ? '' : 'es'} to Excel`, 'success');
        } else {
            showToast('Excel export failed -- check the browser console for details.', 'error');
        }
    }

    // ============================================
    // REFRESH
    // ============================================

    async function refreshInventoryReport() {
        const tbody = document.getElementById('invrepTableBody');
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="8" class="text-center" style="padding: 40px; color: #94a3b8;"><i class="fa-solid fa-spinner fa-spin"></i> Loading inventory...</td></tr>`;
        }
        await loadBatches();
        renderStats();
        renderTable();
    }

    // ============================================
    // UTILITY FUNCTIONS
    // ============================================

    function formatNumber(num) {
        return (num || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function showToast(message, type = 'success') {
        const existing = document.querySelector('#customToast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.id = 'customToast';
        const bgColor = type === 'success' ? '#059669' : type === 'error' ? '#dc2626' : '#2563eb';
        toast.style.cssText = `
            position: fixed; top: 20px; right: 20px;
            padding: 16px 24px; border-radius: 8px;
            color: white; font-weight: 500; z-index: 9999;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            background: ${bgColor};
            max-width: 400px;
        `;
        toast.textContent = message;
        document.body.appendChild(toast);

        setTimeout(() => toast.remove(), 3000);
    }

    // ============================================
    // EVENT LISTENERS
    // ============================================

    function setupEventListeners() {
        document.getElementById('invrepSearch')?.addEventListener('input', applyInventoryReportFilters);
        document.getElementById('invrepCategoryFilter')?.addEventListener('change', applyInventoryReportFilters);
        document.getElementById('invrepExpiryFilter')?.addEventListener('change', applyInventoryReportFilters);

        // Changes the scope everything else (stats + table) is built on,
        // so both need to re-render, not just the table.
        document.getElementById('invrepIncludeZeroStock')?.addEventListener('change', () => {
            renderStats();
            renderTable();
        });
    }

    // ============================================
    // EXPOSE TO GLOBAL SCOPE
    // ============================================
    window.refreshInventoryReport = refreshInventoryReport;
    window.applyInventoryReportFilters = applyInventoryReportFilters;
    window.exportInventoryReportToExcel = exportInventoryReportToExcel;

    // ============================================
    // INITIALIZE
    // ============================================
    await loadCategories();
    await loadBatches();
    renderStats();
    renderTable();
    setupEventListeners();

    console.log("✅ Inventory Report initialized successfully!");
    console.log(`📦 ${state.allBatches.length} batches loaded (${getScopedBatches().length} in scope)`);
})();

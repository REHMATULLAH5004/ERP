// ============================================
// INVENTORY REPORT MODULE -- stock value by day
// ============================================
// One row per day: Date | Opening Stock Amount | Closing Stock Amount |
// Difference. Amounts are stock valued at cost price. They come from the
// database function stock_value_by_day(): a value saved at the end of the
// day is used when there is one; older days are worked out backwards from
// today's stock (undoing every sale, purchase, return, write-off and stock
// take after that day); today is live because the day is not finished.
// The opening of a day is always the closing of the day before.

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
        rows: []   // [{ day, opening_value, closing_value, difference, source }], oldest first
    };

    // ============================================
    // DATE HELPERS (all in Lusaka time)
    // ============================================
    function lusakaToday() {
        try { return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lusaka' }); }
        catch (e) { return new Date().toISOString().split('T')[0]; }
    }

    function shiftDate(iso, days) {
        const d = new Date(iso + 'T00:00:00Z');
        d.setUTCDate(d.getUTCDate() + days);
        return d.toISOString().split('T')[0];
    }

    function formatDay(iso) {
        const d = new Date(iso + 'T00:00:00Z');
        const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const dd = String(d.getUTCDate()).padStart(2, '0');
        const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
        return `${names[d.getUTCDay()]} ${dd}/${mm}/${d.getUTCFullYear()}`;
    }

    function applyQuickRange() {
        const choice = document.getElementById('invrepQuickRange')?.value || 'month';
        if (choice === 'custom') return;
        const today = lusakaToday();
        let from = today;
        if (choice === 'month') from = today.slice(0, 8) + '01';
        else from = shiftDate(today, -(parseInt(choice, 10) - 1));
        document.getElementById('invrepFrom').value = from;
        document.getElementById('invrepTo').value = today;
    }

    // ============================================
    // LOAD DATA
    // ============================================
    async function loadReport() {
        const tbody = document.getElementById('invrepTableBody');
        const from = document.getElementById('invrepFrom')?.value;
        const to = document.getElementById('invrepTo')?.value;

        if (!from || !to) {
            showToast('Please choose both dates.', 'error');
            return;
        }
        if (from > to) {
            showToast('"From" cannot be after "To".', 'error');
            return;
        }

        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="4" class="text-center" style="padding: 40px; color: #94a3b8;"><i class="fa-solid fa-spinner fa-spin"></i> Working out stock values...</td></tr>`;
        }

        try {
            const { data, error } = await supabaseClient.rpc('stock_value_by_day', { p_from: from, p_to: to });
            if (error) throw error;
            state.rows = (data || []).map(r => ({
                day: r.day,
                opening_value: parseFloat(r.opening_value) || 0,
                closing_value: parseFloat(r.closing_value) || 0,
                difference: parseFloat(r.difference) || 0,
                source: r.source
            }));
        } catch (error) {
            console.error('Error loading stock value by day:', error);
            state.rows = [];
            if (tbody) {
                const notSetUp = /stock_value_by_day|function|schema cache/i.test(error.message || '');
                tbody.innerHTML = `<tr><td colspan="4" class="text-center" style="padding: 40px; color: #dc2626;">${notSetUp
                    ? 'This report is not set up in the database yet.'
                    : 'Could not load: ' + (error.message || 'unknown error')}</td></tr>`;
            }
            renderStats();
            return;
        }

        renderStats();
        renderTable();
    }

    // ============================================
    // RENDER
    // ============================================
    const SOURCE_DOT = {
        saved:   { color: '#059669', tip: 'Saved at the end of that day' },
        live:    { color: '#2563eb', tip: 'Live -- today is not finished yet' },
        rebuilt: { color: '#b45309', tip: "Worked out backwards from today's stock using every sale, purchase, return, write-off and stock take" }
    };

    function money(n) { return `ZK ${formatNumber(n)}`; }

    function signedMoney(n) {
        if (Math.abs(n) < 0.005) return money(0);
        return `${n > 0 ? '+' : '-'}ZK ${formatNumber(Math.abs(n))}`;
    }

    function diffColor(n) {
        return n > 0.004 ? '#059669' : n < -0.004 ? '#dc2626' : '#64748b';
    }

    function renderStats() {
        const rows = state.rows;
        const set = (id, text, color) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.textContent = text;
            el.style.color = color || '';
        };
        if (rows.length === 0) {
            set('invrepStatOpening', money(0)); set('invrepStatClosing', money(0)); set('invrepStatDiff', money(0));
            const c = document.getElementById('invrepListCount'); if (c) c.textContent = '0 days';
            return;
        }
        const first = rows[0], last = rows[rows.length - 1];
        const diff = last.closing_value - first.opening_value;
        set('invrepStatOpening', money(first.opening_value));
        set('invrepStatClosing', money(last.closing_value));
        set('invrepStatDiff', signedMoney(diff), diffColor(diff));
        const c = document.getElementById('invrepListCount');
        if (c) c.textContent = `${rows.length} day${rows.length === 1 ? '' : 's'}`;
    }

    function renderTable() {
        const tbody = document.getElementById('invrepTableBody');
        if (!tbody) return;

        if (state.rows.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" class="text-center" style="padding: 40px; color: #94a3b8;">No days in this period.</td></tr>`;
            return;
        }

        // newest day first
        const rows = state.rows.slice().reverse();
        tbody.innerHTML = rows.map(r => {
            const dot = SOURCE_DOT[r.source] || SOURCE_DOT.rebuilt;
            return `
                <tr>
                    <td style="padding-left: 20px; white-space: nowrap;">${formatDay(r.day)}</td>
                    <td class="text-right">${money(r.opening_value)}</td>
                    <td class="text-right" style="font-weight: 600;">
                        ${money(r.closing_value)}
                        <span title="${dot.tip}" style="color:${dot.color}; font-size:0.7rem; margin-left:4px;">&#9679;</span>
                    </td>
                    <td class="text-right" style="padding-right: 20px; font-weight: 600; color:${diffColor(r.difference)}; cursor:pointer;" title="Click to see how this difference came" onclick="openInventoryDayDetail('${r.day}')"><span style="text-decoration: underline dotted; text-underline-offset: 3px;">${signedMoney(r.difference)}</span> <i class="fa-solid fa-circle-info" style="font-size:0.7rem; opacity:0.6; margin-left:2px;"></i></td>
                </tr>`;
        }).join('');
    }

    // ============================================
    // EXCEL EXPORT -- the days currently shown, via the shared SheetJS
    // wrapper in assets/js/shared-excel-export.js.
    // ============================================
    function exportInventoryReportToExcel() {
        if (state.rows.length === 0) {
            showToast('Nothing to export for this period.', 'error');
            return;
        }
        const exportRows = state.rows.slice().reverse().map(r => ({
            'Date': r.day,
            'Opening Stock Amount (ZK)': r.opening_value,
            'Closing Stock Amount (ZK)': r.closing_value,
            'Difference (ZK)': r.difference
        }));
        const first = state.rows[0].day, last = state.rows[state.rows.length - 1].day;
        const filename = `Inventory_Report_${first}_to_${last}.xlsx`;
        const ok = typeof exportRowsToExcel === 'function'
            ? exportRowsToExcel(filename, 'Stock Value by Day', exportRows)
            : false;

        if (ok) {
            showToast(`Exported ${exportRows.length} day${exportRows.length === 1 ? '' : 's'} to Excel`, 'success');
        } else {
            showToast('Excel export failed -- check the browser console for details.', 'error');
        }
    }

    // ============================================
    // DAY DETAIL -- click a Difference to see how it came
    // ============================================
    // Calls stock_value_day_detail(day): every document that moved stock on
    // that day, valued at cost. Grouped by kind (sales, purchases, ...) and
    // expandable to the individual documents.
    const CATEGORY_ORDER = [
        'Purchases (GRN)', 'Opening stock', 'Stock take (found more)',
        'Sales', 'Donations', 'Bundle ingredients used', 'Write-offs',
        'Returned to supplier', 'Stock take (found less)'
    ];
    const CATEGORY_NOTE = {
        'Purchases (GRN)': 'Stock received from suppliers',
        'Opening stock': 'Batches entered with an opening quantity',
        'Stock take (found more)': 'Stock count found more than the system',
        'Sales': 'Sold to customers (invoices / receipts)',
        'Donations': 'Given out as donations',
        'Bundle ingredients used': 'Items used up inside bundles such as the Maternity Pack',
        'Write-offs': 'Damaged / expired / lost stock written off',
        'Returned to supplier': 'Purchase returns (credit notes)',
        'Stock take (found less)': 'Stock count found less than the system'
    };
    const detailState = { day: null, groups: [] };

    function esc(v) {
        return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function ensureDetailModal() {
        let m = document.getElementById('invrepDetailModal');
        if (m) return m;
        m = document.createElement('div');
        m.id = 'invrepDetailModal';
        m.style.cssText = 'display:none; position:fixed; inset:0; background:rgba(15,23,42,0.55); z-index:9000; align-items:center; justify-content:center; padding:16px;';
        m.innerHTML = `
            <div style="background:#fff; border-radius:12px; width:100%; max-width:760px; max-height:88vh; display:flex; flex-direction:column; box-shadow:0 20px 50px rgba(0,0,0,0.3);">
                <div style="display:flex; align-items:center; justify-content:space-between; padding:16px 20px; border-bottom:1px solid #e2e8f0;">
                    <div>
                        <div id="invrepDetailTitle" style="font-size:1.05rem; font-weight:700; color:#0f172a;"></div>
                        <div id="invrepDetailSub" style="font-size:0.8rem; color:#64748b; margin-top:2px;"></div>
                    </div>
                    <button type="button" onclick="closeInventoryDayDetail()" style="border:none; background:none; font-size:1.4rem; cursor:pointer; color:#64748b; line-height:1;" aria-label="Close">&times;</button>
                </div>
                <div id="invrepDetailBody" style="padding:16px 20px; overflow:auto;"></div>
            </div>`;
        m.addEventListener('click', e => { if (e.target === m) closeInventoryDayDetail(); });
        document.body.appendChild(m);
        return m;
    }

    function closeInventoryDayDetail() {
        const m = document.getElementById('invrepDetailModal');
        if (m) m.style.display = 'none';
    }

    async function openInventoryDayDetail(day) {
        const m = ensureDetailModal();
        const row = state.rows.find(r => r.day === day);
        const body = document.getElementById('invrepDetailBody');
        document.getElementById('invrepDetailTitle').textContent = `How the difference came -- ${formatDay(day)}`;
        document.getElementById('invrepDetailSub').textContent = row
            ? `Opening ${money(row.opening_value)}  →  Closing ${money(row.closing_value)}  (${signedMoney(row.difference)})`
            : '';
        body.innerHTML = `<div style="text-align:center; padding:30px; color:#94a3b8;"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</div>`;
        m.style.display = 'flex';

        let data;
        try {
            const res = await supabaseClient.rpc('stock_value_day_detail', { p_day: day });
            if (res.error) throw res.error;
            data = res.data || [];
        } catch (error) {
            console.error('Error loading day detail:', error);
            const notSetUp = /Could not find the function|does not exist|schema cache/i.test(error.message || '');
            body.innerHTML = `<div style="padding:24px; text-align:center; color:#dc2626;">${notSetUp
                ? 'This breakdown is not set up in the database yet.'
                : 'Could not load: ' + esc(error.message || 'unknown error')}
                <div style="margin-top:10px; font-size:0.75rem; color:#94a3b8;">${esc(error.message || '')}</div></div>`;
            return;
        }

        // group by category
        const map = {};
        data.forEach(r => {
            const g = map[r.category] || (map[r.category] = { category: r.category, units: 0, amount: 0, docs: [] });
            const units = parseFloat(r.units) || 0, amount = parseFloat(r.amount) || 0;
            g.units += units; g.amount += amount;
            g.docs.push({ doc: r.doc, units, amount });
        });
        const groups = Object.values(map).sort((a, b) => {
            const ia = CATEGORY_ORDER.indexOf(a.category), ib = CATEGORY_ORDER.indexOf(b.category);
            return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        });
        groups.forEach(g => g.docs.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)));
        detailState.day = day;
        detailState.groups = groups;

        const moved = groups.reduce((t, g) => t + g.amount, 0);
        const other = row ? row.difference - moved : 0;
        const showOther = row && Math.abs(other) >= 0.5;

        const th = 'padding:8px 10px; font-size:0.72rem; text-transform:uppercase; letter-spacing:0.03em; color:#64748b; background:#f8fafc; border-bottom:1px solid #e2e8f0;';
        let html = `<table style="width:100%; border-collapse:collapse; font-size:0.9rem;">
            <thead><tr>
                <th style="${th} text-align:left;">What happened</th>
                <th style="${th} text-align:right;">Documents</th>
                <th style="${th} text-align:right;">Units</th>
                <th style="${th} text-align:right;">Amount at cost</th>
            </tr></thead><tbody>`;

        if (groups.length === 0) {
            html += `<tr><td colspan="4" style="padding:24px; text-align:center; color:#94a3b8;">No stock moved on this day.</td></tr>`;
        }

        groups.forEach((g, i) => {
            const color = diffColor(g.amount);
            html += `
                <tr style="cursor:pointer; border-bottom:1px solid #f1f5f9;" onclick="toggleInventoryDetailGroup(${i})">
                    <td style="padding:10px;">
                        <i id="invrepGrpIcon${i}" class="fa-solid fa-chevron-right" style="font-size:0.7rem; color:#94a3b8; margin-right:6px;"></i>
                        <span style="font-weight:600; color:#0f172a;">${esc(g.category)}</span>
                        <div style="font-size:0.75rem; color:#94a3b8; margin-left:18px;">${esc(CATEGORY_NOTE[g.category] || '')}</div>
                    </td>
                    <td style="padding:10px; text-align:right;">${g.docs.length}</td>
                    <td style="padding:10px; text-align:right; color:${color};">${g.units > 0 ? '+' : ''}${formatNumber(g.units)}</td>
                    <td style="padding:10px; text-align:right; font-weight:600; color:${color};">${signedMoney(g.amount)}</td>
                </tr>
                <tr id="invrepGrpRows${i}" style="display:none;"><td colspan="4" style="padding:0 0 8px 28px; background:#fafafa;">
                    <table style="width:100%; border-collapse:collapse; font-size:0.82rem;">
                        ${g.docs.slice(0, 200).map(d => `
                            <tr style="border-bottom:1px solid #f1f5f9;">
                                <td style="padding:5px 10px; color:#334155;">${esc(d.doc)}</td>
                                <td style="padding:5px 10px; text-align:right; color:#64748b;">${d.units > 0 ? '+' : ''}${formatNumber(d.units)} units</td>
                                <td style="padding:5px 10px; text-align:right; color:${diffColor(d.amount)};">${signedMoney(d.amount)}</td>
                            </tr>`).join('')}
                        ${g.docs.length > 200 ? `<tr><td colspan="3" style="padding:6px 10px; color:#94a3b8;">...and ${g.docs.length - 200} smaller documents</td></tr>` : ''}
                    </table>
                </td></tr>`;
        });

        if (showOther) {
            html += `
                <tr style="border-bottom:1px solid #f1f5f9;">
                    <td style="padding:10px;">
                        <span style="font-weight:600; color:#0f172a;">Other / not explained</span>
                        <div style="font-size:0.75rem; color:#94a3b8;">Cost price changes and anything not recorded as a document</div>
                    </td>
                    <td style="padding:10px; text-align:right;">-</td>
                    <td style="padding:10px; text-align:right;">-</td>
                    <td style="padding:10px; text-align:right; font-weight:600; color:${diffColor(other)};">${signedMoney(other)}</td>
                </tr>`;
        }

        html += `</tbody>
            <tfoot><tr>
                <td colspan="3" style="padding:12px 10px; font-weight:700; border-top:2px solid #e2e8f0;">Difference for the day</td>
                <td style="padding:12px 10px; text-align:right; font-weight:700; border-top:2px solid #e2e8f0; color:${diffColor(row ? row.difference : moved)};">${signedMoney(row ? row.difference : moved)}</td>
            </tr></tfoot></table>
            <div style="font-size:0.75rem; color:#94a3b8; margin-top:10px;">Click a line to see the individual documents. Amounts are units multiplied by the product's average cost price.</div>`;

        body.innerHTML = html;
    }

    function toggleInventoryDetailGroup(i) {
        const r = document.getElementById('invrepGrpRows' + i);
        const ic = document.getElementById('invrepGrpIcon' + i);
        if (!r) return;
        const open = r.style.display === 'none';
        r.style.display = open ? 'table-row' : 'none';
        if (ic) ic.className = open ? 'fa-solid fa-chevron-down' : 'fa-solid fa-chevron-right';
    }

    // ============================================
    // BUTTONS
    // ============================================
    async function refreshInventoryReport() { await loadReport(); }
    function applyInventoryReportFilters() { loadReport(); }

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
        document.getElementById('invrepQuickRange')?.addEventListener('change', () => {
            applyQuickRange();
            if (document.getElementById('invrepQuickRange').value !== 'custom') loadReport();
        });
        ['invrepFrom', 'invrepTo'].forEach(id => {
            document.getElementById(id)?.addEventListener('change', () => {
                const q = document.getElementById('invrepQuickRange');
                if (q) q.value = 'custom';
            });
        });
    }

    // ============================================
    // EXPOSE TO GLOBAL SCOPE
    // ============================================
    window.refreshInventoryReport = refreshInventoryReport;
    window.applyInventoryReportFilters = applyInventoryReportFilters;
    window.exportInventoryReportToExcel = exportInventoryReportToExcel;
    window.openInventoryDayDetail = openInventoryDayDetail;
    window.closeInventoryDayDetail = closeInventoryDayDetail;
    window.toggleInventoryDetailGroup = toggleInventoryDetailGroup;

    // ============================================
    // INITIALIZE
    // ============================================
    const maxDay = lusakaToday();
    const fromEl = document.getElementById('invrepFrom');
    const toEl = document.getElementById('invrepTo');
    if (fromEl) fromEl.max = maxDay;
    if (toEl) toEl.max = maxDay;
    applyQuickRange();
    setupEventListeners();
    await loadReport();

    console.log("✅ Inventory Report initialized successfully!");
})();
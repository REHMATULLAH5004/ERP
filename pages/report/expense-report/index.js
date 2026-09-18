// ============================================
// EXPENSE REPORT -- what's being spent, on what, and how
// ============================================
// Reads from view_expenses (already a clean, ready-made view of expense
// transactions -- transaction_number, category, amount, description,
// reference, paid-via account, date). Built with the same house style as
// report-view.js / Cash Report: single accent hue per chart, thin 2px
// line / capped bars, recessive gridlines, hover tooltips, and a
// "View as table" toggle on every chart.
// ============================================

(function initExpenseReport() {
    console.log("Expense Report initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    const state = {
        from: null,
        to: null,
        category: 'ALL',
        allRows: [],     // every expense row, ever (small volume)
        filtered: [],    // rows in the selected range + category
        byCategory: [],
        byAccount: [],
        trend: []
    };

    function formatNumber(num) {
        return (num || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    function formatCompact(num) {
        const n = num || 0;
        const abs = Math.abs(n);
        if (abs >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
        if (abs >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
        return formatNumber(n);
    }
    function dateKey(d) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    function startOfWeek(d) {
        const copy = new Date(d);
        const day = copy.getDay();
        const diff = (day === 0 ? -6 : 1) - day;
        copy.setDate(copy.getDate() + diff);
        return copy;
    }

    // ============================================
    // FETCH
    // ============================================

    async function loadExpenses() {
        const { data, error } = await supabaseClient
            .from('view_expenses')
            .select('*')
            .order('transaction_date', { ascending: true });
        if (error) throw error;
        return (data || []).map(r => ({
            date: r.transaction_date,
            transactionNumber: r.transaction_number || '-',
            category: r.expense_category || 'Uncategorized',
            description: r.description || '-',
            reference: r.reference || '-',
            account: r.account || 'Unknown',
            amount: parseFloat(r.amount) || 0
        }));
    }

    function populateCategoryFilter(rows) {
        const select = document.getElementById('exprepCategoryFilter');
        const categories = [...new Set(rows.map(r => r.category))].sort();
        const current = select.value || 'ALL';
        select.innerHTML = '<option value="ALL">All categories</option>' +
            categories.map(c => `<option value="${c}">${c}</option>`).join('');
        select.value = categories.includes(current) ? current : 'ALL';
    }

    function computeForRange(allRows, fromStr, toStr, category) {
        const filtered = allRows.filter(r =>
            r.date >= fromStr && r.date <= toStr && (category === 'ALL' || r.category === category)
        );

        const catMap = {}, acctMap = {};
        filtered.forEach(r => {
            catMap[r.category] = (catMap[r.category] || 0) + r.amount;
            acctMap[r.account] = (acctMap[r.account] || 0) + r.amount;
        });
        const byCategory = Object.entries(catMap).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
        const byAccount = Object.entries(acctMap).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);

        const fromDate = new Date(fromStr + 'T00:00:00');
        const toDate = new Date(toStr + 'T00:00:00');
        const dayCount = Math.round((toDate - fromDate) / 86400000) + 1;
        const useWeekly = dayCount > 31;

        const bucketMap = new Map();
        const bucketOrder = [];
        if (useWeekly) {
            let cursor = startOfWeek(fromDate);
            const lastWeekStart = startOfWeek(toDate);
            while (cursor <= lastWeekStart) {
                const key = dateKey(cursor);
                bucketOrder.push(key);
                bucketMap.set(key, { label: cursor.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), value: 0 });
                cursor = new Date(cursor); cursor.setDate(cursor.getDate() + 7);
            }
        } else {
            let cursor = new Date(fromDate);
            while (cursor <= toDate) {
                const key = dateKey(cursor);
                bucketOrder.push(key);
                bucketMap.set(key, { label: cursor.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), value: 0 });
                cursor = new Date(cursor); cursor.setDate(cursor.getDate() + 1);
            }
        }
        filtered.forEach(r => {
            const d = new Date(r.date + 'T00:00:00');
            const bucketStart = useWeekly ? startOfWeek(d) : d;
            const key = dateKey(bucketStart);
            const bucket = bucketMap.get(key);
            if (bucket) bucket.value += r.amount;
        });
        const trend = bucketOrder.map(k => bucketMap.get(k));

        return { filtered, byCategory, byAccount, trend };
    }

    // ============================================
    // RENDER -- KPIs
    // ============================================

    function renderKPIs() {
        const total = state.filtered.reduce((sum, r) => sum + r.amount, 0);
        const count = state.filtered.length;
        const top = state.byCategory[0];
        document.getElementById('exprepStatTotal').textContent = `K${formatNumber(total)}`;
        document.getElementById('exprepStatCount').textContent = `${count}`;
        document.getElementById('exprepStatTopCategory').textContent = top ? `${top.label} (K${formatCompact(top.value)})` : '--';
        document.getElementById('exprepStatAverage').textContent = count > 0 ? `K${formatNumber(total / count)}` : 'K0.00';
    }

    // ============================================
    // RENDER -- BAR CHARTS (category / account)
    // ============================================

    function renderBarChart(containerId, rows, barClass, emptyLabel) {
        const wrap = document.getElementById(containerId);
        if (rows.length === 0) {
            wrap.innerHTML = `<div class="exprep-chart-empty"><i class="fa-regular fa-chart-bar" style="font-size:1.6rem; display:block; margin-bottom:8px;"></i>No ${emptyLabel} in this range.</div>`;
            return;
        }

        const barH = 22, gap = 14, labelW = 110;
        const W = 640;
        const plotL = labelW, plotR = W - 90;
        const H = rows.length * (barH + gap) + gap;
        const maxVal = Math.max(...rows.map(r => r.value)) || 1;
        const scale = (plotR - plotL) / maxVal;

        let bars = '';
        rows.forEach((r, i) => {
            const y = gap + i * (barH + gap);
            const barLen = Math.max(r.value * scale, 2);
            const midY = y + barH / 2;
            const shortLabel = r.label.length > 20 ? r.label.slice(0, 18) + '…' : r.label;
            bars += `
                <text class="exprep-bar-label" x="${plotL - 10}" y="${midY + 4}" text-anchor="end">${shortLabel}</text>
                <rect class="${barClass}" data-i="${i}" x="${plotL}" y="${y}" width="${barLen}" height="${barH}" rx="4"/>
                <text class="exprep-bar-value" x="${plotL + barLen + 8}" y="${midY + 4}">K${formatCompact(r.value)}</text>
                <rect class="exprep-bar-hit" data-i="${i}" x="0" y="${y - gap / 2}" width="${W}" height="${barH + gap}"/>
            `;
        });

        wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${emptyLabel}">${bars}</svg>`;

        const svg = wrap.querySelector('svg');
        const tooltip = getOrCreateTooltip(wrap);
        svg.querySelectorAll('.exprep-bar-hit').forEach(hit => {
            const i = parseInt(hit.dataset.i, 10);
            const bar = svg.querySelector(`.${barClass}[data-i="${i}"]`);
            function show(clientX, clientY) {
                bar.classList.add('exprep-bar-hover');
                const r = rows[i];
                tooltip.innerHTML = '';
                const labelEl = document.createElement('div');
                labelEl.className = 'exprep-tooltip-label';
                labelEl.textContent = r.label;
                const valueEl = document.createElement('div');
                valueEl.className = 'exprep-tooltip-value';
                valueEl.textContent = `K${formatNumber(r.value)}`;
                tooltip.appendChild(labelEl);
                tooltip.appendChild(valueEl);
                positionTooltip(tooltip, wrap, clientX, clientY);
                tooltip.classList.add('show');
            }
            function hide() { bar.classList.remove('exprep-bar-hover'); tooltip.classList.remove('show'); }
            hit.addEventListener('pointermove', (e) => show(e.clientX, e.clientY));
            hit.addEventListener('pointerleave', hide);
            hit.setAttribute('tabindex', '0');
            hit.addEventListener('focus', () => { const r = hit.getBoundingClientRect(); show(r.left + r.width / 2, r.top); });
            hit.addEventListener('blur', hide);
        });
    }

    // ============================================
    // RENDER -- TREND (line)
    // ============================================

    function niceMax(rawMax) {
        if (rawMax <= 0) return 100;
        const magnitude = Math.pow(10, Math.floor(Math.log10(rawMax)));
        const normalized = rawMax / magnitude;
        let n;
        if (normalized <= 1) n = 1; else if (normalized <= 2) n = 2; else if (normalized <= 5) n = 5; else n = 10;
        return n * magnitude;
    }

    function renderTrendChart() {
        const wrap = document.getElementById('exprepTrendChart');
        const points = state.trend;

        if (points.length === 0 || points.every(p => p.value === 0)) {
            wrap.innerHTML = `<div class="exprep-chart-empty"><i class="fa-regular fa-chart-bar" style="font-size:1.6rem; display:block; margin-bottom:8px;"></i>No expenses in this range.</div>`;
            return;
        }

        const W = 640, H = 260;
        const padL = 46, padR = 16, padT = 16, padB = 34;
        const plotW = W - padL - padR, plotH = H - padT - padB;

        const maxVal = niceMax(Math.max(...points.map(p => p.value)));
        const stepX = points.length > 1 ? plotW / (points.length - 1) : 0;
        const xAt = i => padL + i * stepX;
        const yAt = v => padT + plotH - (v / maxVal) * plotH;

        const gridCount = 4;
        let gridLines = '', gridLabels = '';
        for (let g = 0; g <= gridCount; g++) {
            const v = (maxVal / gridCount) * g;
            const y = yAt(v);
            gridLines += `<line class="exprep-grid-line" x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}"/>`;
            gridLabels += `<text class="exprep-axis-label" x="${padL - 8}" y="${y + 3}" text-anchor="end">K${formatCompact(v)}</text>`;
        }

        let xLabels = '';
        const labelEvery = points.length > 20 ? Math.ceil(points.length / 10) : 2;
        points.forEach((p, i) => {
            if (i % labelEvery === 0 || i === points.length - 1) {
                xLabels += `<text class="exprep-axis-label" x="${xAt(i)}" y="${H - padB + 16}" text-anchor="middle">${p.label}</text>`;
            }
        });

        const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i)} ${yAt(p.value)}`).join(' ');
        const areaPath = `${linePath} L ${xAt(points.length - 1)} ${padT + plotH} L ${xAt(0)} ${padT + plotH} Z`;
        const lastPoint = points[points.length - 1];
        const lastX = xAt(points.length - 1), lastY = yAt(lastPoint.value);

        let hitRects = '';
        points.forEach((p, i) => {
            const left = i === 0 ? padL : (xAt(i - 1) + xAt(i)) / 2;
            const right = i === points.length - 1 ? W - padR : (xAt(i) + xAt(i + 1)) / 2;
            hitRects += `<rect class="exprep-hit-rect" data-i="${i}" x="${left}" y="${padT}" width="${Math.max(right - left, 1)}" height="${plotH}"/>`;
        });

        wrap.innerHTML = `
            <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Expense trend">
                ${gridLines}
                <path class="exprep-area-fill" d="${areaPath}"/>
                <path class="exprep-line-path" d="${linePath}"/>
                <circle class="exprep-end-dot-ring" cx="${lastX}" cy="${lastY}" r="6"/>
                <circle class="exprep-end-dot" cx="${lastX}" cy="${lastY}" r="4"/>
                <text class="exprep-value-label" x="${Math.min(lastX, W - padR - 46)}" y="${lastY - 12}">K${formatCompact(lastPoint.value)}</text>
                ${gridLabels}
                ${xLabels}
                <line class="exprep-crosshair-line" id="exprepTrendCrosshair" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" style="display:none;"/>
                <circle class="exprep-crosshair-dot" id="exprepTrendCrosshairDot" r="5" style="display:none;"/>
                ${hitRects}
            </svg>
        `;

        const svg = wrap.querySelector('svg');
        const crosshair = document.getElementById('exprepTrendCrosshair');
        const crosshairDot = document.getElementById('exprepTrendCrosshairDot');
        const tooltip = getOrCreateTooltip(wrap);

        function showAt(i, clientX, clientY) {
            const p = points[i];
            const x = xAt(i), y = yAt(p.value);
            crosshair.setAttribute('x1', x); crosshair.setAttribute('x2', x);
            crosshair.style.display = '';
            crosshairDot.setAttribute('cx', x); crosshairDot.setAttribute('cy', y);
            crosshairDot.style.display = '';
            tooltip.innerHTML = '';
            const labelEl = document.createElement('div');
            labelEl.className = 'exprep-tooltip-label';
            labelEl.textContent = p.label;
            const valueEl = document.createElement('div');
            valueEl.className = 'exprep-tooltip-value';
            valueEl.textContent = `K${formatNumber(p.value)}`;
            tooltip.appendChild(labelEl);
            tooltip.appendChild(valueEl);
            positionTooltip(tooltip, wrap, clientX, clientY);
            tooltip.classList.add('show');
        }
        function hide() {
            crosshair.style.display = 'none';
            crosshairDot.style.display = 'none';
            tooltip.classList.remove('show');
        }
        svg.querySelectorAll('.exprep-hit-rect').forEach(rect => {
            const i = parseInt(rect.dataset.i, 10);
            rect.addEventListener('pointermove', (e) => showAt(i, e.clientX, e.clientY));
            rect.addEventListener('pointerleave', hide);
            rect.setAttribute('tabindex', '0');
            rect.addEventListener('focus', () => { const r = rect.getBoundingClientRect(); showAt(i, r.left + r.width / 2, r.top); });
            rect.addEventListener('blur', hide);
        });
    }

    // ============================================
    // TOOLTIP HELPERS
    // ============================================

    function getOrCreateTooltip(wrap) {
        let tooltip = wrap.querySelector('.exprep-tooltip');
        if (!tooltip) {
            tooltip = document.createElement('div');
            tooltip.className = 'exprep-tooltip';
            wrap.appendChild(tooltip);
        }
        return tooltip;
    }
    function positionTooltip(tooltip, wrap, clientX, clientY) {
        const wrapRect = wrap.getBoundingClientRect();
        let left = clientX - wrapRect.left + 14;
        let top = clientY - wrapRect.top - 10;
        const tooltipWidth = 150;
        if (left + tooltipWidth > wrapRect.width) left = clientX - wrapRect.left - tooltipWidth - 14;
        tooltip.style.left = `${left}px`;
        tooltip.style.top = `${top}px`;
    }

    // ============================================
    // TABLE VIEW TOGGLES
    // ============================================

    function buildBarTable(rows) {
        const trs = rows.map(r => `<tr><td>${r.label}</td><td class="exprep-num">K${formatNumber(r.value)}</td></tr>`).join('');
        return `<table class="exprep-table-simple"><thead><tr><th>Category</th><th class="exprep-num">Amount</th></tr></thead><tbody>${trs}</tbody></table>`;
    }
    function buildTrendTable() {
        const trs = state.trend.map(p => `<tr><td>${p.label}</td><td class="exprep-num">K${formatNumber(p.value)}</td></tr>`).join('');
        return `<table class="exprep-table-simple"><thead><tr><th>Period</th><th class="exprep-num">Total</th></tr></thead><tbody>${trs}</tbody></table>`;
    }

    window.toggleExpenseReportTable = function (which) {
        const ids = {
            category: ['exprepCatChart', 'exprepCatTable', 'exprepCatTableToggle'],
            account: ['exprepAcctChart', 'exprepAcctTable', 'exprepAcctTableToggle'],
            trend: ['exprepTrendChart', 'exprepTrendTable', 'exprepTrendTableToggle']
        }[which];
        const [svgId, tableId, btnId] = ids;
        const svgWrap = document.getElementById(svgId);
        const tableWrap = document.getElementById(tableId);
        const btn = document.getElementById(btnId);
        const showingTable = tableWrap.style.display !== 'none';
        if (showingTable) {
            tableWrap.style.display = 'none';
            svgWrap.style.display = '';
            btn.innerHTML = '<i class="fa-solid fa-table"></i> View as table';
        } else {
            if (which === 'category') tableWrap.innerHTML = buildBarTable(state.byCategory);
            else if (which === 'account') tableWrap.innerHTML = buildBarTable(state.byAccount);
            else tableWrap.innerHTML = buildTrendTable();
            tableWrap.style.display = '';
            svgWrap.style.display = 'none';
            btn.innerHTML = '<i class="fa-solid fa-chart-line"></i> View as chart';
        }
    };

    // ============================================
    // DETAIL LIST
    // ============================================

    function renderList() {
        const body = document.getElementById('exprepListBody');
        const rows = [...state.filtered].sort((a, b) => (a.date < b.date ? 1 : -1));

        if (rows.length === 0) {
            body.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:30px;color:#94a3b8;">No expense transactions in this range.</td></tr>`;
        } else {
            body.innerHTML = rows.map(r => `
                <tr>
                    <td>${r.date}</td>
                    <td>${r.transactionNumber}</td>
                    <td><span class="exprep-badge">${r.category}</span></td>
                    <td>${r.description}</td>
                    <td>${r.reference}</td>
                    <td>${r.account}</td>
                    <td class="exprep-num" style="font-weight:600;">K${formatNumber(r.amount)}</td>
                </tr>`).join('');
        }
        document.getElementById('exprepListCount').textContent = `${rows.length} transaction${rows.length === 1 ? '' : 's'}`;
    }

    window.expenseReportExportCsv = function () {
        const rows = [...state.filtered].sort((a, b) => (a.date < b.date ? 1 : -1));
        const header = ['Date', 'Transaction #', 'Category', 'Description', 'Reference', 'Paid Via', 'Amount'];
        const csvRows = [header.join(',')];
        rows.forEach(r => {
            const cells = [r.date, r.transactionNumber, r.category, r.description, r.reference, r.account, r.amount.toFixed(2)]
                .map(c => `"${String(c).replace(/"/g, '""')}"`);
            csvRows.push(cells.join(','));
        });
        const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `expense-report_${state.from}_to_${state.to}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    // ============================================
    // APPLY / INIT
    // ============================================

    async function renderAll() {
        const from = document.getElementById('exprepFrom').value;
        const to = document.getElementById('exprepTo').value;
        const category = document.getElementById('exprepCategoryFilter').value;
        state.from = from; state.to = to; state.category = category;

        const result = computeForRange(state.allRows, from, to, category);
        state.filtered = result.filtered;
        state.byCategory = result.byCategory;
        state.byAccount = result.byAccount;
        state.trend = result.trend;

        document.getElementById('exprepRangeLabel').textContent =
            `${new Date(from + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} – ${new Date(to + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

        renderKPIs();
        renderBarChart('exprepCatChart', state.byCategory, 'exprep-bar', 'expenses by category');
        renderBarChart('exprepAcctChart', state.byAccount, 'exprep-bar-acct', 'expenses by account');
        renderTrendChart();
        renderList();

        ['category', 'account', 'trend'].forEach(which => {
            const ids = { category: 'exprepCatTable', account: 'exprepAcctTable', trend: 'exprepTrendTable' };
            const tableEl = document.getElementById(ids[which]);
            if (tableEl && tableEl.style.display !== 'none') {
                window.toggleExpenseReportTable(which);
                window.toggleExpenseReportTable(which);
            }
        });
    }

    window.expenseReportApply = async function () {
        const btn = document.getElementById('exprepApplyBtn');
        btn.disabled = true;
        try {
            await renderAll();
        } catch (error) {
            console.error('Error applying Expense Report filter:', error);
        } finally {
            btn.disabled = false;
        }
    };

    (async function init() {
        try {
            const now = new Date();
            const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
            document.getElementById('exprepFrom').value = dateKey(monthStart);
            document.getElementById('exprepTo').value = dateKey(now);

            state.allRows = await loadExpenses();
            populateCategoryFilter(state.allRows);

            await renderAll();
            console.log("✅ Expense Report initialized successfully!");
        } catch (error) {
            console.error('Error loading Expense Report:', error);
            const wrap = document.getElementById('exprepListBody');
            if (wrap) wrap.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:30px;color:#94a3b8;">Could not load the Expense Report. Check the console for details.</td></tr>`;
        }
    })();
})();
// ============================================
// REPORTS OVERVIEW (Report module landing page)
// ============================================
// Was just "Select a report from the sidebar." with nothing else on the
// page. This adds a KPI row, two charts (sales trend + sales by type),
// and quick-link cards into the four real reports -- built by hand in
// SVG (no charting library added) following the house dataviz rules:
// single accent hue per chart (no rainbow), thin 2px line / capped bars,
// recessive hairline gridlines, hover tooltips + line-chart crosshair,
// and a "View as table" toggle on every chart so nothing is chart-only.
//
// Sales figures use the SAME scope as the Dashboard sidebar's "Sales
// Today" stat (client_type IN RETAIL/WHOLESALE only, quotations
// excluded) -- Write-Off/Donation rows are inventory loss/giveaways, not
// revenue, so they're left out of a "Sales" KPI on purpose, matching
// that existing convention (see dashboard-view.js's loadSidebarStats()).
// ============================================

(async function initReportOverview() {
    console.log("Reports Overview initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    const ACCENT = '#2563eb';
    const TYPE_ROWS = [
        { key: 'NHIMA', label: 'NHIMA' },
        { key: 'REGULAR', label: 'Regular' },
        { key: 'ONLINE', label: 'Online' },
        { key: 'STAFF', label: 'Staff' },
        { key: 'WHOLESALE', label: 'Wholesale' }
    ];

    const state = {
        trend: [],   // [{ dateStr, label, value }] oldest -> newest, 14 points
        byType: []   // [{ key, label, value }] sorted desc
    };

    function formatNumber(num) {
        return (num || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    // Compact form for KPI tiles / axis labels (1,284 / 12.9K / 4.2M) --
    // full precision is still available in the tooltip/table.
    function formatCompact(num) {
        const n = num || 0;
        const abs = Math.abs(n);
        if (abs >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
        if (abs >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
        return formatNumber(n);
    }

    function classifyRow(sale) {
        if (sale.client_sub_type === 'NHIMA') return 'NHIMA';
        if (sale.client_type === 'WHOLESALE') return 'WHOLESALE';
        if (sale.client_sub_type === 'ONLINE') return 'ONLINE';
        if (sale.client_sub_type === 'STAFF') return 'STAFF';
        return 'REGULAR';
    }

    function dateKey(d) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    // ============================================
    // FETCH + AGGREGATE
    // ============================================

    async function loadKPIsAndCharts() {
        const now = new Date();
        const todayKey = dateKey(now);
        const rangeStartDate = new Date(now);
        rangeStartDate.setDate(rangeStartDate.getDate() - 30); // 31-day window, always covers month-to-date
        const monthStartKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

        const rangeStart = `${dateKey(rangeStartDate)}T00:00:00`;
        const rangeEnd = `${todayKey}T23:59:59`;

        const [salesResult, payablesResult, batchesResult] = await Promise.all([
            supabaseClient
                .from('sales')
                .select('grand_total, client_type, client_sub_type, created_at')
                .in('client_type', ['RETAIL', 'WHOLESALE'])
                .neq('is_quotation', true)
                .gte('created_at', rangeStart)
                .lte('created_at', rangeEnd),
            supabaseClient
                .from('supplier_payables')
                .select('currency, amount_remaining'),
            supabaseClient
                .from('batches')
                .select('expiry_date, total_qty')
                .gt('total_qty', 0)
        ]);

        if (salesResult.error) throw salesResult.error;
        if (payablesResult.error) throw payablesResult.error;
        if (batchesResult.error) throw batchesResult.error;

        const sales = salesResult.data || [];

        // -- Today / Month-to-date --
        let todayTotal = 0, monthTotal = 0;
        sales.forEach(s => {
            const amount = parseFloat(s.grand_total) || 0;
            const dayKey = (s.created_at || '').slice(0, 10);
            if (dayKey === todayKey) todayTotal += amount;
            if (dayKey >= monthStartKey) monthTotal += amount;
        });

        // -- 14-day trend (zero-filled, oldest -> newest) --
        const trendMap = new Map();
        sales.forEach(s => {
            const dayKey = (s.created_at || '').slice(0, 10);
            trendMap.set(dayKey, (trendMap.get(dayKey) || 0) + (parseFloat(s.grand_total) || 0));
        });
        const trend = [];
        for (let i = 13; i >= 0; i--) {
            const d = new Date(now);
            d.setDate(d.getDate() - i);
            const key = dateKey(d);
            trend.push({
                dateStr: key,
                label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
                value: trendMap.get(key) || 0
            });
        }

        // -- 30-day by-type (whole window, already scoped to RETAIL/WHOLESALE) --
        const byTypeMap = {};
        TYPE_ROWS.forEach(r => { byTypeMap[r.key] = 0; });
        sales.forEach(s => {
            const key = classifyRow(s);
            byTypeMap[key] = (byTypeMap[key] || 0) + (parseFloat(s.grand_total) || 0);
        });
        const byType = TYPE_ROWS
            .map(r => ({ key: r.key, label: r.label, value: byTypeMap[r.key] || 0 }))
            .sort((a, b) => b.value - a.value);

        // -- Pending payables (per currency, never combined) --
        let payZmw = 0, payUsd = 0;
        (payablesResult.data || []).forEach(p => {
            const remaining = parseFloat(p.amount_remaining) || 0;
            if (p.currency === 'USD') payUsd += remaining; else payZmw += remaining;
        });

        // -- Expiring/expired active stock (<=30 days, same threshold as
        // Inventory Report / Expiry Management) --
        const today0 = new Date(now); today0.setHours(0, 0, 0, 0);
        let expiringCount = 0;
        (batchesResult.data || []).forEach(b => {
            const expiry = new Date(b.expiry_date); expiry.setHours(0, 0, 0, 0);
            const days = Math.ceil((expiry - today0) / (1000 * 60 * 60 * 24));
            if (days <= 30) expiringCount++;
        });

        state.trend = trend;
        state.byType = byType;

        return { todayTotal, monthTotal, payZmw, payUsd, expiringCount };
    }

    // ============================================
    // RENDER -- KPI TILES
    // ============================================

    function renderKPIs(k) {
        document.getElementById('repOvStatTodaySales').textContent = `K${formatNumber(k.todayTotal)}`;
        document.getElementById('repOvStatMonthSales').textContent = `K${formatNumber(k.monthTotal)}`;
        document.getElementById('repOvStatPayables').textContent = `K${formatCompact(k.payZmw)} / $${formatCompact(k.payUsd)}`;
        document.getElementById('repOvStatExpiring').textContent = `${k.expiringCount} batch${k.expiringCount === 1 ? '' : 'es'}`;
    }

    // ============================================
    // RENDER -- LINE CHART (Sales Trend)
    // ============================================
    // Single series -> no legend needed (title already says what's
    // plotted). 2px line, 10% area wash, hairline gridlines rounded to
    // clean numbers, end-dot + end value label, full-width crosshair
    // that snaps to the nearest day with a one-line tooltip.

    function niceMax(rawMax) {
        if (rawMax <= 0) return 100;
        const magnitude = Math.pow(10, Math.floor(Math.log10(rawMax)));
        const normalized = rawMax / magnitude;
        let niceNormalized;
        if (normalized <= 1) niceNormalized = 1;
        else if (normalized <= 2) niceNormalized = 2;
        else if (normalized <= 5) niceNormalized = 5;
        else niceNormalized = 10;
        return niceNormalized * magnitude;
    }

    function renderTrendChart() {
        const wrap = document.getElementById('repOvTrendChart');
        const points = state.trend;

        if (points.every(p => p.value === 0)) {
            wrap.innerHTML = `<div class="repov-chart-empty"><i class="fa-regular fa-chart-bar" style="font-size:1.6rem; display:block; margin-bottom:8px;"></i>No sales in the last 14 days.</div>`;
            return;
        }

        const W = 640, H = 260;
        const padL = 46, padR = 16, padT = 16, padB = 34;
        const plotW = W - padL - padR, plotH = H - padT - padB;

        const maxVal = niceMax(Math.max(...points.map(p => p.value)));
        const stepX = plotW / (points.length - 1);

        const xAt = i => padL + i * stepX;
        const yAt = v => padT + plotH - (v / maxVal) * plotH;

        // 4 horizontal gridlines (0 .. maxVal), rounded to clean numbers
        const gridCount = 4;
        let gridLines = '', gridLabels = '';
        for (let g = 0; g <= gridCount; g++) {
            const v = (maxVal / gridCount) * g;
            const y = yAt(v);
            gridLines += `<line class="repov-grid-line" x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}"/>`;
            gridLabels += `<text class="repov-axis-label" x="${padL - 8}" y="${y + 3}" text-anchor="end">K${formatCompact(v)}</text>`;
        }

        // X-axis labels -- every 2nd day so 14 labels don't collide
        let xLabels = '';
        points.forEach((p, i) => {
            if (i % 2 === 0 || i === points.length - 1) {
                xLabels += `<text class="repov-axis-label" x="${xAt(i)}" y="${H - padB + 16}" text-anchor="middle">${p.label}</text>`;
            }
        });

        const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i)} ${yAt(p.value)}`).join(' ');
        const areaPath = `${linePath} L ${xAt(points.length - 1)} ${padT + plotH} L ${xAt(0)} ${padT + plotH} Z`;

        const lastPoint = points[points.length - 1];
        const lastX = xAt(points.length - 1), lastY = yAt(lastPoint.value);

        // Invisible per-day hit columns, wider than the mark, for the
        // crosshair to snap to on hover/focus.
        let hitRects = '';
        points.forEach((p, i) => {
            const left = i === 0 ? padL : (xAt(i - 1) + xAt(i)) / 2;
            const right = i === points.length - 1 ? W - padR : (xAt(i) + xAt(i + 1)) / 2;
            hitRects += `<rect class="repov-hit-rect" data-i="${i}" x="${left}" y="${padT}" width="${right - left}" height="${plotH}"/>`;
        });

        wrap.innerHTML = `
            <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Sales trend over the last 14 days">
                ${gridLines}
                <path class="repov-area-fill" d="${areaPath}"/>
                <path class="repov-line-path" d="${linePath}"/>
                <circle class="repov-end-dot-ring" cx="${lastX}" cy="${lastY}" r="6"/>
                <circle class="repov-end-dot" cx="${lastX}" cy="${lastY}" r="4"/>
                <text class="repov-value-label" x="${Math.min(lastX, W - padR - 46)}" y="${lastY - 12}">K${formatCompact(lastPoint.value)}</text>
                ${gridLabels}
                ${xLabels}
                <line class="repov-crosshair-line" id="repOvTrendCrosshair" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" style="display:none;"/>
                <circle class="repov-crosshair-dot" id="repOvTrendCrosshairDot" r="5" style="display:none;"/>
                ${hitRects}
            </svg>
        `;

        const svg = wrap.querySelector('svg');
        const crosshair = document.getElementById('repOvTrendCrosshair');
        const crosshairDot = document.getElementById('repOvTrendCrosshairDot');
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
            labelEl.className = 'repov-tooltip-label';
            labelEl.textContent = p.label;
            const valueEl = document.createElement('div');
            valueEl.className = 'repov-tooltip-value';
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

        svg.querySelectorAll('.repov-hit-rect').forEach(rect => {
            const i = parseInt(rect.dataset.i, 10);
            rect.addEventListener('pointermove', (e) => showAt(i, e.clientX, e.clientY));
            rect.addEventListener('pointerleave', hide);
            rect.setAttribute('tabindex', '0');
            rect.addEventListener('focus', () => {
                const r = rect.getBoundingClientRect();
                showAt(i, r.left + r.width / 2, r.top);
            });
            rect.addEventListener('blur', hide);
        });
    }

    // ============================================
    // RENDER -- HORIZONTAL BAR CHART (Sales By Type)
    // ============================================
    // Magnitude comparison across categories, already ranked by sort --
    // one accent hue (not a categorical rainbow), per the "compare
    // magnitude" color rule. Value labels sit at the bar tip; category
    // names are plain text, never colored.

    function renderTypeChart() {
        const wrap = document.getElementById('repOvTypeChart');
        const rows = state.byType;

        if (rows.every(r => r.value === 0)) {
            wrap.innerHTML = `<div class="repov-chart-empty"><i class="fa-regular fa-chart-bar" style="font-size:1.6rem; display:block; margin-bottom:8px;"></i>No sales in the last 30 days.</div>`;
            return;
        }

        const barH = 22, gap = 14, labelW = 74;
        const W = 640;
        const plotL = labelW, plotR = W - 90; // right margin reserved for value labels
        const H = rows.length * (barH + gap) + gap;

        const maxVal = Math.max(...rows.map(r => r.value)) || 1;
        const scale = (plotR - plotL) / maxVal;

        let bars = '';
        rows.forEach((r, i) => {
            const y = gap + i * (barH + gap);
            const barLen = Math.max(r.value * scale, 2);
            const midY = y + barH / 2;

            bars += `
                <text class="repov-bar-label" x="${plotL - 10}" y="${midY + 4}" text-anchor="end">${r.label}</text>
                <rect class="repov-bar" data-i="${i}" x="${plotL}" y="${y}" width="${barLen}" height="${barH}" rx="4"/>
                <text class="repov-bar-value" x="${plotL + barLen + 8}" y="${midY + 4}">K${formatCompact(r.value)}</text>
                <rect class="repov-bar-hit" data-i="${i}" x="0" y="${y - gap / 2}" width="${W}" height="${barH + gap}"/>
            `;
        });

        wrap.innerHTML = `
            <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Sales by type over the last 30 days">
                ${bars}
            </svg>
        `;

        const svg = wrap.querySelector('svg');
        const tooltip = getOrCreateTooltip(wrap);

        svg.querySelectorAll('.repov-bar-hit').forEach(hit => {
            const i = parseInt(hit.dataset.i, 10);
            const bar = svg.querySelector(`.repov-bar[data-i="${i}"]`);

            function show(clientX, clientY) {
                bar.classList.add('repov-bar-hover');
                const r = rows[i];
                tooltip.innerHTML = '';
                const labelEl = document.createElement('div');
                labelEl.className = 'repov-tooltip-label';
                labelEl.textContent = r.label + ' Sale';
                const valueEl = document.createElement('div');
                valueEl.className = 'repov-tooltip-value';
                valueEl.textContent = `K${formatNumber(r.value)}`;
                tooltip.appendChild(labelEl);
                tooltip.appendChild(valueEl);
                positionTooltip(tooltip, wrap, clientX, clientY);
                tooltip.classList.add('show');
            }
            function hide() {
                bar.classList.remove('repov-bar-hover');
                tooltip.classList.remove('show');
            }

            hit.addEventListener('pointermove', (e) => show(e.clientX, e.clientY));
            hit.addEventListener('pointerleave', hide);
            hit.setAttribute('tabindex', '0');
            hit.addEventListener('focus', () => {
                const r = hit.getBoundingClientRect();
                show(r.left + r.width / 2, r.top);
            });
            hit.addEventListener('blur', hide);
        });
    }

    // ============================================
    // TOOLTIP HELPERS (shared by both charts)
    // ============================================

    function getOrCreateTooltip(wrap) {
        let tooltip = wrap.querySelector('.repov-tooltip');
        if (!tooltip) {
            tooltip = document.createElement('div');
            tooltip.className = 'repov-tooltip';
            wrap.appendChild(tooltip);
        }
        return tooltip;
    }

    function positionTooltip(tooltip, wrap, clientX, clientY) {
        const wrapRect = wrap.getBoundingClientRect();
        let left = clientX - wrapRect.left + 14;
        let top = clientY - wrapRect.top - 10;
        // Keep it from overflowing the right edge of the card.
        const tooltipWidth = 130;
        if (left + tooltipWidth > wrapRect.width) left = clientX - wrapRect.left - tooltipWidth - 14;
        tooltip.style.left = `${left}px`;
        tooltip.style.top = `${top}px`;
    }

    // ============================================
    // TABLE VIEW TOGGLE -- the accessibility twin of every chart here
    // ============================================

    function buildTrendTable() {
        const rows = state.trend.map(p => `<tr><td>${p.label}</td><td class="repov-num">K${formatNumber(p.value)}</td></tr>`).join('');
        return `<table class="repov-table-simple"><thead><tr><th>Date</th><th class="repov-num">Sales</th></tr></thead><tbody>${rows}</tbody></table>`;
    }

    function buildTypeTable() {
        const rows = state.byType.map(r => `<tr><td>${r.label} Sale</td><td class="repov-num">K${formatNumber(r.value)}</td></tr>`).join('');
        return `<table class="repov-table-simple"><thead><tr><th>Sale Type</th><th class="repov-num">Sales (Last 30 Days)</th></tr></thead><tbody>${rows}</tbody></table>`;
    }

    window.toggleReportOverviewTable = function (which) {
        const svgWrapId = which === 'trend' ? 'repOvTrendChart' : 'repOvTypeChart';
        const tableWrapId = which === 'trend' ? 'repOvTrendTable' : 'repOvTypeTable';
        const toggleBtnId = which === 'trend' ? 'repOvTrendTableToggle' : 'repOvTypeTableToggle';

        const svgWrap = document.getElementById(svgWrapId);
        const tableWrap = document.getElementById(tableWrapId);
        const btn = document.getElementById(toggleBtnId);

        const showingTable = tableWrap.style.display !== 'none';
        if (showingTable) {
            tableWrap.style.display = 'none';
            svgWrap.style.display = '';
            btn.innerHTML = '<i class="fa-solid fa-table"></i> View as table';
        } else {
            tableWrap.innerHTML = which === 'trend' ? buildTrendTable() : buildTypeTable();
            tableWrap.style.display = '';
            svgWrap.style.display = 'none';
            btn.innerHTML = '<i class="fa-solid fa-chart-line"></i> View as chart';
        }
    };

    // ============================================
    // INIT
    // ============================================
    try {
        const kpis = await loadKPIsAndCharts();
        renderKPIs(kpis);
        renderTrendChart();
        renderTypeChart();
        console.log("✅ Reports Overview initialized successfully!");
    } catch (error) {
        console.error('Error loading Reports Overview:', error);
        ['repOvStatTodaySales', 'repOvStatMonthSales', 'repOvStatPayables', 'repOvStatExpiring'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.textContent = '--';
        });
    }
})();
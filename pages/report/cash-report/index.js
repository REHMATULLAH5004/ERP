// ============================================
// CASH REPORT -- where cash came from, where it went
// ============================================
// Sourced straight from the general ledger: every cash movement is a
// journal_lines row against 1111 (Cash in Hand ZMW), 1121 (Bank ZMW) or
// 1120 (Bank USD). Each of those lines lives in a journal_entry alongside
// exactly one "counterparty" line (confirmed against live data -- e.g. a
// retail cash sale posts Debit 1111 / Credit 4002 "Retail - Regular
// Sales" in the SAME entry, a supplier payment posts Credit 1111 / Debit
// 2001 "Accounts Payable"). That counterparty account IS the answer to
// "where did this cash come from / go to" -- so this report reads it
// straight from chart_of_accounts rather than guessing from free-text
// descriptions.
//
// Built following the same house style as report-view.js: single accent
// hue per chart (green/red here specifically because in-vs-out is a
// polarity, not a category list), thin 2px line / capped bars, recessive
// gridlines, hover tooltips, and a "View as table" toggle on every chart.
// ============================================

(function initCashReport() {
    console.log("Cash Report initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    const CASH_CODES = ['1111', '1121', '1120'];
    const ACCOUNT_META = {
        '1111': { label: 'Cash in Hand (ZMW)', currency: 'K', accent: '#2563eb' },
        '1121': { label: 'Bank (ZMW)', currency: 'K', accent: '#7c3aed' },
        '1120': { label: 'Bank (USD)', currency: '$', accent: '#0891b2' }
    };
    const ZMW_CODES = ['1111', '1121'];

    const state = {
        from: null,
        to: null,
        accountNames: {},   // account_code -> chart_of_accounts.name
        ledger: [],          // full ledger rows in the selected range, all 3 accounts
        accountTotals: {},   // code -> { opening, in, out, closing }
        inBySource: [],      // [{ label, value }] ZMW only, sorted desc
        outByUse: [],        // [{ label, value }] ZMW only, sorted desc
        trend: []            // [{ label, value }] net ZMW cash flow, oldest -> newest
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
        const day = copy.getDay(); // 0 = Sunday
        const diff = (day === 0 ? -6 : 1) - day; // move back to Monday
        copy.setDate(copy.getDate() + diff);
        return copy;
    }

    // ============================================
    // FETCH + AGGREGATE
    // ============================================

    async function loadChartOfAccountNames() {
        const { data, error } = await supabaseClient.from('chart_of_accounts').select('code, name');
        if (error) throw error;
        const map = {};
        (data || []).forEach(a => { map[a.code] = a.name; });
        state.accountNames = map;
    }

    async function loadCashLedger() {
        // All cash-account lines, ever -- small volume (a few dozen rows
        // today), and we need the full history anyway to compute a
        // correct Opening Balance for whatever range is selected.
        const { data: cashLines, error: cashError } = await supabaseClient
            .from('journal_lines')
            .select('journal_entry_id, account_code, description, debit, credit, journal_entries(entry_date, reference, description)')
            .in('account_code', CASH_CODES);
        if (cashError) throw cashError;

        const entryIds = [...new Set((cashLines || []).map(l => l.journal_entry_id))];
        let counterpartyByEntry = {};
        if (entryIds.length > 0) {
            const { data: counterLines, error: counterError } = await supabaseClient
                .from('journal_lines')
                .select('journal_entry_id, account_code, debit, credit')
                .in('journal_entry_id', entryIds)
                .not('account_code', 'in', `(${CASH_CODES.join(',')})`);
            if (counterError) throw counterError;
            (counterLines || []).forEach(l => {
                // An entry could in theory have more than one counterparty
                // line -- keep the first one found rather than overwriting,
                // since that's still a truthful (if partial) answer to
                // "where did it go" rather than a random pick.
                if (!counterpartyByEntry[l.journal_entry_id]) {
                    counterpartyByEntry[l.journal_entry_id] = l.account_code;
                }
            });
        }

        const allRows = (cashLines || []).map(l => {
            const je = l.journal_entries || {};
            const counterCode = counterpartyByEntry[l.journal_entry_id];
            const counterName = counterCode ? (state.accountNames[counterCode] || `Account ${counterCode}`) : 'Other';
            return {
                entryDate: je.entry_date || null,
                accountCode: l.account_code,
                reference: je.reference || '-',
                description: je.description || l.description || '-',
                counterName,
                debit: parseFloat(l.debit) || 0,
                credit: parseFloat(l.credit) || 0
            };
        }).filter(r => r.entryDate);

        return allRows;
    }

    function computeForRange(allRows, fromStr, toStr) {
        const inRange = r => r.entryDate >= fromStr && r.entryDate <= toStr;
        const beforeRange = r => r.entryDate < fromStr;

        const accountTotals = {};
        CASH_CODES.forEach(code => {
            const opening = allRows.filter(r => r.accountCode === code && beforeRange(r))
                .reduce((sum, r) => sum + r.debit - r.credit, 0);
            const rangeRows = allRows.filter(r => r.accountCode === code && inRange(r));
            const cashIn = rangeRows.reduce((sum, r) => sum + r.debit, 0);
            const cashOut = rangeRows.reduce((sum, r) => sum + r.credit, 0);
            accountTotals[code] = { opening, in: cashIn, out: cashOut, closing: opening + cashIn - cashOut };
        });

        const ledger = allRows.filter(inRange).sort((a, b) => (a.entryDate < b.entryDate ? 1 : -1));

        // Sources / Uses -- ZMW accounts only (Cash in Hand + Bank ZMW),
        // grouped by the counterparty account name.
        const zmwLedger = ledger.filter(r => ZMW_CODES.includes(r.accountCode));
        const inMap = {}, outMap = {};
        zmwLedger.forEach(r => {
            if (r.debit > 0) inMap[r.counterName] = (inMap[r.counterName] || 0) + r.debit;
            if (r.credit > 0) outMap[r.counterName] = (outMap[r.counterName] || 0) + r.credit;
        });
        const inBySource = Object.entries(inMap).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
        const outByUse = Object.entries(outMap).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);

        // Trend -- net ZMW cash flow, daily if the range is <=31 days,
        // otherwise bucketed by week so a multi-month range stays readable.
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
        zmwLedger.forEach(r => {
            const d = new Date(r.entryDate + 'T00:00:00');
            const bucketStart = useWeekly ? startOfWeek(d) : d;
            const key = dateKey(bucketStart);
            const bucket = bucketMap.get(key);
            if (bucket) bucket.value += (r.debit - r.credit);
        });
        const trend = bucketOrder.map(k => bucketMap.get(k));

        return { accountTotals, ledger, inBySource, outByUse, trend };
    }

    // ============================================
    // RENDER -- ACCOUNT CARDS
    // ============================================

    function renderAccountCards() {
        const wrap = document.getElementById('cashrepAccountCards');
        wrap.innerHTML = CASH_CODES.map(code => {
            const meta = ACCOUNT_META[code];
            const t = state.accountTotals[code] || { opening: 0, in: 0, out: 0, closing: 0 };
            return `
            <div class="cashrep-account-card" style="border-left-color:${meta.accent};">
                <h4>${meta.label}</h4>
                <div class="cashrep-row"><span>Opening</span><span>${meta.currency}${formatNumber(t.opening)}</span></div>
                <div class="cashrep-row cashrep-in"><span>Cash In</span><span>+${meta.currency}${formatNumber(t.in)}</span></div>
                <div class="cashrep-row cashrep-out"><span>Cash Out</span><span>-${meta.currency}${formatNumber(t.out)}</span></div>
                <div class="cashrep-row cashrep-closing"><span>Closing</span><span>${meta.currency}${formatNumber(t.closing)}</span></div>
            </div>`;
        }).join('');
    }

    // ============================================
    // RENDER -- SOURCES / USES BAR CHARTS
    // ============================================

    function renderBarChart(containerId, rows, barClass, label) {
        const wrap = document.getElementById(containerId);
        if (rows.length === 0) {
            wrap.innerHTML = `<div class="cashrep-chart-empty"><i class="fa-regular fa-chart-bar" style="font-size:1.6rem; display:block; margin-bottom:8px;"></i>No ${label} in this range.</div>`;
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
                <text class="cashrep-bar-label" x="${plotL - 10}" y="${midY + 4}" text-anchor="end">${shortLabel}</text>
                <rect class="${barClass}" data-i="${i}" x="${plotL}" y="${y}" width="${barLen}" height="${barH}" rx="4"/>
                <text class="cashrep-bar-value" x="${plotL + barLen + 8}" y="${midY + 4}">K${formatCompact(r.value)}</text>
                <rect class="cashrep-bar-hit" data-i="${i}" x="0" y="${y - gap / 2}" width="${W}" height="${barH + gap}"/>
            `;
        });

        wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}">${bars}</svg>`;

        const svg = wrap.querySelector('svg');
        const tooltip = getOrCreateTooltip(wrap);
        svg.querySelectorAll('.cashrep-bar-hit').forEach(hit => {
            const i = parseInt(hit.dataset.i, 10);
            const bar = svg.querySelector(`.${barClass}[data-i="${i}"]`);
            function show(clientX, clientY) {
                bar.classList.add('cashrep-bar-hover');
                const r = rows[i];
                tooltip.innerHTML = '';
                const labelEl = document.createElement('div');
                labelEl.className = 'cashrep-tooltip-label';
                labelEl.textContent = r.label;
                const valueEl = document.createElement('div');
                valueEl.className = 'cashrep-tooltip-value';
                valueEl.textContent = `K${formatNumber(r.value)}`;
                tooltip.appendChild(labelEl);
                tooltip.appendChild(valueEl);
                positionTooltip(tooltip, wrap, clientX, clientY);
                tooltip.classList.add('show');
            }
            function hide() { bar.classList.remove('cashrep-bar-hover'); tooltip.classList.remove('show'); }
            hit.addEventListener('pointermove', (e) => show(e.clientX, e.clientY));
            hit.addEventListener('pointerleave', hide);
            hit.setAttribute('tabindex', '0');
            hit.addEventListener('focus', () => { const r = hit.getBoundingClientRect(); show(r.left + r.width / 2, r.top); });
            hit.addEventListener('blur', hide);
        });
    }

    // ============================================
    // RENDER -- NET CASH FLOW TREND (line, can go negative)
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
        const wrap = document.getElementById('cashrepTrendChart');
        const points = state.trend;

        if (points.length === 0 || points.every(p => p.value === 0)) {
            wrap.innerHTML = `<div class="cashrep-chart-empty"><i class="fa-regular fa-chart-bar" style="font-size:1.6rem; display:block; margin-bottom:8px;"></i>No cash movement in this range.</div>`;
            return;
        }

        const W = 640, H = 260;
        const padL = 50, padR = 16, padT = 16, padB = 34;
        const plotW = W - padL - padR, plotH = H - padT - padB;

        const maxAbs = niceMax(Math.max(...points.map(p => Math.abs(p.value))));
        const stepX = points.length > 1 ? plotW / (points.length - 1) : 0;
        const xAt = i => padL + i * stepX;
        const yAt = v => padT + plotH / 2 - (v / maxAbs) * (plotH / 2);
        const zeroY = yAt(0);

        const gridCount = 4;
        let gridLines = '', gridLabels = '';
        for (let g = -gridCount / 2; g <= gridCount / 2; g++) {
            const v = (maxAbs / (gridCount / 2)) * g;
            const y = yAt(v);
            gridLines += `<line class="cashrep-grid-line" x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}"/>`;
            gridLabels += `<text class="cashrep-axis-label" x="${padL - 8}" y="${y + 3}" text-anchor="end">K${formatCompact(v)}</text>`;
        }

        let xLabels = '';
        const labelEvery = points.length > 20 ? Math.ceil(points.length / 10) : 2;
        points.forEach((p, i) => {
            if (i % labelEvery === 0 || i === points.length - 1) {
                xLabels += `<text class="cashrep-axis-label" x="${xAt(i)}" y="${H - padB + 16}" text-anchor="middle">${p.label}</text>`;
            }
        });

        const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i)} ${yAt(p.value)}`).join(' ');
        const posAreaPath = `${linePath} L ${xAt(points.length - 1)} ${zeroY} L ${xAt(0)} ${zeroY} Z`;

        let hitRects = '';
        points.forEach((p, i) => {
            const left = i === 0 ? padL : (xAt(i - 1) + xAt(i)) / 2;
            const right = i === points.length - 1 ? W - padR : (xAt(i) + xAt(i + 1)) / 2;
            hitRects += `<rect class="cashrep-hit-rect" data-i="${i}" x="${left}" y="${padT}" width="${Math.max(right - left, 1)}" height="${plotH}"/>`;
        });

        wrap.innerHTML = `
            <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily net cash flow">
                ${gridLines}
                <path class="cashrep-area-fill-pos" d="${posAreaPath}"/>
                <line class="cashrep-zero-line" x1="${padL}" y1="${zeroY}" x2="${W - padR}" y2="${zeroY}"/>
                <path class="cashrep-line-path" d="${linePath}"/>
                ${gridLabels}
                ${xLabels}
                <line class="cashrep-crosshair-line" id="cashrepTrendCrosshair" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" style="display:none;"/>
                <circle class="cashrep-crosshair-dot" id="cashrepTrendCrosshairDot" r="5" style="display:none;"/>
                ${hitRects}
            </svg>
        `;

        const svg = wrap.querySelector('svg');
        const crosshair = document.getElementById('cashrepTrendCrosshair');
        const crosshairDot = document.getElementById('cashrepTrendCrosshairDot');
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
            labelEl.className = 'cashrep-tooltip-label';
            labelEl.textContent = p.label;
            const valueEl = document.createElement('div');
            valueEl.className = 'cashrep-tooltip-value';
            valueEl.style.color = p.value >= 0 ? '#34d399' : '#f87171';
            valueEl.textContent = `${p.value >= 0 ? '+' : ''}K${formatNumber(p.value)}`;
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
        svg.querySelectorAll('.cashrep-hit-rect').forEach(rect => {
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
        let tooltip = wrap.querySelector('.cashrep-tooltip');
        if (!tooltip) {
            tooltip = document.createElement('div');
            tooltip.className = 'cashrep-tooltip';
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
        const trs = rows.map(r => `<tr><td>${r.label}</td><td class="cashrep-num">K${formatNumber(r.value)}</td></tr>`).join('');
        return `<table class="cashrep-table-simple"><thead><tr><th>Category</th><th class="cashrep-num">Amount</th></tr></thead><tbody>${trs}</tbody></table>`;
    }
    function buildTrendTable() {
        const trs = state.trend.map(p => `<tr><td>${p.label}</td><td class="cashrep-num" style="color:${p.value >= 0 ? '#059669' : '#dc2626'};">${p.value >= 0 ? '+' : ''}K${formatNumber(p.value)}</td></tr>`).join('');
        return `<table class="cashrep-table-simple"><thead><tr><th>Period</th><th class="cashrep-num">Net Flow</th></tr></thead><tbody>${trs}</tbody></table>`;
    }

    window.toggleCashReportTable = function (which) {
        const ids = {
            in: ['cashrepInChart', 'cashrepInTable', 'cashrepInTableToggle'],
            out: ['cashrepOutChart', 'cashrepOutTable', 'cashrepOutTableToggle'],
            trend: ['cashrepTrendChart', 'cashrepTrendTable', 'cashrepTrendTableToggle']
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
            if (which === 'in') tableWrap.innerHTML = buildBarTable(state.inBySource);
            else if (which === 'out') tableWrap.innerHTML = buildBarTable(state.outByUse);
            else tableWrap.innerHTML = buildTrendTable();
            tableWrap.style.display = '';
            svgWrap.style.display = 'none';
            btn.innerHTML = '<i class="fa-solid fa-chart-line"></i> View as chart';
        }
    };

    // ============================================
    // LEDGER TABLE
    // ============================================

    window.cashReportRenderLedger = function () {
        const filter = document.getElementById('cashrepAccountFilter').value;
        const rows = state.ledger.filter(r => filter === 'ALL' || r.accountCode === filter);
        const body = document.getElementById('cashrepLedgerBody');

        if (rows.length === 0) {
            body.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:30px;color:#94a3b8;">No cash movements in this range.</td></tr>`;
        } else {
            body.innerHTML = rows.map(r => {
                const meta = ACCOUNT_META[r.accountCode];
                return `
                <tr>
                    <td>${r.entryDate}</td>
                    <td><span class="cashrep-badge">${meta.label}</span></td>
                    <td>${r.reference}</td>
                    <td>${r.description}</td>
                    <td>${r.counterName}</td>
                    <td class="cashrep-num" style="color:${r.debit > 0 ? '#059669' : '#cbd5e1'};">${r.debit > 0 ? `+${meta.currency}${formatNumber(r.debit)}` : '-'}</td>
                    <td class="cashrep-num" style="color:${r.credit > 0 ? '#dc2626' : '#cbd5e1'};">${r.credit > 0 ? `-${meta.currency}${formatNumber(r.credit)}` : '-'}</td>
                </tr>`;
            }).join('');
        }

        const countLabel = document.getElementById('cashrepLedgerCount');
        countLabel.textContent = `${rows.length} movement${rows.length === 1 ? '' : 's'}`;
    };

    window.cashReportExportCsv = function () {
        const filter = document.getElementById('cashrepAccountFilter').value;
        const rows = state.ledger.filter(r => filter === 'ALL' || r.accountCode === filter);
        const header = ['Date', 'Account', 'Reference', 'Description', 'From/To', 'Cash In', 'Cash Out'];
        const csvRows = [header.join(',')];
        rows.forEach(r => {
            const meta = ACCOUNT_META[r.accountCode];
            const cells = [
                r.entryDate,
                meta.label,
                r.reference,
                r.description,
                r.counterName,
                r.debit > 0 ? r.debit.toFixed(2) : '',
                r.credit > 0 ? r.credit.toFixed(2) : ''
            ].map(c => `"${String(c).replace(/"/g, '""')}"`);
            csvRows.push(cells.join(','));
        });
        const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `cash-report_${state.from}_to_${state.to}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    // ============================================
    // APPLY / INIT
    // ============================================

    let allRowsCache = null;

    async function renderAll() {
        const from = document.getElementById('cashrepFrom').value;
        const to = document.getElementById('cashrepTo').value;
        state.from = from;
        state.to = to;

        const result = computeForRange(allRowsCache, from, to);
        state.accountTotals = result.accountTotals;
        state.ledger = result.ledger;
        state.inBySource = result.inBySource;
        state.outByUse = result.outByUse;
        state.trend = result.trend;

        document.getElementById('cashrepRangeLabel').textContent =
            `${new Date(from + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} – ${new Date(to + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

        renderAccountCards();
        renderBarChart('cashrepInChart', state.inBySource, 'cashrep-bar-in', 'cash in by source');
        renderBarChart('cashrepOutChart', state.outByUse, 'cashrep-bar-out', 'cash out by use');
        renderTrendChart();
        window.cashReportRenderLedger();

        // Reset any open table views back to chart view on every apply.
        ['in', 'out', 'trend'].forEach(which => {
            const ids = { in: 'cashrepInTable', out: 'cashrepOutTable', trend: 'cashrepTrendTable' };
            const tableEl = document.getElementById(ids[which]);
            if (tableEl && tableEl.style.display !== 'none') {
                window.toggleCashReportTable(which);
                window.toggleCashReportTable(which);
            }
        });
    }

    window.cashReportApply = async function () {
        const btn = document.getElementById('cashrepApplyBtn');
        btn.disabled = true;
        try {
            await renderAll();
        } catch (error) {
            console.error('Error applying Cash Report filter:', error);
        } finally {
            btn.disabled = false;
        }
    };

    (async function init() {
        try {
            const now = new Date();
            const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
            document.getElementById('cashrepFrom').value = dateKey(monthStart);
            document.getElementById('cashrepTo').value = dateKey(now);

            await loadChartOfAccountNames();
            allRowsCache = await loadCashLedger();

            await renderAll();
            console.log("✅ Cash Report initialized successfully!");
        } catch (error) {
            console.error('Error loading Cash Report:', error);
            const wrap = document.getElementById('cashrepAccountCards');
            if (wrap) wrap.innerHTML = `<div class="cashrep-chart-empty">Could not load the Cash Report. Check the console for details.</div>`;
        }
    })();
})();
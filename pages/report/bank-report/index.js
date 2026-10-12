// ============================================
// BANK REPORT -- where bank money came from, where it went
// ============================================
// Same layout as the Cash Report, but for the two bank accounts:
// 1121 (Bank ZMW) and 1120 (Bank USD). Sourced straight from the general
// ledger: every bank movement is a journal_lines row against one of those
// accounts, sitting in a journal_entry alongside a "counterparty" line
// (e.g. a supplier payment is Credit 1121 / Debit 2001 "Accounts Payable";
// a cash deposit shows Cash in Hand as the counterparty). That counterparty
// account answers "where did this money come from / go to".
//
// Cards show Opening / In / Out / Closing for each bank account. The
// Sources / Uses charts and the daily trend cover Bank (ZMW) only -- USD is
// a separate currency and is never mixed into ZMW totals; its movements
// still appear in the Bank Movements list and in the Excel export.
// Cash in Hand is NOT part of this report (see the Cash Report).
// ============================================

(function initBankReport() {
    console.log("Bank Report initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    const CASH_CODES = ['1121', '1120'];   // (name kept from the Cash Report this was cloned from) = the bank accounts
    const ACCOUNT_META = {
        '1121': { label: 'Bank (ZMW)', currency: 'K', accent: '#7c3aed' },
        '1120': { label: 'Bank (USD)', currency: '$', accent: '#0891b2' }
    };
    const ZMW_CODES = ['1121'];
    // Currency symbol for the charts/tables below -- 'K' for Bank (ZMW), '$' when the
    // Account filter is set to Bank (USD). Set in renderAll() on every apply.
    let chartCur = 'K';

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

    // 🔥 PREVENTIVE FIX: PostgREST silently caps any .select() at 1000
    // rows unless you page through it with .range() -- the exact bug that
    // badly under-reported the Sales Report earlier (see fetchSales() in
    // pages/report/sales-report/index.js). Cash ledger volume is small
    // today (a few dozen rows), but it's growing at roughly the same rate
    // as every other ledger-backed report in this app, so it's paginated
    // from day one rather than waiting to get bitten by it later. Every
    // page is ordered by the row's own primary key ('id') -- required
    // because .range() is not guaranteed stable/deterministic otherwise.
    const PAGE_SIZE = 1000;
    async function fetchAllPaginated(queryBuilder) {
        let all = [];
        let from = 0;
        while (true) {
            const { data, error } = await queryBuilder(from, from + PAGE_SIZE - 1);
            if (error) throw error;
            all = all.concat(data || []);
            if (!data || data.length < PAGE_SIZE) break;
            from += PAGE_SIZE;
        }
        return all;
    }

    async function loadBankLedger() {
        // All cash-account lines, ever -- we need the full history anyway
        // to compute a correct Opening Balance for whatever range is
        // selected.
        const cashLines = await fetchAllPaginated((from, to) =>
            supabaseClient
                .from('journal_lines')
                .select('id, journal_entry_id, account_code, description, debit, credit, journal_entries(entry_date, reference, description)')
                .in('account_code', CASH_CODES)
                .order('id')
                .range(from, to)
        );

        const entryIds = [...new Set((cashLines || []).map(l => l.journal_entry_id))];
        let counterpartyByEntry = {};
        if (entryIds.length > 0) {
            const counterLines = await fetchAllPaginated((from, to) =>
                supabaseClient
                    .from('journal_lines')
                    .select('id, journal_entry_id, account_code, debit, credit')
                    .in('journal_entry_id', entryIds)
                    .not('account_code', 'in', `(${CASH_CODES.join(',')})`)
                    .order('id')
                    .range(from, to)
            );
            // 🔥 CHANGED: an entry can have SEVERAL counterparty lines -- a payroll
            // entry, for example, is Net pay (bank) against Gross Salary, PAYE,
            // NAPSA, NHIMA and Employer Contributions lines. Keeping "the first
            // one found" meant each employee's identical net-pay row landed under
            // a different From/To depending on row order (one under PAYE Payable,
            // the next under NAPSA Payable...). Now the counterparty is the line
            // with the LARGEST amount in the entry -- for payroll that is always
            // Gross Salary, so every employee's net pay shows the same From/To,
            // and any other multi-line entry is labelled by its main line.
            const bestAmount = {};
            (counterLines || []).forEach(l => {
                const amt = Math.max(parseFloat(l.debit) || 0, parseFloat(l.credit) || 0);
                if (!(l.journal_entry_id in bestAmount) || amt > bestAmount[l.journal_entry_id]) {
                    bestAmount[l.journal_entry_id] = amt;
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

    function computeForRange(allRows, fromStr, toStr, activeCodes, chartCodes) {
        const inRange = r => r.entryDate >= fromStr && r.entryDate <= toStr;
        const beforeRange = r => r.entryDate < fromStr;

        const accountTotals = {};
        activeCodes.forEach(code => {
            const opening = allRows.filter(r => r.accountCode === code && beforeRange(r))
                .reduce((sum, r) => sum + r.debit - r.credit, 0);
            const rangeRows = allRows.filter(r => r.accountCode === code && inRange(r));
            const cashIn = rangeRows.reduce((sum, r) => sum + r.debit, 0);
            const cashOut = rangeRows.reduce((sum, r) => sum + r.credit, 0);
            accountTotals[code] = { opening, in: cashIn, out: cashOut, closing: opening + cashIn - cashOut };
        });

        const ledger = allRows.filter(r => inRange(r) && activeCodes.includes(r.accountCode)).sort((a, b) => (a.entryDate < b.entryDate ? 1 : -1));

        // Sources / Uses -- the chart account(s) only (Bank ZMW normally, Bank USD when filtered),
        // grouped by the counterparty account name.
        const zmwLedger = ledger.filter(r => chartCodes.includes(r.accountCode));
        const inMap = {}, outMap = {};
        zmwLedger.forEach(r => {
            if (r.debit > 0) inMap[r.counterName] = (inMap[r.counterName] || 0) + r.debit;
            if (r.credit > 0) outMap[r.counterName] = (outMap[r.counterName] || 0) + r.credit;
        });
        const inBySource = Object.entries(inMap).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
        const outByUse = Object.entries(outMap).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);

        // Trend -- net Bank (ZMW) flow, daily if the range is <=31 days,
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
        const wrap = document.getElementById('bankrepAccountCards');
        wrap.innerHTML = CASH_CODES.filter(c => c in state.accountTotals).map(code => {
            const meta = ACCOUNT_META[code];
            const t = state.accountTotals[code] || { opening: 0, in: 0, out: 0, closing: 0 };
            return `
            <div class="bankrep-account-card" style="border-left-color:${meta.accent};">
                <h4>${meta.label}</h4>
                <div class="bankrep-row"><span>Opening</span><span>${meta.currency}${formatNumber(t.opening)}</span></div>
                <div class="bankrep-row bankrep-in"><span>Money In</span><span>+${meta.currency}${formatNumber(t.in)}</span></div>
                <div class="bankrep-row bankrep-out"><span>Money Out</span><span>-${meta.currency}${formatNumber(t.out)}</span></div>
                <div class="bankrep-row bankrep-closing"><span>Closing</span><span>${meta.currency}${formatNumber(t.closing)}</span></div>
            </div>`;
        }).join('');
    }

    // ============================================
    // RENDER -- SOURCES / USES BAR CHARTS
    // ============================================

    function renderBarChart(containerId, rows, barClass, label) {
        const wrap = document.getElementById(containerId);
        if (rows.length === 0) {
            wrap.innerHTML = `<div class="bankrep-chart-empty"><i class="fa-regular fa-chart-bar" style="font-size:1.6rem; display:block; margin-bottom:8px;"></i>No ${label} in this range.</div>`;
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
                <text class="bankrep-bar-label" x="${plotL - 10}" y="${midY + 4}" text-anchor="end">${shortLabel}</text>
                <rect class="${barClass}" data-i="${i}" x="${plotL}" y="${y}" width="${barLen}" height="${barH}" rx="4"/>
                <text class="bankrep-bar-value" x="${plotL + barLen + 8}" y="${midY + 4}">${chartCur}${formatCompact(r.value)}</text>
                <rect class="bankrep-bar-hit" data-i="${i}" x="0" y="${y - gap / 2}" width="${W}" height="${barH + gap}"/>
            `;
        });

        wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}">${bars}</svg>`;

        const svg = wrap.querySelector('svg');
        const tooltip = getOrCreateTooltip(wrap);
        svg.querySelectorAll('.bankrep-bar-hit').forEach(hit => {
            const i = parseInt(hit.dataset.i, 10);
            const bar = svg.querySelector(`.${barClass}[data-i="${i}"]`);
            function show(clientX, clientY) {
                bar.classList.add('bankrep-bar-hover');
                const r = rows[i];
                tooltip.innerHTML = '';
                const labelEl = document.createElement('div');
                labelEl.className = 'bankrep-tooltip-label';
                labelEl.textContent = r.label;
                const valueEl = document.createElement('div');
                valueEl.className = 'bankrep-tooltip-value';
                valueEl.textContent = `${chartCur}${formatNumber(r.value)}`;
                tooltip.appendChild(labelEl);
                tooltip.appendChild(valueEl);
                positionTooltip(tooltip, wrap, clientX, clientY);
                tooltip.classList.add('show');
            }
            function hide() { bar.classList.remove('bankrep-bar-hover'); tooltip.classList.remove('show'); }
            hit.addEventListener('pointermove', (e) => show(e.clientX, e.clientY));
            hit.addEventListener('pointerleave', hide);
            hit.setAttribute('tabindex', '0');
            hit.addEventListener('focus', () => { const r = hit.getBoundingClientRect(); show(r.left + r.width / 2, r.top); });
            hit.addEventListener('blur', hide);
        });
    }

    // ============================================
    // RENDER -- NET BANK FLOW TREND (line, can go negative)
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
        const wrap = document.getElementById('bankrepTrendChart');
        const points = state.trend;

        if (points.length === 0 || points.every(p => p.value === 0)) {
            wrap.innerHTML = `<div class="bankrep-chart-empty"><i class="fa-regular fa-chart-bar" style="font-size:1.6rem; display:block; margin-bottom:8px;"></i>No bank movement in this range.</div>`;
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
            gridLines += `<line class="bankrep-grid-line" x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}"/>`;
            gridLabels += `<text class="bankrep-axis-label" x="${padL - 8}" y="${y + 3}" text-anchor="end">${chartCur}${formatCompact(v)}</text>`;
        }

        let xLabels = '';
        const labelEvery = points.length > 20 ? Math.ceil(points.length / 10) : 2;
        points.forEach((p, i) => {
            if (i % labelEvery === 0 || i === points.length - 1) {
                xLabels += `<text class="bankrep-axis-label" x="${xAt(i)}" y="${H - padB + 16}" text-anchor="middle">${p.label}</text>`;
            }
        });

        const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i)} ${yAt(p.value)}`).join(' ');
        const posAreaPath = `${linePath} L ${xAt(points.length - 1)} ${zeroY} L ${xAt(0)} ${zeroY} Z`;

        let hitRects = '';
        points.forEach((p, i) => {
            const left = i === 0 ? padL : (xAt(i - 1) + xAt(i)) / 2;
            const right = i === points.length - 1 ? W - padR : (xAt(i) + xAt(i + 1)) / 2;
            hitRects += `<rect class="bankrep-hit-rect" data-i="${i}" x="${left}" y="${padT}" width="${Math.max(right - left, 1)}" height="${plotH}"/>`;
        });

        wrap.innerHTML = `
            <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily net bank flow">
                ${gridLines}
                <path class="bankrep-area-fill-pos" d="${posAreaPath}"/>
                <line class="bankrep-zero-line" x1="${padL}" y1="${zeroY}" x2="${W - padR}" y2="${zeroY}"/>
                <path class="bankrep-line-path" d="${linePath}"/>
                ${gridLabels}
                ${xLabels}
                <line class="bankrep-crosshair-line" id="bankrepTrendCrosshair" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" style="display:none;"/>
                <circle class="bankrep-crosshair-dot" id="bankrepTrendCrosshairDot" r="5" style="display:none;"/>
                ${hitRects}
            </svg>
        `;

        const svg = wrap.querySelector('svg');
        const crosshair = document.getElementById('bankrepTrendCrosshair');
        const crosshairDot = document.getElementById('bankrepTrendCrosshairDot');
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
            labelEl.className = 'bankrep-tooltip-label';
            labelEl.textContent = p.label;
            const valueEl = document.createElement('div');
            valueEl.className = 'bankrep-tooltip-value';
            valueEl.style.color = p.value >= 0 ? '#34d399' : '#f87171';
            valueEl.textContent = `${p.value >= 0 ? '+' : ''}${chartCur}${formatNumber(p.value)}`;
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
        svg.querySelectorAll('.bankrep-hit-rect').forEach(rect => {
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
        let tooltip = wrap.querySelector('.bankrep-tooltip');
        if (!tooltip) {
            tooltip = document.createElement('div');
            tooltip.className = 'bankrep-tooltip';
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
        const trs = rows.map(r => `<tr><td>${r.label}</td><td class="bankrep-num">${chartCur}${formatNumber(r.value)}</td></tr>`).join('');
        return `<table class="bankrep-table-simple"><thead><tr><th>Category</th><th class="bankrep-num">Amount</th></tr></thead><tbody>${trs}</tbody></table>`;
    }
    function buildTrendTable() {
        const trs = state.trend.map(p => `<tr><td>${p.label}</td><td class="bankrep-num" style="color:${p.value >= 0 ? '#059669' : '#dc2626'};">${p.value >= 0 ? '+' : ''}${chartCur}${formatNumber(p.value)}</td></tr>`).join('');
        return `<table class="bankrep-table-simple"><thead><tr><th>Period</th><th class="bankrep-num">Net Flow</th></tr></thead><tbody>${trs}</tbody></table>`;
    }

    window.toggleBankReportTable = function (which) {
        const ids = {
            in: ['bankrepInChart', 'bankrepInTable', 'bankrepInTableToggle'],
            out: ['bankrepOutChart', 'bankrepOutTable', 'bankrepOutTableToggle'],
            trend: ['bankrepTrendChart', 'bankrepTrendTable', 'bankrepTrendTableToggle']
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

    window.bankReportRenderLedger = function () {
        const filter = document.getElementById('bankrepAccountFilter').value;
        const rows = state.ledger.filter(r => filter === 'ALL' || r.accountCode === filter);
        const body = document.getElementById('bankrepLedgerBody');

        if (rows.length === 0) {
            body.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:30px;color:#94a3b8;">No bank movements in this range.</td></tr>`;
        } else {
            body.innerHTML = rows.map(r => {
                const meta = ACCOUNT_META[r.accountCode];
                return `
                <tr>
                    <td>${r.entryDate}</td>
                    <td><span class="bankrep-badge">${meta.label}</span></td>
                    <td>${r.reference}</td>
                    <td>${r.description}</td>
                    <td>${r.counterName}</td>
                    <td class="bankrep-num" style="color:${r.debit > 0 ? '#059669' : '#cbd5e1'};">${r.debit > 0 ? `+${meta.currency}${formatNumber(r.debit)}` : '-'}</td>
                    <td class="bankrep-num" style="color:${r.credit > 0 ? '#dc2626' : '#cbd5e1'};">${r.credit > 0 ? `-${meta.currency}${formatNumber(r.credit)}` : '-'}</td>
                </tr>`;
            }).join('');
        }

        const countLabel = document.getElementById('bankrepLedgerCount');
        countLabel.textContent = `${rows.length} movement${rows.length === 1 ? '' : 's'}`;
    };

    // ============================================
    // 🔥 ADDED: EXPORT EXCEL -- the old CSV only held the ledger rows, so
    // it never showed the Opening / In / Out / Closing numbers on
    // the account cards, nor the Sources / Uses charts -- which is why the
    // download and the screen "didn't talk to each other". This workbook
    // carries everything on the page, built from the same state the screen
    // is drawn from, so the two always agree (this replaced the old CSV export):
    //   Summary          -> the three account cards (Opening/In/Out/Closing)
    //   Cash In Sources  -> "Money In By Source" chart (Bank ZMW)
    //   Cash Out Uses    -> "Money Out By Use" chart (Bank ZMW)
    //   Ledger           -> every movement, oldest first, with a running
    //                       balance per account; its last balance for each
    //                       account equals that account's Closing above.
    // Always exports ALL accounts (ignores the ledger's account filter) so
    // the totals tie to the cards.
    // ============================================
    window.bankReportExportExcel = function () {
        if (!window.XLSX || !XLSX.utils) {
            alert('Excel library did not load -- refresh the page and try again.');
            return;
        }
        if (!state.from || !state.to) { alert('Apply a date range first.'); return; }

        try {
            const wb = XLSX.utils.book_new();
            const num = n => Math.round((n || 0) * 100) / 100;

            // Summary
            const summary = [
                ['Bank Report', `${state.from} to ${state.to}`],
                [],
                ['Account', 'Currency', 'Opening', 'Money In', 'Money Out', 'Closing']
            ];
            CASH_CODES.filter(c => c in state.accountTotals).forEach(code => {
                const t = state.accountTotals[code] || { opening: 0, in: 0, out: 0, closing: 0 };
                summary.push([ACCOUNT_META[code].label, code === '1120' ? 'USD' : 'ZMW', num(t.opening), num(t.in), num(t.out), num(t.closing)]);
            });
            const wsSummary = XLSX.utils.aoa_to_sheet(summary);
            wsSummary['!cols'] = [{ wch: 24 }, { wch: 10 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }];
            XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');

            // Sources / Uses (ZMW)
            const srcRows = [['Source (counter account)', `Amount (${chartCur})`]].concat(state.inBySource.map(r => [r.label, num(r.value)]));
            srcRows.push(['Total', num(state.inBySource.reduce((a, r) => a + r.value, 0))]);
            const wsIn = XLSX.utils.aoa_to_sheet(srcRows);
            wsIn['!cols'] = [{ wch: 34 }, { wch: 16 }];
            XLSX.utils.book_append_sheet(wb, wsIn, 'Money In Sources');

            const useRows = [['Use (counter account)', `Amount (${chartCur})`]].concat(state.outByUse.map(r => [r.label, num(r.value)]));
            useRows.push(['Total', num(state.outByUse.reduce((a, r) => a + r.value, 0))]);
            const wsOut = XLSX.utils.aoa_to_sheet(useRows);
            wsOut['!cols'] = [{ wch: 34 }, { wch: 16 }];
            XLSX.utils.book_append_sheet(wb, wsOut, 'Money Out Uses');

            // Ledger, oldest first, running balance per account starting
            // from that account's Opening on the cards.
            const running = {};
            CASH_CODES.filter(c => c in state.accountTotals).forEach(code => { running[code] = (state.accountTotals[code] || {}).opening || 0; });
            const oldestFirst = [...state.ledger].reverse();
            const ledgerRows = [['Date', 'Account', 'Reference', 'Description', 'From/To', 'Money In', 'Money Out', 'Balance After']];
            oldestFirst.forEach(r => {
                running[r.accountCode] += r.debit - r.credit;
                ledgerRows.push([
                    r.entryDate, ACCOUNT_META[r.accountCode].label, r.reference, r.description, r.counterName,
                    r.debit > 0 ? num(r.debit) : '', r.credit > 0 ? num(r.credit) : '', num(running[r.accountCode])
                ]);
            });
            const wsLedger = XLSX.utils.aoa_to_sheet(ledgerRows);
            wsLedger['!cols'] = [{ wch: 12 }, { wch: 20 }, { wch: 26 }, { wch: 60 }, { wch: 28 }, { wch: 14 }, { wch: 14 }, { wch: 16 }];
            XLSX.utils.book_append_sheet(wb, wsLedger, 'Ledger');

            XLSX.writeFile(wb, `Bank_Report_${state.from}_to_${state.to}${document.getElementById('bankrepAccountFilter').value === 'ALL' ? '' : '_' + (document.getElementById('bankrepAccountFilter').value === '1120' ? 'USD' : 'ZMW')}.xlsx`);
        } catch (err) {
            console.error('Bank Report Excel export failed:', err);
            alert('Excel export failed -- check the browser console for details.');
        }
    };

    // ============================================
    // APPLY / INIT
    // ============================================

    let allRowsCache = null;

    async function renderAll() {
        const from = document.getElementById('bankrepFrom').value;
        const to = document.getElementById('bankrepTo').value;
        state.from = from;
        state.to = to;

        // Account filter drives the WHOLE report: cards, charts, trend, ledger, Excel.
        const filter = document.getElementById('bankrepAccountFilter').value;
        const activeCodes = filter === 'ALL' ? CASH_CODES : [filter];
        const chartCodes = filter === 'ALL' ? ZMW_CODES : [filter];
        chartCur = ACCOUNT_META[chartCodes[0]].currency;
        const chartLabel = filter === 'ALL' ? 'Bank (ZMW)' : ACCOUNT_META[filter].label;
        ['bankrepSubIn', 'bankrepSubOut', 'bankrepSubTrend'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.textContent = `${chartLabel} · selected range`;
        });

        const result = computeForRange(allRowsCache, from, to, activeCodes, chartCodes);
        state.accountTotals = result.accountTotals;
        state.ledger = result.ledger;
        state.inBySource = result.inBySource;
        state.outByUse = result.outByUse;
        state.trend = result.trend;

        document.getElementById('bankrepRangeLabel').textContent =
            `${new Date(from + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} – ${new Date(to + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

        renderAccountCards();
        renderBarChart('bankrepInChart', state.inBySource, 'bankrep-bar-in', 'money in by source');
        renderBarChart('bankrepOutChart', state.outByUse, 'bankrep-bar-out', 'money out by use');
        renderTrendChart();
        window.bankReportRenderLedger();

        // Reset any open table views back to chart view on every apply.
        ['in', 'out', 'trend'].forEach(which => {
            const ids = { in: 'bankrepInTable', out: 'bankrepOutTable', trend: 'bankrepTrendTable' };
            const tableEl = document.getElementById(ids[which]);
            if (tableEl && tableEl.style.display !== 'none') {
                window.toggleBankReportTable(which);
                window.toggleBankReportTable(which);
            }
        });
    }

    window.bankReportApply = async function () {
        const btn = document.getElementById('bankrepApplyBtn');
        btn.disabled = true;
        try {
            await renderAll();
        } catch (error) {
            console.error('Error applying Bank Report filter:', error);
        } finally {
            btn.disabled = false;
        }
    };

    (async function init() {
        try {
            const now = new Date();
            const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
            document.getElementById('bankrepFrom').value = dateKey(monthStart);
            document.getElementById('bankrepTo').value = dateKey(now);

            await loadChartOfAccountNames();
            allRowsCache = await loadBankLedger();

            await renderAll();
            console.log("✅ Bank Report initialized successfully!");
        } catch (error) {
            console.error('Error loading Bank Report:', error);
            const wrap = document.getElementById('bankrepAccountCards');
            if (wrap) wrap.innerHTML = `<div class="bankrep-chart-empty">Could not load the Bank Report. Check the console for details.</div>`;
        }
    })();
})();
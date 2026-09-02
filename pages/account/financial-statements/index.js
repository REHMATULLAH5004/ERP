// ============================================
// FINANCIAL STATEMENTS MODULE - FULLY DYNAMIC (ZMW / COA / GL)
// ============================================

(async function initFinancialStatements() {
    console.log("📊 Financial Statements initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    // ============================================
    // GLOBAL STATE
    // ============================================
    const state = {
        accounts: [],
        journalLines: [],
        accountBalances: {},
        currentReportType: 'income-statement',
        currentPeriod: 'month',
        startDate: '',
        endDate: ''
    };

    // ============================================
    // CURRENCY SETTINGS (ZMW)
    // ============================================
    const CURRENCY = {
        symbol: 'K',
        code: 'ZMW',
        locale: 'en-ZM',
        minFraction: 2,
        maxFraction: 2
    };

    // ============================================
    // LOAD DATA
    // ============================================

    async function loadAccounts() {
        try {
            const { data, error } = await supabaseClient
                .from('chart_of_accounts')
                .select('*')
                .order('code', { ascending: true });

            if (error) throw error;
            state.accounts = data || [];
            return state.accounts;
        } catch (error) {
            console.error('Error loading accounts:', error);
            state.accounts = [];
            return [];
        }
    }

    async function loadJournalLines() {
        try {
            // 🔥 FIX: this used to be a single unpaginated fetch -- Supabase
            // (PostgREST) silently caps any query with no .range() at its
            // default max-rows setting (1000 here) and returns THAT MANY
            // rows with no error, no warning, nothing to indicate anything
            // was cut off. Confirmed against real data: this project has
            // 1250+ Posted journal_lines, so the old query was quietly
            // dropping ~250 of them -- and because Postgres has no
            // guaranteed row order without an ORDER BY, the rows that got
            // cut were effectively the most RECENTLY inserted ones (i.e.
            // today's), not some random/old subset. That's exactly why
            // Total Revenue on the Income Statement came out far short of
            // the real total for a period that included today: today's
            // NHIMA/Regular sales entries were the ones silently missing
            // from state.journalLines before every report's date filter
            // even got a chance to run. Fixed by paging through in batches
            // of 1000 until a page comes back short, so this always loads
            // every Posted line regardless of how large the ledger grows.
            const PAGE_SIZE = 1000;
            let allLines = [];
            let offset = 0;

            while (true) {
                const { data, error } = await supabaseClient
                    .from('journal_lines')
                    .select(`
                        id,
                        account_code,
                        debit,
                        credit,
                        description,
                        journal_entries!inner (
                            entry_date,
                            journal_number,
                            status
                        )
                    `)
                    .eq('journal_entries.status', 'Posted')
                    .range(offset, offset + PAGE_SIZE - 1);

                if (error) throw error;

                allLines = allLines.concat(data || []);

                if (!data || data.length < PAGE_SIZE) break;
                offset += PAGE_SIZE;
            }

            state.journalLines = allLines;
            return state.journalLines;
        } catch (error) {
            console.error('Error loading journal lines:', error);
            state.journalLines = [];
            return [];
        }
    }

    // ============================================
    // CALCULATE PERIOD BALANCES
    // ============================================

    async function calculateAccountBalances(startDate, endDate) {
        const balances = {};
        
        // 1. Initialize all accounts
        state.accounts.forEach(acc => {
            balances[acc.code] = { 
                ...acc, 
                period_debit: 0, 
                period_credit: 0,
                net_balance: 0
            };
        });

        // 2. Convert the Input Dates to Timestamps
        const start = new Date(startDate + 'T00:00:00').getTime();
        const end = new Date(endDate + 'T23:59:59').getTime();

        // 3. Filter using Timestamp Math
        let filteredLines = state.journalLines.filter(l => {
            let entryDate = l.entry_date || l.journal_entries?.entry_date;
            if (!entryDate) return false;
            const entryTime = new Date(entryDate).getTime();
            return entryTime >= start && entryTime <= end;
        });

        // 4. Sum debits and credits
        filteredLines.forEach(line => {
            if (balances[line.account_code]) {
                balances[line.account_code].period_debit += line.debit || 0;
                balances[line.account_code].period_credit += line.credit || 0;
            }
        });

        // 🔥 FIX (revised): an earlier version of this fix multiplied
        // 1120's period_debit/period_credit by today's rate before
        // net_balance was computed -- confirmed against real data that
        // this broke Balance Sheet's "Assets = Liabilities + Equity"
        // check, for the same reason as Trial Balance (see that file's
        // comment): 1120's balance was built up across transactions each
        // originally paired against a ZMW account at whatever rate
        // applied that day, so multiplying the accumulated total by
        // TODAY's single rate no longer matches and the two stop
        // cancelling out. Left raw here (this is what keeps
        // net_balance -- and everything downstream that reads it --
        // mathematically correct); usdRate is stashed on the balance
        // entry purely so the Balance Sheet/Cash Flow renderers can
        // LABEL 1120 with its approximate ZMW-equivalent, never to
        // change what's summed.
        if (balances['1120']) {
            balances['1120'].usd_rate_for_display = await getSharedExchangeRate();
        }

        // 5. Calculate Net Balance exactly like Trial Balance
        Object.keys(balances).forEach(code => {
            const acc = balances[code];
            const rawBal = acc.period_debit - acc.period_credit;
            if (acc.normal_balance === 'Debit') {
                acc.net_balance = rawBal; 
            } else {
                acc.net_balance = acc.period_credit - acc.period_debit;
            }
        });

        state.accountBalances = balances;
        return balances;
    }

    // ============================================
    // 🔥 SHARED: what counts as "revenue-like" for these reports.
    // Revenue (sales) and Income (gains / other income, e.g. an
    // inventory adjustment gain) are both credit-normal accounts that
    // belong in Net Income -- treating only 'Revenue' as real revenue
    // meant any 'Income'-type account silently vanished from every
    // report that used to duplicate this check separately (Income
    // Statement, Balance Sheet's Net Income calc, Retained Earnings).
    // Extracted once here so those three can never drift apart again.
    // ============================================
    function isRevenueType(account) {
        return account.type === 'Revenue' || account.type === 'Income';
    }

    // ============================================
    // DATE RANGE HELPERS
    // ============================================

    function getDateRange(period) {
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth();
        const today = now.toISOString().split('T')[0];

        let startDate, endDate;

        switch (period) {
            case 'month':
                startDate = new Date(year, month, 1).toISOString().split('T')[0];
                endDate = today;
                break;
            case 'quarter':
                const quarterMonth = Math.floor(month / 3) * 3;
                startDate = new Date(year, quarterMonth, 1).toISOString().split('T')[0];
                endDate = today;
                break;
            case 'year':
                startDate = new Date(year, 0, 1).toISOString().split('T')[0];
                endDate = today;
                break;
            case 'custom':
                startDate = document.getElementById('fsStartDate').value || today;
                endDate = document.getElementById('fsEndDate').value || today;
                break;
            default:
                startDate = new Date(year, month, 1).toISOString().split('T')[0];
                endDate = today;
        }

        return { startDate, endDate };
    }

    // ============================================
    // INCOME STATEMENT (ALREADY WORKING, UNTOUCHED)
    // ============================================

    function generateIncomeStatement(startDate, endDate) {
        const balances = state.accountBalances;
        const revenueAccounts = state.accounts.filter(a => isRevenueType(a) && (balances[a.code]?.period_credit || 0) > 0.01);
        const expenseAccounts = state.accounts.filter(a => a.type === 'Expense' && (balances[a.code]?.period_debit || 0) > 0.01);
        const cogsAccounts = expenseAccounts.filter(a => a.name.toLowerCase().includes('cogs') || a.name.toLowerCase().includes('cost of goods') || a.name.toLowerCase().includes('cost of sales'));
        const operatingExpenses = expenseAccounts.filter(a => !cogsAccounts.includes(a));

        const totalRevenue = revenueAccounts.reduce((sum, a) => sum + (balances[a.code]?.period_credit || 0), 0);
        const totalCogs = cogsAccounts.reduce((sum, a) => sum + (balances[a.code]?.period_debit || 0), 0);
        const totalExpenses = operatingExpenses.reduce((sum, a) => sum + (balances[a.code]?.period_debit || 0), 0);
        const grossProfit = totalRevenue - totalCogs;
        const netIncome = grossProfit - totalExpenses;

        return `
            <div class="fs-report" id="fsReportContent">
                <div class="fs-report-header">
                    <h2>Income Statement (Profit & Loss)</h2>
                    <p>For the period ${formatDate(startDate)} to ${formatDate(endDate)}</p>
                </div>
                <div class="fs-section">
                    <div class="fs-section-title">Revenue</div>
                    ${revenueAccounts.map(a => `<div class="fs-row"><span>${a.code} - ${a.name}</span><span class="amount positive">${formatCurrency(balances[a.code]?.period_credit || 0)}</span></div>`).join('') || '<div class="fs-row"><span>No revenue recorded</span><span class="amount">K0.00</span></div>'}
                    <div class="fs-total"><span>Total Revenue</span><span class="amount positive">${formatCurrency(totalRevenue)}</span></div>
                </div>
                <div class="fs-section">
                    <div class="fs-section-title">Cost of Goods Sold</div>
                    ${cogsAccounts.map(a => `<div class="fs-row"><span>${a.code} - ${a.name}</span><span class="amount negative">(${formatCurrency(balances[a.code]?.period_debit || 0)})</span></div>`).join('') || '<div class="fs-row"><span>No COGS recorded</span><span class="amount">K0.00</span></div>'}
                    <div class="fs-subtotal"><span>Total COGS</span><span class="amount negative">(${formatCurrency(totalCogs)})</span></div>
                </div>
                <div class="fs-subtotal" style="background: #eff6ff; border: none;">
                    <span style="font-weight: 700; font-size: 1rem;">Gross Profit</span>
                    <span style="font-weight: 700; font-size: 1rem; color: ${grossProfit >= 0 ? '#15803d' : '#dc2626'};">${formatCurrency(grossProfit)}</span>
                </div>
                <div class="fs-section" style="margin-top: 25px;">
                    <div class="fs-section-title">Operating Expenses</div>
                    ${operatingExpenses.map(a => `<div class="fs-row"><span>${a.code} - ${a.name}</span><span class="amount negative">(${formatCurrency(balances[a.code]?.period_debit || 0)})</span></div>`).join('') || '<div class="fs-row"><span>No expenses recorded</span><span class="amount">K0.00</span></div>'}
                    <div class="fs-subtotal"><span>Total Operating Expenses</span><span class="amount negative">(${formatCurrency(totalExpenses)})</span></div>
                </div>
                <div class="fs-total" style="border-top: 3px double #0f172a; padding-top: 15px; margin-top: 15px;">
                    <span style="font-size: 1.2rem; font-weight: 700;">Net Income ${netIncome >= 0 ? '(Profit)' : '(Loss)'}</span>
                    <span style="font-size: 1.3rem; font-weight: 700; color: ${netIncome >= 0 ? '#15803d' : '#dc2626'};">${formatCurrency(netIncome)}</span>
                </div>
                <div class="fs-footer"><p>Generated on ${new Date().toLocaleString()}</p></div>
            </div>
        `;
    }

        // ============================================
    // BALANCE SHEET (FIXED - SHOWING NET INCOME)
    // ============================================

    function generateBalanceSheet(startDate, endDate) {
        const balances = state.accountBalances;
        
        // 1. Filter accounts. For Balance Sheet, we must use net_balance
        const assetAccounts = state.accounts.filter(a => a.type === 'Asset' && Math.abs(balances[a.code]?.net_balance || 0) > 0.01);
        const liabilityAccounts = state.accounts.filter(a => a.type === 'Liability' && Math.abs(balances[a.code]?.net_balance || 0) > 0.01);
        const equityAccounts = state.accounts.filter(a => a.type === 'Equity' && Math.abs(balances[a.code]?.net_balance || 0) > 0.01);

        // 2a. Calculate Net Income to add to Equity
        const totalRevenue = state.accounts.filter(a => isRevenueType(a)).reduce((sum, a) => sum + (balances[a.code]?.period_credit || 0), 0);
        const totalExpenses = state.accounts.filter(a => a.type === 'Expense').reduce((sum, a) => sum + (balances[a.code]?.period_debit || 0), 0);
        const netIncome = totalRevenue - totalExpenses;

        // 2b. Add Net Income to the display list (so the user sees it!)
        if (netIncome !== 0) {
            equityAccounts.push({
                code: '---',
                name: 'Current Period Net Income (Profit)',
                net_balance: netIncome
            });
        }

        // 3. Calculate Totals based on Net Balances
        const totalAssets = assetAccounts.reduce((sum, a) => sum + (balances[a.code]?.net_balance || 0), 0);
        const totalLiabilities = liabilityAccounts.reduce((sum, a) => sum + (balances[a.code]?.net_balance || 0), 0);
        
        // We calculate totalEquity from the ORIGINAL accounts + our added NetIncome
        const originalEquityBalance = state.accounts.filter(a => a.type === 'Equity').reduce((sum, a) => sum + (balances[a.code]?.net_balance || 0), 0);
        const totalEquity = originalEquityBalance + netIncome;
        
        const totalLiabilitiesEquity = totalLiabilities + totalEquity;
        const isBalanced = Math.abs(totalAssets - totalLiabilitiesEquity) < 0.01;

        return `
            <div class="fs-report" id="fsReportContent">
                <div class="fs-report-header">
                    <h2>Balance Sheet</h2>
                    <p>As of ${formatDate(endDate)}</p>
                </div>
                <div class="fs-balance-sheet-grid">
                    <div>
                        <div class="fs-section-title" style="color: #2563eb;">ASSETS</div>
                        ${assetAccounts.map(a => {
                            // 🔥 1120 (Bank - USD) is the one Asset account whose
                            // net_balance is raw dollars, not ZMW like every other
                            // row -- label it clearly and show its approximate
                            // ZMW-equivalent, without changing the number that
                            // actually feeds Total Assets (see calculateAccountBalances).
                            const isUsd = a.code === '1120';
                            const bal = balances[a.code]?.net_balance || 0;
                            const rate = balances[a.code]?.usd_rate_for_display;
                            const label = isUsd ? `${a.code} - ${a.name} (USD, raw dollars${rate ? `, ≈K${(bal * rate).toFixed(2)} today` : ''})` : `${a.code} - ${a.name}`;
                            const amountDisplay = isUsd
                                ? `${bal < 0 ? '-' : ''}$${Math.abs(bal).toFixed(2)}`
                                : formatSignedCurrency(bal);
                            return `<div class="fs-row"><span>${label}</span><span class="amount ${bal < 0 ? 'negative' : 'positive'}">${amountDisplay}</span></div>`;
                        }).join('') || '<div class="fs-row"><span>No assets recorded</span><span class="amount">K0.00</span></div>'}
                        <div class="fs-total" style="border-color: #2563eb;"><span>Total Assets</span><span style="color: ${totalAssets < 0 ? '#dc2626' : '#2563eb'};">${formatSignedCurrency(totalAssets)}</span></div>
                    </div>
                    <div>
                        <div class="fs-section-title" style="color: #f59e0b;">LIABILITIES</div>
                        ${liabilityAccounts.map(a => `<div class="fs-row"><span>${a.code} - ${a.name}</span><span class="amount ${(balances[a.code]?.net_balance || 0) < 0 ? 'negative' : 'positive'}">${formatSignedCurrency(balances[a.code]?.net_balance || 0)}</span></div>`).join('') || '<div class="fs-row"><span>No liabilities recorded</span><span class="amount">K0.00</span></div>'}
                        <div class="fs-subtotal" style="border-color: #f59e0b;"><span>Total Liabilities</span><span style="color: ${totalLiabilities < 0 ? '#dc2626' : '#f59e0b'};">${formatSignedCurrency(totalLiabilities)}</span></div>
                        
                        <div class="fs-section-title" style="color: #8b5cf6; margin-top: 20px;">EQUITY</div>
                        ${equityAccounts.map(a => {
                            if (a.code === '---') {
                                // Special formatting for the calculated Net Income
                                return `<div class="fs-row" style="font-style: italic; color: #475569;"><span>${a.name}</span><span class="amount ${a.net_balance < 0 ? 'negative' : 'positive'}">${formatSignedCurrency(a.net_balance)}</span></div>`;
                            }
                            return `<div class="fs-row"><span>${a.code} - ${a.name}</span><span class="amount ${(balances[a.code]?.net_balance || 0) < 0 ? 'negative' : 'positive'}">${formatSignedCurrency(balances[a.code]?.net_balance || 0)}</span></div>`;
                        }).join('') || '<div class="fs-row"><span>No equity recorded</span><span class="amount">K0.00</span></div>'}
                        
                        <div class="fs-subtotal" style="border-color: #8b5cf6;"><span>Total Equity</span><span style="color: ${totalEquity < 0 ? '#dc2626' : '#8b5cf6'};">${formatSignedCurrency(totalEquity)}</span></div>
                        
                        <div class="fs-total" style="border-color: #0f172a;"><span>Total Liabilities + Equity</span><span style="color: #0f172a;">${formatSignedCurrency(totalLiabilitiesEquity)}</span></div>
                    </div>
                </div>
                <div style="margin-top: 20px; padding: 12px; background: ${isBalanced ? '#dcfce7' : '#fee2e2'}; border-radius: 6px; text-align: center; color: ${isBalanced ? '#15803d' : '#dc2626'}; font-weight: 600;">
                    ${isBalanced ? '✅ Balance Sheet is Balanced! (Assets = Liabilities + Equity)' : '⚠️ Balance Sheet is NOT Balanced! Please check your entries.'}
                </div>
                <div class="fs-footer"><p>Generated on ${new Date().toLocaleString()}</p></div>
            </div>
        `;
    }

    // ============================================
    // RETAINED EARNINGS (BRAND NEW & DYNAMIC)
    // ============================================

    function generateRetainedEarningsStatement(startDate, endDate) {
        const balances = state.accountBalances;
        
        // 1. Get Net Income from the current period (reuse P&L logic)
        const totalRevenue = state.accounts.filter(a => isRevenueType(a)).reduce((sum, a) => sum + (balances[a.code]?.period_credit || 0), 0);
        const totalExpenses = state.accounts.filter(a => a.type === 'Expense').reduce((sum, a) => sum + (balances[a.code]?.period_debit || 0), 0);
        const currentNetIncome = totalRevenue - totalExpenses;

        // 2. Find Retained Earnings account (Type Equity, Name contains Retained or code 32xx)
        let retainedEarningsAccount = state.accounts.find(a => a.type === 'Equity' && (a.name.toLowerCase().includes('retained') || a.code.startsWith('32')));
        const retainedEarningsBalance = retainedEarningsAccount ? (balances[retainedEarningsAccount.code]?.net_balance || 0) : 0;

        // 3. Find Dividends account (Type Equity, Name contains Dividends)
        let dividendsAccount = state.accounts.find(a => a.type === 'Equity' && a.name.toLowerCase().includes('dividend'));
        const dividendsPaid = dividendsAccount ? Math.abs(balances[dividendsAccount.code]?.period_debit || 0) : 0;

        const endingRetainedEarnings = retainedEarningsBalance + currentNetIncome - dividendsPaid;

        return `
            <div class="fs-report" id="fsReportContent">
                <div class="fs-report-header">
                    <h2>Statement of Retained Earnings</h2>
                    <p>For the period ${formatDate(startDate)} to ${formatDate(endDate)}</p>
                </div>
                <div class="fs-section">
                    <div class="fs-row">
                        <span>Retained Earnings - Beginning</span>
                        <span class="amount positive">${formatCurrency(retainedEarningsBalance)}</span>
                    </div>
                    <div class="fs-row">
                        <span>Add: Current Year Net Income</span>
                        <span class="amount ${currentNetIncome >= 0 ? 'positive' : 'negative'}">${formatCurrency(currentNetIncome)}</span>
                    </div>
                    ${dividendsPaid > 0 ? `
                        <div class="fs-row">
                            <span>Less: Dividends Paid</span>
                            <span class="amount negative">(${formatCurrency(dividendsPaid)})</span>
                        </div>
                    ` : ''}
                    <div class="fs-total" style="border-top: 3px double #0f172a; padding-top: 15px; margin-top: 15px;">
                        <span style="font-size: 1.2rem; font-weight: 700;">Retained Earnings - Ending</span>
                        <span style="font-size: 1.3rem; font-weight: 700; color: ${endingRetainedEarnings >= 0 ? '#15803d' : '#dc2626'};">${formatCurrency(endingRetainedEarnings)}</span>
                    </div>
                </div>
                <div class="fs-footer"><p>Generated on ${new Date().toLocaleString()}</p></div>
            </div>
        `;
    }

    // ============================================
    // CASH FLOW STATEMENT (CLEANER FORMATTING)
    // ============================================

    function generateCashFlowStatement(startDate, endDate) {
        const balances = state.accountBalances;
        
        // 1. Get Net Income from current period
        const totalRevenue = state.accounts.filter(a => isRevenueType(a)).reduce((sum, a) => sum + (balances[a.code]?.period_credit || 0), 0);
        const totalExpenses = state.accounts.filter(a => a.type === 'Expense').reduce((sum, a) => sum + (balances[a.code]?.period_debit || 0), 0);
        const netIncome = totalRevenue - totalExpenses;

        // 2. Add back non-cash expenses (Depreciation)
        const depreciationAccounts = state.accounts.filter(a => a.type === 'Expense' && (a.name.toLowerCase().includes('depreciation') || a.name.toLowerCase().includes('amortization')));
        const depreciation = depreciationAccounts.reduce((sum, a) => sum + (balances[a.code]?.period_debit || 0), 0);

        // 3. Changes in Working Capital (Simplified)
        const arAccounts = state.accounts.filter(a => a.type === 'Asset' && (a.name.toLowerCase().includes('receivable') || a.name.toLowerCase().includes('receivables')));
        const apAccounts = state.accounts.filter(a => a.type === 'Liability' && a.name.toLowerCase().includes('payable'));
        
        const changeInAR = arAccounts.reduce((sum, a) => sum + (balances[a.code]?.period_debit || 0), 0);
        const changeInAP = apAccounts.reduce((sum, a) => sum + (balances[a.code]?.period_credit || 0), 0);

        const operatingCashFlow = netIncome + depreciation - changeInAR + changeInAP;

        // 4. Investing (Fixed Assets) & Financing (Loans & Equity)
        const fixedAssetAccounts = state.accounts.filter(a => a.type === 'Asset' && (a.category === 'Fixed' || a.name.toLowerCase().includes('fixed')));
        const investingCashFlow = -fixedAssetAccounts.reduce((sum, a) => sum + (balances[a.code]?.period_debit || 0), 0);

        const loanAccounts = state.accounts.filter(a => a.type === 'Liability' && a.name.toLowerCase().includes('loan'));
        const equityAccounts = state.accounts.filter(a => a.type === 'Equity' && !a.name.toLowerCase().includes('retained'));
        const financingCashFlow = loanAccounts.reduce((sum, a) => sum + (balances[a.code]?.period_credit || 0), 0) + equityAccounts.reduce((sum, a) => sum + (balances[a.code]?.period_credit || 0), 0);

        const netCashFlow = operatingCashFlow + investingCashFlow + financingCashFlow;

        // 5. Ending Cash
        const cashAccounts = state.accounts.filter(a => a.type === 'Asset' && (a.name.toLowerCase().includes('cash') || a.name.toLowerCase().includes('bank') || a.code.startsWith('11')));
        const endingCash = cashAccounts.reduce((sum, a) => sum + (balances[a.code]?.net_balance || 0), 0);

        return `
            <div class="fs-report" id="fsReportContent">
                <div class="fs-report-header">
                    <h2>Cash Flow Statement</h2>
                    <p>For the period ${formatDate(startDate)} to ${formatDate(endDate)}</p>
                </div>
                <div class="fs-section">
                    <div class="fs-section-title">Cash Flows from Operating Activities</div>
                    <div class="fs-row"><span>Net Income</span><span class="amount ${netIncome >= 0 ? 'positive' : 'negative'}">${formatCurrency(netIncome)}</span></div>
                    ${depreciation > 0 ? `<div class="fs-row"><span>Depreciation (non-cash)</span><span class="amount positive">${formatCurrency(depreciation)}</span></div>` : ''}
                    <div class="fs-row" style="padding-left: 20px;"><span>Change in Accounts Receivable</span><span class="amount negative">(${formatCurrency(changeInAR)})</span></div>
                    <div class="fs-row" style="padding-left: 20px;"><span>Change in Accounts Payable</span><span class="amount positive">${formatCurrency(changeInAP)}</span></div>
                    <div class="fs-subtotal"><span>Net Cash from Operating Activities</span><span class="amount ${operatingCashFlow >= 0 ? 'positive' : 'negative'}">${formatCurrency(operatingCashFlow)}</span></div>
                </div>
                <div class="fs-section">
                    <div class="fs-section-title">Cash Flows from Investing Activities</div>
                    <div class="fs-row"><span>Purchase of Fixed Assets</span><span class="amount negative">(${formatCurrency(Math.abs(investingCashFlow))})</span></div>
                    <div class="fs-subtotal"><span>Net Cash from Investing Activities</span><span class="amount ${investingCashFlow >= 0 ? 'positive' : 'negative'}">${formatCurrency(investingCashFlow)}</span></div>
                </div>
                <div class="fs-section">
                    <div class="fs-section-title">Cash Flows from Financing Activities</div>
                    <div class="fs-row"><span>Borrowings / Capital Contributions</span><span class="amount ${financingCashFlow >= 0 ? 'positive' : 'negative'}">${formatCurrency(financingCashFlow)}</span></div>
                    <div class="fs-subtotal"><span>Net Cash from Financing Activities</span><span class="amount ${financingCashFlow >= 0 ? 'positive' : 'negative'}">${formatCurrency(financingCashFlow)}</span></div>
                </div>
                <div class="fs-total" style="border-top: 3px double #0f172a; padding-top: 15px; margin-top: 15px;">
                    <span style="font-size: 1.2rem; font-weight: 700;">Net Increase in Cash</span>
                    <span style="font-size: 1.3rem; font-weight: 700; color: ${netCashFlow >= 0 ? '#15803d' : '#dc2626'};">${formatCurrency(netCashFlow)}</span>
                </div>
                <div class="fs-subtotal" style="border: none; background: none; margin-top: 10px;">
                    <span>Cash Balance at End of Period</span>
                    <span style="font-weight: 700; color: #2563eb;">${formatCurrency(endingCash)}</span>
                </div>
                ${balances['1120'] && Math.abs(balances['1120'].net_balance) > 0.01 ? `
                <div class="fs-footer" style="color: #94a3b8; font-size: 0.75rem;">
                    <p>Note: includes Bank - USD's raw dollar balance ($${balances['1120'].net_balance.toFixed(2)}) added in as-is, not converted to ZMW -- see Balance Sheet or Cash & Bank for its ZMW-equivalent at today's rate.</p>
                </div>` : ''}
                <div class="fs-footer"><p>Generated on ${new Date().toLocaleString()}</p></div>
            </div>
        `;
    }

    // ============================================
    // MAIN LOAD FUNCTION
    // ============================================

    async function loadFinancialStatement() {
        const reportType = document.getElementById('fsReportType').value;
        const period = document.getElementById('fsPeriodSelect').value;
        
        const customRange = document.getElementById('customDateRange');
        const customRangeEnd = document.getElementById('customDateRangeEnd');
        if (period === 'custom') {
            customRange.style.display = 'flex';
            customRangeEnd.style.display = 'flex';
            if (!document.getElementById('fsStartDate').value) {
                const now = new Date();
                const monthAgo = new Date(now);
                monthAgo.setMonth(monthAgo.getMonth() - 1);
                document.getElementById('fsStartDate').value = monthAgo.toISOString().split('T')[0];
                document.getElementById('fsEndDate').value = now.toISOString().split('T')[0];
            }
        } else {
            customRange.style.display = 'none';
            customRangeEnd.style.display = 'none';
        }

        const { startDate, endDate } = getDateRange(period);
        state.startDate = startDate;
        state.endDate = endDate;

        // 🔥 FIX: this used to call calculateAccountBalances() without
        // awaiting it -- now that it fetches the shared exchange rate
        // (see above), the report generator functions right below would
        // have started reading state.accountBalances before that promise
        // resolved, rendering against whatever was left over from the
        // PREVIOUS calculation (or nothing, on first load).
        await calculateAccountBalances(startDate, endDate);

        let html = '';
        switch (reportType) {
            case 'income-statement':
                html = generateIncomeStatement(startDate, endDate);
                break;
            case 'balance-sheet':
                html = generateBalanceSheet(startDate, endDate);
                break;
            case 'cash-flow':
                html = generateCashFlowStatement(startDate, endDate);
                break;
            case 'retained-earnings':
                html = generateRetainedEarningsStatement(startDate, endDate);
                break;
            default:
                html = generateIncomeStatement(startDate, endDate);
        }

        document.getElementById('fsReportContainer').innerHTML = html;
        document.getElementById('fsPeriod').textContent = `${formatDate(startDate)} to ${formatDate(endDate)}`;
    }

    // ============================================
    // REFRESH & EXPORT
    // ============================================

    async function refreshFinancialStatements() {
        await loadAccounts();
        await loadJournalLines();
        await loadFinancialStatement();
    }

    function exportFinancialStatement() {
        const content = document.getElementById('fsReportContent');
        if (!content) {
            showToast('No report to export', 'error');
            return;
        }

        const printWindow = window.open('', '_blank', 'width=900,height=700');
        if (!printWindow) {
            showToast('Please allow popups to print', 'error');
            return;
        }

        const styles = document.querySelector('style').innerHTML;

        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Financial Statement</title>
                <style>${styles}</style>
                <style>
                    body { background: white; padding: 20px; }
                    .fs-report { border: none; box-shadow: none; padding: 10px; }
                    .fs-header-actions, .fs-filters, .btn { display: none !important; }
                    .fs-report-header { border-bottom: 1px solid #333 !important; }
                    .fs-total { border-top: 2px solid #333 !important; }
                    .fs-subtotal { background: #f5f5f5 !important; }
                </style>
            </head>
            <body>
                ${content.outerHTML}
                <script>
                    window.onload = function() {
                        window.print();
                    };
                <\/script>
            </body>
            </html>
        `);
        printWindow.document.close();
        setTimeout(() => printWindow.focus(), 500);
    }

    // ============================================
    // UTILITY FUNCTIONS
    // ============================================

    function formatCurrency(amount) {
        if (amount === 0 || amount === undefined || amount === null) {
            return 'K0.00';
        }
        return `K${Math.abs(amount).toFixed(CURRENCY.minFraction)}`;
    }

    // 🔥 ADDED: formatCurrency() above always shows the absolute value --
    // fine for places that already wrap it in their own parens for a
    // known-negative context (e.g. "(${formatCurrency(totalCogs)})"), but
    // wrong for Balance Sheet asset/liability/equity rows, where a
    // genuinely negative balance needs to actually LOOK negative. Silently
    // flipping it positive was hiding a real discrepancy in the books
    // instead of surfacing it -- exactly why the per-line amounts didn't
    // visibly add up to the totals shown.
    function formatSignedCurrency(amount) {
        if (amount === 0 || amount === undefined || amount === null) {
            return 'K0.00';
        }
        const magnitude = `K${Math.abs(amount).toFixed(CURRENCY.minFraction)}`;
        return amount < 0 ? `-${magnitude}` : magnitude;
    }

    function formatDate(dateStr) {
        if (!dateStr) return '-';
        try {
            const d = new Date(dateStr);
            return d.toLocaleDateString('en-ZM', { month: 'short', day: 'numeric', year: 'numeric' });
        } catch {
            return dateStr;
        }
    }

    function showToast(message, type = 'success') {
        const existing = document.querySelector('#customToast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.id = 'customToast';
        const bgColor = type === 'success' ? '#059669' : type === 'error' ? '#dc2626' : '#f59e0b';
        toast.style.cssText = `
            position: fixed; top: 20px; right: 20px; 
            padding: 16px 24px; border-radius: 8px; 
            color: white; font-weight: 500; z-index: 9999;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            animation: slideIn 0.3s ease;
            background: ${bgColor};
            max-width: 400px;
        `;
        toast.textContent = message;
        document.body.appendChild(toast);

        setTimeout(() => {
            toast.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // ============================================
    // EVENT LISTENERS & INITIALIZE
    // ============================================

    function setupEventListeners() {
        document.getElementById('fsPeriodSelect').addEventListener('change', function() {
            const customRange = document.getElementById('customDateRange');
            const customRangeEnd = document.getElementById('customDateRangeEnd');
            if (this.value === 'custom') {
                customRange.style.display = 'flex';
                customRangeEnd.style.display = 'flex';
            } else {
                customRange.style.display = 'none';
                customRangeEnd.style.display = 'none';
            }
        });
    }

    window.loadFinancialStatement = loadFinancialStatement;
    window.refreshFinancialStatements = refreshFinancialStatements;
    window.exportFinancialStatement = exportFinancialStatement;

    await loadAccounts();
    await loadJournalLines();
    
    const now = new Date();
    document.getElementById('fsStartDate').value = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    document.getElementById('fsEndDate').value = now.toISOString().split('T')[0];
    
    await loadFinancialStatement();
    setupEventListeners();

    console.log("✅ Financial Statements initialized successfully!");
})();
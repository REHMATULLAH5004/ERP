// ============================================
// GENERAL LEDGER MODULE
// ============================================

(async function initLedger() {
    console.log("📖 General Ledger initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    // ============================================
    // GLOBAL STATE
    // ============================================
    const state = {
        accounts: [],
        journalEntries: [],
        journalLines: [],
        currentAccount: null,
        startDate: '',
        endDate: ''
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
            populateAccountFilter();
            return state.accounts;
        } catch (error) {
            console.error('Error loading accounts:', error);
            state.accounts = [];
            return [];
        }
    }

    async function loadJournalEntries() {
        try {
            const { data, error } = await supabaseClient
                .from('journal_entries')
                .select(`
                    *,
                    journal_lines (*)
                `)
                .order('entry_date', { ascending: true });

            if (error) throw error;
            state.journalEntries = data || [];
            
            // Extract all journal lines
            state.journalLines = [];
            state.journalEntries.forEach(entry => {
                if (entry.journal_lines) {
                    entry.journal_lines.forEach(line => {
                        state.journalLines.push({
                            ...line,
                            entry_date: entry.entry_date,
                            journal_number: entry.journal_number,
                            journal_description: entry.description,
                            journal_reference: entry.reference
                        });
                    });
                }
            });
            
            return state.journalEntries;
        } catch (error) {
            console.error('Error loading journal entries:', error);
            state.journalEntries = [];
            state.journalLines = [];
            return [];
        }
    }

    // ============================================
    // POPULATE ACCOUNT FILTER
    // ============================================

    function populateAccountFilter() {
        const select = document.getElementById('ledgerAccountFilter');
        if (!select) return;

        select.innerHTML = `<option value="">All Accounts</option>`;
        state.accounts.forEach(a => {
            select.innerHTML += `<option value="${a.code}">${a.code} - ${a.name}</option>`;
        });
    }

    // ============================================
    // RENDER FUNCTIONS
    // ============================================

    async function renderLedger() {
        const container = document.getElementById('ledgerTableContainer');
        const countSpan = document.getElementById('ledgerEntryCount');
        const countMain = document.getElementById('ledgerCount');

        if (!container) return;

        // Get filters
        const accountCode = document.getElementById('ledgerAccountFilter')?.value || '';
        const startDate = document.getElementById('ledgerStartDate')?.value || '';
        const endDate = document.getElementById('ledgerEndDate')?.value || '';

        state.currentAccount = accountCode;
        state.startDate = startDate;
        state.endDate = endDate;

        // Filter journal lines
        let lines = [...state.journalLines];

        if (accountCode) {
            lines = lines.filter(l => l.account_code === accountCode);
        }

        if (startDate) {
            lines = lines.filter(l => l.entry_date >= startDate);
        }

        if (endDate) {
            lines = lines.filter(l => l.entry_date <= endDate);
        }

        // Sort by date
        lines.sort((a, b) => new Date(a.entry_date) - new Date(b.entry_date));

        if (lines.length === 0) {
            container.innerHTML = `
                <div style="text-align: center; padding: 40px; color: #94a3b8;">
                    <i class="fa-regular fa-book" style="font-size: 2rem; display: block; margin-bottom: 10px;"></i>
                    No transactions found for the selected criteria.
                </div>
            `;
            if (countSpan) countSpan.textContent = '0 entries';
            if (countMain) countMain.textContent = '0 entries';
            document.getElementById('ledgerAccountSummary').style.display = 'none';
            return;
        }

        // Build the ledger table
        let runningBalance = 0;
        const account = state.accounts.find(a => a.code === accountCode);
        const isDebit = account?.normal_balance === 'Debit';

        // 🔥 FIX (revised): an earlier version of this fix converted
        // 1120's lines to ZMW and fed THAT into runningBalance/
        // totalDebits/totalCredits below -- confirmed against real data
        // that this broke the running balance's arithmetic, for the same
        // reason as Trial Balance (see that file's comment): 1120's rows
        // were each originally paired against a ZMW account at whatever
        // rate applied on that transaction's own day, so multiplying by
        // TODAY's single rate no longer matches and the two stop
        // cancelling out. The running balance/totals below now always
        // use the raw figures (this is what keeps them mathematically
        // correct); usdRate is used ONLY to label a 1120 row with its
        // approximate ZMW-equivalent, never to change what's summed.
        const showingAllAccounts = !accountCode;
        const usdRate = showingAllAccounts ? await getSharedExchangeRate() : 1;

        let html = `
            <div style="overflow-x: auto;">
                <table class="table-minimal">
                    <thead>
                        <tr>
                            <th style="padding-left: 20px;">Date</th>
                            <th>Journal #</th>
                            <th>Account</th>
                            <th>Description</th>
                            <th style="text-align: right;">Debit</th>
                            <th style="text-align: right;">Credit</th>
                            <th style="text-align: right; padding-right: 20px;">Balance</th>
                        </tr>
                    </thead>
                    <tbody>
        `;

        let totalDebits = 0;
        let totalCredits = 0;

        lines.forEach((line, index) => {
            const isUsdLine = showingAllAccounts && line.account_code === '1120';
            const debit = line.debit || 0;
            const credit = line.credit || 0;
            const balanceChange = debit - credit;

            // For liability/equity accounts, balance increases on credit
            const effectiveChange = (isDebit || account?.type === 'Asset' || account?.type === 'Expense')
                ? balanceChange
                : -balanceChange;

            // 🔥 FIX: runningBalance/totalDebits/totalCredits always use
            // the RAW figures now (see comment above) -- this is what
            // keeps them mathematically correct regardless of which
            // accounts are mixed together in the "All Accounts" view.
            runningBalance += effectiveChange;
            totalDebits += debit;
            totalCredits += credit;

            const accountName = state.accounts.find(a => a.code === line.account_code)?.name || line.account_code;
            const description = line.description || line.journal_description || '-';

            // Show the real dollar figures on a 1120 row, with an
            // approximate ZMW-equivalent alongside for readability only
            // -- purely a label, not part of the running balance/totals.
            const debitDisplay = isUsdLine
                ? (debit > 0 ? `$${formatNumber(debit)} <span style="color:#94a3b8;">(≈K${formatNumber(debit * usdRate)})</span>` : '-')
                : (debit > 0 ? formatNumber(debit) : '-');
            const creditDisplay = isUsdLine
                ? (credit > 0 ? `$${formatNumber(credit)} <span style="color:#94a3b8;">(≈K${formatNumber(credit * usdRate)})</span>` : '-')
                : (credit > 0 ? formatNumber(credit) : '-');

            html += `
                <tr ${line.debit > 0 && line.credit === 0 ? 'style="background: #fef2f2;"' : ''}>
                    <td style="padding-left: 20px;">${formatDate(line.entry_date)}</td>
                    <td><strong>${line.journal_number || '-'}</strong></td>
                    <td>
                        <strong>${line.account_code}</strong>
                        <br><span style="font-size: 0.7rem; color: #94a3b8;">${accountName}</span>
                    </td>
                    <td>${description}</td>
                    <td style="text-align: right; color: #dc2626;">${debitDisplay}</td>
                    <td style="text-align: right; color: #22c55e;">${creditDisplay}</td>
                    <td style="text-align: right; padding-right: 20px; font-weight: ${index === lines.length - 1 ? 'bold' : 'normal'}; color: ${runningBalance > 0 ? '#059669' : runningBalance < 0 ? '#dc2626' : '#94a3b8'};">
                        ${formatNumber(runningBalance)}
                    </td>
                </tr>
            `;
        });

        html += `
                    </tbody>
                    <tfoot>
                        <tr class="total-row" style="background: #f8fafc; font-weight: bold;">
                            <td colspan="4" style="text-align: right; padding-left: 20px;">Totals</td>
                            <td style="text-align: right; color: #dc2626;">${formatNumber(totalDebits)}</td>
                            <td style="text-align: right; color: #22c55e;">${formatNumber(totalCredits)}</td>
                            <td style="text-align: right; padding-right: 20px; color: ${runningBalance > 0 ? '#059669' : runningBalance < 0 ? '#dc2626' : '#94a3b8'};">
                                ${formatNumber(runningBalance)}
                            </td>
                        </tr>
                    </tfoot>
                </table>
            </div>
        `;

        container.innerHTML = html;

        if (countSpan) countSpan.textContent = `${lines.length} entries`;
        if (countMain) countMain.textContent = `${lines.length} entries`;

        // Update account summary
        updateAccountSummary(lines, account, runningBalance, totalDebits, totalCredits);
    }

    function updateAccountSummary(lines, account, closingBalance, totalDebits, totalCredits) {
        const summaryDiv = document.getElementById('ledgerAccountSummary');
        if (!summaryDiv) return;

        if (!account) {
            // Show summary for all accounts
            // 🔥 FIX: this used to recompute its own "allAccountsBalance"
            // straight from the full, UNFILTERED state.journalLines --
            // silently ignoring the date range filter applied everywhere
            // else on this page, AND (separately) mixing account 1120's
            // raw USD figures into what's shown as a single ZMW balance.
            // closingBalance (passed in) is already correctly filtered
            // by date AND already ZMW-converted for 1120 -- just use it.
            document.getElementById('summaryAccountName').textContent = 'All Accounts';
            document.getElementById('summaryPeriod').textContent = `${state.startDate || 'Start'} to ${state.endDate || 'End'}`;
            document.getElementById('summaryOpeningBalance').textContent = formatCurrency(0);
            document.getElementById('summaryTotalDebits').textContent = formatCurrency(totalDebits);
            document.getElementById('summaryTotalCredits').textContent = formatCurrency(totalCredits);
            document.getElementById('summaryClosingBalance').textContent = formatCurrency(closingBalance);
            document.getElementById('summaryClosingBalance').className = 'summary-value ' + (closingBalance >= 0 ? 'positive' : 'negative');
            summaryDiv.style.display = 'grid';
            return;
        }

        // Calculate opening balance (balance before first transaction in the period)
        const openingBalance = closingBalance - (totalDebits - totalCredits);
        const isDebit = account.normal_balance === 'Debit';
        const openingBalanceFormatted = isDebit ? openingBalance : -openingBalance;

        document.getElementById('summaryAccountName').textContent = `${account.code} - ${account.name}`;
        document.getElementById('summaryPeriod').textContent = `${state.startDate || 'Start'} to ${state.endDate || 'End'}`;
        document.getElementById('summaryOpeningBalance').textContent = formatCurrency(openingBalanceFormatted);
        document.getElementById('summaryOpeningBalance').className = 'summary-value ' + (openingBalanceFormatted >= 0 ? 'positive' : 'negative');
        document.getElementById('summaryTotalDebits').textContent = formatCurrency(totalDebits);
        document.getElementById('summaryTotalDebits').className = 'summary-value debit';
        document.getElementById('summaryTotalCredits').textContent = formatCurrency(totalCredits);
        document.getElementById('summaryTotalCredits').className = 'summary-value credit';
        document.getElementById('summaryClosingBalance').textContent = formatCurrency(closingBalance);
        document.getElementById('summaryClosingBalance').className = 'summary-value ' + (closingBalance >= 0 ? 'positive' : 'negative');
        
        summaryDiv.style.display = 'grid';
    }

    // ============================================
    // REFRESH
    // ============================================

    function refreshLedger() {
        renderLedger();
    }

    // ============================================
    // EXPORT LEDGER
    // ============================================

    function exportLedger() {
        const container = document.getElementById('ledgerTableContainer');
        const table = container?.querySelector('table');
        if (!table) {
            showToast('No data to export', 'error');
            return;
        }

        // Get account info
        const accountCode = document.getElementById('ledgerAccountFilter')?.value || '';
        const account = state.accounts.find(a => a.code === accountCode);
        const accountName = account ? `${account.code} - ${account.name}` : 'All Accounts';

        // Build CSV
        let csv = `General Ledger - ${accountName}\n`;
        csv += `Period: ${state.startDate || 'Start'} to ${state.endDate || 'End'}\n\n`;
        csv += 'Date,Journal #,Account,Description,Debit,Credit,Balance\n';

        const rows = table.querySelectorAll('tbody tr');
        rows.forEach(row => {
            const cells = row.querySelectorAll('td');
            if (cells.length === 7) {
                const date = cells[0]?.textContent?.trim() || '';
                const journal = cells[1]?.textContent?.trim() || '';
                const account = cells[2]?.textContent?.trim() || '';
                const description = cells[3]?.textContent?.trim() || '';
                const debit = cells[4]?.textContent?.trim()?.replace(/,/g, '') || '0';
                const credit = cells[5]?.textContent?.trim()?.replace(/,/g, '') || '0';
                const balance = cells[6]?.textContent?.trim()?.replace(/,/g, '') || '0';
                csv += `${date},"${journal}","${account}","${description}",${debit},${credit},${balance}\n`;
            }
        });

        // Add totals from footer
        const footer = table.querySelector('tfoot');
        if (footer) {
            const cells = footer.querySelectorAll('td');
            if (cells.length === 7) {
                csv += `\nTotals,,,,"${cells[4]?.textContent?.trim() || '0'}","${cells[5]?.textContent?.trim() || '0'}","${cells[6]?.textContent?.trim() || '0'}"\n`;
            }
        }

        // Download CSV
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `General_Ledger_${accountName}_${new Date().toISOString().split('T')[0]}.csv`;
        a.click();
        window.URL.revokeObjectURL(url);

        showToast('Ledger exported successfully!', 'success');
    }

    // ============================================
    // UTILITY FUNCTIONS
    // ============================================

    function formatNumber(num) {
        return (num || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function formatCurrency(amount) {
        const sign = amount >= 0 ? '' : '-';
        return `${sign}$${Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }

    function formatDate(dateStr) {
        if (!dateStr) return '-';
        try {
            const d = new Date(dateStr);
            return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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
    // EVENT LISTENERS
    // ============================================

    function setupEventListeners() {
        // Enter key on filters triggers refresh
        document.querySelectorAll('#ledgerAccountFilter, #ledgerStartDate, #ledgerEndDate').forEach(el => {
            el.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    refreshLedger();
                }
            });
            el.addEventListener('change', refreshLedger);
        });
    }

    // ============================================
    // TOAST CSS
    // ============================================
    if (!document.getElementById('customToastStyles')) {
        const style = document.createElement('style');
        style.id = 'customToastStyles';
        style.textContent = `
            @keyframes slideIn {
                from { transform: translateX(100%); opacity: 0; }
                to { transform: translateX(0); opacity: 1; }
            }
            @keyframes slideOut {
                from { transform: translateX(0); opacity: 1; }
                to { transform: translateX(100%); opacity: 0; }
            }
        `;
        document.head.appendChild(style);
    }

    // ============================================
    // EXPOSE TO GLOBAL SCOPE
    // ============================================
    window.refreshLedger = refreshLedger;
    window.exportLedger = exportLedger;

    // ============================================
    // INITIALIZE
    // ============================================
    await loadAccounts();
    await loadJournalEntries();
    
    // Set default dates
    const now = new Date();
    const monthAgo = new Date(now);
    monthAgo.setMonth(monthAgo.getMonth() - 1);
    document.getElementById('ledgerStartDate').value = monthAgo.toISOString().split('T')[0];
    document.getElementById('ledgerEndDate').value = now.toISOString().split('T')[0];

    renderLedger();
    setupEventListeners();

    console.log("✅ General Ledger initialized successfully!");
    console.log(`📖 ${state.journalLines.length} journal lines loaded`);
    console.log(`📊 ${state.accounts.length} accounts loaded`);
})();
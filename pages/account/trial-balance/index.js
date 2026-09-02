// ============================================
// TRIAL BALANCE MODULE - COMPLETE (ZMW Currency)
// ============================================

(async function initTrialBalance() {
    console.log("📊 Trial Balance initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    // ============================================
    // GLOBAL STATE
    // ============================================
    const state = {
        trialBalance: [],
        totalDebits: 0,
        totalCredits: 0,
        isBalanced: false,
        asOfDate: new Date().toISOString().split('T')[0],
        accounts: []
    };

    // ============================================
    // CURRENCY SETTINGS
    // ============================================
    const CURRENCY = {
        symbol: 'K',  // Zambian Kwacha
        code: 'ZMW',
        locale: 'en-ZM',
        minFraction: 2,
        maxFraction: 2
    };

    // ============================================
    // DOM REFERENCES
    // ============================================
    const container = document.getElementById('trialBalanceContainer');
    const tbody = container?.querySelector('tbody');
    const tfoot = container?.querySelector('tfoot');
    const dateDisplay = document.getElementById('tbDate');

    // ============================================
    // FORMAT FUNCTIONS
    // ============================================

    function formatCurrency(amount) {
        if (amount === 0 || amount === undefined || amount === null) {
            return '-';
        }
        return `${CURRENCY.symbol}${amount.toFixed(CURRENCY.minFraction)}`;
    }

    function formatCurrencyWithColor(amount, isDebit = true) {
        if (amount === 0 || amount === undefined || amount === null) {
            return '<span style="color: #94a3b8;">-</span>';
        }
        const color = isDebit ? '#dc2626' : '#22c55e';
        return `<span style="color: ${color}; font-weight: ${amount > 0 ? '600' : '400'};">${formatCurrency(amount)}</span>`;
    }

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

    async function loadJournalLines(asOfDate) {
        try {
            // 🔥 FIX: same bug as Financial Statements' loadJournalLines() --
            // a single unpaginated fetch silently caps at Supabase/PostgREST's
            // default max-rows (1000), with no error and no way to tell from
            // the response that anything was cut off. This project already
            // has 1250+ Posted journal_lines, and since Postgres has no
            // guaranteed row order without an ORDER BY, the rows most likely
            // to be missing are the most recently inserted ones -- i.e. the
            // newest entries, which is exactly backwards from what you'd
            // want for a report that's supposed to be complete "as of"
            // today. Fixed by paging through in batches of 1000 until a page
            // comes back short, so this always loads every matching line
            // regardless of how large the ledger grows.
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
                    .lte('journal_entries.entry_date', asOfDate)
                    .eq('journal_entries.status', 'Posted')
                    .range(offset, offset + PAGE_SIZE - 1);

                if (error) throw error;

                allLines = allLines.concat(data || []);

                if (!data || data.length < PAGE_SIZE) break;
                offset += PAGE_SIZE;
            }

            return allLines;
        } catch (error) {
            console.error('Error loading journal lines:', error);
            return [];
        }
    }

    // ============================================
    // GENERATE TRIAL BALANCE (FIXED)
    // ============================================

    async function generateTrialBalance(asOfDate) {
        try {
            console.log(`📊 Generating Trial Balance as of ${asOfDate}...`);

            await loadAccounts();
            const lines = await loadJournalLines(asOfDate);

            if (state.accounts.length === 0) {
                showToast('No accounts found. Please add accounts to the Chart of Accounts.', 'warning');
                return;
            }

            const accountBalances = {};
            
            state.accounts.forEach(acc => {
                accountBalances[acc.code] = {
                    code: acc.code,
                    name: acc.name,
                    type: acc.type,
                    normal_balance: acc.normal_balance,
                    total_debit: 0,
                    total_credit: 0,
                    net_balance: 0,
                    display_debit: 0,
                    display_credit: 0,
                    is_active: acc.is_active
                };
            });

            // 🔥 FIX: this used to silently skip any line whose
            // account_code wasn't found in chart_of_accounts -- meaning
            // a wrong/orphaned code would vanish from this calculation
            // entirely, while everything else in the ledger still
            // counted it, producing exactly this symptom: the full
            // ledger balances, but this report doesn't, with no visible
            // explanation why. Confirmed against real data that this is
            // precisely what happened -- one historical line referencing
            // a code ('1110') that was never actually added to the
            // chart of accounts. Now creates a fallback "Unknown
            // Account" entry for any such code instead of dropping it,
            // so a future occurrence of this is visible and explainable
            // rather than a silent, untraceable imbalance.
            lines.forEach(line => {
                if (!accountBalances[line.account_code]) {
                    accountBalances[line.account_code] = {
                        code: line.account_code,
                        name: '⚠️ Unknown Account (not in Chart of Accounts)',
                        type: 'Unknown',
                        normal_balance: 'Debit', // arbitrary default -- flagged visually regardless
                        total_debit: 0,
                        total_credit: 0,
                        net_balance: 0,
                        display_debit: 0,
                        display_credit: 0,
                        is_active: true,
                        is_unknown: true
                    };
                }
                accountBalances[line.account_code].total_debit += line.debit || 0;
                accountBalances[line.account_code].total_credit += line.credit || 0;
            });

            // 🔥 FIX (revised): an earlier version of this fix multiplied
            // 1120's whole historical total_debit/total_credit by
            // today's rate before it fed into net_balance/totalDebits/
            // totalCredits below -- confirmed against real data that
            // this broke the fundamental "Total Debits = Total Credits"
            // identity, since 1120's balance was built up across many
            // transactions each originally paired against a ZMW account
            // at WHATEVER rate applied that day (or not converted at
            // all, for direct-USD payments). Multiplying the accumulated
            // total by a single current rate doesn't match what those
            // older ZMW-side entries actually say, so they stop
            // cancelling out -- e.g. a $150 net balance times today's
            // rate of 20 introduced exactly a K2,850 imbalance.
            // Left raw here (this is what keeps the balanced-check
            // mathematically guaranteed to hold), and instead just
            // ANNOTATE the row with its approximate ZMW-equivalent for
            // readability -- doesn't feed into any total. A rigorous,
            // provably-balanced ZMW conversion of this account needs
            // real per-transaction FX translation, not a report-side
            // multiply.
            if (accountBalances['1120']) {
                const usdRate = await getSharedExchangeRate();
                const rawNet = accountBalances['1120'].total_debit - accountBalances['1120'].total_credit;
                accountBalances['1120'].name += ` (USD account -- balance below is in raw dollars, ≈ K${(rawNet * usdRate).toFixed(2)} at today's rate)`;
            }

            const trialBalance = [];
            let totalDebits = 0;
            let totalCredits = 0;

            Object.values(accountBalances).forEach(acc => {
                let netBalance = 0;
                if (acc.normal_balance === 'Debit') {
                    netBalance = acc.total_debit - acc.total_credit;
                } else {
                    netBalance = acc.total_credit - acc.total_debit;
                }
                
                acc.net_balance = netBalance;

                if (netBalance !== 0) {
                    if (acc.normal_balance === 'Debit') {
                        if (netBalance > 0) {
                            acc.display_debit = netBalance;
                            acc.display_credit = 0;
                            totalDebits += netBalance;
                        } else {
                            acc.display_debit = 0;
                            acc.display_credit = Math.abs(netBalance);
                            totalCredits += Math.abs(netBalance);
                        }
                    } else {
                        if (netBalance > 0) {
                            acc.display_debit = 0;
                            acc.display_credit = netBalance;
                            totalCredits += netBalance;
                        } else {
                            acc.display_debit = Math.abs(netBalance);
                            acc.display_credit = 0;
                            totalDebits += Math.abs(netBalance);
                        }
                    }
                    
                    trialBalance.push(acc);
                }
            });

            trialBalance.sort((a, b) => a.code.localeCompare(b.code));

            state.trialBalance = trialBalance;
            state.totalDebits = totalDebits;
            state.totalCredits = totalCredits;
            state.isBalanced = Math.abs(totalDebits - totalCredits) < 0.01;
            state.asOfDate = asOfDate;

            console.log(`✅ Trial Balance generated: ${trialBalance.length} accounts`);
            console.log(`   Total Debits: ${formatCurrency(totalDebits)}`);
            console.log(`   Total Credits: ${formatCurrency(totalCredits)}`);
            console.log(`   Balanced: ${state.isBalanced ? '✅ YES' : '❌ NO'}`);

            if (!state.isBalanced) {
                console.warn(`⚠️ Difference: ${formatCurrency(Math.abs(totalDebits - totalCredits))}`);
            }

            return trialBalance;

        } catch (error) {
            console.error('Error generating trial balance:', error);
            showToast('Error generating trial balance: ' + error.message, 'error');
            return [];
        }
    }

    // ============================================
    // RENDER FUNCTIONS
    // ============================================

    function renderTrialBalance() {
        const container = document.getElementById('trialBalanceContainer');
        if (!container) return;

        const tbody = container.querySelector('tbody');
        const tfoot = container.querySelector('tfoot');

        if (!tbody || !tfoot) return;

        const dateDisplay = document.getElementById('tbDate');
        if (dateDisplay) {
            const date = new Date(state.asOfDate);
            dateDisplay.textContent = date.toLocaleDateString('en-ZM', {
                year: 'numeric',
                month: 'long',
                day: 'numeric'
            });
        }

        const accountCount = document.getElementById('tbAccountCount');
        if (accountCount) {
            accountCount.textContent = `${state.trialBalance.length} accounts`;
        }

        if (state.trialBalance.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="4" style="text-align: center; padding: 40px; color: #94a3b8;">
                        <i class="fa-regular fa-file-lines" style="font-size: 2rem; display: block; margin-bottom: 10px;"></i>
                        No transactions found for the selected period.
                        <br><span style="font-size: 0.85rem;">Try adjusting the date filter or create some journal entries.</span>
                    </td>
                </tr>
            `;
            tfoot.innerHTML = `
                <tr class="total-row">
                    <td colspan="2" style="text-align: right; font-weight: 600;">Total</td>
                    <td style="text-align: right; font-weight: 600;">${formatCurrency(0)}</td>
                    <td style="text-align: right; font-weight: 600;">${formatCurrency(0)}</td>
                </tr>
                <tr style="background: #f1f5f9; font-weight: 600;">
                    <td colspan="4" style="text-align: center; padding: 12px; color: #94a3b8;">
                        <i class="fa-solid fa-circle-info" style="margin-right: 8px;"></i>
                        No data to display
                    </td>
                </tr>
            `;
            return;
        }

        let html = '';
        state.trialBalance.forEach(acc => {
            const debit = acc.display_debit || 0;
            const credit = acc.display_credit || 0;
            // 🔥 ADDED: visually flag any unknown-account row distinctly,
            // so it's impossible to miss if it ever appears again.
            const rowStyle = acc.is_unknown ? 'background: #fef2f2;' : '';
            
            html += `
                <tr style="${rowStyle}">
                    <td style="font-family: monospace; font-weight: 600;">${acc.code}</td>
                    <td>${acc.name}</td>
                    <td style="text-align: right;">
                        ${debit > 0 ? formatCurrencyWithColor(debit, true) : '<span style="color: #94a3b8;">-</span>'}
                    </td>
                    <td style="text-align: right;">
                        ${credit > 0 ? formatCurrencyWithColor(credit, false) : '<span style="color: #94a3b8;">-</span>'}
                    </td>
                </tr>
            `;
        });

        tbody.innerHTML = html;

        const isBalanced = state.isBalanced;
        const difference = Math.abs(state.totalDebits - state.totalCredits);

        tfoot.innerHTML = `
            <tr class="total-row" style="background: #f8fafc; font-weight: 700; border-top: 2px solid #e2e8f0;">
                <td colspan="2" style="text-align: right; padding: 12px;">Total</td>
                <td style="text-align: right; padding: 12px; color: #dc2626;">${formatCurrency(state.totalDebits)}</td>
                <td style="text-align: right; padding: 12px; color: #22c55e;">${formatCurrency(state.totalCredits)}</td>
            </tr>
            <tr style="background: ${isBalanced ? '#f0fdf4' : '#fef2f2'}; font-weight: 600;">
                <td colspan="4" style="text-align: center; padding: 12px;">
                    <i class="fa-solid ${isBalanced ? 'fa-circle-check' : 'fa-circle-exclamation'}" 
                       style="color: ${isBalanced ? '#22c55e' : '#dc2626'}; margin-right: 8px;"></i>
                    ${isBalanced 
                        ? '✅ TRIAL BALANCE IS BALANCED' 
                        : `❌ TRIAL BALANCE IS NOT BALANCED - Difference: ${formatCurrency(difference)}`
                    }
                </td>
            </tr>
        `;

        updateSummaryStats();
    }

    function updateSummaryStats() {
        const totalAccounts = state.trialBalance.length;
        const debitAccounts = state.trialBalance.filter(a => a.display_debit > 0).length;
        const creditAccounts = state.trialBalance.filter(a => a.display_credit > 0).length;

        console.log(`📊 Summary: ${totalAccounts} accounts | ${debitAccounts} debit | ${creditAccounts} credit`);
    }

    // ============================================
    // EXPORT FUNCTIONS
    // ============================================

    function exportTrialBalance() {
        if (state.trialBalance.length === 0) {
            showToast('No data to export', 'error');
            return;
        }

        try {
            let csv = 'Account Code,Account Name,Type,Normal Balance,Debit (ZMW),Credit (ZMW)\n';
            state.trialBalance.forEach(acc => {
                csv += `"${acc.code}","${acc.name}","${acc.type || ''}","${acc.normal_balance || ''}",${(acc.display_debit || 0).toFixed(2)},${(acc.display_credit || 0).toFixed(2)}\n`;
            });

            csv += `\nTOTALS,,,,"${state.totalDebits.toFixed(2)}","${state.totalCredits.toFixed(2)}"\n`;
            csv += `BALANCED,${state.isBalanced ? 'YES' : 'NO'},,,"${Math.abs(state.totalDebits - state.totalCredits).toFixed(2)}"\n`;

            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `Trial_Balance_ZMW_${state.asOfDate}.csv`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            showToast('Trial Balance exported successfully!', 'success');
        } catch (error) {
            console.error('Error exporting trial balance:', error);
            showToast('Error exporting: ' + error.message, 'error');
        }
    }

    // ============================================
    // DATE PICKER LOGIC
    // ============================================

    function setupDatePicker() {
        const dateInput = document.getElementById('tbDatePicker');
        if (!dateInput) {
            const header = document.querySelector('.tb-info');
            if (header) {
                const pickerHTML = `
                    <div style="display: flex; align-items: center; gap: 12px; margin-top: 8px;">
                        <label style="font-weight: 500; color: #475569; font-size: 0.9rem;">
                            <i class="fa-regular fa-calendar"></i> As of:
                        </label>
                        <input type="date" id="tbDatePicker" value="${state.asOfDate}" 
                               style="padding: 6px 12px; border: 1px solid #e2e8f0; border-radius: 4px; font-size: 0.9rem;">
                        <button id="tbApplyDate" class="btn btn-primary btn-sm">
                            <i class="fa-solid fa-check"></i> Apply
                        </button>
                    </div>
                `;
                header.insertAdjacentHTML('beforeend', pickerHTML);
            }
        }

        const dateInputEl = document.getElementById('tbDatePicker');
        const applyBtn = document.getElementById('tbApplyDate');

        if (dateInputEl) {
            dateInputEl.value = state.asOfDate;
            dateInputEl.addEventListener('change', function() {
                state.asOfDate = this.value;
                refreshTrialBalance();
            });
        }

        if (applyBtn) {
            applyBtn.addEventListener('click', function() {
                const dateInput = document.getElementById('tbDatePicker');
                if (dateInput) {
                    state.asOfDate = dateInput.value;
                    refreshTrialBalance();
                }
            });
        }
    }

    // ============================================
    // REFRESH FUNCTION
    // ============================================

    async function refreshTrialBalance() {
        const dateInput = document.getElementById('tbDatePicker');
        const asOfDate = dateInput ? dateInput.value : state.asOfDate;
        
        const container = document.getElementById('trialBalanceContainer');
        if (container) {
            const tbody = container.querySelector('tbody');
            if (tbody) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="4" style="text-align: center; padding: 40px; color: #94a3b8;">
                            <i class="fa-solid fa-spinner fa-spin" style="font-size: 2rem; display: block; margin-bottom: 10px;"></i>
                            Loading Trial Balance...
                        </td>
                    </tr>
                `;
            }
        }

        await generateTrialBalance(asOfDate);
        renderTrialBalance();
    }

    // ============================================
    // TOAST NOTIFICATION
    // ============================================

    function showToast(message, type = 'success') {
        const container = document.getElementById('toastContainer');
        if (!container) {
            const newContainer = document.createElement('div');
            newContainer.id = 'toastContainer';
            newContainer.style.cssText = 'position: fixed; top: 20px; right: 20px; z-index: 9999; display: flex; flex-direction: column; gap: 8px;';
            document.body.appendChild(newContainer);
        }

        const toastContainer = document.getElementById('toastContainer');
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        const bgColor = type === 'success' ? '#059669' : type === 'error' ? '#dc2626' : type === 'warning' ? '#f59e0b' : '#2563eb';
        toast.style.cssText = `
            padding: 16px 24px;
            border-radius: 8px;
            color: white;
            font-weight: 500;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            animation: slideIn 0.3s ease;
            background: ${bgColor};
            max-width: 400px;
        `;
        toast.textContent = message;
        toastContainer.appendChild(toast);

        setTimeout(() => {
            toast.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
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
    window.refreshTrialBalance = refreshTrialBalance;
    window.exportTrialBalance = exportTrialBalance;
    window.generateTrialBalance = generateTrialBalance;

    // ============================================
    // INITIALIZE
    // ============================================
    setupDatePicker();
    await generateTrialBalance(state.asOfDate);
    renderTrialBalance();

    console.log("✅ Trial Balance initialized successfully!");
    console.log(`📊 ${state.trialBalance.length} accounts with balances`);
    console.log(`💵 Total Debits: ${formatCurrency(state.totalDebits)}`);
    console.log(`💳 Total Credits: ${formatCurrency(state.totalCredits)}`);
    console.log(`⚖️ ${state.isBalanced ? 'BALANCED ✅' : 'NOT BALANCED ❌'}`);

})();
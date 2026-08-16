// ============================================
// CHART OF ACCOUNTS MODULE - WITH REAL BALANCES
// ============================================

(async function initCOA() {
    console.log("📊 Chart of Accounts initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    // ============================================
    // GLOBAL STATE
    // ============================================
    const state = {
        accounts: [],
        currentViewData: null,
        accountTypes: ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'],
        categories: ['Current', 'Fixed', 'Other'],
        balances: {} // Cache for account balances
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

            if (error) {
                console.warn('chart_of_accounts table not found or error:', error);
                state.accounts = [];
                return [];
            }
            
            state.accounts = data || [];
            console.log(`✅ Loaded ${state.accounts.length} accounts`);
            return state.accounts;
        } catch (error) {
            console.error('Error loading accounts:', error);
            state.accounts = [];
            return [];
        }
    }

    // ============================================
    // GET ACCOUNT BALANCE FROM JOURNAL LINES
    // ============================================

    async function getAccountBalance(accountCode) {
        try {
            // Sum all debits and credits for this account
            const { data, error } = await supabaseClient
                .from('journal_lines')
                .select('debit, credit')
                .eq('account_code', accountCode);

            if (error) {
                // If table doesn't exist or error, return 0
                return 0;
            }

            let totalDebit = 0;
            let totalCredit = 0;
            
            data.forEach(line => {
                totalDebit += line.debit || 0;
                totalCredit += line.credit || 0;
            });

            // Find the account to determine normal balance
            const account = state.accounts.find(a => a.code === accountCode);
            
            // For Asset/Expense accounts: Balance = Debit - Credit
            // For Liability/Equity/Revenue: Balance = Credit - Debit
            if (account && account.normal_balance === 'Credit') {
                return totalCredit - totalDebit;
            }
            return totalDebit - totalCredit;

        } catch (error) {
            console.error('Error getting account balance:', error);
            return 0;
        }
    }

    // ============================================
    // GET ALL ACCOUNT BALANCES (BATCH)
    // ============================================

    async function getAllAccountBalances() {
        try {
            // Get all journal lines
            const { data: lines, error } = await supabaseClient
                .from('journal_lines')
                .select('account_code, debit, credit');

            if (error) {
                console.warn('Could not fetch journal lines:', error);
                return {};
            }

            // Group by account code
            const balances = {};
            lines.forEach(line => {
                if (!balances[line.account_code]) {
                    balances[line.account_code] = { debit: 0, credit: 0 };
                }
                balances[line.account_code].debit += line.debit || 0;
                balances[line.account_code].credit += line.credit || 0;
            });

            // Calculate net balance based on normal balance
            const result = {};
            state.accounts.forEach(account => {
                const code = account.code;
                if (balances[code]) {
                    const { debit, credit } = balances[code];
                    if (account.normal_balance === 'Credit') {
                        result[code] = credit - debit;
                    } else {
                        result[code] = debit - credit;
                    }
                } else {
                    result[code] = 0;
                }
            });

            state.balances = result;
            return result;

        } catch (error) {
            console.error('Error getting all balances:', error);
            return {};
        }
    }

    // ============================================
    // RENDER FUNCTIONS
    // ============================================

    function renderStats() {
        const accounts = state.accounts;
        const total = accounts.length;
        const assets = accounts.filter(a => a.type === 'Asset').length;
        const liabilities = accounts.filter(a => a.type === 'Liability').length;
        const equity = accounts.filter(a => a.type === 'Equity').length;
        const revenue = accounts.filter(a => a.type === 'Revenue').length;
        const expenses = accounts.filter(a => a.type === 'Expense').length;

        // Safe element updates - check if elements exist
        const totalEl = document.getElementById('totalAccounts');
        const assetEl = document.getElementById('assetAccounts');
        const liabilityEl = document.getElementById('liabilityAccounts');
        const equityEl = document.getElementById('equityAccounts');
        const revenueEl = document.getElementById('revenueAccounts');
        const expenseEl = document.getElementById('expenseAccounts');
        
        if (totalEl) totalEl.textContent = total;
        if (assetEl) assetEl.textContent = assets;
        if (liabilityEl) liabilityEl.textContent = liabilities;
        if (equityEl) equityEl.textContent = equity;
        if (revenueEl) revenueEl.textContent = revenue;
        if (expenseEl) expenseEl.textContent = expenses;

        // Update balance stats
        updateBalanceStats();
    }

    async function updateBalanceStats() {
        const balances = state.balances;
        if (Object.keys(balances).length === 0) return;

        let totalAssets = 0;
        let totalLiabilities = 0;
        let totalEquity = 0;
        let totalRevenue = 0;
        let totalExpenses = 0;

        // 🔥 FIX (revised): an earlier version of this fix multiplied
        // 1120's balance by today's rate before adding it into
        // totalAssets -- confirmed against real data that this makes
        // Total Assets disagree with Trial Balance and the Balance
        // Sheet (both of which must use 1120's RAW balance to stay
        // mathematically correct -- see trial-balance/index.js's
        // comment for the full reasoning: 1120's balance was built up
        // across transactions each paired against a ZMW account at
        // whatever rate applied that day, so multiplying the
        // accumulated total by TODAY's single rate doesn't match and
        // creates a discrepancy). Total Assets now uses the raw figure
        // too, so it agrees with the other reports; usdRate is kept
        // only to label the per-row balance below with an approximate
        // ZMW-equivalent.
        const usdRate = balances['1120'] ? await getSharedExchangeRate() : 1;
        state.usdRateForDisplay = usdRate; // read by formatBalanceWithColor() in renderAccounts()

        state.accounts.forEach(a => {
            let balance = balances[a.code] || 0;
            switch(a.type) {
                case 'Asset': totalAssets += balance; break;
                case 'Liability': totalLiabilities += balance; break;
                case 'Equity': totalEquity += balance; break;
                case 'Revenue': totalRevenue += balance; break;
                case 'Expense': totalExpenses += balance; break;
            }
        });

        // Update balance display elements if they exist
        const assetBalEl = document.getElementById('assetBalanceTotal');
        const liabilityBalEl = document.getElementById('liabilityBalanceTotal');
        const equityBalEl = document.getElementById('equityBalanceTotal');
        const revenueBalEl = document.getElementById('revenueBalanceTotal');
        const expenseBalEl = document.getElementById('expenseBalanceTotal');

        if (assetBalEl) assetBalEl.textContent = formatBalance(totalAssets);
        if (liabilityBalEl) liabilityBalEl.textContent = formatBalance(totalLiabilities);
        if (equityBalEl) equityBalEl.textContent = formatBalance(totalEquity);
        if (revenueBalEl) revenueBalEl.textContent = formatBalance(totalRevenue);
        if (expenseBalEl) expenseBalEl.textContent = formatBalance(totalExpenses);
    }

    async function renderAccounts(data = null) {
        const accounts = data || state.accounts;
        const tbody = document.getElementById('coaTableBody');
        const countSpan = document.getElementById('coaListCount');
        const countMain = document.getElementById('coaCount');

        if (!tbody) return;

        // Apply filters
        const searchTerm = document.getElementById('searchCOA')?.value?.toLowerCase() || '';
        const typeFilter = document.getElementById('coaTypeFilter')?.value || 'all';
        const categoryFilter = document.getElementById('coaCategoryFilter')?.value || 'all';

        let filtered = accounts;

        if (searchTerm) {
            filtered = filtered.filter(a => 
                a.code.toLowerCase().includes(searchTerm) ||
                a.name.toLowerCase().includes(searchTerm) ||
                (a.description || '').toLowerCase().includes(searchTerm)
            );
        }

        if (typeFilter !== 'all') {
            filtered = filtered.filter(a => a.type === typeFilter);
        }

        if (categoryFilter !== 'all') {
            filtered = filtered.filter(a => a.category === categoryFilter);
        }

        if (filtered.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 40px; color: #94a3b8;">
                <i class="fa-regular fa-circle-check" style="font-size: 2rem; display: block; margin-bottom: 10px;"></i>
                ${accounts.length === 0 ? 'No accounts found. Click "New Account" to get started!' : 'No accounts match the filters.'}
            </td></tr>`;
            if (countSpan) countSpan.textContent = '0 accounts';
            if (countMain) countMain.textContent = '0 accounts';
            return;
        }

        // Get all balances in one query (if not already cached)
        if (Object.keys(state.balances).length === 0) {
            await getAllAccountBalances();
        }

        const getTypeBadge = (type) => {
            const map = {
                'Asset': 'type-asset',
                'Liability': 'type-liability',
                'Equity': 'type-equity',
                'Revenue': 'type-revenue',
                'Expense': 'type-expense'
            };
            return map[type] || 'type-asset';
        };

        const getCategoryBadge = (category) => {
            const map = {
                'Current': 'category-current',
                'Fixed': 'category-fixed'
            };
            return map[category] || 'category-badge';
        };

        const getNormalBalanceColor = (balance) => {
            return balance === 'Debit' ? '#059669' : '#dc2626';
        };

        // Format balance with color based on value
        const formatBalanceWithColor = (balance, account) => {
            // 🔥 FIX: this account's balance is raw USD, not ZMW like
            // every other row (and Total Assets above also uses this
            // same raw figure, to stay mathematically consistent with
            // Trial Balance and the Balance Sheet). A bare number here
            // was easy to misread as ZMW -- label it clearly and show
            // its approximate ZMW-equivalent alongside, for readability
            // only.
            const isUsd = account.code === '1120';
            const formatted = isUsd
                ? `$${formatBalance(balance)}` + (state.usdRateForDisplay ? ` <span style="color:#94a3b8; font-weight:400;">(≈K${formatBalance(balance * state.usdRateForDisplay)})</span>` : '')
                : formatBalance(balance);
            let color = '#94a3b8'; // default gray for zero
            
            if (balance > 0) {
                // For debit balance accounts (Asset, Expense)
                if (account.normal_balance === 'Debit') {
                    color = '#059669'; // green
                } else {
                    color = '#dc2626'; // red
                }
            } else if (balance < 0) {
                // For negative balance (opposite of normal)
                if (account.normal_balance === 'Debit') {
                    color = '#dc2626'; // red
                } else {
                    color = '#059669'; // green
                }
            }
            
            return `<span style="color: ${color}; font-weight: ${balance !== 0 ? '600' : '400'};">${formatted}</span>`;
        };

        tbody.innerHTML = filtered.map(a => {
            const balance = state.balances[a.code] || 0;
            return `
            <tr>
                <td style="padding-left: 20px; font-family: monospace; font-weight: 600;">${a.code}</td>
                <td><strong>${a.name}</strong></td>
                <td><span class="type-badge ${getTypeBadge(a.type)}">${a.type}</span></td>
                <td><span class="${getCategoryBadge(a.category)}">${a.category || '-'}</span></td>
                <td style="text-align: right; font-weight: 500;">${formatBalanceWithColor(balance, a)}</td>
                <td style="text-align: center; color: ${getNormalBalanceColor(a.normal_balance)};">
                    <span style="font-weight: 600;">${a.normal_balance}</span>
                </td>
                <td style="text-align: center;">
                    <button class="btn btn-sm btn-outline" onclick="viewAccount('${a.id}')" title="View Details">
                        <i class="fa-regular fa-eye"></i>
                    </button>
                    <button class="btn btn-sm btn-outline" onclick="editAccount('${a.id}')" title="Edit" style="color: #f59e0b;">
                        <i class="fa-regular fa-pen-to-square"></i>
                    </button>
                    <button class="btn btn-sm btn-outline" onclick="deleteAccount('${a.id}')" title="Delete" style="color: #ef4444;">
                        <i class="fa-regular fa-trash-can"></i>
                    </button>
                </td>
            </tr>
        `}).join('');

        if (countSpan) countSpan.textContent = `${filtered.length} accounts`;
        if (countMain) countMain.textContent = `${filtered.length} accounts`;
    }

    function formatBalance(amount) {
        return amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    // ============================================
    // ACCOUNT CRUD OPERATIONS
    // ============================================

    function openNewAccount() {
        const modal = document.getElementById('accountModal');
        const title = document.getElementById('accountModalTitle');
        const form = document.getElementById('accountForm');
        const editId = document.getElementById('editAccountId');

        if (!modal || !title || !form) {
            showToast('Modal elements not found', 'error');
            return;
        }

        title.innerHTML = `<i class="fa-solid fa-plus"></i> New Account`;
        editId.value = '';
        form.reset();

        // Hide info
        const infoDiv = document.getElementById('accountTypeInfo');
        if (infoDiv) infoDiv.style.display = 'none';

        // Populate parent accounts
        populateParentAccounts();

        modal.classList.add('show');
    }

    async function editAccount(accountId) {
        try {
            const account = state.accounts.find(a => a.id === accountId);
            if (!account) {
                showToast('Account not found', 'error');
                return;
            }

            const modal = document.getElementById('accountModal');
            const title = document.getElementById('accountModalTitle');
            const editId = document.getElementById('editAccountId');

            title.innerHTML = `<i class="fa-solid fa-pen-to-square"></i> Edit Account`;
            editId.value = accountId;

            document.getElementById('accountCode').value = account.code || '';
            document.getElementById('accountName').value = account.name || '';
            document.getElementById('accountType').value = account.type || '';
            document.getElementById('accountCategory').value = account.category || '';
            document.getElementById('normalBalance').value = account.normal_balance || '';
            document.getElementById('accountDescription').value = account.description || '';
            document.getElementById('openingBalance').value = '';

            populateParentAccounts(account.parent_account_id);

            // Show info
            updateAccountTypeInfo();

            modal.classList.add('show');
        } catch (error) {
            console.error('Error loading account for edit:', error);
            showToast('Error loading account: ' + error.message, 'error');
        }
    }

    async function deleteAccount(accountId) {
        if (!confirm('Are you sure you want to delete this account?')) return;

        try {
            // Check if account has transactions
            const { data: hasTransactions, error: checkError } = await supabaseClient
                .from('journal_lines')
                .select('id')
                .eq('account_code', state.accounts.find(a => a.id === accountId)?.code)
                .limit(1);

            if (checkError) {
                console.warn('Could not check for transactions:', checkError);
            } else if (hasTransactions && hasTransactions.length > 0) {
                showToast('Cannot delete account with existing transactions. Please deactivate instead.', 'error');
                return;
            }

            const { error } = await supabaseClient
                .from('chart_of_accounts')
                .delete()
                .eq('id', accountId);

            if (error) throw error;

            showToast('Account deleted successfully', 'success');
            await refreshCOA();
        } catch (error) {
            console.error('Error deleting account:', error);
            showToast('Error deleting account: ' + error.message, 'error');
        }
    }

    async function viewAccount(accountId) {
        try {
            const account = state.accounts.find(a => a.id === accountId);
            if (!account) {
                showToast('Account not found', 'error');
                return;
            }

            state.currentViewData = account;

            // Get the real balance for this account
            const balance = await getAccountBalance(account.code);
            const formattedBalance = formatBalance(balance);

            const content = document.getElementById('viewAccountContent');
            if (!content) return;

            content.innerHTML = `
                <div class="view-detail-row">
                    <span class="label">Code</span>
                    <span class="value"><strong style="font-family: monospace; font-size: 1.1rem;">${account.code}</strong></span>
                </div>
                <div class="view-detail-row">
                    <span class="label">Account Name</span>
                    <span class="value"><strong>${account.name}</strong></span>
                </div>
                <div class="view-detail-row">
                    <span class="label">Type</span>
                    <span class="value"><span class="type-badge ${account.type === 'Asset' ? 'type-asset' : account.type === 'Liability' ? 'type-liability' : account.type === 'Equity' ? 'type-equity' : account.type === 'Revenue' ? 'type-revenue' : 'type-expense'}">${account.type}</span></span>
                </div>
                <div class="view-detail-row">
                    <span class="label">Category</span>
                    <span class="value"><span class="${account.category === 'Current' ? 'category-current' : account.category === 'Fixed' ? 'category-fixed' : 'category-badge'}">${account.category || '-'}</span></span>
                </div>
                <div class="view-detail-row">
                    <span class="label">Normal Balance</span>
                    <span class="value" style="color: ${account.normal_balance === 'Debit' ? '#059669' : '#dc2626'}; font-weight: 600;">${account.normal_balance}</span>
                </div>
                <div class="view-detail-row" style="background: #f8fafc; padding: 10px; border-radius: 4px; margin: 8px 0;">
                    <span class="label" style="font-weight: 600;">Current Balance</span>
                    <span class="value" style="font-weight: 700; font-size: 1.1rem; color: ${balance !== 0 ? (account.normal_balance === 'Debit' ? '#059669' : '#dc2626') : '#94a3b8'};">${formattedBalance}</span>
                </div>
                ${account.description ? `
                <div class="view-detail-row">
                    <span class="label">Description</span>
                    <span class="value">${account.description}</span>
                </div>
                ` : ''}
                <div class="view-detail-row" style="border-bottom: none;">
                    <span class="label">Status</span>
                    <span class="value"><span style="background: ${account.is_active ? '#dcfce7' : '#fee2e2'}; color: ${account.is_active ? '#15803d' : '#dc2626'}; padding: 2px 12px; border-radius: 10px; font-size: 0.75rem;">${account.is_active ? 'Active' : 'Inactive'}</span></span>
                </div>
            `;

            document.getElementById('viewAccountModal').classList.add('show');
        } catch (error) {
            console.error('Error viewing account:', error);
            showToast('Error loading account details: ' + error.message, 'error');
        }
    }

    // ============================================
    // SAVE ACCOUNT
    // ============================================

    async function saveAccount() {
        const editId = document.getElementById('editAccountId').value;
        const code = document.getElementById('accountCode').value.trim();
        const name = document.getElementById('accountName').value.trim();
        const type = document.getElementById('accountType').value;
        const category = document.getElementById('accountCategory').value;
        const normalBalance = document.getElementById('normalBalance').value;
        const description = document.getElementById('accountDescription').value.trim();
        const openingBalance = parseFloat(document.getElementById('openingBalance').value) || 0;
        const parentAccount = document.getElementById('parentAccount').value || null;

        // Validation
        if (!code) {
            showToast('Please enter an account code', 'error');
            return;
        }
        if (!name) {
            showToast('Please enter an account name', 'error');
            return;
        }
        if (!type) {
            showToast('Please select an account type', 'error');
            return;
        }
        if (!category) {
            showToast('Please select a category', 'error');
            return;
        }
        if (!normalBalance) {
            showToast('Please select normal balance', 'error');
            return;
        }

        const accountData = {
            code: code,
            name: name,
            type: type,
            category: category,
            normal_balance: normalBalance,
            description: description || null,
            parent_account_id: parentAccount,
            is_active: true,
            updated_at: new Date().toISOString()
        };

        try {
            let result;
            if (editId) {
                const { data, error } = await supabaseClient
                    .from('chart_of_accounts')
                    .update(accountData)
                    .eq('id', editId)
                    .select();

                if (error) throw error;
                result = data;
                showToast('Account updated successfully!', 'success');
            } else {
                // Check if code already exists
                const { data: existing, error: checkError } = await supabaseClient
                    .from('chart_of_accounts')
                    .select('code')
                    .eq('code', code)
                    .maybeSingle();

                if (existing) {
                    showToast('Account code already exists. Please use a unique code.', 'error');
                    return;
                }

                accountData.created_at = new Date().toISOString();
                const { data, error } = await supabaseClient
                    .from('chart_of_accounts')
                    .insert([accountData])
                    .select();

                if (error) throw error;
                result = data;
                showToast('Account created successfully!', 'success');

                // If opening balance is provided, create a journal entry for it
                if (openingBalance !== 0) {
                    await createOpeningBalanceEntry(code, openingBalance, normalBalance);
                }
            }

            closeModal('accountModal');
            await refreshCOA();

        } catch (error) {
            console.error('Error saving account:', error);
            showToast('Error saving account: ' + error.message, 'error');
        }
    }

    // ============================================
    // OPENING BALANCE JOURNAL ENTRY
    // ============================================

    async function createOpeningBalanceEntry(accountCode, amount, normalBalance) {
        try {
            const entryDate = new Date().toISOString().split('T')[0];
            
            const journal = {
                entry_date: entryDate,
                reference: 'OPENING-BALANCE',
                description: `Opening balance for account ${accountCode}`,
                journal_number: `OPEN-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
                status: 'Posted',
                created_at: new Date().toISOString()
            };

            const { data: journalData, error: jError } = await supabaseClient
                .from('journal_entries')
                .insert([journal])
                .select();

            if (jError) throw jError;

            // For debit balance accounts: Debit = amount, Credit = 0
            // For credit balance accounts: Debit = 0, Credit = amount
            const isDebit = normalBalance === 'Debit';
            
            const lines = [
                {
                    journal_entry_id: journalData[0].id,
                    account_code: accountCode,
                    description: `Opening balance`,
                    debit: isDebit ? amount : 0,
                    credit: isDebit ? 0 : amount
                },
                {
                    journal_entry_id: journalData[0].id,
                    account_code: '9999', // Equity - Opening Balance (create this account first)
                    description: `Opening balance offset`,
                    debit: isDebit ? 0 : amount,
                    credit: isDebit ? amount : 0
                }
            ];

            const { error: lineError } = await supabaseClient
                .from('journal_lines')
                .insert(lines);

            if (lineError) throw lineError;

            console.log(`✅ Opening balance journal entry created for ${accountCode}`);
        } catch (error) {
            console.error('Error creating opening balance entry:', error);
            showToast('Account created but opening balance entry failed: ' + error.message, 'warning');
        }
    }

    // ============================================
    // UI HELPERS
    // ============================================

    function populateParentAccounts(selectedId = null) {
        const select = document.getElementById('parentAccount');
        if (!select) return;
        
        select.innerHTML = `<option value="">None (Top Level)</option>`;

        state.accounts.forEach(a => {
            const selected = selectedId === a.id ? 'selected' : '';
            select.innerHTML += `<option value="${a.id}" ${selected}>${a.code} - ${a.name}</option>`;
        });
    }

    function updateAccountTypeInfo() {
        const type = document.getElementById('accountType')?.value;
        const category = document.getElementById('accountCategory')?.value;
        const normalBalance = document.getElementById('normalBalance')?.value;
        const infoDiv = document.getElementById('accountTypeInfo');

        if (!infoDiv) return;

        if (type || category || normalBalance) {
            infoDiv.style.display = 'block';
            const infoType = document.getElementById('infoType');
            const infoNormalBalance = document.getElementById('infoNormalBalance');
            const infoCategory = document.getElementById('infoCategory');
            
            if (infoType) infoType.textContent = type || 'Not selected';
            if (infoNormalBalance) infoNormalBalance.textContent = normalBalance || 'Not selected';
            if (infoCategory) infoCategory.textContent = category || 'Not selected';
        } else {
            infoDiv.style.display = 'none';
        }
    }

    // ============================================
    // FILTERS
    // ============================================

    function applyCOAFilters() {
        renderAccounts();
    }

    // ============================================
    // EXPORT
    // ============================================

    async function exportCOA() {
        const accounts = state.accounts;
        if (accounts.length === 0) {
            showToast('No accounts to export', 'error');
            return;
        }

        // Get balances for export
        const balances = await getAllAccountBalances();

        let csv = 'Code,Account Name,Type,Category,Normal Balance,Balance,Description\n';
        accounts.forEach(a => {
            const balance = balances[a.code] || 0;
            csv += `${a.code},"${a.name}",${a.type},${a.category || ''},${a.normal_balance},${balance.toFixed(2)},"${a.description || ''}"\n`;
        });

        const blob = new Blob([csv], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `chart_of_accounts_${new Date().toISOString().split('T')[0]}.csv`;
        a.click();
        window.URL.revokeObjectURL(url);

        showToast('Chart of Accounts exported successfully!', 'success');
    }

    // ============================================
    // REFRESH
    // ============================================

    async function refreshCOA() {
        await loadAccounts();
        state.balances = await getAllAccountBalances();
        renderStats();
        await renderAccounts();
        populateParentAccounts();
    }

    // ============================================
    // UTILITY FUNCTIONS
    // ============================================

    function closeModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) modal.classList.remove('show');
    }

    function showToast(message, type = 'success') {
        // Use the global toast system if available
        if (typeof window.showToast === 'function') {
            window.showToast(message, type);
            return;
        }

        // Fallback toast implementation
        const container = document.getElementById('toastContainer');
        if (!container) {
            // Create container if it doesn't exist
            const newContainer = document.createElement('div');
            newContainer.id = 'toastContainer';
            newContainer.style.cssText = 'position: fixed; top: 20px; right: 20px; z-index: 9999; display: flex; flex-direction: column; gap: 8px;';
            document.body.appendChild(newContainer);
        }

        const toastContainer = document.getElementById('toastContainer');
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.textContent = message;
        toastContainer.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('toast-hide');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // ============================================
    // EVENT LISTENERS
    // ============================================

    function setupEventListeners() {
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                document.querySelectorAll('.modal.show').forEach(modal => {
                    modal.classList.remove('show');
                });
            }
        });

        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    modal.classList.remove('show');
                }
            });
        });

        // Update info on type change
        const typeEl = document.getElementById('accountType');
        const categoryEl = document.getElementById('accountCategory');
        const balanceEl = document.getElementById('normalBalance');
        
        if (typeEl) typeEl.addEventListener('change', updateAccountTypeInfo);
        if (categoryEl) categoryEl.addEventListener('change', updateAccountTypeInfo);
        if (balanceEl) balanceEl.addEventListener('change', updateAccountTypeInfo);

        // Search and filters
        const searchEl = document.getElementById('searchCOA');
        const typeFilterEl = document.getElementById('coaTypeFilter');
        const categoryFilterEl = document.getElementById('coaCategoryFilter');
        
        if (searchEl) searchEl.addEventListener('input', applyCOAFilters);
        if (typeFilterEl) typeFilterEl.addEventListener('change', applyCOAFilters);
        if (categoryFilterEl) categoryFilterEl.addEventListener('change', applyCOAFilters);
    }

    // ============================================
    // EXPOSE TO GLOBAL SCOPE
    // ============================================
    window.openNewAccount = openNewAccount;
    window.editAccount = editAccount;
    window.deleteAccount = deleteAccount;
    window.viewAccount = viewAccount;
    window.saveAccount = saveAccount;
    window.applyCOAFilters = applyCOAFilters;
    window.refreshCOA = refreshCOA;
    window.exportCOA = exportCOA;
    window.closeModal = closeModal;
    window.showToast = showToast;

    // ============================================
    // INITIALIZE
    // ============================================
    await loadAccounts();
    state.balances = await getAllAccountBalances();
    renderStats();
    await renderAccounts();
    populateParentAccounts();
    setupEventListeners();

    console.log("✅ Chart of Accounts initialized successfully!");
    console.log(`📊 ${state.accounts.length} accounts loaded`);
    console.log(`💰 ${Object.keys(state.balances).length} accounts have balances`);
})();
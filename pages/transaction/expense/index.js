// ============================================
// EXPENSE MANAGEMENT MODULE
// ============================================

(async function initExpensePage() {
    console.log("💳 Expense Management initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    // 🔥 CHANGED: the shared window-level getCompanySettings() helper
    // (assets/js/shared-company-settings.js) no longer exists on the site,
    // so calling it here threw "getCompanySettings is not defined" and
    // aborted this entire module's init. Self-contained now: reads the
    // company_name straight from the `company_settings` row, with a
    // hardcoded fallback if that fails for any reason.
    const companySettings = await (async function loadCompanySettingsInline() {
        const fallback = { company_name: 'GRIFFINS MEDICALS LIMITED' };
        try {
            const { data, error } = await supabaseClient
                .from('company_settings')
                .select('company_name')
                .eq('id', 1)
                .maybeSingle();
            if (error || !data) return fallback;
            return { company_name: data.company_name || fallback.company_name };
        } catch (e) {
            console.warn('Could not load company_settings, using defaults:', e);
            return fallback;
        }
    })();

    // ============================================
    // GLOBAL STATE
    // ============================================
    const state = {
        expenses: [],
        currentViewData: null
    };

    // ============================================
    // ACCOUNT CONFIGURATION
    // ============================================
    // 🔥 FIX: expenses can now only come from Cash in Hand or Bank
    // (ZMW) -- matching the same two sources used for supplier payments
    // elsewhere in this system. Previously there was also a separate
    // "USD Account" option and a redundant "Petty Cash"/"ZMW Account"
    // split that didn't map onto any real ledger account at all.
    const ACCOUNTS = [
        { id: 'Cash in Hand', label: 'Cash in Hand', currency: 'ZMW', symbol: 'ZK' },
        { id: 'Bank (ZMW)', label: 'Bank (ZMW)', currency: 'ZMW', symbol: 'ZK' }
    ];

    const EXPENSE_CATEGORIES = [
        'Administrative',
        'Utilities',
        'Rent',
        'Salaries',
        'Office Supplies',
        'Maintenance',
        'Transport',
        'Marketing',
        'Insurance',
        'Licenses',
        'Professional Fees',
        'Bank Charges',
        'Taxes',
        'Other'
    ];

    // ============================================
    // 🔥 CHART OF ACCOUNTS - AUTO CREATE MISSING ACCOUNTS
    // ============================================
    // This module had NO accounting/GL integration at all before this --
    // expenses were recorded in cash_transactions but never touched
    // journal_entries/journal_lines/chart_of_accounts. Cash/Bank codes
    // match retail.js/wholesale.js/donation.js/writeoff.js/purchase's
    // index.js/payment's index.js exactly, so this never creates
    // duplicates of those shared accounts. One dedicated expense account
    // per category (6101-6113, plus 6199 for "Other") so the P&L can
    // actually break expenses down by category, not just lump them all
    // into one number.
    const CATEGORY_ACCOUNT_CODES = {
        'Administrative': '6101',
        'Utilities': '6102',
        'Rent': '6103',
        'Salaries': '6104',
        'Office Supplies': '6105',
        'Maintenance': '6106',
        'Transport': '6107',
        'Marketing': '6108',
        'Insurance': '6109',
        'Licenses': '6110',
        'Professional Fees': '6111',
        'Bank Charges': '6112',
        'Taxes': '6113',
        'Other': '6199'
    };

    const REQUIRED_ACCOUNTS = [
        { code: '1111', name: 'Cash in Hand (ZMW)', type: 'Asset', category: 'Current Asset', normal_balance: 'Debit' },
        { code: '1121', name: 'Bank - ZMW', type: 'Asset', category: 'Current Asset', normal_balance: 'Debit' },
        ...EXPENSE_CATEGORIES.map(cat => ({
            code: CATEGORY_ACCOUNT_CODES[cat],
            name: `${cat} Expense`,
            type: 'Expense',
            category: 'Operating Expense',
            normal_balance: 'Debit'
        }))
    ];

    async function ensureChartOfAccounts() {
        try {
            let created = 0, existing = 0;
            for (const account of REQUIRED_ACCOUNTS) {
                const { data: existingAccount, error: findError } = await supabaseClient
                    .from('chart_of_accounts')
                    .select('code, name')
                    .eq('code', account.code)
                    .maybeSingle();

                if (findError && findError.code !== 'PGRST116') {
                    console.error(`Error checking account ${account.code}:`, findError);
                    continue;
                }
                if (existingAccount) { existing++; continue; }

                const { error: insertError } = await supabaseClient
                    .from('chart_of_accounts')
                    .insert([{
                        code: account.code,
                        name: account.name,
                        type: account.type,
                        category: account.category,
                        normal_balance: account.normal_balance,
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString()
                    }]);

                if (insertError) {
                    console.error(`Error creating account ${account.code}:`, insertError);
                } else {
                    created++;
                }
            }
            console.log(`✅ Chart of Accounts sync complete: ${created} created, ${existing} existing`);
        } catch (error) {
            console.error('Error ensuring chart of accounts:', error);
        }
    }

    function getCashBankAccountCode(accountId) {
        return accountId === 'Bank (ZMW)' ? '1121' : '1111';
    }

    // ============================================
    // 🔥 EXPENSE GL ENTRIES -- Debit the category's expense account,
    // Credit Cash in Hand or Bank (ZMW). Reversal helper posts an
    // equal-and-opposite entry rather than ever deleting/altering a
    // posted one, matching standard accounting practice, and is used by
    // both edit (reverse old + post new) and delete (reverse only).
    // ============================================
    async function createExpenseGLEntry(txNumber, date, account, category, amount) {
        try {
            const expenseAccountCode = CATEGORY_ACCOUNT_CODES[category] || CATEGORY_ACCOUNT_CODES['Other'];
            const cashBankCode = getCashBankAccountCode(account);

            const journal = {
                entry_date: date,
                reference: txNumber,
                description: `Expense: ${category} (${txNumber})`,
                journal_number: `EXP-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
                status: 'Posted',
                created_at: new Date().toISOString()
            };

            const { data: journalData, error: jError } = await supabaseClient
                .from('journal_entries')
                .insert([journal])
                .select();
            if (jError) throw jError;

            await supabaseClient.from('journal_lines').insert([
                { journal_entry_id: journalData[0].id, account_code: expenseAccountCode, description: `${category} expense - ${txNumber}`, debit: amount, credit: 0 },
                { journal_entry_id: journalData[0].id, account_code: cashBankCode, description: `Paid via ${account} - ${txNumber}`, debit: 0, credit: amount }
            ]);

            console.log(`✅ Expense GL entry created for ${txNumber}: ZK${amount.toFixed(2)} (${category}, via ${account})`);
        } catch (error) {
            console.error('Error creating expense GL entry:', error);
            showToast('Expense saved, but the accounting entry failed -- please check manually.', 'warning');
        }
    }

    async function reverseExpenseGLEntries(txNumber) {
        try {
            const { data: entries, error } = await supabaseClient
                .from('journal_entries')
                .select('id, description, journal_lines(*)')
                .eq('reference', txNumber);

            if (error) throw error;
            if (!entries || entries.length === 0) return;

            // Reversals are ADDITIVE, never exclusionary -- the original
            // entry's status is never changed, since any report that
            // sums journal_lines by account_code (filtered to
            // status='Posted' or not) needs BOTH the original and its
            // reversal present to correctly net to zero. Idempotency
            // (so repeated edits never double-reverse the same entry) is
            // tracked by having each reversal's description reference the
            // specific original entry id it reverses, rather than by
            // touching status at all.
            const alreadyReversedIds = new Set(
                entries
                    .filter(e => (e.description || '').startsWith('Reversal of expense entry -'))
                    .map(e => e.description.match(/entry - ([a-f0-9-]+)/)?.[1])
                    .filter(Boolean)
            );

            const toReverse = entries.filter(e =>
                !(e.description || '').startsWith('Reversal of expense entry -') &&
                !alreadyReversedIds.has(e.id)
            );

            for (const original of toReverse) {
                const reversalJournal = {
                    entry_date: new Date().toISOString().split('T')[0],
                    reference: txNumber,
                    description: `Reversal of expense entry - ${original.id} (${txNumber})`,
                    journal_number: `EXPREV-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
                    status: 'Posted',
                    created_at: new Date().toISOString()
                };

                const { data: reversalData, error: rjError } = await supabaseClient
                    .from('journal_entries')
                    .insert([reversalJournal])
                    .select();
                if (rjError) throw rjError;

                const reversalLines = (original.journal_lines || []).map(line => ({
                    journal_entry_id: reversalData[0].id,
                    account_code: line.account_code,
                    description: `Reversal: ${line.description}`,
                    debit: line.credit || 0,
                    credit: line.debit || 0
                }));

                if (reversalLines.length > 0) {
                    const { error: rlError } = await supabaseClient.from('journal_lines').insert(reversalLines);
                    if (rlError) throw rlError;
                }
            }

            if (toReverse.length > 0) {
                console.log(`✅ Reversed ${toReverse.length} prior GL entr${toReverse.length === 1 ? 'y' : 'ies'} for ${txNumber}`);
            }
        } catch (error) {
            console.error('Error reversing expense GL entry:', error);
            showToast('Could not reverse the prior accounting entry -- please check the ledger manually.', 'warning');
        }
    }

    function getAccountInfo(accountId) {
        return ACCOUNTS.find(a => a.id === accountId) || ACCOUNTS[0];
    }

    function getCurrencySymbol(accountId) {
        const info = getAccountInfo(accountId);
        return info ? info.symbol : 'ZK';
    }

    // ============================================
    // LOAD DATA
    // ============================================

    async function loadExpenses() {
        try {
            // Get all transactions where type is 'Payment' and has expense_category
            const { data, error } = await supabaseClient
                .from('cash_transactions')
                .select('*')
                .eq('type', 'Payment')
                .not('expense_category', 'is', null)
                .order('transaction_date', { ascending: false })
                .order('created_at', { ascending: false });

            if (error) {
                console.warn('Error loading expenses:', error);
                state.expenses = [];
                return [];
            }
            state.expenses = data || [];
            console.log(`✅ Loaded ${state.expenses.length} expenses`);
            return state.expenses;
        } catch (error) {
            console.error('Error loading expenses:', error);
            state.expenses = [];
            return [];
        }
    }

    // ============================================
    // CALCULATE STATS
    // ============================================

    function calculateExpenseStats() {
        const today = new Date().toISOString().split('T')[0];
        const weekStart = new Date();
        weekStart.setDate(weekStart.getDate() - 7);
        const monthStart = new Date();
        monthStart.setDate(1);

        let total = 0;
        let monthTotal = 0;
        let weekTotal = 0;
        let todayTotal = 0;

        state.expenses.forEach(exp => {
            const amount = exp.amount || 0;
            const date = exp.transaction_date;

            total += amount;

            if (date && new Date(date) >= monthStart) {
                monthTotal += amount;
            }
            if (date && new Date(date) >= weekStart) {
                weekTotal += amount;
            }
            if (date === today) {
                todayTotal += amount;
            }
        });

        return { total, monthTotal, weekTotal, todayTotal };
    }

    // ============================================
    // RENDER FUNCTIONS
    // ============================================

    function renderStats() {
        const stats = calculateExpenseStats();
        const symbol = 'ZK';

        document.getElementById('totalExpenses').textContent = `${symbol} ${formatNumber(stats.total)}`;
        document.getElementById('monthExpenses').textContent = `${symbol} ${formatNumber(stats.monthTotal)}`;
        document.getElementById('weekExpenses').textContent = `${symbol} ${formatNumber(stats.weekTotal)}`;
        document.getElementById('todayExpenses').textContent = `${symbol} ${formatNumber(stats.todayTotal)}`;
    }

    function renderExpenses(data = null) {
        const expenses = data || state.expenses;
        const tbody = document.getElementById('expenseTableBody');
        const countSpan = document.getElementById('expenseListCount');
        const countMain = document.getElementById('expenseCount');

        if (!tbody) return;

        // Apply filters
        const searchTerm = document.getElementById('searchExpense')?.value?.toLowerCase() || '';
        const categoryFilter = document.getElementById('expenseCategoryFilter')?.value || 'all';
        const accountFilter = document.getElementById('expenseAccountFilter')?.value || 'all';
        const startDate = document.getElementById('expenseStartDate')?.value;
        const endDate = document.getElementById('expenseEndDate')?.value;

        let filtered = expenses;

        if (searchTerm) {
            filtered = filtered.filter(tx => 
                (tx.description || '').toLowerCase().includes(searchTerm) ||
                (tx.reference || '').toLowerCase().includes(searchTerm) ||
                (tx.expense_category || '').toLowerCase().includes(searchTerm)
            );
        }

        if (categoryFilter !== 'all') {
            filtered = filtered.filter(tx => tx.expense_category === categoryFilter);
        }

        if (accountFilter !== 'all') {
            filtered = filtered.filter(tx => tx.account === accountFilter);
        }

        if (startDate) {
            filtered = filtered.filter(tx => tx.transaction_date >= startDate);
        }
        if (endDate) {
            filtered = filtered.filter(tx => tx.transaction_date <= endDate);
        }

        if (filtered.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 40px; color: #94a3b8;">
                <i class="fa-regular fa-circle-check" style="font-size: 2rem; display: block; margin-bottom: 10px;"></i>
                ${expenses.length === 0 ? 'No expenses recorded yet.' : 'No expenses match the filters.'}
            </td></tr>`;
            if (countSpan) countSpan.textContent = '0 expenses';
            if (countMain) countMain.textContent = '0 expenses';
            return;
        }

        const getAccountBadge = (account) => {
            const map = {
                'Cash in Hand': 'account-petty-cash',
                'Bank (ZMW)': 'account-zmw'
            };
            return map[account] || 'account-petty-cash';
        };

        const categoryColors = {
            'Administrative': '#6366f1',
            'Utilities': '#f59e0b',
            'Rent': '#8b5cf6',
            'Salaries': '#ec4899',
            'Office Supplies': '#14b8a6',
            'Maintenance': '#f97316',
            'Transport': '#06b6d4',
            'Marketing': '#f43f5e',
            'Insurance': '#0ea5e9',
            'Licenses': '#8b5cf6',
            'Professional Fees': '#6366f1',
            'Bank Charges': '#94a3b8',
            'Taxes': '#dc2626',
            'Other': '#64748b'
        };

        tbody.innerHTML = filtered.map(tx => {
            const symbol = getCurrencySymbol(tx.account);
            const date = tx.transaction_date ? new Date(tx.transaction_date).toLocaleDateString() : 'N/A';
            const category = tx.expense_category || 'Other';
            const color = categoryColors[category] || '#64748b';

            return `
            <tr>
                <td style="padding-left: 20px;">${date}</td>
                <td><span class="account-badge ${getAccountBadge(tx.account)}">${tx.account}</span></td>
                <td>
                    <span class="expense-category-badge" style="background: ${color}20; color: ${color};">
                        ${category}
                    </span>
                </td>
                <td>${tx.description || '-'}</td>
                <td>${tx.reference || '-'}</td>
                <td style="text-align: right; font-weight: 600; color: #dc2626;">
                    - ${symbol} ${formatNumber(tx.amount)}
                </td>
                <td style="padding-right: 20px; text-align: center;">
                    <button class="btn btn-sm btn-outline" onclick="viewExpense('${tx.id}')" title="View Details">
                        <i class="fa-regular fa-eye"></i>
                    </button>
                    <button class="btn btn-sm btn-outline" onclick="editExpense('${tx.id}')" title="Edit" style="color: #f59e0b;">
                        <i class="fa-regular fa-pen-to-square"></i>
                    </button>
                    <button class="btn btn-sm btn-outline" onclick="deleteExpense('${tx.id}')" title="Delete" style="color: #ef4444;">
                        <i class="fa-regular fa-trash-can"></i>
                    </button>
                </td>
            </tr>
            `;
        }).join('');

        if (countSpan) countSpan.textContent = `${filtered.length} expenses`;
        if (countMain) countMain.textContent = `${filtered.length} expenses`;
    }

    function applyExpenseFilters() {
        renderExpenses();
    }

    // ============================================
    // EXPENSE CRUD OPERATIONS
    // ============================================

    function openNewExpense() {
        const modal = document.getElementById('expenseModal');
        const title = document.getElementById('expenseModalTitle');
        const form = document.getElementById('expenseForm');
        const editId = document.getElementById('editExpenseId');

        title.innerHTML = `<i class="fa-solid fa-plus"></i> New Expense`;
        editId.value = '';
        form.reset();

        // Set default date to today
        document.getElementById('expenseDate').value = new Date().toISOString().split('T')[0];

        // Hide summary
        document.getElementById('expenseSummary').style.display = 'none';

        // Set currency symbol
        updateExpenseCurrencySymbol();

        modal.classList.add('show');
    }

    async function editExpense(txId) {
        try {
            const tx = state.expenses.find(t => t.id === txId);
            if (!tx) {
                showToast('Expense not found', 'error');
                return;
            }

            const modal = document.getElementById('expenseModal');
            const title = document.getElementById('expenseModalTitle');
            const editId = document.getElementById('editExpenseId');

            title.innerHTML = `<i class="fa-solid fa-pen-to-square"></i> Edit Expense`;
            editId.value = txId;

            // Set form values
            document.getElementById('expenseAccount').value = tx.account || '';
            document.getElementById('expenseCategory').value = tx.expense_category || '';
            document.getElementById('expenseAmount').value = tx.amount || '';
            document.getElementById('expenseDescription').value = tx.description || '';
            document.getElementById('expenseReference').value = tx.reference || '';
            document.getElementById('expenseDate').value = tx.transaction_date || '';
            document.getElementById('expenseNotes').value = tx.notes || '';

            // Show summary
            updateExpenseSummary();

            modal.classList.add('show');
        } catch (error) {
            console.error('Error loading expense for edit:', error);
            showToast('Error loading expense: ' + error.message, 'error');
        }
    }

    async function deleteExpense(txId) {
        if (!confirm('Are you sure you want to delete this expense? This will also reverse its accounting entry.')) return;

        try {
            const tx = state.expenses.find(t => t.id === txId);

            // 🔥 FIX: deleting an expense used to just remove the
            // cash_transactions row while leaving its posted GL entry in
            // place forever -- the ledger would keep showing money spent
            // for a record that no longer existed. Now reverses the GL
            // entry first.
            if (tx && tx.transaction_number) {
                await reverseExpenseGLEntries(tx.transaction_number);
            }

            const { error } = await supabaseClient
                .from('cash_transactions')
                .delete()
                .eq('id', txId);

            if (error) throw error;

            showToast('Expense deleted and accounting entry reversed', 'success');
            await refreshExpenseData();
        } catch (error) {
            console.error('Error deleting expense:', error);
            showToast('Error deleting expense: ' + error.message, 'error');
        }
    }

    async function viewExpense(txId) {
        try {
            const tx = state.expenses.find(t => t.id === txId);
            if (!tx) {
                showToast('Expense not found', 'error');
                return;
            }

            state.currentViewData = tx;

            const content = document.getElementById('viewExpenseContent');
            const symbol = getCurrencySymbol(tx.account);
            const date = tx.transaction_date ? new Date(tx.transaction_date).toLocaleString() : 'N/A';

            content.innerHTML = `
                <div class="view-detail-row">
                    <span class="label">Expense #</span>
                    <span class="value"><strong>${tx.transaction_number || 'N/A'}</strong></span>
                </div>
                <div class="view-detail-row">
                    <span class="label">Date</span>
                    <span class="value">${date}</span>
                </div>
                <div class="view-detail-row">
                    <span class="label">Account</span>
                    <span class="value"><span class="account-badge ${tx.account === 'Bank (ZMW)' ? 'account-zmw' : 'account-petty-cash'}">${tx.account}</span></span>
                </div>
                <div class="view-detail-row">
                    <span class="label">Category</span>
                    <span class="value"><strong>${tx.expense_category || 'Uncategorized'}</strong></span>
                </div>
                <div class="view-detail-row">
                    <span class="label">Amount</span>
                    <span class="value" style="font-weight: 700; font-size: 1.2rem; color: #dc2626;">
                        - ${symbol} ${formatNumber(tx.amount)}
                    </span>
                </div>
                <div class="view-detail-row">
                    <span class="label">Description</span>
                    <span class="value">${tx.description || '-'}</span>
                </div>
                <div class="view-detail-row">
                    <span class="label">Reference</span>
                    <span class="value">${tx.reference || '-'}</span>
                </div>
                ${tx.notes ? `
                <div class="view-detail-row">
                    <span class="label">Notes</span>
                    <span class="value">${tx.notes}</span>
                </div>
                ` : ''}
                <div class="view-detail-row" style="border-bottom: none;">
                    <span class="label">Created</span>
                    <span class="value" style="font-size: 0.8rem; color: #94a3b8;">${new Date(tx.created_at).toLocaleString()}</span>
                </div>
            `;

            document.getElementById('viewExpenseModal').classList.add('show');
        } catch (error) {
            console.error('Error viewing expense:', error);
            showToast('Error loading expense details: ' + error.message, 'error');
        }
    }

    function printExpense() {
        const tx = state.currentViewData;
        if (!tx) {
            showToast('No expense to print', 'error');
            return;
        }

        const symbol = getCurrencySymbol(tx.account);
        const date = tx.transaction_date ? new Date(tx.transaction_date).toLocaleString() : 'N/A';

        const printContent = `
            <div style="font-family: 'Courier New', monospace; padding: 20px; max-width: 400px; margin: 0 auto;">
                <div style="text-align: center; border-bottom: 2px dashed #333; padding-bottom: 10px; margin-bottom: 15px;">
                    <h2 style="margin: 0; font-size: 1.2rem;">${companySettings.company_name}</h2>
                    <p style="margin: 3px 0; font-size: 0.85rem; color: #475569;">Expense Voucher</p>
                </div>
                <div style="font-size: 0.85rem;">
                    <div style="padding: 3px 0;"><strong>Expense #:</strong> ${tx.transaction_number || 'N/A'}</div>
                    <div style="padding: 3px 0;"><strong>Date:</strong> ${date}</div>
                    <div style="padding: 3px 0;"><strong>Account:</strong> ${tx.account}</div>
                    <div style="padding: 3px 0;"><strong>Category:</strong> ${tx.expense_category || 'Uncategorized'}</div>
                    <div style="padding: 3px 0; font-size: 1.1rem; font-weight: 700; color: #dc2626;">
                        <strong>Amount:</strong> - ${symbol} ${formatNumber(tx.amount)}
                    </div>
                    <div style="padding: 3px 0;"><strong>Description:</strong> ${tx.description || '-'}</div>
                    <div style="padding: 3px 0;"><strong>Reference:</strong> ${tx.reference || '-'}</div>
                    ${tx.notes ? `<div style="padding: 3px 0;"><strong>Notes:</strong> ${tx.notes}</div>` : ''}
                </div>
                <div style="text-align: center; margin-top: 20px; padding-top: 15px; border-top: 2px dashed #333; font-size: 0.8rem; color: #64748b;">
                    <p>This is a computer-generated expense voucher.</p>
                    <p>Generated on: ${new Date().toLocaleString()}</p>
                </div>
            </div>
        `;

        const printWindow = window.open('', '_blank', 'width=420,height=600');
        if (!printWindow) {
            showToast('Please allow popups to print', 'error');
            return;
        }

        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Expense Voucher - ${tx.transaction_number}</title>
                <style>
                    body { font-family: 'Courier New', monospace; padding: 20px; max-width: 400px; margin: 0 auto; background: white; }
                    @media print {
                        body { margin: 0; padding: 10px; }
                    }
                </style>
            </head>
            <body>
                ${printContent}
                <script>
                    window.onload = function() {
                        window.print();
                    };
                <\/script>
            </body>
            </html>
        `);
        printWindow.document.close();
        setTimeout(() => {
            printWindow.focus();
        }, 500);
    }

    // ============================================
    // SAVE EXPENSE
    // ============================================

    async function saveExpense() {
        const editId = document.getElementById('editExpenseId').value;
        const account = document.getElementById('expenseAccount').value;
        const category = document.getElementById('expenseCategory').value;
        const amount = parseFloat(document.getElementById('expenseAmount').value);
        const description = document.getElementById('expenseDescription').value.trim();
        const reference = document.getElementById('expenseReference').value.trim();
        const date = document.getElementById('expenseDate').value;
        const notes = document.getElementById('expenseNotes').value.trim();

        // Validation
        if (!account) {
            showToast('Please select an account', 'error');
            return;
        }
        if (!category) {
            showToast('Please select an expense category', 'error');
            return;
        }
        if (!amount || amount <= 0) {
            showToast('Please enter a valid amount', 'error');
            return;
        }
        if (!description) {
            showToast('Please enter a description', 'error');
            return;
        }
        if (!date) {
            showToast('Please select a date', 'error');
            return;
        }

        // Generate transaction number
        const txNumber = editId ?
            (state.expenses.find(t => t.id === editId)?.transaction_number || `EXP-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`) :
            `EXP-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;

        // 🔥 ADDED: this had no double-submit guard at all -- a double
        // click/press on "Record Expense" fired saveExpense() twice before
        // the first call's cash_transactions insert even came back, each
        // generating its OWN random transaction number and posting its OWN
        // full GL entry, so one click could silently record (and post) the
        // same expense twice. Locking the button the moment a save
        // genuinely starts closes that window, same fix already applied to
        // retail POS's saveTransaction().
        //
        // 🔥 ADDED: on top of disabling the button, this now also swaps its
        // visible label to a spinner + "Saving..." so there is an obvious,
        // impossible-to-miss visual signal that the save is in progress --
        // previously the button just silently sat there disabled with no
        // change in appearance, so users couldn't tell a click had even
        // registered and would click again.
        const saveExpenseBtn = document.getElementById('saveExpenseBtn');
        if (saveExpenseBtn) {
            if (saveExpenseBtn.disabled) {
                // Already saving -- ignore this extra click/press entirely.
                return;
            }
            saveExpenseBtn.disabled = true;
            saveExpenseBtn.dataset.originalHtml = saveExpenseBtn.innerHTML;
            saveExpenseBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
        }

        const txData = {
            transaction_number: txNumber,
            type: 'Payment',
            account: account,
            amount: amount,
            description: description,
            reference: reference || null,
            transaction_date: date,
            notes: notes || null,
            related_to: 'Expense',
            expense_category: category,
            updated_at: new Date().toISOString()
        };

        try {
            let result;
            if (editId) {
                // 🔥 FIX: editing an expense now reverses the OLD posted
                // GL entry and posts a fresh one for the new values,
                // instead of just silently updating the cash_transactions
                // row while the ledger kept the stale original numbers.
                await reverseExpenseGLEntries(txNumber);

                const { data, error } = await supabaseClient
                    .from('cash_transactions')
                    .update(txData)
                    .eq('id', editId)
                    .select();

                if (error) throw error;
                result = data;

                await ensureChartOfAccounts();
                await createExpenseGLEntry(txNumber, date, account, category, amount);

                showToast('Expense updated successfully!', 'success');
            } else {
                txData.created_at = new Date().toISOString();
                const { data, error } = await supabaseClient
                    .from('cash_transactions')
                    .insert([txData])
                    .select();

                if (error) throw error;
                result = data;

                await ensureChartOfAccounts();
                await createExpenseGLEntry(txNumber, date, account, category, amount);

                showToast('Expense recorded successfully!', 'success');
            }

            closeModal('expenseModal');
            await refreshExpenseData();

        } catch (error) {
            console.error('Error saving expense:', error);
            showToast('Error saving expense: ' + error.message, 'error');
        } finally {
            // 🔥 ADDED: guaranteed to run whether the save succeeded or
            // failed -- the button is never left stuck disabled or stuck
            // showing "Saving...".
            if (saveExpenseBtn) {
                saveExpenseBtn.disabled = false;
                if (saveExpenseBtn.dataset.originalHtml) {
                    saveExpenseBtn.innerHTML = saveExpenseBtn.dataset.originalHtml;
                    delete saveExpenseBtn.dataset.originalHtml;
                }
            }
        }
    }

    // ============================================
    // UI HELPERS
    // ============================================

    function updateExpenseCurrencySymbol() {
        const account = document.getElementById('expenseAccount').value;
        const symbol = getCurrencySymbol(account);
        document.getElementById('expenseCurrencySymbol').textContent = symbol;
        updateExpenseSummary();
    }

    function updateExpenseSummary() {
        const account = document.getElementById('expenseAccount').value;
        const amount = parseFloat(document.getElementById('expenseAmount').value) || 0;
        const category = document.getElementById('expenseCategory').value;
        const symbol = getCurrencySymbol(account);

        const summaryDiv = document.getElementById('expenseSummary');
        
        if (account && amount > 0) {
            summaryDiv.style.display = 'block';
            document.getElementById('expenseAccountSummary').textContent = account;
            document.getElementById('expenseAmountSummary').textContent = `${symbol} ${formatNumber(amount)}`;
            document.getElementById('expenseCategorySummary').textContent = category || '-';
        } else {
            summaryDiv.style.display = 'none';
        }
    }

    // ============================================
    // REFRESH
    // ============================================

    async function refreshExpenseData() {
        await loadExpenses();
        renderStats();
        renderExpenses();
    }

    // ============================================
    // UTILITY FUNCTIONS
    // ============================================

    function formatNumber(num) {
        return (num || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function closeModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) modal.classList.remove('show');
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

        // Update summary on input change
        document.getElementById('expenseAccount').addEventListener('change', updateExpenseSummary);
        document.getElementById('expenseAmount').addEventListener('input', updateExpenseSummary);
        document.getElementById('expenseCategory').addEventListener('change', updateExpenseSummary);

        // Update currency symbol when account changes
        document.getElementById('expenseAccount').addEventListener('change', updateExpenseCurrencySymbol);

        // Auto-fill description from category
        document.getElementById('expenseCategory').addEventListener('change', function() {
            const desc = document.getElementById('expenseDescription');
            if (!desc.value.trim()) {
                const category = this.options[this.selectedIndex]?.text || '';
                if (category && category !== 'Select Category') {
                    const cleanCategory = category.split(' ').slice(1).join(' ') || category;
                    desc.value = `Expense: ${cleanCategory}`;
                }
            }
        });

        // Filters
        document.getElementById('searchExpense')?.addEventListener('input', applyExpenseFilters);
        document.getElementById('expenseCategoryFilter')?.addEventListener('change', applyExpenseFilters);
        document.getElementById('expenseAccountFilter')?.addEventListener('change', applyExpenseFilters);
        document.getElementById('expenseStartDate')?.addEventListener('change', applyExpenseFilters);
        document.getElementById('expenseEndDate')?.addEventListener('change', applyExpenseFilters);
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
    window.openNewExpense = openNewExpense;
    window.editExpense = editExpense;
    window.deleteExpense = deleteExpense;
    window.viewExpense = viewExpense;
    window.printExpense = printExpense;
    window.saveExpense = saveExpense;
    window.applyExpenseFilters = applyExpenseFilters;
    window.refreshExpenseData = refreshExpenseData;
    window.closeModal = closeModal;
    window.showToast = showToast;
    window.updateExpenseSummary = updateExpenseSummary;
    window.updateExpenseCurrencySymbol = updateExpenseCurrencySymbol;

    // ============================================
    // INITIALIZE
    // ============================================
    await ensureChartOfAccounts();
    await loadExpenses();
    renderStats();
    renderExpenses();
    setupEventListeners();

    console.log("✅ Expense Management initialized successfully!");
    console.log(`💳 ${state.expenses.length} expenses loaded`);
})();

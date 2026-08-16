// ============================================
// JOURNAL ENTRY MODULE - COMPLETE
// ============================================

(async function initJournal() {
    console.log("📝 Journal Entry module initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    // ============================================
    // GLOBAL STATE
    // ============================================
    const state = {
        journalEntries: [],
        journalLines: [],
        accounts: [],
        isEditing: false
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

    async function loadJournalEntries() {
        try {
            const { data, error } = await supabaseClient
                .from('journal_entries')
                .select(`
                    *,
                    journal_lines (*)
                `)
                .order('entry_date', { ascending: false });

            if (error) throw error;
            state.journalEntries = data || [];
            return state.journalEntries;
        } catch (error) {
            console.error('Error loading journal entries:', error);
            state.journalEntries = [];
            return [];
        }
    }

    // ============================================
    // RENDER FUNCTIONS
    // ============================================

    function renderJournalEntries() {
        const tbody = document.getElementById('journalTableBody');
        const countSpan = document.getElementById('entryCount');
        const countMain = document.getElementById('journalCount');
        
        if (!tbody) return;

        if (state.journalEntries.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 40px; color: #94a3b8;">
                <i class="fa-regular fa-file-lines" style="font-size: 2rem; display: block; margin-bottom: 10px;"></i>
                No journal entries found
            </td></tr>`;
            if (countSpan) countSpan.textContent = '0 entries';
            if (countMain) countMain.textContent = '0 entries';
            return;
        }

        tbody.innerHTML = state.journalEntries.slice(0, 50).map(entry => {
            const lines = entry.journal_lines || [];
            const totalDebit = lines.reduce((sum, l) => sum + (l.debit || 0), 0);
            const totalCredit = lines.reduce((sum, l) => sum + (l.credit || 0), 0);
            const isBalanced = Math.abs(totalDebit - totalCredit) < 0.01;

            return `
            <tr>
                <td>${formatDate(entry.entry_date)}</td>
                <td><strong>${entry.journal_number || 'JNL-' + entry.id.slice(0, 8)}</strong></td>
                <td>${entry.description || '-'}</td>
                <td style="text-align: right; color: #dc2626;">${formatNumber(totalDebit)}</td>
                <td style="text-align: right; color: #22c55e;">${formatNumber(totalCredit)}</td>
                <td style="text-align: center;">
                    <span class="status-badge ${isBalanced ? 'status-approved' : 'status-draft'}">
                        ${isBalanced ? '✅ Balanced' : '⚠️ Unbalanced'}
                    </span>
                </td>
                <td style="text-align: center;">
                    <button class="action-btn" onclick="viewJournalEntry('${entry.id}')" title="View">
                        <i class="fa-regular fa-eye"></i>
                    </button>
                    <button class="action-btn" onclick="editJournalEntry('${entry.id}')" title="Edit">
                        <i class="fa-regular fa-pen-to-square"></i>
                    </button>
                    <button class="action-btn" onclick="deleteJournalEntry('${entry.id}')" title="Delete" style="color: #ef4444;">
                        <i class="fa-regular fa-trash-can"></i>
                    </button>
                </td>
            </tr>
            `;
        }).join('');

        if (countSpan) countSpan.textContent = `${state.journalEntries.length} entries`;
        if (countMain) countMain.textContent = `${state.journalEntries.length} entries`;
    }

    // ============================================
    // JOURNAL ENTRY FORM FUNCTIONS
    // ============================================

    function openNewJournalEntry() {
        state.journalLines = [];
        state.isEditing = false;
        resetJournalForm();
        renderJournalLines();
        updateJournalSummary();
        document.getElementById('journalModal').classList.add('show');
    }

    function resetJournalForm() {
        const editId = document.getElementById('editJournalId');
        const date = document.getElementById('journalDate');
        const ref = document.getElementById('journalReference');
        const desc = document.getElementById('journalDescription');
        const title = document.getElementById('journalModalTitle');
        
        if (editId) editId.value = '';
        if (date) date.value = new Date().toISOString().split('T')[0];
        if (ref) ref.value = '';
        if (desc) desc.value = '';
        if (title) title.innerHTML = '<i class="fa-solid fa-feather-pointed"></i> New Journal Entry';
        
        state.journalLines = [];
        state.isEditing = false;
        renderJournalLines();
        updateJournalSummary();
    }

    function addJournalLine(accountCode = '', description = '', debit = '', credit = '') {
        state.journalLines.push({
            id: Date.now(),
            account_code: accountCode || '',
            description: description || '',
            debit: parseFloat(debit) || 0,
            credit: parseFloat(credit) || 0
        });
        renderJournalLines();
        updateJournalSummary();
    }

    function addContraEntry() {
        // Add a contra entry (one debit, one credit for same amount)
        // This is a helper for common journal entries
        const lastLine = state.journalLines[state.journalLines.length - 1];
        if (lastLine && (lastLine.debit > 0 || lastLine.credit > 0)) {
            const amount = lastLine.debit > 0 ? lastLine.debit : lastLine.credit;
            const contraAccount = lastLine.account_code;
            
            // Find a different account for contra
            const otherAccount = state.accounts.find(a => a.code !== contraAccount);
            if (otherAccount) {
                addJournalLine(
                    otherAccount.code,
                    'Contra entry for ' + (lastLine.description || ''),
                    lastLine.debit > 0 ? 0 : amount,
                    lastLine.debit > 0 ? amount : 0
                );
            } else {
                showToast('No other account found for contra entry', 'warning');
            }
        } else {
            showToast('Add a debit or credit line first', 'warning');
        }
    }

    function removeJournalLine(index) {
        state.journalLines.splice(index, 1);
        renderJournalLines();
        updateJournalSummary();
    }

    function renderJournalLines() {
        const tbody = document.getElementById('journalLinesBody');
        const countSpan = document.getElementById('journalLineCount');
        
        if (!tbody) return;

        if (state.journalLines.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="6" class="text-center text-muted" style="padding: 30px;">
                        <i class="fa-regular fa-plus" style="display: block; margin-bottom: 8px; font-size: 1.5rem;"></i>
                        Add journal lines below
                    </td>
                </tr>
            `;
            if (countSpan) countSpan.textContent = '0 lines';
            return;
        }

        const accountOptions = state.accounts
            .filter(a => a.is_active !== false)
            .sort((a, b) => a.code.localeCompare(b.code))
            .map(a => `<option value="${a.code}">${a.code} - ${a.name}</option>`)
            .join('');

        tbody.innerHTML = state.journalLines.map((line, index) => `
            <tr>
                <td>${index + 1}</td>
                <td>
                    <select class="form-control" style="width: 100%; min-width: 200px;" 
                        onchange="updateJournalLine(${index}, 'account_code', this.value)">
                        <option value="">Select Account</option>
                        ${accountOptions}
                    </select>
                    <span style="font-size: 0.65rem; color: #94a3b8; display: block;">
                        ${line.account_code ? getAccountName(line.account_code) : ''}
                    </span>
                </td>
                <td>
                    <input type="text" class="form-control" value="${line.description || ''}" 
                        style="width: 100%;" 
                        onchange="updateJournalLine(${index}, 'description', this.value)"
                        placeholder="Line description">
                </td>
                <td style="text-align: right;">
                    <input type="number" class="form-control" value="${line.debit || ''}" 
                        style="width: 120px; text-align: right; display: inline-block;" 
                        onchange="updateJournalLine(${index}, 'debit', parseFloat(this.value) || 0)"
                        step="0.01" min="0" placeholder="0.00">
                </td>
                <td style="text-align: right;">
                    <input type="number" class="form-control" value="${line.credit || ''}" 
                        style="width: 120px; text-align: right; display: inline-block;" 
                        onchange="updateJournalLine(${index}, 'credit', parseFloat(this.value) || 0)"
                        step="0.01" min="0" placeholder="0.00">
                </td>
                <td style="text-align: center;">
                    <button class="action-btn" onclick="removeJournalLine(${index})" style="color: #ef4444;">
                        <i class="fa-regular fa-trash-can"></i>
                    </button>
                </td>
            </tr>
        `).join('');

        if (countSpan) countSpan.textContent = `${state.journalLines.length} lines`;
    }

    function updateJournalLine(index, field, value) {
        if (index >= 0 && index < state.journalLines.length) {
            state.journalLines[index][field] = value;
            updateJournalSummary();
        }
    }

    function updateJournalSummary() {
        const totalDebit = state.journalLines.reduce((sum, l) => sum + (l.debit || 0), 0);
        const totalCredit = state.journalLines.reduce((sum, l) => sum + (l.credit || 0), 0);
        const difference = totalDebit - totalCredit;

        const debitEl = document.getElementById('journalTotalDebit');
        const creditEl = document.getElementById('journalTotalCredit');
        const diffEl = document.getElementById('journalDifference');
        
        if (debitEl) debitEl.textContent = `$${formatNumber(totalDebit)}`;
        if (creditEl) creditEl.textContent = `$${formatNumber(totalCredit)}`;
        
        if (diffEl) {
            diffEl.textContent = `$${formatNumber(Math.abs(difference))}`;
            diffEl.style.color = Math.abs(difference) < 0.01 ? '#22c55e' : '#dc2626';
            const parent = diffEl.parentElement;
            if (parent) {
                parent.className = `journal-summary-item total ${Math.abs(difference) < 0.01 ? 'balanced' : 'unbalanced'}`;
            }
        }
    }

    function getAccountName(code) {
        const account = state.accounts.find(a => a.code === code);
        return account ? account.name : '';
    }

    // ============================================
    // SAVE JOURNAL ENTRY
    // ============================================

    async function saveJournalEntry() {
        const entryDate = document.getElementById('journalDate')?.value;
        const reference = document.getElementById('journalReference')?.value.trim();
        const description = document.getElementById('journalDescription')?.value.trim();

        if (!entryDate) {
            showToast('Please select an entry date', 'error');
            return;
        }
        if (!description) {
            showToast('Please enter a description', 'error');
            return;
        }

        const validLines = state.journalLines.filter(l => l.account_code && (l.debit > 0 || l.credit > 0));
        if (validLines.length === 0) {
            showToast('Please add at least one valid journal line', 'error');
            return;
        }

        const totalDebit = validLines.reduce((sum, l) => sum + (l.debit || 0), 0);
        const totalCredit = validLines.reduce((sum, l) => sum + (l.credit || 0), 0);
        
        if (Math.abs(totalDebit - totalCredit) > 0.01) {
            showToast(`Journal entry is not balanced! Debit: ${formatNumber(totalDebit)}, Credit: ${formatNumber(totalCredit)}`, 'error');
            return;
        }

        try {
            const isEditing = document.getElementById('editJournalId')?.value !== '';
            const journalId = isEditing ? document.getElementById('editJournalId').value : null;

            const journalData = {
                entry_date: entryDate,
                reference: reference || null,
                description: description,
                journal_number: `JNL-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
                status: 'Posted'
            };

            let result;
            if (isEditing && journalId) {
                const { error } = await supabaseClient
                    .from('journal_entries')
                    .update(journalData)
                    .eq('id', journalId);

                if (error) throw error;

                await supabaseClient
                    .from('journal_lines')
                    .delete()
                    .eq('journal_entry_id', journalId);

                result = { id: journalId };
            } else {
                const { data, error } = await supabaseClient
                    .from('journal_entries')
                    .insert([journalData])
                    .select();

                if (error) throw error;
                result = data[0];
            }

            const linesToInsert = validLines.map(line => ({
                journal_entry_id: result.id,
                account_code: line.account_code,
                description: line.description || '',
                debit: line.debit || 0,
                credit: line.credit || 0
            }));

            const { error: lineError } = await supabaseClient
                .from('journal_lines')
                .insert(linesToInsert);

            if (lineError) throw lineError;

            showToast('Journal entry posted successfully!', 'success');
            closeModal('journalModal');
            await refreshJournal();
        } catch (error) {
            console.error('Error saving journal entry:', error);
            showToast('Error saving journal entry: ' + error.message, 'error');
        }
    }

    // ============================================
    // VIEW/EDIT/DELETE JOURNAL ENTRY
    // ============================================

    async function viewJournalEntry(entryId) {
        try {
            const { data: entry, error } = await supabaseClient
                .from('journal_entries')
                .select(`
                    *,
                    journal_lines (*)
                `)
                .eq('id', entryId)
                .single();

            if (error) throw error;

            let message = `📋 Journal Entry: ${entry.journal_number}\n`;
            message += `📅 Date: ${formatDate(entry.entry_date)}\n`;
            message += `📝 Description: ${entry.description}\n`;
            message += `🔗 Reference: ${entry.reference || 'N/A'}\n\n`;
            message += `Lines:\n`;
            entry.journal_lines.forEach((l, i) => {
                const account = state.accounts.find(a => a.code === l.account_code);
                message += `${i+1}. ${l.account_code} ${account?.name || ''} | Debit: ${formatNumber(l.debit)} | Credit: ${formatNumber(l.credit)}\n`;
            });
            
            const totalDebit = entry.journal_lines.reduce((sum, l) => sum + (l.debit || 0), 0);
            const totalCredit = entry.journal_lines.reduce((sum, l) => sum + (l.credit || 0), 0);
            message += `\nTotal Debit: ${formatNumber(totalDebit)} | Total Credit: ${formatNumber(totalCredit)}`;
            message += `\nStatus: ${Math.abs(totalDebit - totalCredit) < 0.01 ? '✅ Balanced' : '⚠️ Unbalanced'}`;

            alert(message);
        } catch (error) {
            console.error('Error viewing journal entry:', error);
            showToast('Error loading journal entry: ' + error.message, 'error');
        }
    }

    async function editJournalEntry(entryId) {
        try {
            const { data: entry, error } = await supabaseClient
                .from('journal_entries')
                .select(`
                    *,
                    journal_lines (*)
                `)
                .eq('id', entryId)
                .single();

            if (error) throw error;

            state.isEditing = true;
            state.journalLines = entry.journal_lines || [];

            document.getElementById('editJournalId').value = entry.id;
            document.getElementById('journalDate').value = entry.entry_date;
            document.getElementById('journalReference').value = entry.reference || '';
            document.getElementById('journalDescription').value = entry.description || '';
            document.getElementById('journalModalTitle').innerHTML = `<i class="fa-solid fa-pen-to-square"></i> Edit Journal Entry: ${entry.journal_number}`;

            renderJournalLines();
            updateJournalSummary();
            document.getElementById('journalModal').classList.add('show');
        } catch (error) {
            console.error('Error loading journal entry for edit:', error);
            showToast('Error loading journal entry: ' + error.message, 'error');
        }
    }

    async function deleteJournalEntry(entryId) {
        if (!confirm('Are you sure you want to delete this journal entry?')) return;

        try {
            await supabaseClient
                .from('journal_lines')
                .delete()
                .eq('journal_entry_id', entryId);

            const { error } = await supabaseClient
                .from('journal_entries')
                .delete()
                .eq('id', entryId);

            if (error) throw error;

            showToast('Journal entry deleted successfully', 'success');
            await refreshJournal();
        } catch (error) {
            console.error('Error deleting journal entry:', error);
            showToast('Error deleting journal entry: ' + error.message, 'error');
        }
    }

    // ============================================
    // REFRESH
    // ============================================

    async function refreshJournal() {
        await loadJournalEntries();
        renderJournalEntries();
    }

    // ============================================
    // UTILITY FUNCTIONS
    // ============================================

    function formatNumber(num) {
        return (num || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

    function closeModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) modal.classList.remove('show');
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
                to { transform: translateX(0%); opacity: 1; }
            }
            @keyframes slideOut {
                from { transform: translateX(0%); opacity: 1; }
                to { transform: translateX(100%); opacity: 0; }
            }
        `;
        document.head.appendChild(style);
    }

    // ============================================
    // EXPOSE TO GLOBAL SCOPE
    // ============================================
    window.openNewJournalEntry = openNewJournalEntry;
    window.saveJournalEntry = saveJournalEntry;
    window.viewJournalEntry = viewJournalEntry;
    window.editJournalEntry = editJournalEntry;
    window.deleteJournalEntry = deleteJournalEntry;
    window.addJournalLine = addJournalLine;
    window.addContraEntry = addContraEntry;
    window.removeJournalLine = removeJournalLine;
    window.updateJournalLine = updateJournalLine;
    window.resetJournalForm = resetJournalForm;
    window.refreshJournal = refreshJournal;
    window.closeModal = closeModal;
    window.showToast = showToast;

    // ============================================
    // INITIALIZE
    // ============================================
    await loadAccounts();
    await loadJournalEntries();
    renderJournalEntries();
    setupEventListeners();

    console.log("✅ Journal Entry module initialized successfully!");
    console.log(`📝 Loaded ${state.journalEntries.length} journal entries`);
    console.log(`📊 Loaded ${state.accounts.length} accounts`);
})();
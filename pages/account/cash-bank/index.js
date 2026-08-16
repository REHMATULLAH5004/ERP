// ============================================
// CASH & BANK MANAGEMENT MODULE (TRANSFER ONLY)
// ============================================

// Global references so HTML buttons work
// 🔥 FIX: this is an SPA -- navigating away and back to this page
// re-executes this whole script. 'let' at top-level scope collides with
// itself on re-execution ("Identifier 'state' has already been
// declared"), a SyntaxError that aborts the ENTIRE script before
// anything -- including window.openOpeningBalanceModal -- ever gets
// defined. 'var' can be safely redeclared; the typeof guard on
// exchangeRate additionally avoids resetting it back to defaults on a
// re-run (state gets fully reassigned inside the IIFE regardless, so it
// doesn't need the same guard).
if (typeof state === 'undefined') { var state = {}; }
if (typeof exchangeRate === 'undefined') { var exchangeRate = { zmwPerUsd: 25.00 }; }

(async function initCashPage() {
    console.log("💰 Cash & Bank Management initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    // ============================================
    // GLOBAL STATE
    // ============================================
    state = {
        // 🔥 FIX: consolidated to a single stored rate (ZMW per USD).
        // Previously usdToZmw and zmwToUsd were entered and stored
        // separately -- nothing forced them to actually be each other's
        // inverse, so they could drift apart. zmwToUsd is now always
        // computed from zmwPerUsd, never entered independently.
        exchangeRate: {
            zmwPerUsd: 25.00
        },
        glJournalLines: [],
        glAccounts: {} // Stores the real COA codes from your DB
    };

    // ============================================
    // LOAD CHART OF ACCOUNTS FOR GL MAPPING (FIXED)
    // ============================================

    async function loadGLAccounts() {
        try {
            const { data, error } = await supabaseClient
                .from('chart_of_accounts')
                .select('code, name')
                .in('code', ['1111', '1120', '1121']);

            if (error) throw error;

            const mapping = {};
            (data || []).forEach(acc => {
                mapping[acc.code] = acc.name;
            });

            state.glAccounts = {
                '1111': mapping['1111'] || 'Cash in Hand (ZMW)',
                '1120': mapping['1120'] || 'Bank - USD',
                '1121': mapping['1121'] || 'Bank - ZMW'
            };
            
            console.log("✅ GL Account Mapping loaded:", state.glAccounts);
        } catch (error) {
            console.error('Error loading GL accounts:', error);
            state.glAccounts = {
                '1111': 'Cash in Hand (ZMW)',
                '1120': 'Bank - USD',
                '1121': 'Bank - ZMW'
            };
        }
    }

    // ============================================
    // ACCOUNT CONFIGURATION
    // ============================================
    const ACCOUNT_CURRENCY_MAP = {
        '1111': { currency: 'ZMW', symbol: 'ZK' },
        '1120': { currency: 'USD', symbol: '$' },
        '1121': { currency: 'ZMW', symbol: 'ZK' }
    };

    function getCurrencySymbol(accountCode) {
        return ACCOUNT_CURRENCY_MAP[accountCode]?.symbol || 'ZK';
    }

    function getCurrency(accountCode) {
        return ACCOUNT_CURRENCY_MAP[accountCode]?.currency || 'ZMW';
    }

    // ============================================
    // LOAD DATA FROM GL
    // ============================================

    async function loadGLJournalLines() {
        try {
            const codes = ['1111', '1120', '1121'];

            // ✅ FIXED: Using foreignTable syntax for Supabase sorting
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
                .in('account_code', codes)
                .eq('journal_entries.status', 'Posted')
                .order('entry_date', { ascending: false, foreignTable: 'journal_entries' });

            if (error) throw error;
            
            state.glJournalLines = data || [];
            
            const foundCodes = [...new Set(data.map(l => l.account_code))];
            console.log(`✅ Loaded ${state.glJournalLines.length} GL lines for Cash/Bank.`);
            console.log(`   Found balances in these GL Codes: ${foundCodes.join(', ')}`);
            
        } catch (error) {
            console.error('Error loading GL journal lines:', error);
            state.glJournalLines = [];
        }
    }

    async function loadExchangeRate() {
        try {
            const { data, error } = await supabaseClient
                .from('exchange_rates')
                .select('*')
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            if (!error && data) {
                // usd_to_zmw IS the ZMW-per-USD rate -- same number, just
                // read from the existing column name for compatibility.
                state.exchangeRate.zmwPerUsd = parseFloat(data.usd_to_zmw) || 25.00;
                updateExchangeRateDisplay();
            }
        } catch (error) {
            console.log('Using default exchange rates');
        }
    }

    // ============================================
    // RENDER FUNCTIONS
    // ============================================

    function renderBalances() {
        const balances = { '1111': 0, '1120': 0, '1121': 0 };
        const counts = { '1111': 0, '1120': 0, '1121': 0 };

        state.glJournalLines.forEach(line => {
            if (balances[line.account_code] !== undefined) {
                balances[line.account_code] += (line.debit || 0) - (line.credit || 0);
                counts[line.account_code]++;
            }
        });

        document.getElementById('cashBalance').textContent = `ZK ${formatNumber(balances['1111'])}`;
        // 🔥 ADDED: shows the ZMW-equivalent alongside the raw USD
        // balance, for reference -- the actual balance stays in USD
        // (that's what's really in the account), this is just a
        // conversion at today's rate, not a stored or calculated value.
        const usdZmwEquivalent = balances['1120'] * state.exchangeRate.zmwPerUsd;
        document.getElementById('usdBalance').textContent = `$ ${formatNumber(balances['1120'])} (ZK ${formatNumber(usdZmwEquivalent)})`;
        document.getElementById('zmwBalance').textContent = `ZK ${formatNumber(balances['1121'])}`;

        document.getElementById('cashCount').textContent = `${counts['1111']} GL tx`;
        document.getElementById('usdCount').textContent = `${counts['1120']} GL tx`;
        document.getElementById('zmwCount').textContent = `${counts['1121']} GL tx`;

        // 🔥 ADDED: clicking a stat card shows that account's full
        // statement -- reuses the existing account filter + transaction
        // table rather than building a separate statement view, since
        // that filter already does exactly this.
        wireStatCardClick('cashBalance', '1111');
        wireStatCardClick('usdBalance', '1120');
        wireStatCardClick('zmwBalance', '1121');
    }

    function wireStatCardClick(elementId, accountCode) {
        const el = document.getElementById(elementId);
        if (!el) return;
        const card = el.closest('.balance-card') || el;
        if (card.dataset.clickWired) return; // avoid stacking listeners on re-render
        card.dataset.clickWired = 'true';
        card.style.cursor = 'pointer';
        card.addEventListener('click', () => {
            const filterEl = document.getElementById('accountFilter');
            if (filterEl) {
                filterEl.value = accountCode;
                renderTransactions();
            }
            const table = document.getElementById('transactionTableBody');
            if (table) table.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
    }

    function updateExchangeRateDisplay() {
        const rate = state.exchangeRate.zmwPerUsd;
        document.getElementById('usdToZmwRate').textContent = rate.toFixed(4);
        document.getElementById('zmwToUsdRate').textContent = (1 / rate).toFixed(4);
    }

    function renderTransactions() {
        const tbody = document.getElementById('transactionTableBody');
        const countSpan = document.getElementById('transactionListCount');
        const countMain = document.getElementById('transactionCount');

        if (!tbody) return;

        const accountFilter = document.getElementById('accountFilter')?.value || 'all';
        const startDate = document.getElementById('startDate')?.value;
        const endDate = document.getElementById('endDate')?.value;

        let filtered = state.glJournalLines;

        if (accountFilter !== 'all') {
            filtered = filtered.filter(line => line.account_code === accountFilter);
        }
        if (startDate) {
            filtered = filtered.filter(line => line.journal_entries?.entry_date >= startDate);
        }
        if (endDate) {
            filtered = filtered.filter(line => line.journal_entries?.entry_date <= endDate);
        }

        if (filtered.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 40px; color: #94a3b8;">
                <i class="fa-regular fa-circle-check" style="font-size: 2rem; display: block; margin-bottom: 10px;"></i>
                No transactions found in the General Ledger for these accounts.
            </td></tr>`;
            if (countSpan) countSpan.textContent = '0 transactions';
            if (countMain) countMain.textContent = '0 transactions';
            return;
        }

        let runningBalance = 0;

        tbody.innerHTML = filtered.map(line => {
            const amount = (line.debit || 0) - (line.credit || 0);
            runningBalance += amount;

            const date = line.journal_entries?.entry_date ? new Date(line.journal_entries.entry_date).toLocaleDateString() : 'N/A';
            const journalNo = line.journal_entries?.journal_number || '-';
            const accountName = state.glAccounts[line.account_code] || line.account_code;

            return `
            <tr>
                <td style="padding-left: 20px;">${date}</td>
                <td><strong>${line.account_code}</strong><br><span style="font-size: 0.7rem; color: #94a3b8;">${accountName}</span></td>
                <td>${line.description || '-'}</td>
                <td>${journalNo}</td>
                <td style="text-align: right; color: #dc2626;">${line.debit > 0 ? formatNumber(line.debit) : '-'}</td>
                <td style="text-align: right; color: #22c55e;">${line.credit > 0 ? formatNumber(line.credit) : '-'}</td>
                <td style="text-align: right; font-weight: 600; color: ${runningBalance >= 0 ? '#2563eb' : '#dc2626'};">
                    ${formatNumber(runningBalance)}
                </td>
            </tr>
            `;
        }).join('');

        if (countSpan) countSpan.textContent = `${filtered.length} transactions`;
        if (countMain) countMain.textContent = `${filtered.length} transactions`;
    }

    // ============================================
    // EXPOSED FUNCTIONS (FOR HTML BUTTONS)
    // ============================================

    window.openNewTransfer = function() {
        const modal = document.getElementById('transferModal');
        const form = document.getElementById('transferForm');

        form.reset();
        document.getElementById('editTransferId').value = '';
        document.getElementById('txDate').value = new Date().toISOString().split('T')[0];
        document.getElementById('txExchangeRate').value = state.exchangeRate.zmwPerUsd;
        
        document.getElementById('exchangeRateGroup').style.display = 'none';
        document.getElementById('convertedAmountDisplay').style.display = 'none';
        
        modal.classList.add('show');
    };

    // 🔥 ADDED: the account that absorbs the nominal difference on a
    // cross-currency transfer. Confirmed against real posted data that
    // recording K5000 on one side and $250 on the other (same
    // transaction, same rate, genuinely equal in value) leaves every
    // cross-currency transfer's own journal entry mathematically
    // unbalanced -- debits never equal credits within that single
    // entry, which is what actually broke the trial balance. This
    // account is not a real gain or loss (nothing was actually gained
    // or lost -- it's the same value, just expressed in two different
    // currencies), so it's classified as Equity, not Revenue/Expense.
    async function ensureTranslationAccount() {
        const { data: existing } = await supabaseClient
            .from('chart_of_accounts')
            .select('code')
            .eq('code', '3900')
            .maybeSingle();

        if (!existing) {
            await supabaseClient.from('chart_of_accounts').insert([{
                code: '3900',
                name: 'Currency Translation Reserve',
                type: 'Equity',
                category: 'Equity',
                normal_balance: 'Credit',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            }]);
        }
    }

    window.saveTransfer = async function() {
        const fromAccount = document.getElementById('fromAccount').value;
        const toAccount = document.getElementById('toAccount').value;
        const amount = parseFloat(document.getElementById('txAmount').value);
        const description = document.getElementById('txDescription').value.trim();
        const reference = document.getElementById('txReference').value.trim();
        const date = document.getElementById('txDate').value;
        const exchangeRate = parseFloat(document.getElementById('txExchangeRate').value);

        if (!fromAccount || !toAccount || fromAccount === toAccount) {
            showToast('Please select valid, different accounts for transfer', 'error'); return;
        }
        if (!amount || amount <= 0 || !description || !date) {
            showToast('Please fill in all required fields', 'error'); return;
        }

        const fromCurrency = getCurrency(fromAccount);
        const toCurrency = getCurrency(toAccount);
        if (fromCurrency !== toCurrency && (!exchangeRate || exchangeRate <= 0)) {
            showToast('Please enter a valid exchange rate for cross-currency transfer', 'error'); return;
        }

        try {
            const journalNumber = `TRANS-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;

            const journal = {
                entry_date: date,
                reference: reference || journalNumber,
                description: `Internal Transfer: ${description}`,
                journal_number: journalNumber,
                status: 'Posted',
                created_at: new Date().toISOString()
            };

            const { data: journalData, error: jError } = await supabaseClient
                .from('journal_entries')
                .insert([journal])
                .select();

            if (jError) throw jError;

            let amountToDebit = amount;
            if (fromCurrency !== toCurrency && exchangeRate > 0) {
                // 🔥 FIX: this used to always multiply by the entered
                // rate regardless of direction. The rate is always
                // entered as "ZMW per USD" -- converting ZMW into USD
                // means dividing by that rate, converting USD into ZMW
                // means multiplying by it. Applying the same multiply in
                // both directions silently produced the wrong destination
                // amount whenever the transfer went ZMW -> USD.
                amountToDebit = fromCurrency === 'USD'
                    ? amount * exchangeRate   // USD -> ZMW
                    : amount / exchangeRate;  // ZMW -> USD
            }

            const lines = [
                { journal_entry_id: journalData[0].id, account_code: fromAccount, debit: 0, credit: amount, description: `Transfer Out: ${description}` },
                { journal_entry_id: journalData[0].id, account_code: toAccount, debit: amountToDebit, credit: 0, description: `Transfer In: ${description}` }
            ];

            // 🔥 ADDED: for a cross-currency transfer, the two lines
            // above use different currencies' raw numbers (e.g. 5000
            // ZMW vs 250 USD) -- genuinely equal in value, but never
            // equal as numbers, so the entry is unbalanced without a
            // third line. Confirmed this is exactly what broke the
            // trial balance for every existing cross-currency transfer.
            if (fromCurrency !== toCurrency) {
                await ensureTranslationAccount();
                const totalDebit = lines.reduce((sum, l) => sum + l.debit, 0);
                const totalCredit = lines.reduce((sum, l) => sum + l.credit, 0);
                const diff = totalDebit - totalCredit;

                if (Math.abs(diff) > 0.01) {
                    lines.push({
                        journal_entry_id: journalData[0].id,
                        account_code: '3900',
                        debit: diff < 0 ? Math.abs(diff) : 0,
                        credit: diff > 0 ? diff : 0,
                        description: `Currency translation: ${description}`
                    });
                }
            }

            const { error: lineError } = await supabaseClient.from('journal_lines').insert(lines);
            if (lineError) throw lineError;

            showToast('Internal transfer posted successfully!', 'success');
            closeModal('transferModal');
            await refreshCashData();

        } catch (error) {
            console.error('Error saving transfer:', error);
            showToast('Error saving transfer: ' + error.message, 'error');
        }
    };

    window.applyFilters = function() {
        renderTransactions();
    };

    window.editExchangeRate = function() {
        document.getElementById('editZmwPerUsd').value = state.exchangeRate.zmwPerUsd;
        document.getElementById('exchangeRateModal').classList.add('show');
    };

    // ============================================
    // 🔥 ADDED: OPENING BALANCE
    // ============================================
    // Kept deliberately simple: one small modal, one number field per
    // account, one journal entry per non-zero field on submit --
    // Debit the account, Credit Opening Balance Equity (3000), same
    // pattern already used for suppliers elsewhere in this system.
    window.openOpeningBalanceModal = function() {
        ensureOpeningBalanceModal();
        document.getElementById('openingBalanceModal').classList.add('show');
    };

    function ensureOpeningBalanceModal() {
        if (document.getElementById('openingBalanceModal')) return;
        const html = `
        <div id="openingBalanceModal" class="modal">
            <div class="modal-dialog" style="max-width:420px;">
                <div style="background:white;padding:25px;border-radius:10px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                        <h4 style="margin:0;"><i class="fa-solid fa-coins" style="color:#f59e0b;"></i> Set Opening Balance</h4>
                        <button onclick="closeModal('openingBalanceModal')" style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:#94a3b8;">&times;</button>
                    </div>
                    <p style="color:#64748b;font-size:0.85rem;margin-bottom:16px;">Leave any field blank/zero to skip it. Only run this once per account -- running it again adds another opening entry on top.</p>
                    <div style="margin-bottom:12px;">
                        <label style="display:block;font-weight:500;color:#475569;margin-bottom:4px;font-size:0.85rem;">Cash in Hand (ZMW)</label>
                        <input type="number" id="obCash1111" step="0.01" min="0" placeholder="0.00" style="width:100%;padding:8px 10px;border:1px solid #e2e8f0;border-radius:6px;">
                    </div>
                    <div style="margin-bottom:12px;">
                        <label style="display:block;font-weight:500;color:#475569;margin-bottom:4px;font-size:0.85rem;">Bank (USD)</label>
                        <input type="number" id="obBank1120" step="0.01" min="0" placeholder="0.00" style="width:100%;padding:8px 10px;border:1px solid #e2e8f0;border-radius:6px;">
                    </div>
                    <div style="margin-bottom:12px;">
                        <label style="display:block;font-weight:500;color:#475569;margin-bottom:4px;font-size:0.85rem;">Bank (ZMW)</label>
                        <input type="number" id="obBank1121" step="0.01" min="0" placeholder="0.00" style="width:100%;padding:8px 10px;border:1px solid #e2e8f0;border-radius:6px;">
                    </div>
                    <div style="margin-bottom:16px;">
                        <label style="display:block;font-weight:500;color:#475569;margin-bottom:4px;font-size:0.85rem;">Date</label>
                        <input type="date" id="obDate" style="width:100%;padding:8px 10px;border:1px solid #e2e8f0;border-radius:6px;">
                    </div>
                    <div style="display:flex;gap:10px;justify-content:flex-end;">
                        <button onclick="closeModal('openingBalanceModal')" style="background:white;border:1px solid #e2e8f0;padding:8px 20px;border-radius:6px;cursor:pointer;">Cancel</button>
                        <button id="saveOpeningBalanceBtn" onclick="saveOpeningBalance()" style="background:#2563eb;color:white;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;">
                            <i class="fa-solid fa-floppy-disk"></i> Save
                        </button>
                    </div>
                </div>
            </div>
        </div>`;
        document.body.insertAdjacentHTML('beforeend', html);
        document.getElementById('openingBalanceModal').addEventListener('click', (e) => {
            if (e.target.id === 'openingBalanceModal') e.target.classList.remove('show');
        });
    }

    window.saveOpeningBalance = async function() {
        const date = document.getElementById('obDate').value || new Date().toISOString().split('T')[0];
        const entries = [
            { code: '1111', amount: parseFloat(document.getElementById('obCash1111').value) || 0 },
            { code: '1120', amount: parseFloat(document.getElementById('obBank1120').value) || 0 },
            { code: '1121', amount: parseFloat(document.getElementById('obBank1121').value) || 0 }
        ].filter(e => e.amount > 0);

        if (entries.length === 0) {
            showToast('Enter at least one opening balance amount', 'error');
            return;
        }

        const btn = document.getElementById('saveOpeningBalanceBtn');
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';

        try {
            for (const entry of entries) {
                const journalNumber = `OPEN-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
                const journal = {
                    entry_date: date,
                    reference: journalNumber,
                    description: `Opening balance - ${state.glAccounts[entry.code] || entry.code}`,
                    journal_number: journalNumber,
                    status: 'Posted',
                    created_at: new Date().toISOString()
                };
                const { data: journalData, error: jError } = await supabaseClient.from('journal_entries').insert([journal]).select();
                if (jError) throw jError;

                await supabaseClient.from('journal_lines').insert([
                    { journal_entry_id: journalData[0].id, account_code: entry.code, debit: entry.amount, credit: 0, description: 'Opening balance' },
                    { journal_entry_id: journalData[0].id, account_code: '3000', debit: 0, credit: entry.amount, description: `Opening balance - ${state.glAccounts[entry.code] || entry.code}` }
                ]);
            }

            showToast('Opening balance(s) posted successfully!', 'success');
            closeModal('openingBalanceModal');
            await refreshCashData();
        } catch (error) {
            console.error('Error saving opening balance:', error);
            showToast('Error saving opening balance: ' + error.message, 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save';
        }
    };

    window.saveExchangeRate = async function() {
        const zmwPerUsd = parseFloat(document.getElementById('editZmwPerUsd').value);

        if (!zmwPerUsd || zmwPerUsd <= 0) {
            showToast('Please enter a valid exchange rate', 'error'); return;
        }

        try {
            // 🔥 FIX: zmw_to_usd is now always the mathematical inverse
            // of usd_to_zmw, computed here rather than entered
            // separately -- the two columns can no longer disagree.
            const { error } = await supabaseClient
                .from('exchange_rates')
                .insert([{ usd_to_zmw: zmwPerUsd, zmw_to_usd: 1 / zmwPerUsd, created_at: new Date().toISOString() }]);

            if (error) throw error;

            state.exchangeRate.zmwPerUsd = zmwPerUsd;
            updateExchangeRateDisplay();
            showToast('Exchange rate updated!', 'success');
            closeModal('exchangeRateModal');
        } catch (error) {
            console.error('Error saving exchange rate:', error);
            showToast('Error saving exchange rate: ' + error.message, 'error');
        }
    };

    // ============================================
    // GLOBAL HELPER FUNCTIONS
    // ============================================

    window.refreshCashData = async function() {
        await loadGLAccounts();
        await loadGLJournalLines();
        await loadExchangeRate();
        renderBalances();
        renderTransactions();
        updateExchangeRateDisplay();
    };

    window.closeModal = function(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) modal.classList.remove('show');
    };

    window.showToast = function(message, type = 'success') {
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
    };

    // ============================================
    // UTILITY FUNCTIONS
    // ============================================

    function formatNumber(num) {
        return (num || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function updateConvertedAmount() {
        const from = document.getElementById('fromAccount').value;
        const to = document.getElementById('toAccount').value;
        const amount = parseFloat(document.getElementById('txAmount').value) || 0;
        const fromCurrency = getCurrency(from);
        const toCurrency = getCurrency(to);
        
        const exchangeGroup = document.getElementById('exchangeRateGroup');
        const convertedDisplay = document.getElementById('convertedAmountDisplay');
        const rateLabel = document.getElementById('txExchangeRateLabel');

        if (from && to && fromCurrency !== toCurrency && amount > 0) {
            exchangeGroup.style.display = 'block';
            if (rateLabel) rateLabel.textContent = '(ZMW per USD)';
            const toSymbol = getCurrencySymbol(to);
            const rate = parseFloat(document.getElementById('txExchangeRate').value) || state.exchangeRate.zmwPerUsd;
            // 🔥 FIX: same directional correction as saveTransfer() --
            // divide when converting ZMW into USD, multiply when
            // converting USD into ZMW, rather than always multiplying.
            const converted = fromCurrency === 'USD' ? amount * rate : amount / rate;
            document.getElementById('convertedAmountText').textContent = `${toSymbol} ${formatNumber(converted)}`;
            convertedDisplay.style.display = 'block';
        } else {
            exchangeGroup.style.display = 'none';
            convertedDisplay.style.display = 'none';
        }
    }

    // ============================================
    // TOAST CSS
    // ============================================
    if (!document.getElementById('customToastStyles')) {
        const style = document.createElement('style');
        style.id = 'customToastStyles';
        style.textContent = `
            @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
            @keyframes slideOut { from { transform: translateX(0); opacity: 1; } to { transform: translateX(100%); opacity: 0; } }
        `;
        document.head.appendChild(style);
    }

    // ============================================
    // EVENT LISTENERS
    // ============================================

    function setupEventListeners() {
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                document.querySelectorAll('.modal.show').forEach(modal => modal.classList.remove('show'));
            }
        });

        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) modal.classList.remove('show');
            });
        });

        document.getElementById('fromAccount').addEventListener('change', updateConvertedAmount);
        document.getElementById('toAccount').addEventListener('change', updateConvertedAmount);
        document.getElementById('txAmount').addEventListener('input', updateConvertedAmount);
        document.getElementById('txExchangeRate').addEventListener('input', updateConvertedAmount);

        document.getElementById('accountFilter')?.addEventListener('change', function() {
            renderTransactions();
        });
        document.getElementById('startDate')?.addEventListener('change', function() {
            renderTransactions();
        });
        document.getElementById('endDate')?.addEventListener('change', function() {
            renderTransactions();
        });
    }

    // ============================================
    // INITIALIZE
    // ============================================
    await loadGLAccounts();
    await loadGLJournalLines();
    await loadExchangeRate();
    renderBalances();
    renderTransactions();
    updateExchangeRateDisplay();
    setupEventListeners();

    console.log("✅ Cash & Bank Management initialized successfully!");
})();
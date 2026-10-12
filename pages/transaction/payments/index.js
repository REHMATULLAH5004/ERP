// ============================================
// PAYMENT MODULE - INVOICE BASED (UPDATED)
// ============================================

(async function initPaymentPage() {
    console.log("💳 Payment module initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    // 🔥 FIX: "Cannot read properties of null (reading 'addEventListener')
    // at setupEventListeners" -- this whole module is one async IIFE that
    // awaits 7 separate Supabase round trips (below) before it ever wires
    // up the DOM. app.js's loadSubModule() already guards against a STALE
    // fetch injecting HTML/a script over a newer navigation (see its
    // navToken comment), but that guard only covers the injection step --
    // it can't stop an ALREADY-INJECTED script's own async chain from
    // continuing to run in the background after the user navigates away
    // (removing the <script> tag doesn't cancel code already executing).
    // If the user leaves Payments -- or re-opens it quickly -- while any
    // of those awaits are still in flight, this exact run keeps going,
    // and eventually reaches setupEventListeners() trying to attach
    // listeners to #paymentSupplier etc., which by then belong to
    // whatever page replaced this one and are simply gone from the DOM.
    //
    // Fix: capture a sentinel element reference right now, synchronously,
    // at the instant this script starts executing (guaranteed to exist
    // then -- loadSubModule() injects this module's HTML immediately
    // before injecting this script). Its .isConnected flips to false the
    // moment ANY later navigation replaces workspace-content, which is
    // exactly the signal needed to detect "this run is stale" after the
    // long await chain below.
    const paymentModuleSentinel = document.getElementById('paymentModal');
    function paymentModuleStillMounted() {
        return !!(paymentModuleSentinel && paymentModuleSentinel.isConnected);
    }

    // ============================================
    // GLOBAL STATE
    // ============================================
    const state = {
        suppliers: [],
        payments: [],
        purchaseOrders: [],
        grns: [],
        supplierPayables: [],
        paymentInvoices: [],
        currentStatementData: null,
        currentCurrencyTab: 'USD'
    };

    // ============================================
    // 🔥 CHART OF ACCOUNTS - AUTO CREATE MISSING ACCOUNTS
    // ============================================
    // This module had NO accounting/GL integration at all before this --
    // payments were recorded in `payments`/`payment_invoices` but never
    // touched journal_entries/journal_lines/chart_of_accounts, so
    // settling a payable never actually cleared it in the general ledger.
    // Account codes/names match retail.js/wholesale.js/donation.js/
    // writeoff.js/purchase's index.js exactly -- this never creates
    // duplicates of shared accounts across the whole system.
    const REQUIRED_ACCOUNTS = [
        { code: '1111', name: 'Cash in Hand (ZMW)', type: 'Asset', category: 'Current Asset', normal_balance: 'Debit' },
        { code: '1121', name: 'Bank - ZMW', type: 'Asset', category: 'Current Asset', normal_balance: 'Debit' },
        // 🔥 ADDED: lets a payment be settled directly out of the USD bank
        // account (no ZMW conversion at all) -- same account code (1120)
        // already used by Account > Cash & Bank and Fixed Assets, so this
        // never creates a duplicate.
        { code: '1120', name: 'Bank - USD', type: 'Asset', category: 'Current Asset', normal_balance: 'Debit' },
        { code: '2001', name: 'Accounts Payable', type: 'Liability', category: 'Current Liability', normal_balance: 'Credit' }
    ];

    // 🔥 PERF FIX: this used to run on every single save -- and twice per
    // save at that, since createPaymentGLEntry() called it directly (via
    // getAccountCodesFromChartOfAccounts()) and that function called it
    // again itself. Each run checked every required account ONE AT A TIME
    // (a separate SELECT, and INSERT if missing, per account) -- up to
    // REQUIRED_ACCOUNTS.length * 2 sequential round-trips just for this
    // housekeeping step. REQUIRED_ACCOUNTS is a fixed list baked into this
    // file and never changes while the page is open, so it only needs
    // checking once per page load. Now: checked in a single query, any
    // missing ones created in a single batch insert, and skipped entirely
    // after the first successful run.
    let chartOfAccountsSynced = false;

    async function ensureChartOfAccounts() {
        if (chartOfAccountsSynced) {
            return { created: 0, existing: REQUIRED_ACCOUNTS.length, cached: true };
        }

        try {
            const codes = REQUIRED_ACCOUNTS.map(a => a.code);
            const { data: existingAccounts, error: findError } = await supabaseClient
                .from('chart_of_accounts')
                .select('code')
                .in('code', codes);

            if (findError) throw findError;

            const existingCodes = new Set((existingAccounts || []).map(a => a.code));
            const missing = REQUIRED_ACCOUNTS.filter(a => !existingCodes.has(a.code));

            let created = 0;
            if (missing.length > 0) {
                const { error: insertError } = await supabaseClient
                    .from('chart_of_accounts')
                    .insert(missing.map(account => ({
                        code: account.code,
                        name: account.name,
                        type: account.type,
                        category: account.category,
                        normal_balance: account.normal_balance,
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString()
                    })));

                if (insertError) {
                    console.error('Error creating missing accounts:', insertError);
                } else {
                    created = missing.length;
                    missing.forEach(a => console.log(`✅ Created account: ${a.code} - ${a.name}`));
                }
            }

            const existing = REQUIRED_ACCOUNTS.length - missing.length;
            console.log(`✅ Chart of Accounts sync complete: ${created} created, ${existing} existing`);
            chartOfAccountsSynced = true;
            return { created, existing };
        } catch (error) {
            console.error('Error ensuring chart of accounts:', error);
            return { created: 0, existing: 0, error };
        }
    }

    async function getAccountCodesFromChartOfAccounts() {
        try {
            await ensureChartOfAccounts();
            const accountNames = REQUIRED_ACCOUNTS.map(a => a.name);
            const { data: accounts, error } = await supabaseClient
                .from('chart_of_accounts')
                .select('code, name')
                .in('name', accountNames);

            if (error) throw error;

            const accountMap = {};
            accounts.forEach(acc => {
                const key = acc.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
                accountMap[key] = acc.code;
            });

            return {
                cash_zmw: accountMap['cash_in_hand_zmw'] || '1111',
                bank_zmw: accountMap['bank_zmw'] || '1121',
                bank_usd: accountMap['bank_usd'] || '1120',
                accounts_payable: accountMap['accounts_payable'] || '2001'
            };
        } catch (error) {
            console.error('Error fetching account codes:', error);
            return { cash_zmw: '1111', bank_zmw: '1121', bank_usd: '1120', accounts_payable: '2001' };
        }
    }

    // ============================================
    // 🔥 PAYMENT GL ENTRY -- Debit Accounts Payable, Credit Cash in Hand,
    // Bank (ZMW), or -- 🔥 ADDED -- Bank (USD) when the payment is made
    // directly out of the USD bank account.
    //
    // Two distinct paths:
    //  - method 'Cash' / 'Bank Transfer': settled in ZMW cash, exactly as
    //    before -- if the payable being cleared was USD-denominated, the
    //    USD portion is converted to ZMW at `exchangeRate` first, matching
    //    the original spec ("Payables get settled by cash or bank —
    //    always in ZMW, even if the original payable was in USD").
    //  - method 'Bank Transfer USD': 🔥 ADDED -- settled directly out of
    //    the USD bank account, no conversion at all. Both lines of this
    //    journal entry are posted in raw USD numbers (matching how
    //    Account > Cash & Bank already posts to this same account, e.g.
    //    its Opening Balance entries) rather than converting to ZMW --
    //    this is the whole point: no exchange rate is needed or asked for
    //    on this path.
    // ============================================
    async function createPaymentGLEntry(paymentNumber, paymentDate, method, amountUsd, amountZmw, exchangeRate, payCurrency) {
        try {
            const accountCodes = await getAccountCodesFromChartOfAccounts();
            const debitAccount = accountCodes.accounts_payable;

            if (payCurrency === 'USD') {
                // Direct USD payment -- amountUsd is the raw amount that
                // actually left the USD bank account, no conversion.
                if (amountUsd <= 0) return;

                const journal = {
                    entry_date: paymentDate,
                    reference: paymentNumber,
                    description: `Supplier payment - ${paymentNumber} (USD ${formatNumber(amountUsd)}, paid directly from USD bank)`,
                    journal_number: `PAY-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
                    status: 'Posted',
                    created_at: new Date().toISOString()
                };

                const { data: journalData, error: jError } = await supabaseClient
                    .from('journal_entries')
                    .insert([journal])
                    .select();
                if (jError) throw jError;

                await supabaseClient.from('journal_lines').insert([
                    { journal_entry_id: journalData[0].id, account_code: debitAccount, description: `Clearing payable - ${paymentNumber}`, debit: amountUsd, credit: 0 },
                    { journal_entry_id: journalData[0].id, account_code: accountCodes.bank_usd, description: `USD bank payment: ${paymentNumber}`, debit: 0, credit: amountUsd }
                ]);

                console.log(`✅ Payment GL entry created for ${paymentNumber}: $${amountUsd.toFixed(2)} (USD bank, direct)`);
                return;
            }

            // Convert the USD portion (if any) to ZMW for the ledger --
            // cash/bank on hand is always ZMW, regardless of which
            // currency bucket the paid-down invoice was in.
            const zmwTotal = amountZmw + (amountUsd * (exchangeRate || 1));
            if (zmwTotal <= 0) return;

            const creditAccount = method === 'Bank Transfer' ? accountCodes.bank_zmw : accountCodes.cash_zmw;
            const creditDescription = method === 'Bank Transfer'
                ? `Bank payment: ${paymentNumber}`
                : `Cash payment: ${paymentNumber}`;

            const journal = {
                entry_date: paymentDate,
                reference: paymentNumber,
                description: `Supplier payment - ${paymentNumber}` + (amountUsd > 0 ? ` (USD ${formatNumber(amountUsd)} @ ${exchangeRate})` : ''),
                journal_number: `PAY-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
                status: 'Posted',
                created_at: new Date().toISOString()
            };

            const { data: journalData, error: jError } = await supabaseClient
                .from('journal_entries')
                .insert([journal])
                .select();
            if (jError) throw jError;

            await supabaseClient.from('journal_lines').insert([
                { journal_entry_id: journalData[0].id, account_code: debitAccount, description: `Clearing payable - ${paymentNumber}`, debit: zmwTotal, credit: 0 },
                { journal_entry_id: journalData[0].id, account_code: creditAccount, description: creditDescription, debit: 0, credit: zmwTotal }
            ]);

            console.log(`✅ Payment GL entry created for ${paymentNumber}: ZK${zmwTotal.toFixed(2)} (${method})`);
        } catch (error) {
            console.error('Error creating payment GL entry:', error);
            showToast('Payment saved, but the accounting entry failed -- please check manually.', 'warning');
        }
    }

    // ============================================
    // LOAD DATA
    // ============================================

    async function loadSuppliers() {
        try {
            const { data, error } = await supabaseClient
                .from('suppliers')
                .select('*')
                .order('name', { ascending: true });

            if (error) throw error;
            state.suppliers = data || [];
            return state.suppliers;
        } catch (error) {
            console.error('Error loading suppliers:', error);
            state.suppliers = [];
            return [];
        }
    }

    async function loadPayments() {
        try {
            const { data, error } = await supabaseClient
                .from('payments')
                .select('*')
                .order('payment_date', { ascending: false });

            if (error) throw error;
            state.payments = data || [];
            return state.payments;
        } catch (error) {
            console.error('Error loading payments:', error);
            state.payments = [];
            return [];
        }
    }

    async function loadSupplierPayables() {
        try {
            const { data, error } = await supabaseClient
                .from('supplier_payables')
                .select('*')
                .order('created_at', { ascending: true });

            if (error) {
                console.warn('supplier_payables table not found or error:', error);
                state.supplierPayables = [];
                return [];
            }
            state.supplierPayables = data || [];
            console.log(`✅ Loaded ${state.supplierPayables.length} supplier payables`);
            return state.supplierPayables;
        } catch (error) {
            console.error('Error loading supplier payables:', error);
            state.supplierPayables = [];
            return [];
        }
    }

    async function loadPurchaseOrders() {
        try {
            const { data, error } = await supabaseClient
                .from('purchase_orders')
                .select('*')
                .in('status', ['Goods Received', 'Partially Received', 'Closed'])
                .order('created_at', { ascending: true });

            if (error) throw error;
            state.purchaseOrders = data || [];
            return state.purchaseOrders;
        } catch (error) {
            console.error('Error loading purchase orders:', error);
            state.purchaseOrders = [];
            return [];
        }
    }

    async function loadGRNs() {
        try {
            const { data, error } = await supabaseClient
                .from('goods_receipt_notes')
                .select('*')
                .eq('posted', true)
                .order('entry_date', { ascending: true });

            if (error) {
                console.warn('goods_receipt_notes table not found:', error);
                state.grns = [];
                return [];
            }
            state.grns = data || [];
            return state.grns;
        } catch (error) {
            console.error('Error loading GRNs:', error);
            state.grns = [];
            return [];
        }
    }

    async function loadPaymentInvoices() {
        try {
            const { data, error } = await supabaseClient
                .from('payment_invoices')
                .select('*')
                .order('created_at', { ascending: true });

            if (error) {
                console.warn('payment_invoices table not found, using empty state');
                state.paymentInvoices = [];
                return [];
            }
            state.paymentInvoices = data || [];
            console.log(`✅ Loaded ${state.paymentInvoices.length} payment invoices`);
            return state.paymentInvoices;
        } catch (error) {
            console.error('Error loading payment invoices:', error);
            state.paymentInvoices = [];
            return [];
        }
    }

    // ============================================
    // CALCULATE SUPPLIER BALANCES
    // ============================================

    // ============================================
    // 🔥 SHARED: opening-balance payments lookup. Both
    // calculateSupplierBalances() (drives the main list) and
    // openSupplierStatement() (drives the statement modal) need to know
    // "how much of this supplier's opening balance has been paid, in this
    // currency" -- they used to each have their own separate copy of the
    // identical filter, which meant any future edit to one without the
    // other would silently make them disagree. Extracted here so there is
    // exactly one place this is computed, and both callers are
    // structurally guaranteed to agree.
    // ============================================
    function getOpeningBalancePayments(supplierId, currency) {
        return state.paymentInvoices.filter(pi =>
            pi.supplier_id === supplierId &&
            pi.is_opening_balance === true &&
            pi.currency === currency
        );
    }

    function calculateSupplierBalances() {
        return state.suppliers.map(supplier => {
            // Get payables for this supplier (from GRNs)
            const supplierPayables = state.supplierPayables.filter(sp => sp.supplier_id === supplier.id);
            
            let totalPayableUsd = 0;
            let totalPayableZmw = 0;
            let totalPaidUsd = 0;
            let totalPaidZmw = 0;
            
            // Calculate from supplier payables (this is the amount we owe per invoice)
            supplierPayables.forEach(sp => {
                if (sp.currency === 'USD') {
                    totalPayableUsd += sp.total_amount || 0;
                    // Track payments made against this payable
                    const paidAmounts = state.paymentInvoices
                        .filter(pi => pi.supplier_id === supplier.id && pi.payable_id === sp.id)
                        .reduce((sum, pi) => sum + (pi.amount_paid || 0), 0);
                    totalPaidUsd += paidAmounts;
                } else if (sp.currency === 'ZMW') {
                    totalPayableZmw += sp.total_amount || 0;
                    const paidAmounts = state.paymentInvoices
                        .filter(pi => pi.supplier_id === supplier.id && pi.payable_id === sp.id)
                        .reduce((sum, pi) => sum + (pi.amount_paid || 0), 0);
                    totalPaidZmw += paidAmounts;
                }
            });

            // Also check opening balance payments
            const openingPaymentsUsd = getOpeningBalancePayments(supplier.id, 'USD')
                .reduce((sum, pi) => sum + (pi.amount_paid || 0), 0);
            const openingPaymentsZmw = getOpeningBalancePayments(supplier.id, 'ZMW')
                .reduce((sum, pi) => sum + (pi.amount_paid || 0), 0);

            const dueUsd = (supplier.opening_balance_usd || 0) + totalPayableUsd - totalPaidUsd - openingPaymentsUsd;
            const dueZmw = (supplier.opening_balance_zmw || 0) + totalPayableZmw - totalPaidZmw - openingPaymentsZmw;
            
            const hasDue = dueUsd > 0 || dueZmw > 0;

            return {
                ...supplier,
                dueUsd,
                dueZmw,
                hasDue,
                payables: supplierPayables,
                purchaseOrders: state.purchaseOrders.filter(po => po.supplier_id === supplier.id)
            };
        });
    }

    // ============================================
    // RENDER FUNCTIONS
    // ============================================

    function renderPaymentList(data = null) {
        const supplierData = data || calculateSupplierBalances();
        const tbody = document.getElementById('paymentTableBody');
        const countSpan = document.getElementById('paymentListCount');
        const countMain = document.getElementById('paymentCount');
        
        if (!tbody) return;

        const searchTerm = document.getElementById('searchPayment')?.value?.toLowerCase() || '';

        // 🔥 FIX: openSupplierStatement() is only ever wired up via onclick
        // on rows in THIS table. Previously this table only ever rendered
        // suppliers with hasDue === true -- so the moment a supplier (or
        // their last remaining invoice) got fully paid off, their row
        // vanished and there was no longer any way to click into their
        // statement at all, even though the statement itself correctly
        // shows the full paid history with no filtering. Now: with no
        // search term, still default to "who do I owe" (due-only) since
        // that's this screen's normal purpose -- but typing a search term
        // searches across ALL suppliers, so a fully-settled one can still
        // be found and their statement opened.
        // 🔥 CHANGED: every supplier stays in the list, even once their
        // payable is zero (they show a "Paid in full" tag and a ZK0.00
        // balance), so their statement is always one click away. Suppliers
        // who still have something due are listed first.
        let filtered = searchTerm
            ? supplierData.filter(s => s.name.toLowerCase().includes(searchTerm))
            : [...supplierData];
        filtered.sort((a, b) => (b.hasDue ? 1 : 0) - (a.hasDue ? 1 : 0) || a.name.localeCompare(b.name));

        if (filtered.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 40px; color: #94a3b8;">
                <i class="fa-regular fa-circle-check" style="font-size: 2rem; display: block; margin-bottom: 10px; color: #22c55e;"></i>
                ${searchTerm ? 'No suppliers match your search.' : 'No suppliers found.'}
            </td></tr>`;
            if (countSpan) countSpan.textContent = '0 suppliers';
            if (countMain) countMain.textContent = '0 suppliers';
            return;
        }

        tbody.innerHTML = filtered.map(s => `
            <tr>
                <td style="padding-left: 20px;">
                    <span class="supplier-name-link" onclick="openSupplierStatement('${s.id}')">${s.name}</span>
                    ${!s.hasDue ? '<span style="margin-left:8px;font-size:0.7rem;background:#dcfce7;color:#15803d;padding:1px 8px;border-radius:10px;">Paid in full</span>' : ''}
                </td>
                <td>${s.phone || '-'}</td>
                <td style="text-align: right;">
                    ${s.dueUsd > 0 ? 
                        `<span class="clickable-amount usd" onclick="openSupplierStatement('${s.id}')" title="Click to view statement">
                            $${formatNumber(s.dueUsd)}
                        </span>` : 
                        '<span style="color: #94a3b8;">$0.00</span>'
                    }
                </td>
                <td style="text-align: right;">
                    ${s.dueZmw > 0 ? 
                        `<span class="clickable-amount zmw" onclick="openSupplierStatement('${s.id}')" title="Click to view statement">
                            ZK${formatNumber(s.dueZmw)}
                        </span>` : 
                        '<span style="color: #94a3b8;">ZK0.00</span>'
                    }
                </td>
                <td style="padding-right: 20px; text-align: center;">
                    ${s.hasDue ? `
                    <button class="btn btn-primary btn-sm" onclick="openRecordPayment('${s.id}')" title="Record Payment">
                        <i class="fa-solid fa-credit-card"></i> Pay
                    </button>` : `<span style="color: #94a3b8; font-size: 0.8rem;">-</span>`}
                </td>
            </tr>
        `).join('');
        
        if (countSpan) countSpan.textContent = `${filtered.length} suppliers`;
        if (countMain) countMain.textContent = `${filtered.length} suppliers`;
        // Stats should only reflect suppliers who actually have something
        // due, even if the search results above include paid-off ones.
        updateStats(filtered.filter(s => s.hasDue));
    }

    function updateStats(filteredData) {
        const totalDueUsd = filteredData.reduce((sum, s) => sum + s.dueUsd, 0);
        const totalDueZmw = filteredData.reduce((sum, s) => sum + s.dueZmw, 0);
        const today = new Date().toISOString().split('T')[0];
        const todayPayments = state.payments.filter(p => p.payment_date === today);
        const totalPaidToday = todayPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
        
        document.getElementById('totalDueSuppliers').textContent = filteredData.length;
        document.getElementById('totalDueUsd').textContent = `$${formatNumber(totalDueUsd)}`;
        document.getElementById('totalDueZmw').textContent = `ZK${formatNumber(totalDueZmw)}`;
        document.getElementById('totalPaidToday').textContent = `ZK${formatNumber(totalPaidToday)}`;
    }

    // ============================================
    // INVOICE LIST FOR PAYMENT
    // ============================================

    function loadInvoicesForSupplier(supplierId) {
        const container = document.getElementById('invoiceList');
        const summary = document.getElementById('paymentSummary');
        const exchangeGroup = document.getElementById('exchangeRateGroup');
        
        if (!supplierId) {
            container.innerHTML = '<p style="text-align: center; color: #94a3b8; padding: 20px;">Select a supplier to view due invoices</p>';
            summary.style.display = 'none';
            exchangeGroup.style.display = 'none';
            return;
        }

        const supplier = state.suppliers.find(s => s.id === supplierId);
        if (!supplier) {
            container.innerHTML = '<p style="text-align: center; color: #94a3b8; padding: 20px;">Supplier not found</p>';
            summary.style.display = 'none';
            exchangeGroup.style.display = 'none';
            return;
        }

        // FIX: "Settling" now picks ONE currency at a time -- USD and
        // ZMW invoices never appear together in the same payment list, so
        // there's no way to accidentally blend them into one payment.
        const settlingCurrency = document.getElementById('paymentCurrency').value;

        // 🔥 ADDED: "Bank Account (USD)" is only a valid way to pay while
        // settling USD invoices (paying a ZMW invoice straight out of the
        // USD account isn't something this adds -- out of scope for now).
        // Hide/show the option here, and fall back to Cash if it was
        // selected and Settling changed out from under it.
        const usdBankOption = document.getElementById('usdBankPaymentOption');
        const methodSelect = document.getElementById('paymentMethod');
        if (usdBankOption && methodSelect) {
            usdBankOption.style.display = settlingCurrency === 'USD' ? '' : 'none';
            if (settlingCurrency !== 'USD' && methodSelect.value === 'Bank Transfer USD') {
                methodSelect.value = 'Cash';
            }
        }

        let html = '';
        let totalSelected = 0;

        // Opening Balance, only for the selected currency
        const openingBalance = settlingCurrency === 'USD' ? (supplier.opening_balance_usd || 0) : (supplier.opening_balance_zmw || 0);
        if (openingBalance > 0) {
            const paidOpening = state.paymentInvoices
                .filter(pi => pi.supplier_id === supplierId && pi.is_opening_balance === true && pi.currency === settlingCurrency)
                .reduce((sum, pi) => sum + (pi.amount_paid || 0), 0);

            const remaining = openingBalance - paidOpening;

            if (remaining > 0) {
                const symbol = settlingCurrency === 'USD' ? '$' : 'ZK';
                html += `
                    <div class="invoice-item">
                        <div class="checkbox">
                            <input type="checkbox" class="invoice-checkbox"
                                data-id="opening_${settlingCurrency.toLowerCase()}"
                                data-amount="${remaining}"
                                data-currency="${settlingCurrency}"
                                data-is-opening="true"
                                onchange="onPaymentInvoiceToggle(this)">
                        </div>
                        <div class="info">
                            <div class="number">Opening Balance (${settlingCurrency})</div>
                            <div class="date">Previous balance</div>
                        </div>
                        <div class="amount">${symbol}${formatNumber(remaining)}</div>
                        <!-- 🔥 ADDED: appears the moment this item is ticked, defaulting to
                             its full remaining amount -- edit it down to pay only part of
                             this specific opening balance instead of always paying it in full. -->
                        <div class="pay-amount-box" style="display:none;">
                            <input type="number" class="invoice-pay-amount"
                                data-remaining="${remaining}"
                                min="0.01" max="${remaining}" step="0.01"
                                value="${remaining.toFixed(2)}"
                                oninput="onPaymentAmountInput(this)">
                        </div>
                    </div>
                `;
                totalSelected += remaining;
            }
        }

        // Payables (from GRNs), only for the selected currency
        const supplierPayables = state.supplierPayables.filter(sp =>
            sp.supplier_id === supplierId && (sp.currency || 'USD') === settlingCurrency
        );

        const payableMap = {};
        supplierPayables.forEach(sp => {
            const paidAmount = state.paymentInvoices
                .filter(pi => pi.supplier_id === supplierId && pi.payable_id === sp.id && pi.is_opening_balance !== true)
                .reduce((sum, pi) => sum + (pi.amount_paid || 0), 0);

            const remaining = sp.total_amount - paidAmount;

            if (remaining > 0) {
                const key = sp.po_id || sp.grn_id || sp.id;
                if (!payableMap[key]) {
                    payableMap[key] = {
                        id: sp.id,
                        po_id: sp.po_id,
                        grn_id: sp.grn_id,
                        invoice_number: sp.invoice_number || 'INV-' + sp.id.slice(0, 8),
                        currency: settlingCurrency,
                        total: remaining,
                        original_total: sp.total_amount,
                        paid: paidAmount,
                        date: sp.invoice_date || sp.created_at
                    };
                }
            }
        });

        const payableItems = Object.values(payableMap);

        if (payableItems.length === 0 && openingBalance === 0) {
            container.innerHTML = `<p style="text-align: center; color: #94a3b8; padding: 20px;">No due ${settlingCurrency} invoices or opening balance for this supplier</p>`;
            summary.style.display = 'none';
            exchangeGroup.style.display = 'none';
            return;
        }

        if (openingBalance > 0 && payableItems.length > 0) {
            html += `
                <div style="padding: 8px 12px; background: #f1f5f9; margin: 5px 0; font-weight: 600; color: #475569; border-radius: 4px;">
                    <i class="fa-solid fa-receipt"></i> Purchase Invoices (from GRNs)
                </div>
            `;
        }

        payableItems.forEach(item => {
            const symbol = settlingCurrency === 'USD' ? '$' : 'ZK';
            const invoiceDate = item.date ? new Date(item.date).toLocaleDateString() : '-';

            html += `
                <div class="invoice-item">
                    <div class="checkbox">
                        <input type="checkbox" class="invoice-checkbox"
                            data-id="${item.id}"
                            data-payable-id="${item.id}"
                            data-po-id="${item.po_id || ''}"
                            data-amount="${item.total}"
                            data-currency="${settlingCurrency}"
                            data-is-opening="false"
                            onchange="onPaymentInvoiceToggle(this)">
                    </div>
                    <div class="info">
                        <div class="number">${item.invoice_number}</div>
                        <div class="date">Date: ${invoiceDate} | ${settlingCurrency} | Remaining: ${symbol}${formatNumber(item.total)}</div>
                    </div>
                    <div class="amount">${symbol}${formatNumber(item.total)}</div>
                    <!-- 🔥 ADDED: appears the moment this invoice is ticked, defaulting to
                         its full remaining amount -- edit it down to pay only part of this
                         specific invoice (a half payment) instead of always paying it in full. -->
                    <div class="pay-amount-box" style="display:none;">
                        <input type="number" class="invoice-pay-amount"
                            data-remaining="${item.total}"
                            min="0.01" max="${item.total}" step="0.01"
                            value="${item.total.toFixed(2)}"
                            oninput="onPaymentAmountInput(this)">
                    </div>
                </div>
            `;
            totalSelected += item.total;
        });

        container.innerHTML = html;

        // Exchange rate is required whenever settling USD invoices with
        // ZMW cash/bank -- shown unconditionally for that case, not gated
        // behind the old buggy "payCurrency === 'ZMW' && hasUsdInvoices"
        // check (which meant picking "USD" as payCurrency never showed
        // the rate field at all). 🔥 ADDED: never shown at all when paying
        // directly from the USD bank account -- no conversion needed.
        const payingDirectlyInUsd = document.getElementById('paymentMethod')?.value === 'Bank Transfer USD';
        exchangeGroup.style.display = (settlingCurrency === 'USD' && !payingDirectlyInUsd) ? 'block' : 'none';

        summary.style.display = 'block';
        updatePaymentSummary();
    }

    // ============================================
    // PER-INVOICE PAY AMOUNT HANDLERS
    // ============================================
    // 🔥 ADDED: previously there was one free-text "Amount to Pay" that
    // got auto-allocated (oldest first) across everything ticked -- there
    // was no way to say "pay half of THIS specific invoice" when more than
    // one invoice existed, and even with only one ticked, the field's
    // intent wasn't obviously "how much against this invoice". Now each
    // invoice/opening-balance row gets its own "Pay Amount" box, shown the
    // moment it's ticked and defaulting to that item's full remaining
    // amount, so a partial/half payment is just editing that one box down.

    function getPaymentAmountInputFor(checkbox) {
        const row = checkbox.closest('.invoice-item');
        return row ? row.querySelector('.invoice-pay-amount') : null;
    }

    window.onPaymentInvoiceToggle = function(checkbox) {
        const amountBox = checkbox.closest('.invoice-item')?.querySelector('.pay-amount-box');
        const amountInput = getPaymentAmountInputFor(checkbox);
        if (amountBox) amountBox.style.display = checkbox.checked ? 'flex' : 'none';
        if (amountInput && checkbox.checked) {
            // reset to the full remaining amount each time it's freshly ticked
            amountInput.value = (parseFloat(checkbox.dataset.amount) || 0).toFixed(2);
        }
        updatePaymentSummary();
    };

    window.onPaymentAmountInput = function(input) {
        const remaining = parseFloat(input.dataset.remaining) || parseFloat(input.max) || 0;
        let value = parseFloat(input.value);
        if (isNaN(value) || value < 0) value = 0;
        if (value > remaining) input.value = remaining.toFixed(2);
        updatePaymentSummary();
    };

    // ============================================
    // UPDATE PAYMENT SUMMARY
    // ============================================

    function updatePaymentSummary() {
        const checkboxes = document.querySelectorAll('.invoice-checkbox:checked');
        const settlingCurrency = document.getElementById('paymentCurrency').value;
        const exchangeRate = parseFloat(document.getElementById('paymentExchangeRate').value) || 25.00;
        // 🔥 ADDED: paying directly out of the USD bank account -- no ZMW
        // conversion at all.
        const payingDirectlyInUsd = document.getElementById('paymentMethod').value === 'Bank Transfer USD';

        // 🔥 FIX: checkboxes are now all the same currency (loadInvoicesForSupplier
        // only ever renders one currency's invoices at a time), so this is
        // just a straight sum -- no more cross-currency blending.
        // 🔥 CHANGED: totalSelected now reflects what's actually going to be
        // PAID (the sum of each row's editable Pay Amount box), not always
        // the full remaining balance of everything ticked.
        let totalSelected = 0;
        checkboxes.forEach(cb => {
            const amountInput = getPaymentAmountInputFor(cb);
            totalSelected += amountInput ? (parseFloat(amountInput.value) || 0) : (parseFloat(cb.dataset.amount) || 0);
        });

        const amountLabel = document.getElementById('paymentAmountLabel');
        const amountInput = document.getElementById('paymentAmount');

        if (payingDirectlyInUsd) {
            // Amount due IS the USD total selected -- nothing to convert.
            document.getElementById('selectedTotal').textContent = `Total Selected: $${formatNumber(totalSelected)}`;

            amountLabel.textContent = 'Total to Pay (USD):';
            // 🔥 CHANGED: this field is now read-only and purely reflects
            // the sum of the per-invoice Pay Amount boxes above -- editing
            // a specific invoice's pay amount is what changes this, not
            // typing directly into this field.
            amountInput.value = totalSelected.toFixed(2);
        } else {
            // The amount actually paid is ZMW cash/bank. If settling USD
            // invoices, convert the selected USD total to the ZMW amount due.
            const totalDueZmw = settlingCurrency === 'USD' ? totalSelected * exchangeRate : totalSelected;

            const symbol = settlingCurrency === 'USD' ? '$' : 'ZK';
            let displayText = `Total Selected: ${symbol}${formatNumber(totalSelected)}`;
            if (settlingCurrency === 'USD') {
                displayText += ` = ZK${formatNumber(totalDueZmw)} at rate ${exchangeRate}`;
            }
            document.getElementById('selectedTotal').textContent = displayText;

            amountLabel.textContent = 'Total to Pay (ZMW):';
            amountInput.value = totalDueZmw.toFixed(2);
        }

        // 🔥 FIX: never shown while paying directly from the USD bank
        // account -- previously this line alone (running after
        // loadInvoicesForSupplier's own, method-aware version) could
        // re-show the rate field even when paying directly in USD.
        const exchangeGroup = document.getElementById('exchangeRateGroup');
        exchangeGroup.style.display = (settlingCurrency === 'USD' && !payingDirectlyInUsd) ? 'block' : 'none';

        // 🔥 CHANGED: live partial-payment indicator, now driven by the
        // per-invoice Pay Amount boxes rather than one overall figure --
        // compares each ticked item's own remaining balance against what
        // was actually typed into its Pay Amount box, in the invoice's own
        // currency (not the ZMW-cash-equivalent), so it's correct even
        // when only one of several ticked invoices is being half-paid.
        const noteEl = document.getElementById('paymentBalanceNote');
        if (noteEl) {
            const invoiceSymbol = settlingCurrency === 'USD' ? '$' : 'ZK';
            let partialCount = 0;
            let shortfallInSettlingCurrency = 0;
            checkboxes.forEach(cb => {
                const remaining = parseFloat(cb.dataset.amount) || 0;
                const amountInputForRow = getPaymentAmountInputFor(cb);
                const payAmount = amountInputForRow ? (parseFloat(amountInputForRow.value) || 0) : remaining;
                const rowShortfall = remaining - payAmount;
                if (rowShortfall > 0.01) {
                    partialCount++;
                    shortfallInSettlingCurrency += rowShortfall;
                }
            });

            if (checkboxes.length === 0 || totalSelected <= 0) {
                noteEl.innerHTML = '';
            } else if (partialCount > 0) {
                noteEl.innerHTML = `<span style="color:#b45309;"><i class="fa-solid fa-triangle-exclamation"></i> Partial payment on ${partialCount} item(s) -- ${invoiceSymbol}${formatNumber(shortfallInSettlingCurrency)} will still be due on ${partialCount > 1 ? 'them' : 'it'} after this payment.</span>`;
            } else {
                noteEl.innerHTML = `<span style="color:#15803d;"><i class="fa-solid fa-circle-check"></i> Full payment -- this clears the selected invoice(s) completely.</span>`;
            }
        }
    }

    // ============================================
    // SUPPLIER STATEMENT
    // ============================================

    // ============================================
    // STATEMENT LEDGER BUILDER
    // ============================================
    // Local-time YYYY-MM-DD key for a date-only string ("2026-09-03") or a
    // full timestamp, so rows sort by real calendar date and never by a
    // locale-formatted string (which parses differently per browser locale).
    function statementDateKey(value) {
        if (!value) return '0000-00-00';
        if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
        const d = new Date(value);
        if (isNaN(d.getTime())) return '0000-00-00';
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    function statementDateLabel(key) {
        return new Date(key + 'T00:00:00').toLocaleDateString();
    }

    // Statement layout (agreed with the accountant):
    //   Date | Invoice # | Type | Reference | Amount DUE | Amount PAID | Balance
    // followed by three "for information" columns -- Paid so far | Paid on |
    // Remaining -- that NEVER affect the balance.
    //   Balance = previous balance + Amount DUE - Amount PAID
    // One payment = ONE row (even when it settles several invoices); its
    // Invoice # cell lists everything it covered, e.g. "Opening Balance/EM114589".
    function buildStatementLedger(supplier, supplierPayables, currency) {
        const opening = currency === 'USD' ? (supplier.opening_balance_usd || 0) : (supplier.opening_balance_zmw || 0);
        const openingPayments = getOpeningBalancePayments(supplier.id, currency);
        const payables = supplierPayables.filter(sp => (sp.currency || 'USD') === currency);

        // Nothing at all in this currency
        if (!(opening > 0) && openingPayments.length === 0 && payables.length === 0) return [];

        const events = [];
        let seq = 0;
        const round2 = n => Math.round(n * 100) / 100;
        const lineKey = pi => statementDateKey(pi.payment_date || pi.created_at);
        const latestKey = lines => lines.reduce((m, pi) => (lineKey(pi) > m ? lineKey(pi) : m), '');

        // Payment lines grouped by payment, so one payment = one statement row
        const groups = new Map();
        const addPaymentLine = (pi, label, labelKey) => {
            const gid = pi.payment_id || ('line-' + (pi.id || ('n' + (seq++))));
            let g = groups.get(gid);
            if (!g) { g = { lines: [], labels: [] }; groups.set(gid, g); }
            g.lines.push(pi);
            g.labels.push({ label, labelKey });
        };

        openingPayments.forEach(pi => addPaymentLine(pi, 'Opening Balance', ''));

        payables.forEach(sp => {
            const amount = sp.total_amount || 0;
            const invoiceNumber = sp.invoice_number || 'INV-' + sp.id.slice(0, 8);
            const invoiceKey = statementDateKey(sp.invoice_date || sp.created_at);

            // Human-readable GRN/PO number instead of the raw UUID
            const relatedGrn = state.grns.find(g => g.id === sp.grn_id);
            const relatedPo = state.purchaseOrders.find(p => p.id === sp.po_id);
            const referenceDisplay = relatedGrn?.grn_number || relatedPo?.po_number || 'PO';

            const paymentsAgainst = state.paymentInvoices.filter(pi => pi.supplier_id === supplier.id && pi.payable_id === sp.id);
            const paidAmount = round2(paymentsAgainst.reduce((sum, pi) => sum + (pi.amount_paid || 0), 0));

            events.push({
                key: invoiceKey, order: 0, seq: seq++,
                stamp: new Date(sp.created_at || 0).getTime() || 0,
                row: {
                    type: 'Purchase', reference: referenceDisplay, due: amount, amount: amount,
                    isOpening: false, isPayment: false, invoiceNumber: invoiceNumber,
                    invoiceDate: statementDateLabel(invoiceKey),
                    paidSoFar: paidAmount, remaining: round2(amount - paidAmount),
                    paidOn: paymentsAgainst.length ? statementDateLabel(latestKey(paymentsAgainst)) : '',
                    payableId: sp.id
                }
            });

            paymentsAgainst.forEach(pi => addPaymentLine(pi, invoiceNumber, invoiceKey));
        });

        groups.forEach(g => {
            const lines = g.lines;
            const total = round2(lines.reduce((sum, pi) => sum + (pi.amount_paid || 0), 0));
            const first = lines[0];
            const payRec = (state.payments || []).find(p => p.id === first.payment_id);
            const reference = lines.map(pi => pi.payment_reference).find(Boolean)
                || (payRec && (payRec.reference_number || payRec.payment_number)) || 'PAY';
            const seen = new Set();
            const label = g.labels
                .sort((x, y) => x.labelKey.localeCompare(y.labelKey) || x.label.localeCompare(y.label))
                .filter(l => !seen.has(l.label) && seen.add(l.label))
                .map(l => l.label).join('/');
            events.push({
                key: lines.map(lineKey).sort()[0], order: 1, seq: seq++,
                stamp: Math.min.apply(null, lines.map(pi => new Date(pi.created_at || 0).getTime() || 0)),
                row: {
                    type: 'Payment', reference: reference, due: 0, amount: -total, credit: total,
                    isOpening: false, isPayment: true, method: first.payment_method,
                    invoiceNumber: label || '-', paymentId: first.payment_id
                }
            });
        });

        // Same day: invoices first, then payments; otherwise by entry time.
        events.sort((a, b) =>
            a.key.localeCompare(b.key) || a.order - b.order || a.stamp - b.stamp || a.seq - b.seq
        );

        const rows = [];
        let running = opening;
        if (opening > 0 || openingPayments.length > 0) {
            const paidOpening = round2(openingPayments.reduce((sum, pi) => sum + (pi.amount_paid || 0), 0));
            rows.push({
                date: 'Opening Balance', type: 'Opening Balance', reference: 'Opening',
                due: opening, amount: opening, balance: running, isOpening: true, invoiceNumber: '-',
                paidSoFar: paidOpening, remaining: round2(opening - paidOpening),
                paidOn: openingPayments.length ? statementDateLabel(latestKey(openingPayments)) : ''
            });
        }
        events.forEach(ev => {
            running = round2(running + ev.row.amount); // invoices add, payments are already negative
            rows.push(Object.assign({ date: statementDateLabel(ev.key), balance: running }, ev.row));
        });
        return rows;
    }

    // ---- shared HTML for the statement table (modal + print) ----
    const STMT_INFO_STYLE = 'background:#f8fafc; color:#64748b; font-size:0.85em;';

    function statementHeadHtml(currency) {
        return `
                    <tr>
                        <th>Date</th>
                        <th>Invoice #</th>
                        <th>Type</th>
                        <th>Reference</th>
                        <th style="text-align: right;">Amount (${currency}) DUE</th>
                        <th style="text-align: right;">Amount (${currency}) PAID</th>
                        <th style="text-align: right;">Balance (${currency})</th>
                        <th style="text-align: right; ${STMT_INFO_STYLE}">Paid so far (${currency})</th>
                        <th style="text-align: right; ${STMT_INFO_STYLE}">PAID ON</th>
                        <th style="text-align: right; ${STMT_INFO_STYLE}">Remaining (${currency})</th>
                    </tr>`;
    }

    // The ten cell texts of one statement row. Used by the screen/print table
    // AND the PDF download, so all three always show exactly the same figures.
    function statementRowCells(t, symbol) {
        const f = n => symbol + formatNumber(n);
        const isPayment = !!t.isPayment;
        return [
            t.date,
            t.invoiceNumber || '-',
            t.type + (t.method ? ' (' + t.method + ')' : ''),
            t.reference,
            isPayment ? '-' : f(t.due !== undefined ? t.due : t.amount),   // Amount DUE
            isPayment ? f(Math.abs(t.amount)) : '',                         // Amount PAID
            f(t.balance),                                                   // Balance
            isPayment ? '-' : f(t.paidSoFar || 0),                          // Paid so far (info)
            isPayment ? '-' : (t.paidOn || ''),                             // PAID ON (info)
            isPayment ? '-' : f(t.remaining || 0)                           // Remaining (info)
        ];
    }

    function statementRowHtml(t, symbol) {
        const isPayment = !!t.isPayment;
        const c = statementRowCells(t, symbol);
        return `
                <tr class="${t.isOpening ? 'total-row' : ''}">
                    <td>${c[0]}</td>
                    <td><strong>${c[1]}</strong></td>
                    <td>${c[2]}</td>
                    <td>${c[3]}</td>
                    <td class="text-right ${!isPayment && t.amount > 0 ? 'debit' : ''}">${c[4]}</td>
                    <td class="text-right ${isPayment ? 'credit' : ''}">${c[5]}</td>
                    <td class="text-right"><strong>${c[6]}</strong></td>
                    <td class="text-right" style="${STMT_INFO_STYLE}">${c[7]}</td>
                    <td class="text-right" style="${STMT_INFO_STYLE}">${c[8]}</td>
                    <td class="text-right" style="${STMT_INFO_STYLE}">${c[9]}</td>
                </tr>`;
    }

    function statementFootHtml(currency, symbol, closingBalance) {
        return `
                    <tr class="total-row">
                        <td colspan="6" style="text-align: right;">Closing Balance (${currency}):</td>
                        <td style="text-align: right; color: ${closingBalance > 0 ? '#dc2626' : '#15803d'};">${symbol}${formatNumber(closingBalance)}</td>
                        <td colspan="3" style="${STMT_INFO_STYLE}"></td>
                    </tr>`;
    }

    async function openSupplierStatement(supplierId) {
        try {
            const supplier = state.suppliers.find(s => s.id === supplierId);
            if (!supplier) {
                showToast('Supplier not found', 'error');
                return;
            }

            // Get payables for this supplier
            const supplierPayables = state.supplierPayables.filter(sp => sp.supplier_id === supplierId);
            
            // 🔥 FIX: the statement used to compute each row's running
            // balance WHILE building the list (an invoice, then straight
            // away that invoice's payments), and only afterwards re-sort
            // the rows by date -- so a payment made on 10/10 against an
            // invoice from March was pushed to the bottom of the list but
            // kept the balance it had when it was built right after that
            // March invoice. Every "Balance" figure after the first few
            // rows was therefore out of step with the row it was printed
            // on. Now every event (invoice, payment) is collected first,
            // sorted into true date order, and ONLY THEN is the running
            // balance worked out -- one pass, top to bottom, so each row's
            // balance is exactly the previous row's balance +/- its own
            // amount. Invoices that are already fully paid (remaining 0)
            // stay in the list like any other row.
            const transactionsUsd = buildStatementLedger(supplier, supplierPayables, 'USD');
            const transactionsZmw = buildStatementLedger(supplier, supplierPayables, 'ZMW');
            const runningUsd = transactionsUsd.length ? transactionsUsd[transactionsUsd.length - 1].balance : (supplier.opening_balance_usd || 0);
            const runningZmw = transactionsZmw.length ? transactionsZmw[transactionsZmw.length - 1].balance : (supplier.opening_balance_zmw || 0);

            state.currentStatementData = {
                supplier,
                transactionsUsd,
                transactionsZmw,
                closingUsd: runningUsd,
                closingZmw: runningZmw
            };

            state.currentCurrencyTab = 'USD'; // the modal always opens on the USD tab
            renderStatement(state.currentStatementData);
            document.getElementById('statementModal').classList.add('show');
        } catch (error) {
            console.error('Error opening statement:', error);
            showToast('Error loading statement: ' + error.message, 'error');
        }
    }

    function renderStatement(data) {
        const content = document.getElementById('statementContent');
        const { supplier, transactionsUsd, transactionsZmw, closingUsd, closingZmw } = data;
        
        let html = `
            <div class="statement-header">
                <h2 style="margin-bottom:2px;">Griffins Medicals Limited</h2>
                <p style="margin:0 0 12px; color:#64748b; font-size:0.8rem; text-transform:uppercase; letter-spacing:0.05em;">Supplier Statement</p>
                <div style="text-align:left; background:#f8fafc; padding:10px 15px; border-radius:6px; font-size:0.9rem;">
                    <strong>Statement For:</strong> ${supplier.name}<br>
                    ${supplier.address || ''} ${supplier.phone ? '| Phone: ' + supplier.phone : ''}<br>
                    Email: ${supplier.email || 'N/A'}
                </div>
            </div>

            <div class="statement-info">
                <table>
                    <tr>
                        <td class="label">Opening Balance (USD):</td>
                        <td>$${formatNumber(supplier.opening_balance_usd || 0)}</td>
                        <td class="label">Opening Balance (ZMW):</td>
                        <td>ZK${formatNumber(supplier.opening_balance_zmw || 0)}</td>
                    </tr>
                    <tr>
                        <td class="label">Closing Balance (USD):</td>
                        <td style="font-weight: bold; color: ${closingUsd > 0 ? '#dc2626' : '#15803d'};">$${formatNumber(closingUsd)}</td>
                        <td class="label">Closing Balance (ZMW):</td>
                        <td style="font-weight: bold; color: ${closingZmw > 0 ? '#dc2626' : '#15803d'};">ZK${formatNumber(closingZmw)}</td>
                    </tr>
                </table>
            </div>

            <div class="statement-tabs">
                <div class="statement-tab active" data-currency="USD" onclick="switchStatementTab('USD')">
                    USD Transactions
                    ${closingUsd > 0 ? `<span style="color: #dc2626; font-weight: bold;"> (Due: $${formatNumber(closingUsd)})</span>` : ''}
                </div>
                <div class="statement-tab" data-currency="ZMW" onclick="switchStatementTab('ZMW')">
                    ZMW Transactions
                    ${closingZmw > 0 ? `<span style="color: #dc2626; font-weight: bold;"> (Due: ZK${formatNumber(closingZmw)})</span>` : ''}
                </div>
            </div>

            <div id="statementTableContainer">
                ${renderStatementTable(transactionsUsd, 'USD', closingUsd)}
            </div>
        `;

        content.innerHTML = html;
    }

    function renderStatementTable(transactions, currency, closingBalance) {
        const symbol = currency === 'USD' ? '$' : 'ZK';

        if (transactions.length === 0) {
            return `<p style="text-align: center; padding: 30px; color: #94a3b8;">No ${currency} transactions found.</p>`;
        }

        return `
            <div style="overflow-x: auto;">
            <table class="statement-table">
                <thead>${statementHeadHtml(currency)}
                </thead>
                <tbody>${transactions.map(t => statementRowHtml(t, symbol)).join('')}
                </tbody>
                <tfoot>${statementFootHtml(currency, symbol, closingBalance)}
                </tfoot>
            </table>
            </div>
            <p style="font-size: 0.72rem; color: #94a3b8; margin: 6px 2px 0;">
                Balance = previous balance + Amount DUE &minus; Amount PAID. The grey columns (Paid so far, PAID ON, Remaining) are for information only and do not change the balance.
            </p>
        `;
    }

    function switchStatementTab(currency) {
        state.currentCurrencyTab = currency;
        
        document.querySelectorAll('.statement-tab').forEach(tab => {
            tab.classList.remove('active');
            if (tab.dataset.currency === currency) {
                tab.classList.add('active');
            }
        });

        const data = state.currentStatementData;
        if (!data) return;
        
        const container = document.getElementById('statementTableContainer');
        const transactions = currency === 'USD' ? data.transactionsUsd : data.transactionsZmw;
        const closingBalance = currency === 'USD' ? data.closingUsd : data.closingZmw;
        
        container.innerHTML = renderStatementTable(transactions, currency, closingBalance);
    }

    function printStatement() {
        const data = state.currentStatementData;
        if (!data) return;
        
        const currency = state.currentCurrencyTab;
        const symbol = currency === 'USD' ? '$' : 'ZK';
        const transactions = currency === 'USD' ? data.transactionsUsd : data.transactionsZmw;
        const closingBalance = currency === 'USD' ? data.closingUsd : data.closingZmw;
        const openingBalance = currency === 'USD' ? data.supplier.opening_balance_usd || 0 : data.supplier.opening_balance_zmw || 0;
        
        const printContent = `
            <div class="statement-header">
                <h1>Griffins Medicals Limited</h1>
                <p class="statement-subtitle">Supplier Statement</p>
                <div class="statement-for">
                    <strong>Statement For:</strong> ${data.supplier.name}<br>
                    ${data.supplier.address || ''} ${data.supplier.phone ? '| Phone: ' + data.supplier.phone : ''}<br>
                    Email: ${data.supplier.email || 'N/A'}
                </div>
            </div>

            <div class="statement-info">
                <table>
                    <tr>
                        <td class="label">Opening Balance (${currency}):</td>
                        <td>${symbol}${formatNumber(openingBalance)}</td>
                    </tr>
                    <tr>
                        <td class="label">Closing Balance (${currency}):</td>
                        <td style="font-weight: bold; color: ${closingBalance > 0 ? '#dc2626' : '#15803d'};">${symbol}${formatNumber(closingBalance)}</td>
                    </tr>
                </table>
            </div>

            <table class="statement-table">
                <thead>${statementHeadHtml(currency)}
                </thead>
                <tbody>${transactions.map(t => statementRowHtml(t, symbol)).join('')}
                </tbody>
                <tfoot>${statementFootHtml(currency, symbol, closingBalance)}
                </tfoot>
            </table>
            <p style="font-size: 0.75rem; color: #64748b;">The grey columns (Paid so far, PAID ON, Remaining) are for information only.</p>
        `;
        
        const printWindow = window.open('', '_blank', 'width=800,height=600');
        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Supplier Statement - ${data.supplier.name} (${currency})</title>
                <style>
                    body { font-family: Arial, sans-serif; padding: 20px; max-width: 1150px; margin: 0 auto; }
                    .statement-header { text-align: center; border-bottom: 2px solid #333; padding-bottom: 15px; margin-bottom: 20px; }
                    .statement-header h1 { margin: 0; color: #0f172a; font-size: 1.5rem; }
                    .statement-subtitle { margin: 4px 0 15px 0; color: #64748b; font-size: 0.95rem; text-transform: uppercase; letter-spacing: 0.05em; }
                    .statement-for { text-align: left; background: #f8fafc; padding: 10px 15px; border-radius: 6px; font-size: 0.9rem; line-height: 1.6; }
                    .statement-info { background: #f8fafc; padding: 15px; border-radius: 6px; margin-bottom: 20px; }
                    .statement-info table { width: 100%; }
                    .statement-info td { padding: 4px 8px; }
                    .statement-info .label { font-weight: 600; width: 150px; }
                    table { width: 100%; border-collapse: collapse; margin: 15px 0; font-size: 0.9rem; }
                    th { background: #f1f5f9; padding: 10px; text-align: left; border: 1px solid #e2e8f0; }
                    td { padding: 10px; border: 1px solid #e2e8f0; }
                    .statement-table th, .statement-table td { padding: 6px 7px; font-size: 0.78rem; }
                    .text-right { text-align: right; }
                    .total-row { font-weight: bold; background: #f8fafc; }
                    .credit { color: #15803d; }
                    .debit { color: #dc2626; }
                    @media print {
                        body { margin: 0; padding: 10px; }
                        .no-print { display: none; }
                    }
                </style>
            </head>
            <body>
                ${printContent}
                <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e2e8f0; color: #64748b; font-size: 0.9rem;">
                    <p>This is a computer-generated statement.</p>
                    <p>Generated on: ${new Date().toLocaleString()}</p>
                </div>
            </body>
            </html>
        `);
        printWindow.document.close();
        setTimeout(() => {
            printWindow.focus();
            printWindow.print();
        }, 500);
    }

    // ============================================
    // STATEMENT PDF DOWNLOAD
    // ============================================
    // Same layout and same figures as the on-screen / printed statement
    // (rows come from statementRowCells), saved as a real PDF file for the
    // tab that is currently showing. jsPDF is loaded on demand, exactly like
    // the Purchase Order PDF does.
    async function ensureStatementPdfLibs() {
        const load = src => new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src;
            s.onload = resolve;
            s.onerror = () => reject(new Error('Could not load the PDF library -- check your internet connection.'));
            document.head.appendChild(s);
        });
        if (!(window.jspdf && window.jspdf.jsPDF)) {
            await load('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.2/jspdf.umd.min.js');
        }
        const probe = new window.jspdf.jsPDF();
        if (typeof probe.autoTable !== 'function') {
            await load('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js');
        }
    }

    function buildStatementPdf(data, currency) {
        const { jsPDF } = window.jspdf;
        const symbol = currency === 'USD' ? '$' : 'ZK';
        const transactions = currency === 'USD' ? data.transactionsUsd : data.transactionsZmw;
        const closingBalance = currency === 'USD' ? data.closingUsd : data.closingZmw;
        const openingBalance = (currency === 'USD' ? data.supplier.opening_balance_usd : data.supplier.opening_balance_zmw) || 0;
        const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
        const pageW = doc.internal.pageSize.getWidth();
        const f = n => symbol + formatNumber(n);

        doc.setTextColor(15, 23, 42);
        doc.setFont(undefined, 'bold');
        doc.setFontSize(16);
        doc.text('Griffins Medicals Limited', pageW / 2, 14, { align: 'center' });
        doc.setFont(undefined, 'normal');
        doc.setFontSize(9);
        doc.setTextColor(100, 116, 139);
        doc.text('SUPPLIER STATEMENT', pageW / 2, 19.5, { align: 'center' });

        doc.setTextColor(15, 23, 42);
        doc.setFontSize(10);
        let y = 28;
        const info = [
            ['Statement For:', String(data.supplier.name || '')],
            ['Address / Phone:', [data.supplier.address, data.supplier.phone].filter(Boolean).join('  |  ') || '-'],
            ['Email:', String(data.supplier.email || 'N/A')],
            ['Opening Balance (' + currency + '):', f(openingBalance)],
            ['Closing Balance (' + currency + '):', f(closingBalance)]
        ];
        info.forEach(([label, value]) => {
            doc.setFont(undefined, 'bold');
            doc.text(label, 14, y);
            doc.setFont(undefined, 'normal');
            doc.text(value, 64, y);
            y += 5.5;
        });

        const head = [[
            'Date', 'Invoice #', 'Type', 'Reference',
            'Amount (' + currency + ') DUE', 'Amount (' + currency + ') PAID', 'Balance (' + currency + ')',
            'Paid so far (' + currency + ')', 'PAID ON', 'Remaining (' + currency + ')'
        ]];
        const body = transactions.map(t => statementRowCells(t, symbol));
        const infoFill = [248, 250, 252];
        const infoText = [100, 116, 139];

        doc.autoTable({
            startY: y + 3,
            head: head,
            body: body,
            foot: [[
                { content: 'Closing Balance (' + currency + '):', colSpan: 6, styles: { halign: 'right' } },
                { content: f(closingBalance), styles: { halign: 'right', textColor: closingBalance > 0 ? [220, 38, 38] : [21, 128, 61] } },
                { content: '', colSpan: 3 }
            ]],
            showFoot: 'lastPage',
            theme: 'grid',
            margin: { left: 10, right: 10, bottom: 14 },
            styles: { fontSize: 8, cellPadding: 1.8, lineColor: [226, 232, 240], lineWidth: 0.2, textColor: [15, 23, 42], overflow: 'linebreak' },
            headStyles: { fillColor: [241, 245, 249], textColor: [15, 23, 42], fontStyle: 'bold', halign: 'left' },
            footStyles: { fillColor: [248, 250, 252], textColor: [15, 23, 42], fontStyle: 'bold' },
            columnStyles: {
                0: { cellWidth: 24 }, 1: { cellWidth: 44 }, 2: { cellWidth: 34 }, 3: { cellWidth: 30 },
                4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right', fontStyle: 'bold' },
                7: { halign: 'right', fillColor: infoFill, textColor: infoText },
                8: { halign: 'right', fillColor: infoFill, textColor: infoText },
                9: { halign: 'right', fillColor: infoFill, textColor: infoText }
            },
            didParseCell: function (h) {
                const col = h.column.index;
                if (h.section === 'head') {
                    if (col >= 4) h.cell.styles.halign = 'right';
                    if (col >= 7) { h.cell.styles.fillColor = infoFill; h.cell.styles.textColor = infoText; }
                }
                if (h.section === 'body') {
                    const t = transactions[h.row.index];
                    if (t && t.isOpening) h.cell.styles.fontStyle = 'bold';
                    if (t && col === 1) h.cell.styles.fontStyle = 'bold';
                    if (t && t.isPayment && col === 5) h.cell.styles.textColor = [21, 128, 61];
                    if (t && !t.isPayment && col === 4 && t.amount > 0) h.cell.styles.textColor = [220, 38, 38];
                }
                if (h.section === 'foot' && col >= 7) { h.cell.styles.fillColor = infoFill; }
            },
            didDrawPage: function () {
                const pageH = doc.internal.pageSize.getHeight();
                doc.setFontSize(7.5);
                doc.setFont(undefined, 'normal');
                doc.setTextColor(100, 116, 139);
                doc.text('This is a computer-generated statement. Generated on: ' + new Date().toLocaleString(), 10, pageH - 7);
                doc.text('Page ' + doc.internal.getNumberOfPages(), pageW - 10, pageH - 7, { align: 'right' });
            }
        });

        const endY = (doc.lastAutoTable && doc.lastAutoTable.finalY) || y + 20;
        doc.setFontSize(7.5);
        doc.setTextColor(100, 116, 139);
        doc.text('Balance = previous balance + Amount DUE - Amount PAID. The grey columns (Paid so far, PAID ON, Remaining) are for information only.', 10, endY + 5);
        return doc;
    }

    async function downloadStatementPDF() {
        const data = state.currentStatementData;
        if (!data) return;
        const currency = state.currentCurrencyTab;
        const transactions = currency === 'USD' ? data.transactionsUsd : data.transactionsZmw;
        if (!transactions || transactions.length === 0) {
            showToast('No ' + currency + ' transactions to download.', 'error');
            return;
        }

        const btn = document.getElementById('statementPdfBtn');
        const original = btn ? btn.innerHTML : '';
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Preparing PDF...'; }
        try {
            await ensureStatementPdfLibs();
            const doc = buildStatementPdf(data, currency);
            const safeName = String(data.supplier.name || 'Supplier').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
            doc.save('Supplier_Statement_' + safeName + '_' + currency + '_' + statementDateKey(new Date()) + '.pdf');
        } catch (error) {
            console.error('Statement PDF failed:', error);
            showToast('Could not create the PDF: ' + error.message, 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = original; }
        }
    }

    // ============================================
    // DUE INVOICES -> EXCEL (list sent to the boss for payment)
    // ============================================
    // One row per unpaid / part-paid supplier invoice, oldest first, in the
    // same layout as the accountant's manual sheet:
    //   DATE | INV NO. | SUPPLIER NAME | INV AMOUNT ZMW | INV AMOUNT USD |
    //   STATUS | Payment Date | NOTE | MONTH
    // "Payment Date" and "NOTE" are left empty for the boss to fill in.
    // The amount shown is what is still unpaid on that invoice (same maths as
    // the Due figures on this page). Opening balances (money owed from before
    // the system, with no invoice number) are added at the bottom.
    function buildDueInvoiceRows() {
        const round2 = n => Math.round(n * 100) / 100;
        const money = (cur, n) => (cur === 'USD' ? '$' : 'ZMW ') + formatNumber(n);
        const rows = [];

        state.suppliers.forEach(supplier => {
            state.supplierPayables.filter(sp => sp.supplier_id === supplier.id).forEach(sp => {
                const cur = sp.currency === 'ZMW' ? 'ZMW' : 'USD';
                const total = sp.total_amount || 0;
                const paid = round2(state.paymentInvoices
                    .filter(pi => pi.supplier_id === supplier.id && pi.payable_id === sp.id)
                    .reduce((sum, pi) => sum + (pi.amount_paid || 0), 0));
                const remaining = round2(total - paid);
                if (remaining <= 0.005) return; // fully paid -> not on the list
                rows.push({
                    dateKey: statementDateKey(sp.invoice_date || sp.created_at),
                    invoice: sp.invoice_number || ('INV-' + String(sp.id).slice(0, 8)),
                    supplier: supplier.name,
                    zmw: cur === 'ZMW' ? remaining : 0,
                    usd: cur === 'USD' ? remaining : 0,
                    status: paid > 0.005 ? 'PART PAID' : 'DUE',
                    note: paid > 0.005 ? ('Part paid: ' + money(cur, paid) + ' of ' + money(cur, total)) : '',
                    isOpening: false
                });
            });

            ['ZMW', 'USD'].forEach(cur => {
                const opening = (cur === 'USD' ? supplier.opening_balance_usd : supplier.opening_balance_zmw) || 0;
                const paidOpening = getOpeningBalancePayments(supplier.id, cur)
                    .reduce((sum, pi) => sum + (pi.amount_paid || 0), 0);
                const remaining = round2(opening - paidOpening);
                if (remaining <= 0.005) return;
                rows.push({
                    dateKey: '',
                    invoice: 'OPENING BALANCE',
                    supplier: supplier.name,
                    zmw: cur === 'ZMW' ? remaining : 0,
                    usd: cur === 'USD' ? remaining : 0,
                    status: paidOpening > 0.005 ? 'PART PAID' : 'DUE',
                    note: 'Balance brought forward' + (paidOpening > 0.005 ? (' (part paid: ' + money(cur, paidOpening) + ' of ' + money(cur, opening) + ')') : ''),
                    isOpening: true
                });
            });
        });

        rows.sort((a, b) =>
            (a.isOpening - b.isOpening) ||
            a.dateKey.localeCompare(b.dateKey) ||
            a.supplier.localeCompare(b.supplier) ||
            String(a.invoice).localeCompare(String(b.invoice))
        );
        return rows;
    }

    async function ensureExcelJsLoaded() {
        if (window.ExcelJS) return;
        await new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js';
            s.onload = resolve;
            s.onerror = () => reject(new Error('Could not load the Excel library -- check your internet connection.'));
            document.head.appendChild(s);
        });
        if (!window.ExcelJS) throw new Error('Excel library failed to load');
    }

    async function buildDueInvoicesWorkbook(rows) {
        const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const wb = new window.ExcelJS.Workbook();
        const ws = wb.addWorksheet('Payment List', { views: [{ state: 'frozen', ySplit: 1 }] });
        const ZMW_FMT = '"ZMW "#,##0.00;-"ZMW "#,##0.00;"ZMW -"';
        const USD_FMT = '"$"#,##0.00;-"$"#,##0.00;"$-"';

        ws.columns = [
            { header: 'DATE', key: 'date', width: 12 },
            { header: 'INV NO.', key: 'inv', width: 18 },
            { header: 'SUPPLIER NAME', key: 'sup', width: 46 },
            { header: 'INV AMOUNT ZMW', key: 'zmw', width: 18 },
            { header: 'INV AMOUNT USD', key: 'usd', width: 18 },
            { header: 'STATUS', key: 'status', width: 12 },
            { header: 'Payment Date', key: 'paydate', width: 14 },
            { header: 'NOTE', key: 'note', width: 56 },
            { header: 'MONTH', key: 'month', width: 9 }
        ];
        const thin = { style: 'thin', color: { argb: 'FFBFBFBF' } };
        const border = { top: thin, left: thin, bottom: thin, right: thin };

        const head = ws.getRow(1);
        head.font = { name: 'Arial', bold: true, size: 10 };
        head.alignment = { vertical: 'middle', horizontal: 'center' };
        head.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } }; c.border = border; });

        rows.forEach(r => {
            let dateVal = null, month = '';
            if (r.dateKey && r.dateKey !== '0000-00-00') {
                const [y, m, dd] = r.dateKey.split('-').map(Number);
                dateVal = new Date(Date.UTC(y, m - 1, dd));
                month = MONTHS[m - 1];
            }
            const row = ws.addRow({
                date: dateVal, inv: r.invoice, sup: r.supplier,
                zmw: r.zmw, usd: r.usd, status: r.status, paydate: null, note: r.note, month: month
            });
            row.font = { name: 'Arial', size: 10 };
            row.getCell('date').numFmt = 'm/d/yyyy';
            row.getCell('zmw').numFmt = ZMW_FMT;
            row.getCell('usd').numFmt = USD_FMT;
            row.getCell('paydate').numFmt = 'm/d/yyyy';
            ['date', 'status', 'paydate', 'month'].forEach(k => { row.getCell(k).alignment = { horizontal: 'center' }; });
            row.eachCell({ includeEmpty: true }, c => { c.border = border; });
        });

        const first = 2, last = rows.length + 1;
        const t = ws.getRow(last + 2); // totals one blank row below the list
        t.getCell('sup').value = 'TOTAL DUE';
        t.getCell('zmw').value = { formula: 'SUM(D' + first + ':D' + last + ')', result: rows.reduce((s, r) => s + r.zmw, 0) };
        t.getCell('usd').value = { formula: 'SUM(E' + first + ':E' + last + ')', result: rows.reduce((s, r) => s + r.usd, 0) };
        t.getCell('zmw').numFmt = ZMW_FMT;
        t.getCell('usd').numFmt = USD_FMT;
        t.font = { name: 'Arial', bold: true, size: 10 };
        t.getCell('sup').alignment = { horizontal: 'right' };
        t.eachCell(c => { c.border = { top: { style: 'medium', color: { argb: 'FF000000' } } }; });

        ws.autoFilter = { from: 'A1', to: 'I' + last };
        ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
        return wb;
    }

    async function exportDueInvoicesExcel() {
        const btn = document.getElementById('exportDueBtn');
        const original = btn ? btn.innerHTML : '';
        try {
            const rows = buildDueInvoiceRows();
            if (rows.length === 0) {
                showToast('There are no unpaid invoices to export.', 'error');
                return;
            }
            if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Preparing...'; }
            await ensureExcelJsLoaded();
            const wb = await buildDueInvoicesWorkbook(rows);
            const buffer = await wb.xlsx.writeBuffer();
            const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'Supplier_Payment_List_' + statementDateKey(new Date()) + '.xlsx';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
            showToast('Payment list downloaded (' + rows.length + ' invoices).');
        } catch (error) {
            console.error('Due list export failed:', error);
            showToast('Could not create the Excel file: ' + error.message, 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = original; }
        }
    }

    // ============================================
    // RECORD PAYMENT
    // ============================================

    // 🔥 FIX: async now, so the exchange rate default below can be
    // awaited -- safe to call from an onclick attribute either way.
    async function openRecordPayment(supplierId = null) {
        document.getElementById('editPaymentId').value = '';
        document.getElementById('paymentDate').value = new Date().toISOString().split('T')[0];
        document.getElementById('paymentCurrency').value = 'USD';
        document.getElementById('paymentAmount').value = '';
        document.getElementById('paymentMethod').value = 'Cash';
        document.getElementById('paymentReference').value = '';
        document.getElementById('paymentNotes').value = '';
        // 🔥 ADDED: defaults from the Dashboard's shared exchange rate
        // (assets/js/shared-exchange-rate.js) instead of a hardcoded
        // 25.00 -- still editable here if this specific payment needs a
        // different rate.
        document.getElementById('paymentExchangeRate').value = await getSharedExchangeRate();
        document.getElementById('exchangeRateGroup').style.display = 'none';
        document.getElementById('paymentSummary').style.display = 'none';

        // Settling defaults to USD above, so "Bank Account (USD)" should
        // already be selectable, even before a supplier is picked.
        const usdBankOption = document.getElementById('usdBankPaymentOption');
        if (usdBankOption) usdBankOption.style.display = '';

        populatePaymentSuppliers();

        if (supplierId) {
            document.getElementById('paymentSupplier').value = supplierId;
            loadInvoicesForSupplier(supplierId);
        }

        document.getElementById('paymentModal').classList.add('show');
    }

    function populatePaymentSuppliers() {
        const select = document.getElementById('paymentSupplier');
        const suppliersWithDue = calculateSupplierBalances().filter(s => s.hasDue);
        select.innerHTML = `<option value="">Select Supplier</option>` + 
            suppliersWithDue.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
    }

    // ============================================
    // SAVE PAYMENT (UPDATED WITH PAYABLE_ID)
    // ============================================

    // ============================================
    // 🔥 ADDED: WHATSAPP SUPPLIER NOTIFICATION (Payment made)
    // ============================================
    // Same helper/pattern as Purchase's PO-created notification -- see
    // that file's comment for the full explanation of why this won't
    // actually send anything until (1) the WhatsApp number is verified in
    // Meta and (2) WHATSAPP_TEMPLATES.PAYMENT_MADE below is a real,
    // Meta-approved template name (this one is a placeholder). Every call
    // fails harmlessly -- console-only -- until then, and is never
    // awaited, so it can't delay or block the payment save.
    const WHATSAPP_TEMPLATES = {
        PAYMENT_MADE: 'supplier_payment_notice'
    };

    async function notifySupplierWhatsApp(phone, templateName, bodyParams) {
        if (!phone) {
            console.log('WhatsApp: this supplier has no phone number on file -- skipping notification.');
            return;
        }
        try {
            const { data, error } = await supabaseClient.functions.invoke('send-whatsapp-message', {
                body: {
                    to: phone,
                    template_name: templateName,
                    components: [{
                        type: 'body',
                        parameters: bodyParams.map(p => ({ type: 'text', text: String(p) }))
                    }]
                }
            });
            if (error) {
                console.warn(`WhatsApp notification (${templateName}) did not send -- expected until the WhatsApp number is verified and this template is approved in Meta:`, error);
                return;
            }
            console.log(`✅ WhatsApp notification sent (${templateName}):`, data);
        } catch (err) {
            console.warn(`WhatsApp notification (${templateName}) failed:`, err);
        }
    }

    // ============================================
    // 🔥 ADDED: AUTH-RETRY ON WRITE
    // ============================================
    // Same pattern already used elsewhere in the app (Retail POS's label
    // printing, the Dashboard's notice board) for a stale/expired login
    // session getting rejected by RLS on a write -- refresh the session
    // once and retry the SAME write once before giving up. Wraps the
    // financial writes below (payment record, supplier_payables sync) so
    // a stale session doesn't force staff to lose a half-entered payment
    // and start over.
    async function withAuthRetry(operationFn) {
        let result = await operationFn();
        const err = result?.error;
        const looksLikeAuthRejection = err && (
            err.code === '42501' ||
            err.code === 'PGRST301' ||
            /row-level security|jwt|permission denied/i.test(err.message || '')
        );
        if (looksLikeAuthRejection) {
            console.warn('⚠️ Write rejected (looks like a stale session) -- refreshing session and retrying once:', err.message);
            try { await supabaseClient.auth.refreshSession(); } catch (refreshError) { console.error('Session refresh failed:', refreshError); }
            result = await operationFn();
        }
        return result;
    }

    async function savePayment() {
        const supplierId = document.getElementById('paymentSupplier').value;
        const paymentDate = document.getElementById('paymentDate').value;
        // "Settling" -- which currency's invoices this payment applies to.
        const settlingCurrency = document.getElementById('paymentCurrency').value;
        const method = document.getElementById('paymentMethod').value;
        // 🔥 ADDED: paying directly out of the USD bank account -- the cash
        // movement is USD, not ZMW, and no exchange rate applies at all.
        const payingDirectlyInUsd = method === 'Bank Transfer USD';
        const reference = document.getElementById('paymentReference').value.trim();
        const notes = document.getElementById('paymentNotes').value.trim();
        const exchangeRate = parseFloat(document.getElementById('paymentExchangeRate').value) || 0;

        if (!supplierId) {
            showToast('Please select a supplier', 'error');
            return;
        }
        if (!paymentDate) {
            showToast('Please select a payment date', 'error');
            return;
        }
        // Exchange rate is mandatory whenever settling USD invoices with
        // ZMW cash/bank -- not needed at all when paying directly out of
        // the USD bank account (payingDirectlyInUsd), since nothing is
        // being converted.
        if (settlingCurrency === 'USD' && !payingDirectlyInUsd && (!exchangeRate || exchangeRate <= 0)) {
            showToast('Please enter a valid exchange rate to settle USD invoices with ZMW cash', 'error');
            return;
        }

        // Get selected items -- FIX: all checkboxes are now the SAME
        // currency (settlingCurrency), since loadInvoicesForSupplier only
        // ever renders one currency's invoices at a time. No more mixing.
        // 🔥 CHANGED: each item now carries its OWN pay amount, read from
        // the Pay Amount box next to its checkbox, instead of a single
        // overall figure getting auto-allocated across all of them. This
        // is what actually makes a half/partial payment on one specific
        // selected invoice possible.
        const selectedItems = [];
        document.querySelectorAll('.invoice-checkbox:checked').forEach(cb => {
            const remaining = parseFloat(cb.dataset.amount) || 0;
            const amountInputForRow = getPaymentAmountInputFor(cb);
            let payAmount = amountInputForRow ? parseFloat(amountInputForRow.value) : remaining;
            if (isNaN(payAmount) || payAmount <= 0) payAmount = 0;
            if (payAmount > remaining) payAmount = remaining;
            selectedItems.push({
                id: cb.dataset.id,
                payableId: cb.dataset.payableId || null,
                poId: cb.dataset.poId || null,
                remaining: remaining,
                payAmount: payAmount,
                isOpening: cb.dataset.isOpening === 'true'
            });
        });

        if (selectedItems.length === 0) {
            showToast(`Please select at least one ${settlingCurrency} invoice or opening balance to pay`, 'error');
            return;
        }

        // Drop anything ticked with a zero/blank Pay Amount rather than
        // silently including it as a no-op line.
        const itemsToPay = selectedItems.filter(item => item.payAmount > 0);
        if (itemsToPay.length === 0) {
            showToast('Enter a pay amount greater than 0 for at least one selected item', 'error');
            return;
        }

        // How much of the SELECTED CURRENCY's debt does this payment
        // clear -- now the sum of each item's own pay amount, not one
        // overall figure. Paying directly in USD, or settling ZMW
        // invoices, is a direct 1:1 with the cash moved. Only "USD
        // invoices paid via ZMW cash" needs converting this into the ZMW
        // amount actually handed over.
        const amountInSelectedCurrency = itemsToPay.reduce((sum, item) => sum + item.payAmount, 0);
        const amountEntered = (settlingCurrency === 'USD' && !payingDirectlyInUsd)
            ? amountInSelectedCurrency * exchangeRate
            : amountInSelectedCurrency;

        // FIX: single-currency distribution -- no more bidirectional
        // USD<->ZMW blending. Exactly one of these two is non-zero.
        const amountUsd = settlingCurrency === 'USD' ? amountInSelectedCurrency : 0;
        const amountZmw = settlingCurrency === 'ZMW' ? amountInSelectedCurrency : 0;

        try {
            const paymentNumber = `PAY-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;

            // 🔥 ADDED: `amount` is read elsewhere in the app (Transaction
            // Overview, this module's own "Total Paid Today" stat) as a
            // ZMW figure and displayed with a "K" prefix -- always has
            // been. Paying directly in USD has no ZMW figure by design
            // (that's the point), so for THAT display/reporting purpose
            // only, a ZMW-equivalent is derived silently from today's
            // shared Dashboard exchange rate -- the user is never asked
            // for a rate on this path. This does NOT affect the actual
            // accounting: the GL entry and the invoice settlement below
            // both still use the real, raw USD amount.
            const displayZmwRate = payingDirectlyInUsd ? await getSharedExchangeRate() : exchangeRate;
            const displayAmount = payingDirectlyInUsd ? amountEntered * displayZmwRate : amountEntered;

            const paymentData = {
                supplier_id: supplierId,
                payment_number: paymentNumber,
                payment_date: paymentDate,
                currency: settlingCurrency,
                amount: displayAmount,
                amount_usd: amountUsd,
                amount_zmw: amountZmw,
                payment_method: method,
                reference_number: reference || null,
                notes: notes || null,
                status: 'Paid',
                exchange_rate: (settlingCurrency === 'USD') ? displayZmwRate : 1
            };

            // 🔥 ADDED: withAuthRetry -- a stale session here used to mean
            // the whole payment failed outright and had to be re-entered
            // from scratch; now retried once after a session refresh
            // before actually giving up.
            const { data: payment, error: paymentError } = await withAuthRetry(() => supabaseClient
                .from('payments')
                .insert([paymentData])
                .select());

            if (paymentError) throw paymentError;

            const paymentId = payment[0].id;
            const paymentInvoicesToInsert = [];
            // 🔥 FIX: this is the actual "Purchase not talking to Payable"
            // bug. Purchase's createSupplierPayable() writes amount_paid,
            // amount_remaining, and status ONCE at creation and never
            // touches them again. This module was computing paid/remaining
            // itself by joining payment_invoices (which is why the list
            // and statement views were correct) but never wrote that
            // result back onto the supplier_payables row Purchase created
            // -- so that row sat there forever saying status:'Pending' and
            // the full original amount_remaining, no matter how much was
            // actually paid. Anything reading supplier_payables directly
            // (rather than re-deriving it the same way this file does)
            // would see permanently stale data. Collected here and applied
            // after the distribution loop below.
            const payableUpdates = [];

            // 🔥 CHANGED: each item now settles for exactly the amount typed
            // into its own Pay Amount box (already clamped to that item's
            // remaining balance above), instead of one overall figure being
            // distributed oldest-first across everything ticked. This is
            // what actually lets one specific selected invoice be paid in
            // half while another ticked alongside it is paid in full (or
            // not touched further at all).
            for (const item of itemsToPay) {
                const amountToPay = item.payAmount;
                if (amountToPay > 0) {
                    paymentInvoicesToInsert.push({
                        payment_id: paymentId,
                        purchase_order_id: item.isOpening ? null : item.poId,
                        payable_id: item.payableId || null,
                        supplier_id: supplierId,
                        amount_paid: amountToPay,
                        currency: settlingCurrency,
                        payment_date: paymentDate,
                        payment_method: method,
                        payment_reference: reference || null,
                        status: amountToPay >= item.remaining ? 'paid' : 'partial',
                        is_opening_balance: item.isOpening
                    });

                    // Opening-balance items have no payableId (they're not
                    // a real supplier_payables row) -- only real payables
                    // need writing back.
                    if (item.payableId) {
                        payableUpdates.push({ payableId: item.payableId, amountToPay });
                    }
                }
            }

            if (paymentInvoicesToInsert.length > 0) {
                const { error: piError } = await withAuthRetry(() => supabaseClient
                    .from('payment_invoices')
                    .insert(paymentInvoicesToInsert));

                if (piError) throw piError;
            }

            // Write the payment back onto each supplier_payables row it
            // actually settled, so the payable record itself is truthful
            // -- not just re-derivable via a join. Non-fatal if it fails:
            // the payment itself is already safely recorded above, and
            // this module's own calculations don't depend on these
            // fields, but keeping them in sync matters for anything else
            // that reads supplier_payables directly.
            for (const { payableId, amountToPay } of payableUpdates) {
                try {
                    const payable = state.supplierPayables.find(sp => sp.id === payableId);
                    const priorPaid = payable?.amount_paid || 0;
                    const totalAmount = payable?.total_amount || 0;
                    const newAmountPaid = priorPaid + amountToPay;
                    const newAmountRemaining = Math.max(0, totalAmount - newAmountPaid);

                    // 🔥 ADDED: withAuthRetry -- this is exactly the write
                    // the comment above already flagged as having gone
                    // stale for real in the past (permanently stuck
                    // 'Pending' rows). A retry after a session refresh
                    // fixes the most common cause of that outright.
                    const { error: payableUpdateError } = await withAuthRetry(() => supabaseClient
                        .from('supplier_payables')
                        .update({
                            amount_paid: newAmountPaid,
                            amount_remaining: newAmountRemaining,
                            status: newAmountRemaining <= 0.01 ? 'Paid' : 'Partial'
                        })
                        .eq('id', payableId));

                    if (payableUpdateError) {
                        console.error('Error updating supplier_payables record:', payableUpdateError);
                    }
                } catch (err) {
                    console.error('Error syncing supplier_payables record:', err);
                }
            }

            // Post to the general ledger: Debit Accounts Payable, Credit
            // Cash in Hand, Bank (ZMW), or -- 🔥 ADDED -- Bank (USD) when
            // paying directly. This module had no GL integration at all
            // before this.
            await createPaymentGLEntry(paymentNumber, paymentDate, method, amountUsd, amountZmw, exchangeRate, payingDirectlyInUsd ? 'USD' : 'ZMW');

            // 🔥 ADDED: explicit partial-vs-full confirmation, in the
            // selected invoice(s)' own currency -- so it's never a silent
            // side effect of having typed a smaller number. Same shortfall
            // check the distribution loop above already used.
            const invoiceSymbol = settlingCurrency === 'USD' ? '$' : 'ZK';
            // 🔥 FIX: `totalSelected` was a stale reference to a variable
            // scoped inside updatePaymentSummary() (undefined here), left
            // over from before per-item pay amounts existed -- this threw
            // a ReferenceError and aborted savePayment() before it could
            // reach the success toast/refresh, even though the payment had
            // already been inserted. The correct analog now is the sum of
            // each PAID item's own full remaining balance (not just what
            // was actually entered), compared against what was entered.
            const totalRemainingSelected = itemsToPay.reduce((sum, item) => sum + item.remaining, 0);
            const shortfallInSelectedCurrency = totalRemainingSelected - amountInSelectedCurrency;
            const paidSummary = `${payingDirectlyInUsd ? '$' : 'ZK'}${formatNumber(amountEntered)} paid`;
            const toastMessage = shortfallInSelectedCurrency > 0.01
                ? `Partial payment recorded! ${paidSummary}. ${invoiceSymbol}${formatNumber(shortfallInSelectedCurrency)} still due on the selected invoice(s).`
                : `Payment recorded successfully! ${paidSummary} -- selected invoice(s) fully cleared.`;
            // 🔥 ADDED: notify the supplier on WhatsApp that a payment was
            // made -- see notifySupplierWhatsApp()'s comment above.
            // Fire-and-forget, never awaited.
            const supplierRecord = (state.suppliers || []).find(s => s.id === supplierId);
            if (supplierRecord) {
                notifySupplierWhatsApp(
                    supplierRecord.phone,
                    WHATSAPP_TEMPLATES.PAYMENT_MADE,
                    [
                        supplierRecord.name || '',
                        paidSummary,
                        paymentNumber,
                        formatDate(paymentDate)
                    ]
                );
            }

            showToast(toastMessage, 'success');
            closeModal('paymentModal');
            await refreshPaymentList();
        } catch (error) {
            console.error('Error saving payment:', error);
            showToast('Error saving payment: ' + error.message, 'error');
        }
    }


    // ============================================
    // REFRESH
    // ============================================

    async function refreshPaymentList() {
        await loadPayments();
        await loadPurchaseOrders();
        await loadSupplierPayables();
        await loadGRNs();
        await loadPaymentInvoices();
        const supplierData = calculateSupplierBalances();
        renderPaymentList(supplierData);
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
        toast.style.cssText = `
            position: fixed; top: 20px; right: 20px; 
            padding: 16px 24px; border-radius: 8px; 
            color: white; font-weight: 500; z-index: 9999;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            animation: slideIn 0.3s ease;
            background: ${type === 'success' ? '#059669' : '#dc2626'};
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

        document.getElementById('paymentSupplier').addEventListener('change', function() {
            loadInvoicesForSupplier(this.value);
        });

        // 🔥 FIX: switching Settling currency now needs to reload the whole
        // invoice list (it shows only one currency's invoices at a time),
        // not just toggle the exchange rate field.
        document.getElementById('paymentCurrency').addEventListener('change', function() {
            document.getElementById('paymentAmount').value = '';
            const supplierId = document.getElementById('paymentSupplier').value;
            loadInvoicesForSupplier(supplierId);
        });

        // 🔥 ADDED: switching Payment Method (e.g. ZMW cash <-> the new
        // "Bank Account (USD)" option) changes which currency the entered
        // amount means -- clear it so a ZMW figure never gets silently
        // reinterpreted as USD (or vice versa), then refresh the
        // label/max/placeholder/exchange-rate visibility for the new method.
        document.getElementById('paymentMethod').addEventListener('change', function() {
            document.getElementById('paymentAmount').value = '';
            updatePaymentSummary();
        });

        document.addEventListener('change', function(e) {
            if (e.target.classList.contains('invoice-checkbox')) {
                updatePaymentSummary();
            }
        });

        document.getElementById('searchPayment').addEventListener('input', () => {
            const supplierData = calculateSupplierBalances();
            renderPaymentList(supplierData);
        });

        document.getElementById('paymentExchangeRate').addEventListener('input', function() {
            updatePaymentSummary();
        });

        // 🔥 REMOVED: "Total to Pay" used to be free-text with its own
        // clamp-on-input listener here. It's now read-only and computed
        // entirely from each invoice's own Pay Amount box (see
        // onPaymentAmountInput / updatePaymentSummary above), so there's
        // nothing left for the user to type into it directly.
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
    window.openRecordPayment = openRecordPayment;
    window.savePayment = savePayment;
    window.openSupplierStatement = openSupplierStatement;
    window.switchStatementTab = switchStatementTab;
    window.printStatement = printStatement;
    window.downloadStatementPDF = downloadStatementPDF;
    window.exportDueInvoicesExcel = exportDueInvoicesExcel;
    window.closeModal = closeModal;
    window.refreshPaymentList = refreshPaymentList;
    window.showToast = showToast;
    window.updatePaymentSummary = updatePaymentSummary;
    window.loadInvoicesForSupplier = loadInvoicesForSupplier;

    // ============================================
    // INITIALIZE
    // ============================================
    await ensureChartOfAccounts();
    await loadSuppliers();
    await loadPayments();
    await loadPurchaseOrders();
    await loadSupplierPayables();
    await loadGRNs();
    await loadPaymentInvoices();

    // 🔥 If the user navigated away from Payments at any point during the
    // 7 awaits above, this DOM no longer belongs to this run -- stop here
    // instead of crashing on elements that aren't there anymore. See the
    // paymentModuleSentinel comment near the top of this file.
    if (!paymentModuleStillMounted()) {
        console.log('ℹ️ Payment module: navigated away before init finished -- skipping DOM setup for this stale run.');
        return;
    }

    const supplierData = calculateSupplierBalances();
    renderPaymentList(supplierData);
    setupEventListeners();

    console.log("✅ Payment module initialized successfully!");
})();
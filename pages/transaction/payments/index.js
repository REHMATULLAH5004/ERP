// ============================================
// PAYMENT MODULE - INVOICE BASED (UPDATED)
// ============================================

(async function initPaymentPage() {
    console.log("💳 Payment module initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
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
        let filtered;
        if (searchTerm) {
            filtered = supplierData.filter(s => s.name.toLowerCase().includes(searchTerm));
        } else {
            filtered = supplierData.filter(s => s.hasDue);
        }

        if (filtered.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 40px; color: #94a3b8;">
                <i class="fa-regular fa-circle-check" style="font-size: 2rem; display: block; margin-bottom: 10px; color: #22c55e;"></i>
                ${searchTerm ? 'No suppliers match your search.' : 'All suppliers are paid in full!'}
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
                                onchange="updatePaymentSummary()">
                        </div>
                        <div class="info">
                            <div class="number">Opening Balance (${settlingCurrency})</div>
                            <div class="date">Previous balance</div>
                        </div>
                        <div class="amount">${symbol}${formatNumber(remaining)}</div>
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
                            onchange="updatePaymentSummary()">
                    </div>
                    <div class="info">
                        <div class="number">${item.invoice_number}</div>
                        <div class="date">Date: ${invoiceDate} | ${settlingCurrency} | Remaining: ${symbol}${formatNumber(item.total)}</div>
                    </div>
                    <div class="amount">${symbol}${formatNumber(item.total)}</div>
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
        let totalSelected = 0;
        checkboxes.forEach(cb => {
            totalSelected += parseFloat(cb.dataset.amount) || 0;
        });

        const amountLabel = document.getElementById('paymentAmountLabel');
        const amountInput = document.getElementById('paymentAmount');

        // 🔥 ADDED: how much is actually due in whatever currency the
        // Amount input itself is in -- used below to build the live
        // partial-payment note. Computed here (before either branch
        // overwrites amountInput.value with a default) so it always
        // reflects the true "amount due" regardless of what happens next.
        let dueInInputCurrency;
        let dueSymbol;

        if (payingDirectlyInUsd) {
            // Amount due IS the USD total selected -- nothing to convert.
            document.getElementById('selectedTotal').textContent = `Total Selected: $${formatNumber(totalSelected)}`;

            amountLabel.textContent = 'Amount to Pay (USD):';
            amountInput.max = totalSelected;
            amountInput.placeholder = `Enter USD amount (max ${formatNumber(totalSelected)})`;

            if (!amountInput.value || parseFloat(amountInput.value) === 0) {
                amountInput.value = totalSelected.toFixed(2);
            }

            dueInInputCurrency = totalSelected;
            dueSymbol = '$';
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

            amountLabel.textContent = 'Amount to Pay (ZMW):';
            amountInput.max = totalDueZmw;
            amountInput.placeholder = `Enter ZMW amount (max ${formatNumber(totalDueZmw)})`;

            if (!amountInput.value || parseFloat(amountInput.value) === 0) {
                amountInput.value = totalDueZmw.toFixed(2);
            }

            dueInInputCurrency = totalDueZmw;
            dueSymbol = 'ZK';
        }

        // 🔥 FIX: never shown while paying directly from the USD bank
        // account -- previously this line alone (running after
        // loadInvoicesForSupplier's own, method-aware version) could
        // re-show the rate field even when paying directly in USD.
        const exchangeGroup = document.getElementById('exchangeRateGroup');
        exchangeGroup.style.display = (settlingCurrency === 'USD' && !payingDirectlyInUsd) ? 'block' : 'none';

        // 🔥 ADDED: live partial-payment indicator. Entering less than the
        // full amount due has always been recorded correctly (the save
        // logic below tags it status:'partial' and carries the remaining
        // balance forward) -- this just surfaces that outcome before you
        // click Record Payment, instead of it being a silent side effect
        // of typing a smaller number into the box.
        const noteEl = document.getElementById('paymentBalanceNote');
        if (noteEl) {
            const enteredNow = parseFloat(amountInput.value) || 0;
            const shortfall = dueInInputCurrency - enteredNow;
            if (checkboxes.length === 0 || enteredNow <= 0) {
                noteEl.innerHTML = '';
            } else if (shortfall > 0.01) {
                noteEl.innerHTML = `<span style="color:#b45309;"><i class="fa-solid fa-triangle-exclamation"></i> Partial payment -- ${dueSymbol}${formatNumber(shortfall)} will still be due on the selected invoice(s) after this payment.</span>`;
            } else {
                noteEl.innerHTML = `<span style="color:#15803d;"><i class="fa-solid fa-circle-check"></i> Full payment -- this clears the selected invoice(s) completely.</span>`;
            }
        }
    }

    // ============================================
    // SUPPLIER STATEMENT
    // ============================================

    async function openSupplierStatement(supplierId) {
        try {
            const supplier = state.suppliers.find(s => s.id === supplierId);
            if (!supplier) {
                showToast('Supplier not found', 'error');
                return;
            }

            // Get payables for this supplier
            const supplierPayables = state.supplierPayables.filter(sp => sp.supplier_id === supplierId);
            
            // Build transactions for USD and ZMW separately
            const transactionsUsd = [];
            const transactionsZmw = [];

            // Running totals are declared BEFORE the opening balance
            // blocks below, so those blocks can actually use them.
            let runningUsd = supplier.opening_balance_usd || 0;
            let runningZmw = supplier.opening_balance_zmw || 0;

            // Opening balance - USD
            if (supplier.opening_balance_usd > 0) {
                transactionsUsd.push({
                    date: 'Opening Balance',
                    type: 'Opening Balance',
                    reference: 'Opening',
                    amount: supplier.opening_balance_usd || 0,
                    balance: runningUsd,
                    isOpening: true,
                    invoiceNumber: '-'
                });

                // Payments made against the opening balance get their own
                // "Payment" line (same treatment as regular payable
                // payments below) and actually reduce runningUsd -- using
                // the same shared helper calculateSupplierBalances() uses,
                // so these two can never disagree again.
                getOpeningBalancePayments(supplierId, 'USD').forEach(pi => {
                    runningUsd -= (pi.amount_paid || 0);
                    transactionsUsd.push({
                        date: new Date(pi.payment_date || pi.created_at).toLocaleDateString(),
                        type: 'Payment',
                        reference: pi.payment_reference || 'PAY',
                        amount: -(pi.amount_paid || 0),
                        balance: runningUsd,
                        isOpening: false,
                        isPayment: true,
                        method: pi.payment_method,
                        invoiceNumber: 'Opening Balance',
                        paymentId: pi.payment_id
                    });
                });
            }

            // Opening balance - ZMW
            if (supplier.opening_balance_zmw > 0) {
                transactionsZmw.push({
                    date: 'Opening Balance',
                    type: 'Opening Balance',
                    reference: 'Opening',
                    amount: supplier.opening_balance_zmw || 0,
                    balance: runningZmw,
                    isOpening: true,
                    invoiceNumber: '-'
                });

                getOpeningBalancePayments(supplierId, 'ZMW').forEach(pi => {
                    runningZmw -= (pi.amount_paid || 0);
                    transactionsZmw.push({
                        date: new Date(pi.payment_date || pi.created_at).toLocaleDateString(),
                        type: 'Payment',
                        reference: pi.payment_reference || 'PAY',
                        amount: -(pi.amount_paid || 0),
                        balance: runningZmw,
                        isOpening: false,
                        isPayment: true,
                        method: pi.payment_method,
                        invoiceNumber: 'Opening Balance',
                        paymentId: pi.payment_id
                    });
                });
            }

            // Process each payable (GRN invoice) -- runningUsd/runningZmw
            // already declared above (before the opening balance blocks),
            // carrying forward any opening-balance payment reductions.

            // Sort payables by date
            const sortedPayables = [...supplierPayables].sort((a, b) => 
                new Date(a.created_at) - new Date(b.created_at)
            );

            sortedPayables.forEach(sp => {
                const currency = sp.currency || 'USD';
                const amount = sp.total_amount || 0;
                const invoiceNumber = sp.invoice_number || 'INV-' + sp.id.slice(0, 8);
                const invoiceDate = sp.invoice_date || sp.created_at;

                // 🔥 FIX: reference was showing the raw Supabase UUID
                // (sp.po_id / sp.grn_id) -- now shows the actual human
                // -readable GRN/PO number, looked up from the already
                // -loaded state.grns / state.purchaseOrders.
                const relatedGrn = state.grns.find(g => g.id === sp.grn_id);
                const relatedPo = state.purchaseOrders.find(p => p.id === sp.po_id);
                const referenceDisplay = relatedGrn?.grn_number || relatedPo?.po_number || 'PO';
                
                // Get payments against this payable
                const paidAmount = state.paymentInvoices
                    .filter(pi => pi.supplier_id === supplierId && pi.payable_id === sp.id)
                    .reduce((sum, pi) => sum + (pi.amount_paid || 0), 0);
                
                const remaining = amount - paidAmount;

                if (currency === 'USD') {
                    runningUsd += amount;
                    transactionsUsd.push({
                        date: new Date(invoiceDate).toLocaleDateString(),
                        type: 'Purchase',
                        reference: referenceDisplay,
                        amount: amount,
                        balance: runningUsd,
                        isOpening: false,
                        isPayment: false,
                        invoiceNumber: invoiceNumber,
                        invoiceDate: new Date(invoiceDate).toLocaleDateString(),
                        paid: paidAmount,
                        remaining: remaining,
                        payableId: sp.id
                    });
                    
                    // If payments were made against this payable, add them
                    const paymentsAgainst = state.paymentInvoices
                        .filter(pi => pi.supplier_id === supplierId && pi.payable_id === sp.id);
                    
                    paymentsAgainst.forEach(pi => {
                        runningUsd -= pi.amount_paid;
                        transactionsUsd.push({
                            date: new Date(pi.payment_date || pi.created_at).toLocaleDateString(),
                            type: 'Payment',
                            reference: pi.payment_reference || 'PAY',
                            amount: -(pi.amount_paid || 0),
                            balance: runningUsd,
                            isOpening: false,
                            isPayment: true,
                            method: pi.payment_method,
                            invoiceNumber: invoiceNumber,
                            paymentId: pi.payment_id
                        });
                    });
                    
                } else if (currency === 'ZMW') {
                    runningZmw += amount;
                    transactionsZmw.push({
                        date: new Date(invoiceDate).toLocaleDateString(),
                        type: 'Purchase',
                        reference: referenceDisplay,
                        amount: amount,
                        balance: runningZmw,
                        isOpening: false,
                        isPayment: false,
                        invoiceNumber: invoiceNumber,
                        invoiceDate: new Date(invoiceDate).toLocaleDateString(),
                        paid: paidAmount,
                        remaining: remaining,
                        payableId: sp.id
                    });
                    
                    const paymentsAgainst = state.paymentInvoices
                        .filter(pi => pi.supplier_id === supplierId && pi.payable_id === sp.id);
                    
                    paymentsAgainst.forEach(pi => {
                        runningZmw -= pi.amount_paid;
                        transactionsZmw.push({
                            date: new Date(pi.payment_date || pi.created_at).toLocaleDateString(),
                            type: 'Payment',
                            reference: pi.payment_reference || 'PAY',
                            amount: -(pi.amount_paid || 0),
                            balance: runningZmw,
                            isOpening: false,
                            isPayment: true,
                            method: pi.payment_method,
                            invoiceNumber: invoiceNumber,
                            paymentId: pi.payment_id
                        });
                    });
                }
            });

            // Sort transactions by date
            const sortByDate = (a, b) => {
                if (a.isOpening) return -1;
                if (b.isOpening) return 1;
                return new Date(a.date) - new Date(b.date);
            };
            
            transactionsUsd.sort(sortByDate);
            transactionsZmw.sort(sortByDate);

            state.currentStatementData = {
                supplier,
                transactionsUsd,
                transactionsZmw,
                closingUsd: runningUsd,
                closingZmw: runningZmw
            };

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

        let html = `
            <table class="statement-table">
                <thead>
                    <tr>
                        <th>Date</th>
                        <th>Invoice #</th>
                        <th>Type</th>
                        <th>Reference</th>
                        <th style="text-align: right;">Amount (${currency})</th>
                        <th style="text-align: right;">Balance (${currency})</th>
                    </tr>
                </thead>
                <tbody>
        `;

        transactions.forEach((t) => {
            const isOpening = t.isOpening;
            const isPayment = t.isPayment;
            const rowClass = isOpening ? 'total-row' : '';
            const amountClass = isPayment ? 'credit' : (t.amount > 0 ? 'debit' : '');
            const amountDisplay = isPayment ? `(${symbol}${formatNumber(Math.abs(t.amount))})` : `${symbol}${formatNumber(t.amount)}`;
            
            const invoiceDisplay = t.invoiceNumber || '-';
            
            // Show paid/remaining info for purchases
            let extraInfo = '';
            if (!isOpening && !isPayment && t.paid !== undefined && t.remaining !== undefined) {
                extraInfo = ` <span style="font-size: 0.7rem; color: #64748b;">(Paid: ${symbol}${formatNumber(t.paid)}, Remaining: ${symbol}${formatNumber(t.remaining)})</span>`;
            }
            
            html += `
                <tr class="${rowClass}">
                    <td>${t.date}</td>
                    <td><strong>${invoiceDisplay}</strong></td>
                    <td>${t.type}${t.method ? ' (' + t.method + ')' : ''}</td>
                    <td>${t.reference}</td>
                    <td class="text-right ${amountClass}">${amountDisplay}</td>
                    <td class="text-right">${symbol}${formatNumber(t.balance)}${extraInfo}</td>
                </tr>
            `;
        });

        html += `
                </tbody>
                <tfoot>
                    <tr class="total-row">
                        <td colspan="5" style="text-align: right;">Closing Balance (${currency}):</td>
                        <td style="text-align: right; color: ${closingBalance > 0 ? '#dc2626' : '#15803d'};">${symbol}${formatNumber(closingBalance)}</td>
                    </tr>
                </tfoot>
            </table>
        `;

        return html;
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
                <thead>
                    <tr>
                        <th>Date</th>
                        <th>Invoice #</th>
                        <th>Type</th>
                        <th>Reference</th>
                        <th style="text-align: right;">Amount (${currency})</th>
                        <th style="text-align: right;">Balance (${currency})</th>
                    </tr>
                </thead>
                <tbody>
                    ${transactions.map(t => {
                        const isOpening = t.isOpening;
                        const isPayment = t.isPayment;
                        const rowClass = isOpening ? 'total-row' : '';
                        const amountClass = isPayment ? 'credit' : (t.amount > 0 ? 'debit' : '');
                        const amountDisplay = isPayment ? `(${symbol}${formatNumber(Math.abs(t.amount))})` : `${symbol}${formatNumber(t.amount)}`;
                        const invoiceDisplay = t.invoiceNumber || '-';
                        
                        let extraInfo = '';
                        if (!isOpening && !isPayment && t.paid !== undefined && t.remaining !== undefined) {
                            extraInfo = ` <span style="font-size: 0.7rem; color: #64748b;">(Paid: ${symbol}${formatNumber(t.paid)}, Remaining: ${symbol}${formatNumber(t.remaining)})</span>`;
                        }
                        
                        return `
                            <tr class="${rowClass}">
                                <td>${t.date}</td>
                                <td><strong>${invoiceDisplay}</strong></td>
                                <td>${t.type}${t.method ? ' (' + t.method + ')' : ''}</td>
                                <td>${t.reference}</td>
                                <td class="text-right ${amountClass}">${amountDisplay}</td>
                                <td class="text-right">${symbol}${formatNumber(t.balance)}${extraInfo}</td>
                            </tr>
                        `;
                    }).join('')}
                </tbody>
                <tfoot>
                    <tr class="total-row">
                        <td colspan="5" style="text-align: right;">Closing Balance (${currency}):</td>
                        <td style="text-align: right; color: ${closingBalance > 0 ? '#dc2626' : '#15803d'};">${symbol}${formatNumber(closingBalance)}</td>
                    </tr>
                </tfoot>
            </table>
        `;
        
        const printWindow = window.open('', '_blank', 'width=800,height=600');
        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Supplier Statement - ${data.supplier.name} (${currency})</title>
                <style>
                    body { font-family: Arial, sans-serif; padding: 20px; max-width: 1000px; margin: 0 auto; }
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

    async function savePayment() {
        const supplierId = document.getElementById('paymentSupplier').value;
        const paymentDate = document.getElementById('paymentDate').value;
        // "Settling" -- which currency's invoices this payment applies to.
        const settlingCurrency = document.getElementById('paymentCurrency').value;
        const method = document.getElementById('paymentMethod').value;
        // 🔥 ADDED: paying directly out of the USD bank account -- the cash
        // movement is USD, not ZMW, and no exchange rate applies at all.
        const payingDirectlyInUsd = method === 'Bank Transfer USD';
        const amountEntered = parseFloat(document.getElementById('paymentAmount').value);
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
        if (!amountEntered || amountEntered <= 0) {
            showToast(`Please enter a valid ${payingDirectlyInUsd ? 'USD' : 'ZMW'} amount`, 'error');
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
        const selectedItems = [];
        document.querySelectorAll('.invoice-checkbox:checked').forEach(cb => {
            selectedItems.push({
                id: cb.dataset.id,
                payableId: cb.dataset.payableId || null,
                poId: cb.dataset.poId || null,
                remaining: parseFloat(cb.dataset.amount) || 0,
                isOpening: cb.dataset.isOpening === 'true'
            });
        });

        if (selectedItems.length === 0) {
            showToast(`Please select at least one ${settlingCurrency} invoice or opening balance to pay`, 'error');
            return;
        }

        const totalSelected = selectedItems.reduce((sum, item) => sum + item.remaining, 0);

        // How much of the SELECTED CURRENCY's debt does this payment
        // clear? Paying directly in USD, or settling ZMW invoices, is a
        // direct 1:1. Only "USD invoices paid via ZMW cash" needs
        // converting the ZMW cash paid back into the USD amount it settles.
        const amountInSelectedCurrency = (settlingCurrency === 'USD' && !payingDirectlyInUsd)
            ? amountEntered / exchangeRate
            : amountEntered;

        if (amountInSelectedCurrency > totalSelected + 0.01) {
            const symbol = settlingCurrency === 'USD' ? '$' : 'ZK';
            showToast(`Payment amount exceeds total selected (${symbol}${formatNumber(totalSelected)})`, 'error');
            return;
        }

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

            const { data: payment, error: paymentError } = await supabaseClient
                .from('payments')
                .insert([paymentData])
                .select();

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

            // Distribute across the selected (single-currency) items only.
            let remainingToDistribute = amountInSelectedCurrency;
            for (const item of selectedItems) {
                if (remainingToDistribute <= 0) break;

                const amountToPay = Math.min(item.remaining, remainingToDistribute);
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
                    remainingToDistribute -= amountToPay;

                    // Opening-balance items have no payableId (they're not
                    // a real supplier_payables row) -- only real payables
                    // need writing back.
                    if (item.payableId) {
                        payableUpdates.push({ payableId: item.payableId, amountToPay });
                    }
                }
            }

            if (paymentInvoicesToInsert.length > 0) {
                const { error: piError } = await supabaseClient
                    .from('payment_invoices')
                    .insert(paymentInvoicesToInsert);

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

                    const { error: payableUpdateError } = await supabaseClient
                        .from('supplier_payables')
                        .update({
                            amount_paid: newAmountPaid,
                            amount_remaining: newAmountRemaining,
                            status: newAmountRemaining <= 0.01 ? 'Paid' : 'Partial'
                        })
                        .eq('id', payableId);

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
            const shortfallInSelectedCurrency = totalSelected - amountInSelectedCurrency;
            const paidSummary = `${payingDirectlyInUsd ? '$' : 'ZK'}${formatNumber(amountEntered)} paid`;
            const toastMessage = shortfallInSelectedCurrency > 0.01
                ? `Partial payment recorded! ${paidSummary}. ${invoiceSymbol}${formatNumber(shortfallInSelectedCurrency)} still due on the selected invoice(s).`
                : `Payment recorded successfully! ${paidSummary} -- selected invoice(s) fully cleared.`;
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

        document.getElementById('paymentAmount').addEventListener('input', function() {
            const max = parseFloat(this.max) || 0;
            const value = parseFloat(this.value) || 0;
            if (value > max) {
                this.value = max;
            }
            // 🔥 ADDED: refresh the partial/full payment note as the user
            // types -- safe to call here since updatePaymentSummary() only
            // ever overwrites this field when it's empty/zero, never while
            // it already holds a value the user is actively editing.
            updatePaymentSummary();
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
    window.openRecordPayment = openRecordPayment;
    window.savePayment = savePayment;
    window.openSupplierStatement = openSupplierStatement;
    window.switchStatementTab = switchStatementTab;
    window.printStatement = printStatement;
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
    
    const supplierData = calculateSupplierBalances();
    renderPaymentList(supplierData);
    setupEventListeners();
    
    console.log("✅ Payment module initialized successfully!");
})();
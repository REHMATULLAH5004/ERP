// ============================================
// WHOLESALE POS LOGIC (WITH ACCOUNTING & OPENING RECEIVABLE)
// ============================================

(async function initWholesalePos() {
    console.log("Wholesale POS initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    // 🔥 CHANGED: see the same note in transaction/retail/index.js -- the
    // shared window-level getCompanySettings() helper no longer exists on
    // the site, so calling it here threw "getCompanySettings is not
    // defined" and aborted this entire module's init before anything below
    // it ever ran. Self-contained now: reads the same single
    // `company_settings` row directly, with a hardcoded fallback.
    // 🔥 CHANGED: now also reads the Wholesale-specific Invoice Settings
    // just added in Admin -- a separate company name, a PER-CUSTOMER-TYPE
    // invoice prefix (Regular vs Internal), and Wholesale's own ZAMRA/TPIN
    // numbers, plus the pharmacy's real bank details -- instead of always
    // falling back to the generic/retail company_settings fields (or, for
    // the bank details, literal placeholder text that was never filled
    // in). Every new field below falls back sensibly to the existing
    // generic field (or the old single wholesale_prefix) if Admin hasn't
    // set it yet, so this is safe even before Admin fills everything in.
    const companySettings = await (async function loadCompanySettingsInline() {
        const fallback = {
            company_name: 'GRIFFINS MEDICALS LIMITED',
            address: 'Plot 3534, Freedomway, Lusaka',
            phone: '+260 97 000 0000',
            zamra_number: 'ZAMRA-123456',
            wholesale_prefix: 'GWH',
            wholesale_company_name: '',
            wholesale_prefix_regular: '',
            wholesale_prefix_internal: '',
            wholesale_zamra_number: '',
            wholesale_tpin_number: '',
            bank_name: '',
            bank_account_name: '',
            bank_account_number: '',
            bank_branch: '',
            bank_swift: '',
            // 🔥 ADDED: dynamic pricing -- flat global markup rates,
            // replacing the old per-product wholesale_internal_percent /
            // wholesale_regular_percent columns that had to be typed in by
            // hand for every single product. Unlike Retail these are NOT
            // an exponential curve -- Wholesale is a flat % for every
            // product regardless of cost, per spec (Internal 5%, Regular
            // 10%).
            wholesale_internal_markup_percent: 5,
            wholesale_regular_markup_percent: 10
        };
        try {
            const { data, error } = await supabaseClient
                .from('company_settings')
                .select(`company_name, address, phone, zamra_number, wholesale_prefix,
                    wholesale_company_name, wholesale_prefix_regular, wholesale_prefix_internal,
                    wholesale_zamra_number, wholesale_tpin_number,
                    bank_name, bank_account_name, bank_account_number, bank_branch, bank_swift,
                    wholesale_internal_markup_percent, wholesale_regular_markup_percent`)
                .eq('id', 1)
                .maybeSingle();
            if (error || !data) return fallback;
            return {
                company_name: data.company_name || fallback.company_name,
                address: data.address || fallback.address,
                phone: data.phone || fallback.phone,
                zamra_number: data.zamra_number || fallback.zamra_number,
                wholesale_prefix: data.wholesale_prefix || fallback.wholesale_prefix,
                // Wholesale-specific overrides -- each falls back to the
                // generic/legacy equivalent, never to a blank field on the
                // printed invoice.
                wholesale_company_name: data.wholesale_company_name || data.company_name || fallback.company_name,
                wholesale_prefix_regular: data.wholesale_prefix_regular || data.wholesale_prefix || fallback.wholesale_prefix,
                wholesale_prefix_internal: data.wholesale_prefix_internal || data.wholesale_prefix || fallback.wholesale_prefix,
                wholesale_zamra_number: data.wholesale_zamra_number || data.zamra_number || fallback.zamra_number,
                wholesale_tpin_number: data.wholesale_tpin_number || '',
                bank_name: data.bank_name || '',
                bank_account_name: data.bank_account_name || data.wholesale_company_name || data.company_name || fallback.company_name,
                bank_account_number: data.bank_account_number || '',
                bank_branch: data.bank_branch || '',
                bank_swift: data.bank_swift || '',
                wholesale_internal_markup_percent: data.wholesale_internal_markup_percent ?? fallback.wholesale_internal_markup_percent,
                wholesale_regular_markup_percent: data.wholesale_regular_markup_percent ?? fallback.wholesale_regular_markup_percent
            };
        } catch (e) {
            console.warn('Could not load company_settings, using defaults:', e);
            return fallback;
        }
    })();

    // 🔥 ADDED: picks the right invoice-number prefix for the customer
    // type currently on the form -- Admin now configures Regular and
    // Internal wholesale customers with DIFFERENT prefixes
    // (wholesale_prefix_regular / wholesale_prefix_internal), where
    // before every wholesale sale used the same single prefix regardless
    // of customer type.
    function getWholesalePrefix(subType) {
        return subType === 'INTERNAL'
            ? (companySettings.wholesale_prefix_internal || companySettings.wholesale_prefix)
            : (companySettings.wholesale_prefix_regular || companySettings.wholesale_prefix);
    }

    // ============================================
    // DOM REFERENCES
    // ============================================
    const posTableBody = document.getElementById('wholesalePosTableBody');
    const customerSelect = document.getElementById('wholesaleCustomerSelect');
    const paymentType = document.getElementById('wholesalePaymentType');
    const paymentNoteBox = document.getElementById('wholesalePaymentNoteBox');
    const saveBtn = document.getElementById('saveTransactionBtn');
    const quoteBtn = document.getElementById('makeQuotationBtn');
    const clearBtn = document.getElementById('clearSaleBtn');
    const invoiceNumber = document.getElementById('invoiceNumber');
    const invoiceDateTime = document.getElementById('invoiceDateTime');
    const toggleSidebarBtn = document.getElementById('toggleSidebarBtn');

    // Customer details fields
    const customerType = document.getElementById('wholesaleCustomerType');
    const contactPerson = document.getElementById('wholesaleContactPerson');
    const phone = document.getElementById('wholesalePhone');
    const address = document.getElementById('wholesaleAddress');
    const zamra = document.getElementById('wholesaleZamra');
    const tpin = document.getElementById('wholesaleTpin');

    // Modal elements
    const addCustomerBtn = document.getElementById('addCustomerBtn');
    const customerModal = document.getElementById('addCustomerModal');
    const closeCustomerModalBtn = document.getElementById('closeCustomerModalBtn');
    const cancelCustomerBtn = document.getElementById('cancelCustomerBtn');
    const customerForm = document.getElementById('addCustomerForm');
    const saveCustomerBtn = document.getElementById('saveCustomerBtn');

    // Print modal refs
    const printModal = document.getElementById('printModal');
    let currentSaleData = null;

    // 🔥 ADDED: item search-by-name-or-generic-name (see the matching HTML
    // change). productCatalogCache holds the full product list (id, name,
    // generic) so every row's search box can filter instantly without a
    // DB round-trip per keystroke; it's (re)populated wherever the product
    // dropdown itself is loaded. itemSearchDropdownEl is the one shared
    // results list (fixed-positioned) reused by whichever row's search box
    // currently has focus; activeItemSearchRow/Input/Select track which
    // row that dropdown is currently acting on.
    let productCatalogCache = [];
    const itemSearchDropdownEl = document.getElementById('wholesaleItemSearchDropdown');
    let activeItemSearchRow = null;
    let activeItemSearchInput = null;
    let activeItemSearchSelect = null;

    // 🔥 FIX: this used to not exist at all -- loadWholesaleForEdit()
    // populated the form from an existing sale, but saveTransaction() had
    // no way to know it was looking at an edit rather than a new sale, so
    // it ALWAYS inserted. Re-saving an "edited" wholesale invoice silently
    // created a second, separate sale row for the same real-world
    // transaction (duplicate invoice, stock deducted twice, revenue/COGS
    // posted twice) while the original row sat there untouched. Same fix
    // as retail.js's `editingSaleDbId` -- set by loadWholesaleForEdit(),
    // cleared by generateNextSaleId() (Reset / post-save / a fresh
    // quotation-to-invoice conversion), read by saveTransaction() to
    // decide update vs insert.
    let editingWholesaleDbId = null;

    // 🔥 ADDED: tracks the ORIGINAL quotation's id while
    // convertQuotationToInvoice() has its data loaded into the form ready
    // to be saved as a real invoice. Previously that conversion only ever
    // loaded the quotation and gave it a fresh invoice number -- it never
    // touched the original quotation row, so after Save the customer had
    // a brand-new invoice AND the old quotation was still sitting there
    // untouched, looking like a second, still-open document for the same
    // sale. Set by convertQuotationToInvoice(), cleared by
    // generateNextSaleId() (Reset / a fresh conversion) and consumed by
    // saveTransaction() once the new invoice has actually saved
    // successfully, to remove the original quotation.
    let convertingFromQuotationId = null;

    // 🔥 ADDED: current user's role -- needed to gate the Delete button
    // in search results to Admin only. Fetched once and cached; runs in
    // the background so it doesn't block anything else from loading.
    let currentUserRole = null;
    (async function fetchCurrentUserRole() {
        try {
            const { data: { session } } = await supabaseClient.auth.getSession();
            if (!session) return;
            const { data: profile } = await supabaseClient
                .from('user_profiles')
                .select('role')
                .eq('id', session.user.id)
                .maybeSingle();
            currentUserRole = profile?.role || null;
        } catch (e) {
            console.warn("Could not fetch current user role:", e);
        }
    })();

    // ============================================
    // 🔥 CHART OF ACCOUNTS - AUTO CREATE MISSING ACCOUNTS
    // ============================================
    // Ported from retail.js. Previously wholesale.js hardcoded account codes
    // directly into journal_lines inserts ('4101', '4102', '5002', etc.)
    // with no guarantee those rows actually existed in chart_of_accounts —
    // if they didn't, any journal_lines insert referencing them could fail
    // (or silently post against a nonexistent account, depending on whether
    // there's an FK constraint). This auto-creates every account wholesale
    // needs, the same way retail.js already does.
    const REQUIRED_ACCOUNTS = [
        { code: '1111', name: 'Cash in Hand (ZMW)', type: 'Asset', category: 'Current Asset', normal_balance: 'Debit' },
        { code: '1121', name: 'Bank - ZMW', type: 'Asset', category: 'Current Asset', normal_balance: 'Debit' },
        { code: '1200', name: 'Accounts Receivable', type: 'Asset', category: 'Current Asset', normal_balance: 'Debit' },
        { code: '1400', name: 'Inventory', type: 'Asset', category: 'Current Asset', normal_balance: 'Debit' },
        { code: '2100', name: 'Sales Tax Payable', type: 'Liability', category: 'Current Liability', normal_balance: 'Credit' },
        { code: '3000', name: 'Opening Balance Equity', type: 'Equity', category: 'Equity', normal_balance: 'Credit' },
        { code: '4101', name: 'Wholesale - Regular Sales', type: 'Revenue', category: 'Revenue', normal_balance: 'Credit' },
        { code: '4102', name: 'Wholesale - Internal Sales', type: 'Revenue', category: 'Revenue', normal_balance: 'Credit' },
        { code: '5002', name: 'COGS - Wholesale', type: 'Expense', category: 'Cost of Goods Sold', normal_balance: 'Debit' }
    ];

    // 🔥 PERF FIX: this used to run on every single save -- and twice per
    // save at that, since createWholesaleAccountingEntries() called it
    // directly AND getAccountCodesFromChartOfAccounts() called it again
    // right afterwards. Each run checked every required account ONE AT A
    // TIME (a separate SELECT, and INSERT if missing, per account) -- up
    // to REQUIRED_ACCOUNTS.length * 2 sequential round-trips just for this
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
                accounts_receivable: accountMap['accounts_receivable'] || '1200',
                inventory: accountMap['inventory'] || '1400',
                sales_tax_payable: accountMap['sales_tax_payable'] || '2100',
                opening_balance_equity: accountMap['opening_balance_equity'] || '3000',
                wholesale_regular_sales: accountMap['wholesale_regular_sales'] || '4101',
                wholesale_internal_sales: accountMap['wholesale_internal_sales'] || '4102',
                cogs_wholesale: accountMap['cogs_wholesale'] || '5002'
            };
        } catch (error) {
            console.error('Error fetching account codes:', error);
            return {
                cash_zmw: '1111',
                bank_zmw: '1121',
                accounts_receivable: '1200',
                inventory: '1400',
                sales_tax_payable: '2100',
                opening_balance_equity: '3000',
                wholesale_regular_sales: '4101',
                wholesale_internal_sales: '4102',
                cogs_wholesale: '5002'
            };
        }
    }

    // ============================================
    // TOGGLE SIDEBAR
    // ============================================
    if (toggleSidebarBtn) {
        // 🔥 FIX: previously looked up a `#appRoot` element that doesn't
        // exist anywhere in the page, so this button silently did
        // nothing. Toggles a class on <body> instead (see style.css),
        // which hides the sidebar and lets the workspace expand.
        toggleSidebarBtn.addEventListener('click', function() {
            document.body.classList.toggle('layout-fullscreen');
        });
    }

    // ============================================
    // INITIALIZE INVOICE
    // ============================================
    generateNextSaleId();
    updateDateTime();
    setInterval(updateDateTime, 60000);

    // ============================================
    // LOAD CUSTOMERS
    // ============================================
    await loadCustomers();

    // ============================================
    // LOAD PRODUCT DROPDOWNS
    // ============================================
    try {
        await loadProductDropdowns();
    } catch (e) {
        console.warn("Could not load products:", e);
    }

    // ============================================
    // CUSTOMER SELECTION
    // ============================================
    if (customerSelect) {
        customerSelect.addEventListener('change', async function() {
            const customerId = this.value;
            if (!customerId) {
                clearCustomerFields();
                return;
            }

            resetPOSTable();

            try {
                const { data: customer, error } = await supabaseClient
                    .from('wholesale_customers')
                    .select('*')
                    .eq('id', customerId)
                    .single();

                if (error) throw error;

                if (customer) {
                    customerType.value = customer.customer_type || 'REGULAR';
                    contactPerson.value = customer.contact_person || '';
                    phone.value = customer.phone || '';
                    address.value = customer.address || '';
                    zamra.value = customer.zamra_number || '';
                    tpin.value = customer.tpin_number || '';

                    updateRowRates();

                    // 🔥 ADDED: the invoice number's prefix depends on
                    // this customer's type (Regular vs Internal -- see
                    // getWholesalePrefix()), so re-generate it now that
                    // the type is known. Only for a brand-new sale --
                    // loadWholesaleForEdit() also selects a customer
                    // (to populate its fields) but sets
                    // editingWholesaleDbId right after, before this runs,
                    // so an in-progress edit's original invoice number is
                    // left untouched here.
                    if (!editingWholesaleDbId) {
                        generateNextSaleId();
                    }
                }
            } catch (err) {
                console.error("Error fetching customer details:", err);
            }
        });
    }

    // ============================================
    // PAYMENT TYPE LOGIC
    // ============================================
    if (paymentType && paymentNoteBox) {
        paymentType.addEventListener('change', function() {
            const val = this.value;
            if (val === 'Airtel Money' || val === 'Bank Transfer') {
                paymentNoteBox.style.display = 'block';
            } else {
                paymentNoteBox.style.display = 'none';
                const noteInput = document.getElementById('wholesalePaymentNote');
                if (noteInput) noteInput.value = '';
            }
        });
    }

    // ============================================
    // ADD CUSTOMER MODAL (WITH OPENING RECEIVABLE)
    // ============================================
    if (addCustomerBtn) {
        addCustomerBtn.addEventListener('click', function() {
            customerModal.style.display = 'flex';
            document.getElementById('newCustomerName').value = '';
            document.getElementById('newContactPerson').value = '';
            document.getElementById('newPhone').value = '';
            document.getElementById('newAddress').value = '';
            document.getElementById('newZamra').value = '';
            document.getElementById('newTpin').value = '';
            document.getElementById('newOpeningBalance').value = '';
            document.querySelector('input[name="customerType"][value="INTERNAL"]').checked = true;
        });
    }

    if (closeCustomerModalBtn) {
        closeCustomerModalBtn.addEventListener('click', function() {
            customerModal.style.display = 'none';
        });
    }

    if (cancelCustomerBtn) {
        cancelCustomerBtn.addEventListener('click', function() {
            customerModal.style.display = 'none';
        });
    }

    customerModal.addEventListener('click', function(e) {
        if (e.target === this) {
            this.style.display = 'none';
        }
    });

    // ============================================
    // SAVE CUSTOMER (WITH OPENING RECEIVABLE)
    // ============================================
    if (customerForm) {
        customerForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const customerName = document.getElementById('newCustomerName').value.trim();
            const contactPersonVal = document.getElementById('newContactPerson').value.trim();
            const phoneVal = document.getElementById('newPhone').value.trim();
            const addressVal = document.getElementById('newAddress').value.trim();
            const customerTypeVal = document.querySelector('input[name="customerType"]:checked').value;
            const zamraVal = document.getElementById('newZamra').value.trim();
            const tpinVal = document.getElementById('newTpin').value.trim();
            const openingBalance = parseFloat(document.getElementById('newOpeningBalance').value) || 0;

            if (!customerName) {
                alert('Customer Name is required');
                return;
            }
            if (!phoneVal) {
                alert('Phone Number is required');
                return;
            }

            saveCustomerBtn.disabled = true;
            saveCustomerBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';

            try {
                const { data, error } = await supabaseClient
                    .from('wholesale_customers')
                    .insert([{
                        customer_name: customerName,
                        contact_person: contactPersonVal,
                        phone: phoneVal,
                        address: addressVal,
                        customer_type: customerTypeVal,
                        zamra_number: zamraVal,
                        tpin_number: tpinVal,
                        opening_balance_zmw: openingBalance // ✅ Save opening balance
                    }])
                    .select();

                if (error) throw error;

                // ✅ If opening balance > 0, create GL entry for opening receivable
                if (openingBalance > 0 && data && data.length > 0) {
                    await createOpeningReceivableGLEntry(data[0].id, customerName, openingBalance);
                }

                customerModal.style.display = 'none';
                await loadCustomers();

                if (data && data.length > 0) {
                    customerSelect.value = data[0].id;
                    customerSelect.dispatchEvent(new Event('change'));
                }

                alert('✅ Customer added successfully!' + (openingBalance > 0 ? ` With opening balance of ZK${openingBalance.toFixed(2)}` : ''));

            } catch (error) {
                console.error('Error saving customer:', error);
                alert('❌ Error saving customer: ' + error.message);
            } finally {
                saveCustomerBtn.disabled = false;
                saveCustomerBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Customer';
            }
        });
    }

    // ============================================
    // OPENING RECEIVABLE GL ENTRY
    // ============================================
    async function createOpeningReceivableGLEntry(customerId, customerName, amount) {
        try {
            await ensureChartOfAccounts();
            const accountCodes = await getAccountCodesFromChartOfAccounts();
            const entryDate = new Date().toISOString().split('T')[0];
            
            const journal = {
                entry_date: entryDate,
                reference: `OPEN-WHOLESALE-${customerId.slice(0, 8)}`,
                description: `Opening receivable for wholesale customer: ${customerName}`,
                journal_number: `OPN-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
                status: 'Posted',
                created_at: new Date().toISOString()
            };

            const { data: journalData, error: jError } = await supabaseClient
                .from('journal_entries')
                .insert([journal])
                .select();

            if (jError) throw jError;

            const lines = [
                {
                    journal_entry_id: journalData[0].id,
                    account_code: accountCodes.accounts_receivable,
                    description: `Opening receivable - ${customerName}`,
                    debit: amount,
                    credit: 0
                },
                {
                    journal_entry_id: journalData[0].id,
                    account_code: accountCodes.opening_balance_equity,
                    description: `Opening equity for receivable - ${customerName}`,
                    debit: 0,
                    credit: amount
                }
            ];

            const { error: lineError } = await supabaseClient
                .from('journal_lines')
                .insert(lines);

            if (lineError) throw lineError;

            console.log(`✅ Opening receivable GL entry created for ${customerName}: ZK${amount}`);

        } catch (error) {
            console.error('Error creating opening receivable GL entry:', error);
        }
    }

    // ============================================
    // POS TABLE LOGIC
    // ============================================
    if (!posTableBody) {
        console.error("❌ wholesalePosTableBody not found!");
        return;
    }

    posTableBody.addEventListener('input', function(e) {
        if (e.target.classList.contains('wholesale-pos-qty')) {
            const row = e.target.closest('tr');
            const rows = posTableBody.querySelectorAll('tr');
            const qty = parseInt(e.target.value) || 0;

            if (row === rows[rows.length - 1] && qty > 0) {
                addPOSRow();
            }
            updateRowTotal(row);
            updateTotals();
        }

        // 🔥 FIX: the rate field used to be readonly, so no edit could ever
        // happen here -- see the matching HTML change. Now that it's
        // editable, a manual edit needs to recalculate this row's total
        // and the grand totals the same way a qty edit already does above.
        // updateRowRate() (the function that OVERWRITES this field with
        // the auto-calculated batch cost + markup%) only runs when the
        // item or batch selection itself changes, so typing a custom price
        // here doesn't get silently reverted. Same pattern as retail.js's
        // .retail-pos-rate handling.
        if (e.target.classList.contains('wholesale-pos-rate')) {
            const row = e.target.closest('tr');
            updateRowTotal(row);
            updateTotals();
        }
    });

    // ============================================
    // PRODUCT AND BATCH SELECTION
    // ============================================
    posTableBody.addEventListener('change', async function(e) {
        if (e.target.classList.contains('wholesale-pos-item')) {
            const row = e.target.closest('tr');
            const productId = e.target.value;
            const batchSelect = row.querySelector('.wholesale-pos-batch');
            const packInput = row.querySelector('.wholesale-pos-pack-size');
            const taxInput = row.querySelector('.wholesale-pos-tax');
            const rateInput = row.querySelector('.wholesale-pos-rate');
            const qtyInput = row.querySelector('.wholesale-pos-qty');

            if (!productId) {
                if (batchSelect) batchSelect.innerHTML = `<option value="">Select Batch</option>`;
                if (packInput) packInput.value = '';
                if (taxInput) taxInput.value = '';
                if (rateInput) rateInput.value = '';
                if (qtyInput) {
                    qtyInput.value = '1';
                    qtyInput.disabled = false;
                    qtyInput.max = '';
                }
                updateTotals();
                return;
            }

            try {
                // 🔥 CHANGED: dropped wholesale_internal_percent / wholesale_regular_percent
                // -- those manual per-product columns are gone. Internal/Regular markup
                // is now the flat global rate from Admin (company_settings), applied in
                // updateRowRate().
                const { data: product, error: prodError } = await supabaseClient
                    .from('products')
                    .select('conversion_rate, tax_percent')
                    .eq('id', productId)
                    .single();

                if (prodError) throw prodError;

                const { data: batches, error: batchError } = await supabaseClient
                    .from('batches')
                    .select(`
                        id,
                        batch_number,
                        expiry_date,
                        total_qty,
                        cost_price
                    `)
                    .eq('product_id', productId)
                    .gt('total_qty', 0)
                    .order('expiry_date', { ascending: true });

                if (batchError) throw batchError;

                if (batchSelect) {
                    batchSelect.innerHTML = `<option value="">Select Batch</option>`;
                    
                    if (batches.length === 0) {
                        batchSelect.innerHTML = `<option value="">⚠️ No stock available</option>`;
                        if (qtyInput) {
                            qtyInput.value = 0;
                            qtyInput.disabled = true;
                        }
                        return;
                    }

                    if (qtyInput) {
                        qtyInput.disabled = false;
                        qtyInput.max = '';
                    }

                    batches.forEach(b => {
                        const expiry = new Date(b.expiry_date).toLocaleDateString();
                        const costPrice = b.cost_price || 0;
                        
                        let stockLabel = `${b.total_qty} units`;
                        if (b.total_qty <= 5) {
                            stockLabel = `⚠️ ${b.total_qty} units (Low Stock)`;
                        }
                        
                        batchSelect.innerHTML += `
                            <option value="${b.id}"
                                data-cost="${costPrice}"
                                data-pack="${product.conversion_rate || 1}"
                                data-tax="${product.tax_percent || 0}"
                                data-expiry="${expiry}"
                                data-qty="${b.total_qty}"
                                data-batch-number="${b.batch_number}">
                                ${b.batch_number} (Exp: ${expiry}) - ${stockLabel}
                            </option>
                        `;
                    });

                    if (batches.length > 0) {
                        setTimeout(() => {
                            batchSelect.value = batches[0].id;
                            if (taxInput) taxInput.value = product.tax_percent || 0;
                            updateRowRate(row);
                            updateRowTotal(row);
                            updateTotals();
                        }, 50);
                    }
                }
            } catch (err) {
                console.error("Error fetching product data:", err);
                showToast('Error loading product data: ' + err.message, 'error');
            }
        }

        if (e.target.classList.contains('wholesale-pos-batch')) {
            const row = e.target.closest('tr');
            const qtyInput = row.querySelector('.wholesale-pos-qty');
            const selectedBatch = e.target.options[e.target.selectedIndex];
            
            if (qtyInput && selectedBatch && selectedBatch.value) {
                const availableQty = parseInt(selectedBatch.dataset.qty) || 0;
                const requestedQty = parseInt(qtyInput.value) || 1;
                
                if (requestedQty > availableQty) {
                    showToast(`Only ${availableQty} units available in this batch`, 'warning');
                    qtyInput.value = availableQty;
                }
                qtyInput.max = availableQty;
            }
            
            updateRowRate(row);
            updateRowTotal(row);
            updateTotals();
        }
    });

    // ============================================
    // 🔥 ADDED: ITEM SEARCH (by item name OR generic name)
    // ============================================
    // The item picker used to be a plain <select> -- browsers only jump to
    // an option by matching the first letters you type against its VISIBLE
    // text (the product name), so there was no way to find a product by its
    // generic name. This adds a type-to-search text box per row, filtering
    // against both product_name and generic name from productCatalogCache,
    // with one shared results dropdown (fixed-positioned, so it's never
    // clipped by the item table's own horizontal-scroll wrapper). Picking a
    // result just sets the row's hidden <select class="wholesale-pos-item">
    // value and dispatches a real 'change' event on it, so every existing
    // handler (batch loading, rate calc, getSaleData(), etc.) keeps working
    // completely unchanged.

    // Sets a row's search box text to match whatever its hidden select
    // currently has selected (or clears it if nothing is selected). Called
    // after loading a saved sale into a row, and after Reset/new-row setup,
    // so the visible text never drifts from the actual selected item.
    function syncItemSearchDisplay(row) {
        if (!row) return;
        const select = row.querySelector('.wholesale-pos-item');
        const searchInput = row.querySelector('.wholesale-pos-item-search');
        if (!select || !searchInput) return;
        const opt = select.options[select.selectedIndex];
        searchInput.value = (opt && opt.value) ? opt.textContent.trim() : '';
    }

    function renderItemSearchResults(query) {
        if (!itemSearchDropdownEl) return;
        const q = (query || '').trim().toLowerCase();
        let matches = productCatalogCache;
        if (q) {
            matches = productCatalogCache.filter(p =>
                (p.product_name || '').toLowerCase().includes(q) ||
                (p.generic || '').toLowerCase().includes(q)
            );
        }
        matches = matches.slice(0, 50);

        if (matches.length === 0) {
            itemSearchDropdownEl.innerHTML = `<div style="padding:10px 12px; color:#94a3b8; font-size:0.8rem;">No matching items</div>`;
        } else {
            itemSearchDropdownEl.innerHTML = matches.map(p => `
                <div class="wholesale-item-search-option" data-id="${p.id}" style="padding:6px 12px; cursor:pointer; font-size:0.8rem; border-bottom:1px solid #f1f5f9;">
                    <div style="color:#0f172a;">${p.product_name}</div>
                    ${p.generic ? `<div style="color:#94a3b8; font-size:0.7rem; margin-top:1px;">${p.generic}</div>` : ''}
                </div>
            `).join('');
        }
    }

    function showItemDropdownFor(row, searchInput, select, query) {
        if (!itemSearchDropdownEl) return;
        activeItemSearchRow = row;
        activeItemSearchInput = searchInput;
        activeItemSearchSelect = select;
        renderItemSearchResults(query);

        const rect = searchInput.getBoundingClientRect();
        itemSearchDropdownEl.style.left = `${rect.left}px`;
        itemSearchDropdownEl.style.top = `${rect.bottom + 2}px`;
        itemSearchDropdownEl.style.width = `${Math.max(rect.width, 240)}px`;
        itemSearchDropdownEl.style.display = 'block';
    }

    function hideItemDropdown() {
        if (!itemSearchDropdownEl) return;
        itemSearchDropdownEl.style.display = 'none';
        activeItemSearchRow = null;
        activeItemSearchInput = null;
        activeItemSearchSelect = null;
    }

    posTableBody.addEventListener('input', function(e) {
        if (e.target.classList.contains('wholesale-pos-item-search')) {
            const row = e.target.closest('tr');
            const select = row.querySelector('.wholesale-pos-item');
            // Typing invalidates whatever was previously selected until a
            // result is actually clicked -- mirrors a plain <select> being
            // reset to "Select Item" while you're still choosing.
            if (select.value) {
                select.value = '';
                select.dispatchEvent(new Event('change', { bubbles: true }));
            }
            showItemDropdownFor(row, e.target, select, e.target.value);
        }
    });

    // 'focus' doesn't bubble, so this listener has to run in the capture
    // phase to see it via delegation on posTableBody.
    posTableBody.addEventListener('focus', function(e) {
        if (e.target.classList.contains('wholesale-pos-item-search')) {
            const row = e.target.closest('tr');
            const select = row.querySelector('.wholesale-pos-item');
            showItemDropdownFor(row, e.target, select, e.target.value);
        }
    }, true);

    // Picking a result: 'mousedown' (not 'click') so this fires BEFORE the
    // search box's own 'blur' handler below, which would otherwise hide the
    // dropdown first and cause the click to land on nothing.
    posTableBody.addEventListener('mousedown', function(e) {
        const option = e.target.closest('.wholesale-item-search-option');
        if (!option || !activeItemSearchRow) return;
        e.preventDefault();

        const select = activeItemSearchSelect;
        const searchInput = activeItemSearchInput;
        select.value = option.dataset.id;
        syncItemSearchDisplay(activeItemSearchRow);
        hideItemDropdown();
        select.dispatchEvent(new Event('change', { bubbles: true }));
        searchInput.blur();
    });

    // 'blur' doesn't bubble either -- capture phase again. Delayed slightly
    // so the mousedown handler above (which runs first) has already set the
    // select's value before this resyncs the visible text.
    posTableBody.addEventListener('blur', function(e) {
        if (e.target.classList.contains('wholesale-pos-item-search')) {
            const row = e.target.closest('tr');
            setTimeout(() => {
                hideItemDropdown();
                syncItemSearchDisplay(row);
            }, 150);
        }
    }, true);

    // Click anywhere outside the dropdown/search boxes closes it (covers
    // clicking a different row, another field, etc.).
    document.addEventListener('click', function(e) {
        if (!itemSearchDropdownEl || itemSearchDropdownEl.style.display === 'none') return;
        if (e.target.classList.contains('wholesale-pos-item-search')) return;
        if (itemSearchDropdownEl.contains(e.target)) return;
        hideItemDropdown();
    });

    // Remove row handler
    posTableBody.addEventListener('click', function(e) {
        if (e.target.closest('.wholesale-remove-btn')) {
            const rows = posTableBody.querySelectorAll('tr');
            if (rows.length > 1) {
                e.target.closest('tr').remove();
                updateTotals();
            } else {
                alert('You must have at least one item.');
            }
        }
    });

    // ============================================
    // RESET POS TABLE
    // ============================================
    function resetPOSTable() {
        const rows = posTableBody.querySelectorAll('tr');
        rows.forEach((row, index) => {
            if (index > 0) {
                row.remove();
            }
        });
        
        const firstRow = posTableBody.querySelector('tr:first-child');
        if (firstRow) {
            const itemSelect = firstRow.querySelector('.wholesale-pos-item');
            const itemSearchInput = firstRow.querySelector('.wholesale-pos-item-search');
            const batchSelect = firstRow.querySelector('.wholesale-pos-batch');
            const packInput = firstRow.querySelector('.wholesale-pos-pack-size');
            const taxInput = firstRow.querySelector('.wholesale-pos-tax');
            const rateInput = firstRow.querySelector('.wholesale-pos-rate');
            const qtyInput = firstRow.querySelector('.wholesale-pos-qty');
            const totalInput = firstRow.querySelector('.wholesale-pos-total');

            if (itemSelect) itemSelect.value = '';
            if (itemSearchInput) itemSearchInput.value = ''; // 🔥 ADDED: keep in sync with itemSelect above
            if (batchSelect) batchSelect.innerHTML = `<option value="">Select Batch</option>`;
            if (packInput) packInput.value = '';
            if (taxInput) taxInput.value = '';
            if (rateInput) rateInput.value = '';
            if (qtyInput) {
                qtyInput.value = '1';
                qtyInput.disabled = false;
                qtyInput.max = '';
            }
            if (totalInput) totalInput.value = '';

            if (itemSelect) {
                loadProductDropdownsForRow(itemSelect);
            }
        }
        updateTotals();
    }

    // ============================================
    // ADD POS ROW
    // ============================================
    function addPOSRow() {
        const template = document.querySelector('.wholesale-pos-row');
        if (!template) {
            console.error("❌ wholesale-pos-row template missing!");
            return;
        }
        
        const newRow = template.cloneNode(true);
        newRow.classList.remove('wholesale-pos-row');

        const itemSelect = newRow.querySelector('.wholesale-pos-item');
        const itemSearchInput = newRow.querySelector('.wholesale-pos-item-search');
        const batchSelect = newRow.querySelector('.wholesale-pos-batch');
        const packInput = newRow.querySelector('.wholesale-pos-pack-size');
        const taxInput = newRow.querySelector('.wholesale-pos-tax');
        const rateInput = newRow.querySelector('.wholesale-pos-rate');
        const qtyInput = newRow.querySelector('.wholesale-pos-qty');
        const totalInput = newRow.querySelector('.wholesale-pos-total');

        if (itemSelect) {
            itemSelect.value = '';
            loadProductDropdownsForRow(itemSelect);
        }
        if (itemSearchInput) itemSearchInput.value = ''; // 🔥 ADDED: keep in sync with itemSelect above (cloned from the template, which may carry stale text)
        if (batchSelect) batchSelect.innerHTML = `<option value="">Select Batch</option>`;
        if (packInput) packInput.value = '';
        if (taxInput) taxInput.value = '';
        if (rateInput) rateInput.value = '';
        if (qtyInput) {
            qtyInput.value = '1';
            qtyInput.disabled = false;
            qtyInput.max = '';
        }
        if (totalInput) totalInput.value = '';

        posTableBody.appendChild(newRow);
    }

    // ============================================
    // HELPER FUNCTIONS
    // ============================================
    async function loadCustomers() {
        try {
            const { data: customers, error } = await supabaseClient
                .from('wholesale_customers')
                .select('id, customer_name, phone, opening_balance_zmw')
                .order('customer_name');

            if (error) throw error;

            customerSelect.innerHTML = `<option value="">Select Customer</option>`;
            customers.forEach(c => {
                customerSelect.innerHTML += `<option value="${c.id}" data-customer-name="${c.customer_name}" data-phone="${c.phone || ''}">${c.customer_name}</option>`;
            });
        } catch (e) {
            console.warn("Could not load customers:", e);
        }
    }

    // 🔥 ADDED: resolve generic names for every product, same two-query
    // pattern (products, then a batch generic_names lookup keyed by
    // generic_name_id) already used by Purchase/Retail -- needed so each
    // item row's dropdown option can carry a data-generic attribute,
    // which is how getSaleData() picks up the Generic Name for the new
    // Delivery Note print-out below.
    async function buildGenericNameMap(products) {
        const genericIds = [...new Set((products || []).map(p => p.generic_name_id).filter(Boolean))];
        const map = {};
        if (genericIds.length === 0) return map;
        const { data: generics, error } = await supabaseClient
            .from('generic_names')
            .select('id, name')
            .in('id', genericIds);
        if (!error && generics) {
            generics.forEach(g => { map[g.id] = g.name; });
        }
        return map;
    }

    async function loadProductDropdowns() {
        const selects = document.querySelectorAll('.wholesale-pos-item');
        try {
            const { data: products, error } = await supabaseClient
                .from('products')
                .select('id, product_name, generic_name_id')
                .order('product_name');

            if (error) throw error;

            const genericMap = await buildGenericNameMap(products);

            // 🔥 ADDED: feeds the item search box's filtering (matches on
            // BOTH product_name and generic name) -- see the item-search
            // block above.
            productCatalogCache = products.map(p => ({
                id: p.id,
                product_name: p.product_name,
                generic: genericMap[p.generic_name_id] || ''
            }));

            selects.forEach(select => {
                if (select) {
                    select.innerHTML = `<option value="">Select Item</option>`;
                    products.forEach(p => {
                        select.innerHTML += `<option value="${p.id}" data-generic="${genericMap[p.generic_name_id] || ''}">${p.product_name}</option>`;
                    });
                }
            });
        } catch (e) {
            console.warn("Could not load products:", e);
        }
    }

    async function loadProductDropdownsForRow(select) {
        if (!select) return;
        try {
            const { data: products, error } = await supabaseClient
                .from('products')
                .select('id, product_name, generic_name_id')
                .order('product_name');

            if (error) throw error;

            const genericMap = await buildGenericNameMap(products);

            // Keep the shared search cache fresh here too -- this runs on
            // every Reset/new-row, so it doubles as a periodic refresh in
            // case products were added since the page loaded.
            productCatalogCache = products.map(p => ({
                id: p.id,
                product_name: p.product_name,
                generic: genericMap[p.generic_name_id] || ''
            }));

            select.innerHTML = `<option value="">Select Item</option>`;
            products.forEach(p => {
                select.innerHTML += `<option value="${p.id}" data-generic="${genericMap[p.generic_name_id] || ''}">${p.product_name}</option>`;
            });
        } catch (e) {
            console.warn("Could not load products for row:", e);
        }
    }

    function generateNextSaleId() {
        // 🔥 FIX: a fresh generated invoice number means this is a NEW sale
        // from here on, not an edit of an existing one -- clear the edit
        // tracker so Save inserts instead of updating. Covers the Reset
        // button, the post-save form reset, and convertQuotationToInvoice()
        // (which deliberately calls this right after loadWholesaleForEdit()
        // to turn a loaded quotation into a brand-new invoice instead of
        // editing it in place). Same pattern as retail.js.
        editingWholesaleDbId = null;

        // 🔥 ADDED: also clears any pending quotation-conversion tracker --
        // a plain Reset or starting a fresh sale means there is no
        // conversion to finalize on the next Save. convertQuotationToInvoice()
        // sets convertingFromQuotationId AFTER calling this function, so
        // that assignment always wins for an actual conversion.
        convertingFromQuotationId = null;

        const display = document.getElementById('saleIdDisplay');
        const invoiceDisplay = document.getElementById('invoiceNumber');
        if (!display) return;

        const date = new Date();
        const year = date.getFullYear();
        const timestamp = Date.now().toString().slice(-6);
        const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
        // 🔥 CHANGED: uses the prefix for whichever customer type is
        // currently on the form (falls back to Regular if none selected
        // yet) instead of always the one generic wholesale_prefix.
        const prefix = getWholesalePrefix(customerType ? customerType.value : '');
        const saleId = `${prefix}-${year}-${timestamp}-${random}`;

        display.textContent = `Invoice #: ${saleId}`;
        if (invoiceDisplay) invoiceDisplay.value = saleId;
    }

    function updateDateTime() {
        const now = new Date();
        const dateTimeStr = now.toLocaleString('en-ZM', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        });
        if (invoiceDateTime) invoiceDateTime.value = dateTimeStr;
    }

    function clearCustomerFields() {
        customerType.value = '';
        contactPerson.value = '';
        phone.value = '';
        address.value = '';
        zamra.value = '';
        tpin.value = '';
    }

    // ============================================
    // UPDATE ROW RATE
    // ============================================
    function updateRowRate(row) {
        if (!row) return;
        const batchSelect = row.querySelector('.wholesale-pos-batch');
        const rateInput = row.querySelector('.wholesale-pos-rate');
        const packInput = row.querySelector('.wholesale-pos-pack-size');
        
        if (!batchSelect || !rateInput || !packInput) return;

        const selected = batchSelect.options[batchSelect.selectedIndex];
        if (!selected || !selected.value) { 
            rateInput.value = ''; 
            return; 
        }

        const singleUnitCost = parseFloat(selected.dataset.cost) || 0;
        const packSize = parseInt(selected.dataset.pack) || 1;
        const costPerPack = singleUnitCost * packSize;

        const customerTypeValue = customerType.value || 'REGULAR';

        // 🔥 CHANGED: dynamic pricing -- flat global rates from Admin
        // (company_settings) instead of per-product wholesale_internal_percent /
        // wholesale_regular_percent. Same rate for every product, regardless
        // of cost (Wholesale doesn't use the exponential curve -- only
        // Retail Regular/Online do).
        let percent = 0;
        if (customerTypeValue === 'INTERNAL') {
            percent = companySettings.wholesale_internal_markup_percent;
        } else {
            percent = companySettings.wholesale_regular_markup_percent;
        }

        packInput.value = packSize + 's';
        const markupMultiplier = 1 + (percent / 100);
        const saleRatePerPack = costPerPack * markupMultiplier;
        
        rateInput.value = saleRatePerPack.toFixed(2);
    }

    function updateRowTotal(row) {
        if (!row) return;
        const rate = parseFloat(row.querySelector('.wholesale-pos-rate')?.value) || 0;
        const qty = parseInt(row.querySelector('.wholesale-pos-qty')?.value) || 0;
        const totalInput = row.querySelector('.wholesale-pos-total');
        if (totalInput) totalInput.value = (rate * qty).toFixed(2);
    }

    function updateTotals() {
        const rows = posTableBody.querySelectorAll('tr');
        let subtotal = 0;
        let totalTax = 0;

        rows.forEach(row => {
            const total = parseFloat(row.querySelector('.wholesale-pos-total')?.value) || 0;
            const taxRate = parseFloat(row.querySelector('.wholesale-pos-tax')?.value) || 0;
            
            if (taxRate > 0 && total > 0) {
                const taxAmount = total * (taxRate / (100 + taxRate));
                subtotal += total - taxAmount;
                totalTax += taxAmount;
            } else {
                subtotal += total;
            }
        });

        const grandTotal = subtotal + totalTax;

        document.getElementById('wholesaleSubtotal').textContent = `K${subtotal.toFixed(2)}`;
        document.getElementById('wholesaleTotalTax').textContent = `K${totalTax.toFixed(2)}`;
        document.getElementById('wholesaleGrandTotal').textContent = `K${grandTotal.toFixed(2)}`;
    }

    function updateRowRates() {
        const rows = posTableBody.querySelectorAll('tr');
        rows.forEach(row => updateRowRate(row));
    }


    // ============================================
    // 🔥 ADDED: SEARCH INVOICES & QUOTATIONS
    // Same feature as retail.js, adapted to Wholesale's own fields --
    // no NHIMA, no how-to-take/days-supplied, customer_name instead of
    // full_name. Scoped to client_type = 'WHOLESALE' only, so a search
    // here can never return a Retail sale whose data (rate stored
    // pack-adjusted rather than per-unit) isn't compatible with this form.
    // ============================================
    async function searchSalesRecords(query) {
        const resultsEl = document.getElementById('wholesaleSearchResults');
        if (!resultsEl) return;

        resultsEl.innerHTML = `<div style="text-align:center; padding:30px; color:#94a3b8;"><i class="fa-solid fa-spinner fa-spin"></i> Searching...</div>`;

        try {
            let dbQuery = supabaseClient
                .from('sales')
                .select('id, sale_id, created_at, grand_total, status, is_quotation, customer_data, client_type')
                .eq('client_type', 'WHOLESALE')
                .order('created_at', { ascending: false })
                .limit(20);

            // 🔥 ADDED: this used to only ever match the invoice number --
            // there was no way to find an older invoice by customer name
            // alone. No date limit here either -- this already searches
            // every WHOLESALE sale ever saved, not just today's.
            if (query && query.trim() !== '') {
                const term = query.trim().replace(/[%_]/g, '\\$&');
                dbQuery = dbQuery.or(
                    `sale_id.ilike.%${term}%,customer_data->>customer_name.ilike.%${term}%`
                );
            }

            const { data: results, error } = await dbQuery;
            if (error) throw error;

            renderSearchResults(results || []);

        } catch (error) {
            console.error('Error searching sales:', error);
            resultsEl.innerHTML = `<div style="text-align:center; padding:30px; color:#dc2626;">Error searching: ${error.message}</div>`;
        }
    }

    function renderSearchResults(results) {
        const resultsEl = document.getElementById('wholesaleSearchResults');
        if (!resultsEl) return;

        if (results.length === 0) {
            resultsEl.innerHTML = `<div style="text-align:center; padding:30px; color:#94a3b8;">No matching invoices or quotations found.</div>`;
            return;
        }

        const isAdmin = currentUserRole === 'Admin';

        resultsEl.innerHTML = results.map(r => {
            const isQuotation = r.is_quotation;
            const date = new Date(r.created_at).toLocaleDateString();
            const customerName = r.customer_data?.customer_name || 'N/A';
            const typeLabel = isQuotation
                ? `<span style="background:#fef3c7; color:#92400e; padding:2px 10px; border-radius:10px; font-size:0.7rem; font-weight:600;">QUOTATION</span>`
                : `<span style="background:#dcfce7; color:#166534; padding:2px 10px; border-radius:10px; font-size:0.7rem; font-weight:600;">INVOICE</span>`;

            // 🔥 ADDED: "Print" on every row -- previously there was no way
            // to reprint an invoice or quotation once it had already been
            // saved (the only print button lived on the "just saved this"
            // confirmation dialog, which only ever knew about whatever was
            // saved in the current page session). Wired to printSavedSale(),
            // which re-fetches the record and prints it exactly like a
            // fresh save would.
            const printBtn = `<button class="search-print-btn" data-id="${r.id}" style="background:#0f766e; color:white; border:none; padding:5px 12px; border-radius:4px; cursor:pointer; font-size:0.75rem;"><i class="fa-solid fa-print"></i> Print</button>`;

            const actions = isQuotation ? `
                <button class="search-view-btn" data-id="${r.id}" style="background:#2563eb; color:white; border:none; padding:5px 12px; border-radius:4px; cursor:pointer; font-size:0.75rem;"><i class="fa-solid fa-eye"></i> View</button>
                ${printBtn}
                <button class="search-convert-btn" data-id="${r.id}" style="background:#059669; color:white; border:none; padding:5px 12px; border-radius:4px; cursor:pointer; font-size:0.75rem;"><i class="fa-solid fa-arrow-right-arrow-left"></i> Convert to Invoice</button>
            ` : `
                <button class="search-view-btn" data-id="${r.id}" style="background:#2563eb; color:white; border:none; padding:5px 12px; border-radius:4px; cursor:pointer; font-size:0.75rem;"><i class="fa-solid fa-eye"></i> View</button>
                ${printBtn}
                <button class="search-edit-btn" data-id="${r.id}" style="background:#f59e0b; color:white; border:none; padding:5px 12px; border-radius:4px; cursor:pointer; font-size:0.75rem;"><i class="fa-solid fa-pen"></i> Edit</button>
                ${isAdmin ? `<button class="search-delete-btn" data-id="${r.id}" data-sale-number="${r.sale_id}" style="background:#dc2626; color:white; border:none; padding:5px 12px; border-radius:4px; cursor:pointer; font-size:0.75rem;"><i class="fa-solid fa-trash"></i> Delete</button>` : ''}
            `;

            return `
                <div style="padding:12px; margin-bottom:8px; background:#f8fafc; border-radius:6px; border:1px solid #e2e8f0;">
                    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
                        <div>
                            <span style="font-weight:600;">${r.sale_id}</span> ${typeLabel}
                            <div style="font-size:0.8rem; color:#64748b; margin-top:2px;">${customerName} &middot; ${date} &middot; K${(r.grand_total || 0).toFixed(2)}</div>
                        </div>
                        <div style="display:flex; gap:6px;">${actions}</div>
                    </div>
                </div>
            `;
        }).join('');

        resultsEl.querySelectorAll('.search-view-btn').forEach(btn => {
            btn.addEventListener('click', () => viewSaleDetail(btn.dataset.id));
        });
        resultsEl.querySelectorAll('.search-print-btn').forEach(btn => {
            btn.addEventListener('click', () => printSavedSale(btn.dataset.id));
        });
        resultsEl.querySelectorAll('.search-edit-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                await loadSaleByIdForEdit(btn.dataset.id);
                document.getElementById('wholesaleSearchModal').style.display = 'none';
            });
        });
        resultsEl.querySelectorAll('.search-convert-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                await convertQuotationToInvoice(btn.dataset.id);
                document.getElementById('wholesaleSearchModal').style.display = 'none';
            });
        });
        resultsEl.querySelectorAll('.search-delete-btn').forEach(btn => {
            btn.addEventListener('click', () => deleteSaleRecord(btn.dataset.id, btn.dataset.saleNumber));
        });
    }

    async function fetchSaleDataById(id) {
        const { data: sale, error } = await supabaseClient
            .from('sales')
            .select('*')
            .eq('id', id)
            .maybeSingle();

        if (error) throw error;
        if (!sale) return null;

        return {
            // 🔥 FIX: this was missing entirely, unlike retail.js's own
            // version of this same function -- so even Wholesale's own
            // in-page "Search Invoices" modal's Edit button never actually
            // updated the invoice it loaded; Save always inserted a
            // duplicate. See editingWholesaleDbId's declaration near the
            // top of the file.
            db_id: sale.id,
            sale_id: sale.sale_id,
            client_sub_type: sale.client_sub_type,
            customer_data: sale.customer_data || {},
            items: sale.items || [],
            payment: sale.payment || { type: 'Cash', note: '' },
        };
    }

    async function viewSaleDetail(id) {
        try {
            const { data: sale, error } = await supabaseClient
                .from('sales')
                .select('*')
                .eq('id', id)
                .maybeSingle();

            if (error) throw error;
            if (!sale) { alert('Could not find that sale.'); return; }

            const saleData = {
                sale_id: sale.sale_id,
                customer: sale.customer_data || {},
                items: sale.items || [],
                payment: sale.payment || { type: 'Cash', note: '' },
                totals: {
                    subtotal: sale.subtotal || 0,
                    tax: sale.tax || 0,
                    grand_total: sale.grand_total || 0
                },
                date: new Date(sale.created_at).toLocaleString(),
                status: sale.status,
                is_quotation: sale.is_quotation
            };

            showViewItemsModal(saleData);
        } catch (error) {
            console.error('Error viewing sale detail:', error);
            alert('Error loading sale details: ' + error.message);
        }
    }

    // 🔥 ADDED: reprints an already-saved invoice or quotation found via
    // Search. Previously printSale() only ever had access to
    // currentSaleData -- whatever was saved in THIS page session -- so
    // once you saved something else, or reloaded the page, there was no
    // way to print a past invoice again at all. Builds the exact same
    // saleData shape viewSaleDetail() does (buildWholesaleCopyHTML()
    // needs the full totals/date/status, not just the item list) and
    // hands it straight to printSale().
    async function printSavedSale(id) {
        try {
            const { data: sale, error } = await supabaseClient
                .from('sales')
                .select('*')
                .eq('id', id)
                .maybeSingle();

            if (error) throw error;
            if (!sale) { alert('Could not find that sale.'); return; }

            const saleData = {
                sale_id: sale.sale_id,
                customer: sale.customer_data || {},
                items: sale.items || [],
                payment: sale.payment || { type: 'Cash', note: '' },
                totals: {
                    subtotal: sale.subtotal || 0,
                    tax: sale.tax || 0,
                    grand_total: sale.grand_total || 0
                },
                date: new Date(sale.created_at).toLocaleString(),
                status: sale.status,
                is_quotation: sale.is_quotation
            };

            printSale(saleData);
        } catch (error) {
            console.error('Error reprinting sale:', error);
            alert('Error reprinting: ' + error.message);
        }
    }

    function showViewItemsModal(saleData) {
        const modalEl = document.getElementById('wholesaleViewItemsModal');
        const content = document.getElementById('wholesaleViewItemsContent');
        const title = document.getElementById('wholesaleViewModalTitle');
        if (!modalEl || !content) return;

        const docLabel = saleData.is_quotation ? 'Quotation' : 'Invoice';
        title.innerHTML = `<i class="fa-solid fa-list" style="color: #2563eb;"></i> ${docLabel} - ${saleData.sale_id}`;

        let html = `
            <div style="margin-bottom: 20px; padding: 15px; background: #f8fafc; border-radius: 6px; border: 1px solid #e2e8f0;">
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                    <div><strong>${docLabel} #:</strong> ${saleData.sale_id}</div>
                    <div><strong>Date:</strong> ${saleData.date}</div>
                    <div><strong>Customer:</strong> ${saleData.customer.customer_name || 'N/A'}</div>
                    <div><strong>Phone:</strong> ${saleData.customer.phone || 'N/A'}</div>
                    <div><strong>Payment:</strong> ${saleData.payment.type}</div>
                    <div><strong>Status:</strong> <span style="color: #10b981; font-weight: 600;">${saleData.status}</span></div>
                </div>
            </div>
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
                <thead style="background: #f1f5f9;">
                    <tr>
                        <th style="padding: 10px; text-align: left; border-bottom: 2px solid #e2e8f0;">Item</th>
                        <th style="padding: 10px; text-align: left; border-bottom: 2px solid #e2e8f0;">Batch</th>
                        <th style="padding: 10px; text-align: center; border-bottom: 2px solid #e2e8f0;">Pack</th>
                        <th style="padding: 10px; text-align: right; border-bottom: 2px solid #e2e8f0;">Rate</th>
                        <th style="padding: 10px; text-align: right; border-bottom: 2px solid #e2e8f0;">Qty</th>
                        <th style="padding: 10px; text-align: right; border-bottom: 2px solid #e2e8f0;">Total</th>
                    </tr>
                </thead>
                <tbody>
        `;

        saleData.items.forEach(item => {
            html += `
                <tr style="border-bottom: 1px solid #e2e8f0;">
                    <td style="padding: 10px;">${item.product_name}</td>
                    <td style="padding: 10px;">${item.batch_number}</td>
                    <td style="padding: 10px; text-align: center;">${item.pack_size}</td>
                    <td style="padding: 10px; text-align: right;">K${(item.rate || 0).toFixed(2)}</td>
                    <td style="padding: 10px; text-align: right;">${item.qty}</td>
                    <td style="padding: 10px; text-align: right;">K${(item.total || 0).toFixed(2)}</td>
                </tr>
            `;
        });

        html += `
                </tbody>
                <tfoot style="background: #f8fafc; font-weight: 600;">
                    <tr>
                        <td colspan="5" style="padding: 10px; text-align: right;">Subtotal:</td>
                        <td style="padding: 10px; text-align: right;">K${saleData.totals.subtotal.toFixed(2)}</td>
                    </tr>
                    <tr>
                        <td colspan="5" style="padding: 10px; text-align: right;">Tax:</td>
                        <td style="padding: 10px; text-align: right;">K${saleData.totals.tax.toFixed(2)}</td>
                    </tr>
                    <tr style="font-size: 1.1rem; color: #0f172a;">
                        <td colspan="5" style="padding: 10px; text-align: right;">Grand Total:</td>
                        <td style="padding: 10px; text-align: right;">K${saleData.totals.grand_total.toFixed(2)}</td>
                    </tr>
                </tfoot>
            </table>
        `;

        content.innerHTML = html;
        modalEl.style.display = 'flex';
    }

    async function loadSaleByIdForEdit(id) {
        try {
            const saleData = await fetchSaleDataById(id);
            if (!saleData) { alert('Could not find that sale.'); return; }
            await loadWholesaleForEdit(saleData);
        } catch (error) {
            console.error('Error loading sale for edit:', error);
            alert('Error loading sale: ' + error.message);
        }
    }

    // 🔥 ADDED: same as retail.js -- loads a quotation into the form for
    // review with a fresh invoice number, never auto-saves.
    async function convertQuotationToInvoice(id) {
        try {
            const saleData = await fetchSaleDataById(id);
            if (!saleData) { alert('Could not find that quotation.'); return; }

            await loadWholesaleForEdit(saleData);
            generateNextSaleId();

            // 🔥 ADDED: remember which quotation this is -- generateNextSaleId()
            // just cleared any previous tracker, so this MUST be set after
            // that call, not before. saveTransaction() reads this once the
            // new invoice has actually saved and removes the original
            // quotation, so it stops sitting there as a separate, still-open
            // document once it's been turned into a real invoice.
            convertingFromQuotationId = id;

            alert('✅ Quotation loaded. Review the details, then click Save to finalize it as a real invoice.\n\nOnce saved, this quotation will be removed automatically.');
        } catch (error) {
            console.error('Error converting quotation:', error);
            alert('Error converting quotation: ' + error.message);
        }
    }

    // 🔥 ADDED: same conservative baseline as retail.js -- removes the
    // sale and its sale_items rows only, does not touch stock or the
    // accounting ledger. Admin-only, checked both in the UI and here.
    async function deleteSaleRecord(id, saleNumber) {
        if (currentUserRole !== 'Admin') {
            alert('Only an Admin can delete a sale record.');
            return;
        }

        const confirmed = confirm(
            `Delete ${saleNumber}?\n\nThis permanently removes the sale record. ` +
            `It does NOT restore stock or reverse any accounting entries already posted for it -- ` +
            `those will need to be corrected separately if this sale affected them.\n\nThis cannot be undone.`
        );
        if (!confirmed) return;

        try {
            const { error: itemsError } = await supabaseClient
                .from('sale_items')
                .delete()
                .eq('sale_id', id);
            if (itemsError) throw itemsError;

            const { error: saleError } = await supabaseClient
                .from('sales')
                .delete()
                .eq('id', id);
            if (saleError) throw saleError;

            alert(`✅ ${saleNumber} deleted.`);
            searchSalesRecords(document.getElementById('wholesaleSearchInput')?.value || '');
        } catch (error) {
            console.error('Error deleting sale:', error);
            alert('Error deleting sale: ' + error.message);
        }
    }




    // ============================================
    // GET SALE DATA (WITH STOCK VALIDATION)
    // ============================================
    function getSaleData(status = 'COMPLETED', prefix = 'GWH') {
        const rows = posTableBody.querySelectorAll('tr');
        const items = [];
        let hasItems = false;
        let stockErrors = [];

        rows.forEach(row => {
            const itemSelect = row.querySelector('.wholesale-pos-item');
            const batchSelect = row.querySelector('.wholesale-pos-batch');
            const qtyInput = row.querySelector('.wholesale-pos-qty');
            const rateInput = row.querySelector('.wholesale-pos-rate');
            const packInput = row.querySelector('.wholesale-pos-pack-size');
            const taxInput = row.querySelector('.wholesale-pos-tax');
            const totalInput = row.querySelector('.wholesale-pos-total');
            
            const selectedBatch = batchSelect?.options[batchSelect.selectedIndex];
            
            if (itemSelect && itemSelect.value && batchSelect && batchSelect.value) {
                const qty = parseInt(qtyInput.value) || 0;
                if (qty > 0) {
                    hasItems = true;
                    
                    const availableQty = parseInt(selectedBatch?.dataset?.qty) || 0;
                    if (qty > availableQty) {
                        stockErrors.push({
                            product: itemSelect.options[itemSelect.selectedIndex]?.text || 'Unknown',
                            batch: selectedBatch?.text || 'Unknown',
                            requested: qty,
                            available: availableQty
                        });
                    }
                    
                    const packSize = parseInt(packInput.value) || 1;
                    const singleUnitCost = parseFloat(selectedBatch?.dataset?.cost) || 0;
                    
                    items.push({
                        product_id: itemSelect.value,
                        product_name: itemSelect.options[itemSelect.selectedIndex]?.text || '',
                        // 🔥 ADDED: for the Delivery Note (Item/Generic/Batch/
                        // Expiry) -- read straight off the dropdown options'
                        // own data attributes, same as batch_number below, so
                        // no extra DB round-trip is needed at save time.
                        generic_name: itemSelect.options[itemSelect.selectedIndex]?.dataset.generic || '',
                        batch_id: batchSelect.value,
                        // 🔥 FIX: same as retail.js -- this used to store
                        // the entire dropdown display text including
                        // live stock quantity.
                        batch_number: batchSelect.options[batchSelect.selectedIndex]?.dataset.batchNumber || '',
                        expiry: selectedBatch?.dataset?.expiry || '',
                        qty: qty,
                        rate: parseFloat(rateInput.value) || 0,
                        pack_size: packInput.value || '1s',
                        tax_rate: parseFloat(taxInput.value) || 0,
                        total: (parseFloat(rateInput.value) || 0) * qty,
                        cost_per_unit: singleUnitCost,
                        available_qty: availableQty
                    });
                }
            }
        });

        // 🔥 CHANGED: insufficient stock still blocks an actual sale
        // (COMPLETED) -- we can't sell what isn't on the shelf -- but a
        // QUOTATION is just a price estimate for the customer, not a
        // stock commitment (and doesn't deduct stock either way), so it
        // shouldn't be blocked by what's physically available right now.
        // The requested quantity is still saved as entered.
        if (stockErrors.length > 0 && status !== 'QUOTATION') {
            let errorMsg = '❌ Stock validation failed:\n\n';
            stockErrors.forEach(err => {
                errorMsg += `• ${err.product} (${err.batch}): Requested ${err.requested}, Available ${err.available}\n`;
            });
            errorMsg += '\nPlease adjust quantities or select different batches.';
            alert(errorMsg);
            return null;
        }

        if (!hasItems) {
            alert('Please add at least one item to the sale.');
            return null;
        }

        const customerId = customerSelect.value;
        if (!customerId) {
            alert('Please select a customer.');
            return null;
        }

        const customerData = {
            id: customerId,
            // 🔥 FIX: this used to parse the customer name back out of
            // the dropdown's display text by splitting on " - ", which
            // would silently truncate any customer name that genuinely
            // contained that substring. Now reads the clean name
            // directly from a data attribute instead.
            customer_name: customerSelect.options[customerSelect.selectedIndex]?.dataset.customerName || '',
            contact_person: contactPerson.value || '',
            phone: phone.value || '',
            address: address.value || '',
            customer_type: customerType.value || 'REGULAR',
            zamra_number: zamra.value || '',
            tpin_number: tpin.value || ''
        };

        const paymentTypeVal = document.getElementById('wholesalePaymentType')?.value || 'Cash';
        const paymentNoteVal = document.getElementById('wholesalePaymentNote')?.value || '';

        const subtotal = parseFloat(document.getElementById('wholesaleSubtotal')?.textContent?.replace('K', '') || '0');
        const tax = parseFloat(document.getElementById('wholesaleTotalTax')?.textContent?.replace('K', '') || '0');
        const grandTotal = parseFloat(document.getElementById('wholesaleGrandTotal')?.textContent?.replace('K', '') || '0');

        const saleData = {
            type: status,
            prefix: prefix,
            client_type: 'WHOLESALE',
            client_sub_type: customerType.value || 'REGULAR',
            customer: customerData,
            items: items,
            payment: {
                type: paymentTypeVal,
                note: paymentNoteVal
            },
            totals: {
                subtotal: subtotal,
                tax: tax,
                grand_total: grandTotal
            },
            sale_id: document.getElementById('invoiceNumber')?.value || '',
            date: document.getElementById('invoiceDateTime')?.value || new Date().toLocaleString(),
            status: status,
            customerType: customerType
        };

        return saleData;
    }

    // ============================================
    // WHOLESALE ACCOUNTING INTEGRATION
    // ============================================
    async function createWholesaleAccountingEntries(saleData, saleRecord) {
        try {
            await ensureChartOfAccounts();
            const accountCodes = await getAccountCodesFromChartOfAccounts();

            const entryDate = new Date().toISOString().split('T')[0];
            // 🔥 FIX: saleData.customer_type never existed (the real value
            // lives at saleData.client_sub_type, set in getSaleData()) — so
            // `subType` was silently always 'REGULAR', meaning INTERNAL
            // wholesale sales were NEVER posted to the Internal Sales
            // revenue account (4102); they always went to Regular Sales
            // (4101) no matter what the customer actually was.
            const subType = saleData.client_sub_type || 'REGULAR';
            const paymentType = saleData.payment.type;
            const saleId = saleData.sale_id;

            const revenueAccount = subType === 'INTERNAL'
                ? accountCodes.wholesale_internal_sales
                : accountCodes.wholesale_regular_sales;

            // 🔥 FIX: only 'Credit' means the customer still owes the money
            // and should hit Accounts Receivable. The old logic's
            // `isCashSale` check treated Airtel Money and Bank Transfer the
            // same as Credit (routing BOTH to Accounts Receivable, code
            // 1200) even though that money was already received —
            // overstating receivables and understating cash/bank on hand.
            let debitAccount = '';
            let debitDescription = '';

            if (paymentType === 'Credit') {
                debitAccount = accountCodes.accounts_receivable;
                debitDescription = `Credit sale - ${saleId}`;
            } else if (paymentType === 'Cash') {
                debitAccount = accountCodes.cash_zmw;
                debitDescription = `Cash payment - ${saleId}`;
            } else if (paymentType === 'Bank Transfer') {
                debitAccount = accountCodes.bank_zmw;
                debitDescription = `Bank Transfer payment - ${saleId}`;
            } else {
                // Airtel Money / Mobile Money / anything else received
                // immediately (not owed) — treated as a cash-equivalent.
                debitAccount = accountCodes.cash_zmw;
                debitDescription = `${paymentType} payment - ${saleId}`;
            }

            const totalAmount = saleData.totals.grand_total || 0;
            const taxAmount = saleData.totals.tax || 0;
            // 🔥 FIX: revenue must be booked NET of tax — the tax portion
            // belongs in the Sales Tax Payable liability account, not
            // Revenue. Previously the entire tax-inclusive total was
            // credited to Revenue with no tax line posted anywhere at all.
            const netRevenue = totalAmount - taxAmount;

            const cogsAmount = saleData.items.reduce((sum, item) => {
                const singleUnitCost = item.cost_per_unit || 0;
                const packSize = parseInt(item.pack_size) || 1;
                return sum + (singleUnitCost * item.qty * packSize);
            }, 0);

            const journalNumber = `WHL-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;

            const journal = {
                entry_date: entryDate,
                reference: saleId || 'SALE-' + Date.now(),
                description: `Wholesale ${subType} sale - ${saleId}`,
                journal_number: journalNumber,
                status: 'Posted',
                created_at: new Date().toISOString()
            };

            const { data: journalData, error: journalError } = await supabaseClient
                .from('journal_entries')
                .insert([journal])
                .select();

            if (journalError) throw journalError;

            const journalId = journalData[0].id;
            const lines = [
                {
                    journal_entry_id: journalId,
                    account_code: debitAccount,
                    description: debitDescription,
                    debit: totalAmount,
                    credit: 0
                },
                {
                    journal_entry_id: journalId,
                    account_code: revenueAccount,
                    description: `Revenue from wholesale ${subType} sale - ${saleId}`,
                    debit: 0,
                    credit: netRevenue
                }
            ];

            if (taxAmount > 0) {
                lines.push({
                    journal_entry_id: journalId,
                    account_code: accountCodes.sales_tax_payable,
                    description: `VAT on wholesale sale - ${saleId}`,
                    debit: 0,
                    credit: taxAmount
                });
            }

            const { error: lineError } = await supabaseClient
                .from('journal_lines')
                .insert(lines);
            if (lineError) throw lineError;

            console.log(`✅ Revenue journal ${journalNumber} created`);
            console.log(`   Debit: ${debitAccount} - ${debitDescription}`);
            console.log(`   Credit: ${revenueAccount} - Revenue (${netRevenue})`);
            if (taxAmount > 0) {
                console.log(`   Credit: ${accountCodes.sales_tax_payable} - VAT (${taxAmount})`);
            }

            if (cogsAmount > 0) {
                const cogsJournal = {
                    entry_date: entryDate,
                    reference: `${saleId}-COGS`,
                    description: `COGS for wholesale - ${saleId}`,
                    journal_number: `COG-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
                    status: 'Posted',
                    created_at: new Date().toISOString()
                };
                
                const { data: cogsData, error: cogsError } = await supabaseClient
                    .from('journal_entries')
                    .insert([cogsJournal])
                    .select();
                
                if (cogsError) throw cogsError;
                
                const cogsLines = [
                    {
                        journal_entry_id: cogsData[0].id,
                        account_code: accountCodes.cogs_wholesale,
                        description: `COGS for wholesale - ${saleId}`,
                        debit: cogsAmount,
                        credit: 0
                    },
                    {
                        journal_entry_id: cogsData[0].id,
                        account_code: accountCodes.inventory,
                        description: `Inventory reduction - ${saleId}`,
                        debit: 0,
                        credit: cogsAmount
                    }
                ];
                
                const { error: cogsLineError } = await supabaseClient
                    .from('journal_lines')
                    .insert(cogsLines);
                
                if (cogsLineError) throw cogsLineError;

                console.log(`✅ COGS journal created: ${accountCodes.cogs_wholesale} debit ${cogsAmount}`);
            }
            
            console.log(`✅ Wholesale accounting entries created for ${saleId}`);
            
        } catch (error) {
            console.error('Error creating wholesale accounting entries:', error);
            console.warn('⚠️ Accounting entries failed but sale was saved successfully.');
        }
    }

    // ============================================
    // LOAD SALE FOR EDIT
    // ============================================
    async function loadWholesaleForEdit(saleData) {
        try {
            if (saleData.customer_data) {
                const customer = saleData.customer_data;
                if (customer.id) {
                    const opt = Array.from(customerSelect.options).find(o => o.value === customer.id);
                    if (opt) {
                        customerSelect.value = customer.id;
                        customerSelect.dispatchEvent(new Event('change'));
                    }
                }
                if (contactPerson) contactPerson.value = customer.contact_person || '';
                if (phone) phone.value = customer.phone || '';
                if (address) address.value = customer.address || '';
                if (customerType) customerType.value = customer.customer_type || saleData.client_sub_type || 'REGULAR';
                if (zamra) zamra.value = customer.zamra_number || '';
                if (tpin) tpin.value = customer.tpin_number || '';
            }

            if (saleData.payment) {
                const paymentTypeEl = document.getElementById('wholesalePaymentType');
                if (paymentTypeEl) {
                    paymentTypeEl.value = saleData.payment.type || 'Cash';
                    paymentTypeEl.dispatchEvent(new Event('change'));
                }
                const paymentNoteEl = document.getElementById('wholesalePaymentNote');
                if (paymentNoteEl) paymentNoteEl.value = saleData.payment.note || '';
            }

            if (saleData.sale_id) {
                document.getElementById('invoiceNumber').value = saleData.sale_id;
                const display = document.getElementById('saleIdDisplay');
                if (display) display.textContent = `Invoice #: ${saleData.sale_id}`;
            }

            if (saleData.items && saleData.items.length > 0) {
                const rows = posTableBody.querySelectorAll('tr');
                rows.forEach((row, index) => { if (index > 0) row.remove(); });

                const firstRow = posTableBody.querySelector('tr:first-child');
                if (firstRow) {
                    const itemSelect = firstRow.querySelector('.wholesale-pos-item');
                    const itemSearchInput = firstRow.querySelector('.wholesale-pos-item-search');
                    const batchSelect = firstRow.querySelector('.wholesale-pos-batch');
                    if (itemSelect) itemSelect.value = '';
                    if (itemSearchInput) itemSearchInput.value = ''; // 🔥 ADDED: keep in sync with itemSelect above
                    if (batchSelect) batchSelect.innerHTML = `<option value="">Select Batch</option>`;
                }

                saleData.items.forEach((item, index) => {
                    if (index > 0) addPOSRow();
                });

                // Prefetch every product/batch needed, then inject the
                // exact original values directly -- no dependency on the
                // item dropdown's own background load finishing in time,
                // and no substituted/recalculated batch or rate.
                const allProductIds = [...new Set(saleData.items.map(i => i.product_id).filter(Boolean))];
                const allBatchIds = [...new Set(saleData.items.map(i => i.batch_id).filter(Boolean))];

                const { data: editProducts } = await supabaseClient
                    .from('products').select('id, product_name').in('id', allProductIds);
                const { data: editBatches } = await supabaseClient
                    .from('batches').select('id, batch_number, expiry_date, total_qty').in('id', allBatchIds);

                const editProductMap = {};
                (editProducts || []).forEach(p => editProductMap[p.id] = p);
                const editBatchMap = {};
                (editBatches || []).forEach(b => editBatchMap[b.id] = b);

                const editRows = posTableBody.querySelectorAll('tr');

                saleData.items.forEach((item, index) => {
                    const targetRow = editRows[index];
                    if (!targetRow) return;

                    const itemSelect = targetRow.querySelector('.wholesale-pos-item');
                    const batchSelect = targetRow.querySelector('.wholesale-pos-batch');
                    const packInput = targetRow.querySelector('.wholesale-pos-pack-size');
                    const taxInput = targetRow.querySelector('.wholesale-pos-tax');
                    const rateInput = targetRow.querySelector('.wholesale-pos-rate');
                    const qtyInput = targetRow.querySelector('.wholesale-pos-qty');
                    const totalInput = targetRow.querySelector('.wholesale-pos-total');

                    if (itemSelect && item.product_id) {
                        let opt = Array.from(itemSelect.options).find(o => o.value === item.product_id);
                        if (!opt) {
                            const newOpt = document.createElement('option');
                            newOpt.value = item.product_id;
                            newOpt.textContent = editProductMap[item.product_id]?.product_name || item.product_name || 'Unknown item';
                            // 🔥 ADDED: preserve this line's original Generic
                            // Name (for the Delivery Note) even in the rare
                            // case the product wasn't found in the already-
                            // loaded dropdown -- getSaleData() reads this
                            // same data-generic attribute back out on Save.
                            newOpt.dataset.generic = item.generic_name || '';
                            itemSelect.appendChild(newOpt);
                        }
                        itemSelect.value = item.product_id;
                        syncItemSearchDisplay(targetRow); // 🔥 ADDED: reflect the selected item in the new search box
                    }

                    if (batchSelect && item.batch_id) {
                        const batchInfo = editBatchMap[item.batch_id];
                        const expiry = batchInfo ? new Date(batchInfo.expiry_date).toLocaleDateString() : '';
                        // 🔥 FIX: the "available" quantity shown/validated
                        // while editing used to be the batch's CURRENT live
                        // stock -- which already has THIS SAME invoice's
                        // original quantity deducted from it. So editing an
                        // invoice DOWN (e.g. a batch of 50, 40 already sold
                        // on this invoice, 10 left on the shelf -> trying
                        // to change it to 30) was wrongly blocked as
                        // "insufficient stock" (30 > 10), even though
                        // reducing the quantity can only ever free up more
                        // stock, never need more. Adds this line's own
                        // original committed quantity (converted to the
                        // same base-unit terms as total_qty, via its pack
                        // size) back on top of the live figure, so the cap
                        // used for validation reflects what's truly
                        // available once this invoice's own hold is
                        // accounted for -- exactly what saveTransaction()
                        // itself already restores behind the scenes before
                        // re-saving an edited invoice.
                        const originalPackSize = parseInt(item.pack_size) || 1;
                        const originalUnitsHeld = (parseInt(item.qty) || 0) * originalPackSize;
                        const liveUnits = batchInfo?.total_qty ?? item.available_qty ?? item.qty ?? 0;
                        const effectiveAvailable = liveUnits + originalUnitsHeld;
                        batchSelect.innerHTML = `<option value="${item.batch_id}"
                            data-cost="${item.cost_per_unit || 0}"
                            data-qty="${effectiveAvailable}"
                            data-batch-number="${item.batch_number || batchInfo?.batch_number || ''}"
                            data-expiry="${expiry}">
                            ${item.batch_number || batchInfo?.batch_number || 'Unknown batch'} ${expiry ? `(Exp: ${expiry})` : ''}
                        </option>`;
                        batchSelect.value = item.batch_id;
                    }

                    if (packInput) packInput.value = item.pack_size || '1s';
                    if (taxInput) taxInput.value = item.tax_rate || 0;
                    if (rateInput) rateInput.value = (item.rate || 0).toFixed(2);
                    if (qtyInput) qtyInput.value = item.qty || 1;
                    if (totalInput) totalInput.value = (item.total || 0).toFixed(2);
                });

                updateTotals();
            }

            // 🔥 FIX: set this LAST -- after everything above, in case any
            // of those field changes (customer select, payment type) ever
            // trigger a handler that touches the sale id. Setting it here
            // is what makes Save actually update this invoice instead of
            // inserting a duplicate. See the state declaration for why
            // this is needed at all.
            editingWholesaleDbId = saleData.db_id || null;

            alert('✅ Sale loaded for editing. Make changes and save.');

        } catch (error) {
            console.error('Error loading sale for edit:', error);
            alert('Error loading sale: ' + error.message);
        }
    }

    // 🔥 ADDED: same defensive cleanup as retail.js -- strips any
    // "- XX units" suffix that might still be on batch_number for sales
    // saved before the source-level fix to how batch_number is captured.
    function cleanBatchDisplay(batchNumber) {
        if (!batchNumber) return '';
        return batchNumber.replace(/\s*-\s*(⚠️\s*)?\d+\s*units?(\s*\(Low Stock\))?\s*$/i, '').trim();
    }

    // 🔥 Builds ONE copy of the document, labeled Customer or Merchant --
    // used twice below to produce both copies in a single print job.
    // Redesigned to match the reference layout: teal color scheme, Bill
    // To section, colored table header, highlighted total box, payment
    // info section -- using our real business details, not placeholder
    // content from the reference image.
    function buildWholesaleCopyHTML(saleData, copyLabel) {
        const isQuotation = saleData.status === 'QUOTATION';
        const docLabel = isQuotation ? 'Quotation' : 'Invoice';
        const effectiveTaxRate = saleData.totals.subtotal > 0
            ? (saleData.totals.tax / saleData.totals.subtotal * 100)
            : 0;

        return `
            <div class="copy-page">
                <div class="copy-label">${copyLabel} COPY</div>

                <div class="doc-header">
                    <div class="company-block">
                        <h1>${companySettings.wholesale_company_name}</h1>
                        <p>${companySettings.address}</p>
                        <p>Phone: ${companySettings.phone} | ZAMRA: ${companySettings.wholesale_zamra_number}${companySettings.wholesale_tpin_number ? ` | TPIN: ${companySettings.wholesale_tpin_number}` : ''}</p>
                    </div>
                </div>

                <div class="doc-title-row">
                    <div class="doc-title">
                        ${docLabel.toUpperCase()}
                        ${isQuotation ? '<span class="quotation-badge">QUOTATION</span>' : ''}
                    </div>
                </div>

                <div class="info-row">
                    <div class="info-box">
                        <div><strong>${docLabel} #:</strong> ${saleData.sale_id}</div>
                        <div><strong>Date:</strong> ${saleData.date}</div>
                        ${!isQuotation ? `<div><strong>Payment:</strong> ${saleData.payment.type}</div>` : ''}
                    </div>
                    <div class="bill-to">
                        <strong>BILL TO:</strong><br>
                        <strong>${saleData.customer.customer_name || 'N/A'}</strong><br>
                        ${saleData.customer.contact_person ? `Attn: ${saleData.customer.contact_person}<br>` : ''}
                        ${saleData.customer.address || ''}<br>
                        ${saleData.customer.phone ? `Phone: ${saleData.customer.phone}<br>` : ''}
                        ${saleData.customer.zamra_number ? `ZAMRA #: ${saleData.customer.zamra_number}<br>` : ''}
                        ${saleData.customer.tpin_number ? `TPIN #: ${saleData.customer.tpin_number}` : ''}
                    </div>
                </div>

                <table>
                    <thead>
                        <tr>
                            <th>Description</th>
                            <th>Batch</th>
                            <th class="text-center">Qty</th>
                            <th class="text-right">Unit Price</th>
                            <th class="text-right">Total</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${saleData.items.map(item => `
                            <tr>
                                <td>${item.product_name}</td>
                                <td>${cleanBatchDisplay(item.batch_number)}</td>
                                <td class="text-center">${item.qty} ${item.pack_size}</td>
                                <td class="text-right">K${item.rate.toFixed(2)}</td>
                                <td class="text-right">K${item.total.toFixed(2)}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>

                <div class="totals-box">
                    <div class="totals-row"><span>Subtotal</span><span>K${saleData.totals.subtotal.toFixed(2)}</span></div>
                    <div class="totals-row"><span>VAT (${effectiveTaxRate.toFixed(0)}%)</span><span>K${saleData.totals.tax.toFixed(2)}</span></div>
                    <div class="totals-row grand"><span>Total Due</span><span>K${saleData.totals.grand_total.toFixed(2)}</span></div>
                </div>

                <div class="payment-info">
                    <strong>NOTES / PAYMENT INFO</strong>
                    <p>Please reference ${docLabel} # ${saleData.sale_id} with payment.</p>
                    ${!isQuotation ? `
                        ${companySettings.bank_name || companySettings.bank_account_number ? `
                            <strong>PAYMENT OPTIONS</strong>
                            <p>Bank Transfer Details:<br>
                            Bank: ${companySettings.bank_name || 'N/A'}<br>
                            Account Name: ${companySettings.bank_account_name}<br>
                            ${companySettings.bank_branch ? `Branch: ${companySettings.bank_branch}<br>` : ''}
                            Account: ${companySettings.bank_account_number || 'N/A'}${companySettings.bank_swift ? `<br>SWIFT: ${companySettings.bank_swift}` : ''}</p>
                        ` : ''}
                    ` : `<p>This is a quotation only and does not constitute a tax invoice. Prices valid for 30 days.</p>`}
                </div>

                ${!isQuotation ? `
                <!-- 🔥 ADDED: sign-off boxes on the invoice itself, separate
                     from the Delivery Note's Dispatched/Received boxes --
                     Prepared By covers whoever drew up the invoice, before
                     the goods have necessarily even left the building. Only
                     on actual invoices, not quotations (nothing's shipped
                     yet, same reasoning as the Delivery Note being skipped
                     for quotations below). -->
                <div style="margin-top: 30px; display: flex; justify-content: space-between; gap: 20px; font-size: 0.85rem;">
                    <div style="flex: 1; border-top: 1px solid #1e293b; padding-top: 6px;">
                        Prepared By &nbsp;&nbsp; Name / Signature &amp; Date
                    </div>
                    <div style="flex: 1; border-top: 1px solid #1e293b; padding-top: 6px;">
                        Delivered By &nbsp;&nbsp; Name / Signature &amp; Date
                    </div>
                    <div style="flex: 1; border-top: 1px solid #1e293b; padding-top: 6px;">
                        Received By &nbsp;&nbsp; Name / Signature &amp; Date
                    </div>
                </div>
                ` : ''}
            </div>
        `;
    }

    // ============================================
    // 🔥 ADDED: DELIVERY NOTE
    // ============================================
    // Printed right after the Invoice, one per copy (Customer/Merchant),
    // so each copy is self-contained. No prices on a delivery note --
    // it's proof of what physically went out (Item / Generic / Batch /
    // Expiry / Qty), not a billing document -- with a signature line for
    // whoever receives the goods. Only makes sense for an actual
    // delivery, so this is skipped entirely for a Quotation (nothing has
    // shipped yet).
    function buildWholesaleDeliveryNoteHTML(saleData, copyLabel) {
        return `
            <div class="copy-page">
                <div class="copy-label">${copyLabel} COPY</div>

                <div class="doc-header">
                    <div class="company-block">
                        <h1>${companySettings.wholesale_company_name}</h1>
                        <p>${companySettings.address}</p>
                        <p>Phone: ${companySettings.phone} | ZAMRA: ${companySettings.wholesale_zamra_number}${companySettings.wholesale_tpin_number ? ` | TPIN: ${companySettings.wholesale_tpin_number}` : ''}</p>
                    </div>
                </div>

                <div class="doc-title-row">
                    <div class="doc-title">DELIVERY NOTE</div>
                </div>

                <div class="info-row">
                    <div class="info-box">
                        <div><strong>Delivery Note #:</strong> ${saleData.sale_id}</div>
                        <div><strong>Date:</strong> ${saleData.date}</div>
                        <div><strong>Ref. Invoice #:</strong> ${saleData.sale_id}</div>
                    </div>
                    <div class="bill-to">
                        <strong>DELIVER TO:</strong><br>
                        <strong>${saleData.customer.customer_name || 'N/A'}</strong><br>
                        ${saleData.customer.contact_person ? `Attn: ${saleData.customer.contact_person}<br>` : ''}
                        ${saleData.customer.address || ''}<br>
                        ${saleData.customer.phone ? `Phone: ${saleData.customer.phone}<br>` : ''}
                    </div>
                </div>

                <table>
                    <thead>
                        <tr>
                            <th>Item Name</th>
                            <th>Generic Name</th>
                            <th>Batch Number</th>
                            <th>Expiry</th>
                            <th class="text-center">Qty</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${saleData.items.map(item => `
                            <tr>
                                <td>${item.product_name}</td>
                                <td>${item.generic_name || '-'}</td>
                                <td>${cleanBatchDisplay(item.batch_number)}</td>
                                <td>${item.expiry || '-'}</td>
                                <td class="text-center">${item.qty} ${item.pack_size}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>

                <div class="payment-info" style="margin-top: 40px; border-top: 1px solid #e2e8f0; padding-top: 16px;">
                    <p style="margin-bottom: 32px;">Goods listed above dispatched in good condition. Please inspect item names, batch numbers and quantities on receipt.</p>
                    <div style="display: flex; justify-content: space-between; gap: 30px; font-size: 0.85rem;">
                        <div style="flex: 1; border-top: 1px solid #1e293b; padding-top: 6px;">
                            Dispatched By &nbsp;&nbsp; Name / Signature / Date
                        </div>
                        <div style="flex: 1; border-top: 1px solid #1e293b; padding-top: 6px;">
                            Received By &nbsp;&nbsp; Name / Signature / Date
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    // ============================================
    // 🔥 ADDED: backfill Generic Name / Expiry for older sales
    // ============================================
    // Sales saved before the Delivery Note feature don't have
    // generic_name/expiry on their stored items (only product_name,
    // batch_number, etc.) -- this fills those two fields in from the
    // product/batch tables directly, live, so reprinting an OLD invoice
    // still gets a correct Delivery Note. A brand-new sale's items
    // already carry both straight from getSaleData(), so this is a
    // no-op for the normal case.
    async function enrichItemsForDeliveryNote(items) {
        const productIds = [...new Set((items || []).map(i => i.product_id).filter(Boolean))];
        const batchIds = [...new Set((items || []).map(i => i.batch_id).filter(Boolean))];

        let genericByProduct = {};
        if (productIds.length > 0) {
            try {
                const { data: products } = await supabaseClient
                    .from('products').select('id, generic_name_id').in('id', productIds);
                const genericMap = await buildGenericNameMap(products || []);
                (products || []).forEach(p => { genericByProduct[p.id] = genericMap[p.generic_name_id] || ''; });
            } catch (e) {
                console.warn('Could not backfill generic names for print:', e);
            }
        }

        let expiryByBatch = {};
        if (batchIds.length > 0) {
            try {
                const { data: batches } = await supabaseClient
                    .from('batches').select('id, expiry_date').in('id', batchIds);
                (batches || []).forEach(b => {
                    expiryByBatch[b.id] = b.expiry_date ? new Date(b.expiry_date).toLocaleDateString() : '';
                });
            } catch (e) {
                console.warn('Could not backfill expiry dates for print:', e);
            }
        }

        return (items || []).map(item => ({
            ...item,
            generic_name: item.generic_name || genericByProduct[item.product_id] || '',
            expiry: item.expiry || expiryByBatch[item.batch_id] || ''
        }));
    }

    // ============================================
    // PRINT FUNCTION
    // ============================================
    // 🔥 CHANGED: accepts an optional saleData override, falling back to
    // currentSaleData as before -- currentSaleData only ever holds
    // whatever was JUST saved in this page session, so there was no way
    // to reprint an already-saved invoice or quotation found later via
    // Search (currentSaleData is empty again after a page reload, or
    // once a different sale is saved). printSavedSale() below fetches an
    // older sale by id and passes it straight through here.
    async function printSale(saleDataOverride) {
        const saleData = saleDataOverride || currentSaleData;
        if (!saleData) {
            alert('No sale data to print.');
            return;
        }

        // 🔥 ADDED: only await the backfill lookup when this sale's items
        // are actually missing generic_name/expiry (older, pre-Delivery-
        // Note sales) -- a brand-new sale already has both from
        // getSaleData(), so the normal path skips this fetch entirely and
        // window.open() below still fires synchronously within the
        // original click, same as before (some browsers block a popup
        // opened after an awaited gap outside a user gesture).
        const needsEnrichment = (saleData.items || []).some(i => !i.generic_name || !i.expiry);
        if (needsEnrichment) {
            saleData.items = await enrichItemsForDeliveryNote(saleData.items);
        }

        const isQuotation = saleData.status === 'QUOTATION';
        const title = isQuotation ? `Quotation - ${saleData.sale_id}` : `Invoice - ${saleData.sale_id}`;

        // 🔥 FIX: now prints BOTH a Customer copy and a Merchant copy in
        // one job, clearly labeled, separated by a page break -- was
        // previously only ever one copy with no distinction at all.
        const printContent = `<!DOCTYPE html>
        <html>
        <head>
            <title>${title}</title>
            <style>
                body { font-family: Arial, Helvetica, sans-serif; padding: 30px; max-width: 800px; margin: 0 auto; color: #1e293b; }
                .copy-page { page-break-after: always; }
                .copy-page:last-child { page-break-after: auto; }
                .copy-label { text-align: center; background: #0f172a; color: white; padding: 4px; font-weight: bold; letter-spacing: 0.1em; font-size: 0.8rem; margin-bottom: 16px; }

                /* 🔥 CHANGED: this whole invoice/quotation/delivery-note
                   print-out used to be themed in teal (#0f766e). On a
                   black-and-white printer, a colored fill like that gets
                   dithered to a muddy grey instead of printing as a clean
                   solid -- every accent below is now pure black (or the
                   existing near-black #0f172a already used for the copy
                   label), which a monochrome printer renders crisply with
                   no dithering at all. Nothing here depends on color to
                   convey meaning, so this is a pure look-and-feel change. */
                .doc-header { border-bottom: 3px solid #000000; padding-bottom: 14px; margin-bottom: 14px; }
                .company-block h1 { margin: 0; color: #000000; font-size: 1.4rem; letter-spacing: 0.02em; }
                .company-block p { margin: 3px 0 0; color: #64748b; font-size: 0.85rem; }

                .doc-title-row { margin-bottom: 16px; }
                .doc-title { font-size: 2rem; font-weight: 800; color: #000000; letter-spacing: 0.03em; }
                .quotation-badge { display: inline-block; background: #000000; color: white; padding: 3px 14px; border-radius: 10px; font-weight: bold; font-size: 0.8rem; margin-left: 12px; vertical-align: middle; }

                .info-row { display: flex; justify-content: space-between; gap: 20px; margin-bottom: 20px; }
                .info-box { background: #f1f5f9; border-radius: 6px; padding: 12px 16px; font-size: 0.85rem; line-height: 1.7; flex: 1; }
                .bill-to { text-align: right; font-size: 0.85rem; line-height: 1.6; flex: 1; }

                table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 0.85rem; }
                th { background: #000000; color: white; padding: 10px; text-align: left; font-weight: 600; }
                th.text-right { text-align: right; }
                th.text-center { text-align: center; }
                td { padding: 10px; border-bottom: 1px solid #e2e8f0; }
                tbody tr:nth-child(even) { background: #f8fafc; }
                .text-right { text-align: right; }
                .text-center { text-align: center; }

                .totals-box { max-width: 300px; margin-left: auto; margin-bottom: 24px; }
                .totals-row { display: flex; justify-content: space-between; padding: 6px 12px; font-size: 0.9rem; }
                .totals-row.grand { background: #000000; color: white; font-weight: bold; font-size: 1rem; border-radius: 4px; margin-top: 4px; }

                .payment-info { border-top: 1px solid #e2e8f0; padding-top: 16px; font-size: 0.85rem; color: #334155; }
                .payment-info strong { display: block; margin-bottom: 4px; color: #000000; }
                .payment-info p { margin: 0 0 12px; line-height: 1.6; }

                @media print { body { margin: 0; padding: 15px; } }
            </style>
        </head>
        <body>
            ${buildWholesaleCopyHTML(saleData, 'CUSTOMER')}
            ${!isQuotation ? buildWholesaleDeliveryNoteHTML(saleData, 'CUSTOMER') : ''}
            ${buildWholesaleCopyHTML(saleData, 'MERCHANT')}
            ${!isQuotation ? buildWholesaleDeliveryNoteHTML(saleData, 'MERCHANT') : ''}
        </body>
        </html>`;

        const printWindow = window.open('', '_blank', 'width=800,height=600');
        printWindow.document.write(printContent);
        printWindow.document.close();
        printWindow.print();
    }

    // ============================================
    // PRINT DIALOG
    // ============================================
    function showPrintDialog(saleData) {
        if (!printModal) return;

        printModal.style.display = 'flex';

        const yesBtn = document.getElementById('printYesBtn');
        const noBtn = document.getElementById('printNoBtn');
        
        const newYesBtn = yesBtn.cloneNode(true);
        const newNoBtn = noBtn.cloneNode(true);
        yesBtn.parentNode.replaceChild(newYesBtn, yesBtn);
        noBtn.parentNode.replaceChild(newNoBtn, noBtn);

        newYesBtn.onclick = function() {
            printModal.style.display = 'none';
            setTimeout(() => printSale(), 300);
        };

        newNoBtn.onclick = function() {
            printModal.style.display = 'none';
        };
    }

    // ============================================
    // SAVE TRANSACTION 
    // ============================================
    async function saveTransaction(status, prefix) {
        const saleData = getSaleData(status, prefix);
        if (!saleData) return;

        const isQuotation = (status === 'QUOTATION');

        // 🔥 ADDED: same fix as retail.js -- lock both buttons the
        // moment a save genuinely starts, preventing a double-click
        // during the accounting/stock work below from creating a
        // duplicate sale. Guaranteed to restore via finally.
        const activeBtn = isQuotation ? quoteBtn : saveBtn;
        const otherBtn = isQuotation ? saveBtn : quoteBtn;
        const activeLabel = activeBtn?.querySelector('.btn-label');
        const originalLabelText = activeLabel?.textContent;
        const activeIcon = activeBtn?.querySelector('i');
        const originalIconClass = activeIcon?.className;

        if (activeBtn) activeBtn.disabled = true;
        if (otherBtn) otherBtn.disabled = true;
        if (activeLabel) activeLabel.textContent = 'Saving...';
        if (activeIcon) activeIcon.className = 'fa-solid fa-spinner fa-spin';

        try {
            const customerTypeValue = saleData.customerType ? saleData.customerType.value : 'REGULAR';
            
            const dbRecord = {
                sale_id: saleData.sale_id,
                type: saleData.type,
                prefix: saleData.prefix,
                client_type: saleData.client_type,
                client_sub_type: customerTypeValue,
                customer_data: saleData.customer,
                // 🔥 ADDED: proper FK reference to wholesale_customers, same
                // as retail.js sets customer_id on its own sales rows.
                // Previously wholesale only stored the id inside the
                // customer_data JSON blob (still kept below for backward
                // compatibility with receivables.js's existing lookup).
                customer_id: saleData.customer?.id || null,
                items: saleData.items,
                payment: saleData.payment,
                subtotal: saleData.totals.subtotal,
                tax: saleData.totals.tax,
                grand_total: saleData.totals.grand_total,
                status: saleData.status,
                is_quotation: isQuotation,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            };

            console.log('Saving to database:', dbRecord);

            // 🔥 FIX: editing an existing wholesale invoice
            // (editingWholesaleDbId set by loadWholesaleForEdit()) must
            // UPDATE that row, never insert a new one -- see this
            // variable's declaration near the top of the file for the full
            // story (this used to always insert, silently duplicating the
            // sale on every edit). Before writing the row, undo exactly
            // what the ORIGINAL save did: restore the stock it deducted,
            // and remove its old sale_items and journal entries (matched
            // by reference, which carries the invoice's sale_id string,
            // e.g. "GWH-2026-...-COGS" for the COGS leg) -- then the rest
            // of this function re-applies stock deduction and accounting
            // entries fresh for the edited items, exactly as it already
            // does for a normal new sale. Mirrors retail.js's edit-save.
            if (editingWholesaleDbId) {
                const { data: oldItems, error: oldItemsError } = await supabaseClient
                    .from('sale_items')
                    .select('batch_id, quantity, pack_size')
                    .eq('sale_id', editingWholesaleDbId);

                if (oldItemsError) {
                    console.error('Error loading original sale items for edit:', oldItemsError);
                    alert('❌ Could not load the original invoice to edit it safely. Nothing was changed.\n' + oldItemsError.message);
                    return;
                }

                if (oldItems && oldItems.length > 0) {
                    const qtyToRestoreByBatch = new Map();
                    for (const item of oldItems) {
                        const packQty = parseInt(item.pack_size) || 1;
                        qtyToRestoreByBatch.set(item.batch_id, (qtyToRestoreByBatch.get(item.batch_id) || 0) + item.quantity * packQty);
                    }
                    const { data: batchesToRestore, error: batchFetchError } = await supabaseClient
                        .from('batches')
                        .select('id, total_qty')
                        .in('id', [...qtyToRestoreByBatch.keys()]);

                    if (batchFetchError) {
                        console.error('Error restoring stock before edit-save:', batchFetchError);
                    } else {
                        await Promise.all((batchesToRestore || []).map(b =>
                            supabaseClient.from('batches')
                                .update({ total_qty: b.total_qty + (qtyToRestoreByBatch.get(b.id) || 0) })
                                .eq('id', b.id)
                        ));
                    }
                }

                await supabaseClient.from('sale_items').delete().eq('sale_id', editingWholesaleDbId);

                const oldSaleIdString = saleData.sale_id; // unchanged across an edit -- same invoice number throughout
                const { data: oldJournals } = await supabaseClient
                    .from('journal_entries')
                    .select('id')
                    .in('reference', [oldSaleIdString, `${oldSaleIdString}-COGS`]);

                if (oldJournals && oldJournals.length > 0) {
                    const oldJournalIds = oldJournals.map(j => j.id);
                    await supabaseClient.from('journal_lines').delete().in('journal_entry_id', oldJournalIds);
                    await supabaseClient.from('journal_entries').delete().in('id', oldJournalIds);
                }
            }

            let savedData;
            try {
                if (editingWholesaleDbId) {
                    const { data, error } = await supabaseClient
                        .from('sales')
                        .update(dbRecord)
                        .eq('id', editingWholesaleDbId)
                        .select();

                    if (error) throw new Error(error.message);
                    if (!data || data.length === 0) {
                        alert('❌ Could not find the original invoice to update. Nothing was saved.');
                        return;
                    }
                    savedData = data;
                } else {
                    const { data, error } = await supabaseClient
                        .from('sales')
                        .insert([dbRecord])
                        .select();

                    if (error) {
                        // 🔥 ADDED: same duplicate sale_id retry as retail.js —
                        // regenerate the id and try once more instead of just
                        // failing the whole sale on a rare timestamp collision.
                        if (error.code === '23505' || error.message?.includes('duplicate key')) {
                            console.log('⚠️ Duplicate key error, regenerating sale_id...');

                            const timestamp = Date.now().toString().slice(-6);
                            const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
                            const newSaleId = `${prefix || 'GWH'}-${new Date().getFullYear()}-${timestamp}-${random}`;

                            document.getElementById('invoiceNumber').value = newSaleId;
                            const display = document.getElementById('saleIdDisplay');
                            if (display) display.textContent = `Invoice #: ${newSaleId}`;

                            dbRecord.sale_id = newSaleId;
                            saleData.sale_id = newSaleId;

                            const { data: retryData, error: retryError } = await supabaseClient
                                .from('sales')
                                .insert([dbRecord])
                                .select();

                            if (retryError) throw new Error('Failed to save (Retry): ' + retryError.message);
                            savedData = retryData;
                        } else {
                            throw new Error(error.message);
                        }
                    } else {
                        savedData = data;
                    }
                }
            } catch (dbError) {
                console.error('Database error:', dbError);
                alert('❌ Error saving transaction:\n' + dbError.message);
                return;
            }

            // ============================================
            // 🔥 ADDED: insert into sale_items table, matching retail.js.
            // Without this, per-item history for wholesale sales only ever
            // existed inside the sales.items JSON blob — any reporting or
            // feature that reads sale_items directly (as retail's does)
            // would see nothing for wholesale sales.
            // ============================================
            if (saleData.items && saleData.items.length > 0) {
                const saleItemsData = saleData.items.map(item => ({
                    sale_id: savedData[0].id,
                    product_id: item.product_id,
                    batch_id: item.batch_id,
                    quantity: item.qty,
                    unit_price: item.rate,
                    pack_size: item.pack_size,
                    tax_rate: item.tax_rate,
                    total: item.total,
                    cost_per_unit: item.cost_per_unit || 0
                }));

                const { error: itemError } = await supabaseClient
                    .from('sale_items')
                    .insert(saleItemsData);

                // 🔥 CRITICAL ROLLBACK: if sale_items fails, delete the main
                // sale record rather than leaving an orphaned/incomplete sale.
                if (itemError) {
                    console.error('❌ Failed to save sale items:', itemError);
                    await supabaseClient.from('sales').delete().eq('id', savedData[0].id);
                    alert('❌ Failed to save sale items. Transaction cancelled.\nError: ' + itemError.message);
                    return;
                } else {
                    console.log(`✅ Inserted ${saleItemsData.length} items into sale_items table.`);
                }
            }

            if (status === 'COMPLETED') {
                // 🔥 PERF FIX: same fix as retail.js -- this used to
                // fetch-then-update stock one batch at a time in a
                // sequential loop (2 round-trips per line item, one after
                // another), then only afterwards post the accounting
                // entries. Now: quantities are aggregated per batch_id
                // first (so a batch on more than one line is only
                // read/written once), all batches are fetched in a single
                // query, the updates fire together via Promise.all(), and
                // the whole stock step runs CONCURRENTLY with posting the
                // accounting entries below instead of waiting for it first
                // -- neither depends on the other's writes.
                const stockUpdatePromise = (async () => {
                    const qtyByBatch = new Map();
                    for (const item of saleData.items) {
                        const packSize = parseInt(item.pack_size) || 1;
                        const totalQtyToDeduct = item.qty * packSize;
                        qtyByBatch.set(item.batch_id, (qtyByBatch.get(item.batch_id) || 0) + totalQtyToDeduct);
                    }
                    const batchIds = [...qtyByBatch.keys()];
                    if (batchIds.length === 0) return;

                    const { data: batches, error: fetchError } = await supabaseClient
                        .from('batches')
                        .select('id, total_qty')
                        .in('id', batchIds);

                    if (fetchError) {
                        console.error('Stock fetch error:', fetchError);
                        return;
                    }

                    await Promise.all((batches || []).map(async (batchData) => {
                        const totalQtyToDeduct = qtyByBatch.get(batchData.id) || 0;
                        const newQty = batchData.total_qty - totalQtyToDeduct;
                        const { error: updateError } = await supabaseClient
                            .from('batches')
                            .update({ total_qty: newQty })
                            .eq('id', batchData.id);

                        if (updateError) {
                            console.error('Stock update error for batch:', batchData.id, updateError);
                        } else {
                            console.log(`Stock updated for batch ${batchData.id}: ${batchData.total_qty} -> ${newQty}`);
                        }
                    }));
                })();

                const accountingPromise = createWholesaleAccountingEntries(saleData, savedData)
                    .catch(accError => console.error('Accounting entry error:', accError));

                await Promise.all([stockUpdatePromise, accountingPromise]);

            } else {
                console.log('Quotation saved - stock not affected');
            }

            currentSaleData = saleData;

            // 🔥 ADDED: this save just went through as a genuinely NEW
            // invoice -- if it's the finalization of a quotation
            // conversion (convertQuotationToInvoice()), remove the
            // ORIGINAL quotation now. A quotation never deducts stock or
            // posts accounting entries, so there is nothing to reverse --
            // just its sale_items and sales rows. Guarded to only ever
            // run once per conversion (cleared immediately) and only for
            // a real insert, never an edit of an existing invoice.
            if (convertingFromQuotationId && !editingWholesaleDbId) {
                const quotationIdToRemove = convertingFromQuotationId;
                convertingFromQuotationId = null;
                try {
                    await supabaseClient.from('sale_items').delete().eq('sale_id', quotationIdToRemove);
                    await supabaseClient.from('sales').delete().eq('id', quotationIdToRemove);
                    console.log(`✅ Removed original quotation ${quotationIdToRemove} after conversion to invoice.`);
                } catch (cleanupError) {
                    console.warn('Could not remove the original quotation after conversion (the new invoice still saved fine):', cleanupError);
                }
            }

            if (status === 'COMPLETED') {
                showPrintDialog(saleData);
            } else {
                await new Promise(resolve => setTimeout(resolve, 500));
                printSale();
            }

            alert(`✅ ${status === 'QUOTATION' ? 'Quotation' : 'Sale'} saved successfully!\nID: ${saleData.sale_id}\nGrand Total: K${saleData.totals.grand_total.toFixed(2)}`);

            resetForm();

        } catch (error) {
            console.error('Error saving transaction:', error);
            alert('❌ Error saving transaction:\n' + error.message);
        } finally {
            if (activeBtn) activeBtn.disabled = false;
            if (otherBtn) otherBtn.disabled = false;
            if (activeLabel && originalLabelText) activeLabel.textContent = originalLabelText;
            if (activeIcon && originalIconClass) activeIcon.className = originalIconClass;
        }
    }

    function resetForm() {
        customerSelect.value = '';
        clearCustomerFields();
        resetPOSTable();
        generateNextSaleId();
        updateDateTime();
    }

    // ============================================
    // TOAST NOTIFICATION
    // ============================================
    function showToast(message, type = 'success') {
        const existing = document.querySelector('#customToast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.id = 'customToast';
        const bgColor = type === 'success' ? '#059669' : type === 'error' ? '#dc2626' : '#f59e0b';
        toast.style.cssText = `
            position: fixed; top: 20px; right: 20px; 
            padding: 16px 24px; border-radius: 8px; 
            color: white; font-weight: 500; z-index: 99999;
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
    // KEYBOARD SHORTCUTS
    // ============================================
    document.addEventListener('keydown', function(e) {
        if (e.ctrlKey && e.key === 's') {
            e.preventDefault();
            if (saveBtn) saveBtn.click();
        }
        if (e.ctrlKey && e.key === 'q') {
            e.preventDefault();
            if (quoteBtn) quoteBtn.click();
        }
        if (e.ctrlKey && e.key === 'r') {
            e.preventDefault();
            if (clearBtn) clearBtn.click();
        }
    });

    // ============================================
    // BUTTON EVENTS
    // ============================================
    // 🔥 CHANGED: this `prefix` argument is only stored as metadata on the
    // sale row (the actual invoice number was already set by
    // generateNextSaleId() using getWholesalePrefix()) -- reading it the
    // same way here keeps that stored metadata consistent with whichever
    // prefix (Regular vs Internal) the invoice number itself actually
    // used, instead of always recording the old single generic prefix.
    if (saveBtn) saveBtn.addEventListener('click', () => saveTransaction('COMPLETED', getWholesalePrefix(customerType ? customerType.value : '')));
    if (quoteBtn) quoteBtn.addEventListener('click', () => saveTransaction('QUOTATION', 'QWH'));

    // ============================================
    // 🔥 ADDED: SEARCH BUTTON & MODAL WIRING
    // ============================================
    const searchSalesBtn = document.getElementById('searchSalesBtn');
    const wholesaleSearchModal = document.getElementById('wholesaleSearchModal');
    const wholesaleCloseSearchModalBtn = document.getElementById('wholesaleCloseSearchModalBtn');
    const wholesaleSearchInput = document.getElementById('wholesaleSearchInput');
    const wholesaleSearchGoBtn = document.getElementById('wholesaleSearchGoBtn');

    if (searchSalesBtn && wholesaleSearchModal) {
        searchSalesBtn.addEventListener('click', () => {
            wholesaleSearchModal.style.display = 'flex';
            if (wholesaleSearchInput) {
                wholesaleSearchInput.value = '';
                wholesaleSearchInput.focus();
            }
            searchSalesRecords('');
        });
    }

    if (wholesaleCloseSearchModalBtn && wholesaleSearchModal) {
        wholesaleCloseSearchModalBtn.addEventListener('click', () => {
            wholesaleSearchModal.style.display = 'none';
        });
    }

    if (wholesaleSearchModal) {
        wholesaleSearchModal.addEventListener('click', (e) => {
            if (e.target === wholesaleSearchModal) wholesaleSearchModal.style.display = 'none';
        });
    }

    if (wholesaleSearchGoBtn) {
        wholesaleSearchGoBtn.addEventListener('click', () => {
            searchSalesRecords(wholesaleSearchInput?.value || '');
        });
    }

    if (wholesaleSearchInput) {
        wholesaleSearchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                searchSalesRecords(wholesaleSearchInput.value || '');
            }
        });
    }

    // ============================================
    // 🔥 ADDED: VIEW MODAL CLOSE HANDLERS
    // ============================================
    const wholesaleViewItemsModal = document.getElementById('wholesaleViewItemsModal');
    const wholesaleCloseViewModalBtn = document.getElementById('wholesaleCloseViewModalBtn');
    const wholesaleCloseViewBtn = document.getElementById('wholesaleCloseViewBtn');

    if (wholesaleCloseViewModalBtn && wholesaleViewItemsModal) {
        wholesaleCloseViewModalBtn.addEventListener('click', () => {
            wholesaleViewItemsModal.style.display = 'none';
        });
    }
    if (wholesaleCloseViewBtn && wholesaleViewItemsModal) {
        wholesaleCloseViewBtn.addEventListener('click', () => {
            wholesaleViewItemsModal.style.display = 'none';
        });
    }
    if (wholesaleViewItemsModal) {
        wholesaleViewItemsModal.addEventListener('click', (e) => {
            if (e.target === wholesaleViewItemsModal) wholesaleViewItemsModal.style.display = 'none';
        });
    }

    if (clearBtn) {
        clearBtn.addEventListener('click', function() {
            if (confirm('Are you sure you want to reset the entire sale?')) {
                resetForm();
            }
        });
    }

    // ============================================
    // EXPOSE GLOBALLY
    // ============================================
    window.loadWholesaleForEdit = loadWholesaleForEdit;
    window.showToast = showToast;

    // ============================================
    // INITIAL SETUP
    // ============================================
    addPOSRow();
    
    console.log("✅ Wholesale POS initialized successfully!");
})();
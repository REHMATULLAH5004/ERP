// ============================================
// RETAIL POS LOGIC - WITH ACCOUNTING INTEGRATION (CLEANED)
// ============================================

(async function initRetailPos() {
    console.log("Retail POS initializing...");

    // 🔥 FIX (v2): guard against wiring up listeners twice on the SAME DOM
    // node — e.g. this script tag getting injected/run twice back-to-back
    // without the DOM changing in between. This is scoped to the actual
    // #retailPosContainer element (via a data attribute), NOT to `window`.
    // A window-level flag is wrong here: if your app re-injects retail.html
    // (fresh DOM) every time the POS screen is opened, a window-level flag
    // stays `true` forever after the first visit and silently blocks EVERY
    // later init — the screen renders but nothing responds, because no
    // listeners ever get attached to the new DOM. Scoping to the element
    // itself means a genuinely fresh container (new DOM node) always gets
    // initialized, while a true double-run on the same still-in-page
    // container gets skipped.
    const __posContainer = document.getElementById('retailPosContainer');
    if (__posContainer) {
        if (__posContainer.dataset.posInitialized === 'true') {
            console.warn("⚠️ Retail POS already initialized for this container — skipping duplicate init.");
            return;
        }
        __posContainer.dataset.posInitialized = 'true';
    }

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    // ============================================
    // DOM REFERENCES
    // ============================================
    const posTableBody = document.getElementById('retailPosTableBody');
    const clientBtns = document.querySelectorAll('.retail-client-btn');
    const nhimaFields = document.getElementById('retailNhimaFields');
    const regularFields = document.getElementById('retailRegularFields');
    const paymentSelect = document.getElementById('retailPaymentType');
    const nhimaSelect = document.getElementById('retailNhimaNumber');
    const phoneSelect = document.getElementById('retailRegPhone');
    const paymentType = document.getElementById('retailPaymentType');
    const paymentNoteBox = document.getElementById('retailPaymentNoteBox');
    const addNhimaBtn = document.getElementById('addNhimaBtn');
    const addPhoneBtn = document.getElementById('addPhoneBtn');
    const saveBtn = document.getElementById('saveTransactionBtn');
    const quoteBtn = document.getElementById('makeQuotationBtn');
    const clearBtn = document.getElementById('clearSaleBtn');
    const invoiceNumber = document.getElementById('invoiceNumber');
    const invoiceDateTime = document.getElementById('invoiceDateTime');

    const toggleHistoryBtn = document.getElementById('toggleHistoryBtn');
    const toggleSidebarBtn = document.getElementById('toggleSidebarBtn');
    const historyToggleIcon = document.getElementById('historyToggleIcon');
    const clientHistoryContainer = document.getElementById('clientHistoryContainer');
    const viewAllHistoryBtn = document.getElementById('viewAllHistoryBtn');
    const historyBadge = document.getElementById('historyBadge');
    const closeHistoryBtn = document.getElementById('closeHistoryBtn');

    // 🔥 FIX: these point at elements that are injected further down (Add Contact
    // modal, View Items modal, Print modal). They are declared with `let` here and
    // re-queried right after the injection block below, once the elements actually
    // exist in the DOM. Previously these were `const` + queried too early, so they
    // stayed `null` forever and the Add Contact modal / View Items close buttons
    // silently did nothing (or threw).
    let modal, closeBtn, cancelBtn, modalTitle, modalFields, retailContactType, contactForm, retailSaveContactBtn;
    let retailPrintModal, viewModal;

    // ============================================
    // TOGGLE FUNCTIONS
    // ============================================
    let historyVisible = false;

    if (toggleHistoryBtn && clientHistoryContainer) {
        toggleHistoryBtn.addEventListener('click', function () {
            historyVisible = !historyVisible;
            clientHistoryContainer.style.display = historyVisible ? 'block' : 'none';
            if (historyToggleIcon) {
                historyToggleIcon.className = historyVisible ? 'fa-solid fa-chevron-up' : 'fa-solid fa-chevron-down';
            }
        });
    }

    if (closeHistoryBtn) {
        closeHistoryBtn.addEventListener('click', function () {
            if (toggleHistoryBtn) toggleHistoryBtn.click();
        });
    }

    if (toggleSidebarBtn) {
        // 🔥 FIX: previously looked up a `#appRoot` element that doesn't
        // exist anywhere in the page, so this button silently did
        // nothing. Toggles a class on <body> instead (see style.css),
        // which hides the sidebar and lets the workspace expand.
        toggleSidebarBtn.addEventListener('click', function () {
            document.body.classList.toggle('layout-fullscreen');
        });
    }

    // 🔥 FIX: `document` itself is never destroyed when the POS screen is
    // re-opened in an SPA — only #retailPosContainer's contents are. If we
    // attached this on every init it would stack (2nd visit = 2 handlers,
    // 3rd = 3, etc.), and it would also close over the *first* load's
    // `toggleHistoryBtn` — a node that no longer exists in the page after a
    // re-render. So: look the button up live (always current), and only
    // attach this listener the first time this script ever runs on the page.
    if (!window.__retailPosDocListenersAttached) {
        document.addEventListener('keydown', function (e) {
            if (e.ctrlKey && e.key === 'h') {
                e.preventDefault();
                const btn = document.getElementById('toggleHistoryBtn');
                if (btn) btn.click();
            }
        });
    }

    // ============================================
    // 🔥 ADDED: current user's role -- needed to gate the Delete button
    // in search results to Admin only. Fetched once and cached; runs in
    // the background so it doesn't block anything else from loading.
    // ============================================
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
    // INITIALIZE INVOICE
    // ============================================
    generateNextSaleId();
    updateDateTime();
    setInterval(updateDateTime, 60000);

    // ============================================
    // LOAD DROPDOWNS
    // ============================================
    // 🔥 FIX: this is the actual root cause of "opens but nothing responds."
    // Everything below this point in the file — client type buttons, the
    // NHIMA/phone dropdown change handlers, Add NHIMA/Add Phone buttons, the
    // contact form, EVERY listener on the item table (select item, select
    // batch, quantity), Save/Quote/Reset, and even the code that injects the
    // three modals into the page — is written further down in this same
    // sequential async function. Awaiting these three calls here means NONE
    // of that setup can run until all three finish. If any of them is slow,
    // stalls, or never settles (e.g. supabaseClient not fully ready yet,
    // a network hiccup, an RLS policy silently hanging a query), the whole
    // screen stays completely dead — it looks rendered but nothing you
    // click, type into, or select does anything, on every single visit.
    //
    // Fix: fire these off WITHOUT awaiting them here, so the rest of this
    // function (all the listener/modal wiring) runs immediately regardless
    // of how long — or whether — these finish. The dropdowns themselves
    // just populate a little after the page becomes interactive instead of
    // gating interactivity on them.
    Promise.all([
        loadProductDropdowns(),
        loadNhimaDropdown(),
        loadPhoneDropdown()
    ]).catch(e => console.warn("Could not load dropdowns initially:", e));

    // ============================================
    // INJECT TOAST STYLES (if not exists)
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
    // INJECT MODALS & STYLES (Only if not exists)
    // ============================================

    // 1. Add Contact Modal
    if (!document.getElementById('retailAddContactModal')) {
        const modalHTML = `
        <div id="retailAddContactModal" style="display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(15, 23, 42, 0.6); backdrop-filter: blur(4px); z-index: 1000; justify-content: center; align-items: center;">
            <div class="modal-content-box" style="background: white; padding: 30px; border-radius: 12px; width: 90%; max-width: 500px; box-shadow: 0 20px 50px rgba(0,0,0,0.5);">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; border-bottom: 1px solid #e2e8f0; padding-bottom: 15px;">
                    <h3 id="retailAddModalTitle" style="margin: 0;"><i class="fa-solid fa-user-plus" style="color: #2563eb;"></i> Add New Contact</h3>
                    <button id="retailCloseModalBtn" type="button" style="background: none; border: none; font-size: 1.5rem; cursor: pointer; color: #64748b;">&times;</button>
                </div>
                <form id="retailAddContactForm">
                    <input type="hidden" id="retailContactType" value="">
                    <div id="retailModalDynamicFields"></div>
                    <div style="margin-top: 20px; display: flex; gap: 10px; justify-content: flex-end; border-top: 1px solid #e2e8f0; padding-top: 20px;">
                        <button type="button" id="retailCancelModalBtn" style="background: white; border: 1px solid #e2e8f0; padding: 10px 25px; border-radius: 6px; cursor: pointer;">Cancel</button>
                        <button type="submit" id="retailSaveContactBtn" style="background: #2563eb; color: white; border: none; padding: 10px 25px; border-radius: 6px; cursor: pointer;">
                            <i class="fa-solid fa-floppy-disk"></i> Save
                        </button>
                    </div>
                </form>
            </div>
        </div>
        `;
        document.body.insertAdjacentHTML('beforeend', modalHTML);
    }

    // 2. View Items Modal
    if (!document.getElementById('retailViewItemsModal')) {
        const viewItemsHTML = `
        <div id="retailViewItemsModal" style="display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(15, 23, 42, 0.6); backdrop-filter: blur(4px); z-index: 1000; justify-content: center; align-items: center;">
            <div class="modal-content-box" style="background: white; padding: 30px; border-radius: 12px; width: 90%; max-width: 900px; max-height: 90vh; overflow-y: auto; box-shadow: 0 20px 50px rgba(0,0,0,0.5);">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; border-bottom: 1px solid #e2e8f0; padding-bottom: 15px;">
                    <h3 id="retailViewModalTitle" style="margin: 0;"><i class="fa-solid fa-list" style="color: #2563eb;"></i> Invoice Items</h3>
                    <button id="retailCloseViewModalBtn" type="button" style="background: none; border: none; font-size: 1.5rem; cursor: pointer; color: #64748b;">&times;</button>
                </div>
                <div id="retailViewItemsContent"></div>
                <div style="margin-top: 20px; display: flex; gap: 10px; justify-content: flex-end; border-top: 1px solid #e2e8f0; padding-top: 20px;">
                    <button id="retailPrintViewBtn" type="button" style="background: #2563eb; color: white; border: none; padding: 10px 25px; border-radius: 6px; cursor: pointer;">
                        <i class="fa-solid fa-print"></i> Print
                    </button>
                    <button id="retailPdfViewBtn" type="button" style="background: #dc2626; color: white; border: none; padding: 10px 25px; border-radius: 6px; cursor: pointer;">
                        <i class="fa-solid fa-file-pdf"></i> PDF
                    </button>
                    <button id="retailCloseViewBtn" type="button" style="background: #f1f5f9; border: 1px solid #e2e8f0; padding: 10px 25px; border-radius: 6px; cursor: pointer;">Close</button>
                </div>
            </div>
        </div>
        `;
        document.body.insertAdjacentHTML('beforeend', viewItemsHTML);
    }

    // 3. Print Confirmation Modal
    if (!document.getElementById('retailPrintModal')) {
        const printModalHTML = `
        <div id="retailPrintModal" style="display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(15, 23, 42, 0.6); backdrop-filter: blur(4px); z-index: 1001; justify-content: center; align-items: center;">
            <div class="modal-content-box" style="background: white; padding: 30px; border-radius: 12px; width: 90%; max-width: 400px; box-shadow: 0 20px 50px rgba(0,0,0,0.5); text-align: center;">
                <div style="margin-bottom: 20px;">
                    <i class="fa-solid fa-print" style="font-size: 3rem; color: #2563eb;"></i>
                </div>
                <h3 style="margin: 0 0 10px 0; color: #0f172a;">Invoice Saved Successfully!</h3>
                <p style="color: #64748b; margin-bottom: 20px;">Would you like to print the invoice?</p>
                <div style="display: flex; gap: 10px; justify-content: center;">
                    <button id="retailPrintYesBtn" type="button" style="background: #2563eb; color: white; border: none; padding: 10px 30px; border-radius: 6px; cursor: pointer;">
                        <i class="fa-solid fa-print"></i> Yes, Print
                    </button>
                    <button id="retailPrintNoBtn" type="button" style="background: #f1f5f9; border: 1px solid #e2e8f0; padding: 10px 30px; border-radius: 6px; cursor: pointer;">No</button>
                </div>
            </div>
        </div>
        `;
        document.body.insertAdjacentHTML('beforeend', printModalHTML);
    }

    // 4. Search Invoices/Quotations Modal
    if (!document.getElementById('retailSearchModal')) {
        const searchModalHTML = `
        <div id="retailSearchModal" style="display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(15, 23, 42, 0.6); backdrop-filter: blur(4px); z-index: 1000; justify-content: center; align-items: center;">
            <div class="modal-content-box" style="background: white; padding: 30px; border-radius: 12px; width: 90%; max-width: 700px; max-height: 85vh; overflow-y: auto; box-shadow: 0 20px 50px rgba(0,0,0,0.5);">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; border-bottom: 1px solid #e2e8f0; padding-bottom: 15px;">
                    <h3 style="margin: 0;"><i class="fa-solid fa-magnifying-glass" style="color: #2563eb;"></i> Search Invoices &amp; Quotations</h3>
                    <button id="retailCloseSearchModalBtn" type="button" style="background: none; border: none; font-size: 1.5rem; cursor: pointer; color: #64748b;">&times;</button>
                </div>
                <div style="display: flex; gap: 10px; margin-bottom: 20px;">
                    <input type="text" id="retailSearchInput" placeholder="Enter Invoice # (GRI-...) or Quotation # (QGR-...)" style="flex: 1; padding: 10px 14px; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 0.9rem;">
                    <button id="retailSearchGoBtn" type="button" style="background: #2563eb; color: white; border: none; padding: 10px 24px; border-radius: 6px; cursor: pointer;">
                        <i class="fa-solid fa-magnifying-glass"></i> Search
                    </button>
                </div>
                <div id="retailSearchResults">
                    <div style="text-align: center; padding: 30px; color: #94a3b8;">
                        <i class="fa-solid fa-receipt" style="font-size: 2rem; display: block; margin-bottom: 10px; opacity: 0.3;"></i>
                        Enter a number and click Search. Leave blank and search to see the most recent 20.
                    </div>
                </div>
            </div>
        </div>
        `;
        document.body.insertAdjacentHTML('beforeend', searchModalHTML);
    }

    // 🔥 FIX: now that the modals exist in the DOM, grab the real references.
    modal = document.getElementById('retailAddContactModal');
    closeBtn = document.getElementById('retailCloseModalBtn');
    cancelBtn = document.getElementById('retailCancelModalBtn');
    modalTitle = document.getElementById('retailAddModalTitle');
    modalFields = document.getElementById('retailModalDynamicFields');
    retailContactType = document.getElementById('retailContactType');
    contactForm = document.getElementById('retailAddContactForm');
    retailSaveContactBtn = document.getElementById('retailSaveContactBtn');
    retailPrintModal = document.getElementById('retailPrintModal');
    viewModal = document.getElementById('retailViewItemsModal');

    // 🔥 FIX: stop clicks anywhere inside a modal's content card from ever
    // bubbling up to `document`. This is the real fix for "click an input to
    // type and the modal disappears" — instead of trying to detect and
    // exclude inside-clicks at the document listener (fragile: breaks if
    // this script ever double-initializes, or if any inner element re-renders
    // and loses the .modal-content-box ancestor for a tick), we simply never
    // let those clicks leave the card in the first place. Attached once per
    // modal, right after the modal HTML exists in the DOM — survives the
    // dynamic innerHTML swaps in openNhimaModal/openPhoneModal because the
    // .modal-content-box element itself is never replaced, only its children.
    document.querySelectorAll('#retailAddContactModal .modal-content-box, #retailViewItemsModal .modal-content-box, #retailPrintModal .modal-content-box, #retailSearchModal .modal-content-box')
        .forEach(box => box.addEventListener('click', (e) => e.stopPropagation()));

    // ============================================
    // UNIVERSAL MODAL CLOSE HANDLERS (backdrop click closes the modal)
    // ============================================
    // 🔥 FIX: the modal elements (#retailAddContactModal etc.) are injected into
    // document.body ONCE (guarded above by `if (!document.getElementById(...))`)
    // and persist across container re-renders, so this listener genuinely
    // only needs to exist once too — attaching it on every init would stack
    // redundant handlers on every click, forever, for the life of the tab.
    if (!window.__retailPosDocListenersAttached) {
        let _modalCloseLock = false; // Prevents rapid open/close conflicts
        window.__retailPosSetModalCloseLock = (val) => { _modalCloseLock = val; };

        document.addEventListener('click', function (e) {
            function isModalVisible(modalElement) {
                if (!modalElement) return false;
                return modalElement.style.display !== 'none' && window.getComputedStyle(modalElement).display !== 'none';
            }

            // 🛑 CRITICAL: If a modal was just opened by a button, we skip the close logic for 200ms
            if (_modalCloseLock) return;

            // Clicks inside .modal-content-box never reach here now (stopped
            // above), so anything that does reach here for a visible modal is a
            // genuine backdrop click and it's safe to close on.
            const addModal = document.getElementById('retailAddContactModal');
            if (isModalVisible(addModal) && e.target.closest('#retailAddContactModal')) {
                addModal.style.display = 'none';
            }

            const viewModalEl = document.getElementById('retailViewItemsModal');
            if (isModalVisible(viewModalEl) && e.target.closest('#retailViewItemsModal')) {
                viewModalEl.style.display = 'none';
            }

            const printModalEl = document.getElementById('retailPrintModal');
            if (isModalVisible(printModalEl) && e.target.closest('#retailPrintModal')) {
                printModalEl.style.display = 'none';
            }

            const searchModalEl = document.getElementById('retailSearchModal');
            if (isModalVisible(searchModalEl) && e.target.closest('#retailSearchModal')) {
                searchModalEl.style.display = 'none';
            }
        });
    }

    // ============================================
    // TOAST NOTIFICATION SYSTEM
    // ============================================
    function showToast(message, type = 'success') {
        if (typeof window.showToast === 'function' && window.showToast !== showToast) {
            window.showToast(message, type);
            return;
        }
        showLocalToast(message, type);
    }

    function showLocalToast(message, type = 'success') {
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
    // 🔥 CHART OF ACCOUNTS - AUTO CREATE MISSING ACCOUNTS
    // ============================================

    const REQUIRED_ACCOUNTS = [
        { code: '1111', name: 'Cash in Hand (ZMW)', type: 'Asset', category: 'Current Asset', normal_balance: 'Debit' },
        { code: '1121', name: 'Bank - ZMW', type: 'Asset', category: 'Current Asset', normal_balance: 'Debit' },
        { code: '1200', name: 'Accounts Receivable', type: 'Asset', category: 'Current Asset', normal_balance: 'Debit' },
        { code: '1400', name: 'Inventory', type: 'Asset', category: 'Current Asset', normal_balance: 'Debit' },
        { code: '2100', name: 'Sales Tax Payable', type: 'Liability', category: 'Current Liability', normal_balance: 'Credit' },
        { code: '3000', name: 'Opening Balance Equity', type: 'Equity', category: 'Equity', normal_balance: 'Credit' },
        { code: '4001', name: 'Retail - NHIMA Sales', type: 'Revenue', category: 'Revenue', normal_balance: 'Credit' },
        { code: '4002', name: 'Retail - Regular Sales', type: 'Revenue', category: 'Revenue', normal_balance: 'Credit' },
        { code: '4003', name: 'Retail - Online Sales', type: 'Revenue', category: 'Revenue', normal_balance: 'Credit' },
        { code: '4004', name: 'Retail - Staff Sales', type: 'Revenue', category: 'Revenue', normal_balance: 'Credit' },
        { code: '5001', name: 'COGS - Retail', type: 'Expense', category: 'Cost of Goods Sold', normal_balance: 'Debit' },
        { code: '6900', name: 'Bad Debt Expense - NHIMA Rejected Claims', type: 'Expense', category: 'Operating Expense', normal_balance: 'Debit' }
    ];

    // 🔥 PERF FIX: this used to run on every single save -- and, because
    // createSaleAccountingEntries() called it directly AND
    // getAccountCodesFromChartOfAccounts() called it again right
    // afterwards, it actually ran TWICE per save. Each run checked every
    // required account ONE AT A TIME (a separate SELECT, and an INSERT if
    // missing, per account) -- up to REQUIRED_ACCOUNTS.length * 2
    // sequential round-trips just for this housekeeping step, before any
    // real accounting work even started. REQUIRED_ACCOUNTS is a fixed list
    // baked into this file -- it never changes while the page is open --
    // so once it's confirmed present there's no reason to check again this
    // session. Now: checked in a single query, missing ones (if any)
    // created in a single batch insert, and skipped entirely after the
    // first successful run.
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

    // ============================================
    // 🔥 GET ACCOUNT CODES - WITH AUTO-CREATE
    // ============================================

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

            console.log('✅ Account codes loaded:', accountMap);

            return {
                cash_zmw: accountMap['cash_in_hand_zmw'] || '1111',
                bank_zmw: accountMap['bank_zmw'] || '1121',
                accounts_receivable: accountMap['accounts_receivable'] || '1200',
                inventory: accountMap['inventory'] || '1400',
                sales_tax_payable: accountMap['sales_tax_payable'] || '2100',
                opening_balance_equity: accountMap['opening_balance_equity'] || '3000',
                retail_nhima_sales: accountMap['retail_nhima_sales'] || '4001',
                retail_regular_sales: accountMap['retail_regular_sales'] || '4002',
                retail_online_sales: accountMap['retail_online_sales'] || '4003',
                retail_staff_sales: accountMap['retail_staff_sales'] || '4004',
                cogs_retail: accountMap['cogs_retail'] || '5001',
                bad_debt_expense: accountMap['bad_debt_expense_nhima_rejected_claims'] || '6900'
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
                retail_nhima_sales: '4001',
                retail_regular_sales: '4002',
                retail_online_sales: '4003',
                retail_staff_sales: '4004',
                cogs_retail: '5001',
                bad_debt_expense: '6900'
            };
        }
    }

    // ============================================
    // 🔥 CUSTOMER EXISTENCE ENSURER
    // ============================================

    async function ensureCustomerExists(customerData, clientType) {
        try {
            let phone = customerData.phone;
            let fullName = customerData.full_name || 'Unknown Customer';
            let address = customerData.address || '';
            let nhimaNumber = customerData.nhima_number || null;
            let nrc = customerData.nrc || null;

            if (clientType === 'NHIMA' && nhimaNumber) {
                const { data: nhimaMember, error: nhimaError } = await supabaseClient
                    .from('nhima_members')
                    .select('phone, full_name, address, nrc')
                    .eq('nhima_number', nhimaNumber)
                    .maybeSingle();

                if (!nhimaError && nhimaMember) {
                    phone = phone || nhimaMember.phone || '';
                    fullName = fullName || nhimaMember.full_name || 'Unknown Customer';
                    address = address || nhimaMember.address || '';
                    nrc = nrc || nhimaMember.nrc || null;
                }
            }

            if (!phone || phone === '') {
                if (clientType === 'NHIMA' && nhimaNumber) {
                    phone = `NHIMA-${nhimaNumber}`;
                } else {
                    phone = `CUST-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
                }
                console.warn(`⚠️ No phone available, using placeholder: ${phone}`);
            }

            const { data: existingCustomer, error: findError } = await supabaseClient
                .from('customers')
                .select('id, phone, full_name, address, customer_type')
                .eq('phone', phone)
                .maybeSingle();

            if (!findError && existingCustomer) {
                return existingCustomer.id;
            }

            // 🔥 For NHIMA, also check by nhima_number
            if (clientType === 'NHIMA' && nhimaNumber) {
                const { data: nhimaCustomer, error: nhimaFindError } = await supabaseClient
                    .from('customers')
                    .select('id')
                    .eq('nhima_number', nhimaNumber)
                    .maybeSingle();

                if (!nhimaFindError && nhimaCustomer) {
                    return nhimaCustomer.id;
                }
            }

            // 🔥 FIX: removed `updated_at` here — your `customers` table
            // doesn't have that column (confirmed by the Supabase error:
            // "Could not find the 'updated_at' column of 'customers' in the
            // schema cache"). This was silently making every new-customer
            // insert fail with a 400, so ensureCustomerExists() fell back to
            // the slower "sync NHIMA members then retry" path every single
            // time instead of just creating the customer directly.
            const customerRecord = {
                full_name: fullName,
                phone: phone,
                address: address,
                customer_type: clientType || 'REGULAR',
                created_at: new Date().toISOString()
            };

            if (clientType === 'NHIMA' && nhimaNumber) {
                customerRecord.nhima_number = nhimaNumber;
                customerRecord.nrc = nrc || '';
            }

            const { data: newCustomer, error: insertError } = await supabaseClient
                .from('customers')
                .insert([customerRecord])
                .select();

            if (insertError) {
                console.error('Error creating customer:', insertError);
                if (insertError.code === '23505') {
                    const { data: retryCustomer } = await supabaseClient
                        .from('customers')
                        .select('id')
                        .eq('phone', phone)
                        .maybeSingle();

                    if (retryCustomer) {
                        return retryCustomer.id;
                    }
                }
                return null;
            }

            console.log(`✅ Customer created: ${fullName} (${phone})`);
            return newCustomer[0].id;

        } catch (error) {
            console.error('Error in ensureCustomerExists:', error);
            return null;
        }
    }

    async function syncNhimaMemberToCustomers() {
        try {
            const { data: nhimaMembers, error } = await supabaseClient
                .from('nhima_members')
                .select('*');

            if (error) throw error;

            let synced = 0;
            for (const member of nhimaMembers) {
                let customerExists = false;

                if (member.phone) {
                    const { data: existing } = await supabaseClient
                        .from('customers')
                        .select('id')
                        .eq('phone', member.phone)
                        .maybeSingle();

                    if (existing) {
                        await supabaseClient
                            .from('customers')
                            .update({
                                nhima_number: member.nhima_number,
                                nrc: member.nrc || '',
                                full_name: member.full_name
                            })
                            .eq('id', existing.id);
                        customerExists = true;
                    }
                }

                if (!customerExists && member.nhima_number) {
                    const { data: existing } = await supabaseClient
                        .from('customers')
                        .select('id')
                        .eq('nhima_number', member.nhima_number)
                        .maybeSingle();

                    if (existing) {
                        customerExists = true;
                    }
                }

                if (!customerExists) {
                    const phone = member.phone || `NHIMA-${member.nhima_number}`;
                    const { error: insertError } = await supabaseClient
                        .from('customers')
                        .insert([{
                            full_name: member.full_name || 'Unknown',
                            phone: phone,
                            address: member.address || '',
                            customer_type: 'NHIMA',
                            nhima_number: member.nhima_number,
                            nrc: member.nrc || '',
                            created_at: new Date().toISOString()
                        }]);

                    if (!insertError) {
                        synced++;
                    }
                }
            }

            if (synced > 0) {
                console.log(`✅ Synced ${synced} NHIMA members to customers table`);
            }

        } catch (error) {
            console.error('Error syncing NHIMA members:', error);
        }
    }

    // ============================================
    // 🔥 ACCOUNTING ENTRIES - PROPER RECEIVABLE FOR NHIMA
    // ============================================

    async function createSaleAccountingEntries(saleData, saleRecord) {
        try {
            await ensureChartOfAccounts();
            const accountCodes = await getAccountCodesFromChartOfAccounts();

            if (!accountCodes) {
                console.error('❌ Could not fetch account codes');
                return createSaleAccountingEntriesFallback(saleData, saleRecord);
            }

            const entryDate = new Date().toISOString().split('T')[0];
            const subType = saleData.client_sub_type;
            const paymentType = saleData.payment.type;
            const saleId = saleData.sale_id;

            const revenueMap = {
                'NHIMA': accountCodes.retail_nhima_sales,
                'STAFF': accountCodes.retail_staff_sales,
                'ONLINE': accountCodes.retail_online_sales,
                'REGULAR': accountCodes.retail_regular_sales
            };
            const revenueAccount = revenueMap[subType] || accountCodes.retail_regular_sales;

            let debitAccount = '';
            let debitDescription = '';

            // ✅ NHIMA is ALWAYS Credit (Accounts Receivable)
            if (subType === 'NHIMA') {
                debitAccount = accountCodes.accounts_receivable;
                debitDescription = `NHIMA Credit sale - ${saleId}`;
                console.log('💰 NHIMA sale: Using Accounts Receivable (Credit)');
            } else {
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
                    debitAccount = accountCodes.cash_zmw;
                    debitDescription = `${paymentType} payment - ${saleId}`;
                }
                console.log(`💰 ${subType} sale: Using ${debitAccount} for ${paymentType}`);
            }

            const totalAmount = saleData.totals.grand_total || 0;
            const taxAmount = saleData.totals.tax || 0;

            const cogsAmount = saleData.items.reduce((sum, item) => {
                const costPrice = item.cost_per_unit || 0;
                let packSize = 1;
                if (item.pack_size && item.pack_size !== 'EACH') {
                    const parsed = parseInt(item.pack_size);
                    if (!isNaN(parsed)) packSize = parsed;
                }
                return sum + (costPrice * item.qty * packSize);
            }, 0);

            console.log(`💰 COGS: ${cogsAmount}, Total: ${totalAmount}, Tax: ${taxAmount}`);

            const journalNumber = `SAL-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;

            const revenueJournal = {
                entry_date: entryDate,
                reference: saleId || 'SALE-' + Date.now(),
                description: `Retail ${subType} sale - ${saleId}`,
                journal_number: journalNumber,
                status: 'Posted',
                created_at: new Date().toISOString()
            };

            const { data: journal, error: journalError } = await supabaseClient
                .from('journal_entries')
                .insert([revenueJournal])
                .select();

            if (journalError) throw journalError;

            const journalId = journal[0].id;
            const lines = [];

            lines.push({
                journal_entry_id: journalId,
                account_code: debitAccount,
                description: debitDescription,
                debit: totalAmount,
                credit: 0
            });

            lines.push({
                journal_entry_id: journalId,
                account_code: revenueAccount,
                description: `Revenue from ${subType} sale - ${saleId}`,
                debit: 0,
                credit: totalAmount
            });

            if (taxAmount > 0) {
                lines.push({
                    journal_entry_id: journalId,
                    account_code: accountCodes.sales_tax_payable,
                    description: `VAT on ${subType} sale - ${saleId}`,
                    debit: 0,
                    credit: taxAmount
                });
            }

            if (lines.length > 0) {
                const { error: lineError } = await supabaseClient
                    .from('journal_lines')
                    .insert(lines);
                if (lineError) throw lineError;
            }

            console.log(`✅ Revenue journal ${journalNumber} created with ${lines.length} lines`);
            console.log(`   Debit: ${debitAccount} - ${debitDescription}`);
            console.log(`   Credit: ${revenueAccount} - Revenue (${totalAmount})`);
            if (taxAmount > 0) {
                console.log(`   Credit: ${accountCodes.sales_tax_payable} - VAT (${taxAmount})`);
            }

            if (cogsAmount > 0) {
                const cogsJournalNumber = `COG-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;

                const cogsJournal = {
                    entry_date: entryDate,
                    reference: `${saleId}-COGS`,
                    description: `COGS for ${subType} sale - ${saleId}`,
                    journal_number: cogsJournalNumber,
                    status: 'Posted',
                    created_at: new Date().toISOString()
                };

                const { data: cogsJournalData, error: cogsJournalError } = await supabaseClient
                    .from('journal_entries')
                    .insert([cogsJournal])
                    .select();

                if (cogsJournalError) throw cogsJournalError;

                const cogsJournalId = cogsJournalData[0].id;

                const cogsLines = [
                    {
                        journal_entry_id: cogsJournalId,
                        account_code: accountCodes.cogs_retail,
                        description: `COGS for ${subType} sale - ${saleId}`,
                        debit: cogsAmount,
                        credit: 0
                    },
                    {
                        journal_entry_id: cogsJournalId,
                        account_code: accountCodes.inventory,
                        description: `Inventory reduction from sale - ${saleId}`,
                        debit: 0,
                        credit: cogsAmount
                    }
                ];

                const { error: cogsLineError } = await supabaseClient
                    .from('journal_lines')
                    .insert(cogsLines);

                if (cogsLineError) throw cogsLineError;

                console.log(`✅ COGS journal ${cogsJournalNumber} created`);
                console.log(`   Debit: ${accountCodes.cogs_retail} - COGS (${cogsAmount})`);
                console.log(`   Credit: ${accountCodes.inventory} - Inventory (${cogsAmount})`);
            }

            console.log(`✅ All accounting entries created for ${saleId}`);

        } catch (error) {
            console.error('Error creating accounting entries:', error);
            console.warn('⚠️ Accounting entries failed but sale was saved successfully.');
            try {
                await createSaleAccountingEntriesFallback(saleData, saleRecord);
            } catch (fallbackError) {
                console.error('Fallback also failed:', fallbackError);
            }
        }
    }

    // ============================================
    // FALLBACK ACCOUNTING ENTRIES
    // ============================================

    async function createSaleAccountingEntriesFallback(saleData, saleRecord) {
        console.warn('⚠️ Using fallback hardcoded account codes');

        try {
            await ensureChartOfAccounts();

            const entryDate = new Date().toISOString().split('T')[0];
            const subType = saleData.client_sub_type;
            const paymentType = saleData.payment.type;
            const saleId = saleData.sale_id;

            let revenueAccount = '4002';
            if (subType === 'NHIMA') revenueAccount = '4001';
            else if (subType === 'STAFF') revenueAccount = '4004';
            else if (subType === 'ONLINE') revenueAccount = '4003';

            let debitAccount = '1111';
            let debitDescription = '';

            if (subType === 'NHIMA') {
                debitAccount = '1200';
                debitDescription = `NHIMA Credit sale - ${saleId}`;
            } else if (paymentType === 'Credit') {
                debitAccount = '1200';
                debitDescription = `Credit sale - ${saleId}`;
            } else if (paymentType === 'Cash') {
                debitAccount = '1111';
                debitDescription = `Cash payment - ${saleId}`;
            } else if (paymentType === 'Bank Transfer') {
                debitAccount = '1121';
                debitDescription = `Bank Transfer payment - ${saleId}`;
            } else {
                debitAccount = '1111';
                debitDescription = `${paymentType} payment - ${saleId}`;
            }

            const totalAmount = saleData.totals.grand_total || 0;
            const taxAmount = saleData.totals.tax || 0;

            const cogsAmount = saleData.items.reduce((sum, item) => {
                const costPrice = item.cost_per_unit || 0;
                let packSize = 1;
                if (item.pack_size && item.pack_size !== 'EACH') {
                    const parsed = parseInt(item.pack_size);
                    if (!isNaN(parsed)) packSize = parsed;
                }
                return sum + (costPrice * item.qty * packSize);
            }, 0);

            const journalNumber = `SAL-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;

            const revenueJournal = {
                entry_date: entryDate,
                reference: saleId || 'SALE-' + Date.now(),
                description: `Retail ${subType} sale - ${saleId}`,
                journal_number: journalNumber,
                status: 'Posted',
                created_at: new Date().toISOString()
            };

            const { data: journal, error: journalError } = await supabaseClient
                .from('journal_entries')
                .insert([revenueJournal])
                .select();

            if (journalError) throw journalError;

            const journalId = journal[0].id;
            const lines = [];

            lines.push({
                journal_entry_id: journalId,
                account_code: debitAccount,
                description: debitDescription,
                debit: totalAmount,
                credit: 0
            });
            lines.push({
                journal_entry_id: journalId,
                account_code: revenueAccount,
                description: `Revenue from ${subType} sale - ${saleId}`,
                debit: 0,
                credit: totalAmount
            });

            if (taxAmount > 0) {
                lines.push({
                    journal_entry_id: journalId,
                    account_code: '2100',
                    description: `VAT on ${subType} sale - ${saleId}`,
                    debit: 0,
                    credit: taxAmount
                });
            }

            await supabaseClient.from('journal_lines').insert(lines);

            if (cogsAmount > 0) {
                const cogsJournalNumber = `COG-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;

                const cogsJournal = {
                    entry_date: entryDate,
                    reference: `${saleId}-COGS`,
                    description: `COGS for ${subType} sale - ${saleId}`,
                    journal_number: cogsJournalNumber,
                    status: 'Posted',
                    created_at: new Date().toISOString()
                };

                const { data: cogsData, error: cogsError } = await supabaseClient
                    .from('journal_entries')
                    .insert([cogsJournal])
                    .select();

                if (cogsError) throw cogsError;

                await supabaseClient.from('journal_lines').insert([
                    {
                        journal_entry_id: cogsData[0].id,
                        account_code: '5001',
                        description: `COGS for ${subType} sale - ${saleId}`,
                        debit: cogsAmount,
                        credit: 0
                    },
                    {
                        journal_entry_id: cogsData[0].id,
                        account_code: '1400',
                        description: `Inventory reduction - ${saleId}`,
                        debit: 0,
                        credit: cogsAmount
                    }
                ]);
            }

            console.log(`✅ Fallback accounting entries created for ${saleId}`);

        } catch (error) {
            console.error('Fallback accounting failed:', error);
        }
    }

    // ============================================
    // CLIENT TYPE LOGIC
    // ============================================
    function resetCustomerFields() {
        const nhimaName = document.getElementById('retailCustomerName');
        const nrc = document.getElementById('retailNrc');
        const phone = document.getElementById('retailPhoneNumber');
        const address = document.getElementById('retailAddress');
        const nhimaNumber = document.getElementById('retailNhimaNumber');
        const claimNumber = document.getElementById('retailClaimNumber');

        if (nhimaName) nhimaName.value = '';
        if (nrc) nrc.value = '';
        if (phone) phone.value = '';
        if (address) address.value = '';
        if (nhimaNumber) nhimaNumber.value = '';
        if (claimNumber) claimNumber.value = '';

        const regName = document.getElementById('retailRegName');
        const regAddress = document.getElementById('retailRegAddress');
        const regPhone = document.getElementById('retailRegPhone');

        if (regName) regName.value = '';
        if (regAddress) regAddress.value = '';
        if (regPhone) regPhone.value = '';

        if (clientHistoryContainer) {
            clientHistoryContainer.style.display = 'none';
            historyVisible = false;
            if (historyToggleIcon) {
                historyToggleIcon.className = 'fa-solid fa-chevron-down';
            }
        }
        if (historyBadge) {
            historyBadge.style.display = 'none';
        }
    }

    function resetPOSTable() {
        const rows = posTableBody.querySelectorAll('tr');
        rows.forEach((row, index) => {
            if (index > 0) {
                row.remove();
            }
        });

        const firstRow = posTableBody.querySelector('tr:first-child');
        if (firstRow) {
            const itemSelect = firstRow.querySelector('.retail-pos-item');
            const batchSelect = firstRow.querySelector('.retail-pos-batch');
            const packInput = firstRow.querySelector('.retail-pos-pack-size');
            const taxInput = firstRow.querySelector('.retail-pos-tax');
            const rateInput = firstRow.querySelector('.retail-pos-rate');
            const qtyInput = firstRow.querySelector('.retail-pos-qty');
            const totalInput = firstRow.querySelector('.retail-pos-total');
            const daysInput = firstRow.querySelector('.retail-pos-days');
            const howToTakeInput = firstRow.querySelector('.retail-pos-how-to-take');

            if (itemSelect) itemSelect.value = '';
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
            if (daysInput) daysInput.value = '0';
            if (howToTakeInput) howToTakeInput.value = '';

            if (itemSelect) {
                loadProductDropdownsForRow(itemSelect);
            }
        }
        updateTotals();
    }

    let currentClientType = 'NHIMA';
    let currentSaleData = null;
    let lastSavedSaleData = null;

    if (clientBtns.length > 0) {
        clientBtns.forEach(btn => {
            btn.addEventListener('click', function () {
                clientBtns.forEach(b => {
                    b.style.background = 'transparent';
                    b.style.color = '#475569';
                });
                this.style.background = '#2563eb';
                this.style.color = 'white';

                const type = this.dataset.type;
                currentClientType = type;

                resetCustomerFields();
                resetPOSTable();

                if (type === 'NHIMA') {
                    if (nhimaFields) nhimaFields.style.display = 'block';
                    if (regularFields) regularFields.style.display = 'none';
                    if (paymentSelect) {
                        paymentSelect.value = 'Credit';
                        paymentSelect.disabled = true;
                    }
                } else {
                    if (nhimaFields) nhimaFields.style.display = 'none';
                    if (regularFields) regularFields.style.display = 'block';
                    if (paymentSelect) {
                        paymentSelect.value = 'Cash';
                        paymentSelect.disabled = false;
                    }
                }

                updateRowRates();
                updateTotals();
                generateNextSaleId();
            });
        });
    }

    // ============================================
    // PAYMENT TYPE LOGIC
    // ============================================
    if (paymentType && paymentNoteBox) {
        paymentType.addEventListener('change', function () {
            const val = this.value;
            if (val === 'Airtel Money' || val === 'Bank Transfer') {
                paymentNoteBox.style.display = 'block';
            } else {
                paymentNoteBox.style.display = 'none';
                const noteInput = document.getElementById('retailPaymentNote');
                if (noteInput) noteInput.value = '';
            }
        });
    }

    // ============================================
    // NHIMA DROPDOWN AUTO-POPULATE
    // ============================================
    if (nhimaSelect) {
        nhimaSelect.addEventListener('change', async function () {
            const nhimaNumber = this.value;
            if (!nhimaNumber) {
                document.getElementById('retailCustomerName').value = '';
                document.getElementById('retailNrc').value = '';
                document.getElementById('retailPhoneNumber').value = '';
                document.getElementById('retailAddress').value = '';
                if (historyBadge) historyBadge.style.display = 'none';
                if (clientHistoryContainer) {
                    clientHistoryContainer.style.display = 'none';
                    historyVisible = false;
                    if (historyToggleIcon) {
                        historyToggleIcon.className = 'fa-solid fa-chevron-down';
                    }
                }
                return;
            }

            try {
                const { data, error } = await supabaseClient
                    .from('nhima_members')
                    .select('full_name, nrc, phone, address')
                    .eq('nhima_number', nhimaNumber)
                    .maybeSingle();

                if (error) throw error;

                if (data) {
                    document.getElementById('retailCustomerName').value = data.full_name || '';
                    document.getElementById('retailNrc').value = data.nrc || '';
                    document.getElementById('retailPhoneNumber').value = data.phone || '';
                    document.getElementById('retailAddress').value = data.address || '';

                    await ensureCustomerExists({
                        nhima_number: nhimaNumber,
                        full_name: data.full_name || '',
                        phone: data.phone || '',
                        address: data.address || '',
                        nrc: data.nrc || ''
                    }, 'NHIMA');
                }

                await loadClientHistory();

            } catch (err) {
                console.error("Error fetching NHIMA details:", err);
            }
        });
    }

    // ============================================
    // PHONE DROPDOWN AUTO-POPULATE
    // ============================================
    if (phoneSelect) {
        phoneSelect.addEventListener('change', async function () {
            const phone = this.value;
            if (!phone) {
                document.getElementById('retailRegName').value = '';
                document.getElementById('retailRegAddress').value = '';
                if (historyBadge) historyBadge.style.display = 'none';
                if (clientHistoryContainer) {
                    clientHistoryContainer.style.display = 'none';
                    historyVisible = false;
                    if (historyToggleIcon) {
                        historyToggleIcon.className = 'fa-solid fa-chevron-down';
                    }
                }
                return;
            }

            try {
                const { data, error } = await supabaseClient
                    .from('customers')
                    .select('full_name, address')
                    .eq('phone', phone)
                    .maybeSingle();

                if (error) throw error;

                if (data) {
                    document.getElementById('retailRegName').value = data.full_name || '';
                    document.getElementById('retailRegAddress').value = data.address || '';
                }

                await loadClientHistory();

            } catch (err) {
                console.error("Error fetching customer details:", err);
            }
        });
    }

    // ============================================
    // ADD CONTACT MODAL FUNCTIONS
    // ============================================

    function openNhimaModal() {
        if (!modal) return;

        document.getElementById('retailContactType').value = 'NHIMA';
        document.getElementById('retailAddModalTitle').innerHTML = '<i class="fa-solid fa-user-plus" style="color: #2563eb;"></i> Add NHIMA Member';

        document.getElementById('retailModalDynamicFields').innerHTML = `
            <div style="margin-bottom: 12px;">
                <label style="display: block; font-weight: 500; color: #475569; margin-bottom: 3px; font-size: 0.85rem;">NHIMA Number *</label>
                <input type="text" id="retailNewNhimaNumber" required placeholder="e.g. 123456789" style="width: 100%; padding: 6px 10px; border: 1px solid #e2e8f0; border-radius: 4px; font-size: 0.9rem;">
            </div>
            <div style="margin-bottom: 12px;">
                <label style="display: block; font-weight: 500; color: #475569; margin-bottom: 3px; font-size: 0.85rem;">Full Name *</label>
                <input type="text" id="retailNewNhimaName" required placeholder="Enter full name" style="width: 100%; padding: 6px 10px; border: 1px solid #e2e8f0; border-radius: 4px; font-size: 0.9rem;">
            </div>
            <div style="margin-bottom: 12px;">
                <label style="display: block; font-weight: 500; color: #475569; margin-bottom: 3px; font-size: 0.85rem;">NRC Number</label>
                <input type="text" id="retailNewNhimaNrc" placeholder="e.g. 123456/78/9" style="width: 100%; padding: 6px 10px; border: 1px solid #e2e8f0; border-radius: 4px; font-size: 0.9rem;">
            </div>
            <div style="margin-bottom: 12px;">
                <label style="display: block; font-weight: 500; color: #475569; margin-bottom: 3px; font-size: 0.85rem;">Phone Number</label>
                <input type="text" id="retailNewNhimaPhone" placeholder="e.g. 0971234567" style="width: 100%; padding: 6px 10px; border: 1px solid #e2e8f0; border-radius: 4px; font-size: 0.9rem;">
            </div>
            <div style="margin-bottom: 12px;">
                <label style="display: block; font-weight: 500; color: #475569; margin-bottom: 3px; font-size: 0.85rem;">Address</label>
                <input type="text" id="retailNewNhimaAddress" placeholder="Enter address" style="width: 100%; padding: 6px 10px; border: 1px solid #e2e8f0; border-radius: 4px; font-size: 0.9rem;">
            </div>
        `;

        // 🔥 FIX: engage the close-lock so the universal "click outside
        // closes modal" handler ignores clicks for a moment right after
        // opening. Goes through window.__retailPosSetModalCloseLock rather
        // than a bare `_modalCloseLock` reference, because that variable
        // only exists in the scope of whichever init call first attached
        // the document click listener (see the `if (!window.__retailPosDocListenersAttached)`
        // block above) — on a second+ init, a direct reference here would
        // throw a ReferenceError and silently break the "Add NHIMA" button.
        if (window.__retailPosSetModalCloseLock) window.__retailPosSetModalCloseLock(true);
        requestAnimationFrame(() => {
            modal.style.display = 'flex';
            setTimeout(() => {
                if (window.__retailPosSetModalCloseLock) window.__retailPosSetModalCloseLock(false);
            }, 250);
        });
    }

    function openPhoneModal() {
        if (!modal) return;

        document.getElementById('retailContactType').value = 'PHONE';
        document.getElementById('retailAddModalTitle').innerHTML = '<i class="fa-solid fa-user-plus" style="color: #2563eb;"></i> Add Customer';

        document.getElementById('retailModalDynamicFields').innerHTML = `
            <div style="margin-bottom: 12px;">
                <label style="display: block; font-weight: 500; color: #475569; margin-bottom: 3px; font-size: 0.85rem;">Full Name *</label>
                <input type="text" id="retailNewPhoneName" required placeholder="Enter full name" style="width: 100%; padding: 6px 10px; border: 1px solid #e2e8f0; border-radius: 4px; font-size: 0.9rem;">
            </div>
            <div style="margin-bottom: 12px;">
                <label style="display: block; font-weight: 500; color: #475569; margin-bottom: 3px; font-size: 0.85rem;">Phone Number *</label>
                <input type="text" id="retailNewPhoneNumber" required placeholder="e.g. 0971234567" style="width: 100%; padding: 6px 10px; border: 1px solid #e2e8f0; border-radius: 4px; font-size: 0.9rem;">
            </div>
            <div style="margin-bottom: 12px;">
                <label style="display: block; font-weight: 500; color: #475569; margin-bottom: 3px; font-size: 0.85rem;">Address</label>
                <input type="text" id="retailNewPhoneAddress" placeholder="Enter address" style="width: 100%; padding: 6px 10px; border: 1px solid #e2e8f0; border-radius: 4px; font-size: 0.9rem;">
            </div>
        `;

        // 🔥 FIX: same lock as openNhimaModal — prevents the modal from
        // closing itself immediately after opening. See the comment in
        // openNhimaModal() above for why this goes through the global
        // setter instead of a direct `_modalCloseLock` reference.
        if (window.__retailPosSetModalCloseLock) window.__retailPosSetModalCloseLock(true);
        requestAnimationFrame(() => {
            modal.style.display = 'flex';
            setTimeout(() => {
                if (window.__retailPosSetModalCloseLock) window.__retailPosSetModalCloseLock(false);
            }, 250);
        });
    }

    // ============================================
    // ADD NHIMA BUTTON
    // ============================================
    if (addNhimaBtn) {
        addNhimaBtn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation(); // 🛑 STOPS the click from bubbling up to the document
            openNhimaModal();
        });
    }

    // ============================================
    // ADD PHONE BUTTON
    // ============================================
    if (addPhoneBtn) {
        addPhoneBtn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation(); // 🛑 STOPS the click from bubbling up to the document
            openPhoneModal();
        });
    }

    // ============================================
    // MODAL FORM SUBMISSION
    // ============================================
    if (contactForm) {
        contactForm.addEventListener('submit', async function (e) {
            e.preventDefault();

            const contactTypeValue = document.getElementById('retailContactType').value;

            if (contactTypeValue === 'NHIMA') {
                const nhimaNumber = document.getElementById('retailNewNhimaNumber')?.value.trim();
                const fullName = document.getElementById('retailNewNhimaName')?.value.trim();
                const nrc = document.getElementById('retailNewNhimaNrc')?.value.trim();
                const phone = document.getElementById('retailNewNhimaPhone')?.value.trim();
                const address = document.getElementById('retailNewNhimaAddress')?.value.trim();

                if (!nhimaNumber) {
                    alert('NHIMA Number is required');
                    return;
                }
                if (!fullName) {
                    alert('Full Name is required');
                    return;
                }

                retailSaveContactBtn.disabled = true;
                retailSaveContactBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';

                try {
                    const { data: existing, error: checkError } = await supabaseClient
                        .from('nhima_members')
                        .select('nhima_number')
                        .eq('nhima_number', nhimaNumber)
                        .maybeSingle();

                    if (checkError && checkError.code !== 'PGRST116') {
                        throw checkError;
                    }

                    if (existing) {
                        alert('NHIMA Number already exists. Please use a different number.');
                        retailSaveContactBtn.disabled = false;
                        retailSaveContactBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save';
                        return;
                    }

                    const { data, error } = await supabaseClient
                        .from('nhima_members')
                        .insert([{
                            nhima_number: nhimaNumber,
                            full_name: fullName,
                            nrc: nrc || '',
                            phone: phone || '',
                            address: address || ''
                        }])
                        .select();

                    if (error) throw error;

                    // 🔥 Also create customer entry for NHIMA member
                    if (data && data.length > 0) {
                        await ensureCustomerExists({
                            nhima_number: nhimaNumber,
                            full_name: fullName,
                            phone: phone || '',
                            address: address || '',
                            nrc: nrc || ''
                        }, 'NHIMA');
                    }

                    modal.style.display = 'none';
                    await loadNhimaDropdown();

                    if (data && data.length > 0) {
                        nhimaSelect.value = data[0].nhima_number;
                        nhimaSelect.dispatchEvent(new Event('change'));
                    }

                    alert('✅ NHIMA member added successfully!');

                } catch (error) {
                    console.error('Error saving NHIMA member:', error);
                    alert('❌ Error saving NHIMA member: ' + error.message);
                } finally {
                    retailSaveContactBtn.disabled = false;
                    retailSaveContactBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save';
                }

            } else if (contactTypeValue === 'PHONE') {
                const fullName = document.getElementById('retailNewPhoneName')?.value.trim();
                const phone = document.getElementById('retailNewPhoneNumber')?.value.trim();
                const address = document.getElementById('retailNewPhoneAddress')?.value.trim();

                if (!fullName) {
                    alert('Full Name is required');
                    return;
                }
                if (!phone) {
                    alert('Phone Number is required');
                    return;
                }

                retailSaveContactBtn.disabled = true;
                retailSaveContactBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';

                try {
                    const { data: existing, error: checkError } = await supabaseClient
                        .from('customers')
                        .select('phone')
                        .eq('phone', phone)
                        .maybeSingle();

                    if (checkError && checkError.code !== 'PGRST116') {
                        throw checkError;
                    }

                    if (existing) {
                        alert('Phone number already exists. Please use a different number.');
                        retailSaveContactBtn.disabled = false;
                        retailSaveContactBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save';
                        return;
                    }

                    const { data, error } = await supabaseClient
                        .from('customers')
                        .insert([{
                            full_name: fullName,
                            phone: phone,
                            address: address || '',
                            customer_type: currentClientType || 'REGULAR'
                        }])
                        .select();

                    if (error) throw error;

                    modal.style.display = 'none';
                    await loadPhoneDropdown();

                    if (data && data.length > 0) {
                        phoneSelect.value = data[0].phone;
                        phoneSelect.dispatchEvent(new Event('change'));
                    }

                    alert('✅ Customer added successfully!');

                } catch (error) {
                    console.error('Error saving customer:', error);
                    alert('❌ Error saving customer: ' + error.message);
                } finally {
                    retailSaveContactBtn.disabled = false;
                    retailSaveContactBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save';
                }
            }
        });
    }

    // ============================================
    // QUICK FILL FUNCTIONS
    // ============================================
    function quickFillItem(productId, batchId, qty, keepHistoryOpen = true) {
        if (!productId) {
            alert('Product not found');
            return;
        }

        const rows = posTableBody.querySelectorAll('tr');
        let targetRow = rows[rows.length - 1];

        const lastItemSelect = targetRow?.querySelector('.retail-pos-item');
        if (lastItemSelect && lastItemSelect.value) {
            addPOSRow();
            const newRows = posTableBody.querySelectorAll('tr');
            targetRow = newRows[newRows.length - 1];
        }

        if (!targetRow) return;

        const itemSelect = targetRow.querySelector('.retail-pos-item');
        if (itemSelect) {
            const option = Array.from(itemSelect.options).find(opt => opt.value === productId);
            if (option) {
                itemSelect.value = productId;
                itemSelect.dispatchEvent(new Event('change', { bubbles: true }));
            } else {
                loadProductDropdownsForRow(itemSelect).then(() => {
                    const option = Array.from(itemSelect.options).find(opt => opt.value === productId);
                    if (option) {
                        itemSelect.value = productId;
                        itemSelect.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                });
                return;
            }
        }

        setTimeout(() => {
            const qtyInput = targetRow.querySelector('.retail-pos-qty');
            if (qtyInput) {
                qtyInput.value = qty || 1;
                qtyInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }, 300);

        if (!keepHistoryOpen && toggleHistoryBtn) {
            toggleHistoryBtn.click();
        }

        targetRow.style.background = '#dbeafe';
        setTimeout(() => {
            targetRow.style.background = '';
        }, 2000);
    }

    async function addAllItemsFromSale(saleId) {
        try {
            const { data: sale, error } = await supabaseClient
                .from('sales')
                .select('*')
                .eq('id', saleId)
                .maybeSingle();

            if (error) throw error;

            const items = sale.items || [];
            if (items.length === 0) {
                alert('No items in this sale.');
                return;
            }

            const hasItems = posTableBody.querySelectorAll('tr').length > 0;
            let confirmClear = true;

            if (hasItems) {
                const firstRow = posTableBody.querySelector('tr:first-child');
                const firstItem = firstRow?.querySelector('.retail-pos-item');
                if (firstItem && firstItem.value) {
                    confirmClear = confirm('Clear current items and add all from this sale?');
                }
            }

            if (!confirmClear) return;

            const rows = posTableBody.querySelectorAll('tr');
            rows.forEach((row, index) => {
                if (index > 0) row.remove();
            });

            const firstRow = posTableBody.querySelector('tr:first-child');
            if (firstRow) {
                const itemSelect = firstRow.querySelector('.retail-pos-item');
                const batchSelect = firstRow.querySelector('.retail-pos-batch');
                const packInput = firstRow.querySelector('.retail-pos-pack-size');
                const taxInput = firstRow.querySelector('.retail-pos-tax');
                const rateInput = firstRow.querySelector('.retail-pos-rate');
                const qtyInput = firstRow.querySelector('.retail-pos-qty');
                const totalInput = firstRow.querySelector('.retail-pos-total');
                const daysInput = firstRow.querySelector('.retail-pos-days');
                const howToTakeInput = firstRow.querySelector('.retail-pos-how-to-take');

                if (itemSelect) itemSelect.value = '';
                if (batchSelect) batchSelect.innerHTML = `<option value="">Select Batch</option>`;
                if (packInput) packInput.value = '';
                if (taxInput) taxInput.value = '';
                if (rateInput) rateInput.value = '';
                if (qtyInput) qtyInput.value = '1';
                if (totalInput) totalInput.value = '';
                if (daysInput) daysInput.value = '0';
                if (howToTakeInput) howToTakeInput.value = '';
            }

            // 🔥 Prefetch all dropdowns to avoid slow async delays
            const allProductIds = [...new Set(items.map(item => item.product_id))];
            const { data: allProducts, error: prodError } = await supabaseClient
                .from('products')
                .select('id, product_name, conversion_rate, tax_percent')
                .in('id', allProductIds);

            if (prodError) throw prodError;

            const allBatchIds = [...new Set(items.map(item => item.batch_id))];
            const { data: allBatches, error: batchError } = await supabaseClient
                .from('batches')
                .select('id, batch_number, expiry_date, total_qty, cost_price')
                .in('id', allBatchIds);

            if (batchError) throw batchError;

            const productMap = {};
            allProducts.forEach(p => productMap[p.id] = p);

            const batchMap = {};
            allBatches.forEach(b => batchMap[b.id] = b);

            items.forEach((item, index) => {
                if (index > 0) addPOSRow();

                const currentRows = posTableBody.querySelectorAll('tr');
                const targetRow = currentRows[currentRows.length - 1];
                if (!targetRow) return;

                const itemSelect = targetRow.querySelector('.retail-pos-item');
                const batchSelect = targetRow.querySelector('.retail-pos-batch');
                const qtyInput = targetRow.querySelector('.retail-pos-qty');
                const totalInput = targetRow.querySelector('.retail-pos-total');

                if (itemSelect && item.product_id) {
                    let opt = Array.from(itemSelect.options).find(o => o.value === item.product_id);
                    if (!opt && productMap[item.product_id]) {
                        const newOpt = document.createElement('option');
                        newOpt.value = item.product_id;
                        newOpt.textContent = productMap[item.product_id].product_name;
                        itemSelect.appendChild(newOpt);
                        opt = newOpt;
                    }
                    if (opt) itemSelect.value = item.product_id;
                }

                if (batchSelect && item.batch_id) {
                    const batch = batchMap[item.batch_id];
                    if (batch) {
                        const expiry = new Date(batch.expiry_date).toLocaleDateString();
                        batchSelect.innerHTML = `<option value="${batch.id}"
                            data-cost="${batch.cost_price}"
                            data-qty="${batch.total_qty}"
                            data-expiry="${expiry}">${batch.batch_number} (Exp: ${expiry})</option>`;
                        batchSelect.value = batch.id;

                        const rateInput = targetRow.querySelector('.retail-pos-rate');
                        if (rateInput) rateInput.value = item.rate.toFixed(2);

                        const packInput = targetRow.querySelector('.retail-pos-pack-size');
                        if (packInput) packInput.value = item.pack_size;

                        const taxInput = targetRow.querySelector('.retail-pos-tax');
                        if (taxInput) taxInput.value = item.tax_rate;

                        const daysInput = targetRow.querySelector('.retail-pos-days');
                        if (daysInput) daysInput.value = item.days_supplied || 0;

                        const howToTakeInput = targetRow.querySelector('.retail-pos-how-to-take');
                        if (howToTakeInput) howToTakeInput.value = item.how_to_take || '';
                    }
                }

                if (qtyInput) {
                    qtyInput.value = item.qty || 1;
                    qtyInput.max = item.available_qty || item.qty;
                }

                if (totalInput) totalInput.value = item.total.toFixed(2);
            });

            updateTotals();

            if (toggleHistoryBtn) toggleHistoryBtn.click();
            alert(`✅ Added ${items.length} items from ${sale.sale_id}`);

        } catch (error) {
            console.error('Error adding all items:', error);
            alert('Error adding items: ' + error.message);
        }
    }

    // ============================================
    // POS TABLE LOGIC
    // ============================================
    if (!posTableBody) {
        console.error("❌ retailPosTableBody not found!");
        return;
    }

    posTableBody.addEventListener('input', function (e) {
        if (e.target.classList.contains('retail-pos-qty')) {
            const row = e.target.closest('tr');
            const rows = posTableBody.querySelectorAll('tr');
            const qty = parseInt(e.target.value) || 0;

            const batchSelect = row.querySelector('.retail-pos-batch');
            const selectedBatch = batchSelect?.options[batchSelect.selectedIndex];
            if (selectedBatch && selectedBatch.value) {
                const availableQty = parseInt(selectedBatch.dataset.qty) || 0;
                if (qty > availableQty) {
                    showToast(`Only ${availableQty} units available in this batch`, 'warning');
                    e.target.value = availableQty;
                }
            }

            if (row === rows[rows.length - 1] && qty > 0) {
                addPOSRow();
            }
            updateRowTotal(row);
            updateTotals();
        }
    });

    // ============================================
    // PRODUCT AND BATCH SELECTION
    // ============================================
    posTableBody.addEventListener('change', async function (e) {
        if (e.target.classList.contains('retail-pos-item')) {
            const row = e.target.closest('tr');
            const productId = e.target.value;
            const batchSelect = row.querySelector('.retail-pos-batch');
            const packInput = row.querySelector('.retail-pos-pack-size');
            const taxInput = row.querySelector('.retail-pos-tax');
            const rateInput = row.querySelector('.retail-pos-rate');
            const qtyInput = row.querySelector('.retail-pos-qty');

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
                const { data: product, error: prodError } = await supabaseClient
                    .from('products')
                    .select('conversion_rate, tax_percent, nhima_price_fixed, retail_regular_percent, retail_online_percent, retail_staff_percent')
                    .eq('id', productId)
                    .maybeSingle();

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
                        showToast('No stock available for this product', 'warning');
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
                                data-nhima="${product.nhima_price_fixed || 0}"
                                data-pack="${product.conversion_rate || 1}"
                                data-regular="${product.retail_regular_percent || 0}"
                                data-online="${product.retail_online_percent || 0}"
                                data-staff="${product.retail_staff_percent || 0}"
                                data-tax="${product.tax_percent || 0}"
                                data-expiry="${expiry}"
                                data-qty="${b.total_qty}"
                                data-batch-number="${b.batch_number}">
                                ${b.batch_number} (Exp: ${expiry}) - ${stockLabel} @ K${costPrice.toFixed(2)}
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

        if (e.target.classList.contains('retail-pos-batch')) {
            const row = e.target.closest('tr');
            const qtyInput = row.querySelector('.retail-pos-qty');
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

    // Remove row handler
    posTableBody.addEventListener('click', function (e) {
        if (e.target.closest('.retail-remove-btn')) {
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
    // ADD POS ROW
    // ============================================
    function addPOSRow() {
        const template = document.querySelector('.retail-pos-row');
        if (!template) {
            console.error("❌ retail-pos-row template missing!");
            return;
        }

        const newRow = template.cloneNode(true);
        newRow.classList.remove('retail-pos-row');

        const itemSelect = newRow.querySelector('.retail-pos-item');
        const batchSelect = newRow.querySelector('.retail-pos-batch');
        const packInput = newRow.querySelector('.retail-pos-pack-size');
        const taxInput = newRow.querySelector('.retail-pos-tax');
        const rateInput = newRow.querySelector('.retail-pos-rate');
        const qtyInput = newRow.querySelector('.retail-pos-qty');
        const totalInput = newRow.querySelector('.retail-pos-total');
        const daysInput = newRow.querySelector('.retail-pos-days');
        const howToTakeInput = newRow.querySelector('.retail-pos-how-to-take');

        if (itemSelect) {
            itemSelect.value = '';
            loadProductDropdownsForRow(itemSelect);
        }
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
        if (daysInput) daysInput.value = '0';
        if (howToTakeInput) howToTakeInput.value = '';

        posTableBody.appendChild(newRow);
    }

    // ============================================
    // HELPER FUNCTIONS
    // ============================================
    async function loadProductDropdowns() {
        const selects = document.querySelectorAll('.retail-pos-item');
        try {
            const { data: products, error } = await supabaseClient
                .from('products')
                .select('id, product_name')
                .order('product_name');

            if (error) throw error;

            selects.forEach(select => {
                if (select) {
                    select.innerHTML = `<option value="">Select Item</option>`;
                    products.forEach(p => {
                        select.innerHTML += `<option value="${p.id}">${p.product_name}</option>`;
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
                .select('id, product_name')
                .order('product_name');

            if (error) throw error;

            select.innerHTML = `<option value="">Select Item</option>`;
            products.forEach(p => {
                select.innerHTML += `<option value="${p.id}">${p.product_name}</option>`;
            });
        } catch (e) {
            console.warn("Could not load products for row:", e);
        }
    }

    async function loadNhimaDropdown() {
        const select = document.getElementById('retailNhimaNumber');
        if (!select) return;
        try {
            const { data, error } = await supabaseClient
                .from('nhima_members')
                .select('nhima_number')
                .order('nhima_number');

            if (error) throw error;

            select.innerHTML = `<option value="">Select NHIMA</option>`;
            data.forEach(m => {
                select.innerHTML += `<option value="${m.nhima_number}">${m.nhima_number}</option>`;
            });
        } catch (e) {
            console.warn("Could not load NHIMA members:", e);
        }
    }

    async function loadPhoneDropdown() {
        const select = document.getElementById('retailRegPhone');
        if (!select) return;
        try {
            const { data, error } = await supabaseClient
                .from('customers')
                .select('phone')
                .order('phone');

            if (error) throw error;

            select.innerHTML = `<option value="">Select Phone</option>`;
            data.forEach(c => {
                select.innerHTML += `<option value="${c.phone}">${c.phone}</option>`;
            });
        } catch (e) {
            console.warn("Could not load customers:", e);
        }
    }

    function generateNextSaleId() {
        const display = document.getElementById('saleIdDisplay');
        const invoiceDisplay = document.getElementById('invoiceNumber');
        if (!display) return;

        const date = new Date();
        const year = date.getFullYear();
        const timestamp = Date.now().toString().slice(-6);
        const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
        const saleId = `GRI-${year}-${timestamp}-${random}`;

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

    // ============================================
    // UPDATE ROW FUNCTIONS
    // ============================================
    function updateRowRate(row) {
        if (!row) return;
        const batchSelect = row.querySelector('.retail-pos-batch');
        const rateInput = row.querySelector('.retail-pos-rate');
        const packInput = row.querySelector('.retail-pos-pack-size');

        if (!batchSelect || !rateInput || !packInput) return;

        const selected = batchSelect.options[batchSelect.selectedIndex];
        if (!selected || !selected.value) {
            rateInput.value = '';
            return;
        }

        const costPrice = parseFloat(selected.dataset.cost) || 0;
        const nhimaPrice = parseFloat(selected.dataset.nhima) || 0;
        const packSize = parseFloat(selected.dataset.pack) || 1;
        const regularPercent = parseFloat(selected.dataset.regular) || 0;
        const onlinePercent = parseFloat(selected.dataset.online) || 0;
        const staffPercent = parseFloat(selected.dataset.staff) || 0;

        let percent = 0;
        if (currentClientType === 'REGULAR') {
            percent = regularPercent;
        } else if (currentClientType === 'ONLINE') {
            percent = onlinePercent;
        } else if (currentClientType === 'STAFF') {
            percent = staffPercent;
        }

        if (currentClientType === 'NHIMA') {
            packInput.value = 'EACH';
            rateInput.value = nhimaPrice.toFixed(2);
        } else {
            packInput.value = packSize + 's';
            const saleRate = costPrice * packSize * (1 + (percent / 100));
            rateInput.value = saleRate.toFixed(2);
        }
    }

    function updateRowTotal(row) {
        if (!row) return;
        const rate = parseFloat(row.querySelector('.retail-pos-rate')?.value) || 0;
        const qty = parseInt(row.querySelector('.retail-pos-qty')?.value) || 0;
        const totalInput = row.querySelector('.retail-pos-total');
        if (totalInput) totalInput.value = (rate * qty).toFixed(2);
    }

    function updateTotals() {
        const rows = posTableBody.querySelectorAll('tr');
        let subtotal = 0;
        let totalTax = 0;

        rows.forEach(row => {
            const total = parseFloat(row.querySelector('.retail-pos-total')?.value) || 0;
            const taxRate = parseFloat(row.querySelector('.retail-pos-tax')?.value) || 0;

            if (taxRate > 0 && total > 0) {
                const taxAmount = total * (taxRate / (100 + taxRate));
                subtotal += total - taxAmount;
                totalTax += taxAmount;
            } else {
                subtotal += total;
            }
        });

        const grandTotal = subtotal + totalTax;

        document.getElementById('retailSubtotal').textContent = `K${subtotal.toFixed(2)}`;
        document.getElementById('retailTotalTax').textContent = `K${totalTax.toFixed(2)}`;
        document.getElementById('retailGrandTotal').textContent = `K${grandTotal.toFixed(2)}`;
    }

    function updateRowRates() {
        const rows = posTableBody.querySelectorAll('tr');
        rows.forEach(row => updateRowRate(row));
    }

    // ============================================
    // CLIENT HISTORY
    // ============================================
    async function loadClientHistory() {
        const container = document.getElementById('clientHistoryContent');
        if (!container) return;

        let clientIdentifier = null;
        let clientType = currentClientType;

        if (clientType === 'NHIMA') {
            const nhimaNumber = document.getElementById('retailNhimaNumber')?.value;
            if (!nhimaNumber) {
                container.innerHTML = `
                    <div style="text-align: center; padding: 20px 10px; color: #64748b; font-size: 0.9rem;">
                        <i class="fa-solid fa-user" style="font-size: 1.5rem; display: block; margin-bottom: 8px; opacity: 0.3;"></i>
                        <p>Select an NHIMA member</p>
                    </div>
                `;
                if (historyBadge) historyBadge.style.display = 'none';
                return;
            }
            clientIdentifier = nhimaNumber;
        } else {
            const phone = document.getElementById('retailRegPhone')?.value;
            if (!phone) {
                container.innerHTML = `
                    <div style="text-align: center; padding: 20px 10px; color: #64748b; font-size: 0.9rem;">
                        <i class="fa-solid fa-phone" style="font-size: 1.5rem; display: block; margin-bottom: 8px; opacity: 0.3;"></i>
                        <p>Select a phone number</p>
                    </div>
                `;
                if (historyBadge) historyBadge.style.display = 'none';
                return;
            }
            clientIdentifier = phone;
        }

        try {
            let query = supabaseClient
                .from('sales')
                .select('*')
                .order('created_at', { ascending: false })
                .limit(20);

            if (clientType === 'NHIMA') {
                query = query.filter('customer_data->>nhima_number', 'eq', clientIdentifier);
            } else {
                query = query.filter('customer_data->>phone', 'eq', clientIdentifier);
            }

            const { data: sales, error } = await query;

            if (error) throw error;

            if (!sales || sales.length === 0) {
                container.innerHTML = `
                    <div style="text-align: center; padding: 20px 10px; color: #64748b; font-size: 0.9rem;">
                        <i class="fa-solid fa-receipt" style="font-size: 1.5rem; display: block; margin-bottom: 8px; opacity: 0.3;"></i>
                        <p>No previous transactions</p>
                    </div>
                `;
                if (historyBadge) historyBadge.style.display = 'none';
                return;
            }

            if (historyBadge) historyBadge.style.display = 'inline';

            if (!historyVisible && clientHistoryContainer) {
                clientHistoryContainer.style.display = 'block';
                historyVisible = true;
                if (historyToggleIcon) {
                    historyToggleIcon.className = 'fa-solid fa-chevron-up';
                }
            }

            let html = '';

            sales.forEach((sale, saleIndex) => {
                const statusColor = (sale.status === 'COMPLETED' || sale.status === 'Paid') ? '#10b981' : '#f59e0b';
                const date = new Date(sale.created_at).toLocaleDateString();
                const time = new Date(sale.created_at).toLocaleTimeString();
                const items = sale.items || [];

                html += `
                    <div style="margin-top: ${saleIndex > 0 ? '12px' : '0'}; padding: 10px; background: #f8fafc; border-radius: 6px; border: 1px solid #e2e8f0;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                            <div>
                                <span style="font-weight: 600; font-size: 0.85rem;">${sale.sale_id}</span>
                                <span style="font-size: 0.7rem; color: #64748b; margin-left: 8px;">${date} ${time}</span>
                            </div>
                            <div style="display: flex; gap: 8px; align-items: center;">
                                <span style="background: ${statusColor}; color: white; padding: 1px 10px; border-radius: 10px; font-size: 0.65rem;">${sale.status}</span>
                                <span style="font-weight: 600; color: #0f172a; font-size: 0.85rem;">K${(sale.grand_total || 0).toFixed(2)}</span>
                                <button class="add-all-items" data-sale-id="${sale.id}" style="background: #10b981; color: white; border: none; padding: 2px 10px; border-radius: 4px; cursor: pointer; font-size: 0.65rem;">
                                    <i class="fa-solid fa-cart-plus"></i> Add All
                                </button>
                            </div>
                        </div>
                        <div style="display: flex; flex-wrap: wrap; gap: 6px;">
                `;

                items.forEach((item) => {
                    const qty = item.qty || 0;
                    const packSize = item.pack_size || 'EACH';
                    html += `
                        <div class="history-item" data-product-id="${item.product_id || ''}" data-batch-id="${item.batch_id || ''}" data-qty="${qty}" style="display: inline-flex; align-items: center; gap: 6px; background: white; padding: 4px 10px; border-radius: 4px; border: 1px solid #e2e8f0; cursor: pointer; transition: all 0.2s; font-size: 0.8rem;" onmouseover="this.style.borderColor='#2563eb'" onmouseout="this.style.borderColor='#e2e8f0'">
                            <span style="font-weight: 500;">${item.product_name || 'Unknown'}</span>
                            <span style="color: #64748b;">(${packSize} × ${qty})</span>
                            <button class="quick-fill-btn" style="background: #2563eb; color: white; border: none; padding: 1px 8px; border-radius: 3px; cursor: pointer; font-size: 0.65rem;">
                                <i class="fa-solid fa-plus"></i>
                            </button>
                        </div>
                    `;
                });

                html += `
                        </div>
                    </div>
                `;
            });

            container.innerHTML = html;

            container.querySelectorAll('.quick-fill-btn').forEach(btn => {
                btn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    const parent = this.closest('.history-item');
                    if (parent) {
                        const productId = parent.dataset.productId;
                        const batchId = parent.dataset.batchId;
                        const qty = parseInt(parent.dataset.qty) || 1;
                        quickFillItem(productId, batchId, qty, true);
                    }
                });
            });

            container.querySelectorAll('.history-item').forEach(item => {
                item.addEventListener('click', function (e) {
                    if (e.target.closest('.quick-fill-btn')) return;
                    const productId = this.dataset.productId;
                    const batchId = this.dataset.batchId;
                    const qty = parseInt(this.dataset.qty) || 1;
                    quickFillItem(productId, batchId, qty, true);
                });
            });

            container.querySelectorAll('.add-all-items').forEach(btn => {
                btn.addEventListener('click', async function (e) {
                    e.stopPropagation();
                    const saleId = this.dataset.saleId;
                    await addAllItemsFromSale(saleId);
                });
            });

        } catch (error) {
            console.error('Error loading client history:', error);
            container.innerHTML = `
                <div style="text-align: center; padding: 20px; color: #dc2626; font-size: 0.85rem;">
                    <i class="fa-solid fa-circle-exclamation"></i>
                    <p>Error loading history</p>
                </div>
            `;
        }
    }

    // ============================================
    // VIEW SALE DETAIL
    // ============================================
    async function viewSaleDetail(saleId) {
        try {
            const { data: sale, error } = await supabaseClient
                .from('sales')
                .select('*')
                .eq('id', saleId)
                .maybeSingle();

            if (error) throw error;

            const saleData = {
                sale_id: sale.sale_id,
                type: sale.type,
                prefix: sale.prefix,
                client_type: sale.client_type,
                customer: sale.customer_data || {},
                items: sale.items || [],
                payment: sale.payment || { type: 'Credit', note: '' },
                totals: {
                    subtotal: sale.subtotal || 0,
                    tax: sale.tax || 0,
                    grand_total: sale.grand_total || 0
                },
                date: new Date(sale.created_at).toLocaleString(),
                status: sale.status
            };

            showViewItemsModal(saleData);

        } catch (error) {
            console.error('Error viewing sale detail:', error);
            alert('Error loading sale details: ' + error.message);
        }
    }

    // ============================================
    // 🔥 ADDED: SEARCH INVOICES & QUOTATIONS
    // ============================================
    async function searchSalesRecords(query) {
        const resultsEl = document.getElementById('retailSearchResults');
        if (!resultsEl) return;

        resultsEl.innerHTML = `<div style="text-align:center; padding:30px; color:#94a3b8;"><i class="fa-solid fa-spinner fa-spin"></i> Searching...</div>`;

        try {
            let dbQuery = supabaseClient
                .from('sales')
                .select('id, sale_id, created_at, grand_total, status, is_quotation, customer_data, client_type')
                // 🔥 FIX: this used to search across ALL sale types --
                // Retail, Wholesale, Donation. Wholesale stores rate as a
                // pack-adjusted price, completely different from how
                // Retail's POS interprets it as per-unit -- loading a
                // Wholesale sale into the Retail form produced exactly
                // the "amount is per unit, not the real total" confusion.
                // This is Retail's own search, so it should only ever
                // return Retail sales.
                .eq('client_type', 'RETAIL')
                .order('created_at', { ascending: false })
                .limit(20);

            // Blank search shows the most recent 20; otherwise match the
            // invoice/quotation number (partial, case-insensitive).
            if (query && query.trim() !== '') {
                dbQuery = dbQuery.ilike('sale_id', `%${query.trim()}%`);
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
        const resultsEl = document.getElementById('retailSearchResults');
        if (!resultsEl) return;

        if (results.length === 0) {
            resultsEl.innerHTML = `<div style="text-align:center; padding:30px; color:#94a3b8;">No matching invoices or quotations found.</div>`;
            return;
        }

        const isAdmin = currentUserRole === 'Admin';

        resultsEl.innerHTML = results.map(r => {
            const isQuotation = r.is_quotation;
            const date = new Date(r.created_at).toLocaleDateString();
            const customerName = r.customer_data?.full_name || 'N/A';
            const typeLabel = isQuotation
                ? `<span style="background:#fef3c7; color:#92400e; padding:2px 10px; border-radius:10px; font-size:0.7rem; font-weight:600;">QUOTATION</span>`
                : `<span style="background:#dcfce7; color:#166534; padding:2px 10px; border-radius:10px; font-size:0.7rem; font-weight:600;">INVOICE</span>`;

            // Quotations: View + Convert to Invoice.
            // Real invoices: View + Edit, and Delete (Admin only).
            const actions = isQuotation ? `
                <button class="search-view-btn" data-id="${r.id}" style="background:#2563eb; color:white; border:none; padding:5px 12px; border-radius:4px; cursor:pointer; font-size:0.75rem;"><i class="fa-solid fa-eye"></i> View</button>
                <button class="search-convert-btn" data-id="${r.id}" style="background:#059669; color:white; border:none; padding:5px 12px; border-radius:4px; cursor:pointer; font-size:0.75rem;"><i class="fa-solid fa-arrow-right-arrow-left"></i> Convert to Invoice</button>
            ` : `
                <button class="search-view-btn" data-id="${r.id}" style="background:#2563eb; color:white; border:none; padding:5px 12px; border-radius:4px; cursor:pointer; font-size:0.75rem;"><i class="fa-solid fa-eye"></i> View</button>
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

        // Wire up the buttons just rendered.
        resultsEl.querySelectorAll('.search-view-btn').forEach(btn => {
            btn.addEventListener('click', () => viewSaleDetail(btn.dataset.id));
        });

        resultsEl.querySelectorAll('.search-edit-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                await loadSaleByIdForEdit(btn.dataset.id);
                document.getElementById('retailSearchModal').style.display = 'none';
            });
        });

        resultsEl.querySelectorAll('.search-convert-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                await convertQuotationToInvoice(btn.dataset.id);
                document.getElementById('retailSearchModal').style.display = 'none';
            });
        });

        resultsEl.querySelectorAll('.search-delete-btn').forEach(btn => {
            btn.addEventListener('click', () => deleteSaleRecord(btn.dataset.id, btn.dataset.saleNumber));
        });
    }

    // Shared by both Edit and Convert -- fetches a sale row and maps it
    // into the shape loadSaleForEdit() expects.
    async function fetchSaleDataById(id) {
        const { data: sale, error } = await supabaseClient
            .from('sales')
            .select('*')
            .eq('id', id)
            .maybeSingle();

        if (error) throw error;
        if (!sale) return null;

        return {
            sale_id: sale.sale_id,
            client_sub_type: sale.client_sub_type,
            customer_data: sale.customer_data || {},
            items: sale.items || [],
            payment: sale.payment || { type: 'Cash', note: '' },
        };
    }

    async function loadSaleByIdForEdit(id) {
        try {
            const saleData = await fetchSaleDataById(id);
            if (!saleData) {
                alert('Could not find that sale.');
                return;
            }
            await loadSaleForEdit(saleData);
        } catch (error) {
            console.error('Error loading sale for edit:', error);
            alert('Error loading sale: ' + error.message);
        }
    }

    // 🔥 ADDED: loads a quotation's items/customer into the POS form for
    // review, exactly like editing -- but gives it a FRESH invoice number
    // rather than reusing the quotation's QGR- number, since converting
    // means it becomes a genuinely new, separate invoice. The person still
    // has to review and click Save themselves to actually finalize it --
    // this only prepares the form, it never auto-saves.
    async function convertQuotationToInvoice(id) {
        try {
            const saleData = await fetchSaleDataById(id);
            if (!saleData) {
                alert('Could not find that quotation.');
                return;
            }

            await loadSaleForEdit(saleData);

            // Overwrite the loaded QGR- number with a fresh GRI- invoice
            // number -- loadSaleForEdit() sets the original quotation
            // number, which is correct for actual editing but wrong here.
            generateNextSaleId();

            alert('✅ Quotation loaded. Review the details, then click Save to finalize it as a real invoice.');
        } catch (error) {
            console.error('Error converting quotation:', error);
            alert('Error converting quotation: ' + error.message);
        }
    }

    // 🔥 ADDED: delete a sale record. Deliberately conservative for now --
    // removes the sale and its sale_items rows only. Does NOT touch stock
    // quantities or the accounting ledger (journal_entries/journal_lines),
    // since a completed sale that was ever counted in stock/accounting
    // reports shouldn't silently vanish from them without a clear decision
    // on how that reversal should work. Admin-only, checked twice: the
    // button itself is hidden from non-Admins in renderSearchResults(),
    // and the role is re-verified here before anything actually deletes,
    // so this can't be triggered just by knowing the button exists.
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
            searchSalesRecords(document.getElementById('retailSearchInput')?.value || '');
        } catch (error) {
            console.error('Error deleting sale:', error);
            alert('Error deleting sale: ' + error.message);
        }
    }

    // ============================================
    // GET SALE DATA (WITH STOCK VALIDATION)
    // ============================================
    async function getSaleData(status = 'COMPLETED', prefix = 'GRI') {
        const rows = posTableBody.querySelectorAll('tr');
        const items = [];
        let hasItems = false;
        let stockErrors = [];

        rows.forEach(row => {
            const itemSelect = row.querySelector('.retail-pos-item');
            const batchSelect = row.querySelector('.retail-pos-batch');
            const qtyInput = row.querySelector('.retail-pos-qty');
            const rateInput = row.querySelector('.retail-pos-rate');
            const packInput = row.querySelector('.retail-pos-pack-size');
            const taxInput = row.querySelector('.retail-pos-tax');
            const totalInput = row.querySelector('.retail-pos-total');
            const daysInput = row.querySelector('.retail-pos-days');
            // 🔥 FIX: this input exists in the HTML and the sticker
            // display already reads item.how_to_take -- but nothing ever
            // actually captured its value into the items array, so it
            // was always undefined and every sticker fell back to
            // "As directed" regardless of what was typed here.
            const howToTakeInput = row.querySelector('.retail-pos-how-to-take');

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

                    let costPerUnit = 0;
                    if (selectedBatch && selectedBatch.dataset && selectedBatch.dataset.cost) {
                        costPerUnit = parseFloat(selectedBatch.dataset.cost) || 0;
                    }

                    items.push({
                        product_id: itemSelect.value,
                        product_name: itemSelect.options[itemSelect.selectedIndex]?.text || '',
                        batch_id: batchSelect.value,
                        // 🔥 FIX: this used to store the ENTIRE dropdown
                        // display text (e.g. "LOM001 (Exp: 31/12/2026) -
                        // 50 units"), leaking live stock quantity into
                        // every saved sale and printed invoice. Now
                        // stores just the actual batch code.
                        batch_number: batchSelect.options[batchSelect.selectedIndex]?.dataset.batchNumber || '',
                        qty: qty,
                        rate: parseFloat(rateInput.value) || 0,
                        pack_size: packInput.value || 'EACH',
                        tax_rate: parseFloat(taxInput.value) || 0,
                        total: parseFloat(totalInput.value) || 0,
                        days_supplied: parseInt(daysInput.value) || 0,
                        how_to_take: howToTakeInput?.value || '',
                        cost_per_unit: costPerUnit,
                        available_qty: availableQty
                    });
                }
            }
        });

        if (stockErrors.length > 0) {
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

        let customerData = {};
        let clientSubType = '';

        if (currentClientType === 'NHIMA') {
            const nhimaNumber = document.getElementById('retailNhimaNumber')?.value;
            const claimNumber = document.getElementById('retailClaimNumber')?.value.trim();

            if (!nhimaNumber) {
                alert('Please select an NHIMA member.');
                return null;
            }
            if (!claimNumber) {
                alert('Please enter the Claim Number for this NHIMA sale.');
                return null;
            }

            // 🔥 ADDED: claim numbers must be unique. Confirmed via a
            // real data investigation that two sales sharing a claim
            // number causes payments recorded against one to silently
            // get applied to both in the receivables calculation --
            // this stops the duplicate at the source rather than only
            // patching the calculation that reads it later. Only checked
            // for real sales (status !== QUOTATION) -- a draft quotation
            // shouldn't be blocked by a claim number that might still
            // change before it's finalized.
            if (status !== 'QUOTATION') {
                // 🔥 FIX: .maybeSingle() throws an error if MORE than one
                // row matches -- confirmed this is exactly what happens
                // here, since the existing data already has two sales
                // sharing this claim number from the original bug. The
                // error-handling below used to only log that error and
                // let the save continue anyway (fail-open) -- confirmed
                // via live data that this let two more duplicates through
                // right after this check was first added. Now uses a
                // query that tolerates any number of existing matches,
                // and blocks the save on any error instead of assuming
                // it's fine to proceed (fail-closed).
                const { data: existingClaims, error: claimCheckError } = await supabaseClient
                    .from('sales')
                    .select('sale_id')
                    .eq('claim_number', claimNumber)
                    .neq('is_quotation', true)
                    .limit(1);

                if (claimCheckError) {
                    console.error('Error checking claim number uniqueness:', claimCheckError);
                    alert('Could not verify this Claim Number is unique. Please try again.');
                    return null;
                }
                if (existingClaims && existingClaims.length > 0) {
                    alert(`This Claim Number is already used on sale ${existingClaims[0].sale_id}. Each NHIMA claim number must be unique.`);
                    return null;
                }
            }

            customerData = {
                type: 'NHIMA',
                nhima_number: nhimaNumber,
                claim_number: claimNumber,
                full_name: document.getElementById('retailCustomerName')?.value || '',
                nrc: document.getElementById('retailNrc')?.value || '',
                phone: document.getElementById('retailPhoneNumber')?.value || '',
                address: document.getElementById('retailAddress')?.value || ''
            };
            clientSubType = 'NHIMA';
        } else {
            const phone = document.getElementById('retailRegPhone')?.value;
            if (!phone) {
                alert('Please select a phone number.');
                return null;
            }
            customerData = {
                type: currentClientType,
                phone: phone,
                full_name: document.getElementById('retailRegName')?.value || '',
                address: document.getElementById('retailRegAddress')?.value || ''
            };
            clientSubType = currentClientType;
        }

        const paymentType = document.getElementById('retailPaymentType')?.value || 'Cash';
        const paymentNote = document.getElementById('retailPaymentNote')?.value || '';

        const subtotal = parseFloat(document.getElementById('retailSubtotal')?.textContent?.replace('K', '') || '0');
        const tax = parseFloat(document.getElementById('retailTotalTax')?.textContent?.replace('K', '') || '0');
        const grandTotal = parseFloat(document.getElementById('retailGrandTotal')?.textContent?.replace('K', '') || '0');

        const saleData = {
            type: status,
            prefix: prefix,
            client_type: 'RETAIL',
            client_sub_type: clientSubType,
            customer: customerData,
            items: items,
            payment: {
                type: paymentType,
                note: paymentNote
            },
            totals: {
                subtotal: subtotal,
                tax: tax,
                grand_total: grandTotal
            },
            sale_id: document.getElementById('invoiceNumber')?.value || '',
            date: document.getElementById('invoiceDateTime')?.value || new Date().toLocaleString(),
            status: status,
            is_quotation: (status === 'QUOTATION')
        };

        return saleData;
    }

    // ============================================
    // SAVE TRANSACTION - WITH ACCOUNTING, CUSTOMER, AND sale_items SUPPORT
    // ============================================
    async function saveTransaction(status, prefix) {
        const saleData = await getSaleData(status, prefix);
        if (!saleData) return;

        if (currentClientType === 'NHIMA') {
            if (!saleData.customer.nhima_number) {
                alert('Please select an NHIMA member.');
                return;
            }
        } else {
            if (!saleData.customer.phone) {
                alert('Please select a phone number.');
                return;
            }
        }

        const isQuotation = (status === 'QUOTATION');

        // 🔥 ADDED: lock both buttons the moment a save genuinely starts,
        // not just visually -- the accounting work below (journal entries,
        // COGS entries, stock deduction) is several sequential awaited
        // database calls, which takes long enough that a second click
        // during that window would start an entirely separate save of
        // the same sale. Disabling here closes that window completely,
        // and the finally block below guarantees they're re-enabled
        // whether the save succeeds or fails -- never left stuck.
        const activeBtn = isQuotation ? quoteBtn : saveBtn;
        const otherBtn = isQuotation ? saveBtn : quoteBtn;
        const activeLabel = activeBtn?.querySelector('.btn-label');
        const originalLabelText = activeLabel?.textContent;

        if (activeBtn) activeBtn.disabled = true;
        if (otherBtn) otherBtn.disabled = true;
        if (activeLabel) activeLabel.textContent = 'Saving...';
        const activeIcon = activeBtn?.querySelector('i');
        const originalIconClass = activeIcon?.className;
        if (activeIcon) activeIcon.className = 'fa-solid fa-spinner fa-spin';

        try {
            let customerId = await ensureCustomerExists(saleData.customer, currentClientType);

            if (!customerId && currentClientType === 'NHIMA' && saleData.customer.nhima_number) {
                const { data: existingCustomer } = await supabaseClient
                    .from('customers')
                    .select('id')
                    .eq('nhima_number', saleData.customer.nhima_number)
                    .maybeSingle();

                if (existingCustomer) {
                    customerId = existingCustomer.id;
                    console.log(`✅ Found existing customer by NHIMA number: ${customerId}`);
                }
            }

            if (!customerId && !isQuotation) {
                console.error('❌ Failed to create/retrieve customer');
                if (currentClientType === 'NHIMA') {
                    await syncNhimaMemberToCustomers();
                    const retryCustomerId = await ensureCustomerExists(saleData.customer, currentClientType);
                    if (!retryCustomerId) {
                        alert('❌ Could not create customer record. Please try again.');
                        return;
                    }
                    customerId = retryCustomerId;
                } else {
                    alert('❌ Could not create customer record. Please ensure the customer exists.');
                    return;
                }
            }

            const dbRecord = {
                sale_id: saleData.sale_id,
                type: saleData.type,
                prefix: saleData.prefix,
                client_type: saleData.client_type,
                client_sub_type: saleData.client_sub_type,
                customer_data: saleData.customer,
                customer_id: customerId || null,
                claim_number: saleData.customer.claim_number || null,
                items: saleData.items,
                payment: saleData.payment,
                subtotal: saleData.totals.subtotal,
                tax: saleData.totals.tax,
                grand_total: saleData.totals.grand_total,

                // 🔥 NHIMA claims are stored as "Pending" — the sale itself is
                // operationally complete (stock deducted, invoice printed,
                // accounting entries posted below) but NHIMA hasn't actually
                // accepted/paid the claim yet. It only moves to Paid / Partial /
                // Rejected once the NHIMA settlement CSV is uploaded and
                // processed in the Receivables module. Quotations are left
                // untouched since they aren't real claims yet.
                status: (saleData.client_sub_type === 'NHIMA' && !isQuotation)
                    ? 'Pending'
                    : saleData.status,

                is_quotation: isQuotation,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            };

            console.log('💾 Saving sale with customer_id:', customerId);

            let savedData;
            try {
                const { data, error } = await supabaseClient
                    .from('sales')
                    .insert([dbRecord])
                    .select();

                if (error) {
                    if (error.code === '23505' || error.message?.includes('duplicate key')) {
                        console.log('⚠️ Duplicate key error, regenerating sale_id...');

                        const timestamp = Date.now().toString().slice(-6);
                        const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
                        const newSaleId = `${prefix || 'GRI'}-${new Date().getFullYear()}-${timestamp}-${random}`;

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
            } catch (dbError) {
                console.error('Database error:', dbError);
                alert('❌ Error saving transaction:\n' + dbError.message);
                return;
            }

            // ============================================
            // Insert into sale_items table
            // ============================================
            if (saleData.items && saleData.items.length > 0) {
                const saleItemsData = saleData.items.map(item => ({
                    sale_id: savedData[0].id, // Use the database UUID, not the string sale_id
                    product_id: item.product_id,
                    batch_id: item.batch_id,
                    quantity: item.qty,
                    unit_price: item.rate,
                    pack_size: item.pack_size,
                    tax_rate: item.tax_rate,
                    total: item.total,
                    days_supplied: item.days_supplied || 0,
                    cost_per_unit: item.cost_per_unit || 0
                }));

                const { error: itemError } = await supabaseClient
                    .from('sale_items')
                    .insert(saleItemsData);

                // 🔥 CRITICAL ROLLBACK: If sale_items fails, delete the main sale record
                if (itemError) {
                    console.error('❌ Failed to save sale items:', itemError);
                    await supabaseClient.from('sales').delete().eq('id', savedData[0].id);
                    alert('❌ Failed to save sale items. Transaction cancelled.\nError: ' + itemError.message);
                    return;
                } else {
                    console.log(`✅ Inserted ${saleItemsData.length} items into sale_items table.`);
                }
            }

            // Update stock for COMPLETED sales only
            // NOTE: `status` here is still the original function parameter
            // ('COMPLETED' for the Save button), NOT the dbRecord.status value
            // that was overridden to 'Pending' for NHIMA above — so stock
            // deduction and accounting entries still fire for NHIMA sales
            // exactly as before.
            if (status === 'COMPLETED' && !isQuotation) {
                // 🔥 PERF FIX: this used to fetch-then-update stock one
                // batch at a time inside a `for...of` loop -- 2 sequential
                // network round-trips PER LINE ITEM, one after another, all
                // before the sale even finished saving. A 10-item sale
                // meant waiting on 20 round-trips in a row. Now: (1) qty to
                // deduct is aggregated per batch_id first, so a batch that
                // appears on more than one line is only read/written once
                // for its combined total, (2) all batches are fetched in a
                // SINGLE query instead of one per item, (3) the updates are
                // fired together with Promise.all() instead of one-by-one,
                // and (4) this whole stock step now runs CONCURRENTLY with
                // posting the accounting entries below, instead of waiting
                // for it to finish first -- the two don't depend on each
                // other's writes.
                const stockUpdatePromise = (async () => {
                    const qtyByBatch = new Map();
                    for (const item of saleData.items) {
                        const totalQtyToDeduct = item.qty * (item.pack_size === 'EACH' ? 1 : parseInt(item.pack_size) || 1);
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

                const accountingPromise = createSaleAccountingEntries(saleData, savedData)
                    .catch(accError => console.error('Accounting entry error:', accError));

                await Promise.all([stockUpdatePromise, accountingPromise]);
            } else {
                console.log('Quotation saved - stock not affected');
            }

            currentSaleData = saleData;
            lastSavedSaleData = saleData;
            window.currentPrintData = saleData;

            // ============================================
            // CLEANUP & UI RESET
            // ============================================
            if (status === 'COMPLETED' && !isQuotation) {
                showPrintDialog(saleData);
            } else {
                await new Promise(resolve => setTimeout(resolve, 500));
                printSale();
            }

            resetCustomerFields();
            resetPOSTable();
            generateNextSaleId();
            updateDateTime();

        } catch (error) {
            console.error('Error saving transaction:', error);
            alert('❌ Error saving transaction:\n' + error.message);
        } finally {
            // 🔥 ADDED: guaranteed to run whether the save succeeded or
            // threw -- both buttons are always left usable again, never
            // stuck disabled from an error partway through.
            if (activeBtn) activeBtn.disabled = false;
            if (otherBtn) otherBtn.disabled = false;
            if (activeLabel && originalLabelText) activeLabel.textContent = originalLabelText;
            if (activeIcon && originalIconClass) activeIcon.className = originalIconClass;
        }
    }

    // ============================================
    // PRINT FUNCTIONS
    // ============================================
    function showPrintDialog(saleData) {
        const printModalEl = document.getElementById('retailPrintModal');
        if (!printModalEl) return;

        const titleEl = printModalEl.querySelector('h3');
        const messageEl = printModalEl.querySelector('p');

        // 🔥 ADDED: second confirmation step for stickers, shown only after
        // the invoice print dialog has been triggered -- reuses the same
        // modal with updated text rather than a separate one. Each "Yes"
        // click is its own genuine user gesture, so the sticker's
        // window.open() is never at risk of being treated as an
        // unrequested popup, and printing them as two separate steps
        // means each can be sent to a different printer if you have one
        // dedicated to labels.
        function showStickerPrompt() {
            if (saleData.is_quotation) return; // nothing to dispense for a quote

            if (titleEl) titleEl.textContent = 'Invoice Printed!';
            if (messageEl) messageEl.textContent = 'Would you like to print the medicine labels for this sale?';

            printModalEl.style.display = 'flex';

            const yesBtn2 = document.getElementById('retailPrintYesBtn');
            const noBtn2 = document.getElementById('retailPrintNoBtn');
            const newYesBtn2 = yesBtn2.cloneNode(true);
            const newNoBtn2 = noBtn2.cloneNode(true);
            yesBtn2.parentNode.replaceChild(newYesBtn2, yesBtn2);
            noBtn2.parentNode.replaceChild(newNoBtn2, noBtn2);

            newYesBtn2.onclick = function () {
                printModalEl.style.display = 'none';
                printStickers();
            };
            newNoBtn2.onclick = function () {
                printModalEl.style.display = 'none';
            };
        }

        if (titleEl) titleEl.textContent = 'Invoice Saved Successfully!';
        if (messageEl) messageEl.textContent = 'Would you like to print the invoice?';
        printModalEl.style.display = 'flex';

        const yesBtn = document.getElementById('retailPrintYesBtn');
        const noBtn = document.getElementById('retailPrintNoBtn');

        const newYesBtn = yesBtn.cloneNode(true);
        const newNoBtn = noBtn.cloneNode(true);
        yesBtn.parentNode.replaceChild(newYesBtn, yesBtn);
        noBtn.parentNode.replaceChild(newNoBtn, noBtn);

        newYesBtn.onclick = function () {
            printModalEl.style.display = 'none';
            printSale();
            setTimeout(showStickerPrompt, 300);
        };

        newNoBtn.onclick = function () {
            printModalEl.style.display = 'none';
            setTimeout(showStickerPrompt, 300);
        };
    }

    // 🔥 CLEANUP: printSale() and pdfSale() used to each carry their own copy of
    // this ~70-line invoice HTML string. Consolidated into one builder so both
    // stay in sync. Output is identical to before.
    // 🔥 ADDED: defensively strips any "- XX units" suffix that might
    // still be present on batch_number for sales saved BEFORE the fix
    // to how batch_number gets captured (see the items.push() code) --
    // that fix only prevents this going forward, it doesn't retroactively
    // clean already-saved sales.
    function cleanBatchDisplay(batchNumber) {
        if (!batchNumber) return '';
        return batchNumber.replace(/\s*-\s*(⚠️\s*)?\d+\s*units?(\s*\(Low Stock\))?\s*$/i, '').trim();
    }

    function buildInvoiceHTML(saleData) {
        // 🔥 FIX: this used to always say "Invoice #:" even for a
        // quotation, which made no sense on a document that isn't an
        // invoice yet. The underlying number was already correctly
        // different (QGR- prefix vs GRI-), only the label was wrong.
        const isQuotation = saleData.is_quotation;
        const docLabel = isQuotation ? 'Quotation' : 'Invoice';

        return `<!DOCTYPE html>
            <html>
            <head>
                <title>${docLabel} - ${saleData.sale_id}</title>
                <style>
                    body { font-family: 'Courier New', monospace; padding: 20px; max-width: 800px; margin: 0 auto; }
                    .header { text-align: center; border-bottom: 2px solid #333; padding-bottom: 10px; margin-bottom: 20px; }
                    .header h1 { margin: 0; color: #0f172a; font-size: 1.5rem; }
                    .header p { margin: 3px 0; color: #475569; font-size: 0.9rem; }
                    .doc-type-badge { display: inline-block; margin-top: 8px; padding: 3px 14px; border-radius: 12px; font-size: 0.8rem; font-weight: bold; ${isQuotation ? 'background:#fef3c7; color:#92400e;' : 'background:#dcfce7; color:#166534;'} }
                    .invoice-info { margin-bottom: 20px; padding: 10px; background: #f8fafc; border-radius: 4px; font-size: 0.9rem; }
                    .invoice-info div { display: inline-block; margin-right: 30px; }
                    .customer-info { margin-bottom: 20px; padding: 10px; background: #f8fafc; border-radius: 4px; font-size: 0.9rem; }
                    table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 0.85rem; }
                    th { background: #f1f5f9; padding: 8px; text-align: left; border-bottom: 2px solid #e2e8f0; }
                    td { padding: 8px; border-bottom: 1px solid #e2e8f0; }
                    .text-right { text-align: right; }
                    .text-center { text-align: center; }
                    .totals { text-align: right; margin-top: 20px; padding-top: 20px; border-top: 2px solid #e2e8f0; font-size: 0.9rem; }
                    .grand-total { font-size: 1.2rem; font-weight: bold; color: #0f172a; }
                    .footer { text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e2e8f0; color: #64748b; font-size: 0.8rem; }
                    @media print { body { margin: 0; padding: 10px; } }
                </style>
            </head>
            <body>
                <div class="header">
                    <h1>GRIFFINS MEDICALS LIMITED</h1>
                    <p>Plot 3534, Freedomway, Lusaka</p>
                    <p>Phone: +260 97 000 0000 | ZAMRA: ZAMRA-123456</p>
                    <div class="doc-type-badge">${isQuotation ? 'QUOTATION -- NOT A TAX INVOICE' : 'TAX INVOICE'}</div>
                </div>
                <div class="invoice-info">
                    <div><strong>${docLabel} #:</strong> ${saleData.sale_id}</div>
                    <div><strong>Date:</strong> ${saleData.date}</div>
                    ${!isQuotation ? `<div><strong>Payment:</strong> ${saleData.payment.type}</div>` : ''}
                </div>
                <div class="customer-info">
                    <strong>Customer Details</strong><br>
                    <strong>Name:</strong> ${saleData.customer.full_name || 'N/A'}<br>
                    <strong>Phone:</strong> ${saleData.customer.phone || 'N/A'}<br>
                    <strong>Address:</strong> ${saleData.customer.address || 'N/A'}<br>
                    ${saleData.customer.nhima_number ? `<strong>NHIMA #:</strong> ${saleData.customer.nhima_number}<br>` : ''}
                    ${saleData.customer.nrc ? `<strong>NRC:</strong> ${saleData.customer.nrc}` : ''}
                </div>
                <table>
                    <thead>
                        <tr>
                            <th>#</th>
                            <th>Item</th>
                            <th>Batch</th>
                            <th class="text-center">Pack</th>
                            <th class="text-right">Tax %</th>
                            <th class="text-right">Rate</th>
                            <th class="text-right">Qty</th>
                            <th class="text-right">Total</th>
                            <th class="text-center">Days</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${saleData.items.map((item, index) => `
                            <tr>
                                <td>${index + 1}</td>
                                <td>${item.product_name}</td>
                                <td>${cleanBatchDisplay(item.batch_number)}</td>
                                <td class="text-center">${item.pack_size}</td>
                                <td class="text-right">${item.tax_rate}%</td>
                                <td class="text-right">K${item.rate.toFixed(2)}</td>
                                <td class="text-right">${item.qty}</td>
                                <td class="text-right">K${item.total.toFixed(2)}</td>
                                <td class="text-center">${item.days_supplied || 0}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
                <div class="totals">
                    <p>Subtotal (Excl. Tax): <strong>K${saleData.totals.subtotal.toFixed(2)}</strong></p>
                    <p>Total Tax: <strong>K${saleData.totals.tax.toFixed(2)}</strong></p>
                    <p class="grand-total">Grand Total: <strong>K${saleData.totals.grand_total.toFixed(2)}</strong></p>
                </div>
                <div class="footer">
                    ${isQuotation
                        ? `<p>This is a quotation only and does not constitute a tax invoice.</p><p>Prices are valid at the time of issue and may change.</p>`
                        : `<p>Thank you for your business!</p><p>This is a computer-generated invoice.</p>`
                    }
                </div>
            </body>
            </html>
        `;
    }

    function buildStickerHTML(saleData) {
        return `<!DOCTYPE html>
            <html>
            <head>
                <title>Labels - ${saleData.sale_id}</title>
                <style>
                    @page { size: 60mm 40mm; margin: 2mm; }
                    body { font-family: Arial, sans-serif; margin: 0; }
                    .sticker {
                        width: 60mm; min-height: 40mm; padding: 3mm; box-sizing: border-box;
                        border: 1px dashed #94a3b8; page-break-after: always;
                        display: flex; flex-direction: column; justify-content: center;
                    }
                    .sticker:last-child { page-break-after: auto; }
                    .sticker .pharmacy { font-size: 7pt; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }
                    .sticker .item-name { font-size: 11pt; font-weight: bold; margin: 2mm 0 1mm 0; }
                    .sticker .how-to-take { font-size: 9pt; }
                    .sticker .qty { font-size: 8pt; color: #475569; margin-top: 1mm; }
                    @media print { .sticker { border: none; } }
                </style>
            </head>
            <body>
                ${saleData.items.map(item => `
                    <div class="sticker">
                        <div class="pharmacy">Griffins Medicals Limited</div>
                        <div class="item-name">${item.product_name}</div>
                        <div class="how-to-take">${item.how_to_take || 'As directed'}</div>
                        <div class="qty">Qty: ${item.qty} ${item.pack_size}</div>
                    </div>
                `).join('')}
            </body>
            </html>
        `;
    }

    function printSale() {
        const saleData = window.currentPrintData || currentSaleData;
        if (!saleData) {
            alert('No sale data to print.');
            return;
        }

        const printWindow = window.open('', '_blank', 'width=800,height=600');
        printWindow.document.write(buildInvoiceHTML(saleData));
        printWindow.document.close();
        printWindow.print();
    }

    // 🔥 ADDED: prints the sticker labels only -- called from its own
    // separate confirmation step after the invoice print, as its own
    // distinct user click.
    function printStickers() {
        const saleData = window.currentPrintData || currentSaleData;
        if (!saleData) return;

        const stickerWindow = window.open('', '_blank', 'width=400,height=500');
        stickerWindow.document.write(buildStickerHTML(saleData));
        stickerWindow.document.close();
        stickerWindow.print();
    }

    function pdfSale() {
        const saleData = window.currentPrintData || currentSaleData;
        if (!saleData) {
            alert('No sale data to generate PDF.');
            return;
        }

        const pdfWindow = window.open('', '_blank', 'width=800,height=600');
        pdfWindow.document.write(buildInvoiceHTML(saleData));
        pdfWindow.document.close();
        setTimeout(() => {
            pdfWindow.print();
        }, 500);
    }

    // ============================================
    // LOAD SALE FOR EDIT
    // ============================================
    async function loadSaleForEdit(saleData) {
        try {
            console.log('Loading sale for edit:', saleData);

            if (saleData.client_sub_type) {
                const clientType = saleData.client_sub_type;
                const btn = document.querySelector(`.retail-client-btn[data-type="${clientType}"]`);
                if (btn) {
                    btn.click();
                }
            }

            if (saleData.customer_data) {
                const customer = saleData.customer_data;

                if (saleData.client_sub_type === 'NHIMA') {
                    const nhimaSelectEl = document.getElementById('retailNhimaNumber');
                    if (nhimaSelectEl && customer.nhima_number) {
                        nhimaSelectEl.value = customer.nhima_number;
                        nhimaSelectEl.dispatchEvent(new Event('change'));
                    }
                    document.getElementById('retailCustomerName').value = customer.full_name || '';
                    document.getElementById('retailNrc').value = customer.nrc || '';
                    document.getElementById('retailPhoneNumber').value = customer.phone || '';
                    document.getElementById('retailAddress').value = customer.address || '';
                } else {
                    const phoneSelectEl = document.getElementById('retailRegPhone');
                    if (phoneSelectEl && customer.phone) {
                        phoneSelectEl.value = customer.phone;
                        phoneSelectEl.dispatchEvent(new Event('change'));
                    }
                    document.getElementById('retailRegName').value = customer.full_name || '';
                    document.getElementById('retailRegAddress').value = customer.address || '';
                }
            }

            if (saleData.payment) {
                document.getElementById('retailPaymentType').value = saleData.payment.type || 'Cash';
                document.getElementById('retailPaymentNote').value = saleData.payment.note || '';

                const paymentTypeEl = document.getElementById('retailPaymentType');
                if (paymentTypeEl) {
                    paymentTypeEl.dispatchEvent(new Event('change'));
                }
            }

            if (saleData.sale_id) {
                document.getElementById('invoiceNumber').value = saleData.sale_id;
                const display = document.getElementById('saleIdDisplay');
                if (display) {
                    display.textContent = `Invoice #: ${saleData.sale_id}`;
                }
            }

            if (saleData.items && saleData.items.length > 0) {
                const rows = posTableBody.querySelectorAll('tr');
                rows.forEach((row, index) => {
                    if (index > 0) {
                        row.remove();
                    }
                });

                const firstRow = posTableBody.querySelector('tr:first-child');
                if (firstRow) {
                    const itemSelect = firstRow.querySelector('.retail-pos-item');
                    const batchSelect = firstRow.querySelector('.retail-pos-batch');
                    const packInput = firstRow.querySelector('.retail-pos-pack-size');
                    const taxInput = firstRow.querySelector('.retail-pos-tax');
                    const rateInput = firstRow.querySelector('.retail-pos-rate');
                    const qtyInput = firstRow.querySelector('.retail-pos-qty');
                    const totalInput = firstRow.querySelector('.retail-pos-total');
                    const daysInput = firstRow.querySelector('.retail-pos-days');
                    const howToTakeInput = firstRow.querySelector('.retail-pos-how-to-take');

                    if (itemSelect) itemSelect.value = '';
                    if (batchSelect) batchSelect.innerHTML = `<option value="">Select Batch</option>`;
                    if (packInput) packInput.value = '';
                    if (taxInput) taxInput.value = '';
                    if (rateInput) rateInput.value = '';
                    if (qtyInput) qtyInput.value = '1';
                    if (totalInput) totalInput.value = '';
                    if (daysInput) daysInput.value = '0';
                    if (howToTakeInput) howToTakeInput.value = '';
                }

                saleData.items.forEach((item, index) => {
                    if (index > 0) {
                        addPOSRow();
                    }
                });

                // 🔥 FIX: this used to try to set itemSelect.value and
                // dispatch a change event, hoping the dropdown's options
                // (loaded asynchronously by addPOSRow) would already be
                // populated by the time this ran -- confirmed this race
                // condition genuinely happens: the option often doesn't
                // exist yet, so the item silently stays unselected.
                //
                // Worse: it never set batchSelect.value to the actual
                // original batch at all -- it relied entirely on the
                // product-change handler's side effect, which
                // auto-selects whichever batch happens to be listed
                // first, then recalculates a rate from scratch. That's
                // not the batch or rate the sale actually used.
                //
                // Fixed the same way addAllItemsFromSale() already
                // solves this correctly: prefetch every product and
                // batch needed in two batch queries, then directly
                // inject the exact original product, batch, rate, and
                // pack size for each row -- no dependency on async
                // dropdown loads finishing in time, no substituted data.
                const allProductIds = [...new Set(saleData.items.map(item => item.product_id).filter(Boolean))];
                const allBatchIds = [...new Set(saleData.items.map(item => item.batch_id).filter(Boolean))];

                const { data: editProducts } = await supabaseClient
                    .from('products')
                    .select('id, product_name')
                    .in('id', allProductIds);
                const { data: editBatches } = await supabaseClient
                    .from('batches')
                    .select('id, batch_number, expiry_date, total_qty')
                    .in('id', allBatchIds);

                const editProductMap = {};
                (editProducts || []).forEach(p => editProductMap[p.id] = p);
                const editBatchMap = {};
                (editBatches || []).forEach(b => editBatchMap[b.id] = b);

                const editRows = posTableBody.querySelectorAll('tr');

                saleData.items.forEach((item, index) => {
                    const targetRow = editRows[index];
                    if (!targetRow) return;

                    const itemSelect = targetRow.querySelector('.retail-pos-item');
                    const batchSelect = targetRow.querySelector('.retail-pos-batch');
                    const packInput = targetRow.querySelector('.retail-pos-pack-size');
                    const taxInput = targetRow.querySelector('.retail-pos-tax');
                    const rateInput = targetRow.querySelector('.retail-pos-rate');
                    const qtyInput = targetRow.querySelector('.retail-pos-qty');
                    const totalInput = targetRow.querySelector('.retail-pos-total');
                    const daysInput = targetRow.querySelector('.retail-pos-days');
                    const howToTakeInput = targetRow.querySelector('.retail-pos-how-to-take');

                    if (itemSelect && item.product_id) {
                        let opt = Array.from(itemSelect.options).find(o => o.value === item.product_id);
                        if (!opt) {
                            const newOpt = document.createElement('option');
                            newOpt.value = item.product_id;
                            newOpt.textContent = editProductMap[item.product_id]?.product_name || item.product_name || 'Unknown item';
                            itemSelect.appendChild(newOpt);
                        }
                        itemSelect.value = item.product_id;
                    }

                    if (batchSelect && item.batch_id) {
                        const batchInfo = editBatchMap[item.batch_id];
                        const expiry = batchInfo ? new Date(batchInfo.expiry_date).toLocaleDateString() : '';
                        batchSelect.innerHTML = `<option value="${item.batch_id}"
                            data-cost="${item.cost_per_unit || 0}"
                            data-qty="${batchInfo?.total_qty ?? item.available_qty ?? item.qty}"
                            data-batch-number="${item.batch_number || batchInfo?.batch_number || ''}"
                            data-expiry="${expiry}">
                            ${item.batch_number || batchInfo?.batch_number || 'Unknown batch'} ${expiry ? `(Exp: ${expiry})` : ''}
                        </option>`;
                        batchSelect.value = item.batch_id;
                    }

                    // Set the exact original values directly -- not
                    // recalculated from a freshly-selected batch.
                    if (packInput) packInput.value = item.pack_size || 'EACH';
                    if (taxInput) taxInput.value = item.tax_rate || 0;
                    if (rateInput) rateInput.value = (item.rate || 0).toFixed(2);
                    if (qtyInput) qtyInput.value = item.qty || 1;
                    if (totalInput) totalInput.value = (item.total || 0).toFixed(2);
                    if (daysInput) daysInput.value = item.days_supplied || 0;
                    if (howToTakeInput) howToTakeInput.value = item.how_to_take || '';
                });

                updateTotals();
            }

            alert('✅ Sale loaded for editing. Make changes and save.');

        } catch (error) {
            console.error('Error loading sale for edit:', error);
            alert('Error loading sale: ' + error.message);
        }
    }

    // ============================================
    // SHOW VIEW ITEMS MODAL
    // ============================================
    function showViewItemsModal(saleData) {
        const modalEl = document.getElementById('retailViewItemsModal');
        const content = document.getElementById('retailViewItemsContent');
        const title = document.getElementById('retailViewModalTitle');

        if (!modalEl || !content) return;

        title.innerHTML = `<i class="fa-solid fa-list" style="color: #2563eb;"></i> Invoice - ${saleData.sale_id}`;

        let html = `
            <div style="margin-bottom: 20px; padding: 15px; background: #f8fafc; border-radius: 6px; border: 1px solid #e2e8f0;">
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                    <div><strong>Invoice #:</strong> ${saleData.sale_id}</div>
                    <div><strong>Date:</strong> ${saleData.date}</div>
                    <div><strong>Customer:</strong> ${saleData.customer.full_name || 'N/A'}</div>
                    <div><strong>Phone:</strong> ${saleData.customer.phone || 'N/A'}</div>
                    <div><strong>Type:</strong> ${saleData.client_type} (${saleData.client_sub_type || 'N/A'})</div>
                    <div><strong>Payment:</strong> ${saleData.payment.type}</div>
                    ${saleData.customer.nhima_number ? `<div><strong>NHIMA #:</strong> ${saleData.customer.nhima_number}</div>` : ''}
                    ${saleData.customer.nrc ? `<div><strong>NRC:</strong> ${saleData.customer.nrc}</div>` : ''}
                    <div><strong>Status:</strong> <span style="color: #10b981; font-weight: 600;">${saleData.status}</span></div>
                </div>
            </div>
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
                <thead style="background: #f1f5f9;">
                    <tr>
                        <th style="padding: 10px; text-align: left; border-bottom: 2px solid #e2e8f0;">#</th>
                        <th style="padding: 10px; text-align: left; border-bottom: 2px solid #e2e8f0;">Item</th>
                        <th style="padding: 10px; text-align: left; border-bottom: 2px solid #e2e8f0;">Batch</th>
                        <th style="padding: 10px; text-align: center; border-bottom: 2px solid #e2e8f0;">Pack</th>
                        <th style="padding: 10px; text-align: right; border-bottom: 2px solid #e2e8f0;">Tax %</th>
                        <th style="padding: 10px; text-align: right; border-bottom: 2px solid #e2e8f0;">Rate</th>
                        <th style="padding: 10px; text-align: right; border-bottom: 2px solid #e2e8f0;">Qty</th>
                        <th style="padding: 10px; text-align: right; border-bottom: 2px solid #e2e8f0;">Total</th>
                        <th style="padding: 10px; text-align: center; border-bottom: 2px solid #e2e8f0;">Days</th>
                    </tr>
                </thead>
                <tbody>
        `;

        saleData.items.forEach((item, index) => {
            html += `
                <tr style="border-bottom: 1px solid #e2e8f0;">
                    <td style="padding: 10px;">${index + 1}</td>
                    <td style="padding: 10px;">${item.product_name}</td>
                    <td style="padding: 10px;">${item.batch_number}</td>
                    <td style="padding: 10px; text-align: center;">${item.pack_size}</td>
                    <td style="padding: 10px; text-align: right;">${item.tax_rate}%</td>
                    <td style="padding: 10px; text-align: right;">K${item.rate.toFixed(2)}</td>
                    <td style="padding: 10px; text-align: right;">${item.qty}</td>
                    <td style="padding: 10px; text-align: right;">K${item.total.toFixed(2)}</td>
                    <td style="padding: 10px; text-align: center;">${item.days_supplied || 0}</td>
                </tr>
            `;
        });

        html += `
                </tbody>
                <tfoot style="background: #f8fafc; font-weight: 600;">
                    <tr>
                        <td colspan="7" style="padding: 10px; text-align: right;">Subtotal (Excl. Tax):</td>
                        <td style="padding: 10px; text-align: right;">K${saleData.totals.subtotal.toFixed(2)}</td>
                        <td></td>
                    </tr>
                    <tr>
                        <td colspan="7" style="padding: 10px; text-align: right;">Total Tax:</td>
                        <td style="padding: 10px; text-align: right;">K${saleData.totals.tax.toFixed(2)}</td>
                        <td></td>
                    </tr>
                    <tr style="font-size: 1.1rem; color: #0f172a;">
                        <td colspan="7" style="padding: 10px; text-align: right;">Grand Total:</td>
                        <td style="padding: 10px; text-align: right;">K${saleData.totals.grand_total.toFixed(2)}</td>
                        <td></td>
                    </tr>
                </tfoot>
            </table>
        `;

        content.innerHTML = html;
        modalEl.style.display = 'flex';
        window.currentPrintData = saleData;
    }

    // ============================================
    // MODAL CLOSE HANDLERS
    // ============================================
    if (closeBtn) closeBtn.addEventListener('click', () => { modal.style.display = 'none'; });
    if (cancelBtn) cancelBtn.addEventListener('click', () => { modal.style.display = 'none'; });
    if (modal) modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.style.display = 'none';
    });

    const retailCloseViewBtn = document.getElementById('retailCloseViewBtn');
    const retailCloseViewModalBtn = document.getElementById('retailCloseViewModalBtn');
    if (retailCloseViewBtn) retailCloseViewBtn.addEventListener('click', () => { viewModal.style.display = 'none'; });
    if (retailCloseViewModalBtn) retailCloseViewModalBtn.addEventListener('click', () => { viewModal.style.display = 'none'; });
    if (viewModal) viewModal.addEventListener('click', (e) => {
        if (e.target === viewModal) viewModal.style.display = 'none';
    });

    if (retailPrintModal) retailPrintModal.addEventListener('click', (e) => {
        if (e.target === retailPrintModal) retailPrintModal.style.display = 'none';
    });

    if (viewAllHistoryBtn) {
        viewAllHistoryBtn.addEventListener('click', function () {
            if (window.openHistoryModal) {
                const filterType = currentClientType === 'NHIMA' ? 'NHIMA' : currentClientType;
                window.openHistoryModal(filterType);
            } else {
                alert('History modal not available');
            }
        });
    }

    // ============================================
    // PRINT & PDF BUTTONS IN VIEW MODAL
    // ============================================
    const retailPrintViewBtn = document.getElementById('retailPrintViewBtn');
    const retailPdfViewBtn = document.getElementById('retailPdfViewBtn');
    if (retailPrintViewBtn) retailPrintViewBtn.addEventListener('click', printSale);
    if (retailPdfViewBtn) retailPdfViewBtn.addEventListener('click', pdfSale);

    // ============================================
    // CLEAR/RESET
    // ============================================
    if (clearBtn) {
        clearBtn.addEventListener('click', function () {
            if (confirm('Are you sure you want to reset the entire sale?')) {
                resetCustomerFields();
                resetPOSTable();
                const nhimaBtn = document.querySelector('.retail-client-btn[data-type="NHIMA"]');
                if (nhimaBtn) nhimaBtn.click();
                currentSaleData = null;
                window.currentPrintData = null;
                generateNextSaleId();
                updateDateTime();
            }
        });
    }

    // ============================================
    // SAVE & QUOTATION BUTTONS
    // ============================================
    if (saveBtn) saveBtn.addEventListener('click', () => saveTransaction('COMPLETED', 'GRI'));
    if (quoteBtn) quoteBtn.addEventListener('click', () => saveTransaction('QUOTATION', 'QGR'));

    // ============================================
    // 🔥 ADDED: SEARCH BUTTON & MODAL WIRING
    // ============================================
    const searchSalesBtn = document.getElementById('searchSalesBtn');
    const retailSearchModal = document.getElementById('retailSearchModal');
    const retailCloseSearchModalBtn = document.getElementById('retailCloseSearchModalBtn');
    const retailSearchInput = document.getElementById('retailSearchInput');
    const retailSearchGoBtn = document.getElementById('retailSearchGoBtn');

    if (searchSalesBtn && retailSearchModal) {
        searchSalesBtn.addEventListener('click', () => {
            retailSearchModal.style.display = 'flex';
            if (retailSearchInput) {
                retailSearchInput.value = '';
                retailSearchInput.focus();
            }
            // Show the most recent 20 immediately, before any typing.
            searchSalesRecords('');
        });
    }

    if (retailCloseSearchModalBtn && retailSearchModal) {
        retailCloseSearchModalBtn.addEventListener('click', () => {
            retailSearchModal.style.display = 'none';
        });
    }

    if (retailSearchGoBtn) {
        retailSearchGoBtn.addEventListener('click', () => {
            searchSalesRecords(retailSearchInput?.value || '');
        });
    }

    if (retailSearchInput) {
        retailSearchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                searchSalesRecords(retailSearchInput.value || '');
            }
        });
    }

    // ============================================
    // KEYBOARD SHORTCUTS
    // ============================================
    // 🔥 FIX: this is the important one. `document` persists across the POS
    // screen being re-opened in an SPA, so attaching this on every init would
    // stack N copies of this listener after N visits — press Ctrl+S once and
    // saveTransaction() would fire N times, meaning the SAME sale gets saved
    // N times (duplicate invoices, stock deducted N times, etc.). It also
    // used to close over `saveBtn`/`quoteBtn`/`clearBtn` from whichever init
    // ran first, which become dead references to removed DOM nodes after a
    // re-render — so the shortcut would silently do nothing on repeat visits
    // even without the stacking problem. Fixed by only ever attaching this
    // once, and looking the buttons up live (by id) at the moment the key is
    // pressed rather than trusting a closure captured at init time.
    if (!window.__retailPosDocListenersAttached) {
        document.addEventListener('keydown', function (e) {
            if (e.ctrlKey && e.key === 's') {
                e.preventDefault();
                document.getElementById('saveTransactionBtn')?.click();
            }
            if (e.ctrlKey && e.key === 'q') {
                e.preventDefault();
                document.getElementById('makeQuotationBtn')?.click();
            }
            if (e.ctrlKey && e.key === 'r') {
                e.preventDefault();
                document.getElementById('clearSaleBtn')?.click();
            }
        });

        // Mark all document-level (page-wide, persistent) listeners as
        // attached — this must be the LAST thing set so every block above
        // that checks this flag still runs during this very first init call.
        window.__retailPosDocListenersAttached = true;
    }

    // ============================================
    // EXPOSE GLOBALLY
    // ============================================
    window.saveTransaction = saveTransaction;
    window.getSaleData = getSaleData;
    window.printSale = printSale;
    window.showPrintDialog = showPrintDialog;
    window.loadSaleForEdit = loadSaleForEdit;
    window.showViewItemsModal = showViewItemsModal;
    window.addPOSRow = addPOSRow;
    window.updateTotals = updateTotals;
    window.resetPOSTable = resetPOSTable;
    window.resetCustomerFields = resetCustomerFields;
    window.generateNextSaleId = generateNextSaleId;
    window.updateDateTime = updateDateTime;
    window.quickFillItem = quickFillItem;
    window.addAllItemsFromSale = addAllItemsFromSale;
    window.createSaleAccountingEntries = createSaleAccountingEntries;
    window.getAccountCodesFromChartOfAccounts = getAccountCodesFromChartOfAccounts;
    window.createSaleAccountingEntriesFallback = createSaleAccountingEntriesFallback;
    window.ensureCustomerExists = ensureCustomerExists;
    window.syncNhimaMemberToCustomers = syncNhimaMemberToCustomers;
    window.ensureChartOfAccounts = ensureChartOfAccounts;

    console.log("✅ Retail POS global functions exposed");

    // ============================================
    // INITIAL SETUP
    // ============================================
    const defaultBtn = document.querySelector('.retail-client-btn.active');
    if (defaultBtn) {
        defaultBtn.click();
    } else {
        const nhimaBtn = document.querySelector('.retail-client-btn[data-type="NHIMA"]');
        if (nhimaBtn) nhimaBtn.click();
    }

    // 🔥 FIX: same issue as the dropdown loads above — don't let these two
    // network calls block addPOSRow() (which is what makes the item table
    // usable) from ever running if either one stalls. Run addPOSRow() first,
    // then sync accounts/NHIMA members in the background.
    addPOSRow();

    ensureChartOfAccounts().catch(e => console.warn("ensureChartOfAccounts failed:", e));
    syncNhimaMemberToCustomers().catch(e => console.warn("syncNhimaMemberToCustomers failed:", e));

    console.log("✅ Retail POS initialized successfully!");
    console.log("Current Client Type:", currentClientType);
    console.log("✅ Accounting integration enabled with auto-create accounts");
    console.log("✅ NHIMA always uses Accounts Receivable (Credit)");
    console.log("✅ NHIMA sales stored as 'Pending' until settled via NHIMA CSV upload");
    console.log("✅ Regular/Online/Staff use Cash or Credit based on payment type");
    console.log("✅ Stock validation enabled - only batches with qty > 0 shown");
    console.log("✅ Customer existence ensurer added - permanent fix for FK constraint");

})();
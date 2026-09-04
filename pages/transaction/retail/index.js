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

    // 🔥 CHANGED: previously called a shared window-level getCompanySettings()
    // (assets/js/shared-company-settings.js) -- that file is no longer part
    // of the site, so calling it threw "getCompanySettings is not defined"
    // and aborted this entire module's init before anything below it (item
    // search, dropdowns, save/print, everything) ever ran. Self-contained
    // now: reads the same single `company_settings` row directly, with a
    // hardcoded fallback if that fails for any reason, so this file has no
    // dependency on any other script existing on the page.
    const companySettings = await (async function loadCompanySettingsInline() {
        const fallback = {
            company_name: 'GRIFFINS MEDICALS LIMITED',
            address: 'Plot 3534, Freedomway, Lusaka',
            phone: '+260 97 000 0000',
            zamra_number: 'ZAMRA-123456',
            invoice_prefix: 'GRI',
            quotation_prefix: 'QGR'
        };
        try {
            const { data, error } = await supabaseClient
                .from('company_settings')
                .select('company_name, address, phone, zamra_number, invoice_prefix, quotation_prefix')
                .eq('id', 1)
                .maybeSingle();
            if (error || !data) return fallback;
            return {
                company_name: data.company_name || fallback.company_name,
                address: data.address || fallback.address,
                phone: data.phone || fallback.phone,
                zamra_number: data.zamra_number || fallback.zamra_number,
                invoice_prefix: data.invoice_prefix || fallback.invoice_prefix,
                quotation_prefix: data.quotation_prefix || fallback.quotation_prefix
            };
        } catch (e) {
            console.warn('Could not load company_settings, using defaults:', e);
            return fallback;
        }
    })();

    // 🔥 FIX: tracks the `sales.id` (database UUID) of the invoice currently
    // loaded for in-place editing via the search modal's "Edit" button. Save
    // previously ALWAYS inserted a new `sales` row -- even when editing an
    // existing invoice -- so a re-save minted a brand-new sale_id (catching
    // the resulting unique-constraint error and retrying with a fresh one),
    // leaving the original row orphaned, deducting stock a second time, and
    // posting a second set of accounting entries for the same real-world
    // transaction. See saveTransaction()'s `editingSaleDbId` branch below.
    // null = a normal new sale; set = update this existing row instead.
    // Declared up here (not lower down with currentSaleData/lastSavedSaleData)
    // because generateNextSaleId() -- which reads it -- is already called
    // during page init below, before execution would otherwise have reached
    // a lower declaration; a `let` accessed before its own declaration line
    // throws, it isn't just `undefined`.
    let editingSaleDbId = null;

    // 🔥 ADDED: in-memory copy of every product (id, product_name,
    // generic_name), built once by loadProductDropdowns() and reused by
    // the new item-search box (see renderSearchResults() further down) so
    // typing doesn't need a network round trip per keystroke. The hidden
    // .retail-pos-item <select> is still populated from the same data --
    // this is purely an extra index for filtering/display.
    let productCatalog = [];

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

    // 🔥 ADDED: "+ Add Item" button in the redesigned Items card header --
    // manually appends a blank row the same way the table already
    // auto-appends one once you fill in the last row's quantity.
    const retailAddItemBtn = document.getElementById('retailAddItemBtn');
    if (retailAddItemBtn) {
        retailAddItemBtn.addEventListener('click', function () {
            addPOSRow();
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

    // 3. Confirm Modal (generic themed dialog shell)
    // 🔥 CHANGED: this used to always be the "Would you like to print
    // the invoice?" prompt (hence the id/icon still saying "print").
    // Saving now prints automatically instead -- this same shell is
    // repurposed by the isolated queue-bridge script at the bottom of
    // this file for its "Send to Dispatch" popup (shown only when the
    // sale being saved is tied to a patient queue ticket), which
    // rewrites the icon/title/message/button text before showing it.
    // Left with its original id/default copy here so the modal always
    // exists in the DOM even before the bridge script (if any) touches it.
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
                    <input type="text" id="retailSearchInput" placeholder="Invoice #, Quotation #, customer name, or NHIMA claim number..." style="flex: 1; padding: 10px 14px; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 0.9rem;">
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

    // 5. Dose Instructions Modal
    // 🔥 ADDED: replaces the old free-text "How to Take" field with a
    // structured builder -- qty per dose, which time(s) of day, before/after
    // food, and an optional note for rare/special cases. The generated
    // sentence is written into the same .retail-pos-how-to-take input that
    // already existed, so nothing downstream (save payload, sticker print,
    // loading a saved sale for edit) needed to change -- see
    // buildDoseSentence() and the wiring below.
    //
    // 🔥 EXTENDED: the original model only covered tablets/capsules. Added
    // a Form selector (Tablet/Capsule, Liquid, Injectable) that switches
    // which fields are relevant -- liquid swaps the unit to ml, injectable
    // swaps in a route (IM/IV/SC) + a unit choice (ml/vial(s)/ampoule(s)/
    // units) and a "single dose" toggle, and hides the Food section since
    // food timing doesn't apply to injections. See buildDoseSentence() and
    // applyDoseFormVisibility() below.
    if (!document.getElementById('retailDoseModal')) {
        const doseModalHTML = `
        <div id="retailDoseModal" style="display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(15, 23, 42, 0.6); backdrop-filter: blur(4px); z-index: 1002; justify-content: center; align-items: center;">
            <div class="modal-content-box" style="background: white; padding: 25px; border-radius: 12px; width: 90%; max-width: 420px; max-height: 90vh; overflow-y: auto; box-shadow: 0 20px 50px rgba(0,0,0,0.5);">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; border-bottom: 1px solid #e2e8f0; padding-bottom: 12px;">
                    <h3 style="margin: 0; font-size: 1rem;"><i class="fa-solid fa-pills" style="color: #2563eb;"></i> Dosage Instructions</h3>
                    <button id="retailDoseCloseBtn" type="button" style="background: none; border: none; font-size: 1.4rem; cursor: pointer; color: #64748b;">&times;</button>
                </div>

                <div style="margin-bottom: 12px;">
                    <label style="display: block; font-weight: 500; color: #475569; margin-bottom: 6px; font-size: 0.8rem;">Form</label>
                    <div style="display: flex; gap: 4px; background: #f1f5f9; padding: 3px; border-radius: 6px; width: fit-content;">
                        <button type="button" class="retail-dose-form-btn active" data-form="tablet" style="padding: 6px 14px; border: none; border-radius: 4px; cursor: pointer; background: #2563eb; color: white; font-weight: 500; font-size: 0.76rem;">Tablet/Capsule</button>
                        <button type="button" class="retail-dose-form-btn" data-form="liquid" style="padding: 6px 14px; border: none; border-radius: 4px; cursor: pointer; background: transparent; color: #475569; font-size: 0.76rem;">Liquid</button>
                        <button type="button" class="retail-dose-form-btn" data-form="injectable" style="padding: 6px 14px; border: none; border-radius: 4px; cursor: pointer; background: transparent; color: #475569; font-size: 0.76rem;">Injectable</button>
                    </div>
                </div>

                <div style="margin-bottom: 12px; display: flex; gap: 10px; align-items: flex-end;">
                    <div>
                        <label id="retailDoseQtyLabel" style="display: block; font-weight: 500; color: #475569; margin-bottom: 4px; font-size: 0.8rem;">Tablets per dose</label>
                        <input type="number" id="retailDoseQty" min="0.25" step="0.25" value="1" style="width: 90px; padding: 6px 10px; border: 1px solid #e2e8f0; border-radius: 4px; font-size: 0.85rem;">
                    </div>
                    <div id="retailDoseUnitRow" style="display: none;">
                        <label style="display: block; font-weight: 500; color: #475569; margin-bottom: 4px; font-size: 0.8rem;">Unit</label>
                        <select id="retailDoseUnit" style="padding: 6px 10px; border: 1px solid #e2e8f0; border-radius: 4px; font-size: 0.85rem;">
                            <option value="ml">ml</option>
                            <option value="vial">vial(s)</option>
                            <option value="ampoule">ampoule(s)</option>
                            <option value="units">units</option>
                        </select>
                    </div>
                </div>

                <div id="retailDoseRouteSection" style="display: none; margin-bottom: 12px;">
                    <label style="display: block; font-weight: 500; color: #475569; margin-bottom: 6px; font-size: 0.8rem;">Route</label>
                    <div style="display: flex; gap: 10px;">
                        <label style="display:flex; align-items:center; gap:5px; font-size:0.82rem; cursor:pointer;"><input type="radio" name="retailDoseRoute" class="retail-dose-route" value="IM" checked> IM</label>
                        <label style="display:flex; align-items:center; gap:5px; font-size:0.82rem; cursor:pointer;"><input type="radio" name="retailDoseRoute" class="retail-dose-route" value="IV"> IV</label>
                        <label style="display:flex; align-items:center; gap:5px; font-size:0.82rem; cursor:pointer;"><input type="radio" name="retailDoseRoute" class="retail-dose-route" value="SC"> SC</label>
                    </div>
                </div>

                <div id="retailDoseOneTimeRow" style="display: none; margin-bottom: 12px;">
                    <label style="display:flex; align-items:center; gap:6px; font-size:0.82rem; cursor:pointer; color: #475569;">
                        <input type="checkbox" id="retailDoseOneTime"> Single (one-time / STAT) dose -- not a recurring schedule
                    </label>
                </div>

                <div id="retailDoseWhenSection" style="margin-bottom: 12px;">
                    <label style="display: block; font-weight: 500; color: #475569; margin-bottom: 6px; font-size: 0.8rem;">When</label>
                    <div style="display: flex; flex-wrap: wrap; gap: 10px;">
                        <label style="display:flex; align-items:center; gap:5px; font-size:0.82rem; cursor:pointer;"><input type="checkbox" class="retail-dose-time" value="morning"> Morning</label>
                        <label style="display:flex; align-items:center; gap:5px; font-size:0.82rem; cursor:pointer;"><input type="checkbox" class="retail-dose-time" value="noon"> Noon</label>
                        <label style="display:flex; align-items:center; gap:5px; font-size:0.82rem; cursor:pointer;"><input type="checkbox" class="retail-dose-time" value="evening"> Evening</label>
                        <label style="display:flex; align-items:center; gap:5px; font-size:0.82rem; cursor:pointer;"><input type="checkbox" class="retail-dose-time" value="bedtime"> Before Bed</label>
                    </div>
                </div>

                <div id="retailDoseFoodSection" style="margin-bottom: 12px;">
                    <label style="display: block; font-weight: 500; color: #475569; margin-bottom: 6px; font-size: 0.8rem;">Food</label>
                    <div style="display: flex; gap: 14px;">
                        <label style="display:flex; align-items:center; gap:5px; font-size:0.82rem; cursor:pointer;"><input type="checkbox" id="retailDoseAfterFood"> After Food</label>
                        <label style="display:flex; align-items:center; gap:5px; font-size:0.82rem; cursor:pointer;"><input type="checkbox" id="retailDoseBeforeFood"> Before Food</label>
                    </div>
                </div>

                <div style="margin-bottom: 15px;">
                    <label style="display: block; font-weight: 500; color: #475569; margin-bottom: 4px; font-size: 0.8rem;">Note (optional -- for rare/special cases)</label>
                    <textarea id="retailDoseNote" rows="2" placeholder="e.g. Take with plenty of water" style="width: 100%; padding: 6px 10px; border: 1px solid #e2e8f0; border-radius: 4px; font-size: 0.8rem; resize: vertical; box-sizing: border-box;"></textarea>
                </div>

                <div id="retailDosePreview" style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; padding: 8px 10px; margin-bottom: 15px; font-size: 0.78rem; color: #475569; min-height: 20px; white-space: pre-line;">
                    Tick a time above to see the generated instructions.
                </div>

                <div style="display: flex; gap: 8px; justify-content: flex-end; border-top: 1px solid #e2e8f0; padding-top: 12px;">
                    <button id="retailDoseCancelBtn" type="button" style="background: #f1f5f9; border: 1px solid #e2e8f0; padding: 8px 20px; border-radius: 6px; cursor: pointer; font-size: 0.85rem;">Cancel</button>
                    <button id="retailDoseApplyBtn" type="button" style="background: #2563eb; color: white; border: none; padding: 8px 20px; border-radius: 6px; cursor: pointer; font-size: 0.85rem;">Apply</button>
                </div>
            </div>
        </div>
        `;
        document.body.insertAdjacentHTML('beforeend', doseModalHTML);
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
    const retailDoseModal = document.getElementById('retailDoseModal');

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
    document.querySelectorAll('#retailAddContactModal .modal-content-box, #retailViewItemsModal .modal-content-box, #retailPrintModal .modal-content-box, #retailSearchModal .modal-content-box, #retailDoseModal .modal-content-box')
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

            const doseModalEl = document.getElementById('retailDoseModal');
            if (isModalVisible(doseModalEl) && e.target.closest('#retailDoseModal')) {
                doseModalEl.style.display = 'none';
            }
        });
    }

    // ============================================
    // 🔥 ADDED: DOSAGE INSTRUCTIONS MODAL LOGIC
    // ============================================
    // Turns (qty per dose, ticked times, before/after food, optional note)
    // into the plain-English sentence(s) that get printed on the medicine
    // sticker -- e.g. qty=2, morning+evening ticked, "after" food ticked ->
    //   "2 tablets in the morning after breakfast.
    //    2 tablets in the evening after dinner."
    // Each ticked time becomes its own line (joined with \n); the sticker's
    // .how-to-take CSS uses white-space: pre-line so those line breaks
    // actually render instead of collapsing into one run-on sentence.
    const DOSE_TIME_CONFIG = {
        morning: { phrase: 'in the morning', meal: 'breakfast' },
        noon: { phrase: 'at noon', meal: 'lunch' },
        evening: { phrase: 'in the evening', meal: 'dinner' },
        bedtime: { phrase: 'before bed', meal: null }
    };
    const DOSE_TIME_ORDER = ['morning', 'noon', 'evening', 'bedtime'];

    // 🔥 ADDED: best-guess dosage Form from a product's dosage_forms.name
    // (free text set in Product Master, e.g. "Tablet", "Syrup",
    // "Prefilled Syringe For Injection"). Only used as the modal's
    // starting point -- the cashier can always change it with the Form
    // buttons, and whatever they pick is what gets saved on the row.
    function classifyDosageForm(dosageFormName) {
        const n = (dosageFormName || '').toLowerCase();
        if (/inject|syringe|\bvial\b|ampoule|\biv\b|\bim\b|\bsc\b/.test(n)) return 'injectable';
        if (/syrup|suspension|solution|liquid|drops|elixir|linctus/.test(n)) return 'liquid';
        return 'tablet';
    }

    // 🔥 ADDED: best-effort, non-blocking lookup of a product's dosage form
    // so the Dosage Instructions modal can default to the right Form
    // automatically. Deliberately isolated in its own try/catch and never
    // awaited by the caller -- if this query fails or the relationship
    // doesn't resolve, it just leaves row.dataset.doseFormGuess unset (the
    // modal falls back to Tablet/Capsule), and never affects the real
    // product/batch/rate loading in the '.retail-pos-item' change handler.
    async function stashDoseFormGuess(row, productId) {
        try {
            const { data } = await supabaseClient
                .from('products')
                .select('dosage_forms(name)')
                .eq('id', productId)
                .maybeSingle();
            row.dataset.doseFormGuess = classifyDosageForm(data?.dosage_forms?.name);
        } catch (e) {
            console.warn('Could not determine dosage form for product', productId, e);
        }
    }

    function buildDoseSentence(state) {
        const qtyNum = parseFloat(state.qty);
        const qty = (qtyNum && qtyNum > 0) ? qtyNum : 1;
        const form = state.form || 'tablet';
        const times = state.times || [];
        const foodRelation = state.foodRelation || ''; // 'after' | 'before' | ''
        const route = state.route || 'IM';
        const oneTime = !!state.oneTime;

        let amountText;
        if (form === 'liquid') {
            amountText = `${qty}ml`;
        } else if (form === 'injectable') {
            const unit = state.unit || 'ml';
            if (unit === 'ml') {
                amountText = `${qty}ml`;
            } else {
                const unitLabel = { vial: 'vial(s)', ampoule: 'ampoule(s)', units: 'units' }[unit] || unit;
                amountText = `${qty} ${unitLabel}`;
            }
        } else {
            const tabletWord = qty === 1 ? 'tablet' : 'tablets';
            amountText = `${qty} ${tabletWord}`;
        }

        const lines = [];

        if (form === 'injectable' && oneTime) {
            // Single/STAT administration -- no time-of-day schedule.
            lines.push(`${amountText} ${route}, single dose.`);
        } else if (form === 'injectable') {
            DOSE_TIME_ORDER
                .filter(key => times.includes(key))
                .forEach(key => {
                    const cfg = DOSE_TIME_CONFIG[key];
                    lines.push(`${amountText} ${route} ${cfg.phrase}.`);
                });
        } else {
            // Tablet/Capsule and Liquid -- identical shape to the original
            // model, just with amountText carrying the right unit.
            DOSE_TIME_ORDER
                .filter(key => times.includes(key))
                .forEach(key => {
                    const cfg = DOSE_TIME_CONFIG[key];
                    let line = `${amountText} ${cfg.phrase}`;
                    if (foodRelation) {
                        line += cfg.meal ? ` ${foodRelation} ${cfg.meal}` : `, ${foodRelation} food`;
                    }
                    lines.push(line + '.');
                });
        }

        if (state.note && state.note.trim()) {
            lines.push(state.note.trim());
        }

        return lines.join('\n');
    }

    let doseModalTargetRow = null;
    let currentDoseForm = 'tablet';

    const doseFormBtns = document.querySelectorAll('.retail-dose-form-btn');
    const doseQtyLabel = document.getElementById('retailDoseQtyLabel');
    const doseQtyInput = document.getElementById('retailDoseQty');
    const doseUnitRow = document.getElementById('retailDoseUnitRow');
    const doseUnitSelect = document.getElementById('retailDoseUnit');
    const doseRouteSection = document.getElementById('retailDoseRouteSection');
    const doseRouteRadios = document.querySelectorAll('.retail-dose-route');
    const doseOneTimeRow = document.getElementById('retailDoseOneTimeRow');
    const doseOneTimeCheck = document.getElementById('retailDoseOneTime');
    const doseWhenSection = document.getElementById('retailDoseWhenSection');
    const doseFoodSection = document.getElementById('retailDoseFoodSection');
    const doseTimeChecks = document.querySelectorAll('.retail-dose-time');
    const doseAfterFoodCheck = document.getElementById('retailDoseAfterFood');
    const doseBeforeFoodCheck = document.getElementById('retailDoseBeforeFood');
    const doseNoteInput = document.getElementById('retailDoseNote');
    const dosePreviewEl = document.getElementById('retailDosePreview');
    const doseCloseBtn = document.getElementById('retailDoseCloseBtn');
    const doseCancelBtn = document.getElementById('retailDoseCancelBtn');
    const doseApplyBtn = document.getElementById('retailDoseApplyBtn');

    // Shows/hides the fields that only make sense for a given Form, and
    // keeps the Form buttons' active styling in sync. Called on open, on
    // Form change, and on the one-time-dose toggle (which also affects
    // whether the When section applies).
    function applyDoseFormVisibility(form) {
        if (doseQtyLabel) {
            doseQtyLabel.textContent = form === 'liquid' ? 'Amount per dose (ml)'
                : form === 'injectable' ? 'Amount per dose'
                : 'Tablets per dose';
        }

        const isInjectable = form === 'injectable';
        if (doseUnitRow) doseUnitRow.style.display = isInjectable ? 'block' : 'none';
        if (doseRouteSection) doseRouteSection.style.display = isInjectable ? 'block' : 'none';
        if (doseOneTimeRow) doseOneTimeRow.style.display = isInjectable ? 'block' : 'none';
        if (doseFoodSection) doseFoodSection.style.display = isInjectable ? 'none' : 'block';

        const hideWhen = isInjectable && !!doseOneTimeCheck?.checked;
        if (doseWhenSection) doseWhenSection.style.display = hideWhen ? 'none' : 'block';

        doseFormBtns.forEach(btn => {
            const active = btn.dataset.form === form;
            btn.style.background = active ? '#2563eb' : 'transparent';
            btn.style.color = active ? 'white' : '#475569';
        });
    }

    doseFormBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            currentDoseForm = btn.dataset.form;
            applyDoseFormVisibility(currentDoseForm);
            updateDosePreview();
        });
    });

    if (doseUnitSelect) doseUnitSelect.addEventListener('change', updateDosePreview);
    doseRouteRadios.forEach(r => r.addEventListener('change', updateDosePreview));
    if (doseOneTimeCheck) {
        doseOneTimeCheck.addEventListener('change', () => {
            applyDoseFormVisibility(currentDoseForm);
            updateDosePreview();
        });
    }

    function readDoseModalState() {
        const checkedRoute = Array.from(doseRouteRadios).find(r => r.checked);
        return {
            form: currentDoseForm,
            qty: doseQtyInput ? doseQtyInput.value : 1,
            unit: doseUnitSelect ? doseUnitSelect.value : 'ml',
            route: checkedRoute ? checkedRoute.value : 'IM',
            oneTime: !!doseOneTimeCheck?.checked,
            times: Array.from(doseTimeChecks).filter(cb => cb.checked).map(cb => cb.value),
            foodRelation: doseAfterFoodCheck?.checked ? 'after' : (doseBeforeFoodCheck?.checked ? 'before' : ''),
            note: doseNoteInput ? doseNoteInput.value : ''
        };
    }

    function updateDosePreview() {
        if (!dosePreviewEl) return;
        const sentence = buildDoseSentence(readDoseModalState());
        dosePreviewEl.textContent = sentence || 'Tick a time above to see the generated instructions.';
    }

    // Before/After food are mutually exclusive -- a dose can't logically be
    // both, so ticking one clears the other rather than allowing both on.
    if (doseAfterFoodCheck && doseBeforeFoodCheck) {
        doseAfterFoodCheck.addEventListener('change', () => {
            if (doseAfterFoodCheck.checked) doseBeforeFoodCheck.checked = false;
            updateDosePreview();
        });
        doseBeforeFoodCheck.addEventListener('change', () => {
            if (doseBeforeFoodCheck.checked) doseAfterFoodCheck.checked = false;
            updateDosePreview();
        });
    }

    doseTimeChecks.forEach(cb => cb.addEventListener('change', updateDosePreview));
    if (doseNoteInput) doseNoteInput.addEventListener('input', updateDosePreview);
    if (doseQtyInput) doseQtyInput.addEventListener('input', updateDosePreview);

    function openDoseModal(row) {
        if (!retailDoseModal || !row) return;
        doseModalTargetRow = row;

        // Restore the row's previously-chosen structured state if it has
        // one (stored as JSON on the row itself), otherwise fall back to a
        // best guess from the selected product's dosage form (stashed on
        // the row when the item was picked -- see the product 'change'
        // handler), else default to Tablet/Capsule. We deliberately don't
        // try to parse the generated sentence back apart, since that's
        // lossy/fragile; the structured state is the source of truth and
        // the sentence is just its output.
        let saved = null;
        try {
            saved = row.dataset.doseState ? JSON.parse(row.dataset.doseState) : null;
        } catch (e) {
            saved = null;
        }

        currentDoseForm = saved?.form || row.dataset.doseFormGuess || 'tablet';

        if (doseQtyInput) doseQtyInput.value = saved?.qty ?? 1;
        if (doseUnitSelect) doseUnitSelect.value = saved?.unit || 'ml';
        doseRouteRadios.forEach(r => { r.checked = (saved?.route || 'IM') === r.value; });
        if (doseOneTimeCheck) doseOneTimeCheck.checked = !!saved?.oneTime;
        doseTimeChecks.forEach(cb => cb.checked = !!(saved?.times || []).includes(cb.value));
        if (doseAfterFoodCheck) doseAfterFoodCheck.checked = saved?.foodRelation === 'after';
        if (doseBeforeFoodCheck) doseBeforeFoodCheck.checked = saved?.foodRelation === 'before';
        if (doseNoteInput) doseNoteInput.value = saved?.note || '';

        applyDoseFormVisibility(currentDoseForm);
        updateDosePreview();
        retailDoseModal.style.display = 'flex';
    }

    function closeDoseModal() {
        if (retailDoseModal) retailDoseModal.style.display = 'none';
        doseModalTargetRow = null;
    }

    if (doseCloseBtn) doseCloseBtn.addEventListener('click', closeDoseModal);
    if (doseCancelBtn) doseCancelBtn.addEventListener('click', closeDoseModal);

    if (doseApplyBtn) {
        doseApplyBtn.addEventListener('click', () => {
            if (!doseModalTargetRow) return;
            const state = readDoseModalState();
            const sentence = buildDoseSentence(state);

            const targetInput = doseModalTargetRow.querySelector('.retail-pos-how-to-take');
            if (targetInput) targetInput.value = sentence;
            doseModalTargetRow.dataset.doseState = JSON.stringify(state);

            closeDoseModal();
        });
    }

    // Opens the modal from either the pencil button or a click on the
    // (readonly) sentence display itself -- delegated on posTableBody so
    // it keeps working for every row added later via addPOSRow()'s
    // cloneNode(), with no per-row wiring needed.
    if (posTableBody) {
        posTableBody.addEventListener('click', (e) => {
            const trigger = e.target.closest('.retail-dose-edit-btn, .retail-pos-how-to-take');
            if (trigger) {
                openDoseModal(trigger.closest('tr'));
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

            const journalNumber = `SAL-${new Date().getFullYear()}-${Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase()}`;

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
                const cogsJournalNumber = `COG-${new Date().getFullYear()}-${Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase()}`;

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
            return true;

        } catch (error) {
            console.error('Error creating accounting entries:', error);
            console.warn('⚠️ Accounting entries failed but sale was saved successfully.');
            try {
                return await createSaleAccountingEntriesFallback(saleData, saleRecord);
            } catch (fallbackError) {
                console.error('Fallback also failed:', fallbackError);
                return false;
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

            const journalNumber = `SAL-${new Date().getFullYear()}-${Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase()}`;

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
                const cogsJournalNumber = `COG-${new Date().getFullYear()}-${Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase()}`;

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
            return true;

        } catch (error) {
            console.error('Fallback accounting failed:', error);
            return false;
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
        // 🔥 ADDED: the visible search inputs sitting in front of the
        // NHIMA/Phone selects don't get cleared just by resetting the
        // hidden select's .value (that assignment doesn't dispatch
        // 'change', which is what the search-input sync listener in
        // initSearchableSelect() listens for) -- clear them directly here.
        const nhimaNumberSearch = document.getElementById('retailNhimaNumberSearch');

        if (nhimaName) nhimaName.value = '';
        if (nrc) nrc.value = '';
        if (phone) phone.value = '';
        if (address) address.value = '';
        if (nhimaNumber) nhimaNumber.value = '';
        if (nhimaNumberSearch) nhimaNumberSearch.value = '';
        if (claimNumber) claimNumber.value = '';

        const regName = document.getElementById('retailRegName');
        const regAddress = document.getElementById('retailRegAddress');
        const regPhone = document.getElementById('retailRegPhone');
        const regPhoneSearch = document.getElementById('retailRegPhoneSearch');

        if (regName) regName.value = '';
        if (regAddress) regAddress.value = '';
        if (regPhone) regPhone.value = '';
        if (regPhoneSearch) regPhoneSearch.value = '';

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
            const expiryInput = firstRow.querySelector('.retail-pos-expiry');
            const taxInput = firstRow.querySelector('.retail-pos-tax');
            const rateInput = firstRow.querySelector('.retail-pos-rate');
            const qtyInput = firstRow.querySelector('.retail-pos-qty');
            const totalInput = firstRow.querySelector('.retail-pos-total');
            const daysInput = firstRow.querySelector('.retail-pos-days');
            const howToTakeInput = firstRow.querySelector('.retail-pos-how-to-take');
            const searchInput = firstRow.querySelector('.retail-pos-item-search');

            if (itemSelect) itemSelect.value = '';
            if (searchInput) searchInput.value = '';
            if (batchSelect) batchSelect.innerHTML = `<option value="">Select Batch</option>`;
            if (packInput) packInput.value = '';
            if (expiryInput) expiryInput.value = '';
            if (taxInput) taxInput.value = '';
            if (rateInput) rateInput.value = '';
            if (qtyInput) {
                qtyInput.value = '1';
                qtyInput.disabled = false;
                qtyInput.max = '';
            }
            if (totalInput) totalInput.value = '';
            if (daysInput) daysInput.value = '0';
            // 🔥 FIX: also clear the structured dose state stored on the row
            // (see the Dosage Instructions modal) -- otherwise reopening the
            // modal on this now-blank row would still show the previous
            // item's ticked times/food/note.
            if (howToTakeInput) {
                howToTakeInput.value = '';
                const doseStateRow = howToTakeInput.closest('tr');
                if (doseStateRow) delete doseStateRow.dataset.doseState;
            }

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
                    // 🔥 FIX: was checking .select('nhima_number') only, so a
                    // false-positive "already exists" gave no way to tell
                    // WHY it thought that -- which patient it's supposedly
                    // registered to, or whether the stored value has some
                    // invisible difference (extra space, different dash,
                    // etc.) from what was just typed. Now selects full_name
                    // too and echoes both the typed value and the exact
                    // stored value back in the alert, so the very next time
                    // this fires, the cause is visible immediately instead
                    // of needing a database lookup to diagnose.
                    const { data: existing, error: checkError } = await supabaseClient
                        .from('nhima_members')
                        .select('nhima_number, full_name')
                        .eq('nhima_number', nhimaNumber)
                        .maybeSingle();

                    if (checkError && checkError.code !== 'PGRST116') {
                        throw checkError;
                    }

                    if (existing) {
                        alert(`NHIMA Number "${nhimaNumber}" already exists -- registered to ${existing.full_name || 'another patient'} (stored as "${existing.nhima_number}"). Please use a different number.`);
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
                const searchInput = firstRow.querySelector('.retail-pos-item-search');

                if (itemSelect) itemSelect.value = '';
                if (searchInput) searchInput.value = '';
                if (batchSelect) batchSelect.innerHTML = `<option value="">Select Batch</option>`;
                if (packInput) packInput.value = '';
                if (taxInput) taxInput.value = '';
                if (rateInput) rateInput.value = '';
                if (qtyInput) qtyInput.value = '1';
                if (totalInput) totalInput.value = '';
                if (daysInput) daysInput.value = '0';
                // 🔥 FIX: also clear the structured dose state stored on the row
            // (see the Dosage Instructions modal) -- otherwise reopening the
            // modal on this now-blank row would still show the previous
            // item's ticked times/food/note.
            if (howToTakeInput) {
                howToTakeInput.value = '';
                const doseStateRow = howToTakeInput.closest('tr');
                if (doseStateRow) delete doseStateRow.dataset.doseState;
            }
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
                    if (opt) {
                        itemSelect.value = item.product_id;
                        // 🔥 ADDED: this path sets .value directly without
                        // dispatching 'change' (batch/rate are filled in
                        // explicitly below instead), so the search box's
                        // sync-on-change (see the posTableBody 'change'
                        // handler) never fires here -- keep it in sync by hand.
                        const searchInputEl = targetRow.querySelector('.retail-pos-item-search');
                        if (searchInputEl) searchInputEl.value = opt.textContent;
                    }
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

                        const expiryInput = targetRow.querySelector('.retail-pos-expiry');
                        if (expiryInput) expiryInput.value = expiry;

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

        // 🔥 ADDED: price is now editable (see .retail-pos-rate) -- a manual
        // edit needs to recalculate this row's total and the grand totals
        // the same way a qty edit already does above. updateRowRate() (the
        // function that OVERWRITES this field with the calculated default)
        // only runs when the item or batch selection itself changes, so
        // typing here doesn't get silently reverted.
        if (e.target.classList.contains('retail-pos-rate')) {
            const row = e.target.closest('tr');
            updateRowTotal(row);
            updateTotals();
        }

        // 🔥 ADDED: product search box -- filters productCatalog by product
        // name OR generic name as the cashier types. See renderItemSearchResults().
        if (e.target.classList.contains('retail-pos-item-search')) {
            const row = e.target.closest('tr');
            renderItemSearchResults(row, e.target, e.target.value);
        }
    });

    // Reopen the search panel (with whatever's already typed) when a search
    // box regains focus -- 'focus' doesn't bubble, so this needs its own
    // capture-phase listener rather than living in the delegated handlers
    // above. Select-all on focus so typing immediately replaces the
    // currently-shown product name instead of appending to it.
    posTableBody.addEventListener('focus', function (e) {
        if (e.target.classList.contains('retail-pos-item-search')) {
            e.target.select();
            renderItemSearchResults(e.target.closest('tr'), e.target, e.target.value);
        }
    }, true);

    // ============================================
    // PRODUCT AND BATCH SELECTION
    // ============================================
    posTableBody.addEventListener('change', async function (e) {
        if (e.target.classList.contains('retail-pos-item')) {
            const row = e.target.closest('tr');
            const productId = e.target.value;
            const batchSelect = row.querySelector('.retail-pos-batch');
            const packInput = row.querySelector('.retail-pos-pack-size');
            const expiryInput = row.querySelector('.retail-pos-expiry');
            const taxInput = row.querySelector('.retail-pos-tax');
            const rateInput = row.querySelector('.retail-pos-rate');
            const qtyInput = row.querySelector('.retail-pos-qty');

            // 🔥 ADDED: keep the visible search box's text in sync with
            // whatever the hidden select's value actually is now -- this
            // single line covers every code path that sets .value and
            // dispatches 'change' on this select (a search-panel pick,
            // quickFillItem(), etc.) without needing to touch each of
            // those call sites separately.
            const searchInputEl = row.querySelector('.retail-pos-item-search');
            if (searchInputEl) {
                searchInputEl.value = productId ? (e.target.options[e.target.selectedIndex]?.text || '') : '';
            }

            if (!productId) {
                if (batchSelect) batchSelect.innerHTML = `<option value="">Select Batch</option>`;
                if (packInput) packInput.value = '';
                if (expiryInput) expiryInput.value = '';
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
                // Non-critical, fired in parallel -- see stashDoseFormGuess().
                stashDoseFormGuess(row, productId);

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
                            // 🔥 FIX: setting .value programmatically does NOT fire a
                            // 'change' event, so this auto-pick of the first batch used
                            // to silently skip the "auto-add next row" logic that only
                            // ran on a manual batch selection (see the 'change' handler
                            // on .retail-pos-batch below). That's exactly the real-world
                            // case: most products only have one batch, it gets
                            // auto-selected here, qty is already defaulted to 1, and
                            // nothing is ever "changed" by hand -- so no second row ever
                            // appeared even though the item was fully entered. Dispatching
                            // a real 'change' event routes through that same handler
                            // (rate/total/new-row all in one place) instead of duplicating
                            // it here.
                            batchSelect.dispatchEvent(new Event('change', { bubbles: true }));
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

            // 🔥 FIX: a new empty row used to only get auto-added when you
            // TYPED into the Qty field of the last row (see the 'input'
            // handler below) -- but every new row starts with Qty already
            // defaulted to 1, so if the real quantity genuinely was 1 (very
            // common), that field was never touched, no 'input' event ever
            // fired, and no second row appeared. Selecting a batch is really
            // the moment the item is "committed" regardless of quantity, so
            // that's the right trigger for auto-adding the next row.
            if (selectedBatch && selectedBatch.value) {
                const rows = posTableBody.querySelectorAll('tr');
                if (row === rows[rows.length - 1]) {
                    addPOSRow();
                }
            }
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
        const searchInput = newRow.querySelector('.retail-pos-item-search');
        const batchSelect = newRow.querySelector('.retail-pos-batch');
        const packInput = newRow.querySelector('.retail-pos-pack-size');
        const expiryInput = newRow.querySelector('.retail-pos-expiry');
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
        if (searchInput) searchInput.value = '';
        if (batchSelect) batchSelect.innerHTML = `<option value="">Select Batch</option>`;
        if (packInput) packInput.value = '';
        if (expiryInput) expiryInput.value = '';
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
        updateItemCountBadge();
    }

    // ============================================
    // HELPER FUNCTIONS
    // ============================================
    async function loadProductDropdowns() {
        const selects = document.querySelectorAll('.retail-pos-item');
        try {
            const { data: products, error } = await supabaseClient
                .from('products')
                .select('id, product_name, generic_name_id')
                .order('product_name');

            if (error) throw error;

            // 🔥 ADDED: resolve generic names for the search box -- same
            // two-query pattern (fetch products, then look up their
            // generic_name_id set in one batch) already used by the
            // Purchase module's product search, rather than relying on a
            // PostgREST embedded select.
            const genericIds = [...new Set((products || []).map(p => p.generic_name_id).filter(Boolean))];
            let genericMap = {};
            if (genericIds.length > 0) {
                const { data: generics, error: genError } = await supabaseClient
                    .from('generic_names')
                    .select('id, name')
                    .in('id', genericIds);
                if (!genError && generics) {
                    generics.forEach(g => { genericMap[g.id] = g.name; });
                }
            }

            productCatalog = (products || []).map(p => ({
                id: p.id,
                product_name: p.product_name,
                generic_name: genericMap[p.generic_name_id] || ''
            }));

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
            // 🔥 CHANGED: reuse the shared productCatalog (loaded once by
            // loadProductDropdowns()) instead of re-querying the DB for
            // every single row -- a new row's select needs the exact same
            // full product list every time, so there's nothing per-row to
            // actually fetch. Falls back to a fresh load only if the cache
            // hasn't been populated yet (e.g. this runs before the initial
            // background load finishes).
            if (!productCatalog.length) {
                await loadProductDropdowns();
            }

            select.innerHTML = `<option value="">Select Item</option>`;
            productCatalog.forEach(p => {
                select.innerHTML += `<option value="${p.id}">${p.product_name}</option>`;
            });
        } catch (e) {
            console.warn("Could not load products for row:", e);
        }
    }

    // ============================================
    // 🔥 ADDED: PRODUCT SEARCH BOX (search by product name OR generic name)
    // ============================================
    // The panel is a single shared element appended to <body> once (not
    // nested inside .pos-items-table-wrap, which has overflow-x:auto -- per
    // spec that forces overflow-y:auto too, so an absolutely-positioned
    // dropdown nested in there would get clipped the moment it needed to
    // extend below the table). Positioned with getBoundingClientRect() under
    // whichever row's search box is currently focused, closed on scroll/
    // resize/outside-click rather than re-tracked, since it's only ever open
    // for the few seconds it takes to search and pick.
    let searchPanelRow = null;
    // 🔥 ADDED: keyboard-nav state for the panel -- which rows currently
    // matched the query, and which one is highlighted (Down/Up moves this,
    // Enter/Tab picks it). Kept at module scope alongside searchPanelRow
    // since only one panel is ever open at a time.
    let searchPanelMatches = [];
    let searchPanelHighlightIndex = -1;

    function getOrCreateSearchPanel() {
        let panel = document.getElementById('retailItemSearchPanel');
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'retailItemSearchPanel';
            panel.style.cssText = 'display:none; position:fixed; z-index:2000; background:white; border:1px solid #e2e8f0; border-radius:8px; box-shadow:0 12px 28px rgba(15,23,42,0.18); max-height:260px; overflow-y:auto; font-size:0.82rem;';
            document.body.appendChild(panel);
        }
        return panel;
    }

    function hideItemSearchPanel() {
        const panel = document.getElementById('retailItemSearchPanel');
        if (panel) panel.style.display = 'none';
        searchPanelRow = null;
        searchPanelMatches = [];
        searchPanelHighlightIndex = -1;
    }

    function positionItemSearchPanel(panel, input) {
        const rect = input.getBoundingClientRect();
        panel.style.left = `${Math.round(rect.left)}px`;
        panel.style.top = `${Math.round(rect.bottom + 4)}px`;
        panel.style.width = `${Math.max(240, Math.round(rect.width))}px`;
    }

    // 🔥 ADDED: split out from renderItemSearchResults() so ArrowUp/ArrowDown
    // can just re-paint the highlight without re-filtering productCatalog
    // on every keypress.
    function renderItemSearchResultsHtml(panel) {
        if (searchPanelMatches.length === 0) {
            panel.innerHTML = `<div style="padding:10px 12px; color:#94a3b8;">No matching products.</div>`;
        } else {
            panel.innerHTML = searchPanelMatches.map((p, i) => `
                <div class="retail-item-search-result" data-index="${i}" data-id="${p.id}" style="padding:8px 12px; cursor:pointer; border-bottom:1px solid #f1f5f9; ${i === searchPanelHighlightIndex ? 'background:#eff6ff;' : ''}">
                    <div style="font-weight:600; color:#0f172a;">${p.product_name}</div>
                    ${p.generic_name ? `<div style="font-size:0.72rem; color:#94a3b8;">${p.generic_name}</div>` : ''}
                </div>
            `).join('');
        }
    }

    function scrollItemSearchHighlightIntoView(panel) {
        const el = panel.querySelector(`.retail-item-search-result[data-index="${searchPanelHighlightIndex}"]`);
        if (el) el.scrollIntoView({ block: 'nearest' });
    }

    function renderItemSearchResults(row, input, query) {
        if (!row) return;
        const panel = getOrCreateSearchPanel();
        searchPanelRow = row;

        const term = query.trim().toLowerCase();
        const matches = term
            ? productCatalog.filter(p =>
                p.product_name.toLowerCase().includes(term) ||
                (p.generic_name && p.generic_name.toLowerCase().includes(term))
            ).slice(0, 30)
            : productCatalog.slice(0, 30);

        searchPanelMatches = matches;
        // 🔥 ADDED: first result starts highlighted so an immediate
        // Enter/Tab (without ever touching the mouse) picks the top match.
        searchPanelHighlightIndex = matches.length ? 0 : -1;

        renderItemSearchResultsHtml(panel);
        positionItemSearchPanel(panel, input);
        panel.style.display = 'block';
    }

    // Picking a result just drives the hidden <select> exactly like a
    // native option pick would -- same value assignment, same 'change'
    // event -- so batch loading / rate calc / everything downstream runs
    // completely unchanged.
    function selectItemSearchResult(productId) {
        if (!searchPanelRow) return;
        const select = searchPanelRow.querySelector('.retail-pos-item');
        if (select) {
            select.value = productId;
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }
        hideItemSearchPanel();
    }

    // 🔥 ADDED: pick whichever result is currently highlighted (used by
    // Enter and Tab). Returns false (does nothing) if the panel has no
    // matches -- e.g. an empty query with no products loaded yet -- so the
    // caller knows whether to let the key's default behavior continue.
    function selectHighlightedItemSearchResult() {
        if (searchPanelHighlightIndex < 0 || !searchPanelMatches[searchPanelHighlightIndex]) return false;
        selectItemSearchResult(searchPanelMatches[searchPanelHighlightIndex].id);
        return true;
    }

    // mousedown (not click) + preventDefault so the search input never
    // blurs before the pick registers -- the classic combobox gotcha.
    document.addEventListener('mousedown', function (e) {
        const panel = document.getElementById('retailItemSearchPanel');
        if (!panel || panel.style.display === 'none') return;
        const result = e.target.closest('.retail-item-search-result');
        if (result) {
            e.preventDefault();
            selectItemSearchResult(result.dataset.id);
            return;
        }
        if (!e.target.closest('#retailItemSearchPanel') && !e.target.classList.contains('retail-pos-item-search')) {
            hideItemSearchPanel();
        }
    });

    // 🔥 ADDED: keyboard navigation for the product search panel -- Down/Up
    // moves the highlight, Enter picks it (and stays put), Tab picks it
    // too but WITHOUT preventDefault so focus still naturally advances to
    // whatever field comes next (the hidden <select> itself is display:none
    // and so never receives Tab focus), Escape closes the panel. Delegated
    // on posTableBody (like the other item-search listeners) since rows
    // are added/removed dynamically.
    posTableBody.addEventListener('keydown', function (e) {
        if (!e.target.classList.contains('retail-pos-item-search')) return;
        const panel = document.getElementById('retailItemSearchPanel');
        const isOpen = panel && panel.style.display !== 'none' && searchPanelRow === e.target.closest('tr');
        if (!isOpen) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (!searchPanelMatches.length) return;
            searchPanelHighlightIndex = Math.min(searchPanelHighlightIndex + 1, searchPanelMatches.length - 1);
            renderItemSearchResultsHtml(panel);
            scrollItemSearchHighlightIntoView(panel);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (!searchPanelMatches.length) return;
            searchPanelHighlightIndex = Math.max(searchPanelHighlightIndex - 1, 0);
            renderItemSearchResultsHtml(panel);
            scrollItemSearchHighlightIntoView(panel);
        } else if (e.key === 'Enter') {
            if (selectHighlightedItemSearchResult()) e.preventDefault();
        } else if (e.key === 'Tab') {
            selectHighlightedItemSearchResult();
        } else if (e.key === 'Escape') {
            hideItemSearchPanel();
        }
    });

    if (!window.__retailPosDocListenersAttached) {
        window.addEventListener('scroll', () => hideItemSearchPanel(), true);
        window.addEventListener('resize', () => hideItemSearchPanel());
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

    // ============================================
    // 🔥 ADDED: SEARCHABLE COMBOBOX for plain native <select>s (NHIMA
    // Number, Regular Phone Number) -- mirrors the product-search box
    // above (visible text input in front of a hidden <select>, floating
    // results panel, mousedown-to-pick, Down/Up/Enter/Tab/Escape), but
    // does PREFIX (startsWith) matching instead of substring -- narrows
    // one digit at a time as the cashier types, instead of the old plain
    // <select> which relied on the browser's own inconsistent typeahead
    // across a very long list of numbers ("looking for every number at
    // once"). Reads the option list live off the underlying <select> each
    // time the panel opens, so it always reflects whatever
    // loadNhimaDropdown()/loadPhoneDropdown() most recently populated --
    // no separate cache to keep in sync.
    // ============================================
    // 🔥 ADDED: optional `normalize` -- by default the match term is just
    // lowercased (exact prefix match, e.g. NHIMA numbers, which are stored
    // as plain digit strings and match exactly what's typed). Phone
    // numbers need something smarter: they're stored as
    // "+260771248060" (country code included), but a cashier naturally
    // types "0771...", "771..." or "260771..." -- none of which are a
    // literal prefix of the stored value, so plain startsWith() would
    // silently never match. normalizePhoneForMatch() below strips
    // everything down to a comparable "core" digit string on both sides.
    function normalizePhoneForMatch(raw) {
        let digits = (raw || '').replace(/\D/g, '');
        if (digits.startsWith('260')) digits = digits.slice(3);
        else if (digits.startsWith('0')) digits = digits.slice(1);
        return digits;
    }

    function initSearchableSelect({ searchInputId, selectId, panelId, normalize, matchMode }) {
        const searchInput = document.getElementById(searchInputId);
        const select = document.getElementById(selectId);
        if (!searchInput || !select) return;
        const normalizeFn = normalize || (v => (v || '').toLowerCase());
        // 🔥 'prefix' (default) = must start with what's typed -- fine for
        // NHIMA numbers, which are always typed/read from the first digit.
        // 'contains' = the typed digits can appear ANYWHERE in the
        // (normalized) number -- phone numbers need this: a cashier often
        // remembers the middle/last digits of a number rather than always
        // starting from the very first one, and it still narrows correctly
        // as more digits are typed (each extra digit only keeps numbers
        // that still contain the longer string, so typing "123" then "4"
        // narrows from "contains 123" down to "contains 1234", never
        // resets).
        const mode = matchMode || 'prefix';

        let panel = document.getElementById(panelId);
        if (!panel) {
            panel = document.createElement('div');
            panel.id = panelId;
            panel.style.cssText = 'display:none; position:fixed; z-index:2000; background:white; border:1px solid #e2e8f0; border-radius:8px; box-shadow:0 12px 28px rgba(15,23,42,0.18); max-height:260px; overflow-y:auto; font-size:0.82rem;';
            document.body.appendChild(panel);
        }

        let matches = [];
        let highlightIndex = -1;

        function liveOptions() {
            return Array.from(select.options).filter(o => o.value !== '').map(o => o.value);
        }

        function position() {
            const rect = searchInput.getBoundingClientRect();
            panel.style.left = `${Math.round(rect.left)}px`;
            panel.style.top = `${Math.round(rect.bottom + 4)}px`;
            panel.style.width = `${Math.max(180, Math.round(rect.width))}px`;
        }

        function render() {
            if (matches.length === 0) {
                panel.innerHTML = `<div style="padding:10px 12px; color:#94a3b8;">No matches.</div>`;
                return;
            }
            panel.innerHTML = matches.map((v, i) => `
                <div class="searchable-select-result" data-index="${i}" data-value="${v}" style="padding:8px 12px; cursor:pointer; border-bottom:1px solid #f1f5f9; ${i === highlightIndex ? 'background:#eff6ff;' : ''}">${v}</div>
            `).join('');
        }

        function scrollHighlightIntoView() {
            const el = panel.querySelector(`.searchable-select-result[data-index="${highlightIndex}"]`);
            if (el) el.scrollIntoView({ block: 'nearest' });
        }

        function hide() {
            panel.style.display = 'none';
            matches = [];
            highlightIndex = -1;
        }

        function show(query) {
            const term = normalizeFn(query.trim());
            const all = liveOptions();
            matches = (term
                ? all.filter(v => {
                    const nv = normalizeFn(v);
                    return mode === 'contains' ? nv.includes(term) : nv.startsWith(term);
                })
                : all
            ).slice(0, 30);
            highlightIndex = matches.length ? 0 : -1;
            render();
            position();
            panel.style.display = 'block';
        }

        function commit(value) {
            select.value = value;
            // 🔥 Set the visible text directly here rather than relying
            // solely on the 'change' listener below -- see that
            // listener's comment for why it now skips updating while this
            // input is focused.
            searchInput.value = value || '';
            select.dispatchEvent(new Event('change', { bubbles: true }));
            hide();
        }

        function selectHighlighted() {
            if (highlightIndex < 0 || !matches[highlightIndex]) return false;
            commit(matches[highlightIndex]);
            return true;
        }

        searchInput.addEventListener('focus', () => {
            searchInput.select();
            show(searchInput.value);
        });
        searchInput.addEventListener('input', () => show(searchInput.value));
        searchInput.addEventListener('keydown', (e) => {
            if (panel.style.display === 'none') return;
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (!matches.length) return;
                highlightIndex = Math.min(highlightIndex + 1, matches.length - 1);
                render();
                scrollHighlightIntoView();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (!matches.length) return;
                highlightIndex = Math.max(highlightIndex - 1, 0);
                render();
                scrollHighlightIntoView();
            } else if (e.key === 'Enter') {
                if (selectHighlighted()) e.preventDefault();
            } else if (e.key === 'Tab') {
                selectHighlighted();
            } else if (e.key === 'Escape') {
                hide();
            }
        });

        // mousedown (not click) + preventDefault so the search input never
        // blurs before the pick registers.
        document.addEventListener('mousedown', (e) => {
            if (panel.style.display === 'none') return;
            const result = e.target.closest(`#${panelId} .searchable-select-result`);
            if (result) {
                e.preventDefault();
                commit(result.dataset.value);
                return;
            }
            if (!e.target.closest(`#${panelId}`) && e.target !== searchInput) {
                hide();
            }
        });

        window.addEventListener('scroll', () => hide(), true);
        window.addEventListener('resize', () => hide());

        // 🔥 THE ACTUAL BUG behind "typing resets after a pause": this
        // listener used to unconditionally overwrite the visible search
        // text on EVERY 'change' from the underlying select -- including
        // one dispatched by the queue bridge's pollForOptionAndSelect(),
        // which retries every 300ms for up to ~4.5s after a patient is
        // called in to auto-fill their NHIMA/phone number. If a cashier
        // was mid-search for a DIFFERENT person during that same window
        // (very common -- calling a patient in is usually the first thing
        // that happens before billing), the poll's eventual match would
        // silently stomp whatever they'd already typed, making it look
        // like the search "started over". Now this only auto-syncs when
        // the search box does NOT currently have focus -- i.e. only for
        // background/programmatic updates (loadSaleForEdit(), the "+"
        // add-new-member/customer flows, the queue bridge) that happen
        // while the cashier isn't actively typing here. A pick the
        // cashier makes THEMSELVES (click or keyboard) still updates
        // instantly via commit() above, regardless of focus.
        select.addEventListener('change', () => {
            if (document.activeElement === searchInput) return;
            searchInput.value = select.value || '';
        });

        // Reflect whatever the select already holds at init time (e.g. if
        // it was populated before this ran).
        searchInput.value = select.value || '';
    }

    initSearchableSelect({ searchInputId: 'retailNhimaNumberSearch', selectId: 'retailNhimaNumber', panelId: 'retailNhimaSearchPanel' });
    // 🔥 Phone numbers in the `customers` table are stored with the
    // "+260" country code (confirmed via the actual data), so this one
    // needs normalizePhoneForMatch() -- plain prefix matching on the raw
    // string would never match how a cashier actually types a number.
    // 🔥 CHANGED BACK to 'prefix' -- confirmed with the user they want
    // matching from the number's actual starting point (i.e. the start of
    // the LOCAL number, after normalizePhoneForMatch() strips the +260
    // country code / leading 0), not "contains these digits anywhere".
    // Typing "123" then "4" still narrows correctly with prefix matching,
    // since both searches read the input's full current value each
    // keystroke -- "123" matches local numbers starting 123…, "1234"
    // matches local numbers starting 1234…, a strict subset of the first.
    initSearchableSelect({ searchInputId: 'retailRegPhoneSearch', selectId: 'retailRegPhone', panelId: 'retailRegPhoneSearchPanel', normalize: normalizePhoneForMatch });

    function generateNextSaleId() {
        // 🔥 FIX: a fresh generated invoice number means this is a NEW sale
        // from here on, not an edit of an existing one -- clear the edit
        // tracker so Save inserts instead of updating. Covers the Reset
        // button, the client-type toggle, the post-save form reset, and
        // convertQuotationToInvoice() (which deliberately calls this right
        // after loadSaleForEdit() to turn a loaded quotation into a
        // brand-new invoice instead of editing it in place).
        editingSaleDbId = null;

        const display = document.getElementById('saleIdDisplay');
        const invoiceDisplay = document.getElementById('invoiceNumber');
        if (!display) return;

        const date = new Date();
        const year = date.getFullYear();
        const timestamp = Date.now().toString().slice(-6);
        const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
        const saleId = `${companySettings.invoice_prefix}-${year}-${timestamp}-${random}`;

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
        const expiryInput = row.querySelector('.retail-pos-expiry');

        if (!batchSelect || !rateInput || !packInput) return;

        const selected = batchSelect.options[batchSelect.selectedIndex];
        if (expiryInput) expiryInput.value = (selected && selected.value) ? (selected.dataset.expiry || '') : '';
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

    // 🔥 ADDED: small "N" badge next to the "Items" section header in the
    // redesigned layout -- just counts rows that actually have a product
    // picked (the trailing always-blank template row doesn't count).
    function updateItemCountBadge() {
        const badge = document.getElementById('retailItemCountBadge');
        if (!badge) return;
        const rows = posTableBody.querySelectorAll('tr');
        let count = 0;
        rows.forEach(row => {
            const itemSelect = row.querySelector('.retail-pos-item');
            if (itemSelect && itemSelect.value) count++;
        });
        badge.textContent = String(count);
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

        updateItemCountBadge();

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
                        <!-- 🔥 CHANGED: stacked into narrower rows (was one wide flex row) so this
                             reads cleanly in the ~300px customer/history sidebar instead of the old
                             full-width bottom panel -- same data, same .add-all-items delegation. -->
                        <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px;">
                            <span style="font-weight: 600; font-size: 0.83rem;">${sale.sale_id}</span>
                            <span style="font-weight: 600; color: #0f172a; font-size: 0.83rem;">K${(sale.grand_total || 0).toFixed(2)}</span>
                        </div>
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                            <span style="font-size: 0.68rem; color: #64748b;">${date} ${time}</span>
                            <span style="background: ${statusColor}; color: white; padding: 1px 10px; border-radius: 10px; font-size: 0.63rem;">${sale.status}</span>
                        </div>
                        <button class="add-all-items" data-sale-id="${sale.id}" style="width: 100%; background: #10b981; color: white; border: none; padding: 5px 10px; border-radius: 4px; cursor: pointer; font-size: 0.68rem; margin-bottom: 8px;">
                            <i class="fa-solid fa-cart-plus"></i> Add All Items
                        </button>
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
                .select('id, sale_id, created_at, grand_total, status, is_quotation, customer_data, client_type, claim_number')
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
            // invoice/quotation number, customer name, or NHIMA claim
            // number (partial, case-insensitive). 🔥 ADDED: this used to
            // only ever match the invoice number -- there was no way to
            // find an older invoice by the patient's name or claim number
            // alone, which is exactly what you'd have on hand if you
            // don't remember the invoice number itself. No date limit
            // here either -- this already searches every RETAIL sale ever
            // saved, not just today's.
            if (query && query.trim() !== '') {
                const term = query.trim().replace(/[%_]/g, '\\$&');
                dbQuery = dbQuery.or(
                    `sale_id.ilike.%${term}%,claim_number.ilike.%${term}%,customer_data->>full_name.ilike.%${term}%`
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
                            <div style="font-size:0.8rem; color:#64748b; margin-top:2px;">${customerName}${r.claim_number ? ` &middot; Claim# ${r.claim_number}` : ''} &middot; ${date} &middot; K${(r.grand_total || 0).toFixed(2)}</div>
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
            db_id: sale.id,
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
                        // 🔥 ADDED: captured here (same dataset attribute
                        // the batch dropdown already carries -- see the
                        // "data-expiry" option markup above) purely so the
                        // printed invoice can show it per item.
                        expiry: batchSelect.options[batchSelect.selectedIndex]?.dataset.expiry || '',
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
                // 🔥 FIX: when editing an existing sale, this same claim
                // number legitimately already exists on THIS row -- exclude
                // the row being edited from the check, otherwise saving an
                // edit with its own unchanged claim number always fails as
                // "already used" (by itself).
                let claimCheckQuery = supabaseClient
                    .from('sales')
                    .select('sale_id')
                    .eq('claim_number', claimNumber)
                    .neq('is_quotation', true);
                if (editingSaleDbId) {
                    claimCheckQuery = claimCheckQuery.neq('id', editingSaleDbId);
                }
                const { data: existingClaims, error: claimCheckError } = await claimCheckQuery.limit(1);

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

            // 🔥 FIX: editing an existing invoice (editingSaleDbId set by
            // loadSaleForEdit()) must UPDATE that row, never insert a new
            // one. Previously this branch didn't exist at all -- every save
            // was an insert, so re-saving an edited sale hit the sale_id
            // unique constraint, minted a brand-new sale_id in the catch
            // block below, and inserted a second, separate sale for the
            // same real-world transaction. That left the original row
            // behind as an orphan, deducted stock a second time, and
            // posted a second set of accounting entries.
            //
            // Fix: before writing the row, undo exactly what the ORIGINAL
            // save did -- restore the stock it deducted, and remove its old
            // sale_items and journal entries (matched by reference, which
            // carries the invoice's sale_id string, e.g. "GRI-2026-...-COGS"
            // for the COGS leg) -- then let the rest of this function
            // re-apply stock deduction and accounting entries fresh for the
            // edited items, exactly as it already does for a normal new
            // sale. Net effect: one clean, correct final state, same as if
            // this were the only save that ever happened.
            if (editingSaleDbId) {
                const { data: oldItems, error: oldItemsError } = await supabaseClient
                    .from('sale_items')
                    .select('batch_id, quantity, pack_size')
                    .eq('sale_id', editingSaleDbId);

                if (oldItemsError) {
                    console.error('Error loading original sale items for edit:', oldItemsError);
                    alert('❌ Could not load the original invoice to edit it safely. Nothing was changed.\n' + oldItemsError.message);
                    return;
                }

                if (oldItems && oldItems.length > 0) {
                    const qtyToRestoreByBatch = new Map();
                    for (const item of oldItems) {
                        const packQty = item.pack_size === 'EACH' ? 1 : (parseInt(item.pack_size) || 1);
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

                await supabaseClient.from('sale_items').delete().eq('sale_id', editingSaleDbId);

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
                if (editingSaleDbId) {
                    const { data, error } = await supabaseClient
                        .from('sales')
                        .update(dbRecord)
                        .eq('id', editingSaleDbId)
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
                    .catch(accError => {
                        console.error('Accounting entry error:', accError);
                        return false;
                    });

                const [, accountingOk] = await Promise.all([stockUpdatePromise, accountingPromise]);

                // 🔥 ADDED: a failed accounting post used to be logged to
                // the console ONLY -- the sale saved and stock deducted
                // normally, but zero journal entries were created and
                // nothing on screen ever showed it. This happened for real
                // (3 NHIMA sales, Sep 2026 -- traced to journal_entries'
                // row-level-security policy rejecting the insert whenever
                // the login session had gone stale/expired) and went
                // unnoticed until a mismatch turned up in the financial
                // statements. Now: an impossible-to-miss alert so whoever
                // is at the till knows to flag it, instead of it silently
                // vanishing.
                if (accountingOk === false) {
                    alert(
                        '⚠️ Sale saved, but the accounting entries FAILED to post.\n\n' +
                        `Sale ${saleData.sale_id} is saved and stock has been deducted, ` +
                        'but no journal entries were created for it (often caused by an ' +
                        'expired login session -- try logging out and back in).\n\n' +
                        'Please tell an admin/accountant so the journal entries can be ' +
                        'posted manually for this sale.'
                    );
                }
            } else {
                console.log('Quotation saved - stock not affected');
            }

            currentSaleData = saleData;
            lastSavedSaleData = saleData;
            window.currentPrintData = saleData;

            // ============================================
            // CLEANUP & UI RESET
            // ============================================
            // 🔥 CHANGED: the "Would you like to print the invoice?"
            // confirmation popup is gone -- a completed sale now prints
            // straight away, same as a quotation already did. In its
            // place, the isolated queue-bridge script appended at the
            // bottom of this file shows a "Send to Dispatch" popup
            // instead -- but ONLY when this sale is tied to a patient
            // token queue ticket (i.e. the cashier got here via "Open in
            // POS" on the queue bar). A normal walk-in sale with no
            // ticket gets no popup at all, just the print.
            await new Promise(resolve => setTimeout(resolve, 500));
            printSale();

            if (status === 'COMPLETED' && !isQuotation && typeof window.__onRetailSaleSaved === 'function') {
                window.__onRetailSaleSaved();
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
    // 🔥 CHANGED: the sticker/label print step that used to chain after this
    // (a second "print medicine labels?" prompt) has been removed from POS
    // entirely. Label printing now happens exclusively from the Dispensing
    // screen (Dashboard -> Dispensing), which lists sales pending labels via
    // sales.labels_printed_at and lets a dispenser reprint any invoice by
    // number -- decoupled from the cashier's save/checkout flow so a busy
    // till never blocks on a slow or jammed label printer.
    // 🔥 REMOVED: showPrintDialog() -- the "Would you like to print the
    // invoice?" confirmation popup. A completed sale now prints
    // automatically instead (see the save handler above); the
    // #retailPrintModal DOM shell it used to drive is now repurposed by
    // the queue-bridge script at the bottom of this file for the "Send
    // to Dispatch" popup instead.

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

    // 🔥 CHANGED (2nd pass): back to a real HTML <table> -- the previous
    // plain-text <pre> version was built specifically to survive
    // Windows' "Generic / Text Only" print driver (which strips out all
    // CSS/HTML and just extracts raw characters, squashing table cells
    // together with no space between them). That driver is meant for
    // printers that genuinely cannot render graphics at all. Most 80mm
    // thermal receipt printers actually DO ship a real, graphics-capable
    // driver (an "XP-58/80", "POS-80", or the printer's own branded
    // driver, usually from the manufacturer's install disc/website,
    // separate from the plain "Generic / Text Only" option Windows
    // offers by default) -- picking that driver instead lets the printer
    // rasterize the page exactly like any other printer, so a real
    // table with borders and bold text prints correctly. If your
    // printer genuinely has no such driver, say so and this goes back to
    // the padded plain-text layout -- just ask.
    //
    // Columns are deliberately compact per the pharmacy's own spec:
    // Item / Batch (+ expiry in the same cell) / Tax% / Days Supply /
    // Rate / Qty / Subtotal. "Pack" was dropped -- it's always "EACH"
    // for NHIMA, so printing it added nothing but width, which matters
    // a lot on a narrow receipt.
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
                <meta charset="UTF-8">
                <!-- 🔥 the printed page's title/URL is what some browsers'
                     "headers and footers" print option stamps at the top
                     and bottom of the page (that stray "about:blank ...
                     1/1" line) -- naming it after the pharmacy at least
                     makes that stamp useful instead of meaningless.
                     Turning that stamp off entirely is a print-dialog
                     setting on the printing computer, not something this
                     page can control: in the print dialog, open "More
                     settings" and uncheck "Headers and footers" -- most
                     browsers remember that choice for next time. -->
                <title>${companySettings.company_name} - ${docLabel} ${saleData.sale_id}</title>
                <style>
                    * { box-sizing: border-box; }
                    /* 🔥 FIX: printed on the real thermal printer, everything
                       that wasn't already bold came out faint/hard to read --
                       bold text has extra "weight" (thicker strokes), which is
                       what actually shows up clearly on a thermal head; a
                       normal-weight (400) character has thin strokes that
                       print light no matter the font size. Fix: raise the
                       BASELINE weight for the whole receipt to 600 (semibold)
                       here on <body>, so everything inherits it unless
                       overridden -- the item name, section headers, and grand
                       total stay at 700/800 so they still stand out as
                       clearly heavier than the rest, but nothing on the page
                       is left at the too-thin default 400 anymore. */
                    body { font-family: 'Courier New', Courier, monospace; padding: 10px; margin: 0; font-size: 11px; font-weight: 600; color: #000; }
                    .header { text-align: center; border-bottom: 2px solid #000; padding-bottom: 6px; margin-bottom: 8px; }
                    .header h1 { margin: 0; font-size: 15px; font-weight: 800; letter-spacing: 0.02em; }
                    .header p { margin: 2px 0; font-size: 10.5px; }
                    .doc-type-badge { display: inline-block; margin-top: 6px; padding: 2px 10px; border: 1px solid #000; font-size: 10px; font-weight: 800; }
                    .meta-row { margin-bottom: 6px; font-size: 11px; }
                    .meta-row div { margin: 1px 0; }
                    .customer-info { margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px dashed #000; font-size: 11px; }
                    .customer-info div { margin: 1px 0; }
                    /* 🔥 CHANGED: the old layout packed # / Item / Batch /
                       Tax% / Days / Rate / Qty / Subtotal into ONE fixed-width
                       table row -- fine for a wide printer, but on an 80mm
                       receipt each column got so narrow that the item name
                       (usually the longest text on the line) wrapped onto 4-5
                       lines and the whole thing read as a wall of squeezed
                       text (confirmed from a real printed sample). Now each
                       item gets its own block: the full-width item name on
                       its own line first, then a second line with the batch
                       and expiry, then a third line with the remaining stats
                       (tax/days/rate/qty) on the left and the subtotal on the
                       right. No column ever has to share its width with the
                       item name, so nothing needs to wrap. */
                    .items-list { margin-bottom: 8px; }
                    .items-header { display: flex; justify-content: space-between; font-size: 10.5px; font-weight: 800; border-bottom: 2px solid #000; padding-bottom: 3px; margin-bottom: 2px; }
                    .item-block { padding: 5px 0; border-bottom: 1px dashed #000; }
                    .item-block:last-child { border-bottom: 1px solid #000; }
                    .item-name { font-size: 11px; font-weight: 700; margin-bottom: 2px; word-wrap: break-word; }
                    .item-batch { font-size: 10.5px; margin-bottom: 2px; color: #000; }
                    .item-stats { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; font-size: 10.5px; gap: 2px 10px; }
                    .item-stats .stat-group { display: flex; gap: 8px; flex-wrap: wrap; }
                    .item-stats .item-subtotal { font-weight: 800; font-size: 11px; white-space: nowrap; }
                    .totals { margin-top: 6px; padding-top: 6px; border-top: 1px dashed #000; font-size: 10.5px; }
                    .totals-row { display: flex; justify-content: space-between; margin: 2px 0; }
                    .grand-total { font-size: 13px; font-weight: 800; border-top: 1px solid #000; margin-top: 4px; padding-top: 4px; }
                    .footer { text-align: center; margin-top: 12px; padding-top: 8px; border-top: 1px dashed #000; font-size: 10.5px; }
                    @media print { @page { margin: 0; } body { padding: 6mm; } }
                </style>
            </head>
            <body>
                <div class="header">
                    <h1>${companySettings.company_name}</h1>
                    <p>${companySettings.address}</p>
                    <p>Phone: ${companySettings.phone} | ZAMRA: ${companySettings.zamra_number}</p>
                    <div class="doc-type-badge">${isQuotation ? 'QUOTATION -- NOT A TAX INVOICE' : 'TAX INVOICE'}</div>
                </div>
                <div class="meta-row">
                    <div><strong>${docLabel} #:</strong> ${saleData.sale_id}</div>
                    <div><strong>Date:</strong> ${saleData.date}</div>
                    ${!isQuotation ? `<div><strong>Payment:</strong> ${saleData.payment.type}</div>` : ''}
                </div>
                <div class="customer-info">
                    <div><strong>Customer:</strong> ${saleData.customer.full_name || 'N/A'}</div>
                    <div><strong>Phone:</strong> ${saleData.customer.phone || 'N/A'}</div>
                    <div><strong>Address:</strong> ${saleData.customer.address || 'N/A'}</div>
                    ${saleData.customer.nhima_number ? `<div><strong>NHIMA #:</strong> ${saleData.customer.nhima_number}</div>` : ''}
                    ${saleData.customer.nrc ? `<div><strong>NRC:</strong> ${saleData.customer.nrc}</div>` : ''}
                </div>
                <div class="items-list">
                    <div class="items-header"><span>ITEMS</span><span>SUBTOTAL</span></div>
                    ${saleData.items.map((item, index) => `
                        <div class="item-block">
                            <div class="item-name">${index + 1}. ${item.product_name}</div>
                            <div class="item-batch">Batch: ${cleanBatchDisplay(item.batch_number)}${item.expiry ? ` (Exp: ${item.expiry})` : ''}</div>
                            <div class="item-stats">
                                <span class="stat-group">
                                    <span>Tax ${item.tax_rate}%</span>
                                    <span>Days ${item.days_supplied || 0}</span>
                                    <span>Rate K${item.rate.toFixed(2)}</span>
                                    <span>Qty ${item.qty}</span>
                                </span>
                                <span class="item-subtotal">K${item.total.toFixed(2)}</span>
                            </div>
                        </div>
                    `).join('')}
                </div>
                <div class="totals">
                    <div class="totals-row"><span>Subtotal (Excl. Tax):</span><span>K${saleData.totals.subtotal.toFixed(2)}</span></div>
                    <div class="totals-row"><span>Total Tax:</span><span>K${saleData.totals.tax.toFixed(2)}</span></div>
                    <div class="totals-row grand-total"><span>GRAND TOTAL:</span><span>K${saleData.totals.grand_total.toFixed(2)}</span></div>
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

    // 🔥 CHANGED: prints through a hidden, off-screen <iframe> instead of
    // window.open() -- window.open() was launching a full separate
    // browser window/tab for every print (visible in the screenshots as
    // its own "Invoice - ... - Microsoft Edge" window sitting on top of
    // POS, left open after printing until manually closed), which is
    // what made printing feel like it took two steps/two windows. The
    // OS/browser print dialog itself still has to appear -- no web page
    // can silently print without it -- but there's no separate browser
    // window to see, wait for, or close: the iframe is invisible, and
    // removes itself right after the print dialog is dismissed.
    function printHTMLViaHiddenFrame(html) {
        const existing = document.getElementById('posPrintFrame');
        if (existing) existing.remove();

        const frame = document.createElement('iframe');
        frame.id = 'posPrintFrame';
        frame.style.cssText = 'position:fixed; right:0; bottom:0; width:0; height:0; border:0; visibility:hidden;';
        document.body.appendChild(frame);

        const cleanup = () => { const f = document.getElementById('posPrintFrame'); if (f) f.remove(); };
        // Safety-net removal in case the print dialog is dismissed in a
        // way that doesn't let the code below run its own cleanup (e.g.
        // the tab loses focus during a slow print job).
        const safetyTimer = setTimeout(cleanup, 60000);

        frame.onload = () => {
            try {
                frame.contentWindow.focus();
                frame.contentWindow.print();
            } catch (e) {
                console.error('Print failed:', e);
            }
            // print() blocks until the dialog is dismissed in most
            // browsers, so this runs right after -- but even where it
            // doesn't block, the browser has already snapshotted the
            // frame's content by the time print() was called, so a short
            // delay before removing it is safe either way.
            setTimeout(() => { clearTimeout(safetyTimer); cleanup(); }, 1000);
        };

        const doc = frame.contentDocument || frame.contentWindow.document;
        doc.open();
        doc.write(html);
        doc.close();
    }

    function printSale() {
        const saleData = window.currentPrintData || currentSaleData;
        if (!saleData) {
            alert('No sale data to print.');
            return;
        }
        printHTMLViaHiddenFrame(buildInvoiceHTML(saleData));
    }


    function pdfSale() {
        // "Save as PDF" is just a destination choice inside the same OS
        // print dialog -- same hidden-iframe path as printSale(), no
        // separate window needed here either.
        const saleData = window.currentPrintData || currentSaleData;
        if (!saleData) {
            alert('No sale data to generate PDF.');
            return;
        }
        printHTMLViaHiddenFrame(buildInvoiceHTML(saleData));
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
                        // 🔥 FIX: this is the actual "NHIMA number not
                        // loading" bug. loadNhimaDropdown() (called once,
                        // fired-and-forgotten, at page init -- see the
                        // Promise.all near the top of this file) populates
                        // this <select>'s <option>s from a background
                        // network request. Setting a <select>'s .value to
                        // something with no matching <option> is a SILENT
                        // no-op in every browser -- it doesn't throw, it
                        // just leaves the dropdown showing its placeholder
                        // -- which is exactly why every OTHER field below
                        // (name, NRC, phone, address, claim #) restored
                        // correctly while only this dropdown stayed blank:
                        // editing a sale soon after the page loads (before
                        // that background request finishes) or editing one
                        // whose NHIMA number was later removed from the
                        // nhima_members master list both hit this. Make
                        // sure the option exists -- inserting it on the fly
                        // if it's missing -- before selecting it, so this
                        // invoice's own saved NHIMA number always shows
                        // regardless of dropdown-load timing or whether the
                        // master list still has it.
                        const hasOption = Array.from(nhimaSelectEl.options).some(o => o.value === customer.nhima_number);
                        if (!hasOption) {
                            const opt = document.createElement('option');
                            opt.value = customer.nhima_number;
                            opt.textContent = customer.nhima_number;
                            nhimaSelectEl.appendChild(opt);
                        }
                        nhimaSelectEl.value = customer.nhima_number;
                        nhimaSelectEl.dispatchEvent(new Event('change'));
                    }
                    document.getElementById('retailCustomerName').value = customer.full_name || '';
                    document.getElementById('retailNrc').value = customer.nrc || '';
                    document.getElementById('retailPhoneNumber').value = customer.phone || '';
                    document.getElementById('retailAddress').value = customer.address || '';
                    // 🔥 FIX: loadSaleForEdit never restored the Claim Number
                    // field, so re-opening an NHIMA sale left it blank --
                    // forcing you to retype it, which then tripped the
                    // uniqueness check below (a "new" claim number that's
                    // actually just this same sale's own claim number,
                    // already in the database). Restore it from the saved
                    // customer_data, same as every other field here.
                    const claimNumberEl = document.getElementById('retailClaimNumber');
                    if (claimNumberEl) claimNumberEl.value = customer.claim_number || '';
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
                    const expiryInput = firstRow.querySelector('.retail-pos-expiry');
                    const taxInput = firstRow.querySelector('.retail-pos-tax');
                    const rateInput = firstRow.querySelector('.retail-pos-rate');
                    const qtyInput = firstRow.querySelector('.retail-pos-qty');
                    const totalInput = firstRow.querySelector('.retail-pos-total');
                    const daysInput = firstRow.querySelector('.retail-pos-days');
                    const howToTakeInput = firstRow.querySelector('.retail-pos-how-to-take');
                    const searchInput = firstRow.querySelector('.retail-pos-item-search');
                    if (searchInput) searchInput.value = '';

                    if (itemSelect) itemSelect.value = '';
                    if (batchSelect) batchSelect.innerHTML = `<option value="">Select Batch</option>`;
                    if (packInput) packInput.value = '';
                    if (expiryInput) expiryInput.value = '';
                    if (taxInput) taxInput.value = '';
                    if (rateInput) rateInput.value = '';
                    if (qtyInput) qtyInput.value = '1';
                    if (totalInput) totalInput.value = '';
                    if (daysInput) daysInput.value = '0';
                    // 🔥 FIX: also clear the structured dose state stored on the row
            // (see the Dosage Instructions modal) -- otherwise reopening the
            // modal on this now-blank row would still show the previous
            // item's ticked times/food/note.
            if (howToTakeInput) {
                howToTakeInput.value = '';
                const doseStateRow = howToTakeInput.closest('tr');
                if (doseStateRow) delete doseStateRow.dataset.doseState;
            }
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
                        // 🔥 ADDED: sets .value directly without dispatching
                        // 'change' (batch/rate are restored explicitly below
                        // from the sale's own saved data), so the search
                        // box's sync-on-change never fires here -- keep it
                        // in sync by hand, same as addAllItemsFromSale() above.
                        const searchInputEl = targetRow.querySelector('.retail-pos-item-search');
                        if (searchInputEl) searchInputEl.value = itemSelect.options[itemSelect.selectedIndex]?.text || '';
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
                    const editExpiryInput = targetRow.querySelector('.retail-pos-expiry');
                    if (editExpiryInput) {
                        const editBatchInfo = item.batch_id ? editBatchMap[item.batch_id] : null;
                        editExpiryInput.value = editBatchInfo ? new Date(editBatchInfo.expiry_date).toLocaleDateString() : '';
                    }
                    if (taxInput) taxInput.value = item.tax_rate || 0;
                    if (rateInput) rateInput.value = (item.rate || 0).toFixed(2);
                    if (qtyInput) qtyInput.value = item.qty || 1;
                    if (totalInput) totalInput.value = (item.total || 0).toFixed(2);
                    if (daysInput) daysInput.value = item.days_supplied || 0;
                    if (howToTakeInput) howToTakeInput.value = item.how_to_take || '';
                });

                updateTotals();
            }

            // 🔥 FIX: set this AFTER the client-type button click above --
            // that click fires generateNextSaleId(), which clears this same
            // flag as a side effect (see generateNextSaleId()'s comment).
            // Setting it here, once the rest of the form is already
            // populated, is what makes Save actually update this invoice
            // instead of inserting a duplicate.
            editingSaleDbId = saleData.db_id || null;

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
    if (saveBtn) saveBtn.addEventListener('click', () => saveTransaction('COMPLETED', companySettings.invoice_prefix));
    if (quoteBtn) quoteBtn.addEventListener('click', () => saveTransaction('QUOTATION', companySettings.quotation_prefix));

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

    // ============================================
    // 🔥 REMOVED: qty stepper (+/-) buttons for the item table. Cashiers
    // never used them -- qty is always typed directly -- so the buttons
    // and their click handler were removed; the HTML qty cell is now just
    // the plain .retail-pos-qty input (see index.html), still wired by the
    // 'input' listener further up exactly as before.
    // ============================================

})();
// ============================================
// 🔥 ADDED: QUEUE MODULE BRIDGE (patient token queue -> POS -> dispensing)
// ============================================
// Deliberately a SEPARATE, isolated IIFE appended after the whole POS
// script above -- it doesn't touch or wrap any of that code, so it can
// never change POS's own behaviour even if something here fails.
//
// When a cashier presses "Open in POS" on the persistent queue bar
// (assets/js/shared-queue-bar.js, visible app-wide once logged in), it
// stashes the ticket being served in sessionStorage under
// 'activeQueueTicket' and navigates here. This block:
//   1. reads that ticket and pre-selects the matching NHIMA/Regular
//      customer in the form above (same buttons/selects a person would
//      click by hand), and shows a small banner confirming which
//      patient is being served (with a manual "Send to Dispensing Now"
//      button, for cases like a quotation-only save that don't go
//      through the popup below at all),
//   2. on a completed sale, the invoice now just prints automatically
//      (no more "would you like to print?" popup -- see the save
//      handler above) and, right after, this shows a "Send to
//      Dispatch" popup instead: confirming, it advances the ticket to
//      Dispensing AND immediately calls the next waiting patient for
//      this same billing counter -- same effect as pressing "Call Next
//      Patient" on the queue bar, but without ever leaving POS. The
//      next patient's details are pre-filled into the (already reset)
//      form the same way as step 1, ready to bill straight away.
//   3. keeps the always-visible top bar (and the Dashboard's own
//      dispatch card, for Dispatch logins) in sync via the same
//      sessionStorage keys the bar itself uses, plus the
//      'queueServingChanged' event it already listens for.
//
// 🔥 ADDED: a manual "Call Next Patient" button, in the NHIMA panel
// itself, for a cashier who's already sitting on this page and wants
// to pull the next waiting billing ticket right now -- not just
// automatically after finishing a sale. Without this, the ONLY way to
// call a patient into POS was the top bar's "Call Next Patient" ->
// "Open in POS" round trip, which only actually hands the ticket to
// this page on a fresh navigation -- it does nothing if you're already
// sitting here (this file never listens for the bar's own
// 'queueServingChanged' broadcasts, only sends them). The button reuses
// the exact same callNextForThisCounter() the auto-call-next flow
// already uses below, just without a "ticket just sent" prefix on the
// toast. See the wiring right after callNextForThisCounter()'s
// definition.
// ============================================
(function initQueueBridge() {
    try {
        if (typeof supabaseClient === 'undefined') return;

        const workspaceContent = document.getElementById('workspace-content');
        if (!workspaceContent) return;

        function pollForOptionAndSelect(selectId, value, attemptsLeft) {
            if (!value || attemptsLeft <= 0) return;
            const select = document.getElementById(selectId);
            if (select) {
                const opt = Array.from(select.options).find(o => o.value === value);
                if (opt) {
                    select.value = value;
                    select.dispatchEvent(new Event('change'));
                    return;
                }
            }
            setTimeout(() => pollForOptionAndSelect(selectId, value, attemptsLeft - 1), 300);
        }

        function showQueueToast(message, muted) {
            const toast = document.createElement('div');
            toast.style.cssText = `position:fixed; top:20px; right:20px; padding:14px 22px; border-radius:8px; color:white; font-weight:500; z-index:9999; box-shadow:0 4px 12px rgba(0,0,0,0.15); background:${muted ? '#475569' : '#2563eb'}; max-width:360px;`;
            toast.textContent = message;
            document.body.appendChild(toast);
            setTimeout(() => toast.remove(), 4500);
        }

        // The ticket currently being handled in THIS pos session -- null
        // once it's been sent to dispensing or dismissed, and reassigned
        // (not re-declared) whenever "Send to Dispatch" auto-calls the
        // next patient in.
        let ticket = null;

        // ---- Pre-select the customer + show the "Serving Token #N"
        // banner for whichever ticket is current right now. ----
        function hydrateFormFromTicket(t) {
            ticket = t;
            sessionStorage.setItem('activeQueueTicket', JSON.stringify(t));

            const wantsNhima = ticket.customerType === 'NHIMA';
            const typeBtn = document.querySelector(`.retail-client-btn[data-type="${wantsNhima ? 'NHIMA' : 'REGULAR'}"]`);
            if (typeBtn) typeBtn.click();

            if (wantsNhima) {
                pollForOptionAndSelect('retailNhimaNumber', ticket.nhimaNumber, 15);
            } else {
                pollForOptionAndSelect('retailRegPhone', ticket.phone, 15);
            }

            document.getElementById('queueBridgeBanner')?.remove();
            const banner = document.createElement('div');
            banner.id = 'queueBridgeBanner';
            // 🔥 CHANGED: rounded/shadowed to match the .pos-card language
            // used everywhere else on this screen (12px radius, subtle
            // shadow) instead of the flatter 8px box this was before --
            // part of the same "looks quite rushed" cleanup as the Call
            // Next card above.
            banner.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; background:#eff6ff; border:1px solid #bfdbfe; color:#1e3a8a; padding:12px 16px; border-radius:12px; margin-bottom:16px; font-size:0.85rem; box-shadow:0 1px 3px rgba(15,23,42,0.06);';
            banner.innerHTML = `
                <span><i class="fa-solid fa-ticket" style="color:#2563eb;"></i>
                    Serving <strong>Token #${ticket.tokenNumber}</strong> -- ${ticket.patientName}.
                    Saving the sale sends them to Dispensing and calls the next patient automatically.
                </span>
                <span style="display:flex; gap:8px;">
                    <button type="button" id="queueBridgeSendBtn" class="btn btn-success btn-sm"><i class="fa-solid fa-check"></i> Send to Dispensing Now</button>
                    <button type="button" id="queueBridgeDismissBtn" class="btn btn-outline btn-sm"><i class="fa-solid fa-clock"></i> Send to Pending (No-Show)</button>
                </span>
            `;
            workspaceContent.insertAdjacentElement('afterbegin', banner);

            document.getElementById('queueBridgeSendBtn')?.addEventListener('click', async () => {
                const sent = ticket;
                await advanceCurrentTicketToDispensing();
                ticket = null;
                const b = document.getElementById('queueBridgeBanner');
                if (b) {
                    b.style.background = '#f0fdf4';
                    b.style.borderColor = '#bbf7d0';
                    b.style.color = '#065f46';
                    b.innerHTML = `<span><i class="fa-solid fa-circle-check" style="color:#059669;"></i> Token #${sent.tokenNumber} sent to the Dispensing queue.</span>`;
                    setTimeout(() => b.remove(), 4000);
                }
            });
            // 🔥 FIX: "Dismiss" used to only clear this browser tab's own
            // sessionStorage -- it never touched the database at all, so
            // the ticket stayed stuck on status='serving_billing' forever
            // (never shown as waiting, pending, or skipped anywhere,
            // effectively lost). A no-show now properly moves to
            // 'pending' via send_ticket_to_pending() -- visible in the
            // Pending (No-Show) list on the CRM registration screen,
            // where staff recall the patient as PRIORITY the moment they
            // actually turn up -- and immediately calls the next waiting
            // billing patient into this same counter, same as finishing
            // a sale does.
            document.getElementById('queueBridgeDismissBtn')?.addEventListener('click', async () => {
                if (!ticket) return;
                if (!confirm(`Send Token #${ticket.tokenNumber} (${ticket.patientName}) to Pending? They'll be off this counter and can be recalled as priority once they arrive.`)) return;
                const dismissed = ticket;
                try {
                    await supabaseClient.rpc('send_ticket_to_pending', { p_ticket_id: dismissed.id });
                } catch (e) {
                    console.warn('Queue bridge: could not send ticket to pending:', e);
                }
                sessionStorage.removeItem('activeQueueTicket');
                document.getElementById('queueBridgeBanner')?.remove();
                ticket = null;
                showQueueToast(`Token #${dismissed.tokenNumber} sent to Pending. `, true);
                await callNextForThisCounter(null);
            });
        }

        async function advanceCurrentTicketToDispensing() {
            if (!ticket) return;
            try {
                await supabaseClient.rpc('complete_billing_ticket', { p_ticket_id: ticket.id });
            } catch (e) {
                console.warn('Queue bridge: could not advance ticket to dispensing:', e);
            }
            sessionStorage.removeItem('activeQueueTicket');
        }

        // ---- "Send to Dispatch" popup, shown right after a completed
        // sale finishes printing (replaces the old print-confirmation
        // popup -- see the save handler above and the repurposed
        // #retailPrintModal shell it drives). ----
        function showSendToDispatchPopup() {
            if (!ticket) return;
            const modalEl = document.getElementById('retailPrintModal');
            const yesBtn = document.getElementById('retailPrintYesBtn');
            const noBtn = document.getElementById('retailPrintNoBtn');
            if (!modalEl || !yesBtn || !noBtn) return;

            const iconEl = modalEl.querySelector('i.fa-solid');
            const titleEl = modalEl.querySelector('h3');
            const messageEl = modalEl.querySelector('p');
            if (iconEl) iconEl.className = 'fa-solid fa-bell';
            if (titleEl) titleEl.textContent = 'Sale Saved!';
            if (messageEl) messageEl.textContent = `Send Token #${ticket.tokenNumber} (${ticket.patientName}) to Dispensing and call the next patient?`;
            modalEl.style.display = 'flex';

            // Strip any previously-attached handlers -- this popup can
            // show more than once per page load (several sales in a row
            // without navigating away).
            const newYesBtn = yesBtn.cloneNode(true);
            const newNoBtn = noBtn.cloneNode(true);
            yesBtn.parentNode.replaceChild(newYesBtn, yesBtn);
            noBtn.parentNode.replaceChild(newNoBtn, noBtn);
            newYesBtn.innerHTML = '<i class="fa-solid fa-forward"></i> Send to Dispatch';
            newNoBtn.textContent = 'Not Now';

            newYesBtn.onclick = async function () {
                modalEl.style.display = 'none';
                const sent = ticket;
                await advanceCurrentTicketToDispensing();
                document.getElementById('queueBridgeBanner')?.remove();
                ticket = null;
                await callNextForThisCounter(sent);
            };
            newNoBtn.onclick = function () {
                modalEl.style.display = 'none';
            };
        }

        // ---- Call the next waiting billing ticket for this counter --
        // same RPC + same sessionStorage/event sync the persistent queue
        // bar uses, so the bar (and the Dashboard's dispatch card) update
        // immediately without a page reload. Used both automatically
        // (right after a sale is sent to Dispensing, with justSentTicket
        // set -- see showSendToDispatchPopup() above) and manually (the
        // "Call Next Patient" button wired just below, with
        // justSentTicket left null). ----
        async function callNextForThisCounter(justSentTicket) {
            const counter = sessionStorage.getItem('staffCounter');
            const prefix = justSentTicket ? `Token #${justSentTicket.tokenNumber} sent to Dispensing. ` : '';

            if (!counter) {
                showQueueToast(justSentTicket
                    ? `${prefix}`.trim()
                    : `You're not logged in to a billing counter -- pick one from the queue bar at the top first.`, !justSentTicket);
                return; // this login isn't working a billing counter -- nothing to call
            }

            try {
                const { data: nextTicket, error } = await supabaseClient.rpc('call_next_ticket', { p_stage: 'billing', p_counter: counter });
                if (error) throw error;

                if (nextTicket) {
                    sessionStorage.setItem('queueServingTicket_billing', JSON.stringify(nextTicket));
                } else {
                    sessionStorage.removeItem('queueServingTicket_billing');
                }
                window.dispatchEvent(new CustomEvent('queueServingChanged', { detail: { stage: 'billing', ticket: nextTicket || null } }));

                if (nextTicket) {
                    showQueueToast(`${prefix}Now serving Token #${nextTicket.token_number} -- ${nextTicket.patient_name}.`);
                    hydrateFormFromTicket({
                        id: nextTicket.id,
                        tokenNumber: nextTicket.token_number,
                        patientName: nextTicket.patient_name,
                        customerId: nextTicket.customer_id,
                        customerType: nextTicket.customer_type,
                        phone: nextTicket.phone,
                        nhimaNumber: nextTicket.nhima_number
                    });
                } else {
                    showQueueToast(`${prefix}No more patients waiting for billing right now.`);
                }
            } catch (e) {
                console.warn('Queue bridge: could not call next patient:', e);
                showQueueToast(`${prefix}Could not call the next patient -- try again, or use the queue bar at the top.`, true);
            }
        }

        // ---- Manual "Call Next Patient" button (NHIMA panel) -- see
        // the "ADDED" note at the top of this IIFE. Wired unconditionally
        // (not gated behind an incoming activeQueueTicket like the INIT
        // block below), and only actually shown when this login is
        // working a real billing counter. ----
        (function initManualCallNextButton() {
            const wrap = document.getElementById('retailCallNextWrap');
            const btn = document.getElementById('retailCallNextBtn');
            const btnLabel = document.getElementById('retailCallNextBtnLabel');
            const waitingBadge = document.getElementById('retailCallNextWaitingBadge');
            if (!wrap || !btn) return;

            const myCounter = sessionStorage.getItem('staffCounter');
            const isBillingCounter = myCounter === 'Counter 1' || myCounter === 'Counter 2' || myCounter === 'Counter 3';
            if (!isBillingCounter) {
                wrap.style.display = 'none';
                return;
            }
            wrap.style.display = 'block';

            async function loadBillingWaitingCount() {
                try {
                    const today = new Date().toISOString().split('T')[0];
                    const { count, error } = await supabaseClient
                        .from('queue_tickets')
                        .select('id', { count: 'exact', head: true })
                        .eq('queue_date', today)
                        .eq('status', 'waiting_billing');
                    if (error) throw error;
                    if (waitingBadge) waitingBadge.textContent = `${count || 0} waiting`;
                } catch (e) {
                    console.warn('Could not load billing waiting count:', e);
                }
            }
            loadBillingWaitingCount();

            // Window-handler-replace pattern (same as the Dashboard's
            // dispatch card) -- this script can be injected more than once
            // per page load (re-navigating into Retail POS), so swap out
            // any previous listener instead of stacking duplicates on
            // `window`.
            if (window.__retailCallNextWaitingHandler) {
                window.removeEventListener('queueWaitingCountChanged', window.__retailCallNextWaitingHandler);
            }
            window.__retailCallNextWaitingHandler = function (e) {
                if (e.detail && e.detail.stage === 'billing' && waitingBadge) {
                    waitingBadge.textContent = `${e.detail.count} waiting`;
                }
            };
            window.addEventListener('queueWaitingCountChanged', window.__retailCallNextWaitingHandler);

            btn.addEventListener('click', async () => {
                if (ticket) {
                    showQueueToast(`You're already serving Token #${ticket.tokenNumber} -- send them to Dispensing or Dismiss first.`, true);
                    return;
                }
                btn.disabled = true;
                if (btnLabel) btnLabel.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Calling...';
                try {
                    await callNextForThisCounter(null);
                } finally {
                    btn.disabled = false;
                    if (btnLabel) btnLabel.innerHTML = '<i class="fa-solid fa-forward"></i> Call Next Patient';
                }
            });
        })();

        // ---- INIT: only do anything if this POS session actually
        // started from "Open in POS" on the queue bar. ----
        const raw = sessionStorage.getItem('activeQueueTicket');
        if (!raw) return;
        let initialTicket;
        try { initialTicket = JSON.parse(raw); } catch (e) { sessionStorage.removeItem('activeQueueTicket'); return; }
        if (!initialTicket || !initialTicket.id) return;

        hydrateFormFromTicket(initialTicket);

        // 🔥 Generic hook core POS calls unconditionally after every
        // completed, non-quotation save (see the save handler above) --
        // a no-op unless there's still an active ticket at that moment
        // (e.g. it wasn't already sent manually via the banner's own
        // "Send to Dispensing Now" button).
        window.__onRetailSaleSaved = function () {
            showSendToDispatchPopup();
        };
    } catch (e) {
        console.warn('Queue bridge init failed (non-fatal, POS unaffected):', e);
    }
})();

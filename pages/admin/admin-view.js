// ============================================
// ADMIN VIEW -- combined host for Clients + Invoicing Settings
// ============================================
// Loaded by app.js's loadModule('admin') every time the Admin module is
// opened. This single file replaces what used to be 2 separate
// pages/admin/clients/ and pages/admin/invoicing/ folders (each its own
// index.html+index.js pair, fetched on demand via loadSubModule) -- both
// sections now live in this one pair of files (admin-view.html/js)
// instead, cutting the number of files needed for the admin panel.
//
// Category/Brand/Supplier deliberately stay as their OWN separate
// pages/admin/<name>/ folders, NOT merged in here -- Inventory's own
// sidebar also links straight to those 3 (loadSubModule('admin',
// 'category'/'brand'/'supplier')) so Manager/Pharmacist/Cashier/Staff,
// who have Inventory access but not Admin access, can still reach them.
// Folding them into this file would make that link 404 for those roles
// (there'd be no separate folder left to fetch), cutting off pages they
// currently use.
//
// SECTION SWITCHING: admin-menu.html's Clients / Invoicing Settings
// links don't call loadSubModule (there's no folder to fetch for
// either). They set window.__adminDesiredSection then call
// loadModule('admin') again, which re-fetches this same admin-view
// pair (small, cheap) and re-runs everything below, which reads that
// flag to decide which section to reveal. Always going through
// loadModule('admin') again -- rather than trying to just toggle
// existing DOM -- is what makes this work correctly even after
// navigating away to e.g. User Accounts (which replaces this entire
// view via loadSubModule): there's no stale DOM to find, this view is
// rebuilt fresh every time either link is clicked.

function showAdminSection(name) {
    ['clients', 'invoicing'].forEach(key => {
        const el = document.getElementById(`adminSection-${key}`);
        if (el) el.style.display = (key === name) ? 'block' : 'none';
    });
    const placeholder = document.getElementById('adminSectionPlaceholder');
    if (placeholder) placeholder.style.display = 'none';
}
window.showAdminSection = showAdminSection;

(function initAdminViewSectionSwitch() {
    // Runs synchronously, before either section's own async init below
    // has a chance to do anything -- so the right section (or neither,
    // on a fresh/plain entry into Admin) is visible immediately, no
    // flash of the wrong content.
    const desired = window.__adminDesiredSection;
    window.__adminDesiredSection = null;
    if (desired) showAdminSection(desired);
})();

// ============================================
// CLIENTS SECTION LOGIC
// ============================================
// Full list + edit for every row in `customers`. Before this existed, a
// customer's details could only be created (CRM registration, Retail
// POS "+" quick-add) or seen in passing (POS lookup, client history) --
// there was nowhere to fix a typo'd phone number, correct an NHIMA
// number, or update an address after the fact. This is that page.
(async function initClientsSection() {
    console.log("Admin > Clients section initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    const PAGE_SIZE = 25;
    let currentPage = 0;
    let currentSearch = '';
    let searchDebounceTimer = null;

    const tbody = document.getElementById('clientsTableBody');
    const searchInput = document.getElementById('clientsSearchInput');
    const resultCount = document.getElementById('clientsResultCount');
    const prevBtn = document.getElementById('clientsPrevBtn');
    const nextBtn = document.getElementById('clientsNextBtn');

    const modal = document.getElementById('clientModal');
    const modalTitle = document.getElementById('clientModalTitle');
    const addBtn = document.getElementById('clientsAddBtn');
    const closeBtn = document.getElementById('closeClientModalBtn');
    const cancelBtn = document.getElementById('cancelClientBtn');
    const form = document.getElementById('clientForm');
    const submitBtn = document.getElementById('saveClientBtn');
    const errorBox = document.getElementById('clientFormError');
    const hiddenId = document.getElementById('clientId');

    await loadClients();

    // ============================================
    // SEARCH (debounced -- avoids a query on every keystroke)
    // ============================================
    searchInput.addEventListener('input', () => {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
            currentSearch = searchInput.value.trim();
            currentPage = 0;
            loadClients();
        }, 300);
    });

    prevBtn.addEventListener('click', () => {
        if (currentPage > 0) {
            currentPage--;
            loadClients();
        }
    });
    nextBtn.addEventListener('click', () => {
        currentPage++;
        loadClients();
    });

    // ============================================
    // MODAL OPEN/CLOSE
    // ============================================
    function openModal(title, btnText) {
        modal.style.display = 'flex';
        modalTitle.innerHTML = `<i class="fa-solid fa-user-pen" style="color: #2563eb;"></i> ${title}`;
        submitBtn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> ${btnText}`;
        errorBox.style.display = 'none';
    }

    function closeModal() {
        modal.style.display = 'none';
        form.reset();
        hiddenId.value = '';
        errorBox.style.display = 'none';
    }

    addBtn.addEventListener('click', () => {
        openModal('Add New Client', 'Save Client');
        document.getElementById('clientType').value = 'NHIMA';
    });
    closeBtn.addEventListener('click', closeModal);
    cancelBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    // ============================================
    // EDIT -- load one client's full record into the form
    // ============================================
    window.editClient = async function(clientId) {
        try {
            const { data: client, error } = await supabaseClient
                .from('customers')
                .select('*')
                .eq('id', clientId)
                .single();

            if (error) throw error;

            openModal('Edit Client', 'Update Client');
            hiddenId.value = client.id;
            document.getElementById('clientType').value = client.customer_type || 'NHIMA';
            document.getElementById('clientFullName').value = client.full_name || '';
            document.getElementById('clientPhone').value = client.phone || '';
            document.getElementById('clientNrc').value = client.nrc || '';
            document.getElementById('clientNhima').value = client.nhima_number || '';
            document.getElementById('clientAddress').value = client.address || '';
            document.getElementById('clientOpeningBalance').value = client.opening_balance_zmw || 0;
        } catch (error) {
            console.error('Error loading client:', error);
            showToast('Error loading client: ' + error.message, 'error');
        }
    };

    // ============================================
    // SAVE (add or update)
    // ============================================
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errorBox.style.display = 'none';

        const isEditing = hiddenId.value !== '';
        const formData = {
            customer_type: document.getElementById('clientType').value,
            full_name: document.getElementById('clientFullName').value.trim(),
            phone: document.getElementById('clientPhone').value.trim() || null,
            nrc: document.getElementById('clientNrc').value.trim() || null,
            nhima_number: document.getElementById('clientNhima').value.trim() || null,
            address: document.getElementById('clientAddress').value.trim() || null,
            opening_balance_zmw: parseFloat(document.getElementById('clientOpeningBalance').value) || 0
        };

        if (!formData.full_name) {
            errorBox.textContent = 'Full Name is required.';
            errorBox.style.display = 'block';
            return;
        }
        if (formData.customer_type === 'NHIMA' && !formData.nhima_number) {
            errorBox.textContent = 'NHIMA Number is required for NHIMA clients.';
            errorBox.style.display = 'block';
            return;
        }

        submitBtn.disabled = true;
        const originalHtml = submitBtn.innerHTML;
        submitBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;

        try {
            if (isEditing) {
                const { error } = await supabaseClient
                    .from('customers')
                    .update(formData)
                    .eq('id', hiddenId.value);
                if (error) throw error;
                showToast('Client updated successfully!', 'success');
            } else {
                const { error } = await supabaseClient
                    .from('customers')
                    .insert([formData]);
                if (error) throw error;
                showToast('Client added successfully!', 'success');
            }

            closeModal();
            await loadClients();
        } catch (error) {
            console.error('Error saving client:', error);
            errorBox.textContent = 'Error saving client: ' + error.message;
            errorBox.style.display = 'block';
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalHtml;
        }
    });

    // ============================================
    // LOAD + RENDER (paginated, optionally filtered)
    // ============================================
    async function loadClients() {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 30px; color: #94a3b8;"><i class="fa-solid fa-spinner fa-spin"></i> Loading clients...</td></tr>`;

        try {
            let query = supabaseClient
                .from('customers')
                .select('*', { count: 'exact' });

            if (currentSearch) {
                // Search across every field a cashier is likely to have on
                // hand when looking someone up -- name, phone, NRC, NHIMA #.
                const term = currentSearch.replace(/[%_]/g, '\\$&');
                query = query.or(
                    `full_name.ilike.%${term}%,phone.ilike.%${term}%,nrc.ilike.%${term}%,nhima_number.ilike.%${term}%`
                );
            }

            const from = currentPage * PAGE_SIZE;
            const to = from + PAGE_SIZE - 1;
            query = query.order('full_name', { ascending: true }).range(from, to);

            const { data: clients, error, count } = await query;
            if (error) throw error;

            renderClients(clients || []);

            const total = count || 0;
            const shownFrom = total === 0 ? 0 : from + 1;
            const shownTo = Math.min(from + PAGE_SIZE, total);
            resultCount.textContent = total === 0 ? 'No clients found.' : `Showing ${shownFrom}-${shownTo} of ${total}`;
            prevBtn.disabled = currentPage === 0;
            nextBtn.disabled = shownTo >= total;
        } catch (error) {
            console.error('Error loading clients:', error);
            tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 30px; color: #dc2626;">Error loading clients: ${error.message}</td></tr>`;
        }
    }

    function renderClients(clients) {
        if (clients.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 30px; color: #94a3b8;">No clients found. ${currentSearch ? 'Try a different search.' : 'Click "Add Client" to get started!'}</td></tr>`;
            return;
        }

        tbody.innerHTML = clients.map(c => `
            <tr>
                <td style="padding-left: 20px; font-weight: 600;">${escapeHtml(c.full_name || 'N/A')}</td>
                <td>${badgeForType(c.customer_type)}</td>
                <td>${escapeHtml(c.phone || '—')}</td>
                <td>${escapeHtml(c.nrc || '—')}</td>
                <td>${escapeHtml(c.nhima_number || '—')}</td>
                <td style="max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(c.address || '—')}</td>
                <td style="text-align: right; padding-right: 20px;">
                    <button onclick="editClient('${c.id}')" style="background: none; border: none; color: #3b82f6; cursor: pointer;" title="Edit">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                </td>
            </tr>
        `).join('');
    }

    function badgeForType(type) {
        const colors = {
            NHIMA: { bg: '#eff6ff', fg: '#2563eb' },
            REGULAR: { bg: '#f0fdf4', fg: '#16a34a' },
            ONLINE: { bg: '#fdf4ff', fg: '#a21caf' },
            STAFF: { bg: '#fff7ed', fg: '#c2410c' }
        };
        const c = colors[type] || { bg: '#f1f5f9', fg: '#475569' };
        return `<span style="background:${c.bg}; color:${c.fg}; padding: 2px 9px; border-radius: 10px; font-size: 0.72rem; font-weight: 700;">${escapeHtml(type || 'N/A')}</span>`;
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = String(str);
        return div.innerHTML;
    }
})();

// ============================================
// INVOICING SETTINGS SECTION LOGIC
// ============================================
// Edits the single `company_settings` row (id=1) that
// assets/js/shared-company-settings.js reads app-wide. See that file's
// header comment for the full picture of who consumes this data.
(async function initInvoicingSettingsSection() {
    console.log("Admin > Invoicing Settings section initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    const fieldMap = {
        invCompanyName: 'company_name',
        invAddress: 'address',
        invPhone: 'phone',
        invEmail: 'email',
        invZamra: 'zamra_number',
        invInvoicePrefix: 'invoice_prefix',
        invQuotationPrefix: 'quotation_prefix',
        invWholesalePrefix: 'wholesale_prefix',
        invPurchasePrefix: 'purchase_order_prefix',
        invDonationPrefix: 'donation_prefix',
        invWriteoffPrefix: 'writeoff_prefix',
        invDefaultTax: 'default_tax_percent',
        invDefaultTerms: 'default_payment_terms'
    };

    await loadSettingsIntoForm();

    document.getElementById('invSaveSettingsBtn').addEventListener('click', saveSettings);

    async function loadSettingsIntoForm() {
        // 🔥 CHANGED: this used to bypass a shared page-lifetime cache
        // (assets/js/shared-company-settings.js's getCompanySettings()/
        // invalidateCompanySettingsCache()) so this form always showed
        // exactly what's in the DB. That shared file no longer exists on
        // the site, so calling it threw "getCompanySettings is not
        // defined" and this section never loaded. Self-contained now:
        // queries the `company_settings` row directly -- there's no
        // shared cache to bypass any more, so this is naturally always
        // fresh from the DB already.
        const { data: settings, error } = await supabaseClient
            .from('company_settings')
            .select('*')
            .eq('id', 1)
            .maybeSingle();

        if (error || !settings) {
            console.warn('Could not load company_settings:', error);
            return;
        }

        Object.entries(fieldMap).forEach(([elId, field]) => {
            const el = document.getElementById(elId);
            if (el) el.value = settings[field] ?? '';
        });
    }

    async function saveSettings() {
        const btn = document.getElementById('invSaveSettingsBtn');
        const savedNote = document.getElementById('invSettingsSavedNote');
        const companyNameEl = document.getElementById('invCompanyName');

        if (!companyNameEl.value.trim()) {
            showToast('Company Name is required.', 'error');
            companyNameEl.focus();
            return;
        }

        // Prefixes feed straight into a document number string
        // (PREFIX-YEAR-...) -- keep them short, uppercase, and free of
        // spaces/dashes so a saved prefix can never itself contain the
        // separator the number format relies on.
        const prefixIds = ['invInvoicePrefix', 'invQuotationPrefix', 'invWholesalePrefix', 'invPurchasePrefix', 'invDonationPrefix', 'invWriteoffPrefix'];
        for (const id of prefixIds) {
            const el = document.getElementById(id);
            const cleaned = (el.value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
            if (!cleaned) {
                showToast('Every document prefix must have a value (letters/numbers only).', 'error');
                el.focus();
                return;
            }
            el.value = cleaned;
        }

        const payload = { id: 1 };
        Object.entries(fieldMap).forEach(([elId, field]) => {
            const el = document.getElementById(elId);
            let val = el.value;
            if (field === 'default_tax_percent') val = parseFloat(val) || 0;
            payload[field] = val;
        });
        payload.updated_at = new Date().toISOString();

        btn.disabled = true;
        const originalHtml = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';

        try {
            const { error } = await supabaseClient
                .from('company_settings')
                .upsert(payload, { onConflict: 'id' });

            if (error) throw error;

            // 🔥 CHANGED: this used to clear a shared page-lifetime cache
            // (assets/js/shared-company-settings.js) so this page's own
            // next read was honest. That shared file no longer exists --
            // every module now queries `company_settings` directly with no
            // cache in front of it, so there's nothing to invalidate here
            // any more; each module already sees this save on its own next
            // load.
            showToast('Invoicing settings saved.', 'success');
            savedNote.style.display = 'inline';
            setTimeout(() => { savedNote.style.display = 'none'; }, 2500);
        } catch (err) {
            console.error('Error saving company settings:', err);
            showToast('Error saving settings: ' + err.message, 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = originalHtml;
        }
    }
})();

// ============================================
// SHARED TOAST HELPER (used by both sections above)
// ============================================
function showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    if (!container) { alert(message); return; }
    const toast = document.createElement('div');
    const bg = type === 'error' ? '#dc2626' : (type === 'warning' ? '#f59e0b' : '#059669');
    toast.style.cssText = `background:${bg}; color:white; padding:12px 18px; border-radius:8px; margin-top:8px; box-shadow:0 4px 12px rgba(0,0,0,0.15); font-size:0.85rem; max-width:360px;`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3500);
}
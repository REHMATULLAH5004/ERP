// ============================================
// CRM MODULE -- NHIMA PATIENT REGISTRATION + TOKEN ISSUE
// ============================================
// Reuses the SAME `customers` table Retail POS reads/writes, so a
// patient registered here is immediately a real customer POS can
// bill. Registering just adds one extra step on top: issue_queue_token()
// (see database/queue_module_schema.sql) atomically hands out the next
// token number for today and creates the queue_tickets row that the
// global "Call Next" bar (assets/js/shared-queue-bar.js, visible on
// every screen) and the TV display board both read from.
//
// 🔥 CHANGED: this module is NHIMA-only now -- the earlier "Cash /
// Regular Patient" and "NRC Patient" tabs are gone. What's different
// from Retail POS is HOW an existing patient is found:
//   - Retail POS looks patients up by NHIMA number, which is
//     guaranteed unique to one person.
//   - Here, NRC Number is the "source" field instead -- but NRC is
//     NOT guaranteed unique to one person (two different patients can
//     legitimately share an NRC), so a bare NRC match is not enough
//     proof it's the same patient. See ensurePatientCustomer() below
//     for how this is handled: an NRC match only counts as "the same
//     patient" when the full name also matches; otherwise a fresh
//     record is created (even if it shares an NRC with someone
//     already on file).
// NHIMA Number is still collected and required (needed for claims),
// and still written to `nhima_members` (ensureNhimaMemberRow, kept
// unchanged below) since Retail POS's own lookup flow depends on that
// table -- it's just no longer what identifies a returning patient on
// this page.
// ============================================

(function initCrmRegister() {
    const container = document.getElementById('crmRegisterContainer');
    if (container) {
        if (container.dataset.init === 'true') {
            console.warn('⚠️ CRM Register already initialized for this container -- skipping duplicate init.');
            return;
        }
        container.dataset.init = 'true';
    }

    if (typeof supabaseClient === 'undefined') {
        console.error('❌ supabaseClient is not defined.');
        return;
    }

    const PHARMACY_NAME = 'Griffins Medicals Limited';

    // ---- DOM refs ----
    const form = document.getElementById('crmRegisterForm');

    const nrcInput = document.getElementById('qregNrc');
    const nrcMatchHint = document.getElementById('qregNrcMatchHint');
    const nrcMatchWrap = document.getElementById('qregNrcMatchWrap');
    const nrcMatchSelect = document.getElementById('qregNrcMatchSelect');
    const fullNameInput = document.getElementById('qregFullName');
    const nhimaNumberInput = document.getElementById('qregNhimaNumber');
    const phoneInput = document.getElementById('qregPhone');
    const addressInput = document.getElementById('qregAddress');

    const submitBtn = document.getElementById('qregSubmitBtn');
    const formError = document.getElementById('qregFormError');

    const tokenCard = document.getElementById('qregTokenCard');
    const tokenNumberEl = document.getElementById('qregTokenNumber');
    const tokenNameEl = document.getElementById('qregTokenName');
    const tokenMetaEl = document.getElementById('qregTokenMeta');
    const printBtn = document.getElementById('qregPrintBtn');
    const newBtn = document.getElementById('qregNewBtn');

    const priorityCheckbox = document.getElementById('qregPriority');

    const recentList = document.getElementById('qregRecentList');
    const pendingList = document.getElementById('qregPendingList');

    let lastIssuedTicket = null;

    // ============================================
    // FORMAT VALIDATION + AUTO PROPER-CASE
    // -- same rules as Retail POS's "Add NHIMA Member" / "Add Customer"
    // modals (pages/transaction/retail/index.js), kept in sync here
    // because THIS form is the main gate most patients are actually
    // registered through. Client-side rules alone can't be fully
    // trusted (stale/cached code can bypass them), so the database
    // also has matching CHECK constraints on customers/nhima_members
    // as a backstop -- but this still gives staff a clear, friendly
    // message instead of a raw database error.
    //   - NHIMA Number: 14 digits + "/" + 2 digits, OR "NHA" + 13
    //     digits + "/" + 2 digits.
    //   - NRC: 6 digits + "/" + 2 digits + "/" + 1 digit.
    //   - Phone: fixed +260 country code + exactly 9 digits, optional here.
    //   - Name: letters only (spaces/hyphens/apostrophes/periods allowed).
    const ZM_PHONE_DIGITS = 9;
    const NRC_REGEX = /^\d{6}\/\d{2}\/\d$/;
    const NHIMA_REGEX = /^(?:\d{14}\/\d{2}|NHA\d{13}\/\d{2})$/;
    const NAME_REGEX = /^[A-Za-z][A-Za-z '.-]*$/;

    function toProperCaseIfAllCaps(str) {
        if (!str) return str;
        const trimmed = str.trim();
        if (trimmed.length > 2 && trimmed === trimmed.toUpperCase() && trimmed !== trimmed.toLowerCase()) {
            return trimmed.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
        }
        return str;
    }

    function sanitizeNameInput(el) {
        if (!el) return;
        el.addEventListener('input', () => {
            const cleaned = el.value.replace(/[^A-Za-z '.-]/g, '');
            if (cleaned !== el.value) el.value = cleaned;
        });
    }

    function sanitizePhoneDigitsInput(el) {
        if (!el) return;
        el.addEventListener('input', () => {
            const digits = el.value.replace(/\D/g, '').slice(0, ZM_PHONE_DIGITS);
            if (digits !== el.value) el.value = digits;
        });
    }

    function sanitizeNrcInput(el) {
        if (!el) return;
        el.addEventListener('input', () => {
            const digits = el.value.replace(/\D/g, '').slice(0, 9); // 6 + 2 + 1
            let formatted = digits.slice(0, 6);
            if (digits.length > 6) formatted += '/' + digits.slice(6, 8);
            if (digits.length > 8) formatted += '/' + digits.slice(8, 9);
            el.value = formatted;
        });
    }

    function validateNameValue(value, fieldLabel) {
        const trimmed = (value || '').trim();
        if (!trimmed) return null; // required-ness is checked separately
        if (!NAME_REGEX.test(trimmed)) {
            return `${fieldLabel} can only contain letters, no numbers -- got "${value}"`;
        }
        return null;
    }

    function validateNrcValue(value) {
        const trimmed = (value || '').trim();
        if (!trimmed) return null;
        if (!NRC_REGEX.test(trimmed)) {
            return `NRC must be in the format 123456/78/9 (6 digits / 2 digits / 1 digit) -- got "${value}"`;
        }
        return null;
    }

    function validateNhimaNumberValue(value) {
        const trimmed = (value || '').trim().toUpperCase();
        if (!NHIMA_REGEX.test(trimmed)) {
            return `NHIMA Number must be 14 digits + "/" + 2 digits (e.g. 49310691110129/00), or "NHA" + 13 digits + "/" + 2 digits -- got "${value}"`;
        }
        return null;
    }

    function buildZmPhone(digitsValue) {
        const digits = (digitsValue || '').replace(/\D/g, '');
        return digits ? `+260${digits}` : '';
    }

    function validatePhoneDigitsValue(digitsValue, required) {
        const digits = (digitsValue || '').replace(/\D/g, '');
        if (!digits) {
            return required ? 'Phone Number is required' : null;
        }
        if (digits.length !== ZM_PHONE_DIGITS) {
            return `Phone Number must be exactly ${ZM_PHONE_DIGITS} digits after +260 (e.g. 971234567) -- got ${digits.length} digit(s)`;
        }
        return null;
    }

    sanitizeNameInput(fullNameInput);
    sanitizeNrcInput(nrcInput);
    sanitizePhoneDigitsInput(phoneInput);

    // `selectedCustomerId` tracks whether the dropdown below currently
    // points at a real, already-registered patient. When set, submit
    // UPDATES that customer's record instead of creating a new one.
    // It's cleared whenever the NRC changes (the old dropdown no
    // longer applies) or the user explicitly picks "New patient".
    let selectedCustomerId = null;
    let nrcCandidates = [];

    // ============================================
    // NRC LOOKUP -- as the NRC is typed, find any patients
    // already on file under it and offer them in a dropdown
    // so staff can pick the returning patient (edit their
    // record) instead of typing everything again. If none
    // match, or "New patient" stays selected, registration
    // just continues as a brand-new record.
    // ============================================
    let nrcLookupTimer = null;
    nrcInput.addEventListener('input', function () {
        selectedCustomerId = null;
        clearTimeout(nrcLookupTimer);
        nrcLookupTimer = setTimeout(checkNrcMatch, 400);
    });

    async function checkNrcMatch() {
        const nrc = nrcInput.value.trim();
        nrcMatchHint.style.display = 'none';
        nrcMatchWrap.style.display = 'none';
        nrcMatchSelect.innerHTML = '<option value="">-- New patient (not in the list below) --</option>';
        nrcCandidates = [];
        if (!nrc) return;

        try {
            // Deliberately NOT .maybeSingle() -- NRC can be shared by
            // more than one patient, so more than one row can come
            // back here. See the comment above ensurePatientCustomer().
            const { data, error } = await supabaseClient
                .from('customers')
                .select('id, full_name, address, phone, nhima_number')
                .eq('nrc', nrc);
            if (error) throw error;

            if (!data || data.length === 0) {
                nrcMatchHint.textContent = 'New patient -- a record will be created.';
                nrcMatchHint.style.color = '#64748b';
                nrcMatchHint.style.display = 'block';
                return;
            }

            nrcCandidates = data;
            data.forEach(c => {
                const opt = document.createElement('option');
                opt.value = c.id;
                const bits = [c.nhima_number ? `NHIMA ${c.nhima_number}` : null, (c.phone && !c.phone.startsWith('NRC-')) ? c.phone : null].filter(Boolean);
                opt.textContent = c.full_name + (bits.length ? ' -- ' + bits.join(', ') : '');
                nrcMatchSelect.appendChild(opt);
            });
            nrcMatchWrap.style.display = 'block';

            nrcMatchHint.textContent = data.length === 1
                ? `1 existing record is on file for this NRC -- select it above if this is the same patient, or leave "New patient" if it's someone else.`
                : `${data.length} existing records are on file for this NRC -- select the matching patient above, or leave "New patient" if it's someone else.`;
            nrcMatchHint.style.color = '#b45309';
            nrcMatchHint.style.display = 'block';
        } catch (e) {
            console.warn('NRC lookup failed:', e);
        }
    }

    nrcMatchSelect.addEventListener('change', function () {
        const id = this.value;
        if (!id) {
            // "New patient" -- don't carry over anyone else's details.
            selectedCustomerId = null;
            fullNameInput.value = '';
            nhimaNumberInput.value = '';
            phoneInput.value = '';
            addressInput.value = '';
            nrcMatchHint.textContent = 'New patient -- a record will be created.';
            nrcMatchHint.style.color = '#64748b';
            nrcMatchHint.style.display = 'block';
            return;
        }

        const match = nrcCandidates.find(c => String(c.id) === String(id));
        if (!match) return;

        selectedCustomerId = match.id;
        fullNameInput.value = match.full_name || '';
        addressInput.value = match.address || '';
        // A synthetic "NRC-..." phone (see ensurePatientCustomer below)
        // was never a real phone number, so don't load it back into the
        // optional Phone field as if it were. The field itself only holds
        // the digits after +260 (the prefix is a fixed label beside it),
        // so strip that prefix back off a real stored number.
        phoneInput.value = (match.phone && !match.phone.startsWith('NRC-')) ? match.phone.replace(/^\+260/, '') : '';
        if (match.nhima_number) nhimaNumberInput.value = match.nhima_number;
        nrcMatchHint.textContent = '✓ Existing patient loaded -- editing their record.';
        nrcMatchHint.style.color = '#059669';
        nrcMatchHint.style.display = 'block';
    });

    // ============================================
    // FIND-OR-CREATE CUSTOMER
    // ============================================
    // NRC is the "source" field here, but -- unlike NHIMA number -- it
    // isn't guaranteed unique to one person, so a bare NRC match isn't
    // enough to safely say "this is the same patient". The dropdown
    // above is the primary way staff confirm that (selectedCustomerId);
    // if it's set, this just updates that exact record. Otherwise --
    // e.g. the dropdown lookup hadn't finished, or was left on "New
    // patient" -- fall back to requiring BOTH the NRC and the full name
    // to line up before reusing a record; anything short of that
    // creates a fresh one (even if it shares an NRC with someone
    // already on file).
    async function ensurePatientCustomer({ selectedCustomerId, fullName, phone, address, nrc, nhimaNumber }) {
        if (selectedCustomerId) {
            const updates = { full_name: fullName || 'Unknown Patient' };
            if (phone) updates.phone = phone;
            if (address) updates.address = address;
            if (nhimaNumber) updates.nhima_number = nhimaNumber;
            if (nrc) updates.nrc = nrc;

            const { data: updated, error: updateError } = await supabaseClient
                .from('customers')
                .update(updates)
                .eq('id', selectedCustomerId)
                .select()
                .single();
            if (updateError) throw updateError;
            return { id: updated.id, full_name: updated.full_name, phone: updated.phone };
        }

        const { data: candidates } = await supabaseClient
            .from('customers')
            .select('id, full_name')
            .eq('nrc', nrc);

        const nameMatch = (candidates || []).find(
            c => (c.full_name || '').trim().toLowerCase() === fullName.trim().toLowerCase()
        );
        if (nameMatch) return { id: nameMatch.id, full_name: nameMatch.full_name || fullName };

        // `customers.phone` still needs SOME value -- a synthetic one
        // keyed off the NRC + a timestamp keeps NEW records unique even
        // when two different people legitimately share one NRC (a plain
        // `NRC-${nrc}` would collide between them and incorrectly merge
        // two different patients into one record).
        const resolvedPhone = phone || `NRC-${nrc}-${Date.now()}`;

        const { data: created, error: insertError } = await supabaseClient
            .from('customers')
            .insert([{
                full_name: fullName || 'Unknown Patient',
                phone: resolvedPhone,
                address: address || '',
                customer_type: 'NHIMA',
                nrc: nrc,
                nhima_number: nhimaNumber || null,
                created_at: new Date().toISOString()
            }])
            .select()
            .single();

        if (insertError) {
            const { data: retry } = await supabaseClient
                .from('customers')
                .select('id, full_name')
                .eq('phone', resolvedPhone)
                .maybeSingle();
            if (retry) return { id: retry.id, full_name: retry.full_name || fullName };
            throw insertError;
        }

        return { id: created.id, full_name: created.full_name, phone: resolvedPhone };
    }

    async function ensureNhimaMemberRow(nhimaNumber, fullName, nrc, phone, address) {
        try {
            const { data: existing } = await supabaseClient
                .from('nhima_members')
                .select('nhima_number')
                .eq('nhima_number', nhimaNumber)
                .maybeSingle();
            if (existing) return;

            await supabaseClient.from('nhima_members').insert([{
                nhima_number: nhimaNumber,
                full_name: fullName,
                nrc: nrc || '',
                phone: phone || '',
                address: address || ''
            }]);
        } catch (e) {
            console.warn('Could not add new NHIMA member row (non-fatal):', e);
        }
    }

    // ============================================
    // FORM SUBMIT
    // ============================================
    function clearError() {
        formError.style.display = 'none';
        formError.textContent = '';
    }
    function showError(msg) {
        formError.textContent = msg;
        formError.style.display = 'block';
    }

    form.addEventListener('submit', async function (e) {
        e.preventDefault();
        clearError();

        const fullName = toProperCaseIfAllCaps(fullNameInput.value.trim());
        const nrc = nrcInput.value.trim();
        const nhimaNumber = nhimaNumberInput.value.trim().toUpperCase();
        const phoneDigits = phoneInput.value.trim();
        const address = addressInput.value.trim();

        if (!nrc) { showError('NRC Number is required.'); return; }
        if (!fullName) { showError('Full Name is required.'); return; }
        if (!nhimaNumber) { showError('NHIMA Number is required.'); return; }

        const validationError = validateNameValue(fullName, 'Full Name')
            || validateNrcValue(nrc)
            || validateNhimaNumberValue(nhimaNumber)
            || validatePhoneDigitsValue(phoneDigits, false);
        if (validationError) { showError(validationError); return; }

        const phone = buildZmPhone(phoneDigits) || null;

        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Registering...';

        try {
            const customer = await ensurePatientCustomer({ selectedCustomerId, fullName, phone, address, nrc, nhimaNumber });
            await ensureNhimaMemberRow(nhimaNumber, fullName, nrc, phone, address);

            const { data: ticket, error: tokenError } = await supabaseClient.rpc('issue_queue_token', {
                p_customer_id: customer.id,
                p_patient_name: fullName,
                p_phone: phone || customer.phone || null,
                p_customer_type: 'NHIMA',
                p_nhima_number: nhimaNumber,
                // 🔥 ADDED: priority flag from the checkbox above the
                // submit button -- call_next_ticket() (database side)
                // always calls priority=true tickets before everyone
                // else waiting in that stage, regardless of token number.
                p_priority: !!priorityCheckbox.checked
            });

            if (tokenError) throw tokenError;

            lastIssuedTicket = ticket;
            showTokenCard(ticket);
            resetForm();
            await loadRecent();
            await loadPending();
        } catch (err) {
            console.error('Error registering patient:', err);
            showError('Error: ' + (err.message || 'could not register patient.'));
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<i class="fa-solid fa-ticket"></i> Register &amp; Issue Token';
        }
    });

    function resetForm() {
        fullNameInput.value = '';
        nrcInput.value = '';
        nhimaNumberInput.value = '';
        phoneInput.value = '';
        addressInput.value = '';
        nrcMatchHint.style.display = 'none';
        nrcMatchWrap.style.display = 'none';
        nrcMatchSelect.innerHTML = '<option value="">-- New patient (not in the list below) --</option>';
        nrcCandidates = [];
        selectedCustomerId = null;
        if (priorityCheckbox) priorityCheckbox.checked = false;
    }

    // ============================================
    // TOKEN CARD + PRINT
    // ============================================
    function showTokenCard(ticket) {
        tokenCard.style.display = 'block';
        tokenNumberEl.textContent = '#' + ticket.token_number;
        tokenNameEl.textContent = ticket.patient_name;
        // 🔥 ADDED: flag priority tokens right on the confirmation card
        // so the front-desk staff know it'll jump the line.
        const priorityTag = ticket.priority ? ' <span style="color:#f59e0b;"><i class="fa-solid fa-star"></i> PRIORITY</span>' : '';
        tokenMetaEl.innerHTML = `${ticket.customer_type || ''} -- ${new Date(ticket.created_at).toLocaleString()}${priorityTag}`;
        tokenCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function buildTokenSlipHTML(ticket) {
        const time = new Date(ticket.created_at).toLocaleString();
        return `
        <!DOCTYPE html>
        <html>
        <head>
        <meta charset="UTF-8">
        <title>Queue Token #${ticket.token_number}</title>
        <style>
            @page { size: 80mm auto; margin: 4mm; }
            body { font-family: 'Segoe UI', Arial, sans-serif; text-align:center; width: 72mm; margin: 0 auto; color:#0f172a; }
            .pharmacy { font-size: 13px; font-weight: 700; margin-bottom: 2px; }
            .label { font-size: 10px; color:#475569; text-transform:uppercase; letter-spacing:0.05em; margin-top:14px; }
            .token { font-size: 54px; font-weight: 800; margin: 4px 0; }
            .name { font-size: 16px; font-weight: 600; margin-top: 6px; }
            .meta { font-size: 11px; color:#475569; margin-top: 8px; }
            hr { border:none; border-top: 1px dashed #94a3b8; margin: 14px 0; }
            .note { font-size: 11px; color:#475569; }
        </style>
        </head>
        <body>
            <div class="pharmacy">${PHARMACY_NAME}</div>
            <div class="meta">${time}</div>
            <hr>
            <div class="label">Your Queue Number</div>
            <div class="token">#${ticket.token_number}</div>
            <div class="name">${ticket.patient_name}</div>
            <hr>
            <div class="note">Please keep this token and wait for your number<br>to be called on the display screen.</div>
        </body>
        </html>`;
    }

    function printTicket(ticket) {
        if (!ticket) return;
        const printWindow = window.open('', '_blank', 'width=380,height=600');
        printWindow.document.write(buildTokenSlipHTML(ticket));
        printWindow.document.close();
        printWindow.focus();
        setTimeout(() => printWindow.print(), 300);
    }

    printBtn.addEventListener('click', () => printTicket(lastIssuedTicket));
    newBtn.addEventListener('click', () => {
        tokenCard.style.display = 'none';
        fullNameInput.focus();
    });

    // ============================================
    // TODAY'S QUEUE (formerly a read-only "Recently Registered" list)
    // ============================================
    const STATUS_LABELS = {
        waiting_billing: 'Waiting -- Billing',
        serving_billing: 'At Billing Counter',
        waiting_dispensing: 'Waiting -- Dispensing',
        serving_dispensing: 'At Dispensing Counter',
        pending: 'Pending (No-Show)',
        completed: 'Completed',
        skipped: 'Skipped'
    };
    const STATUS_COLORS = {
        waiting_billing: '#2563eb',
        serving_billing: '#2563eb',
        waiting_dispensing: '#7c3aed',
        serving_dispensing: '#7c3aed',
        pending: '#d97706',
        completed: '#059669',
        skipped: '#94a3b8'
    };
    const WAITING_STATUSES = ['waiting_billing', 'waiting_dispensing'];

    let recentRows = [];

    async function loadRecent() {
        const today = new Date().toISOString().split('T')[0];
        const { data, error } = await supabaseClient
            .from('queue_tickets')
            .select('*')
            .eq('queue_date', today)
            .order('token_number', { ascending: false })
            .limit(30);

        if (error) {
            console.error('Error loading recent tickets:', error);
            return;
        }

        recentRows = data || [];

        if (recentRows.length === 0) {
            recentList.innerHTML = `<p class="helper-text" style="padding:16px;">Nothing yet today.</p>`;
            return;
        }

        recentList.innerHTML = recentRows.map(t => {
            const isWaiting = WAITING_STATUSES.includes(t.status);
            const statusLabel = STATUS_LABELS[t.status] || t.status;
            const statusColor = STATUS_COLORS[t.status] || '#64748b';
            const priorityTag = t.priority ? '<i class="fa-solid fa-star" style="color:#f59e0b;" title="Priority"></i> ' : '';
            // 🔥 ADDED: a waiting ticket gets a Priority toggle right
            // here -- staff no longer need a separate screen to bump
            // someone to the front of that stage's line.
            const priorityBtn = isWaiting
                ? `<button class="btn btn-outline btn-sm" data-priority-id="${t.id}" data-priority-next="${t.priority ? 'false' : 'true'}" title="${t.priority ? 'Remove priority' : 'Make priority -- call next'}">
                       <i class="fa-solid fa-star" style="color:${t.priority ? '#f59e0b' : '#cbd5e1'};"></i>
                   </button>`
                : '';
            return `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 20px; border-bottom:1px solid #f1f5f9; gap:8px;">
                <div>
                    <div style="font-weight:600; font-size:0.9rem;">${priorityTag}#${t.token_number} -- ${t.patient_name}</div>
                    <div style="font-size:0.75rem; color:${statusColor}; font-weight:600;">${statusLabel}</div>
                </div>
                <div style="display:flex; gap:6px; flex-shrink:0;">
                    ${priorityBtn}
                    <button class="btn btn-outline btn-sm" data-reprint-id="${t.id}"><i class="fa-solid fa-print"></i></button>
                </div>
            </div>
        `; }).join('');

        recentList.querySelectorAll('[data-reprint-id]').forEach(btn => {
            btn.addEventListener('click', () => {
                const row = recentRows.find(t => String(t.id) === btn.dataset.reprintId);
                if (row) printTicket(row);
            });
        });
        recentList.querySelectorAll('[data-priority-id]').forEach(btn => {
            btn.addEventListener('click', () => toggleTicketPriority(btn.dataset.priorityId, btn.dataset.priorityNext === 'true'));
        });
    }

    async function toggleTicketPriority(ticketId, makePriority) {
        try {
            const { error } = await supabaseClient.rpc('set_ticket_priority', {
                p_ticket_id: Number(ticketId),
                p_priority: makePriority
            });
            if (error) throw error;
            await loadRecent();
        } catch (err) {
            console.error('Error updating priority:', err);
            alert('Error updating priority: ' + (err.message || err));
        }
    }

    // ============================================
    // 🔥 ADDED: PENDING (NO-SHOW) LIST
    // ============================================
    // Tickets a counter sent here via "Send to Pending" (see
    // Shared-queue-bar.js's skipCurrent()) after being called but not
    // showing up. They stay here, off the active waiting line, until
    // staff recall them -- unlike the old skip_ticket() path, nothing
    // here is a dead end.
    async function loadPending() {
        if (!pendingList) return;
        const today = new Date().toISOString().split('T')[0];
        const { data, error } = await supabaseClient
            .from('queue_tickets')
            .select('*')
            .eq('queue_date', today)
            .eq('status', 'pending')
            .order('pending_at', { ascending: true });

        if (error) {
            console.error('Error loading pending tickets:', error);
            return;
        }

        if (!data || data.length === 0) {
            pendingList.innerHTML = `<p class="helper-text" style="padding:16px;">No one is pending right now.</p>`;
            return;
        }

        pendingList.innerHTML = data.map(t => {
            const stageLabel = t.billing_done_at ? 'Dispensing' : 'Billing';
            return `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 20px; border-bottom:1px solid #f1f5f9; gap:8px;">
                <div>
                    <div style="font-weight:600; font-size:0.9rem;">#${t.token_number} -- ${t.patient_name}</div>
                    <div style="font-size:0.75rem; color:#94a3b8;">Was waiting for ${stageLabel} -- sent to pending ${t.pending_at ? new Date(t.pending_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</div>
                </div>
                <button class="btn btn-primary btn-sm" data-recall-id="${t.id}"><i class="fa-solid fa-star"></i> Recall as Priority</button>
            </div>
        `; }).join('');

        pendingList.querySelectorAll('[data-recall-id]').forEach(btn => {
            btn.addEventListener('click', () => recallPendingTicket(btn.dataset.recallId));
        });
    }

    // 🔥 CHANGED: recalling always brings the patient back as PRIORITY --
    // a no-show sent to Pending from POS was already waiting their turn
    // once; when they actually show up, they go straight back in line
    // ahead of everyone else rather than to the back of it. This is the
    // "push him to billing queue again and as priority customer" flow
    // described for the billing no-show case; recalling a dispensing
    // no-show the same way is harmless too since call_next_ticket()
    // simply calls priority tickets first within whichever stage they
    // land in.
    async function recallPendingTicket(ticketId) {
        try {
            const { error } = await supabaseClient.rpc('recall_pending_ticket', {
                p_ticket_id: Number(ticketId),
                p_priority: true
            });
            if (error) throw error;
            await loadPending();
            await loadRecent();
        } catch (err) {
            console.error('Error recalling pending ticket:', err);
            alert('Error recalling patient: ' + (err.message || err));
        }
    }

    // 🔥 ADDED: keep both lists live as counters call/complete/skip/
    // pend tickets from other screens, without needing a page reload.
    try {
        supabaseClient
            .channel('crm_queue_view_' + Date.now())
            .on('postgres_changes', { event: '*', schema: 'public', table: 'queue_tickets' }, () => {
                loadRecent();
                loadPending();
            })
            .subscribe();
    } catch (e) {
        console.warn('CRM queue view: realtime subscription failed, list will still refresh after actions taken here:', e);
    }

    // ============================================
    // INIT
    // ============================================
    loadRecent();
    loadPending();
})();
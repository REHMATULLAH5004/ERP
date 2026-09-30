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

    // 🔥 ADDED: small HTML-escaping helper used by the Patient History /
    // Patient Sales Lookup renderers below, since patient names, claim
    // numbers etc. are untrusted data being interpolated into innerHTML.
    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // 🔥 ADDED: withAuthRetry -- same stale-session gap fixed in the Admin
    // Clients page and already present in Retail POS/Payments/Purchase/
    // Dashboard. ensurePatientCustomer() below writes straight to
    // `customers` with no retry, so a stale session surfaced here as a
    // raw "new row violates row-level security policy for table
    // customers" error with no recovery.
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
            try {
                await supabaseClient.auth.refreshSession();
            } catch (refreshError) {
                console.error('Session refresh failed:', refreshError);
            }
            result = await operationFn();
        }

        return result;
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
    // 🔥 ADDED: "Requires NHIMA authorization" checkbox -- see submit
    // handler and loadAuthHold()/confirmAuthorization() below.
    const requiresAuthCheckbox = document.getElementById('qregRequiresAuth');

    const recentList = document.getElementById('qregRecentList');
    const pendingList = document.getElementById('qregPendingList');
    const authHoldList = document.getElementById('qregAuthHoldList');

    // 🔥 ADDED: Patient History panel (registration side) -- shown once
    // an existing patient is picked from the NRC-match dropdown below.
    const historyCard = document.getElementById('qregHistoryCard');
    const historyBanner = document.getElementById('qregHistoryBanner');
    const historyList = document.getElementById('qregHistoryList');
    const historyMoreBtn = document.getElementById('qregHistoryMoreBtn');

    // 🔥 ADDED: Patient Sales Lookup now lives in the sidebar (see
    // crm-menu.html) -- a general "check any patient" tool, deliberately
    // NOT tied to the registration form (searching here doesn't touch
    // selectedCustomerId or anything else the form uses). These come
    // from a SEPARATE fetch (loadModule() in app.js loads crm-menu.html
    // and crm-view.html/js independently, same pattern the Dashboard
    // sidebar already relies on), so they can in principle not exist yet
    // when this script first runs -- every use below is null-guarded.
    const sidebarLookupInput = document.getElementById('crmSidebarLookupSearch');
    const sidebarLookupBtn = document.getElementById('crmSidebarLookupBtn');
    const sidebarLookupResults = document.getElementById('crmSidebarLookupResults');
    const sidebarLookupHistoryWrap = document.getElementById('crmSidebarLookupHistoryWrap');
    const sidebarLookupName = document.getElementById('crmSidebarLookupName');
    const sidebarLookupBanner = document.getElementById('crmSidebarLookupBanner');
    const sidebarLookupHistory = document.getElementById('crmSidebarLookupHistory');
    const sidebarLookupMoreBtn = document.getElementById('crmSidebarLookupMoreBtn');

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
        hidePatientHistory(); // 🔥 ADDED: stale history shouldn't linger once the NRC changes
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
            hidePatientHistory(); // 🔥 ADDED
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
        // 🔥 ADDED: show this patient's sale history right away -- this is
        // the moment staff can see they aren't due for a refill yet.
        loadPatientHistory(match.id, match.full_name);
    });

    // ============================================
    // 🔥 ADDED: PATIENT HISTORY (shown once an existing patient is
    // selected above). Pulls their past NHIMA sales and flags whether
    // they still have supply left from the last collection, using each
    // sale item's `days_supplied` (the same field Retail POS records at
    // sale time) to estimate when they're actually due back.
    // ============================================
    function hidePatientHistory() {
        historyCard.style.display = 'none';
        historyBanner.style.display = 'none';
        historyList.innerHTML = '';
        if (historyMoreBtn) historyMoreBtn.style.display = 'none';
    }

    function fmtDate(d) {
        return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    }

    // 🔥 ADDED: the "still has supply / due" check, factored out so both
    // the full-width and compact sales tables share the exact same
    // due-date math instead of duplicating (and risking drifting from)
    // it. Returns null when there's nothing to flag (no days_supplied on
    // record for the most recent sale).
    function computeDueBanner(sales) {
        if (!sales || sales.length === 0) return null;
        const mostRecent = sales[0];
        const items = mostRecent.items || [];
        let maxDays = 0;
        items.forEach(it => {
            const d = Number(it.days_supplied) || 0;
            if (d > maxDays) maxDays = d;
        });
        if (maxDays <= 0) return null;

        const saleDate = new Date(mostRecent.created_at);
        const dueDate = new Date(saleDate);
        dueDate.setDate(dueDate.getDate() + maxDays);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const dueDateOnly = new Date(dueDate);
        dueDateOnly.setHours(0, 0, 0, 0);

        if (dueDateOnly > today) {
            const daysEarly = Math.round((dueDateOnly - today) / 86400000);
            return {
                bg: '#fef2f2',
                color: '#991b1b',
                html: `<i class="fa-solid fa-triangle-exclamation"></i> Still has supply from ${fmtDate(saleDate)} (${maxDays}-day supply) -- not due until ${fmtDate(dueDate)}, about ${daysEarly} day(s) early.`
            };
        }
        return {
            bg: '#ecfdf5',
            color: '#065f46',
            html: `<i class="fa-solid fa-circle-check"></i> Due -- last supply (from ${fmtDate(saleDate)}, ${maxDays}-day supply) should be finished by ${fmtDate(dueDate)}.`
        };
    }

    function applyDueBanner(sales, bannerEl) {
        if (!bannerEl) return;
        const banner = computeDueBanner(sales);
        if (!banner) { bannerEl.style.display = 'none'; return; }
        bannerEl.style.background = banner.bg;
        bannerEl.style.color = banner.color;
        bannerEl.innerHTML = banner.html;
        bannerEl.style.display = 'block';
    }

    // 🔥 CHANGED: was a stack of <div>s -- switched to a real <table> so
    // date / items / total actually line up in columns instead of
    // reading as loose blocks of text. Shared by the registration-side
    // Patient History card AND the sidebar Patient Sales Lookup;
    // `compact` drops the Claim # column and shortens the item list for
    // the 220px sidebar, where the full table wraps badly.
    function buildSalesTable(sales, opts) {
        opts = opts || {};
        const compact = !!opts.compact;
        const cellPad = compact ? '5px 6px' : '8px 10px';
        const fontSize = compact ? '0.72rem' : '0.82rem';
        const headFontSize = compact ? '0.6rem' : '0.68rem';

        const headCols = compact
            ? `<th style="padding:${cellPad}; text-align:left;">Date</th><th style="padding:${cellPad}; text-align:left;">Items</th><th style="padding:${cellPad}; text-align:right;">Total</th>`
            : `<th style="padding:${cellPad}; text-align:left;">Date</th><th style="padding:${cellPad}; text-align:left;">Claim #</th><th style="padding:${cellPad}; text-align:left;">Items</th><th style="padding:${cellPad}; text-align:right;">Total</th>`;

        const rows = sales.map((s, i) => {
            const items = s.items || [];
            let itemsText;
            if (compact) {
                const names = items.map(it => it.product_name).filter(Boolean);
                itemsText = names.slice(0, 2).join(', ') + (names.length > 2 ? ` +${names.length - 2} more` : '');
            } else {
                itemsText = items.map(it => `${it.product_name} x${it.qty}${it.days_supplied ? ` (${it.days_supplied}d)` : ''}`).join(', ');
            }
            const rowBg = i % 2 === 1 ? 'background:#f8fafc;' : '';
            return `
                <tr style="${rowBg} border-bottom:1px solid #f1f5f9;">
                    <td style="padding:${cellPad}; white-space:nowrap; vertical-align:top; color:#0f172a; font-weight:600;">${fmtDate(new Date(s.created_at))}</td>
                    ${compact ? '' : `<td style="padding:${cellPad}; white-space:nowrap; vertical-align:top; color:#64748b;">${escapeHtml(s.claim_number || '-')}</td>`}
                    <td style="padding:${cellPad}; vertical-align:top; color:#475569;">${escapeHtml(itemsText || '-')}</td>
                    <td style="padding:${cellPad}; text-align:right; white-space:nowrap; vertical-align:top; font-weight:600; color:#0f172a;">ZK ${Number(s.grand_total || 0).toFixed(2)}</td>
                </tr>`;
        }).join('');

        return `
        <div style="overflow-x:auto; border:1px solid #e8edf3; border-radius:8px;">
            <table style="width:100%; border-collapse:collapse; font-size:${fontSize};">
                <thead>
                    <tr style="background:#f8fafc; border-bottom:2px solid #e2e8f0; color:#64748b; text-transform:uppercase; letter-spacing:0.03em; font-size:${headFontSize};">
                        ${headCols}
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
    }

    async function fetchCustomerSales(customerId, limit) {
        const { data, error } = await supabaseClient
            .from('sales')
            .select('id, sale_id, claim_number, created_at, items, grand_total')
            .eq('customer_id', customerId)
            .eq('client_sub_type', 'NHIMA')
            .order('created_at', { ascending: false })
            .limit(limit || 10);
        if (error) throw error;
        return data || [];
    }

    // 🔥 ADDED: shows the last DEFAULT_HISTORY_LIMIT sales by default,
    // with a "View Full History" button that appears ONLY when there
    // actually are more (fetches one extra row up front to find out,
    // rather than guessing) and, on click, reloads with FULL_HISTORY_LIMIT
    // instead. Shared by the registration Patient History card and the
    // sidebar Patient Sales Lookup -- pass `compact: true` for the
    // narrower sidebar table.
    const DEFAULT_HISTORY_LIMIT = 5;
    const FULL_HISTORY_LIMIT = 200;

    async function loadPatientHistoryInto(customerId, refs) {
        const { listEl, bannerEl, moreBtnEl, nameEl, patientName, compact, emptyText } = refs;
        if (!listEl) return;

        if (nameEl) {
            nameEl.textContent = patientName || '';
            nameEl.style.display = patientName ? 'block' : 'none';
        }
        listEl.innerHTML = `<p class="helper-text" style="${compact ? 'font-size:0.75rem;' : ''} padding:4px 0;"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</p>`;
        if (bannerEl) bannerEl.style.display = 'none';
        if (moreBtnEl) moreBtnEl.style.display = 'none';

        try {
            // Fetch one row past the default limit purely to detect
            // "is there more" -- the extra row itself is never shown.
            const sales = await fetchCustomerSales(customerId, DEFAULT_HISTORY_LIMIT + 1);
            applyDueBanner(sales, bannerEl);

            if (!sales.length) {
                listEl.innerHTML = `<p class="helper-text" style="${compact ? 'font-size:0.75rem;' : ''} padding:4px 0;">${emptyText || 'No past NHIMA sales on file for this patient.'}</p>`;
                return;
            }

            const hasMore = sales.length > DEFAULT_HISTORY_LIMIT;
            const shown = hasMore ? sales.slice(0, DEFAULT_HISTORY_LIMIT) : sales;
            listEl.innerHTML = buildSalesTable(shown, { compact });

            if (moreBtnEl && hasMore) {
                moreBtnEl.style.display = compact ? 'flex' : 'inline-flex';
                moreBtnEl.disabled = false;
                moreBtnEl.innerHTML = '<i class="fa-solid fa-clock-rotate-left"></i> View Full History';
                moreBtnEl.onclick = async () => {
                    moreBtnEl.disabled = true;
                    moreBtnEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading full history...';
                    try {
                        const allSales = await fetchCustomerSales(customerId, FULL_HISTORY_LIMIT);
                        listEl.innerHTML = buildSalesTable(allSales, { compact });
                        moreBtnEl.style.display = 'none';
                    } catch (err) {
                        console.error('Error loading full patient history:', err);
                        moreBtnEl.disabled = false;
                        moreBtnEl.innerHTML = '<i class="fa-solid fa-clock-rotate-left"></i> View Full History';
                    }
                };
            }
        } catch (e) {
            console.error('Error loading patient history:', e);
            listEl.innerHTML = `<p class="helper-text" style="${compact ? 'font-size:0.75rem;' : ''} padding:4px 0; color:#dc2626;">Could not load history.</p>`;
        }
    }

    async function loadPatientHistory(customerId, patientName) {
        if (!customerId) { hidePatientHistory(); return; }
        historyCard.style.display = 'block';
        await loadPatientHistoryInto(customerId, {
            listEl: historyList,
            bannerEl: historyBanner,
            moreBtnEl: historyMoreBtn,
            compact: false
        });
    }

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

            const { data: updated, error: updateError } = await withAuthRetry(() => supabaseClient
                .from('customers')
                .update(updates)
                .eq('id', selectedCustomerId)
                .select()
                .single());
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

        const { data: created, error: insertError } = await withAuthRetry(() => supabaseClient
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
            .single());

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

        // 🔥 ADDED: open the print window SYNCHRONOUSLY, right here on the
        // actual click, before any `await` below runs. This used to be a
        // 2-click flow -- Register, then a separate Print click on the
        // token card -- because printTicket() called window.open() only
        // after the registration round-trip finished, by which point some
        // browsers no longer treat it as "triggered by a real click" and
        // silently block the popup. Opening a blank window now (while
        // we're still inside the click handler) reserves it, then
        // printTicket() below just writes the slip into this same window
        // and prints it -- so one click on "Register & Issue Token" is
        // all it takes; no second Print click, no popup-blocker risk.
        let pendingPrintWindow = null;
        try {
            pendingPrintWindow = window.open('', '_blank', 'width=380,height=600');
        } catch (e) {
            pendingPrintWindow = null;
        }

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
                p_priority: !!priorityCheckbox.checked,
                // 🔥 ADDED: when checked, issue_queue_token() (database
                // side) creates this ticket in 'on_hold_authorization'
                // instead of 'waiting_billing' -- it sits in the
                // "Awaiting NHIMA Authorization" list below and never
                // reaches call_next_ticket() until someone confirms it.
                p_requires_authorization: !!requiresAuthCheckbox.checked
            });

            if (tokenError) throw tokenError;

            lastIssuedTicket = ticket;
            showTokenCard(ticket);
            // 🔥 ADDED: auto-print immediately -- registration and
            // printing now happen on the same click. printTicket() still
            // works standalone too (Print button on the token card, and
            // the reprint buttons in Today's Queue below both still call
            // it with no pre-opened window, same as before).
            printTicket(ticket, pendingPrintWindow);
            resetForm();
            await loadRecent();
            await loadPending();
            await loadAuthHold(); // 🔥 ADDED
        } catch (err) {
            console.error('Error registering patient:', err);
            showError('Error: ' + (err.message || 'could not register patient.'));
            // 🔥 ADDED: registration failed -- don't leave a blank popup
            // hanging around on screen.
            if (pendingPrintWindow && !pendingPrintWindow.closed) {
                try { pendingPrintWindow.close(); } catch (e2) { /* ignore */ }
            }
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
        if (requiresAuthCheckbox) requiresAuthCheckbox.checked = false; // 🔥 ADDED
        hidePatientHistory(); // 🔥 ADDED
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
        // 🔥 ADDED: an on-hold ticket hasn't joined the queue yet -- make
        // that obvious right on the confirmation card, not just in the
        // "Awaiting NHIMA Authorization" list below.
        const holdTag = ticket.status === 'on_hold_authorization'
            ? ' <span style="color:#dc2626;"><i class="fa-solid fa-lock"></i> ON HOLD -- awaiting NHIMA authorization</span>'
            : '';
        tokenMetaEl.innerHTML = `${ticket.customer_type || ''} -- ${new Date(ticket.created_at).toLocaleString()}${priorityTag}${holdTag}`;
        tokenCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function buildTokenSlipHTML(ticket) {
        const time = new Date(ticket.created_at).toLocaleString();
        // 🔥 ADDED: an on-hold ticket shouldn't tell the patient to wait
        // for their number to be called -- it isn't in the queue yet.
        const noteText = ticket.status === 'on_hold_authorization'
            ? 'Your NHIMA authorization is still being confirmed. Please wait -- you will be added to the queue as soon as it comes through.'
            : 'Please keep this token and wait for your number<br>to be called on the display screen.';
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
            <div class="note">${noteText}</div>
        </body>
        </html>`;
    }

    // 🔥 CHANGED: accepts an optional already-open window (the one the
    // submit handler above pre-opens synchronously on click, to dodge
    // popup blockers). Manual callers -- the Print button and the
    // reprint buttons in Today's Queue -- don't pass one, so this falls
    // back to opening a fresh window exactly as before.
    function printTicket(ticket, existingWindow) {
        if (!ticket) return;
        const printWindow = (existingWindow && !existingWindow.closed)
            ? existingWindow
            : window.open('', '_blank', 'width=380,height=600');
        if (!printWindow) {
            console.warn('Could not open print window (popup blocked?)');
            return;
        }
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
        skipped: 'Skipped',
        on_hold_authorization: 'Awaiting NHIMA Authorization' // 🔥 ADDED
    };
    const STATUS_COLORS = {
        waiting_billing: '#2563eb',
        serving_billing: '#2563eb',
        waiting_dispensing: '#7c3aed',
        serving_dispensing: '#7c3aed',
        pending: '#d97706',
        completed: '#059669',
        skipped: '#94a3b8',
        on_hold_authorization: '#dc2626' // 🔥 ADDED
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
    // 🔥 ADDED: AWAITING NHIMA AUTHORIZATION LIST
    // ============================================
    // Tokens issued with "Requires NHIMA authorization" checked -- they
    // sit here in 'on_hold_authorization', never reaching call_next_ticket(),
    // until staff enter the confirmed code and push them into the real
    // queue. This is the fix for calling a patient's number before their
    // authorization came through and having to send them to no-show.
    async function loadAuthHold() {
        if (!authHoldList) return;
        const today = new Date().toISOString().split('T')[0];
        const { data, error } = await supabaseClient
            .from('queue_tickets')
            .select('*')
            .eq('queue_date', today)
            .eq('status', 'on_hold_authorization')
            .order('created_at', { ascending: true });

        if (error) {
            console.error('Error loading authorization-hold tickets:', error);
            return;
        }

        if (!data || data.length === 0) {
            authHoldList.innerHTML = `<p class="helper-text" style="padding:16px;">No tokens are on hold for authorization right now.</p>`;
            return;
        }

        authHoldList.innerHTML = data.map(t => `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 20px; border-bottom:1px solid #f1f5f9; gap:8px; flex-wrap:wrap;">
                <div>
                    <div style="font-weight:600; font-size:0.9rem;">#${t.token_number} -- ${t.patient_name}</div>
                    <div style="font-size:0.75rem; color:#94a3b8;">${t.nhima_number || ''} -- registered ${new Date(t.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                </div>
                <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
                    <input type="text" class="form-control" data-auth-code-id="${t.id}" placeholder="Authorization code" style="width:160px; padding:6px 8px; font-size:0.8rem;">
                    <label style="font-size:0.75rem; display:flex; align-items:center; gap:4px; cursor:pointer;">
                        <input type="checkbox" data-auth-priority-id="${t.id}" style="width:14px; height:14px; margin:0;"> Priority
                    </label>
                    <button class="btn btn-primary btn-sm" data-confirm-auth-id="${t.id}"><i class="fa-solid fa-check"></i> Confirm &amp; Add to Queue</button>
                </div>
            </div>
        `).join('');

        authHoldList.querySelectorAll('[data-confirm-auth-id]').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.dataset.confirmAuthId;
                const codeInput = authHoldList.querySelector(`[data-auth-code-id="${id}"]`);
                const priorityInput = authHoldList.querySelector(`[data-auth-priority-id="${id}"]`);
                confirmAuthorization(id, codeInput ? codeInput.value.trim() : '', !!(priorityInput && priorityInput.checked));
            });
        });
    }

    async function confirmAuthorization(ticketId, authorizationCode, makePriority) {
        try {
            const { error } = await supabaseClient.rpc('confirm_ticket_authorization', {
                p_ticket_id: Number(ticketId),
                p_authorization_code: authorizationCode || null,
                p_priority: !!makePriority
            });
            if (error) throw error;
            await loadAuthHold();
            await loadRecent();
        } catch (err) {
            console.error('Error confirming authorization:', err);
            alert('Error confirming authorization: ' + (err.message || err));
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
                loadAuthHold();
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
    loadAuthHold();

    // ============================================
    // 🔥 ADDED: PATIENT SALES LOOKUP (sidebar -- see crm-menu.html)
    // ============================================
    // Deliberately independent of the registration form above -- this
    // searches ANY patient on file (registered today or years ago) and
    // never touches selectedCustomerId or anything the form submits.
    async function findCustomerMatches(term) {
        // Strip characters that have special meaning inside a PostgREST
        // .or() filter string (comma separates conditions, parens group
        // them) so a search term containing them can't break the query.
        const q = (term || '').trim().replace(/[,()]/g, ' ').trim();
        if (!q) return [];
        const { data, error } = await supabaseClient
            .from('customers')
            .select('id, full_name, nhima_number, phone')
            .or(`full_name.ilike.%${q}%,nhima_number.ilike.%${q}%`)
            .limit(15);
        if (error) throw error;
        return data || [];
    }

    function renderLookupMatches(matches) {
        if (!sidebarLookupResults) return;
        if (sidebarLookupHistoryWrap) sidebarLookupHistoryWrap.style.display = 'none';
        if (!matches.length) {
            sidebarLookupResults.innerHTML = `<p class="helper-text" style="font-size:0.75rem; padding:6px 0;">No patients found matching that search.</p>`;
            return;
        }
        sidebarLookupResults.innerHTML = `
            <div style="border:1px solid #e8edf3; border-radius:8px; overflow:hidden;">
                ${matches.map(c => `
                    <div class="sidebar-lookup-match-row" data-customer-id="${c.id}" data-customer-name="${escapeHtml(c.full_name || 'Unknown')}" style="padding:8px 10px; border-bottom:1px solid #f1f5f9; cursor:pointer;">
                        <div style="font-weight:600; font-size:0.78rem; color:#0f172a;">${escapeHtml(c.full_name || 'Unknown')}</div>
                        <div class="helper-text" style="font-size:0.7rem;">${escapeHtml(c.nhima_number || '--')}</div>
                    </div>
                `).join('')}
            </div>
        `;
        sidebarLookupResults.querySelectorAll('.sidebar-lookup-match-row').forEach(row => {
            row.addEventListener('click', async () => {
                sidebarLookupResults.querySelectorAll('.sidebar-lookup-match-row').forEach(r => r.style.background = '');
                row.style.background = '#eff6ff';
                if (sidebarLookupHistoryWrap) sidebarLookupHistoryWrap.style.display = 'block';
                await loadPatientHistoryInto(row.dataset.customerId, {
                    listEl: sidebarLookupHistory,
                    bannerEl: sidebarLookupBanner,
                    moreBtnEl: sidebarLookupMoreBtn,
                    nameEl: sidebarLookupName,
                    patientName: row.dataset.customerName,
                    compact: true
                });
            });
        });
    }

    async function runPatientLookup() {
        if (!sidebarLookupInput) return;
        const term = sidebarLookupInput.value.trim();
        if (sidebarLookupHistoryWrap) sidebarLookupHistoryWrap.style.display = 'none';
        if (!term) {
            sidebarLookupResults.innerHTML = `<p class="helper-text" style="font-size:0.75rem; padding:6px 0;">Type an NHIMA number or patient name to search.</p>`;
            return;
        }
        sidebarLookupResults.innerHTML = `<p class="helper-text" style="font-size:0.75rem; padding:6px 0;"><i class="fa-solid fa-spinner fa-spin"></i> Searching...</p>`;
        try {
            const matches = await findCustomerMatches(term);
            renderLookupMatches(matches);
        } catch (err) {
            console.error('Error searching patients:', err);
            sidebarLookupResults.innerHTML = `<p class="helper-text" style="font-size:0.75rem; color:#dc2626; padding:6px 0;">Error searching: ${escapeHtml(err.message || String(err))}</p>`;
        }
    }

    if (sidebarLookupBtn) {
        sidebarLookupBtn.addEventListener('click', runPatientLookup);
    }
    if (sidebarLookupInput) {
        sidebarLookupInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                runPatientLookup();
            }
        });
    }
})();
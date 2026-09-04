// ============================================
// SHARED QUEUE BAR -- persistent "Call Next Patient" control
// ============================================
// Lives in the app shell (index.html's #queueBarContainer, right under
// the top navbar) which never gets torn down as the SPA navigates
// between modules -- so a cashier can be sitting in Retail POS, or a
// pharmacist on the Dashboard printing labels, and still call the next
// patient / see who they're serving without ever leaving that screen.
//
// app.js calls window.initQueueBar() once, right after login finishes
// resolving. The counter is no longer asked here -- it's chosen at the
// LOGIN SCREEN itself (assets/js/auth.js's showCounterPicker(), right
// after a successful sign-in) and handed off via
// sessionStorage.getItem('staffCounter'). This file just reads that
// value and derives which queue to show from it:
//   'Counter 1' / 'Counter 2' / 'Counter 3'  -> billing stage
//   'Dispatch'                                -> dispensing stage
//   nothing stored (skipped at login)         -> no bar at all
//
// Talks to the same `queue_tickets` table + RPC functions
// (call_next_ticket / complete_billing_ticket / complete_dispensing_ticket
// / skip_ticket) as database/queue_module_schema.sql sets up -- nothing
// new needed there.
// ============================================

window.initQueueBar = function initQueueBar() {
    if (window.__queueBarInitialized) return;
    window.__queueBarInitialized = true;

    if (typeof supabaseClient === 'undefined') {
        console.error('❌ supabaseClient is not defined -- queue bar disabled.');
        return;
    }

    const ALL_COUNTER_OPTIONS = ['Counter 1', 'Counter 2', 'Counter 3', 'Dispatch'];

    function stageForCounter(c) {
        if (c === 'Dispatch') return 'dispensing';
        if (c === 'Counter 1' || c === 'Counter 2' || c === 'Counter 3') return 'billing';
        return null; // unrecognized -- e.g. someone skipped at login
    }

    let counter = sessionStorage.getItem('staffCounter') || null;
    let stage = stageForCounter(counter);

    // Nothing chosen at login (skipped, or an Admin/Manager/Accountant
    // who never sees the picker at all since it's the same picker for
    // everyone) -- no bar to show.
    if (!stage) return;

    let isBilling = stage === 'billing';
    let servingTicket = null;

    // ============================================
    // COUNTER SELECTION -- only reached via the bar's own "Change"
    // button now (not asked automatically -- that happens at login).
    // ============================================
    function askForCounter(onDone) {
        const overlay = document.createElement('div');
        overlay.id = 'counterSelectModal';
        overlay.style.cssText = 'position:fixed; inset:0; background:rgba(15,23,42,0.65); backdrop-filter:blur(4px); z-index:2000; display:flex; align-items:center; justify-content:center;';
        overlay.innerHTML = `
            <div style="background:white; border-radius:12px; padding:28px; width:90%; max-width:420px; box-shadow:0 20px 50px rgba(0,0,0,0.4); text-align:center;">
                <i class="fa-solid fa-right-left" style="font-size:2rem; color:#2563eb;"></i>
                <h3 style="margin:12px 0 4px;">Which counter are you working from?</h3>
                <p style="color:#64748b; font-size:0.85rem; margin:0 0 18px;">Used to call patients and show the right counter on their token.</p>
                <div id="counterSelectOptions" style="display:grid; grid-template-columns:1fr 1fr; gap:8px;"></div>
            </div>
        `;
        document.body.appendChild(overlay);

        const optionsWrap = overlay.querySelector('#counterSelectOptions');
        optionsWrap.innerHTML = ALL_COUNTER_OPTIONS.map(opt => `
            <button type="button" class="counter-opt-btn" data-opt="${opt}"
                style="padding:14px 8px; border:1px solid #e2e8f0; border-radius:8px; background:white; color:#0f172a; font-weight:600; cursor:pointer; font-size:0.9rem;">
                ${opt}
            </button>
        `).join('');

        optionsWrap.querySelectorAll('.counter-opt-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                overlay.remove();
                onDone(btn.dataset.opt);
            });
        });
    }

    // ============================================
    // BAR RENDER
    // ============================================
    function renderBar() {
        const barContainer = document.getElementById('queueBarContainer');
        if (!barContainer) return;

        barContainer.innerHTML = `
            <div id="queueBar" style="display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap; background:#0f172a; color:#e2e8f0; padding:8px 20px; font-size:0.83rem; border-bottom:1px solid #1e293b;">
                <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
                    <i class="fa-solid ${isBilling ? 'fa-cash-register' : 'fa-pills'}" style="color:#60a5fa;"></i>
                    <span>${isBilling ? 'Billing' : 'Dispensing'} Queue</span>
                    <span style="color:#334155;">|</span>
                    <span>Counter: <strong id="queueBarCounterLabel" style="color:#fff;"></strong></span>
                    <button id="queueBarChangeCounterBtn" style="background:transparent; border:1px solid #334155; color:#94a3b8; border-radius:5px; padding:2px 8px; font-size:0.72rem; cursor:pointer;">Change</button>
                    <span id="queueBarWaitingBadge" style="background:#1e293b; color:#93c5fd; padding:2px 10px; border-radius:10px; font-size:0.72rem; font-weight:600;">0 waiting</span>
                </div>

                <div id="queueBarIdle" style="display:flex; align-items:center;">
                    <button id="queueBarNextBtn" style="background:#2563eb; color:white; border:none; border-radius:6px; padding:7px 16px; font-weight:600; font-size:0.82rem; cursor:pointer; display:flex; align-items:center; gap:6px;">
                        <i class="fa-solid fa-forward"></i> Call Next Patient
                    </button>
                </div>

                <div id="queueBarServing" style="display:none; align-items:center; gap:10px; flex-wrap:wrap;">
                    <span>Serving <strong id="queueBarServingToken" style="color:#fbbf24;">#--</strong> -- <span id="queueBarServingName" style="color:#fff;"></span></span>
                    <span id="queueBarBillingActions" style="${isBilling ? 'display:flex;' : 'display:none;'} gap:8px;">
                        <button id="queueBarOpenPosBtn" style="background:#2563eb; color:white; border:none; border-radius:6px; padding:6px 12px; font-size:0.78rem; cursor:pointer;"><i class="fa-solid fa-cart-shopping"></i> Open in POS</button>
                        <button id="queueBarCompleteBillingBtn" style="background:#059669; color:white; border:none; border-radius:6px; padding:6px 12px; font-size:0.78rem; cursor:pointer;"><i class="fa-solid fa-check"></i> Send to Dispensing</button>
                    </span>
                    <span id="queueBarDispensingActions" style="${!isBilling ? 'display:flex;' : 'display:none;'} gap:8px;">
                        <button id="queueBarCompleteDispensingBtn" style="background:#059669; color:white; border:none; border-radius:6px; padding:6px 12px; font-size:0.78rem; cursor:pointer;"><i class="fa-solid fa-check"></i> Mark Complete</button>
                    </span>
                    <button id="queueBarSkipBtn" style="background:transparent; border:1px solid #334155; color:#cbd5e1; border-radius:6px; padding:6px 12px; font-size:0.78rem; cursor:pointer;"><i class="fa-solid fa-clock"></i> Send to Pending (No Show)</button>
                </div>
            </div>
        `;

        document.getElementById('queueBarCounterLabel').textContent = counter;
        document.getElementById('queueBarChangeCounterBtn').addEventListener('click', () => {
            askForCounter(newCounter => {
                const newStage = stageForCounter(newCounter);
                counter = newCounter;
                sessionStorage.setItem('staffCounter', newCounter);

                if (newStage !== stage) {
                    // Switched from billing to dispensing (or vice versa) --
                    // e.g. the pharmacist covering a billing counter for a
                    // bit. Whatever was being served under the old stage
                    // stays saved under its own key (queueServingTicket_billing
                    // / _dispensing) so it's still there if they switch back;
                    // this station starts idle under the new stage.
                    stage = newStage;
                    isBilling = stage === 'billing';
                    try {
                        const saved = sessionStorage.getItem(servingStorageKey());
                        servingTicket = saved ? JSON.parse(saved) : null;
                    } catch (e) { servingTicket = null; }
                    renderBar();
                    loadWaitingCount();
                } else {
                    document.getElementById('queueBarCounterLabel').textContent = counter;
                }
            });
        });
        document.getElementById('queueBarNextBtn').addEventListener('click', callNext);
        document.getElementById('queueBarSkipBtn').addEventListener('click', skipCurrent);
        if (isBilling) {
            document.getElementById('queueBarOpenPosBtn').addEventListener('click', openInPos);
            document.getElementById('queueBarCompleteBillingBtn').addEventListener('click', completeBilling);
        } else {
            document.getElementById('queueBarCompleteDispensingBtn').addEventListener('click', completeDispensing);
        }

        renderServingState();
    }

    function renderServingState() {
        const idleEl = document.getElementById('queueBarIdle');
        const servingEl = document.getElementById('queueBarServing');
        if (!idleEl || !servingEl) return;

        if (servingTicket) {
            idleEl.style.display = 'none';
            servingEl.style.display = 'flex';
            document.getElementById('queueBarServingToken').textContent = '#' + servingTicket.token_number;
            document.getElementById('queueBarServingName').textContent = servingTicket.patient_name;
        } else {
            idleEl.style.display = 'flex';
            servingEl.style.display = 'none';
        }
    }

    function servingStorageKey() {
        return 'queueServingTicket_' + stage;
    }

    function setServing(ticket) {
        servingTicket = ticket;
        if (ticket) sessionStorage.setItem(servingStorageKey(), JSON.stringify(ticket));
        else sessionStorage.removeItem(servingStorageKey());
        renderServingState();
        // 🔥 ADDED: let any other queue UI on this same page (e.g. the
        // Dashboard's own "Dispensing Queue" card, shown only for
        // Dispatch logins) know the serving ticket changed, so both stay
        // in sync immediately without a page reload.
        window.dispatchEvent(new CustomEvent('queueServingChanged', { detail: { stage, ticket } }));
    }

    // 🔥 ADDED: pick up serving-ticket changes made by OTHER queue UI on
    // this same page (e.g. the Dashboard's dispatch card) without
    // re-writing storage ourselves -- avoids an event ping-pong. This bar
    // only ever mounts once for the whole session (see
    // window.__queueBarInitialized above), so a plain addEventListener
    // here is safe and never stacks up duplicate listeners.
    window.addEventListener('queueServingChanged', (e) => {
        if (!e.detail || e.detail.stage !== stage) return;
        servingTicket = e.detail.ticket;
        renderServingState();
    });

    // ============================================
    // ACTIONS
    // ============================================
    async function callNext() {
        const btn = document.getElementById('queueBarNextBtn');
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Calling...'; }
        try {
            const { data, error } = await supabaseClient.rpc('call_next_ticket', { p_stage: stage, p_counter: counter });
            if (error) throw error;
            if (!data) {
                alert(`No patients waiting for ${isBilling ? 'billing' : 'dispensing'} right now.`);
            } else {
                setServing(data);
            }
            loadWaitingCount();
        } catch (err) {
            console.error('Error calling next ticket:', err);
            alert('Error calling next patient: ' + (err.message || err));
        } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-forward"></i> Call Next Patient'; }
        }
    }

    function openInPos() {
        if (!servingTicket) return;
        sessionStorage.setItem('activeQueueTicket', JSON.stringify({
            id: servingTicket.id,
            tokenNumber: servingTicket.token_number,
            patientName: servingTicket.patient_name,
            customerId: servingTicket.customer_id,
            customerType: servingTicket.customer_type,
            phone: servingTicket.phone,
            nhimaNumber: servingTicket.nhima_number
        }));

        document.querySelectorAll('.top-link').forEach(l => l.classList.remove('active'));
        const transactionLink = document.querySelector('.top-link[data-module="transaction"]');
        if (transactionLink) transactionLink.classList.add('active');

        if (typeof loadSubModule === 'function') {
            loadSubModule('transaction', 'retail');
        } else {
            alert('Could not open POS automatically -- go to Transaction > Retail.');
        }
    }

    async function completeBilling() {
        if (!servingTicket) return;
        try {
            const { error } = await supabaseClient.rpc('complete_billing_ticket', { p_ticket_id: servingTicket.id });
            if (error) throw error;
            setServing(null);
            loadWaitingCount();
        } catch (err) {
            console.error('Error completing billing:', err);
            alert('Error: ' + (err.message || err));
        }
    }

    async function completeDispensing() {
        if (!servingTicket) return;
        try {
            const { error } = await supabaseClient.rpc('complete_dispensing_ticket', { p_ticket_id: servingTicket.id });
            if (error) throw error;
            setServing(null);
            loadWaitingCount();
        } catch (err) {
            console.error('Error completing dispensing:', err);
            alert('Error: ' + (err.message || err));
        }
    }

    // 🔥 CHANGED: this used to call skip_ticket(), which marked the
    // ticket 'skipped' -- a dead end nothing in the app could ever
    // recall. Patients who simply weren't in the waiting area yet when
    // called need a way back in, so this now sends them to
    // send_ticket_to_pending() instead: it frees this counter's serving
    // slot exactly the same way, but the ticket lands in the "Pending
    // (No-Show)" list on the CRM registration screen, where staff can
    // recall it back into the correct waiting line whenever the patient
    // turns up. Immediately calling next() afterwards is the "trigger
    // next client" behavior that was asked for -- staff don't have to
    // click "Call Next" a second time after sending someone to pending.
    async function skipCurrent() {
        if (!servingTicket) return;
        if (!confirm(`Send token #${servingTicket.token_number} (${servingTicket.patient_name}) to Pending? They'll be off this counter and can be recalled later from the CRM screen's Pending list.`)) return;
        try {
            const { error } = await supabaseClient.rpc('send_ticket_to_pending', { p_ticket_id: servingTicket.id });
            if (error) throw error;
            setServing(null);
            loadWaitingCount();
            await callNext();
        } catch (err) {
            console.error('Error sending ticket to pending:', err);
            alert('Error: ' + (err.message || err));
        }
    }

    // ============================================
    // WAITING COUNT (small badge -- live + polling fallback)
    // ============================================
    async function loadWaitingCount() {
        const badge = document.getElementById('queueBarWaitingBadge');
        if (!badge) return;
        const today = new Date().toISOString().split('T')[0];
        const { count, error } = await supabaseClient
            .from('queue_tickets')
            .select('id', { count: 'exact', head: true })
            .eq('queue_date', today)
            .eq('status', 'waiting_' + stage);

        if (error) { console.warn('Error loading waiting count:', error); return; }
        badge.textContent = `${count || 0} waiting`;
        // 🔥 ADDED: this bar's realtime channel + 8s poll are the only
        // live source of the waiting count on the page -- broadcast it so
        // the Dashboard's dispatch card (which has no polling/channel of
        // its own, to avoid stacking one up on every Dashboard revisit)
        // can keep its own badge current too.
        window.dispatchEvent(new CustomEvent('queueWaitingCountChanged', { detail: { stage, count: count || 0 } }));
    }

    try {
        supabaseClient
            .channel('queue_bar_' + stage + '_' + Date.now())
            .on('postgres_changes', { event: '*', schema: 'public', table: 'queue_tickets' }, () => loadWaitingCount())
            .subscribe();
    } catch (e) {
        console.warn('Queue bar: realtime subscription failed, polling only:', e);
    }
    setInterval(loadWaitingCount, 8000);

    // ============================================
    // INIT -- counter already known (chosen at login), just show the bar
    // ============================================
    try {
        const saved = sessionStorage.getItem(servingStorageKey());
        if (saved) servingTicket = JSON.parse(saved);
    } catch (e) { /* ignore */ }

    renderBar();
    loadWaitingCount();
};
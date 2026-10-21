// ============================================
// SHARED PRESCRIPTION ALERT -- top-bar button
// ============================================
// Shows a "Prescriptions" button in the ERP's top navbar with a red badge =
// number of online-shop prescriptions still waiting for review ("pending").
// When a NEW one arrives (while the ERP is open) the button pulses, a short
// beep plays and a toast appears. Clicking the button opens the shop admin's
// Prescriptions page, where the pharmacist reviews the prescription and sends
// the quotation -- nothing patient-related is copied into the ERP.
//
// Where the number comes from: the online shop has its own database. It
// exposes ONE read-only function, pending_prescription_count(), which returns
// only {pending, latest} (a number and a timestamp -- no names, no images).
// See online_shop_pending_prescription_count_SHOP_database.sql in the shop
// project folder (run on the SHOP database, not the ERP).
//
// Who sees it: Admin, Manager, Pharmacist (window.currentUserRole, set by
// app.js before it calls window.initPrescriptionAlert()).
// ============================================

(function () {
    // ---- settings you may want to change -------------------------------
    // Address of the shop admin page (opened when the button is clicked).
    const SHOP_ADMIN_URL = 'https://gogriffins.com/pages/admin/index.html#prescriptions';
    // Shop database (public anon key -- it can only call the count function).
    const SHOP_SUPABASE_URL = 'https://depqlvzajukhhbiztnhj.supabase.co';
    const SHOP_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRlcHFsdnphanVraGhiaXp0bmhqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ1MzQ2MTgsImV4cCI6MjA4MDExMDYxOH0.W4R4XFbc8-a6OrX3sNLF4QPaP8pJH0A10o-m2WwqSN8';
    const ALLOWED_ROLES = ['Admin', 'Manager', 'Pharmacist'];
    const POLL_MS = 30000;
    // ---------------------------------------------------------------------

    const SEEN_KEY = 'rxAlert_lastSeenLatest';

    window.initPrescriptionAlert = function initPrescriptionAlert() {
        if (window.__rxAlertInitialized) return;
        if (!ALLOWED_ROLES.includes(window.currentUserRole)) return;
        if (!window.supabase || typeof window.supabase.createClient !== 'function') {
            console.warn('Prescription alert: Supabase SDK not loaded -- button disabled.');
            return;
        }
        const navRight = document.querySelector('.top-navbar .nav-right');
        if (!navRight) return;
        window.__rxAlertInitialized = true;

        // Separate client for the shop database; never stores a session.
        const shop = window.supabase.createClient(SHOP_SUPABASE_URL, SHOP_SUPABASE_ANON_KEY, {
            auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
        });

        // ---- styles (self-contained, so style.css is untouched) ----
        const style = document.createElement('style');
        style.textContent = `
            #rxAlertBtn { position:relative; display:flex; align-items:center; gap:6px; background:#1e293b; color:#e2e8f0;
                border:1px solid #334155; border-radius:8px; padding:6px 12px; font-size:0.85rem; cursor:pointer; }
            #rxAlertBtn:hover { background:#334155; }
            #rxAlertBadge { min-width:18px; height:18px; padding:0 5px; border-radius:9px; background:#ef4444; color:#fff;
                font-size:0.7rem; font-weight:700; display:none; align-items:center; justify-content:center; }
            #rxAlertBtn.has-pending { border-color:#ef4444; }
            #rxAlertBtn.has-pending #rxAlertBadge { display:inline-flex; }
            #rxAlertBtn.rx-pulse { animation: rxPulse 1s ease-in-out 6; }
            @keyframes rxPulse { 0%,100% { box-shadow:0 0 0 0 rgba(239,68,68,0.7); } 50% { box-shadow:0 0 0 8px rgba(239,68,68,0); } }
        `;
        document.head.appendChild(style);

        // ---- button ----
        const btn = document.createElement('button');
        btn.id = 'rxAlertBtn';
        btn.type = 'button';
        btn.title = 'Online prescriptions waiting for review';
        btn.innerHTML = '<i class="fa-solid fa-file-prescription"></i> <span>Prescriptions</span> <span id="rxAlertBadge">0</span>';
        const userProfile = navRight.querySelector('.user-profile');
        navRight.insertBefore(btn, userProfile || navRight.firstChild);
        const badge = btn.querySelector('#rxAlertBadge');

        let latestSeen = null;
        try { latestSeen = localStorage.getItem(SEEN_KEY); } catch (e) { /* storage blocked -- fine */ }
        let currentLatest = null;
        let baseTitle = document.title;

        function beep() {
            try {
                const Ctx = window.AudioContext || window.webkitAudioContext;
                if (!Ctx) return;
                const ctx = new Ctx();
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.value = 880;
                gain.gain.setValueAtTime(0.0001, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
                osc.connect(gain); gain.connect(ctx.destination);
                osc.start(); osc.stop(ctx.currentTime + 0.5);
                osc.onended = () => ctx.close();
            } catch (e) { /* browsers may block audio until the first click -- ignore */ }
        }

        function notifyNew(pending) {
            beep();
            btn.classList.add('rx-pulse');
            setTimeout(() => btn.classList.remove('rx-pulse'), 6500);
            const msg = pending === 1
                ? 'New prescription from the online shop is waiting for review.'
                : `New prescription from the online shop -- ${pending} waiting for review.`;
            const container = document.getElementById('toastContainer');
            if (container) {
                const t = document.createElement('div');
                t.className = 'toast toast-info';
                t.textContent = msg;
                t.style.cssText = 'background:#0f172a;color:#fff;padding:12px 16px;border-radius:8px;margin-top:8px;box-shadow:0 6px 20px rgba(0,0,0,0.3);cursor:pointer;';
                t.addEventListener('click', openShopAdmin);
                container.appendChild(t);
                setTimeout(() => t.remove(), 8000);
            }
        }

        function render(pending) {
            badge.textContent = pending > 99 ? '99+' : String(pending);
            btn.classList.toggle('has-pending', pending > 0);
            document.title = pending > 0 ? `(${pending}) ${baseTitle}` : baseTitle;
        }

        async function refresh() {
            try {
                const { data, error } = await shop.rpc('pending_prescription_count');
                if (error) throw error;
                const pending = Number(data?.pending) || 0;
                const latest = data?.latest || null;
                currentLatest = latest;
                render(pending);
                btn.title = pending > 0
                    ? `${pending} online prescription${pending === 1 ? '' : 's'} waiting for review`
                    : 'No online prescriptions waiting';

                // Alert only when something newer than what this browser last saw
                // has arrived. First run on a browser just records the baseline.
                if (latest) {
                    if (latestSeen === null) {
                        latestSeen = latest;
                        try { localStorage.setItem(SEEN_KEY, latest); } catch (e) { /* ignore */ }
                    } else if (new Date(latest) > new Date(latestSeen)) {
                        notifyNew(pending);
                        latestSeen = latest;
                        try { localStorage.setItem(SEEN_KEY, latest); } catch (e) { /* ignore */ }
                    }
                }
            } catch (err) {
                console.warn('Prescription alert: could not read the shop prescription count:', err);
                btn.title = 'Could not reach the online shop right now';
            }
        }

        function openShopAdmin() {
            window.open(SHOP_ADMIN_URL, '_blank', 'noopener');
        }
        btn.addEventListener('click', openShopAdmin);

        refresh();
        setInterval(refresh, POLL_MS);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    };
})();

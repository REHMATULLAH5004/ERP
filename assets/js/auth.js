// ============================================
// AUTH.JS - LOGIN LOGIC
// ============================================
// Sign-in only. New accounts are created from the Admin page by an
// existing admin, not through self-service sign-up -- there is
// deliberately no sign-up flow here.
// ============================================

document.addEventListener('DOMContentLoaded', () => {

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined. Check that assets/js/supabase-config.js loaded correctly.");
        return;
    }

    const loginForm = document.getElementById('loginForm');
    const loginBtn = document.getElementById('loginBtn');
    const loginError = document.getElementById('loginError');
    const emailInput = document.getElementById('loginEmail');
    const passwordInput = document.getElementById('loginPassword');

    // 🔥 ADDED: if a page (e.g. clock-in.html, reached by scanning a QR
    // code) redirected here because there was no session yet, send the
    // person back to it after a successful login instead of always
    // landing on index.html.
    const params = new URLSearchParams(window.location.search);
    const returnTo = params.get('returnTo');
    const destination = returnTo ? decodeURIComponent(returnTo) : './index.html';

    // ============================================
    // 🔥 ADDED: counter picker shown right after a FRESH sign-in
    // ============================================
    // Asks which counter the person is working from (Counter 1/2/3 for
    // billing, or Dispatch for the pharmacist's dispensing station) so
    // assets/js/shared-queue-bar.js knows which "Call Next" queue to show
    // app-wide, without asking again itself on every page. Built
    // dynamically here (same pattern as other in-app modals, e.g.
    // retail's print dialog) so login.html itself doesn't need to
    // change. Resolves to the chosen counter string, or null if the
    // person skips it (e.g. an Admin/Manager just logging in to check
    // reports, not manning a counter today).
    function showCounterPicker() {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.id = 'loginCounterModal';
            overlay.style.cssText = 'position:fixed; inset:0; background:rgba(15,23,42,0.65); backdrop-filter:blur(4px); z-index:2000; display:flex; align-items:center; justify-content:center;';
            overlay.innerHTML = `
                <div style="background:white; border-radius:12px; padding:28px; width:90%; max-width:420px; box-shadow:0 20px 50px rgba(0,0,0,0.4); text-align:center;">
                    <i class="fa-solid fa-cash-register" style="font-size:2rem; color:#2563eb;"></i>
                    <h3 style="margin:12px 0 4px;">Which counter are you working from?</h3>
                    <p style="color:#64748b; font-size:0.85rem; margin:0 0 18px;">Used to call patients and show the right counter on their token.</p>
                    <div id="loginCounterOptions" style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
                        <button type="button" class="login-counter-btn" data-opt="Counter 1" style="padding:14px 8px; border:1px solid #e2e8f0; border-radius:8px; background:white; color:#0f172a; font-weight:600; cursor:pointer; font-size:0.9rem;">Counter 1</button>
                        <button type="button" class="login-counter-btn" data-opt="Counter 2" style="padding:14px 8px; border:1px solid #e2e8f0; border-radius:8px; background:white; color:#0f172a; font-weight:600; cursor:pointer; font-size:0.9rem;">Counter 2</button>
                        <button type="button" class="login-counter-btn" data-opt="Counter 3" style="padding:14px 8px; border:1px solid #e2e8f0; border-radius:8px; background:white; color:#0f172a; font-weight:600; cursor:pointer; font-size:0.9rem;">Counter 3</button>
                        <button type="button" class="login-counter-btn" data-opt="Dispatch" style="padding:14px 8px; border:1px solid #e2e8f0; border-radius:8px; background:white; color:#0f172a; font-weight:600; cursor:pointer; font-size:0.9rem;">Dispatch</button>
                    </div>
                    <a href="#" id="loginCounterSkip" style="display:inline-block; margin-top:16px; color:#94a3b8; font-size:0.8rem; text-decoration:none;">I'm not working a counter today</a>
                </div>
            `;
            document.body.appendChild(overlay);

            overlay.querySelectorAll('.login-counter-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const chosen = btn.dataset.opt;
                    overlay.remove();
                    resolve(chosen);
                });
            });

            overlay.querySelector('#loginCounterSkip').addEventListener('click', (e) => {
                e.preventDefault();
                overlay.remove();
                resolve(null);
            });
        });
    }

    // ============================================
    // IF ALREADY LOGGED IN, SKIP STRAIGHT TO THE APP
    // ============================================
    // (No counter popup here -- this fires on an existing session, e.g.
    // a page refresh, not a fresh login action. staffCounter, if any,
    // was already set the last time they actually signed in.)
    (async () => {
        try {
            const { data } = await supabaseClient.auth.getSession();
            if (data?.session) {
                window.location.href = destination;
            }
        } catch (error) {
            console.warn('Session check failed, staying on login page:', error);
        }
    })();

    // ============================================
    // SIGN IN
    // ============================================
    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const email = emailInput.value.trim();
            const password = passwordInput.value;

            if (!email || !password) {
                showError('Please enter both email and password.');
                return;
            }

            loginError.style.display = 'none';
            loginBtn.disabled = true;
            loginBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Signing in...';

            try {
                const { data, error } = await supabaseClient.auth.signInWithPassword({
                    email,
                    password
                });

                if (error) throw error;

                if (data?.session) {
                    // 🔥 ADDED: ask which counter they're working from
                    // before entering the app. Stored per-tab (sessionStorage)
                    // so it's asked again on the next real login, and read by
                    // assets/js/shared-queue-bar.js to decide whether to show
                    // the "Call Next" bar and which queue (billing/dispensing)
                    // it's for.
                    const chosenCounter = await showCounterPicker();
                    if (chosenCounter) {
                        sessionStorage.setItem('staffCounter', chosenCounter);
                    } else {
                        sessionStorage.removeItem('staffCounter');
                    }
                    window.location.href = destination;
                } else {
                    showError('Sign in failed. Please try again.');
                }
            } catch (error) {
                console.error('Login error:', error);
                // Supabase's own message is usually clear enough
                // ("Invalid login credentials"), so surface it directly
                // rather than masking it with a generic one.
                showError(error.message || 'Invalid email or password.');
            } finally {
                loginBtn.disabled = false;
                loginBtn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Sign In';
            }
        });
    }

    function showError(message) {
        loginError.textContent = message;
        loginError.style.display = 'block';
    }
});
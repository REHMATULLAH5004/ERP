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
    // IF ALREADY LOGGED IN, SKIP STRAIGHT TO THE APP
    // ============================================
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
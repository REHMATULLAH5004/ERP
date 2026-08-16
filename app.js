// ============================================
// SAFE APPLICATION LOGIC
// ============================================

// ============================================
// GLOBAL VARIABLES - Declared at window level
// ============================================
// These are declared globally so they persist across module loads
window.currentModule = window.currentModule || null;
window.loadedModules = window.loadedModules || {};
window.currentUserRole = window.currentUserRole || null;

// ============================================
// 🔥 ROLE-BASED SECTION ACCESS
// ============================================
// The real, editable source of truth is now the role_permissions table
// (managed from Admin > Roles & Permissions). This hardcoded map is
// kept ONLY as an emergency fallback if that table can't be reached --
// navigation should never break entirely just because a permissions
// query failed.
//
// IMPORTANT: this controls what's shown/navigable in the UI. It is NOT
// a security boundary on its own -- a technically determined user could
// still query Supabase tables directly via the browser console if
// Row Level Security policies aren't ALSO configured server-side to
// enforce the same restrictions. This client-side gate should be
// treated as a UX convenience layered on top of real RLS policies, not
// a replacement for them.
// ============================================
// 🚧 TESTING MODE -- REMOVE BEFORE GOING LIVE 🚧
// ============================================
// Set to false (or delete this block and the two spots below that check
// it) to restore normal role-based restrictions. While true, every
// logged-in account sees every module regardless of role -- login is
// still required, only the section restriction is bypassed.
const TESTING_MODE_ALL_ACCESS = false;
// ============================================

const FALLBACK_ROLE_ACCESS = {
    'Admin':      ['dashboard', 'transaction', 'account', 'crm', 'hr', 'admin', 'inventory', 'report'],
    'Manager':    ['dashboard', 'transaction', 'inventory', 'report'],
    'Pharmacist': ['transaction', 'inventory'],
    'Accountant': ['dashboard', 'account', 'report'],
    'Cashier':    ['transaction']
};
const DEFAULT_ROLE = 'Cashier'; // safest/narrowest fallback if a role lookup ever fails
let ROLE_ACCESS = FALLBACK_ROLE_ACCESS; // replaced with DB data once loaded, see below

// 🔥 FIX: navigation race guard. loadModule()/loadSubModule() each kick off
// 2 chained fetches (view HTML, then view JS) with nothing to cancel them.
// If the user navigates again (e.g. double-clicks a menu item, or clicks
// away and back quickly) before the first navigation's fetches finish, the
// OLDER navigation's ".then" callbacks still fire later and can overwrite
// workspace-content with stale HTML and/or inject a script that then runs
// against whatever the NEWER navigation actually put in the DOM -- causing
// "Cannot read properties of null (reading 'addEventListener')" for
// elements that exist in the file on disk but not in the live DOM at that
// moment. Every navigation now takes a ticket; a navigation only writes to
// the DOM if its ticket is still the latest one when its fetch resolves.
let navToken = 0;

document.addEventListener('DOMContentLoaded', async () => {
    
    console.log("1. app.js starting...");

    // ============================================
    // SAFE SESSION CHECK (With timeout fallback)
    // ============================================
    let isLoggedIn = false;
    let session = null;

    try {
        console.log("2. Checking Supabase session...");
        const sessionResult = await Promise.race([
            supabaseClient.auth.getSession(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 3000))
        ]);
        
        session = sessionResult?.data?.session;
        if (session) {
            console.log("3. Session found! User is authenticated.");
            isLoggedIn = true;
        } else {
            console.log("3. No session found. Redirecting to login.");
            window.location.href = './login.html';
            return;
        }
    } catch (error) {
        // 🔒 FIX: previously set isLoggedIn = true here, which let anyone
        // straight into the app whenever the session check errored or
        // simply took longer than 3 seconds -- effectively bypassing
        // login on any slow/flaky connection. A failed/timed-out check
        // must be treated the same as "no session found": send them to
        // login instead of granting access.
        console.warn("⚠️ Supabase session check failed or timed out. Redirecting to login.", error);
        window.location.href = './login.html';
        return;
    }

    if (!isLoggedIn) {
        window.location.href = './login.html';
        return;
    }

    // ============================================
    // 🔥 ADDED: LOOK UP THE CURRENT USER'S ROLE + NAME
    // ============================================
    let userRole = DEFAULT_ROLE;
    let displayName = session?.user?.email || 'User';
    try {
        if (session?.user?.id) {
            // Same query now also pulls the linked employee's name via
            // the FK relationship (user_profiles.employee_id ->
            // employees.employee_id), so the navbar can show a real name
            // instead of the static "User" placeholder, without a
            // second round trip.
            const { data: profile, error: profileError } = await supabaseClient
                .from('user_profiles')
                .select('role, employees(first_name, last_name)')
                .eq('id', session.user.id)
                .maybeSingle();

            if (profileError) {
                console.warn("Could not load user role, defaulting to '" + DEFAULT_ROLE + "':", profileError);
            } else if (profile?.role && ROLE_ACCESS[profile.role]) {
                userRole = profile.role;
                const emp = profile.employees;
                if (emp?.first_name) {
                    displayName = `${emp.first_name} ${emp.last_name || ''}`.trim();
                }
            } else {
                console.warn("No matching role found for this user, defaulting to '" + DEFAULT_ROLE + "'.");
            }
        }
    } catch (error) {
        console.warn("Role lookup failed, defaulting to '" + DEFAULT_ROLE + "':", error);
    }

    window.currentUserRole = userRole;
    window.currentUserName = displayName;
    const nameEl = document.getElementById('currentUserName');
    if (nameEl) nameEl.textContent = displayName;

    // 🔥 ADDED: load the real, editable permissions from the DB --
    // falls back to the hardcoded map if this table can't be reached or
    // has no rows for this role yet (e.g. before Admin has saved
    // anything from the Roles & Permissions page).
    try {
        const { data: permRows, error: permError } = await supabaseClient
            .from('role_permissions')
            .select('role, module');

        if (permError) throw permError;

        if (permRows && permRows.length > 0) {
            const dbRoleAccess = {};
            permRows.forEach(row => {
                if (!dbRoleAccess[row.role]) dbRoleAccess[row.role] = [];
                dbRoleAccess[row.role].push(row.module);
            });
            // Admin is always full access, regardless of what's stored.
            dbRoleAccess['Admin'] = FALLBACK_ROLE_ACCESS['Admin'];
            ROLE_ACCESS = dbRoleAccess;
        } else {
            console.warn("role_permissions table is empty -- using hardcoded fallback access map.");
        }
    } catch (error) {
        console.warn("Could not load role_permissions, using hardcoded fallback access map:", error);
    }

    // 🚧 TESTING MODE: skip role restriction entirely, everyone gets everything.
    const allowedModules = TESTING_MODE_ALL_ACCESS
        ? FALLBACK_ROLE_ACCESS['Admin']
        : (ROLE_ACCESS[userRole] || FALLBACK_ROLE_ACCESS[DEFAULT_ROLE]);
    console.log(`4. Role: ${userRole} | Allowed sections: ${allowedModules.join(', ')}${TESTING_MODE_ALL_ACCESS ? ' (TESTING MODE -- role restriction bypassed)' : ''}`);

    // ============================================
    // FORCE RENDER: Show the body
    // ============================================
    document.body.style.display = 'flex';
    document.body.style.opacity = '1';

    // ============================================
    // TOP MENU LOGIC
    // ============================================
    const topLinks = document.querySelectorAll('.top-link');

    // 🔥 ADDED: hide any top-level section this role isn't allowed to see.
    topLinks.forEach(link => {
        const moduleName = link.getAttribute('data-module');
        if (!allowedModules.includes(moduleName)) {
            link.style.display = 'none';
        }
    });

    topLinks.forEach(link => {
        link.addEventListener('click', function(e) {
            e.preventDefault();
            const moduleName = this.getAttribute('data-module');

            // 🔥 ADDED: defense in depth -- even if a hidden link were
            // somehow clicked (e.g. via dev tools), block loading a
            // module this role isn't allowed to see.
            if (!allowedModules.includes(moduleName)) {
                alert('You do not have access to this section.');
                return;
            }

            topLinks.forEach(l => l.classList.remove('active'));
            this.classList.add('active');
            loadModule(moduleName);
        });
    });

    // 🔥 FIX: previously always loaded 'dashboard' by default, but a
    // Staff user (per the access map above) doesn't have Dashboard
    // access at all -- loading it anyway would show them a section
    // their role shouldn't see. Load the first section this role
    // actually has access to instead.
    const defaultModule = allowedModules.includes('dashboard') ? 'dashboard' : allowedModules[0];
    if (defaultModule) {
        topLinks.forEach(l => l.classList.remove('active'));
        const defaultLink = document.querySelector(`.top-link[data-module="${defaultModule}"]`);
        if (defaultLink) defaultLink.classList.add('active');
        loadModule(defaultModule);
    } else {
        console.error("This role has no accessible sections at all.");
        document.getElementById('workspace-content').innerHTML =
            `<p class="helper-text" style="padding:50px;text-align:center;">Your account has no accessible sections. Contact an administrator.</p>`;
    }

    // ============================================
    // LOGOUT BUTTON
    // ============================================
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async (e) => {
            e.preventDefault();

            const { error } = await supabaseClient.auth.signOut();

            if (!error) {
                window.location.href = './login.html';
            } else {
                alert('Error logging out: ' + error.message);
            }
        });
    }

    // ============================================
    // 🔥 ADDED: GLOBAL KEYBOARD SHORTCUTS -- S / P / E jump straight to
    // Sales / Purchase / Expense from anywhere in the app. Registered
    // once here, in app.js, which is loaded once in the root index.html
    // and never torn down -- NOT in dashboard-view.js, which gets
    // re-injected every time Dashboard is opened and would stack up a
    // fresh duplicate listener on every visit.
    //
    // Bare keys (no Ctrl/Alt/Meta) on purpose: every existing keyboard
    // shortcut already in this app (retail/wholesale's Ctrl+S save,
    // Ctrl+Q quote, Ctrl+R clear, retail's Ctrl+H history, etc.) requires
    // a modifier, so a plain S/P/E press can never collide with any of
    // them. Skipped entirely whenever an input/textarea/select/
    // contenteditable has focus, so this never fires while someone is
    // actually typing in a form anywhere else in the app.
    // ============================================
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.altKey || e.metaKey) return;

        const target = e.target;
        const tag = target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;

        const key = e.key.toLowerCase();
        if (key === 's') { e.preventDefault(); goToTransactionSubModule('retail'); }
        else if (key === 'p') { e.preventDefault(); goToTransactionSubModule('purchase'); }
        else if (key === 'e') { e.preventDefault(); goToTransactionSubModule('expense'); }
    });
});

// ============================================
// MODULE LOADING FUNCTIONS
// ============================================

function loadModule(moduleName) {
    // 🔥 same access check at the function level, so nothing (including
    // a stray call from within a loaded module's own script) can load a
    // section outside the current role's allowed list.
    // 🚧 TESTING MODE: skip role restriction entirely, everyone gets everything.
    const allowedModules = TESTING_MODE_ALL_ACCESS
        ? FALLBACK_ROLE_ACCESS['Admin']
        : (ROLE_ACCESS[window.currentUserRole] || ROLE_ACCESS[DEFAULT_ROLE]);
    if (!allowedModules.includes(moduleName)) {
        console.warn(`Blocked: role '${window.currentUserRole}' does not have access to '${moduleName}'.`);
        return;
    }

    // 🔥 FIX: this navigation is now the latest one -- any earlier
    // navigation's fetches that resolve after this point must not touch
    // the DOM. See the navToken comment near the top of this file.
    const myToken = ++navToken;

    const sidebarContent = document.getElementById('sidebar-content');
    const workspaceContent = document.getElementById('workspace-content');
    const pageTitle = document.getElementById('page-title');

    pageTitle.textContent = moduleName.charAt(0).toUpperCase() + moduleName.slice(1) + " Module";

    fetch(`pages/${moduleName}/${moduleName}-menu.html`)
        .then(res => res.ok ? res.text() : Promise.reject('Menu not found'))
        .then(html => { if (myToken === navToken) sidebarContent.innerHTML = html; })
        .catch(() => { if (myToken === navToken) sidebarContent.innerHTML = `<p class="helper-text">No menu found for ${moduleName}</p>`; });

    // 🔥 FIX: this used to only ever fetch the view HTML. Setting
    // .innerHTML silently discards any <script> tags embedded in that
    // HTML -- browsers don't execute scripts inserted that way -- so a
    // top-level landing page (like Inventory's) could never have real
    // logic behind it, only static content. Now mirrors loadSubModule()'s
    // safe script injection: fetch the JS separately as text, then
    // create and append a real <script> element so it actually executes.
    fetch(`pages/${moduleName}/${moduleName}-view.html`)
        .then(res => res.ok ? res.text() : Promise.reject('View not found'))
        .then(html => {
            if (myToken !== navToken) return; // a newer navigation started -- drop this stale response
            workspaceContent.innerHTML = html;

            return fetch(`pages/${moduleName}/${moduleName}-view.js`)
                .then(res => res.ok ? res.text() : null)
                .then(jsCode => {
                    if (!jsCode) return;
                    if (myToken !== navToken) return; // still stale -- don't inject a script against a DOM this navigation no longer owns

                    const existingScripts = document.querySelectorAll(`script[data-view-module="${moduleName}"]`);
                    existingScripts.forEach(script => script.remove());

                    const scriptTag = document.createElement('script');
                    scriptTag.textContent = jsCode;
                    scriptTag.dataset.viewModule = moduleName;
                    document.body.appendChild(scriptTag);
                    console.log(`✅ Loaded view script for ${moduleName}`);
                });
        })
        .catch(() => { if (myToken === navToken) workspaceContent.innerHTML = `<p class="helper-text" style="margin-top:20%; text-align:center;">Select a sub-module from the sidebar.</p>`; });
}

// ============================================
// 🔥 ADDED: DASHBOARD SIDEBAR "QUICK ACTIONS" + GLOBAL KEYBOARD SHORTCUTS
// -- Sales/Purchase/Expense are sub-modules of 'transaction'
// (loadSubModule('transaction', 'retail'|'purchase'|'expense'), same
// call the real Transaction sidebar uses). loadSubModule() itself does
// NOT check role access (only loadModule() does, above) -- so without
// this wrapper, a role that isn't even allowed into 'transaction' at all
// (e.g. Accountant) could still reach it via one of these Dashboard
// shortcuts, since Dashboard is a different module that role CAN already
// open. This mirrors loadModule()'s own access check exactly, just
// scoped to whether 'transaction' specifically is allowed.
// ============================================
function goToTransactionSubModule(subModuleName) {
    const allowedModules = TESTING_MODE_ALL_ACCESS
        ? FALLBACK_ROLE_ACCESS['Admin']
        : (ROLE_ACCESS[window.currentUserRole] || ROLE_ACCESS[DEFAULT_ROLE]);
    if (!allowedModules.includes('transaction')) {
        console.warn(`Blocked: role '${window.currentUserRole}' does not have access to 'transaction'.`);
        return;
    }
    loadSubModule('transaction', subModuleName);
}
window.goToTransactionSubModule = goToTransactionSubModule;

// ============================================
// UPDATED SUB-MODULE LOADER (SAFE SCRIPT INJECTION)
// ============================================
function loadSubModule(moduleName, subModuleName) {
    console.log(`📂 Loading sub-module: ${moduleName}/${subModuleName}`);

    // 🔥 FIX: this navigation is now the latest one -- any earlier
    // navigation's fetches that resolve after this point must not touch
    // the DOM. See the navToken comment near the top of this file.
    const myToken = ++navToken;

    const workspaceContent = document.getElementById('workspace-content');

    workspaceContent.innerHTML = `<p class="helper-text" style="padding: 50px; text-align: center;"><i class="fa-solid fa-spinner fa-spin"></i> Loading ${subModuleName}...</p>`;

    if (moduleName === 'dashboard') {
        const sidebarItems = document.querySelectorAll('#sidebar-content .sidebar-menu-item');
        sidebarItems.forEach(item => item.style.background = 'transparent');
        loadModule('dashboard');
        return;
    }

    // 1. Fetch the HTML
    fetch(`pages/${moduleName}/${subModuleName}/index.html`)
        .then(res => res.ok ? res.text() : Promise.reject('HTML not found'))
        .then(html => {
            if (myToken !== navToken) return; // a newer navigation started -- drop this stale response
            workspaceContent.innerHTML = html;

            // 2. Look for a matching .js file and load it
            const scriptUrl = `pages/${moduleName}/${subModuleName}/index.js`;
            return fetch(scriptUrl)
                .then(res => {
                    if (res.ok) {
                        return res.text();
                    } else {
                        console.log(`ℹ️ No custom script found for ${subModuleName}`);
                        return null;
                    }
                })
                .then(jsCode => {
                    if (jsCode) {
                        if (myToken !== navToken) return; // still stale -- don't inject a script against a DOM this navigation no longer owns

                        // 3. REMOVE any existing script tags for this module
                        const existingScripts = document.querySelectorAll(`script[data-module="${subModuleName}"]`);
                        existingScripts.forEach(script => script.remove());

                        // Also remove scripts that were injected without data-module attribute
                        // Find scripts that contain the module name in their content
                        const allScripts = document.querySelectorAll('script');
                        allScripts.forEach(script => {
                            if (script.textContent && script.textContent.includes(`init${subModuleName.charAt(0).toUpperCase() + subModuleName.slice(1)}`)) {
                                script.remove();
                            }
                        });

                        // 4. Create a dynamic <script> tag and inject the JS code
                        const scriptTag = document.createElement('script');
                        scriptTag.textContent = jsCode;
                        scriptTag.dataset.module = subModuleName;
                        document.body.appendChild(scriptTag);
                        console.log(`✅ Loaded script for ${subModuleName}`);
                    }
                });
        })
        .catch((error) => {
            console.warn(`⚠️ Error loading ${subModuleName}:`, error);
            if (myToken !== navToken) return; // a newer navigation already took over -- leave its content alone
            workspaceContent.innerHTML = `
                <div class="card" style="text-align: center; padding: 50px;">
                    <i class="fa-regular fa-file-lines" style="font-size: 4rem; color: #94a3b8; margin-bottom: 15px;"></i>
                    <h3 style="color: #475569;">${subModuleName.charAt(0).toUpperCase() + subModuleName.slice(1)}</h3>
                    <p style="color: #94a3b8;">This module is ready for data.</p>
                    <div style="margin-top:20px; display:inline-block; background:#f1f5f9; padding:10px 20px; border-radius:6px; font-family:monospace; font-size:0.8rem; color:#475569;">
                        /pages/${moduleName}/${subModuleName}/index.html
                    </div>
                </div>
            `;
        });
}
// ============================================
// ADMIN - ROLES & PERMISSIONS
// ============================================
// Three fixed roles (not user-created). This page lets an admin adjust
// which of the 8 top-level sections Manager and Staff can see -- Admin
// itself is always full-access and locked here, matching the security
// decision that user/role management can never be delegated away from
// Admin. Saving here writes to role_permissions, which app.js reads at
// login to decide what to show.
// ============================================

(async function initAdminRolesPage() {
    console.log("Admin Roles & Permissions initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    const MODULES = [
        { key: 'dashboard', label: 'Dashboard' },
        { key: 'transaction', label: 'Transaction' },
        { key: 'account', label: 'Account' },
        { key: 'crm', label: 'CRM' },
        { key: 'hr', label: 'HR' },
        { key: 'admin', label: 'Admin' },
        { key: 'inventory', label: 'Inventory' },
        { key: 'report', label: 'Report' }
    ];
    const ROLES = ['Admin', 'Manager', 'Pharmacist', 'Accountant', 'Cashier'];

    const container = document.getElementById('rolesContainer');
    const state = { permissions: {}, userCounts: {} };

    // ============================================
    // LOAD DATA
    // ============================================
    async function loadPermissions() {
        ROLES.forEach(role => { state.permissions[role] = new Set(); });

        try {
            const { data, error } = await supabaseClient.from('role_permissions').select('*');
            if (error) throw error;
            (data || []).forEach(row => {
                if (state.permissions[row.role]) state.permissions[row.role].add(row.module);
            });
        } catch (error) {
            console.error('Error loading role_permissions:', error);
            showToast('Could not load saved permissions -- showing defaults.', 'warning');
        }

        // Admin is always full access regardless of what's actually
        // stored, so the UI never shows Admin as anything but complete.
        MODULES.forEach(m => state.permissions['Admin'].add(m.key));
    }

    async function loadUserCounts() {
        ROLES.forEach(role => { state.userCounts[role] = 0; });
        try {
            const { data, error } = await supabaseClient.from('user_profiles').select('role');
            if (error) throw error;
            (data || []).forEach(row => {
                if (state.userCounts[row.role] !== undefined) state.userCounts[row.role]++;
            });
        } catch (error) {
            console.warn('Could not load user counts:', error);
        }
    }

    // ============================================
    // RENDER
    // ============================================
    function render() {
        container.innerHTML = ROLES.map(role => {
            const isAdmin = role === 'Admin';
            const roleColor = role === 'Admin' ? '#dc2626' : role === 'Manager' ? '#2563eb' : '#475569';

            const checkboxes = MODULES.map(m => {
                const checked = state.permissions[role].has(m.key);
                return `
                    <label style="display:flex;align-items:center;gap:6px;padding:8px 12px;border:1px solid #e2e8f0;border-radius:6px;cursor:${isAdmin ? 'default' : 'pointer'};background:${checked ? '#eff6ff' : 'white'};">
                        <input type="checkbox" class="role-perm-checkbox" data-role="${role}" data-module="${m.key}" ${checked ? 'checked' : ''} ${isAdmin ? 'disabled' : ''}>
                        ${m.label}
                    </label>
                `;
            }).join('');

            return `
                <div class="card" style="padding: 20px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:15px;">
                        <div>
                            <h4 style="margin:0;color:${roleColor};">${role}</h4>
                            <span style="font-size:0.8rem;color:#94a3b8;">${state.userCounts[role]} user(s) assigned</span>
                        </div>
                        ${isAdmin
                            ? `<span style="font-size:0.75rem;background:#fee2e2;color:#dc2626;padding:4px 10px;border-radius:10px;"><i class="fa-solid fa-lock"></i> Always full access</span>`
                            : `<button class="btn btn-primary btn-sm save-role-btn" data-role="${role}"><i class="fa-solid fa-floppy-disk"></i> Save</button>`
                        }
                    </div>
                    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;">
                        ${checkboxes}
                    </div>
                </div>
            `;
        }).join('');

        // Toggle checkbox highlight on change (visual only, actual save happens on button click)
        document.querySelectorAll('.role-perm-checkbox').forEach(cb => {
            cb.addEventListener('change', function () {
                this.closest('label').style.background = this.checked ? '#eff6ff' : 'white';
            });
        });

        document.querySelectorAll('.save-role-btn').forEach(btn => {
            btn.addEventListener('click', () => saveRole(btn.dataset.role, btn));
        });
    }

    // ============================================
    // SAVE
    // ============================================
    async function saveRole(role, btn) {
        const checkedModules = Array.from(
            document.querySelectorAll(`.role-perm-checkbox[data-role="${role}"]:checked`)
        ).map(cb => cb.dataset.module);

        if (checkedModules.length === 0) {
            if (!confirm(`This will leave ${role} with NO accessible sections. Continue?`)) return;
        }

        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';

        try {
            // Simplest correct approach: replace this role's permission
            // rows entirely rather than trying to diff add/remove.
            const { error: deleteError } = await supabaseClient
                .from('role_permissions')
                .delete()
                .eq('role', role);
            if (deleteError) throw deleteError;

            if (checkedModules.length > 0) {
                const rows = checkedModules.map(module => ({ role, module }));
                const { error: insertError } = await supabaseClient.from('role_permissions').insert(rows);
                if (insertError) throw insertError;
            }

            state.permissions[role] = new Set(checkedModules);
            showToast(`${role} permissions saved. Users with this role will see the change next time they log in.`, 'success');
        } catch (error) {
            console.error('Error saving role permissions:', error);
            showToast('Error saving permissions: ' + error.message, 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save';
        }
    }

    // ============================================
    // TOAST (simple, self-contained)
    // ============================================
    function showToast(message, type = 'success') {
        const existing = document.querySelector('#rolePermToast');
        if (existing) existing.remove();
        const colors = { success: '#059669', error: '#dc2626', warning: '#f59e0b' };
        const toast = document.createElement('div');
        toast.id = 'rolePermToast';
        toast.style.cssText = `position:fixed;top:20px;right:20px;padding:14px 22px;border-radius:8px;color:white;font-weight:500;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,0.15);background:${colors[type] || colors.success};max-width:360px;`;
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 4000);
    }

    // ============================================
    // INIT
    // ============================================
    await loadPermissions();
    await loadUserCounts();
    render();

    console.log("✅ Admin Roles & Permissions initialized successfully!");
})();
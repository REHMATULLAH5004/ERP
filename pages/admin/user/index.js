// ============================================
// ADMIN - USER MANAGEMENT
// ============================================
// Registers a login account for an existing employee. Uses
// supabaseClient.auth.signUp() with the anon key (no backend/service
// role needed), with a session-preservation workaround since signUp()
// otherwise risks swapping the admin's own active session for the
// newly created user's session.
//
// SCHEMA THIS FILE NEEDS:
//   user_profiles
//     id (uuid, matches auth.users.id), employee_id (uuid, FK to
//     employees), email (text), role (text), created_at (timestamptz)
//
// auth.users itself is never queried directly from this file -- it
// isn't accessible via the normal client API. user_profiles is the
// queryable record of who has an account and what role they have.
// ============================================

(async function initAdminUserPage() {
    console.log("Admin User Management initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    const state = { employees: [], profiles: [] };

    // ============================================
    // DOM REFERENCES
    // ============================================
    const modal = document.getElementById('userModal');
    const addBtn = document.getElementById('addUserBtn');
    const closeModalBtn = document.getElementById('closeUserModalBtn');
    const cancelModalBtn = document.getElementById('cancelUserModalBtn');
    const form = document.getElementById('userForm');
    const saveBtn = document.getElementById('saveUserBtn');
    const tbody = document.getElementById('userTableBody');

    const employeeSelect = document.getElementById('userEmployee');
    const emailInput = document.getElementById('userEmail');
    const roleSelect = document.getElementById('userRole');
    const passwordInput = document.getElementById('userPassword');
    const passwordConfirmInput = document.getElementById('userPasswordConfirm');
    const formError = document.getElementById('userFormError');
    const alreadyRegisteredNote = document.getElementById('employeeAlreadyRegisteredNote');
    const noEmailNote = document.getElementById('noEmailNote');

    // 🔥 ADDED: Edit Role modal references
    const editRoleModal = document.getElementById('editRoleModal');
    const editRoleForm = document.getElementById('editRoleForm');
    const editRoleTitle = document.getElementById('editRoleTitle');
    const editRoleProfileId = document.getElementById('editRoleProfileId');
    const editRoleSelect = document.getElementById('editRoleSelect');
    const closeEditRoleModalBtn = document.getElementById('closeEditRoleModalBtn');
    const cancelEditRoleBtn = document.getElementById('cancelEditRoleBtn');
    const saveEditRoleBtn = document.getElementById('saveEditRoleBtn');

    // ============================================
    // LOAD DATA
    // ============================================
    async function loadEmployees() {
        const { data, error } = await supabaseClient
            .from('employees')
            .select('employee_id, first_name, last_name, email')
            .eq('status', 'Active')
            .order('first_name');
        if (error) { console.error('Error loading employees:', error); state.employees = []; return; }
        state.employees = data || [];
    }

    async function loadProfiles() {
        try {
            const { data, error } = await supabaseClient
                .from('user_profiles')
                .select('*')
                .order('created_at', { ascending: false });
            if (error) { console.warn('Error loading user_profiles:', error); state.profiles = []; return; }
            state.profiles = data || [];
        } catch (error) {
            console.warn('user_profiles table may not exist yet:', error);
            state.profiles = [];
        }
    }

    function populateEmployeeDropdown() {
        employeeSelect.innerHTML = `<option value="">Select Employee</option>`;
        state.employees.forEach(emp => {
            const alreadyRegistered = state.profiles.some(p => p.employee_id === emp.employee_id);
            employeeSelect.innerHTML += `
                <option value="${emp.employee_id}" data-email="${emp.email || ''}" ${alreadyRegistered ? 'data-registered="true"' : ''}>
                    ${emp.first_name} ${emp.last_name}${alreadyRegistered ? ' (already registered)' : ''}
                </option>
            `;
        });
    }

    // ============================================
    // RENDER USER LIST
    // ============================================
    function renderUsers() {
        if (state.profiles.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 30px; color: #94a3b8;">No users registered yet.</td></tr>`;
            return;
        }

        tbody.innerHTML = state.profiles.map(p => {
            const emp = state.employees.find(e => e.employee_id === p.employee_id);
            const empName = emp ? `${emp.first_name} ${emp.last_name}` : '(employee record not found)';
            const roleBg = p.role === 'Admin' ? '#fee2e2' : p.role === 'Manager' ? '#dbeafe' : '#f1f5f9';
            const roleColor = p.role === 'Admin' ? '#dc2626' : p.role === 'Manager' ? '#1d4ed8' : '#475569';
            return `
                <tr>
                    <td style="padding-left: 20px; font-weight: 500;">${empName}</td>
                    <td>${p.email}</td>
                    <td><span style="background:${roleBg};color:${roleColor};padding:3px 10px;border-radius:10px;font-size:0.75rem;font-weight:500;">${p.role}</span></td>
                    <td>${new Date(p.created_at).toLocaleDateString()}</td>
                    <td style="padding-right: 20px; text-align: right;">
                        <span style="background:#dcfce7;color:#15803d;padding:3px 10px;border-radius:10px;font-size:0.75rem;">Active</span>
                    </td>
                    <td style="text-align: right;">
                        <button class="edit-role-btn" data-id="${p.id}" data-role="${p.role}" data-name="${empName}" style="background: none; border: none; color: #3b82f6; cursor: pointer;">
                            <i class="fa-regular fa-pen-to-square"></i>
                        </button>
                    </td>
                </tr>
            `;
        }).join('');

        // 🔥 ADDED: wire up Edit Role buttons after each render
        document.querySelectorAll('.edit-role-btn').forEach(btn => {
            btn.addEventListener('click', () => openEditRoleModal(btn.dataset.id, btn.dataset.role, btn.dataset.name));
        });
    }

    // ============================================
    // 🔥 ADDED: EDIT ROLE
    // ============================================
    function openEditRoleModal(profileId, currentRole, employeeName) {
        editRoleTitle.innerHTML = `<i class="fa-solid fa-user-pen" style="color: #2563eb;"></i> Edit Role -- ${employeeName}`;
        editRoleProfileId.value = profileId;
        editRoleSelect.value = currentRole;
        editRoleModal.style.display = 'flex';
    }

    function closeEditRoleModal() { editRoleModal.style.display = 'none'; }
    closeEditRoleModalBtn.addEventListener('click', closeEditRoleModal);
    cancelEditRoleBtn.addEventListener('click', closeEditRoleModal);
    editRoleModal.addEventListener('click', (e) => { if (e.target === editRoleModal) closeEditRoleModal(); });

    editRoleForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const profileId = editRoleProfileId.value;
        const newRole = editRoleSelect.value;

        saveEditRoleBtn.disabled = true;
        saveEditRoleBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';

        try {
            const { error } = await supabaseClient
                .from('user_profiles')
                .update({ role: newRole })
                .eq('id', profileId);
            if (error) throw error;

            closeEditRoleModal();
            await refresh();
            alert(`✅ Role updated to ${newRole}. This takes effect the next time they log in.`);
        } catch (error) {
            console.error('Error updating role:', error);
            alert('Error updating role: ' + error.message);
        } finally {
            saveEditRoleBtn.disabled = false;
            saveEditRoleBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save';
        }
    });

    // ============================================
    // MODAL
    // ============================================
    function openModal() {
        form.reset();
        formError.style.display = 'none';
        alreadyRegisteredNote.style.display = 'none';
        noEmailNote.style.display = 'none';
        emailInput.value = '';
        modal.style.display = 'flex';
    }
    function closeModal() { modal.style.display = 'none'; }

    addBtn.addEventListener('click', openModal);
    closeModalBtn.addEventListener('click', closeModal);
    cancelModalBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

    // Auto-fill email when an employee is selected, and warn if they're
    // already registered or have no email on file.
    employeeSelect.addEventListener('change', function () {
        const selected = this.options[this.selectedIndex];
        const email = selected.dataset.email || '';
        const isRegistered = selected.dataset.registered === 'true';

        emailInput.value = email;
        alreadyRegisteredNote.style.display = isRegistered ? 'block' : 'none';
        noEmailNote.style.display = (!email && this.value) ? 'block' : 'none';
    });

    // ============================================
    // SUBMIT: REGISTER USER
    // ============================================
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        formError.style.display = 'none';

        const employeeId = employeeSelect.value;
        const email = emailInput.value.trim();
        const role = roleSelect.value;
        const password = passwordInput.value;
        const passwordConfirm = passwordConfirmInput.value;

        if (!employeeId) return showFormError('Please select an employee.');
        if (!email) return showFormError('This employee has no email on file. Add one in Employee Management first.');
        if (!role) return showFormError('Please select a role.');
        if (password.length < 6) return showFormError('Password must be at least 6 characters.');
        if (password !== passwordConfirm) return showFormError('Passwords do not match.');
        if (state.profiles.some(p => p.employee_id === employeeId)) {
            return showFormError('This employee is already registered.');
        }

        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Registering...';

        try {
            // 🔥 Preserve the admin's own session -- signUp() may replace
            // the SDK's active session with the newly created user's
            // session, which would otherwise silently log the admin out
            // of their own account and into the one they just created.
            const { data: currentSessionData } = await supabaseClient.auth.getSession();
            const adminSession = currentSessionData?.session || null;

            const { data: signUpData, error: signUpError } = await supabaseClient.auth.signUp({
                email,
                password,
                options: {
                    data: { employee_id: employeeId, role }
                }
            });

            if (signUpError) throw signUpError;
            if (!signUpData?.user) throw new Error('Sign up did not return a user record.');

            const newUserId = signUpData.user.id;

            // Restore the admin's session immediately, before doing
            // anything else.
            if (adminSession) {
                await supabaseClient.auth.setSession({
                    access_token: adminSession.access_token,
                    refresh_token: adminSession.refresh_token
                });
            }

            // Record the profile so this employee/role/email is
            // queryable later (auth.users itself isn't queryable from
            // client-side code).
            const { error: profileError } = await supabaseClient
                .from('user_profiles')
                .insert([{
                    id: newUserId,
                    employee_id: employeeId,
                    email,
                    role,
                    created_at: new Date().toISOString()
                }]);

            if (profileError) {
                console.error('Error saving user profile:', profileError);
                alert('⚠️ Account created, but saving the profile record failed. The user can log in, but won\'t show in this list until that\'s fixed: ' + profileError.message);
            } else {
                alert(`✅ Account registered for ${email}. They can now log in from the login page.`);
            }

            closeModal();
            await refresh();

        } catch (error) {
            console.error('Error registering user:', error);
            showFormError(error.message || 'Error registering user.');
        } finally {
            saveBtn.disabled = false;
            saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Register';
        }
    });

    function showFormError(message) {
        formError.textContent = message;
        formError.style.display = 'block';
    }

    // ============================================
    // REFRESH / INIT
    // ============================================
    async function refresh() {
        await loadEmployees();
        await loadProfiles();
        populateEmployeeDropdown();
        renderUsers();
    }

    await refresh();
    console.log("✅ Admin User Management initialized successfully!");
})();
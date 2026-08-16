// ============================================
// EMPLOYEE MANAGEMENT CONTROLLER (FINAL EDITION)
// ============================================

(async function initEmployeePage() {
    console.log("Employee page initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    // ============================================
    // 🔥 CHART OF ACCOUNTS - AUTO CREATE MISSING ACCOUNTS
    // ============================================
    // Only needed for the new Opening Advance feature -- Employee
    // Advances is a new account, Opening Balance Equity is the same one
    // already used across the rest of this system.
    const REQUIRED_ACCOUNTS = [
        { code: '1300', name: 'Employee Advances', type: 'Asset', category: 'Current Asset', normal_balance: 'Debit' },
        { code: '3000', name: 'Opening Balance Equity', type: 'Equity', category: 'Equity', normal_balance: 'Credit' }
    ];

    async function ensureChartOfAccounts() {
        try {
            for (const account of REQUIRED_ACCOUNTS) {
                const { data: existing } = await supabaseClient
                    .from('chart_of_accounts')
                    .select('code')
                    .eq('code', account.code)
                    .maybeSingle();
                if (existing) continue;

                await supabaseClient.from('chart_of_accounts').insert([{
                    code: account.code, name: account.name, type: account.type,
                    category: account.category, normal_balance: account.normal_balance,
                    created_at: new Date().toISOString(), updated_at: new Date().toISOString()
                }]);
            }
        } catch (error) {
            console.error('Error ensuring chart of accounts:', error);
        }
    }

    async function createOpeningAdvanceGLEntry(employeeId, employeeName, amount) {
        try {
            await ensureChartOfAccounts();
            const journal = {
                entry_date: new Date().toISOString().split('T')[0],
                reference: `OPEN-ADV-${String(employeeId).slice(0, 8)}`,
                description: `Opening advance for employee: ${employeeName}`,
                journal_number: `EMPADV-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
                status: 'Posted',
                created_at: new Date().toISOString()
            };
            const { data: journalData, error: jError } = await supabaseClient.from('journal_entries').insert([journal]).select();
            if (jError) throw jError;

            await supabaseClient.from('journal_lines').insert([
                { journal_entry_id: journalData[0].id, account_code: '1300', description: `Opening advance - ${employeeName}`, debit: amount, credit: 0 },
                { journal_entry_id: journalData[0].id, account_code: '3000', description: `Opening advance - ${employeeName}`, debit: 0, credit: amount }
            ]);
            console.log(`✅ Opening advance GL entry created for ${employeeName}: ZK${amount}`);
        } catch (error) {
            console.error('Error creating opening advance GL entry:', error);
        }
    }

    // ============================================
    // DOM REFERENCES
    // ============================================
    const modal = document.getElementById('employeeModal');
    const modalTitle = document.getElementById('employeeModalTitle');
    const closeModalBtn = document.getElementById('closeEmployeeModalBtn');
    const cancelModalBtn = document.getElementById('cancelEmployeeModalBtn');
    const addBtn = document.getElementById('addEmployeeBtn');
    const saveBtn = document.getElementById('saveEmployeeBtn');
    const form = document.getElementById('employeeForm');
    const hiddenId = document.getElementById('editEmployeeId');
    const tbody = document.getElementById('employeeTableBody');

    // ============================================
    // LOAD EMPLOYEES
    // ============================================
    async function loadEmployees() {
        try {
            const { data, error } = await supabaseClient
                .from('employees')
                .select(`
                    *,
                    employee_employment!employee_employment_employee_id_fkey (
                        department,
                        designation
                    )
                `)
                .order('created_at', { ascending: false });

            if (error) {
                console.error("Supabase Error Details:", error); 
                throw error; 
            }

            if (!data || data.length === 0) {
                tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 30px; color: #94a3b8;">No employees found. Click "Add Employee" to get started!</td></tr>`;
                return;
            }

            tbody.innerHTML = data.map(emp => {
                const initials = (emp.first_name?.charAt(0) || '') + (emp.last_name?.charAt(0) || '');
                const dept = emp.employee_employment?.[0]?.department || '-';
                const position = emp.employee_employment?.[0]?.designation || '-';
                
                let badgeBg = '#dcfce7', badgeColor = '#15803d';
                if (emp.status === 'Inactive') { badgeBg = '#fef3c7'; badgeColor = '#b45309'; }
                else if (emp.status === 'Resigned' || emp.status === 'Terminated') { badgeBg = '#fee2e2'; badgeColor = '#dc2626'; }

                return `
                <tr>
                    <td style="padding-left: 20px; display: flex; align-items: center; gap: 10px; font-weight: 500;">
                        <div style="width: 35px; height: 35px; background: #dbeafe; color: #2563eb; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold;">
                            ${initials}
                        </div>
                        ${emp.first_name} ${emp.last_name}
                    </td>
                    <td>${dept}</td>
                    <td>${position}</td>
                    <td>
                        <span style="background: ${badgeBg}; color: ${badgeColor}; padding: 4px 10px; border-radius: 12px; font-size: 0.75rem; display: inline-block;">
                            ${emp.status || 'Active'}
                        </span>
                    </td>
                    <td style="padding-right: 20px; text-align: right;">
                        <button onclick="window.editEmployee('${emp.employee_id}')" style="background: none; border: none; color: #3b82f6; cursor: pointer;">
                            <i class="fa-regular fa-pen-to-square"></i>
                        </button>
                    </td>
                </tr>
                `;
            }).join('');

        } catch (error) {
            console.error("Error loading employees:", error);
            tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 30px; color: #dc2626;">Error: ${error.message || error.error_description || 'Unknown error'}</td></tr>`;
        }
    }

    // ============================================
    // MODAL FUNCTIONS
    // ============================================
    function openModal(title, employeeId = null) {
        modalTitle.innerHTML = `<i class="fa-solid fa-user" style="color: #2563eb;"></i> ${title}`;
        modal.style.display = 'flex';
        
        if (employeeId) {
            hiddenId.value = employeeId;
            saveBtn.innerHTML = `<i class="fa-solid fa-pen-to-square"></i> Update Employee`;
        } else {
            hiddenId.value = '';
            saveBtn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Save Employee`;
        }
    }

    // ============================================
    // 🔥 Fixed employees have no weekly off day (every day is a working
    // day) and no annual leave (their pay isn't affected by leave or
    // overtime at all, so there's nothing for an entitlement to offset
    // against). Both fields hide together whenever Pay Category is Fixed.
    // ============================================
    function toggleFixedEmployeeFields() {
        const payCategory = document.getElementById('empPayCategory')?.value;
        const isFixed = payCategory === 'Fixed';

        const weeklyOffSelect = document.getElementById('empWeeklyOffDay');
        if (weeklyOffSelect) {
            const wrapper = weeklyOffSelect.closest('div');
            if (wrapper) wrapper.style.display = isFixed ? 'none' : '';
            weeklyOffSelect.required = !isFixed;
            if (isFixed) weeklyOffSelect.value = '';
        }

        const annualLeaveInput = document.getElementById('empAnnualLeave');
        if (annualLeaveInput) {
            const wrapper = annualLeaveInput.closest('div');
            if (wrapper) wrapper.style.display = isFixed ? 'none' : '';
            if (isFixed) annualLeaveInput.value = '0';
        }
    }

    document.getElementById('empPayCategory')?.addEventListener('change', toggleFixedEmployeeFields);

    function closeModal() {
        modal.style.display = 'none';
        form.reset();
        hiddenId.value = '';
        // 🔥 FIX: this used to also strip the 'style' attribute off every
        // field in the form -- since every field gets its actual visual
        // styling from an inline style attribute rather than a CSS
        // class, that permanently destroyed the form's appearance the
        // moment the modal was closed for the first time.
    }

    // ============================================
    // HANDLE ADD EMPLOYEE
    // ============================================
    addBtn.addEventListener('click', () => {
        form.reset();
        hiddenId.value = '';
        openModal('Add New Employee');
        toggleFixedEmployeeFields();
    });

    closeModalBtn.addEventListener('click', closeModal);
    cancelModalBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    // ============================================
    // HANDLE EDIT EMPLOYEE
    // ============================================
    window.editEmployee = async function(employeeId) {
        try {
            const { data: emp, error } = await supabaseClient
                .from('employees')
                .select(`
                    *,
                    employee_employment!employee_employment_employee_id_fkey (
                        department,
                        designation,
                        employment_type,
                        joining_date,
                        pay_category,
                        weekly_off_day,
                        annual_leave_days,
                        basic_pay,
                        allowances,
                        is_fixed_pay
                    )
                `)
                .eq('employee_id', employeeId)
                .single();

            if (error) throw error;

            openModal('Edit Employee', emp.employee_id);
            
            document.getElementById('empFirstName').value = emp.first_name || '';
            document.getElementById('empMiddleName').value = emp.middle_name || '';
            document.getElementById('empLastName').value = emp.last_name || '';
            document.getElementById('empGender').value = emp.gender || '';
            document.getElementById('empDob').value = emp.date_of_birth || '';
            document.getElementById('empNationality').value = emp.nationality || '';
            document.getElementById('empNrc').value = emp.nrc_passport || '';
            document.getElementById('empMarital').value = emp.marital_status || '';
            document.getElementById('empPhone').value = emp.phone || '';
            document.getElementById('empEmail').value = emp.email || '';
            document.getElementById('empAddress').value = emp.address || '';
            document.getElementById('empEmergName').value = emp.emergency_contact_name || '';
            document.getElementById('empEmergPhone').value = emp.emergency_contact_phone || '';

            const job = emp.employee_employment?.[0] || {};
            document.getElementById('empDepartment').value = job.department || '';
            document.getElementById('empDesignation').value = job.designation || '';
            document.getElementById('empType').value = job.employment_type || '';
            document.getElementById('empJoiningDate').value = job.joining_date || '';
            // 🔥 ADDED: populate the new explicit fields
            document.getElementById('empPayCategory').value = job.pay_category || (job.is_fixed_pay ? 'Fixed' : 'Regular');
            document.getElementById('empWeeklyOffDay').value = job.weekly_off_day || '';
            // Opening Advance is creation-only -- not applicable when editing.
            document.getElementById('empOpeningAdvance').value = 0;

            document.getElementById('empAnnualLeave').value = job.annual_leave_days || 20;
            document.getElementById('empBasicPay').value = job.basic_pay || '';
            document.getElementById('empAllowances').value = job.allowances || 0;
            toggleFixedEmployeeFields();

        } catch (error) {
            console.error("Error loading employee for edit:", error);
            alert('Error loading employee details.');
        }
    };

    // ============================================
    // HANDLE SAVE / UPDATE (FIXED)
    // ============================================
    form.addEventListener('submit', async function(e) {
        e.preventDefault();
        saveBtn.disabled = true;
        saveBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;

        const isEditing = hiddenId.value !== '';
        
        let newEmpCode = null;
        if (!isEditing) {
            const { count, error: countError } = await supabaseClient
                .from('employees')
                .select('*', { count: 'exact', head: true });
            
            if (countError) throw countError;
            newEmpCode = 'EMP' + String((count || 0) + 1).padStart(4, '0');
        }

        const empData = {
            employee_code: isEditing ? undefined : newEmpCode, 
            first_name: document.getElementById('empFirstName').value,
            middle_name: document.getElementById('empMiddleName').value || null,
            last_name: document.getElementById('empLastName').value,
            gender: document.getElementById('empGender').value,
            date_of_birth: document.getElementById('empDob').value,
            nationality: document.getElementById('empNationality').value,
            nrc_passport: document.getElementById('empNrc').value,
            marital_status: document.getElementById('empMarital').value || null,
            phone: document.getElementById('empPhone').value,
            email: document.getElementById('empEmail').value || null,
            address: document.getElementById('empAddress').value,
            emergency_contact_name: document.getElementById('empEmergName').value,
            emergency_contact_phone: document.getElementById('empEmergPhone').value,
            // 🔥 ADDED: Opening Advance
            opening_advance: parseFloat(document.getElementById('empOpeningAdvance').value) || 0,
            status: 'Active'
        };

        // 🔥 FIX: Fixed vs Regular used to be INFERRED by checking whether
        // the selected schedule's name happened to equal the literal
        // string 'Fixed / Managerial' -- a fragile, indirect way to
        // determine pay category that conflated "when someone works"
        // (the schedule) with "how leave/overtime affects their pay" (the
        // actual thing this field is for). Now read directly from the
        // explicit Pay Category field.
        const payCategory = document.getElementById('empPayCategory').value;
        const isFixedPay = payCategory === 'Fixed';

        const jobData = {
            department: document.getElementById('empDepartment').value,
            designation: document.getElementById('empDesignation').value,
            employment_type: document.getElementById('empType').value,
            joining_date: document.getElementById('empJoiningDate').value,
            pay_category: payCategory,
            is_fixed_pay: isFixedPay,
            // 🔥 Weekly Off Day and Annual Leave both forced to their
            // Fixed-employee defaults regardless of the field's current
            // value -- Fixed employees work every day (no off day
            // concept) and their pay isn't affected by leave at all (no
            // entitlement to track).
            weekly_off_day: isFixedPay ? null : (document.getElementById('empWeeklyOffDay').value || null),
            annual_leave_days: isFixedPay ? 0 : (parseInt(document.getElementById('empAnnualLeave').value) || 20),
            basic_pay: parseFloat(document.getElementById('empBasicPay').value) || 0,
            allowances: parseFloat(document.getElementById('empAllowances').value) || 0
        };

        try {
            let employeeId = hiddenId.value;
            let employeeResult;

            if (isEditing) {
                delete empData.employee_code;
                // 🔥 Opening Advance is a one-time, creation-only field
                // (matches the HTML help text) -- the edit form doesn't
                // load the existing value back into empOpeningAdvance, so
                // including it here would silently overwrite/reset
                // whatever advance is already on record.
                delete empData.opening_advance;

                // 1. UPDATE EMPLOYEE PERSONAL INFO
                const { data, error } = await supabaseClient
                    .from('employees')
                    .update(empData)
                    .eq('employee_id', employeeId)
                    .select();
                
                if (error) throw error;
                employeeResult = data;

                // 2. FIXED: Check if employment record exists
                const { data: existingJob, error: checkError } = await supabaseClient
                    .from('employee_employment')
                    .select('employment_id')
                    .eq('employee_id', employeeId)
                    .maybeSingle();

                if (checkError) throw checkError;

                if (existingJob) {
                    // If exists, UPDATE it
                    const { error: updateErr } = await supabaseClient
                        .from('employee_employment')
                        .update(jobData)
                        .eq('employee_id', employeeId);
                    
                    if (updateErr) throw updateErr;
                } else {
                    // If missing, INSERT it
                    const { error: insertErr } = await supabaseClient
                        .from('employee_employment')
                        .insert([{ ...jobData, employee_id: employeeId }]);
                    
                    if (insertErr) throw insertErr;
                }

            } else {
                // ✅ INSERT NEW EMPLOYEE
                const { data, error } = await supabaseClient
                    .from('employees')
                    .insert([empData])
                    .select();
                
                if (error) throw error;
                employeeResult = data;
                employeeId = data[0].employee_id;

                const { error: empErr } = await supabaseClient
                    .from('employee_employment')
                    .insert([{ ...jobData, employee_id: employeeId }]);
                if (empErr) throw empErr;

                // 🔥 ADDED: post the opening advance to the ledger --
                // only happens on creation, matching the same
                // opening-balance convention used for suppliers elsewhere
                // in this system (editing the value later does not
                // re-post).
                if (empData.opening_advance > 0) {
                    const fullName = `${empData.first_name} ${empData.last_name}`;
                    await createOpeningAdvanceGLEntry(employeeId, fullName, empData.opening_advance);
                }
            }

            saveBtn.innerHTML = `<i class="fa-solid fa-check"></i> Saved!`;
            setTimeout(() => {
                saveBtn.disabled = false;
                saveBtn.innerHTML = isEditing ? `<i class="fa-solid fa-pen-to-square"></i> Update Employee` : `<i class="fa-solid fa-floppy-disk"></i> Save Employee`;
            }, 1000);

            alert(`✅ Employee ${isEditing ? 'updated' : 'saved'} successfully! Code: ${isEditing ? 'Updated' : newEmpCode}`);
            closeModal();
            await loadEmployees();

        } catch (error) {
            console.error("Error saving employee:", error);
            alert('❌ Error saving employee: ' + error.message);
            saveBtn.disabled = false;
            saveBtn.innerHTML = isEditing ? `<i class="fa-solid fa-pen-to-square"></i> Update Employee` : `<i class="fa-solid fa-floppy-disk"></i> Save Employee`;
        }
    });

    // ============================================
    // INITIALIZE
    // ============================================
    await ensureChartOfAccounts();
    await loadEmployees();
    
    console.log("✅ Employee Management initialized successfully!");
})();
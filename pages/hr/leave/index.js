// ============================================
// LEAVE MANAGEMENT - ANNUAL LEAVE BALANCE SUMMARY
// ============================================
// Deliberately minimal, per instruction: just Annual Leave (entitlement)
// / Leave Taken / Remaining, calendar year, click-through to see dates.
// No Apply for Leave here (that's on Dashboard), no Renew/Cash actions
// (weren't real -- the original sample's buttons just showed alert()
// and never touched the database).
//
// Entitlement: employee_employment.annual_leave_days, set once in
//   Employee Management, NEVER mutated by approvals (fixed this
//   session -- it used to be decremented directly, which destroyed the
//   original entitlement with no way to recover it).
// Leave Taken: sum of days_requested for APPROVED leave_requests this
//   calendar year, where leave_type is 'Annual' OR 'Emergency' -- both
//   draw from the same annual leave balance, per instruction. Sick and
//   Unpaid do NOT count against this balance.
// Remaining: entitlement - taken, always computed live, never stored.
//
// Year-end unused-leave payout is explicitly deferred to a future
// Payroll module -- not built here.
// ============================================

(async function initLeavePage() {
    console.log("Leave Management initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    const tbody = document.getElementById('leaveTableBody');
    const yearStart = `${new Date().getFullYear()}-01-01`;
    const yearEnd = `${new Date().getFullYear()}-12-31`;

    let leaveRecordsByEmployee = {}; // cached for the drill-down modal

    // ============================================
    // LOAD BALANCES FOR ALL EMPLOYEES
    // ============================================
    async function loadLeaveBalances() {
        try {
            const { data: employees, error: empError } = await supabaseClient
                .from('employees')
                .select(`
                    employee_id,
                    first_name,
                    last_name,
                    employment:employee_employment!employee_employment_employee_id_fkey (
                        annual_leave_days
                    )
                `)
                .eq('status', 'Active')
                .order('first_name');

            if (empError) throw empError;

            if (!employees || employees.length === 0) {
                tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; padding: 30px; color: #94a3b8;">No active employees found.</td></tr>`;
                return;
            }

            // Annual + Emergency both draw from the same annual leave
            // balance -- Sick and Unpaid don't count against it.
            const { data: leaveRecords, error: leaveError } = await supabaseClient
                .from('leave_requests')
                .select('employee_id, leave_type, start_date, end_date, days_requested')
                .in('leave_type', ['Annual', 'Emergency'])
                .eq('status', 'Approved')
                .gte('start_date', yearStart)
                .lte('start_date', yearEnd);

            if (leaveError) throw leaveError;

            leaveRecordsByEmployee = {};
            (leaveRecords || []).forEach(l => {
                if (!leaveRecordsByEmployee[l.employee_id]) leaveRecordsByEmployee[l.employee_id] = [];
                leaveRecordsByEmployee[l.employee_id].push(l);
            });

            tbody.innerHTML = employees.map(emp => {
                const job = emp.employment?.[0] || {};
                const entitlement = job.annual_leave_days || 0;
                const records = leaveRecordsByEmployee[emp.employee_id] || [];
                const taken = records.reduce((sum, l) => sum + (l.days_requested || 0), 0);
                const remaining = entitlement - taken;

                return `
                <tr>
                    <td style="padding-left: 20px; font-weight: 500;">${emp.first_name} ${emp.last_name}</td>
                    <td style="text-align: right;">${entitlement} days</td>
                    <td style="text-align: right;">
                        <span class="leave-taken-link" data-id="${emp.employee_id}" data-name="${emp.first_name} ${emp.last_name}"
                              style="color: #2563eb; cursor: pointer; text-decoration: underline;">
                            ${taken} days
                        </span>
                    </td>
                    <td style="padding-right: 20px; text-align: right; font-weight: bold; color: ${remaining < 0 ? '#dc2626' : '#15803d'};">
                        ${remaining} days
                    </td>
                </tr>
                `;
            }).join('');

            document.querySelectorAll('.leave-taken-link').forEach(el => {
                el.addEventListener('click', function () {
                    openLeaveTakenDetail(this.dataset.id, this.dataset.name);
                });
            });

        } catch (error) {
            console.error("Error loading leave balances:", error);
            tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; padding: 30px; color: #dc2626;">Error loading balances: ${error.message}</td></tr>`;
        }
    }

    // ============================================
    // DRILL-DOWN: WHEN WAS LEAVE TAKEN
    // ============================================
    function openLeaveTakenDetail(employeeId, employeeName) {
        const modal = document.getElementById('leaveTakenModal');
        const title = document.getElementById('leaveTakenTitle');
        const list = document.getElementById('leaveTakenList');

        title.innerHTML = `<i class="fa-solid fa-calendar-days" style="color: #2563eb;"></i> ${employeeName}`;

        const records = leaveRecordsByEmployee[employeeId] || [];
        if (records.length === 0) {
            list.innerHTML = `<p style="text-align:center; color:#94a3b8; padding:20px;">No leave taken this year.</p>`;
        } else {
            list.innerHTML = records
                .sort((a, b) => new Date(a.start_date) - new Date(b.start_date))
                .map(l => `
                    <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid #f1f5f9;">
                        <div>
                            <div style="font-size:0.85rem; font-weight:500;">${l.start_date} to ${l.end_date}</div>
                            <div style="font-size:0.75rem; color:#94a3b8;">${l.leave_type}</div>
                        </div>
                        <span style="font-weight:600; color:#2563eb;">${l.days_requested}d</span>
                    </div>
                `).join('');
        }

        modal.style.display = 'flex';
    }

    document.getElementById('leaveTakenModal').addEventListener('click', (e) => {
        if (e.target.id === 'leaveTakenModal') e.target.style.display = 'none';
    });

    // ============================================
    // INITIALIZE
    // ============================================
    await loadLeaveBalances();
    console.log("✅ Leave Management initialized successfully!");
})();
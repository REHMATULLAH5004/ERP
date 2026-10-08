// ============================================
// HR OVERVIEW - LEAVE APPROVALS + EMPLOYEE ATTENDANCE VIEWER
// ============================================
// Leave approval logic and the calendar-rendering logic here are
// intentionally parallel to Dashboard's (dashboard-view.js) -- same
// isWeeklyOffDay/day-classification/leave-clipping rules, just
// parameterized by a SELECTED employee instead of the current user.
// If either file's logic changes, the other should be updated to match,
// or the two pages could show different numbers for the same employee.
// ============================================

(async function initHRView() {
    console.log("HR Overview initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    const DAY_NAMES_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    // isWeeklyOffDay and formatDateLocal now live in
    // assets/js/shared-attendance-utils.js, loaded once in the root
    // index.html -- used to be duplicated here and in attendance_index.js,
    // dashboard_view.js, and clock_in.html.

    let employees = [];

    function formatNumber(num) {
        return (num || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    // ============================================
    // LOAD EMPLOYEES FOR DROPDOWN
    // ============================================
    async function loadEmployees() {
        const { data, error } = await supabaseClient
            .from('employees')
            .select('employee_id, first_name, last_name')
            .eq('status', 'Active')
            .order('first_name');
        if (error) { console.error('Error loading employees:', error); return; }
        employees = data || [];

        const select = document.getElementById('hrEmployeeSelect');
        select.innerHTML = `<option value="">Select Employee</option>` +
            employees.map(e => `<option value="${e.employee_id}">${e.first_name} ${e.last_name}</option>`).join('');
    }

    // ============================================
    // PENDING LEAVE BADGE
    // ============================================
    async function refreshPendingBadge() {
        const { count, error } = await supabaseClient
            .from('leave_requests')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'Pending');

        const badge = document.getElementById('hrPendingBadge');
        if (error || !count) {
            badge.style.display = 'none';
            return;
        }
        badge.textContent = count;
        badge.style.display = 'flex';
    }

    // ============================================
    // LEAVE APPROVALS MODAL
    // ============================================
    async function loadApprovalsList() {
        const tbody = document.getElementById('hrApprovalsBody');
        const { data, error } = await supabaseClient
            .from('leave_requests')
            .select('*, employees(first_name, last_name)')
            .eq('status', 'Pending')
            .order('requested_at', { ascending: true });

        if (error) {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:20px;color:#dc2626;">Error loading requests.</td></tr>`;
            return;
        }
        if (!data || data.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:20px;color:#94a3b8;">No pending requests.</td></tr>`;
            return;
        }

        tbody.innerHTML = data.map(l => `
            <tr>
                <td style="padding-left:20px;">${l.employees ? l.employees.first_name + ' ' + l.employees.last_name : 'Unknown'}</td>
                <td>${l.start_date} to ${l.end_date}</td>
                <td>${l.days_requested}</td>
                <td>${l.reason || '-'}</td>
                <td style="text-align:right; padding-right:20px;">
                    <button class="btn btn-success btn-sm" onclick="hrOpenApproveType('${l.id}', '${l.employee_id}', ${l.days_requested})"><i class="fa-solid fa-check"></i> Approve</button>
                    <button class="btn btn-danger btn-sm" onclick="hrRejectLeave('${l.id}')"><i class="fa-solid fa-xmark"></i> Reject</button>
                </td>
            </tr>
        `).join('');
    }

    document.getElementById('hrOpenApprovalsBtn').addEventListener('click', async () => {
        document.getElementById('hrApprovalsModal').style.display = 'flex';
        await loadApprovalsList();
    });

    // ============================================
    // APPROVE (type decided here -- 4 options)
    // ============================================
    window.hrOpenApproveType = function (leaveId, employeeId, daysRequested) {
        document.getElementById('hrApproveLeaveId').value = leaveId;
        document.getElementById('hrApproveEmployeeId').value = employeeId;
        document.getElementById('hrApproveDays').value = daysRequested;
        document.getElementById('hrApproveType').value = '';
        document.getElementById('hrApproveTypeModal').style.display = 'flex';
    };

    document.getElementById('hrApproveForm').addEventListener('submit', async (e) => {
        e.preventDefault();

        const leaveId = document.getElementById('hrApproveLeaveId').value;
        const employeeId = document.getElementById('hrApproveEmployeeId').value;
        const daysRequested = parseInt(document.getElementById('hrApproveDays').value);
        const leaveType = document.getElementById('hrApproveType').value;

        if (!leaveType) { alert('Please select a leave type.'); return; }

        const submitBtn = document.getElementById('hrConfirmApproveBtn');
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Approving...';

        try {
            const { data: sessionData } = await supabaseClient.auth.getSession();

            // 🔥 FIX: same as Dashboard's approval flow -- annual_leave_days
            // is now a FIXED yearly entitlement, never mutated. Remaining
            // is computed live from entitlement minus already-approved
            // Annual leave this calendar year, purely for the warning.
            if (leaveType === 'Annual') {
                const yearStart = `${new Date().getFullYear()}-01-01`;
                const yearEnd = `${new Date().getFullYear()}-12-31`;

                const [jobRes, takenRes] = await Promise.all([
                    supabaseClient.from('employee_employment').select('annual_leave_days')
                        .eq('employee_id', employeeId).maybeSingle(),
                    supabaseClient.from('leave_requests').select('days_requested')
                        .eq('employee_id', employeeId).eq('leave_type', 'Annual').eq('status', 'Approved')
                        .gte('start_date', yearStart).lte('start_date', yearEnd)
                ]);
                if (jobRes.error) throw jobRes.error;

                const entitlement = jobRes.data?.annual_leave_days || 0;
                const alreadyTaken = (takenRes.data || []).reduce((sum, l) => sum + (l.days_requested || 0), 0);
                const remaining = entitlement - alreadyTaken;

                if (daysRequested > remaining) {
                    if (!confirm(`This employee only has ${remaining} annual leave day(s) remaining this year, but ${daysRequested} were requested. Approve anyway?`)) {
                        submitBtn.disabled = false;
                        submitBtn.innerHTML = '<i class="fa-solid fa-check"></i> Confirm Approval';
                        return;
                    }
                }
                // No update here -- entitlement stays fixed, remaining is derived.
            }

            const { error } = await supabaseClient
                .from('leave_requests')
                .update({
                    status: 'Approved',
                    leave_type: leaveType,
                    reviewed_by: sessionData?.session?.user?.id || null,
                    reviewed_at: new Date().toISOString()
                })
                .eq('id', leaveId);
            if (error) throw error;

            document.getElementById('hrApproveTypeModal').style.display = 'none';
            await loadApprovalsList();
            await refreshPendingBadge();
        } catch (error) {
            alert('Error approving leave: ' + error.message);
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<i class="fa-solid fa-check"></i> Confirm Approval';
        }
    });

    window.hrRejectLeave = async function (id) {
        if (!confirm('Reject this leave request?')) return;
        try {
            const { data: sessionData } = await supabaseClient.auth.getSession();
            const { error } = await supabaseClient
                .from('leave_requests')
                .update({
                    status: 'Rejected',
                    reviewed_by: sessionData?.session?.user?.id || null,
                    reviewed_at: new Date().toISOString()
                })
                .eq('id', id);
            if (error) throw error;
            await loadApprovalsList();
            await refreshPendingBadge();
        } catch (error) {
            alert('Error rejecting leave request: ' + error.message);
        }
    };

    // ============================================
    // 🔥 ADDED: ADVANCE APPROVALS
    // ============================================
    const ACCOUNTS_ENSURED = { 1300: false };
    async function ensureAdvanceAccount() {
        try {
            const { data: existing } = await supabaseClient.from('chart_of_accounts').select('code').eq('code', '1300').maybeSingle();
            if (existing) return;
            await supabaseClient.from('chart_of_accounts').insert([{
                code: '1300', name: 'Employee Advances', type: 'Asset', category: 'Current Asset',
                normal_balance: 'Debit', created_at: new Date().toISOString(), updated_at: new Date().toISOString()
            }]);
        } catch (error) {
            console.error('Error ensuring Employee Advances account:', error);
        }
    }

    async function refreshAdvancePendingBadge() {
        const { count, error } = await supabaseClient
            .from('advance_requests').select('id', { count: 'exact', head: true }).eq('status', 'Pending');
        const badge = document.getElementById('hrAdvancePendingBadge');
        if (error || !count) { badge.style.display = 'none'; return; }
        badge.textContent = count;
        badge.style.display = 'flex';
    }

    async function loadAdvanceApprovalsList() {
        const tbody = document.getElementById('hrAdvanceApprovalsBody');
        const { data, error } = await supabaseClient
            .from('advance_requests').select('*, employees(first_name, last_name)')
            .eq('status', 'Pending').order('requested_at', { ascending: true });

        if (error) {
            tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:20px;color:#dc2626;">Error loading requests.</td></tr>`;
            return;
        }
        if (!data || data.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:20px;color:#94a3b8;">No pending requests.</td></tr>`;
            return;
        }

        tbody.innerHTML = data.map(r => `
            <tr>
                <td style="padding-left:20px;">${r.employees ? r.employees.first_name + ' ' + r.employees.last_name : 'Unknown'}</td>
                <td style="text-align:right;">K${formatNumber(r.amount)}</td>
                <td>${r.reason || '-'}</td>
                <td style="text-align:right; padding-right:20px;">
                    <button class="btn btn-success btn-sm" onclick="hrOpenApproveAdvance('${r.id}', '${r.employee_id}', ${r.amount})"><i class="fa-solid fa-check"></i> Approve</button>
                    <button class="btn btn-danger btn-sm" onclick="hrRejectAdvance('${r.id}')"><i class="fa-solid fa-xmark"></i> Reject</button>
                </td>
            </tr>
        `).join('');
    }

    document.getElementById('hrOpenAdvanceApprovalsBtn').addEventListener('click', async () => {
        document.getElementById('hrAdvanceApprovalsModal').style.display = 'flex';
        await loadAdvanceApprovalsList();
    });

    window.hrOpenApproveAdvance = function (requestId, employeeId, amount) {
        document.getElementById('hrApproveAdvanceModal').dataset.requestId = requestId;
        document.getElementById('hrApproveAdvanceModal').dataset.employeeId = employeeId;
        document.getElementById('hrApproveAdvanceModal').dataset.amount = amount;
        document.getElementById('hrApproveAdvanceModal').style.display = 'flex';
    };

    window.confirmApproveAdvance = async function () {
        const modal = document.getElementById('hrApproveAdvanceModal');
        const requestId = modal.dataset.requestId;
        const employeeId = modal.dataset.employeeId;
        const amount = parseFloat(modal.dataset.amount);
        const paidFrom = document.getElementById('hrAdvancePayFrom').value;

        const btn = document.getElementById('hrConfirmAdvanceApproveBtn');
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Approving...';

        try {
            await ensureAdvanceAccount();

            // Debit Employee Advances (asset -- money owed back to the
            // company), Credit wherever the cash actually came from.
            const journal = {
                entry_date: new Date().toISOString().split('T')[0],
                reference: `ADV-${employeeId.slice(0, 8)}`,
                description: `Salary advance approved`,
                journal_number: `ADV-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
                status: 'Posted', created_at: new Date().toISOString()
            };
            const { data: journalData, error: jError } = await supabaseClient.from('journal_entries').insert([journal]).select();
            if (jError) throw jError;

            const { error: lineError } = await supabaseClient.from('journal_lines').insert([
                { journal_entry_id: journalData[0].id, account_code: '1300', description: 'Advance given', debit: amount, credit: 0 },
                { journal_entry_id: journalData[0].id, account_code: paidFrom, description: 'Advance given', debit: 0, credit: amount }
            ]);
            if (lineError) throw lineError;

            const { data: sessionData } = await supabaseClient.auth.getSession();
            const { error } = await supabaseClient.from('advance_requests').update({
                status: 'Approved', paid_from: paidFrom,
                reviewed_by: sessionData?.session?.user?.id || null, reviewed_at: new Date().toISOString()
            }).eq('id', requestId);
            if (error) throw error;

            modal.style.display = 'none';
            await loadAdvanceApprovalsList();
            await refreshAdvancePendingBadge();
            await loadOutstandingAdvances();
        } catch (error) {
            alert('Error approving advance: ' + error.message);
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-check"></i> Confirm Approval';
        }
    };

    window.hrRejectAdvance = async function (id) {
        if (!confirm('Reject this advance request?')) return;
        try {
            const { data: sessionData } = await supabaseClient.auth.getSession();
            const { error } = await supabaseClient.from('advance_requests').update({
                status: 'Rejected', reviewed_by: sessionData?.session?.user?.id || null, reviewed_at: new Date().toISOString()
            }).eq('id', id);
            if (error) throw error;
            await loadAdvanceApprovalsList();
            await refreshAdvancePendingBadge();
        } catch (error) {
            alert('Error rejecting advance request: ' + error.message);
        }
    };

    // ============================================
    // 🔥 ADDED: OUTSTANDING ADVANCES (all employees) + MANUAL SETTLEMENT
    // ============================================
    let outstandingByEmployee = {};

    async function loadOutstandingAdvances() {
        const tbody = document.getElementById('hrAdvancesBody');

        const [empRes, requestsRes, recoveriesRes] = await Promise.all([
            supabaseClient.from('employees').select('employee_id, first_name, last_name, opening_advance').eq('status', 'Active'),
            supabaseClient.from('advance_requests').select('employee_id, amount').eq('status', 'Approved'),
            supabaseClient.from('advance_recoveries').select('employee_id, amount')
        ]);

        const approvedByEmployee = {};
        (requestsRes.data || []).forEach(r => { approvedByEmployee[r.employee_id] = (approvedByEmployee[r.employee_id] || 0) + (r.amount || 0); });

        const recoveredByEmployee = {};
        (recoveriesRes.data || []).forEach(r => { recoveredByEmployee[r.employee_id] = (recoveredByEmployee[r.employee_id] || 0) + (r.amount || 0); });

        outstandingByEmployee = {};
        const rows = (empRes.data || []).map(emp => {
            const outstanding = (emp.opening_advance || 0) + (approvedByEmployee[emp.employee_id] || 0) - (recoveredByEmployee[emp.employee_id] || 0);
            outstandingByEmployee[emp.employee_id] = { name: `${emp.first_name} ${emp.last_name}`, outstanding };
            return { name: `${emp.first_name} ${emp.last_name}`, employeeId: emp.employee_id, outstanding };
        }).filter(r => r.outstanding > 0.01);

        if (rows.length === 0) {
            tbody.innerHTML = `<tr><td colspan="3" style="text-align:center;padding:20px;color:#94a3b8;">No outstanding advances.</td></tr>`;
            return;
        }

        tbody.innerHTML = rows.map(r => `
            <tr>
                <td style="padding-left:20px;">${r.name}</td>
                <td style="text-align:right; font-weight:600; color:#dc2626;">K${formatNumber(r.outstanding)}</td>
                <td style="text-align:right; padding-right:20px;">
                    <button class="btn btn-outline btn-sm" onclick="hrOpenSettleAdvance('${r.employeeId}')">Settle</button>
                </td>
            </tr>
        `).join('');
    }

    window.hrOpenSettleAdvance = function (employeeId) {
        const entry = outstandingByEmployee[employeeId];
        if (!entry) return;
        document.getElementById('hrSettleTitle').innerHTML = `<i class="fa-solid fa-hand-holding-dollar" style="color:#f59e0b;"></i> Settle: ${entry.name}`;
        document.getElementById('hrSettleAmount').value = entry.outstanding.toFixed(2);
        document.getElementById('hrSettleOutstandingNote').textContent = `Outstanding: K${formatNumber(entry.outstanding)}`;
        document.getElementById('hrSettleAdvanceModal').dataset.employeeId = employeeId;
        document.getElementById('hrSettleAdvanceModal').style.display = 'flex';
    };

    window.confirmSettleAdvance = async function () {
        const employeeId = document.getElementById('hrSettleAdvanceModal').dataset.employeeId;
        const amount = parseFloat(document.getElementById('hrSettleAmount').value);
        const receivedInto = document.getElementById('hrSettleInto').value;

        if (!amount || amount <= 0) { alert('Enter a valid amount.'); return; }

        const btn = document.getElementById('hrConfirmSettleBtn');
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Recording...';

        try {
            await ensureAdvanceAccount();

            // Cash comes IN (Debit Cash/Bank), the advance asset REDUCES
            // (Credit Employee Advances) -- opposite direction from
            // approving a new advance.
            const journal = {
                entry_date: new Date().toISOString().split('T')[0],
                reference: `ADVSETTLE-${employeeId.slice(0, 8)}`,
                description: 'Advance settled in cash',
                journal_number: `ADVS-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
                status: 'Posted', created_at: new Date().toISOString()
            };
            const { data: journalData, error: jError } = await supabaseClient.from('journal_entries').insert([journal]).select();
            if (jError) throw jError;

            const { error: lineError } = await supabaseClient.from('journal_lines').insert([
                { journal_entry_id: journalData[0].id, account_code: receivedInto, description: 'Advance settled', debit: amount, credit: 0 },
                { journal_entry_id: journalData[0].id, account_code: '1300', description: 'Advance settled', debit: 0, credit: amount }
            ]);
            if (lineError) throw lineError;

            const { data: sessionData } = await supabaseClient.auth.getSession();
            const { error } = await supabaseClient.from('advance_recoveries').insert([{
                employee_id: employeeId, amount, method: 'Manual Settlement',
                recovered_at: new Date().toISOString(), recorded_by: sessionData?.session?.user?.id || null
            }]);
            if (error) throw error;

            document.getElementById('hrSettleAdvanceModal').style.display = 'none';
            alert(`✅ K${formatNumber(amount)} settlement recorded.`);
            await loadOutstandingAdvances();
        } catch (error) {
            alert('Error recording settlement: ' + error.message);
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-check"></i> Record Settlement';
        }
    };

    // ============================================
    // EMPLOYEE CALENDAR / HOURS VIEWER
    // ============================================
    document.getElementById('hrEmployeeSelect').addEventListener('change', async function () {
        if (!this.value) {
            document.getElementById('hrCalendarPlaceholder').style.display = 'block';
            document.getElementById('hrCalendarContent').style.display = 'none';
            return;
        }
        document.getElementById('hrCalendarPlaceholder').style.display = 'none';
        document.getElementById('hrCalendarContent').style.display = 'block';
        await loadEmployeeMonthView(this.value);
    });

    async function loadEmployeeMonthView(employeeId) {
        const now = new Date();
        const year = now.getFullYear(), month = now.getMonth();
        const monthStart = formatDateLocal(year, month, 1);
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const monthEnd = formatDateLocal(year, month, daysInMonth);
        const todayStr = formatDateLocal(now.getFullYear(), now.getMonth(), now.getDate());

        const [attendanceRes, leaveRes, jobRes, holidaysRes] = await Promise.all([
            supabaseClient.from('employee_attendance').select('*')
                .eq('employee_id', employeeId)
                .gte('attendance_date', monthStart).lte('attendance_date', monthEnd),
            supabaseClient.from('leave_requests').select('start_date, end_date')
                .eq('employee_id', employeeId)
                .eq('status', 'Approved')
                .lte('start_date', monthEnd)
                .gte('end_date', monthStart),
            supabaseClient.from('employee_employment').select('weekly_off_day')
                .eq('employee_id', employeeId).maybeSingle(),
            supabaseClient.from('public_holidays').select('holiday_date, name')
                .gte('holiday_date', monthStart).lte('holiday_date', monthEnd)
        ]);

        const attendanceByDate = {};
        (attendanceRes.data || []).forEach(a => { attendanceByDate[a.attendance_date] = a; });

        const leaveDatesInMonth = new Set();
        (leaveRes.data || []).forEach(l => {
            let d = new Date(Math.max(new Date(l.start_date), new Date(monthStart)));
            const end = new Date(Math.min(new Date(l.end_date), new Date(monthEnd)));
            while (d <= end) {
                leaveDatesInMonth.add(formatDateLocal(d.getFullYear(), d.getMonth(), d.getDate()));
                d.setDate(d.getDate() + 1);
            }
        });
        // 🔥 FIX: also fold in any day attendance itself marked 'Leave',
        // regardless of whether its leave_requests row is Approved (or
        // exists at all) -- the attendance status is authoritative on its
        // own (see the calendar loop below), so this stat has to agree
        // with what the calendar actually colors purple, instead of only
        // ever counting the Approved-leave_requests subset.
        (attendanceRes.data || []).forEach(a => {
            if (a.status === 'Leave') leaveDatesInMonth.add(a.attendance_date);
        });

        const holidayDates = {};
        (holidaysRes.data || []).forEach(h => { holidayDates[h.holiday_date] = h.name; });

        const weeklyOffDay = jobRes.data?.weekly_off_day || null;

        // ---- STATS ----
        // 🔥 FIX: only count a day absent if EXPLICITLY marked that way
        // -- no record at all is unmarked, not assumed absent.
        //
        // 🔥 ADDED: "Incomplete" days -- see the matching comment on
        // loadMonthSummary() in dashboard-view.js for the full rationale.
        // Kept identical here since these two functions are intentionally
        // duplicated views of the same logic.
        let totalMinutes = 0, absentDays = 0, incompleteDays = 0;
        (attendanceRes.data || []).forEach(a => {
            if (a.status === 'Absent') absentDays++;
            if (a.check_in && a.check_out) {
                const [h1, m1] = a.check_in.split(':').map(Number);
                const [h2, m2] = a.check_out.split(':').map(Number);
                const minutes = (h2 * 60 + m2) - (h1 * 60 + m1);
                if (minutes > 0) totalMinutes += minutes;
            } else if (!a.check_in && a.status !== 'Absent' && a.status !== 'Off' && a.status !== 'Holiday Off' && a.status !== 'Leave') {
                incompleteDays++;
            }
        });

        const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
        set('hrMonthWorkedHours', (totalMinutes / 60).toFixed(1));
        set('hrMonthAbsent', absentDays);
        set('hrMonthLeave', leaveDatesInMonth.size);
        set('hrMonthIncomplete', incompleteDays);

        // ---- CALENDAR ----
        const calEl = document.getElementById('hrCalendarGrid');
        let html = DAY_NAMES_SHORT.map(d => `<div style="text-align:center; font-size:0.7rem; font-weight:600; color:#94a3b8; padding-bottom:4px;">${d}</div>`).join('');

        const firstDayOfWeek = new Date(year, month, 1).getDay();
        for (let i = 0; i < firstDayOfWeek; i++) html += `<div></div>`;

        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = formatDateLocal(year, month, day);
            const record = attendanceByDate[dateStr];
            const dayOfWeek = new Date(year, month, day).getDay();

            let bg = 'white', color = '#94a3b8', border = '1px solid #e2e8f0';

            let flagTitle = '';
            if (record && record.check_in) {
                bg = '#22c55e'; color = 'white'; border = 'none';
            } else if (record && record.status === 'Absent') {
                bg = '#ef4444'; color = 'white'; border = 'none';
            } else if (record && record.status === 'Leave') {
                // 🔥 FIX: the attendance record's own 'Leave' status is
                // authoritative on its own -- it used to only count here
                // if leaveDatesInMonth (built from APPROVED leave_requests
                // for this exact date) also matched, so a day correctly
                // marked Leave on attendance but whose leave_requests row
                // wasn't Approved (or didn't exist) fell through into the
                // Incomplete bucket below instead. Leave is leave,
                // approved or not -- don't gate this on leave_requests.
                bg = '#8b5cf6'; color = 'white'; border = 'none';
            } else if (record && record.status !== 'Off' && record.status !== 'Holiday Off') {
                // 🔥 ADDED: see the matching branch in dashboard-view.js's
                // loadMonthSummary() -- kept identical here.
                bg = '#fbbf24'; color = 'white'; border = 'none';
                flagTitle = ' -- marked "' + record.status + '" but no check-in recorded';
            } else if (leaveDatesInMonth.has(dateStr)) {
                // Fallback for an approved multi-day leave span that
                // hasn't (yet) generated a per-day attendance row.
                bg = '#8b5cf6'; color = 'white'; border = 'none';
            } else if (holidayDates[dateStr]) {
                bg = '#eab308'; color = 'white'; border = 'none';
            } else if (isWeeklyOffDay(weeklyOffDay, dayOfWeek)) {
                bg = '#cbd5e1'; color = 'white'; border = 'none';
            } else if (dateStr > todayStr) {
                bg = '#f1f5f9'; color = '#94a3b8';
            }
            // 🔥 FIX: else-branch removed -- no record means unmarked,
            // stays plain white/neutral rather than assumed Absent.

            html += `
                <div title="${dateStr}${holidayDates[dateStr] ? ' -- ' + holidayDates[dateStr] : ''}${flagTitle}"
                     style="aspect-ratio:1; display:flex; align-items:center; justify-content:center; background:${bg}; color:${color}; border:${border}; border-radius:6px; font-size:0.8rem; font-weight:500;">
                    ${day}
                </div>
            `;
        }
        calEl.innerHTML = html;
    }

    // ============================================
    // 🔥 PRINT: MONTHLY ATTENDANCE REGISTER (all employees, one page)
    // ============================================
    // Standard register format: employees as rows, days of the month as
    // columns, single-letter codes per cell. Fetches attendance/leave/
    // holidays ONCE across all employees (filtered by date range only),
    // then groups by employee in JS -- not one query per employee.
    //
    // Month is read from the #attendancePrintMonth <input type="month">
    // next to the button (defaulted to the current month on page load --
    // see INIT below). "today" for the P/A/upcoming-day logic below is
    // always the REAL current date, not the selected print month, so
    // printing a future month still blanks out days that haven't happened
    // yet instead of marking them absent.
    //
    // NOTE: `employees` is loaded once at page init filtered to
    // status = 'Active' (see loadEmployees above) -- someone who has
    // since left will not appear on a register printed for a past month
    // they actually worked, and someone hired after that month will. This
    // mirrors the existing employee-list behavior elsewhere on this page;
    // fixing it would need hire/termination dates factored into the
    // employee list query, which is out of scope here.
    window.printMonthlyAttendance = async function () {
        const now = new Date();
        const picker = document.getElementById('attendancePrintMonth');
        let year = now.getFullYear(), month = now.getMonth();
        if (picker && picker.value) {
            const [y, m] = picker.value.split('-').map(Number);
            year = y; month = m - 1; // <input type="month"> gives 1-12, Date wants 0-11
        }
        const monthStart = formatDateLocal(year, month, 1);
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const monthEnd = formatDateLocal(year, month, daysInMonth);
        const todayStr = formatDateLocal(now.getFullYear(), now.getMonth(), now.getDate());
        const monthLabel = new Date(year, month, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

        const [attendanceRes, leaveRes, jobsRes, holidaysRes] = await Promise.all([
            supabaseClient.from('employee_attendance').select('*')
                .gte('attendance_date', monthStart).lte('attendance_date', monthEnd),
            supabaseClient.from('leave_requests').select('employee_id, start_date, end_date')
                .eq('status', 'Approved')
                .lte('start_date', monthEnd).gte('end_date', monthStart),
            supabaseClient.from('employee_employment').select('employee_id, weekly_off_day'),
            supabaseClient.from('public_holidays').select('holiday_date, name')
                .gte('holiday_date', monthStart).lte('holiday_date', monthEnd)
        ]);

        // Group everything by employee_id for fast lookup while building rows
        const attendanceByEmployee = {};
        (attendanceRes.data || []).forEach(a => {
            if (!attendanceByEmployee[a.employee_id]) attendanceByEmployee[a.employee_id] = {};
            attendanceByEmployee[a.employee_id][a.attendance_date] = a;
        });

        const leaveDatesByEmployee = {};
        (leaveRes.data || []).forEach(l => {
            if (!leaveDatesByEmployee[l.employee_id]) leaveDatesByEmployee[l.employee_id] = new Set();
            let d = new Date(Math.max(new Date(l.start_date), new Date(monthStart)));
            const end = new Date(Math.min(new Date(l.end_date), new Date(monthEnd)));
            while (d <= end) {
                leaveDatesByEmployee[l.employee_id].add(formatDateLocal(d.getFullYear(), d.getMonth(), d.getDate()));
                d.setDate(d.getDate() + 1);
            }
        });

        const weeklyOffByEmployee = {};
        (jobsRes.data || []).forEach(j => { weeklyOffByEmployee[j.employee_id] = j.weekly_off_day; });

        const holidayDates = {};
        (holidaysRes.data || []).forEach(h => { holidayDates[h.holiday_date] = true; });

        // ---- BUILD ONE ROW PER EMPLOYEE ----
        const rows = employees.map(emp => {
            const empAttendance = attendanceByEmployee[emp.employee_id] || {};
            const empLeaveDates = leaveDatesByEmployee[emp.employee_id] || new Set();
            const weeklyOff = weeklyOffByEmployee[emp.employee_id];

            let presentCount = 0, absentCount = 0, leaveCount = 0, incompleteCount = 0, totalMinutes = 0;
            let cells = '';

            for (let day = 1; day <= daysInMonth; day++) {
                const dateStr = formatDateLocal(year, month, day);
                const record = empAttendance[dateStr];
                const dayOfWeek = new Date(year, month, day).getDay();

                // 🔥 FIX: no record no longer defaults to Absent -- only
                // an EXPLICIT status of 'Absent' counts as absent now.
                //
                // 🔥 CHANGED: a Present day used to just print "P" -- now
                // it prints the actual check-in/check-out times (what
                // HOURS WORKED is actually derived from), stacked on two
                // lines, so the register itself shows the hours an
                // employee was clocked in rather than just a yes/no mark.
                // `code` still carries 'P' for the presentCount tally and
                // the cell's displayed content is built separately into
                // `cellContent`, since a time pair doesn't fit the
                // single-letter pattern the other statuses use.
                let code = '', bg = 'white', cellContent = '';
                if (record && record.check_in) {
                    code = 'P'; bg = '#dcfce7'; presentCount++;
                    const inTime = record.check_in.slice(0, 5);
                    const outTime = record.check_out ? record.check_out.slice(0, 5) : '--:--';
                    cellContent = `<div>${inTime}</div><div style="color:#64748b;">${outTime}</div>`;
                    if (record.check_in && record.check_out) {
                        const [h1, m1] = record.check_in.split(':').map(Number);
                        const [h2, m2] = record.check_out.split(':').map(Number);
                        const minutes = (h2 * 60 + m2) - (h1 * 60 + m1);
                        if (minutes > 0) totalMinutes += minutes;
                    }
                } else if (record && record.status === 'Absent') {
                    code = 'A'; bg = '#fee2e2'; absentCount++;
                } else if (record && record.status === 'Leave') {
                    // 🔥 FIX: the attendance record's own 'Leave' status is
                    // authoritative by itself -- this used to require
                    // empLeaveDates (built from APPROVED leave_requests
                    // covering this date) to also match, so a day correctly
                    // marked Leave on attendance but backed by a
                    // not-yet-approved (or missing) leave_requests row fell
                    // through into the Incomplete branch below instead.
                    // Leave is leave, approved or not.
                    code = 'L'; bg = '#ede9fe'; leaveCount++;
                } else if (record && record.status !== 'Off' && record.status !== 'Holiday Off') {
                    // 🔥 ADDED: a record exists (e.g. status 'Present')
                    // but no check_in was ever recorded -- see the
                    // "Incomplete" stat on the Dashboard sidebar and HR's
                    // calendar widget for the full rationale. This is
                    // exactly the gap that makes this printed register
                    // disagree with those two widgets' worked-hours total
                    // if left uncounted, since it used to render as a
                    // blank cell here (neither P nor A).
                    code = 'I'; bg = '#fef3c7'; incompleteCount++;
                } else if (empLeaveDates.has(dateStr)) {
                    // Fallback for an approved multi-day leave span that
                    // hasn't (yet) generated a per-day attendance row.
                    code = 'L'; bg = '#ede9fe'; leaveCount++;
                } else if (holidayDates[dateStr]) {
                    code = 'H'; bg = '#fef9c3';
                } else if (weeklyOff === DAY_NAMES[dayOfWeek]) {
                    code = 'O'; bg = '#f1f5f9';
                } else if (dateStr > todayStr) {
                    code = ''; bg = 'white';
                } else {
                    code = ''; bg = 'white'; // unmarked, not assumed absent
                }
                // Every non-Present status still prints as its single
                // letter -- only Present got the richer two-line time
                // treatment above.
                if (!cellContent) cellContent = code;
                cells += `<td style="background:${bg}; text-align:center; padding:1px; width:32px; line-height:1.15;">${cellContent}</td>`;
            }

            return { name: `${emp.first_name} ${emp.last_name}`, cells, presentCount, absentCount, leaveCount, incompleteCount, totalHours: totalMinutes / 60 };
        });

        // ---- BUILD PRINT WINDOW ----
        let dayHeaderCells = '';
        for (let day = 1; day <= daysInMonth; day++) {
            dayHeaderCells += `<th style="width:32px; font-size:0.65rem;">${day}</th>`;
        }

        const rowsHtml = rows.map(r => `
            <tr>
                <td style="white-space:nowrap; padding:3px 8px; font-weight:500;">${r.name}</td>
                ${r.cells}
                <td style="text-align:center; font-weight:600; color:#059669;">${r.presentCount}</td>
                <td style="text-align:center; font-weight:600; color:#dc2626;">${r.absentCount}</td>
                <td style="text-align:center; font-weight:600; color:#8b5cf6;">${r.leaveCount}</td>
                <td style="text-align:center; font-weight:600; color:#d97706;">${r.incompleteCount}</td>
                <td style="text-align:center; font-weight:600; color:#0f172a;">${r.totalHours.toFixed(1)}</td>
            </tr>
        `).join('');

        const printWindow = window.open('', '_blank', 'width=1200,height=700');
        if (!printWindow) { alert('Please allow popups to print.'); return; }

        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Attendance Register - ${monthLabel}</title>
                <style>
                    @page { size: landscape; margin: 10mm; }
                    body { font-family: Arial, sans-serif; color: #0f172a; }
                    h1 { margin-bottom: 2px; font-size: 1.3rem; }
                    .subtitle { color: #64748b; margin-top: 0; margin-bottom: 14px; font-size: 0.85rem; }
                    .legend { display: flex; gap: 16px; margin-bottom: 12px; font-size: 0.75rem; flex-wrap: wrap; }
                    .legend span { display: flex; align-items: center; gap: 4px; }
                    .swatch { display: inline-block; width: 10px; height: 10px; border: 1px solid #cbd5e1; }
                    table { border-collapse: collapse; width: 100%; font-size: 0.6rem; }
                    th, td { border: 1px solid #e2e8f0; }
                    th { background: #f1f5f9; padding: 3px 2px; }
                </style>
            </head>
            <body>
                <h1>Monthly Attendance Register</h1>
                <p class="subtitle">${monthLabel} &middot; Generated ${new Date().toLocaleString()}</p>
                <div class="legend">
                    <span><span class="swatch" style="background:#dcfce7;"></span> P = Present (shown as check-in / check-out time)</span>
                    <span><span class="swatch" style="background:#fee2e2;"></span> A = Absent</span>
                    <span><span class="swatch" style="background:#ede9fe;"></span> L = Leave</span>
                    <span><span class="swatch" style="background:#fef9c3;"></span> H = Holiday</span>
                    <span><span class="swatch" style="background:#f1f5f9;"></span> O = Off Day</span>
                    <span><span class="swatch" style="background:#fef3c7;"></span> I = Incomplete (marked present, no check-in recorded)</span>
                </div>
                <table>
                    <thead>
                        <tr>
                            <th style="text-align:left; padding-left:8px;">Employee</th>
                            ${dayHeaderCells}
                            <th>P</th><th>A</th><th>L</th><th>I</th><th>Hrs</th>
                        </tr>
                    </thead>
                    <tbody>${rowsHtml}</tbody>
                </table>
                <script>window.onload = function() { window.print(); };<\/script>
            </body>
            </html>
        `);
        printWindow.document.close();
    };

    // ============================================
    // INIT
    // ============================================
    const attendancePrintMonthEl = document.getElementById('attendancePrintMonth');
    if (attendancePrintMonthEl) {
        const now = new Date();
        attendancePrintMonthEl.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }

    await loadEmployees();
    await refreshPendingBadge();
    await refreshAdvancePendingBadge();
    await loadOutstandingAdvances();

    console.log("✅ HR Overview initialized successfully!");
})();
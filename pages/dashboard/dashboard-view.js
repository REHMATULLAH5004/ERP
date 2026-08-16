// ============================================
// DASHBOARD - QUICK ATTENDANCE + LEAVE REQUEST
// ============================================
// Self-service: this page always acts on the CURRENT logged-in user's
// own attendance and leave, resolved via user_profiles -> employees.
// This is different from HR > Attendance, which lets an authorized
// person administer ANY employee's attendance via a dropdown.
//
// Reuses the exact same off-day/holiday detection logic already built
// and validated in HR > Attendance (isWeeklyOffDay, isPublicHoliday) --
// not reinvented here, since a second divergent implementation writing
// to the same employee_attendance table would risk the two disagreeing.
//
// SCHEMA THIS FILE NEEDS:
//   employee_attendance: add columns check_in_lat, check_in_lng,
//     check_in_distance_meters (all NUMERIC, nullable)
//   leave_requests (new table):
//     id uuid pk, employee_id uuid, leave_type text, start_date date,
//     end_date date, days_requested int, reason text,
//     status text default 'Pending', requested_at timestamptz,
//     reviewed_by uuid, reviewed_at timestamptz, review_note text
// ============================================

(async function initDashboard() {
    console.log("Dashboard initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    // 🔥 FIX: GPS-based location check removed -- superseded by
    // QR-code-based clock-in (see clock-in.html), which is genuinely
    // harder to spoof than a soft GPS check that never blocked anything
    // anyway. Attendance now only happens via the QR Station.
    //
    // isWeeklyOffDay and formatDateLocal now live in
    // assets/js/shared-attendance-utils.js, loaded once in the root
    // index.html -- used to be duplicated here and in
    // attendance_index.js, hr_view.js, and clock_in.html.

    async function isPublicHoliday(dateStr) {
        const { data, error } = await supabaseClient
            .from('public_holidays')
            .select('name')
            .eq('holiday_date', dateStr)
            .maybeSingle();
        if (error) return false;
        return data ? data.name : false;
    }

    let currentEmployeeId = null;
    let currentEmployeeName = '';

    // ============================================
    // RESOLVE CURRENT USER -> EMPLOYEE
    // ============================================
    async function resolveCurrentEmployee() {
        const { data: sessionData } = await supabaseClient.auth.getSession();
        const userId = sessionData?.session?.user?.id;
        if (!userId) return;

        const { data: profile, error } = await supabaseClient
            .from('user_profiles')
            .select('employee_id, employees(first_name, last_name)')
            .eq('id', userId)
            .maybeSingle();

        if (error || !profile?.employee_id) {
            console.warn('Could not resolve current employee from user_profiles:', error);
            return;
        }
        currentEmployeeId = profile.employee_id;
        currentEmployeeName = profile.employees ? `${profile.employees.first_name} ${profile.employees.last_name}` : '';
    }

    // ============================================
    // QUICK ATTENDANCE
    // ============================================
    async function loadTodayAttendance() {
        const statusEl = document.getElementById('dashAttendanceStatus');
        if (!currentEmployeeId) {
            statusEl.innerHTML = `<span style="color:#dc2626;">Your login isn't linked to an employee record. Contact an admin.</span>`;
            return null;
        }

        const today = new Date().toISOString().split('T')[0];
        const { data, error } = await supabaseClient
            .from('employee_attendance')
            .select('*')
            .eq('employee_id', currentEmployeeId)
            .eq('attendance_date', today)
            .maybeSingle();

        if (error) {
            statusEl.innerHTML = `<span style="color:#dc2626;">Error loading attendance.</span>`;
            return null;
        }

        renderAttendanceStatus(data);
        return data;
    }

    // 🔥 FIX: this used to manage Clock In/Out button state (and had a
    // real bug where it never restored button labels after a request).
    // Both problems are now moot -- there are no clock buttons on this
    // page anymore, attendance only comes from the QR Station. This is
    // purely a read-only display of whatever's already recorded.
    function renderAttendanceStatus(record) {
        const statusEl = document.getElementById('dashAttendanceStatus');

        if (!record || !record.check_in) {
            statusEl.innerHTML = `<span style="color:#94a3b8;">Not clocked in yet today.</span>`;
        } else if (record.check_in && !record.check_out) {
            statusEl.innerHTML = `<span style="color:#059669;"><i class="fa-solid fa-circle-check"></i> Clocked in at ${record.check_in}</span>`;
        } else {
            statusEl.innerHTML = `<span style="color:#2563eb;"><i class="fa-solid fa-circle-check"></i> Done for today: ${record.check_in} - ${record.check_out}</span>`;
        }
    }

    // ============================================
    // LEAVE REQUEST -- MY OWN
    // ============================================
    async function loadMyLeave() {
        const listEl = document.getElementById('dashMyLeaveList');
        if (!currentEmployeeId) { listEl.innerHTML = ''; return; }

        const { data, error } = await supabaseClient
            .from('leave_requests')
            .select('*')
            .eq('employee_id', currentEmployeeId)
            .order('requested_at', { ascending: false })
            .limit(5);

        if (error) {
            listEl.innerHTML = `<p style="color:#dc2626;font-size:0.85rem;">Error loading leave requests.</p>`;
            return;
        }

        if (!data || data.length === 0) {
            listEl.innerHTML = `<p style="color:#94a3b8;text-align:center;padding:20px;">No leave requests yet.</p>`;
            return;
        }

        const statusColors = { Pending: ['#fef3c7', '#b45309'], Approved: ['#dcfce7', '#15803d'], Rejected: ['#fee2e2', '#dc2626'] };
        listEl.innerHTML = data.map(l => {
            const [bg, color] = statusColors[l.status] || ['#f1f5f9', '#475569'];
            return `
                <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid #f1f5f9;">
                    <div>
                        <div style="font-weight:500; font-size:0.85rem;">${l.leave_type || 'Type pending review'} (${l.days_requested}d)</div>
                        <div style="font-size:0.75rem; color:#94a3b8;">${l.start_date} to ${l.end_date}</div>
                    </div>
                    <span style="background:${bg}; color:${color}; padding:3px 10px; border-radius:10px; font-size:0.75rem; font-weight:500;">${l.status}</span>
                </div>
            `;
        }).join('');
    }

    document.getElementById('dashLeaveForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!currentEmployeeId) { alert('Your login is not linked to an employee record.'); return; }

        const start = document.getElementById('dashLeaveStart').value;
        const end = document.getElementById('dashLeaveEnd').value;
        if (new Date(end) < new Date(start)) { alert('End date must be on or after start date.'); return; }

        const days = Math.round((new Date(end) - new Date(start)) / (1000 * 60 * 60 * 24)) + 1;
        const submitBtn = document.getElementById('dashSubmitLeaveBtn');
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Submitting...';

        try {
            const { error } = await supabaseClient.from('leave_requests').insert([{
                employee_id: currentEmployeeId,
                leave_type: null, // 🔥 HR decides this at approval time, not the employee
                start_date: start,
                end_date: end,
                days_requested: days,
                reason: document.getElementById('dashLeaveReason').value.trim() || null,
                status: 'Pending',
                requested_at: new Date().toISOString()
            }]);
            if (error) throw error;

            document.getElementById('dashLeaveForm').reset();
            document.getElementById('dashLeaveModal').style.display = 'none';
            await loadMyLeave();
        } catch (error) {
            alert('Error submitting leave request: ' + error.message);
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Submit';
        }
    });

    // ============================================
    // ADMIN: PENDING APPROVALS (only Admin role)
    // ============================================
    async function loadAdminApprovals() {
        if (window.currentUserRole !== 'Admin') return;

        const card = document.getElementById('dashAdminApprovalsCard');
        card.style.display = 'block';
        const tbody = document.getElementById('dashAdminApprovalsBody');

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

        // 🔥 Type column removed here -- for a Pending request, the
        // employee never set one (HR decides it as part of approving),
        // so there's nothing meaningful to show yet.
        tbody.innerHTML = data.map(l => `
            <tr>
                <td style="padding-left:20px;">${l.employees ? l.employees.first_name + ' ' + l.employees.last_name : 'Unknown'}</td>
                <td>${l.start_date} to ${l.end_date}</td>
                <td>${l.days_requested}</td>
                <td>${l.reason || '-'}</td>
                <td style="text-align:right; padding-right:20px;">
                    <button class="btn btn-success btn-sm" onclick="openApproveLeaveModal('${l.id}', '${l.employee_id}', ${l.days_requested})"><i class="fa-solid fa-check"></i> Approve</button>
                    <button class="btn btn-danger btn-sm" onclick="rejectLeaveRequest('${l.id}')"><i class="fa-solid fa-xmark"></i> Reject</button>
                </td>
            </tr>
        `).join('');
    }

    // ============================================
    // 🔥 APPROVE: HR decides the type here, not the employee. Only
    // Annual and Unpaid are real options -- this business doesn't track
    // sick leave as its own category at all.
    //   Annual -> paid, deducts days_requested from the employee's
    //     annual_leave_days balance.
    //   Unpaid -> not paid, salary deduction happens at payroll time --
    //     there's no payroll module yet, so this just records the
    //     decision accurately for whenever that exists.
    // ============================================
    window.openApproveLeaveModal = function (leaveId, employeeId, daysRequested) {
        document.getElementById('dashApproveLeaveId').value = leaveId;
        document.getElementById('dashApproveEmployeeId').value = employeeId;
        document.getElementById('dashApproveDays').value = daysRequested;
        document.getElementById('dashApproveType').value = '';
        document.getElementById('dashApproveModal').style.display = 'flex';
    };

    document.getElementById('dashApproveForm').addEventListener('submit', async (e) => {
        e.preventDefault();

        const leaveId = document.getElementById('dashApproveLeaveId').value;
        const employeeId = document.getElementById('dashApproveEmployeeId').value;
        const daysRequested = parseInt(document.getElementById('dashApproveDays').value);
        const leaveType = document.getElementById('dashApproveType').value;

        if (!leaveType) { alert('Please select a leave type.'); return; }

        const submitBtn = document.getElementById('dashConfirmApproveBtn');
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Approving...';

        try {
            const { data: sessionData } = await supabaseClient.auth.getSession();

            // 🔥 FIX: annual_leave_days is the FIXED yearly entitlement,
            // never mutated by approvals -- Remaining is always computed
            // live (here, and on the Leave Management page) as
            // entitlement minus sum of already-approved Annual leave
            // this calendar year. Previously this directly decremented
            // annual_leave_days on every approval, which destroyed the
            // original entitlement figure with no way to recover it.
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

            document.getElementById('dashApproveModal').style.display = 'none';
            await loadAdminApprovals();
            showToastSimple(`Leave approved as ${leaveType}${leaveType === 'Annual' ? ' -- balance updated' : leaveType === 'Unpaid' ? ' -- flag for payroll deduction' : ''}.`);
        } catch (error) {
            alert('Error approving leave: ' + error.message);
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<i class="fa-solid fa-check"></i> Confirm Approval';
        }
    });

    window.rejectLeaveRequest = async function (id) {
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
            await loadAdminApprovals();
        } catch (error) {
            alert('Error rejecting leave request: ' + error.message);
        }
    };

    function showToastSimple(message) {
        const toast = document.createElement('div');
        toast.style.cssText = 'position:fixed;top:20px;right:20px;padding:14px 22px;border-radius:8px;color:white;font-weight:500;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,0.15);background:#059669;max-width:360px;';
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 4000);
    }

    // ============================================
    // 🔥 THIS MONTH SUMMARY + CALENDAR -- worked hours, absent days,
    // leave days taken, and a color-coded day-by-day grid, all for the
    // current employee, current calendar month.
    // ============================================
    const DAY_NAMES_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    async function loadMonthSummary() {
        if (!currentEmployeeId) return;

        const now = new Date();
        const year = now.getFullYear(), month = now.getMonth();
        const monthStart = formatDateLocal(year, month, 1);
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const monthEnd = formatDateLocal(year, month, daysInMonth);
        const todayStr = formatDateLocal(now.getFullYear(), now.getMonth(), now.getDate());

        const [attendanceRes, leaveRes, jobRes, holidaysRes] = await Promise.all([
            supabaseClient.from('employee_attendance').select('*')
                .eq('employee_id', currentEmployeeId)
                .gte('attendance_date', monthStart).lte('attendance_date', monthEnd),
            // 🔥 FIX: previously only caught leave requests whose
            // start_date fell within this month, missing any that span
            // across a month boundary. Correct overlap condition: the
            // request started on or before month-end AND ends on or
            // after month-start.
            supabaseClient.from('leave_requests').select('start_date, end_date')
                .eq('employee_id', currentEmployeeId)
                .eq('status', 'Approved')
                .lte('start_date', monthEnd)
                .gte('end_date', monthStart),
            supabaseClient.from('employee_employment').select('weekly_off_day')
                .eq('employee_id', currentEmployeeId).maybeSingle(),
            supabaseClient.from('public_holidays').select('holiday_date, name')
                .gte('holiday_date', monthStart).lte('holiday_date', monthEnd)
        ]);

        const attendanceByDate = {};
        (attendanceRes.data || []).forEach(a => { attendanceByDate[a.attendance_date] = a; });

        // Build the set of actual leave DAYS within this month (clipped
        // to month boundaries), not just a raw sum of days_requested,
        // which would overcount a request that partly falls outside it.
        const leaveDatesInMonth = new Set();
        (leaveRes.data || []).forEach(l => {
            let d = new Date(Math.max(new Date(l.start_date), new Date(monthStart)));
            const end = new Date(Math.min(new Date(l.end_date), new Date(monthEnd)));
            while (d <= end) {
                leaveDatesInMonth.add(formatDateLocal(d.getFullYear(), d.getMonth(), d.getDate()));
                d.setDate(d.getDate() + 1);
            }
        });

        const holidayDates = {};
        (holidaysRes.data || []).forEach(h => { holidayDates[h.holiday_date] = h.name; });

        const weeklyOffDay = jobRes.data?.weekly_off_day || null;

        // ---- STATS ----
        // 🔥 FIX: only count a day as absent if it was EXPLICITLY marked
        // that way (e.g. via HR's Mark Absent) -- a day with simply no
        // record at all is unmarked, not assumed absent.
        let totalMinutes = 0, absentDays = 0;
        (attendanceRes.data || []).forEach(a => {
            if (a.status === 'Absent') absentDays++;
            if (a.check_in && a.check_out) {
                const [h1, m1] = a.check_in.split(':').map(Number);
                const [h2, m2] = a.check_out.split(':').map(Number);
                const minutes = (h2 * 60 + m2) - (h1 * 60 + m1);
                if (minutes > 0) totalMinutes += minutes;
            }
        });

        const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
        set('dashMonthWorkedHours', (totalMinutes / 60).toFixed(1));
        set('dashMonthAbsent', absentDays);
        set('dashMonthLeave', leaveDatesInMonth.size);

        // ---- CALENDAR ----
        const calEl = document.getElementById('dashMonthCalendar');
        if (!calEl) return;

        let html = DAY_NAMES_SHORT.map(d => `<div style="text-align:center; font-size:0.7rem; font-weight:600; color:#94a3b8; padding-bottom:4px;">${d}</div>`).join('');

        const firstDayOfWeek = new Date(year, month, 1).getDay();
        for (let i = 0; i < firstDayOfWeek; i++) html += `<div></div>`;

        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = formatDateLocal(year, month, day);
            const record = attendanceByDate[dateStr];
            const dayOfWeek = new Date(year, month, day).getDay();

            let bg = 'white', color = '#94a3b8', border = '1px solid #e2e8f0';

            if (record && record.check_in) {
                bg = '#22c55e'; color = 'white'; border = 'none';        // Present
            } else if (record && record.status === 'Absent') {
                bg = '#ef4444'; color = 'white'; border = 'none';        // Explicitly marked Absent
            } else if (leaveDatesInMonth.has(dateStr)) {
                bg = '#8b5cf6'; color = 'white'; border = 'none';        // On Leave
            } else if (holidayDates[dateStr]) {
                bg = '#eab308'; color = 'white'; border = 'none';        // Holiday
            } else if (isWeeklyOffDay(weeklyOffDay, dayOfWeek)) {
                bg = '#cbd5e1'; color = 'white'; border = 'none';        // Off Day
            } else if (dateStr > todayStr) {
                bg = '#f1f5f9'; color = '#94a3b8';                        // Upcoming
            }
            // 🔥 FIX: else-branch removed -- no record simply means
            // nothing happened yet or nothing was entered, not an
            // assumed absence. Stays plain white/neutral.

            html += `
                <div title="${dateStr}${holidayDates[dateStr] ? ' -- ' + holidayDates[dateStr] : ''}"
                     style="aspect-ratio:1; display:flex; align-items:center; justify-content:center; background:${bg}; color:${color}; border:${border}; border-radius:6px; font-size:0.8rem; font-weight:500;">
                    ${day}
                </div>
            `;
        }
        calEl.innerHTML = html;
    }

    // ============================================
    // 🔥 ADDED: ADVANCE REQUEST -- MY OWN
    // ============================================
    async function loadMyAdvances() {
        const listEl = document.getElementById('dashMyAdvanceList');
        if (!currentEmployeeId) { listEl.innerHTML = ''; return; }

        const [empRes, requestsRes, recoveriesRes] = await Promise.all([
            supabaseClient.from('employees').select('opening_advance').eq('employee_id', currentEmployeeId).maybeSingle(),
            supabaseClient.from('advance_requests').select('*').eq('employee_id', currentEmployeeId).order('requested_at', { ascending: false }).limit(5),
            supabaseClient.from('advance_recoveries').select('amount').eq('employee_id', currentEmployeeId)
        ]);

        const openingAdvance = empRes.data?.opening_advance || 0;
        const approvedTotal = (requestsRes.data || []).filter(r => r.status === 'Approved').reduce((s, r) => s + (r.amount || 0), 0);
        const recoveredTotal = (recoveriesRes.data || []).reduce((s, r) => s + (r.amount || 0), 0);
        const outstanding = openingAdvance + approvedTotal - recoveredTotal;

        const balanceHtml = `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 0 12px 0; margin-bottom:8px; border-bottom:1px solid #f1f5f9;">
                <span style="font-size:0.8rem; color:#64748b;">Outstanding balance</span>
                <span style="font-weight:700; color:${outstanding > 0 ? '#dc2626' : '#15803d'};">K${outstanding.toFixed(2)}</span>
            </div>
        `;

        if (requestsRes.error) {
            listEl.innerHTML = balanceHtml + `<p style="color:#dc2626;font-size:0.85rem;">Error loading advance requests.</p>`;
            return;
        }
        if (!requestsRes.data || requestsRes.data.length === 0) {
            listEl.innerHTML = balanceHtml + `<p style="color:#94a3b8;text-align:center;padding:12px;">No advance requests yet.</p>`;
            return;
        }

        const statusColors = { Pending: ['#fef3c7', '#b45309'], Approved: ['#dcfce7', '#15803d'], Rejected: ['#fee2e2', '#dc2626'] };
        listEl.innerHTML = balanceHtml + requestsRes.data.map(r => {
            const [bg, color] = statusColors[r.status] || ['#f1f5f9', '#475569'];
            return `
                <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid #f1f5f9;">
                    <div>
                        <div style="font-weight:500; font-size:0.85rem;">K${Number(r.amount).toFixed(2)}</div>
                        <div style="font-size:0.75rem; color:#94a3b8;">${r.reason || ''}</div>
                    </div>
                    <span style="background:${bg}; color:${color}; padding:3px 10px; border-radius:10px; font-size:0.75rem; font-weight:500;">${r.status}</span>
                </div>
            `;
        }).join('');
    }

    document.getElementById('dashOpenAdvanceModalBtn').addEventListener('click', () => {
        document.getElementById('dashAdvanceModal').style.display = 'flex';
    });
    document.getElementById('dashCloseAdvanceModalBtn').addEventListener('click', () => {
        document.getElementById('dashAdvanceModal').style.display = 'none';
    });
    document.getElementById('dashCancelAdvanceBtn').addEventListener('click', () => {
        document.getElementById('dashAdvanceModal').style.display = 'none';
    });

    document.getElementById('dashAdvanceForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!currentEmployeeId) { alert('Your login is not linked to an employee record.'); return; }

        const submitBtn = document.getElementById('dashSubmitAdvanceBtn');
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Submitting...';

        try {
            const { error } = await supabaseClient.from('advance_requests').insert([{
                employee_id: currentEmployeeId,
                amount: parseFloat(document.getElementById('dashAdvanceAmount').value),
                reason: document.getElementById('dashAdvanceReason').value.trim(),
                status: 'Pending',
                requested_at: new Date().toISOString()
            }]);
            if (error) throw error;

            document.getElementById('dashAdvanceForm').reset();
            document.getElementById('dashAdvanceModal').style.display = 'none';
            await loadMyAdvances();
        } catch (error) {
            alert('Error submitting advance request: ' + error.message);
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Submit';
        }
    });

    // ============================================
    // 🔥 ADDED: SHARED EXCHANGE RATE WIDGET
    // ============================================
    // Reads/writes the same `exchange_rates` table Account > Cash & Bank
    // already uses (see assets/js/shared-exchange-rate.js) -- setting it
    // here once means Payments, Purchase Orders, and Cash & Bank all pick
    // up the same default rate for the rest of the day instead of each
    // needing it re-typed separately.
    async function loadExchangeRateWidget() {
        const valueEl = document.getElementById('dashExchangeRateValue');
        const updatedEl = document.getElementById('dashExchangeRateUpdated');
        if (!valueEl) return;

        try {
            const { data, error } = await supabaseClient
                .from('exchange_rates')
                .select('usd_to_zmw, created_at')
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            if (error || !data) {
                valueEl.textContent = DEFAULT_EXCHANGE_RATE.toFixed(4);
                updatedEl.textContent = 'No rate set yet -- using default';
                return;
            }

            valueEl.textContent = parseFloat(data.usd_to_zmw).toFixed(4);
            updatedEl.textContent = `Updated ${new Date(data.created_at).toLocaleString()}`;
        } catch (err) {
            console.warn('Could not load exchange rate widget:', err);
            valueEl.textContent = DEFAULT_EXCHANGE_RATE.toFixed(4);
            updatedEl.textContent = 'Using default rate';
        }
    }

    // ============================================
    // 🔥 ADDED: SIDEBAR -- TODAY AT A GLANCE
    // ============================================
    // Sidebar (dashboard-menu.html) and this script load via two
    // INDEPENDENT fetches in app.js's loadModule() -- there's no
    // guarantee the sidebar markup is already on screen when this runs.
    // In practice the sidebar (one small fetch) resolves well before this
    // script does (view.html then view.js -- two chained fetches), so
    // this works in the overwhelming common case; if it ever loses the
    // race the worst case is these two numbers stay on "--" rather than
    // anything crashing, since every write here is null-checked.
    async function loadSidebarStats() {
        const salesEl = document.getElementById('dashSidebarTodaySales');
        const approvalsRow = document.getElementById('dashSidebarApprovalsRow');
        const approvalsEl = document.getElementById('dashSidebarPendingApprovals');
        if (!salesEl) return;

        try {
            const today = new Date().toISOString().split('T')[0];
            const dayStart = `${today}T00:00:00`;
            const dayEnd = `${today}T23:59:59`;

            // Same table/filter convention as Report > Daily Report, so
            // this figure always agrees with that report.
            const { data: sales, error } = await supabaseClient
                .from('sales')
                .select('grand_total')
                .in('client_type', ['RETAIL', 'WHOLESALE'])
                .neq('is_quotation', true)
                .gte('created_at', dayStart).lte('created_at', dayEnd);

            if (error) throw error;
            const total = (sales || []).reduce((sum, s) => sum + (s.grand_total || 0), 0);
            salesEl.textContent = `K${total.toFixed(2)}`;
        } catch (err) {
            console.warn('Could not load sidebar sales stat:', err);
            salesEl.textContent = '--';
        }

        if (window.currentUserRole === 'Admin' && approvalsRow && approvalsEl) {
            // 🔥 FIX: show the row (with "--") as soon as we know this is
            // an Admin, THEN fill in the real count -- previously the row
            // only appeared once the count query had already succeeded,
            // so a failed query left it silently invisible instead of
            // visibly broken, same inconsistency the sales stat above
            // avoids by always writing something into its own element.
            approvalsRow.style.display = 'flex';
            try {
                const { count, error } = await supabaseClient
                    .from('leave_requests')
                    .select('id', { count: 'exact', head: true })
                    .eq('status', 'Pending');
                if (error) throw error;
                approvalsEl.textContent = count || 0;
            } catch (err) {
                console.warn('Could not load sidebar approvals stat:', err);
                approvalsEl.textContent = '--';
            }
        }
    }

    // ============================================
    // 🔥 ADDED: SIDEBAR -- NOTICE BOARD
    // ============================================
    // SCHEMA THIS NEEDS:
    //   announcements (new table): id uuid pk, message text,
    //     created_by uuid, created_by_name text, created_at timestamptz
    async function loadSidebarNotices() {
        const listEl = document.getElementById('dashSidebarNotices');
        const postBtn = document.getElementById('dashSidebarPostNoticeBtn');
        if (!listEl) return;

        const isAdmin = window.currentUserRole === 'Admin';
        if (postBtn) postBtn.style.display = isAdmin ? 'inline-block' : 'none';

        try {
            const { data, error } = await supabaseClient
                .from('announcements')
                .select('*')
                .order('created_at', { ascending: false })
                .limit(5);

            if (error) throw error;

            if (!data || data.length === 0) {
                listEl.innerHTML = `<p class="helper-text" style="font-size:0.75rem; padding:8px 0;">No notices right now.</p>`;
                return;
            }

            listEl.innerHTML = data.map(n => `
                <div style="background:#eff6ff; border-radius:6px; padding:8px 10px; margin-bottom:6px; font-size:0.78rem; position:relative;">
                    <div style="color:#1e3a8a; padding-right:${isAdmin ? '18px' : '0'};">${n.message}</div>
                    <div style="color:#94a3b8; font-size:0.68rem; margin-top:3px;">${n.created_by_name || 'Admin'} · ${new Date(n.created_at).toLocaleDateString()}</div>
                    ${isAdmin ? `<button onclick="deleteNotice('${n.id}')" style="position:absolute; top:6px; right:6px; background:none; border:none; color:#94a3b8; cursor:pointer; font-size:0.85rem;" title="Delete"><i class="fa-solid fa-xmark"></i></button>` : ''}
                </div>
            `).join('');
        } catch (err) {
            console.warn('Could not load notice board:', err);
            listEl.innerHTML = `<p class="helper-text" style="font-size:0.75rem; padding:8px 0; color:#dc2626;">Couldn't load notices.</p>`;
        }
    }

    window.deleteNotice = async function (id) {
        if (!confirm('Remove this notice for everyone?')) return;
        try {
            const { error } = await supabaseClient.from('announcements').delete().eq('id', id);
            if (error) throw error;
            await loadSidebarNotices();
        } catch (err) {
            alert('Error removing notice: ' + err.message);
        }
    };

    // ============================================
    // MODAL WIRING
    // ============================================
    document.getElementById('dashOpenLeaveModalBtn').addEventListener('click', () => {
        document.getElementById('dashLeaveModal').style.display = 'flex';
    });
    document.getElementById('dashCloseLeaveModalBtn').addEventListener('click', () => {
        document.getElementById('dashLeaveModal').style.display = 'none';
    });
    document.getElementById('dashCancelLeaveBtn').addEventListener('click', () => {
        document.getElementById('dashLeaveModal').style.display = 'none';
    });

    document.getElementById('dashOpenExchangeRateModalBtn').addEventListener('click', async () => {
        const current = await getSharedExchangeRate();
        document.getElementById('dashExchangeRateInput').value = current;
        document.getElementById('dashExchangeRateModal').style.display = 'flex';
    });
    document.getElementById('dashCloseExchangeRateModalBtn').addEventListener('click', () => {
        document.getElementById('dashExchangeRateModal').style.display = 'none';
    });
    document.getElementById('dashCancelExchangeRateBtn').addEventListener('click', () => {
        document.getElementById('dashExchangeRateModal').style.display = 'none';
    });
    document.getElementById('dashExchangeRateForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const rate = parseFloat(document.getElementById('dashExchangeRateInput').value);
        const submitBtn = document.getElementById('dashSaveExchangeRateBtn');
        const originalHtml = submitBtn.innerHTML;
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';

        const { error } = await saveSharedExchangeRate(rate);

        submitBtn.disabled = false;
        submitBtn.innerHTML = originalHtml;

        if (error) {
            alert('Error saving exchange rate: ' + error.message);
            return;
        }

        document.getElementById('dashExchangeRateModal').style.display = 'none';
        showToastSimple('Exchange rate updated -- this is now the default everywhere for the rest of the day.');
        await loadExchangeRateWidget();
    });

    // 🔥 ADDED: Post Notice modal. The button that OPENS this modal
    // (dashSidebarPostNoticeBtn) lives in the sidebar and uses its own
    // inline onclick for that reason (see dashboard-menu.html) -- only
    // close/cancel/submit are wired here, since those elements are part
    // of THIS file's own view.html and are guaranteed to exist together
    // with this script.
    document.getElementById('dashClosePostNoticeModalBtn').addEventListener('click', () => {
        document.getElementById('dashPostNoticeModal').style.display = 'none';
    });
    document.getElementById('dashCancelPostNoticeBtn').addEventListener('click', () => {
        document.getElementById('dashPostNoticeModal').style.display = 'none';
    });
    document.getElementById('dashPostNoticeForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = document.getElementById('dashSubmitPostNoticeBtn');
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Posting...';

        try {
            const { data: sessionData } = await supabaseClient.auth.getSession();
            const { error } = await supabaseClient.from('announcements').insert([{
                message: document.getElementById('dashPostNoticeMessage').value.trim(),
                created_by: sessionData?.session?.user?.id || null,
                created_by_name: window.currentUserName || 'Admin',
                created_at: new Date().toISOString()
            }]);
            if (error) throw error;

            document.getElementById('dashPostNoticeForm').reset();
            document.getElementById('dashPostNoticeModal').style.display = 'none';
            await loadSidebarNotices();
            showToastSimple('Notice posted.');
        } catch (error) {
            alert('Error posting notice: ' + error.message);
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<i class="fa-solid fa-bullhorn"></i> Post';
        }
    });

    // ============================================
    // INIT
    // ============================================
    await resolveCurrentEmployee();
    await loadTodayAttendance();
    await loadMyLeave();
    await loadMyAdvances();
    await loadMonthSummary();
    await loadAdminApprovals();
    await loadExchangeRateWidget();
    await loadSidebarStats();
    await loadSidebarNotices();

    console.log("✅ Dashboard initialized successfully!");
})();
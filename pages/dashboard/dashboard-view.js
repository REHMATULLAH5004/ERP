// ============================================
// DASHBOARD - LEAVE / ADVANCE / ATTENDANCE (sidebar widgets), DISPENSING
// (labels + call-next-patient), EXCHANGE RATE, ADMIN APPROVALS
// ============================================
// Self-service: the leave/advance/attendance widgets always act on the
// CURRENT logged-in user's own record, resolved via
// user_profiles -> employees. This is different from HR > Attendance,
// which lets an authorized person administer ANY employee's attendance
// via a dropdown.
//
// 🔥 Leave / Salary Advance / Exchange Rate / Attendance Register moved
// out of full-width cards on the main page and into compact widgets in
// the sidebar (dashboard-menu.html) -- same modals, same logic here,
// just opened from new element ids. "My Attendance Today" was removed
// outright (see loadMyLeave()'s comment just below) rather than moved.
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

    // ============================================
    // 🔥 ADDED: RETAIL COMPANY SETTINGS (for the dispensing "Print
    // Invoice" reprint -- see buildDispatchInvoiceHTML() below)
    // ============================================
    // The dispensing reprint used to hardcode its own pharmacy name and
    // print a totally different 80mm thermal-receipt layout, completely
    // unlike the real A4 invoice Retail POS prints at checkout -- same
    // sale, two different-looking documents depending on which screen
    // reprinted it. Loads the exact same Retail Invoicing profile
    // (Admin > Invoicing Settings > Retail Invoicing) that
    // retail/index.js's own loadCompanySettingsInline() reads, so this
    // page's reprint renders byte-for-byte the same invoice layout/data.
    // Self-contained (own query, own fallback) rather than importing
    // retail/index.js, since this page can be opened without ever
    // visiting Retail POS first.
    const companySettings = await (async function loadRetailCompanySettingsInline() {
        const fallback = {
            company_name: 'GRIFFINS MEDICALS LIMITED',
            address: 'Plot 3534, Freedomway, Lusaka',
            phone: '+260 97 000 0000',
            zamra_number: 'ZAMRA-123456',
            retail_company_name: '',
            retail_zamra_number: '',
            retail_tpin_number: '',
            retail_phone: '',
            retail_footer_message: '',
            invoice_prefix: 'GRI',
            retail_prefix_regular: '',
            retail_regular_markup_max_percent: 60,
            retail_regular_markup_min_percent: 30,
            markup_cost_min: 1,
            markup_cost_max: 600
        };
        try {
            const { data, error } = await supabaseClient
                .from('company_settings')
                .select(`company_name, address, phone, zamra_number, invoice_prefix,
                    retail_company_name, retail_zamra_number, retail_tpin_number, retail_phone, retail_footer_message,
                    retail_prefix_regular, retail_regular_markup_max_percent, retail_regular_markup_min_percent,
                    markup_cost_min, markup_cost_max`)
                .eq('id', 1)
                .maybeSingle();
            if (error || !data) return fallback;
            return {
                company_name: data.company_name || fallback.company_name,
                address: data.address || fallback.address,
                phone: data.phone || fallback.phone,
                zamra_number: data.zamra_number || fallback.zamra_number,
                retail_company_name: data.retail_company_name || data.company_name || fallback.company_name,
                retail_zamra_number: data.retail_zamra_number || data.zamra_number || fallback.zamra_number,
                retail_tpin_number: data.retail_tpin_number || '',
                retail_phone: data.retail_phone || data.phone || fallback.phone,
                retail_footer_message: data.retail_footer_message || '',
                // 🔥 ADDED for Quick Sale (see initQuickSale()): same pricing
                // curve + Regular invoice prefix that retail/index.js uses.
                invoice_prefix: data.invoice_prefix || fallback.invoice_prefix,
                retail_prefix_regular: data.retail_prefix_regular || '',
                retail_regular_markup_max_percent: data.retail_regular_markup_max_percent ?? fallback.retail_regular_markup_max_percent,
                retail_regular_markup_min_percent: data.retail_regular_markup_min_percent ?? fallback.retail_regular_markup_min_percent,
                markup_cost_min: data.markup_cost_min ?? fallback.markup_cost_min,
                markup_cost_max: data.markup_cost_max ?? fallback.markup_cost_max
            };
        } catch (e) {
            console.warn('Could not load company_settings for invoice reprint, using defaults:', e);
            return fallback;
        }
    })();

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
    // 🔥 ADDED: WHATSAPP ADMIN NOTIFICATIONS -- LEAVE / ADVANCE REQUESTS
    // ============================================
    // Fires a WhatsApp message to the admin/HR number whenever a staff
    // member submits a leave or advance request, so it doesn't sit
    // unseen until someone opens the dashboard. This is a business-
    // initiated message to a number that may not have an open 24h
    // conversation window, so it MUST use a Meta-approved template
    // (unlike the free-form text path used for ad-hoc testing
    // elsewhere) -- same send-whatsapp-message edge function already
    // used for Purchase Order / Supplier Payment notifications.
    const ADMIN_WHATSAPP_NUMBER = '260777603560';
    const WHATSAPP_TEMPLATES = {
        LEAVE_REQUEST: 'leave_request_notice',
        ADVANCE_REQUEST: 'advance_request_notice',
        // 🔥 ADDED: for a Notice Board post targeted at one specific
        // employee (see "SIDEBAR -- NOTICE BOARD" below) -- same
        // placeholder situation as every other template here: this won't
        // actually send until a real template of this name is created and
        // approved in Meta Business Manager. Until then, notifyWhatsApp()
        // fails harmlessly (console-only) and the notice still posts and
        // shows on the employee's sidebar either way.
        NOTICE_BOARD: 'notice_board_notice',
    };

    // 🔥 CHANGED: pulled the actual send out of notifyAdminWhatsApp() into
    // this generic `to`-taking helper, so the Notice Board can reuse the
    // exact same send path to notify a TARGETED EMPLOYEE's own number
    // instead of always the fixed admin number. notifyAdminWhatsApp() is
    // now a thin wrapper so every existing call site (Leave/Advance
    // requests below) is unaffected.
    async function notifyWhatsApp(to, templateName, bodyParams) {
        if (!to) {
            console.log('WhatsApp: no phone number on file -- skipping notification.');
            return;
        }
        try {
            await supabaseClient.functions.invoke('send-whatsapp-message', {
                body: {
                    to,
                    template_name: templateName,
                    language_code: 'en_US',
                    components: [{
                        type: 'body',
                        parameters: bodyParams.map(p => ({ type: 'text', text: String(p) }))
                    }]
                }
            });
        } catch (err) {
            // Non-fatal -- never block the actual action (request
            // submission / notice post) on WhatsApp delivery.
            console.warn(`WhatsApp notification (${templateName}) failed:`, err);
        }
    }

    async function notifyAdminWhatsApp(templateName, bodyParams) {
        return notifyWhatsApp(ADMIN_WHATSAPP_NUMBER, templateName, bodyParams);
    }

    // ============================================
    // LEAVE REQUEST -- MY OWN
    // ============================================
    // 🔥 REMOVED: "My Attendance Today" (loadTodayAttendance /
    // renderAttendanceStatus) -- it was a read-only display with
    // nothing left to actually do on this page, since self-service
    // clock in/out was already replaced by the QR Station a while ago.
    async function loadMyLeave() {
        const listEl = document.getElementById('dashSidebarMyLeaveList');
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

            // 🔥 ADDED: fire-and-forget WhatsApp notice to admin/HR number.
            notifyAdminWhatsApp(WHATSAPP_TEMPLATES.LEAVE_REQUEST, [
                currentEmployeeName || 'An employee',
                start,
                end,
                String(days)
            ]);

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
        // 🔥 FIX: also fold in any day attendance itself marked 'Leave',
        // regardless of whether its leave_requests row is Approved (or
        // exists at all) -- see the matching fix in hr-view.js's
        // loadMonthSummary(). This stat has to agree with what the
        // calendar below actually colors purple.
        (attendanceRes.data || []).forEach(a => {
            if (a.status === 'Leave') leaveDatesInMonth.add(a.attendance_date);
        });

        const holidayDates = {};
        (holidaysRes.data || []).forEach(h => { holidayDates[h.holiday_date] = h.name; });

        const weeklyOffDay = jobRes.data?.weekly_off_day || null;

        // ---- STATS ----
        // 🔥 FIX: only count a day as absent if it was EXPLICITLY marked
        // that way (e.g. via HR's Mark Absent) -- a day with simply no
        // record at all is unmarked, not assumed absent.
        //
        // 🔥 ADDED: "Incomplete" days -- a record exists, wasn't marked
        // Off/Holiday/Absent, but has no check_in at all. No current
        // code path (Manual Entry forces status to 'Absent' when there's
        // no check-in; Mark Absent only ever writes Off/Holiday
        // Off/Absent; Clock In always sets check_in) can produce this
        // combination going forward, so a nonzero count here almost
        // always means a stale/bad historical row -- e.g. direct DB
        // edits/import -- that's quietly inflating "days present"
        // elsewhere (like the printed Monthly Attendance Register, which
        // also now flags these the same way) without contributing any
        // hours here. Previously these were invisible: not counted as
        // Absent (status isn't 'Absent'), not counted in Hrs (no
        // check-in/out to sum) -- which is exactly what produces a
        // "the register doesn't match" complaint.
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
        set('dashSidebarMonthWorkedHours', (totalMinutes / 60).toFixed(1));
        set('dashSidebarMonthAbsent', absentDays);
        set('dashSidebarMonthLeave', leaveDatesInMonth.size);
        set('dashSidebarMonthIncomplete', incompleteDays);

        // ---- CALENDAR (now in the sidebar -- narrower, so smaller type) ----
        const calEl = document.getElementById('dashSidebarMonthCalendar');
        if (!calEl) return;

        let html = DAY_NAMES_SHORT.map(d => `<div style="text-align:center; font-size:0.6rem; font-weight:600; color:#94a3b8; padding-bottom:2px;">${d[0]}</div>`).join('');

        const firstDayOfWeek = new Date(year, month, 1).getDay();
        for (let i = 0; i < firstDayOfWeek; i++) html += `<div></div>`;

        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = formatDateLocal(year, month, day);
            const record = attendanceByDate[dateStr];
            const dayOfWeek = new Date(year, month, day).getDay();

            let bg = 'white', color = '#94a3b8', border = '1px solid #e2e8f0';

            let flagTitle = '';
            if (record && record.check_in) {
                bg = '#22c55e'; color = 'white'; border = 'none';        // Present
            } else if (record && record.status === 'Absent') {
                bg = '#ef4444'; color = 'white'; border = 'none';        // Explicitly marked Absent
            } else if (record && record.status === 'Leave') {
                // 🔥 FIX: the attendance record's own 'Leave' status is
                // authoritative by itself -- this used to also require
                // leaveDatesInMonth (built from APPROVED leave_requests
                // covering this date) to match, so a day correctly marked
                // Leave on attendance but backed by a not-yet-approved (or
                // missing) leave_requests row fell through into the
                // Incomplete branch below instead. Leave is leave,
                // approved or not.
                bg = '#8b5cf6'; color = 'white'; border = 'none';        // On Leave
            } else if (record && record.status !== 'Off' && record.status !== 'Holiday Off') {
                // 🔥 ADDED: a record exists, isn't Off/Holiday Off/Absent/
                // Leave, but has no check_in -- see the "Incomplete" stat
                // above.
                bg = '#fbbf24'; color = 'white'; border = 'none';
                flagTitle = ' -- marked "' + record.status + '" but no check-in recorded';
            } else if (leaveDatesInMonth.has(dateStr)) {
                // Fallback for an approved multi-day leave span that
                // hasn't (yet) generated a per-day attendance row.
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
                <div title="${dateStr}${holidayDates[dateStr] ? ' -- ' + holidayDates[dateStr] : ''}${flagTitle}"
                     style="aspect-ratio:1; display:flex; align-items:center; justify-content:center; background:${bg}; color:${color}; border:${border}; border-radius:4px; font-size:0.62rem; font-weight:500;">
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
        const listEl = document.getElementById('dashSidebarMyAdvanceList');
        // 🔥 FIX: the sidebar "My Advances" LIST display was removed from
        // dashboard-view.html at some point (the "Request Advance" modal/
        // button were kept, see the comment near the top of that file) but
        // this function was never updated to match, so listEl is always
        // null now. That crashed here with "Cannot set properties of null
        // (setting 'innerHTML')" -- and because this whole function is
        // awaited directly in the INIT sequence below with no try/catch,
        // the crash silently killed every widget that runs after it in the
        // INIT sequence below (month summary, admin approvals, dispense
        // queue, exchange rate, sidebar stats, sidebar notices), even
        // though none of those have anything to do with advances. Bail
        // out cleanly if the list container isn't there instead of
        // crashing.
        if (!listEl) return;
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

    document.getElementById('dashSidebarOpenAdvanceModalBtn').addEventListener('click', () => {
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

        const advanceAmount = parseFloat(document.getElementById('dashAdvanceAmount').value);
        const advanceReason = document.getElementById('dashAdvanceReason').value.trim();

        try {
            const { error } = await supabaseClient.from('advance_requests').insert([{
                employee_id: currentEmployeeId,
                amount: advanceAmount,
                reason: advanceReason,
                status: 'Pending',
                requested_at: new Date().toISOString()
            }]);
            if (error) throw error;

            // 🔥 ADDED: fire-and-forget WhatsApp notice to admin/HR number.
            notifyAdminWhatsApp(WHATSAPP_TEMPLATES.ADVANCE_REQUEST, [
                currentEmployeeName || 'An employee',
                advanceAmount.toFixed(2),
                advanceReason || 'No reason given'
            ]);

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
    // 🔥 ADDED: DISPENSING -- PRINT LABELS
    // ============================================
    // Moved here from Retail POS so label printing is decoupled from
    // checkout -- a dispenser works through this independently of the
    // till. Reads `sales.items` directly (a JSON snapshot already written
    // at save time -- product_name, how_to_take, qty, pack_size,
    // days_supplied per line) rather than joining sale_items, since that
    // snapshot already has everything a sticker needs.
    //
    // buildStickerHTML() below is copied unchanged from the version that
    // used to live in retail/index.js -- same label size (45mm x 40mm for
    // the TSC TTP-244 Pro), same bold pharmacy name / bold Qty line, same
    // "(Supplied for N Days)" bracket, same multi-line dosage rendering.
    function buildStickerHTML(saleData) {
        return `<!DOCTYPE html>
            <html>
            <head>
                <title>Labels - ${saleData.sale_id}</title>
                <style>
                    @page { size: 45mm 40mm; margin: 0; }
                    /* 🔥 FIX: same issue as the invoice (see buildInvoiceHTML in
                       retail/index.js) -- on the real thermal printer, anything
                       left at the default normal weight (400) came out faint no
                       matter the font size, because thin strokes don't lay down
                       enough toner/heat on a thermal head. Fix: raise the
                       baseline weight for the whole label to 600 (semibold) here
                       on <body>, so every line inherits it unless overridden --
                       pharmacy name / item name / qty line stay bold (700) so
                       they're still clearly heavier than the dosage line, but
                       nothing on the sticker is left at the too-thin default
                       anymore. */
                    body { font-family: Arial, sans-serif; margin: 0; font-weight: 600; color: #000; }
                    .sticker {
                        width: 45mm; height: 40mm; padding: 2mm; box-sizing: border-box;
                        border: 1px dashed #94a3b8; page-break-after: always;
                        display: flex; flex-direction: column; justify-content: center;
                        overflow: hidden;
                    }
                    .sticker:last-child { page-break-after: auto; }
                    .sticker .pharmacy { font-size: 6.5pt; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; font-weight: bold; }
                    .sticker .item-name { font-size: 10pt; font-weight: bold; margin: 1.5mm 0 1mm 0; }
                    .sticker .how-to-take { font-size: 8pt; white-space: pre-line; line-height: 1.3; font-weight: 600; }
                    .sticker .qty { font-size: 7.5pt; color: #475569; margin-top: 1mm; font-weight: bold; }
                    @media print { .sticker { border: none; } }
                </style>
            </head>
            <body>
                ${(saleData.items || []).map(item => `
                    <div class="sticker">
                        <div class="pharmacy">Griffins Medicals Limited</div>
                        <div class="item-name">${item.product_name}</div>
                        ${item.how_to_take ? `<div class="how-to-take">${item.how_to_take}</div>` : ''}
                        <div class="qty">Qty: ${item.qty} ${item.pack_size}${item.days_supplied ? ` (Supplied for ${item.days_supplied} Days)` : ''}</div>
                    </div>
                `).join('')}
            </body>
            </html>
        `;
    }

    // 🔥 CHANGED: this used to print a totally different 80mm
    // thermal-receipt layout with a hardcoded pharmacy name -- same sale,
    // but a dispenser reprinting it from here got a document that looked
    // nothing like the real A4 invoice Retail POS prints at checkout
    // (reported as "different from the one we print in main POS
    // retail"). Rebuilt to be the EXACT same invoice markup as
    // buildInvoiceHTML() in transaction/retail/index.js -- same CSS
    // classes, same A4 @page rule, same Item Name / Generic Name / Batch
    // Number (Expiry Date) / Pack Size / Qty / Rate / Total / Days
    // Supply / Dosage columns, same totals box and footer -- driven by
    // the same Retail Invoicing company-settings profile loaded above
    // (companySettings), so a change to that Admin section (company
    // name, ZAMRA/TPIN, phone, footer message) shows up identically on
    // both screens. Keep this in sync with retail/index.js's
    // buildInvoiceHTML() if that one changes.
    function cleanBatchDisplay(batchNumber) {
        if (!batchNumber) return '';
        return batchNumber.replace(/\s*-\s*(⚠️\s*)?\d+\s*units?(\s*\(Low Stock\))?\s*$/i, '').trim();
    }

    // Maps a raw `sales` row (as read by loadDispenseQueue() /
    // searchDispenseSales() / the Next Up preview above) into the same
    // saleData shape buildInvoiceHTML() expects -- mirrors exactly how
    // retail/index.js's own viewSaleDetail() does this same translation.
    // Every dispensing sale is a real Retail sale, never a quotation (the
    // queries above all filter `.neq('is_quotation', true)`), so this is
    // hardcoded false rather than reading a column none of those queries
    // select.
    function toInvoiceSaleData(sale) {
        return {
            sale_id: sale.sale_id,
            is_quotation: false,
            customer: sale.customer_data || {},
            items: sale.items || [],
            payment: sale.payment || { type: 'Cash', note: '' },
            totals: {
                subtotal: sale.subtotal || 0,
                tax: sale.tax || 0,
                grand_total: sale.grand_total || 0
            },
            date: new Date(sale.created_at).toLocaleString()
        };
    }

    // 🔥 ADDED: backfill Generic Name for older sales, same as
    // retail/index.js's enrichItemsForPrint() -- a sale saved before the
    // A4 invoice's Generic Name column existed has no generic_name on its
    // items at all, so reprinting it here would otherwise show a blank
    // column for every line.
    async function enrichItemsForPrint(items) {
        const productIds = [...new Set((items || []).map(i => i.product_id).filter(Boolean))];
        if (productIds.length === 0) return items;

        try {
            const { data: products } = await supabaseClient
                .from('products').select('id, generic_name_id').in('id', productIds);
            const genericIds = [...new Set((products || []).map(p => p.generic_name_id).filter(Boolean))];
            let genericMap = {};
            if (genericIds.length > 0) {
                const { data: generics } = await supabaseClient
                    .from('generic_names').select('id, name').in('id', genericIds);
                (generics || []).forEach(g => { genericMap[g.id] = g.name; });
            }
            const genericByProduct = {};
            (products || []).forEach(p => { genericByProduct[p.id] = genericMap[p.generic_name_id] || ''; });

            return (items || []).map(item => ({
                ...item,
                generic_name: item.generic_name || genericByProduct[item.product_id] || ''
            }));
        } catch (e) {
            console.warn('Could not backfill generic names for print:', e);
            return items;
        }
    }

    function buildDispatchInvoiceHTML(saleData) {
        const docLabel = 'Invoice';

        return `<!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>${companySettings.retail_company_name} - ${docLabel} ${saleData.sale_id}</title>
                <style>
                    * { box-sizing: border-box; }
                    body { font-family: Arial, Helvetica, sans-serif; padding: 30px; max-width: 800px; margin: 0 auto; color: #1e293b; }

                    .doc-header { border-bottom: 3px solid #000000; padding-bottom: 14px; margin-bottom: 14px; }
                    .company-block h1 { margin: 0; color: #000000; font-size: 1.4rem; letter-spacing: 0.02em; }
                    .company-block p { margin: 3px 0 0; color: #64748b; font-size: 0.85rem; }

                    .doc-title-row { margin-bottom: 16px; }
                    .doc-title { font-size: 2rem; font-weight: 800; color: #000000; letter-spacing: 0.03em; }

                    .info-row { display: flex; justify-content: space-between; gap: 20px; margin-bottom: 20px; }
                    .info-box { background: #f1f5f9; border-radius: 6px; padding: 12px 16px; font-size: 0.85rem; line-height: 1.7; flex: 1; }
                    .bill-to { text-align: right; font-size: 0.85rem; line-height: 1.6; flex: 1; }

                    table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 0.78rem; }
                    th { background: #000000; color: white; padding: 8px 6px; text-align: left; font-weight: 600; }
                    th.text-right { text-align: right; }
                    th.text-center { text-align: center; }
                    td { padding: 8px 6px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
                    tbody tr:nth-child(even) { background: #f8fafc; }
                    .text-right { text-align: right; }
                    .text-center { text-align: center; }

                    .totals-box { max-width: 300px; margin-left: auto; margin-bottom: 24px; }
                    .totals-row { display: flex; justify-content: space-between; padding: 6px 12px; font-size: 0.9rem; }
                    .totals-row.grand { background: #000000; color: white; font-weight: bold; font-size: 1rem; border-radius: 4px; margin-top: 4px; }

                    .footer-note { border-top: 1px solid #e2e8f0; padding-top: 16px; font-size: 0.85rem; color: #334155; text-align: center; }
                    .footer-note p { margin: 0 0 6px; line-height: 1.6; }

                    @media print { @page { size: A4; margin: 12mm; } body { margin: 0; padding: 0; max-width: none; } }
                </style>
            </head>
            <body>
                <div class="doc-header">
                    <div class="company-block">
                        <h1>${companySettings.retail_company_name}</h1>
                        <p>${companySettings.address}</p>
                        <p>Phone: ${companySettings.retail_phone} | ZAMRA: ${companySettings.retail_zamra_number}${companySettings.retail_tpin_number ? ` | TPIN: ${companySettings.retail_tpin_number}` : ''}</p>
                    </div>
                </div>

                <div class="doc-title-row">
                    <div class="doc-title">${docLabel.toUpperCase()}</div>
                </div>

                <div class="info-row">
                    <div class="info-box">
                        <div><strong>${docLabel} #:</strong> ${saleData.sale_id}</div>
                        <div><strong>Date:</strong> ${saleData.date}</div>
                        <div><strong>Payment:</strong> ${saleData.payment.type}</div>
                    </div>
                    <div class="bill-to">
                        <strong>CUSTOMER:</strong><br>
                        <strong>${saleData.customer.full_name || 'N/A'}</strong><br>
                        ${saleData.customer.phone ? `Phone: ${saleData.customer.phone}<br>` : ''}
                        ${saleData.customer.address || ''}<br>
                        ${saleData.customer.nhima_number ? `NHIMA #: ${saleData.customer.nhima_number}<br>` : ''}
                        ${saleData.customer.nrc ? `NRC: ${saleData.customer.nrc}` : ''}
                    </div>
                </div>

                <table>
                    <thead>
                        <tr>
                            <th>Item Name</th>
                            <th>Generic Name</th>
                            <th>Batch Number (Expiry Date)</th>
                            <th class="text-center">Pack Size</th>
                            <th class="text-center">Qty</th>
                            <th class="text-right">Rate</th>
                            <th class="text-right">Total</th>
                            <th class="text-center">Days Supply</th>
                            <th>Dosage</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${saleData.items.map(item => `
                            <tr>
                                <td>${item.product_name}</td>
                                <td>${item.generic_name || '-'}</td>
                                <td>${cleanBatchDisplay(item.batch_number)}${item.expiry ? ` (${item.expiry})` : ''}</td>
                                <td class="text-center">${item.pack_size}</td>
                                <td class="text-center">${item.qty}</td>
                                <td class="text-right">K${Number(item.rate || 0).toFixed(2)}</td>
                                <td class="text-right">K${Number(item.total || 0).toFixed(2)}</td>
                                <td class="text-center">${item.days_supplied || 0}</td>
                                <td>${item.how_to_take || 'As directed'}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>

                <div class="totals-box">
                    ${(saleData.payment && Number(saleData.payment.discount_amount) > 0) ? `
                    <div class="totals-row"><span>Items Total</span><span>K${(saleData.totals.grand_total + Number(saleData.payment.discount_amount)).toFixed(2)}</span></div>
                    <div class="totals-row"><span>Discount (${Number(saleData.payment.discount_percent || 0)}%)</span><span>-K${Number(saleData.payment.discount_amount).toFixed(2)}</span></div>` : ''}
                    <div class="totals-row"><span>Subtotal (Excl. Tax)</span><span>K${saleData.totals.subtotal.toFixed(2)}</span></div>
                    <div class="totals-row"><span>Total Tax</span><span>K${saleData.totals.tax.toFixed(2)}</span></div>
                    <div class="totals-row grand"><span>GRAND TOTAL</span><span>K${saleData.totals.grand_total.toFixed(2)}</span></div>
                </div>

                <div class="footer-note">
                    <p>${companySettings.retail_footer_message || 'Thank you for your business!'}</p><p>This is a computer-generated invoice.</p>
                </div>
            </body>
            </html>
        `;
    }

    // 🔥 CHANGED: prints through a hidden, off-screen <iframe> instead of
    // window.open() -- same reasoning as retail/index.js's
    // printHTMLViaHiddenFrame(): window.open() launches a whole separate
    // browser window/tab that's left sitting on top of the dashboard
    // until manually closed. The OS/browser print dialog itself still
    // appears -- no page can silently print without it -- but there's no
    // extra window to see or close. Unlike labels, reprinting an invoice
    // doesn't mark anything in the database, so this is always safe to
    // click again (e.g. to double-check an item while preparing the
    // order).
    async function printInvoiceForSale(sale) {
        const saleData = toInvoiceSaleData(sale);
        if ((saleData.items || []).some(i => !i.generic_name)) {
            saleData.items = await enrichItemsForPrint(saleData.items);
        }

        const html = buildDispatchInvoiceHTML(saleData);

        const existing = document.getElementById('dashPrintFrame');
        if (existing) existing.remove();

        const frame = document.createElement('iframe');
        frame.id = 'dashPrintFrame';
        frame.style.cssText = 'position:fixed; right:0; bottom:0; width:0; height:0; border:0; visibility:hidden;';
        document.body.appendChild(frame);

        const cleanup = () => { const f = document.getElementById('dashPrintFrame'); if (f) f.remove(); };
        const safetyTimer = setTimeout(cleanup, 60000);

        frame.onload = () => {
            try {
                frame.contentWindow.focus();
                frame.contentWindow.print();
            } catch (e) {
                console.error('Print failed:', e);
            }
            setTimeout(() => { clearTimeout(safetyTimer); cleanup(); }, 1000);
        };

        const doc = frame.contentDocument || frame.contentWindow.document;
        doc.open();
        doc.write(html);
        doc.close();
    }

    // 🔥 ADDED: same pattern as retail/index.js and hr/employee/index.js --
    // a write that gets rejected by RLS because the session's token was
    // stale (not because the user actually lacks permission) gets ONE
    // retry after a session refresh, instead of just failing quietly.
    // This is exactly what was silently breaking "Print Labels" not
    // clearing the pending queue: the sticker printed fine (that part
    // never touches Supabase), but the labels_printed_at update that's
    // supposed to remove it from the list was being rejected by RLS and
    // swallowed by a bare console.warn -- so the sale just sat in
    // "Pending Labels" forever even though it had genuinely been printed,
    // making the dashboard look permanently uncleaned.
    async function withAuthRetry(operationFn) {
        let result = await operationFn();
        const err = result?.error;
        const looksLikeAuthRejection = err && (
            err.code === '42501' ||
            err.code === 'PGRST301' ||
            /row-level security|jwt|permission denied/i.test(err.message || '')
        );
        if (looksLikeAuthRejection) {
            console.warn('⚠️ Write rejected (looks like a stale session) -- refreshing session and retrying once:', err.message);
            try { await supabaseClient.auth.refreshSession(); } catch (refreshError) { console.error('Session refresh failed:', refreshError); }
            result = await operationFn();
        }
        return result;
    }

    // Opens the print window for one sale's labels and marks
    // labels_printed_at so it drops off the pending queue everywhere --
    // any device/terminal viewing this page sees the same state. Always
    // callable again later for a reprint (search still finds it), it just
    // won't show in the "Pending Labels" queue anymore.
    async function printLabelsForSale(sale) {
        if (!sale || !sale.items || sale.items.length === 0) {
            alert('This sale has no items to print labels for.');
            return;
        }

        const stickerWindow = window.open('', '_blank', 'width=400,height=500');
        stickerWindow.document.write(buildStickerHTML({ sale_id: sale.sale_id, items: sale.items }));
        stickerWindow.document.close();
        stickerWindow.print();

        const { error: markPrintedError } = await withAuthRetry(() =>
            supabaseClient
                .from('sales')
                .update({ labels_printed_at: new Date().toISOString() })
                .eq('id', sale.id)
        );

        if (markPrintedError) {
            // 🔥 CHANGED: this used to be swallowed with just a
            // console.warn, so staff had no idea the sale hadn't actually
            // dropped off the pending list -- it would just keep
            // reappearing after every refresh with no explanation.
            console.error('Could not mark labels_printed_at even after retry:', markPrintedError);
            alert(`The label(s) for ${sale.sale_id} printed, but this device could not mark it as printed in the system (it will still show as pending here). Please try clicking "Print Labels" again for this sale, or refresh the page. Error: ${markPrintedError.message || markPrintedError}`);
        }

        await loadDispenseQueue();
        // Re-run the last search too, if one is showing, so its "Reprint"
        // label/timestamp reflects the print that just happened.
        const searchInput = document.getElementById('dashDispenseSearchInput');
        if (searchInput && searchInput.value.trim()) {
            await searchDispenseSales(searchInput.value.trim());
        }
    }

    function renderDispenseRow(sale, isSearchResult) {
        const itemCount = (sale.items || []).length;
        const customerName = sale.customer_data?.full_name || 'Walk-in';
        const time = new Date(sale.created_at).toLocaleString();
        const printedBadge = sale.labels_printed_at
            ? `<span style="margin-left:6px; background:#dcfce7; color:#166534; padding:1px 7px; border-radius:8px; font-size:0.65rem; font-weight:600;">Printed ${new Date(sale.labels_printed_at).toLocaleString()}</span>`
            : '';
        const btnLabel = sale.labels_printed_at
            ? '<i class="fa-solid fa-print"></i> Reprint'
            : '<i class="fa-solid fa-print"></i> Print Labels';

        return `
            <tr>
                <td style="padding-left:12px;"><strong>${sale.sale_id}</strong>${isSearchResult ? printedBadge : ''}</td>
                <td>${customerName}</td>
                <td>${itemCount}</td>
                <td>${time}</td>
                <td style="text-align:right; padding-right:12px;">
                    <button class="btn btn-outline btn-sm dash-print-invoice-btn" data-sale-id="${sale.id}" style="margin-right:6px;"><i class="fa-solid fa-file-invoice"></i> Print Invoice</button>
                    <button class="btn btn-primary btn-sm dash-print-labels-btn" data-sale-id="${sale.id}">${btnLabel}</button>
                </td>
            </tr>
        `;
    }

    // Sales fetched for the queue/search are cached here keyed by id, so
    // the print button (delegated click) doesn't need a second round trip
    // just to get the items it already has in front of it.
    const dispenseSaleCache = {};

    // 🔥 ADDED: only TODAY's unprinted sales show here -- a sale from a
    // previous day drops off this list once the day rolls over, even if
    // it was never printed. This is a deliberate stopgap: some sales
    // (e.g. a cash sale of pure surgicals/non-drug items) never get their
    // "Print Labels" clicked because there's genuinely no dispensing
    // label to print, and with no date filter those sat here forever,
    // cluttering the dashboard indefinitely. Once every product carries a
    // "needs a label" flag (planned once all stock is in the system),
    // this date cutoff can be replaced with filtering by that flag
    // instead, so a genuinely forgotten DRUG label doesn't just silently
    // vanish at midnight the way this stopgap allows today.
    function startOfTodayIso() {
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);
        return startOfToday.toISOString();
    }

    async function loadDispenseQueue() {
        const tbody = document.getElementById('dashDispenseQueueBody');
        if (!tbody) return;

        try {
            const { data, error } = await supabaseClient
                .from('sales')
                // 🔥 ADDED payment, subtotal, tax, grand_total -- needed so
                // printInvoiceForSale() can print the SAME full invoice
                // layout Retail POS prints at checkout (see
                // buildDispatchInvoiceHTML()'s comment); these weren't
                // selected before since the queue row itself never showed
                // them.
                .select('id, sale_id, customer_data, items, created_at, labels_printed_at, payment, subtotal, tax, grand_total')
                .eq('client_type', 'RETAIL')
                .neq('is_quotation', true)
                .is('labels_printed_at', null)
                .gte('created_at', startOfTodayIso())
                .order('created_at', { ascending: false })
                .limit(30);

            if (error) throw error;

            if (!data || data.length === 0) {
                tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:20px;color:#22c55e;"><i class="fa-solid fa-circle-check"></i> All caught up -- no pending labels.</td></tr>`;
                return;
            }

            data.forEach(sale => dispenseSaleCache[sale.id] = sale);
            tbody.innerHTML = data.map(sale => renderDispenseRow(sale, false)).join('');
        } catch (error) {
            console.error('Error loading dispensing queue:', error);
            tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:20px;color:#dc2626;">Error loading queue: ${error.message}</td></tr>`;
        }
    }

    async function searchDispenseSales(query) {
        const resultsEl = document.getElementById('dashDispenseSearchResults');
        if (!resultsEl) return;

        if (!query) {
            resultsEl.innerHTML = '';
            return;
        }

        resultsEl.innerHTML = `<p style="color:#94a3b8; padding:10px 0;"><i class="fa-solid fa-spinner fa-spin"></i> Searching...</p>`;

        try {
            // 🔥 CHANGED: was invoice-number-only, which is exactly what
            // made this hard to use -- a dispenser trying to find a
            // specific patient in a long pending list had no way to
            // search by name, only by an invoice number they usually
            // don't have memorized. Now matches EITHER the invoice
            // number OR the customer's name (same .or()/ilike pattern
            // already used for Retail POS's own invoice search).
            const { data, error } = await supabaseClient
                .from('sales')
                // 🔥 ADDED payment, subtotal, tax, grand_total -- same reason as loadDispenseQueue() above.
                .select('id, sale_id, customer_data, items, created_at, labels_printed_at, payment, subtotal, tax, grand_total')
                .eq('client_type', 'RETAIL')
                .neq('is_quotation', true)
                .or(`sale_id.ilike.%${query}%,customer_data->>full_name.ilike.%${query}%`)
                .order('created_at', { ascending: false })
                .limit(10);

            if (error) throw error;

            if (!data || data.length === 0) {
                resultsEl.innerHTML = `<p style="color:#94a3b8; padding:10px 0; font-size:0.85rem;">No matching invoice found.</p>`;
                return;
            }

            data.forEach(sale => dispenseSaleCache[sale.id] = sale);
            resultsEl.innerHTML = `
                <div class="table-responsive">
                    <table class="table-minimal" style="width:100%;">
                        <thead>
                            <tr>
                                <th style="padding-left:12px;">Invoice #</th>
                                <th>Customer</th>
                                <th>Items</th>
                                <th>Time</th>
                                <th style="text-align:right; padding-right:12px;">Action</th>
                            </tr>
                        </thead>
                        <tbody>${data.map(sale => renderDispenseRow(sale, true)).join('')}</tbody>
                    </table>
                </div>
            `;
        } catch (error) {
            console.error('Error searching sales for dispensing:', error);
            resultsEl.innerHTML = `<p style="color:#dc2626; padding:10px 0; font-size:0.85rem;">Error searching: ${error.message}</p>`;
        }
    }

    // Delegated click covers both the queue table and the search results
    // table -- neither is rebuilt via cloneNode, so a single listener on
    // the shared container works for both.
    const dispenseCard = document.getElementById('dashDispenseQueueBody')?.closest('.card');
    if (dispenseCard) {
        dispenseCard.addEventListener('click', (e) => {
            // 🔥 ADDED: Print Invoice, reusing the same printInvoiceForSale()
            // already wired up on the "Next Up" dispatch panel -- no new
            // print logic needed, just a second entry point to it from here.
            const invoiceBtn = e.target.closest('.dash-print-invoice-btn');
            if (invoiceBtn) {
                const sale = dispenseSaleCache[invoiceBtn.dataset.saleId];
                if (sale) printInvoiceForSale(sale);
                return;
            }
            const btn = e.target.closest('.dash-print-labels-btn');
            if (!btn) return;
            const sale = dispenseSaleCache[btn.dataset.saleId];
            if (sale) printLabelsForSale(sale);
        });
    }

    const dashDispenseSearchBtn = document.getElementById('dashDispenseSearchBtn');
    const dashDispenseSearchInput = document.getElementById('dashDispenseSearchInput');
    const dashDispenseRefreshBtn = document.getElementById('dashDispenseRefreshBtn');

    if (dashDispenseSearchBtn) {
        dashDispenseSearchBtn.addEventListener('click', () => searchDispenseSales(dashDispenseSearchInput?.value.trim() || ''));
    }
    if (dashDispenseSearchInput) {
        dashDispenseSearchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') searchDispenseSales(dashDispenseSearchInput.value.trim());
        });
    }
    if (dashDispenseRefreshBtn) {
        dashDispenseRefreshBtn.addEventListener('click', loadDispenseQueue);
    }

    // ============================================
    // 🔥 ADDED: CALL NEXT PATIENT (DISPATCH ONLY)
    // ============================================
    // Shown only when THIS login chose "Dispatch" as their counter at
    // login (assets/js/auth.js's counter picker, stored in
    // sessionStorage.staffCounter) -- a role check alone isn't enough,
    // since a Pharmacist login might not be covering dispatch today.
    // Talks to the exact same call_next_ticket / complete_dispensing_ticket
    // / skip_ticket RPCs (and queue_tickets table) as the always-visible
    // top bar (assets/js/shared-queue-bar.js) -- this card is just a
    // second, more prominent entry point to the SAME action, right here
    // where dispatch is already working. Kept in sync with the top bar
    // two ways: they share the same sessionStorage key for who's
    // currently being served, and each dispatches a 'queueServingChanged'
    // / 'queueWaitingCountChanged' window event the other listens for, so
    // calling/completing/skipping from either place updates both
    // immediately without a page reload.
    function initDispatchQueueCard() {
        const card = document.getElementById('dashDispatchQueueCard');
        if (!card) return;

        if (sessionStorage.getItem('staffCounter') !== 'Dispatch') return; // not covering dispatch today
        card.style.display = 'block';

        const SERVING_KEY = 'queueServingTicket_dispensing';
        let serving = null;
        try {
            const saved = sessionStorage.getItem(SERVING_KEY);
            if (saved) serving = JSON.parse(saved);
        } catch (e) { /* ignore */ }

        function render() {
            const idleEl = document.getElementById('dashDispatchIdle');
            const servingEl = document.getElementById('dashDispatchServing');
            if (!idleEl || !servingEl) return;
            if (serving) {
                idleEl.style.display = 'none';
                servingEl.style.display = 'flex';
                document.getElementById('dashDispatchServingToken').textContent = serving.token_number;
                document.getElementById('dashDispatchServingName').textContent = serving.patient_name;
            } else {
                idleEl.style.display = 'flex';
                servingEl.style.display = 'none';
            }
        }

        function setServing(ticket) {
            serving = ticket;
            if (ticket) sessionStorage.setItem(SERVING_KEY, JSON.stringify(ticket));
            else sessionStorage.removeItem(SERVING_KEY);
            render();
            window.dispatchEvent(new CustomEvent('queueServingChanged', { detail: { stage: 'dispensing', ticket } }));
        }

        async function loadWaitingBadge() {
            const badge = document.getElementById('dashDispatchWaitingBadge');
            if (!badge) return;
            const today = new Date().toISOString().split('T')[0];
            const { count, error } = await supabaseClient
                .from('queue_tickets')
                .select('id', { count: 'exact', head: true })
                .eq('queue_date', today)
                .eq('status', 'waiting_dispensing');
            if (error) { console.warn('Error loading dispatch waiting count:', error); return; }
            badge.textContent = `${count || 0} waiting`;
        }

        // 🔥 ADDED: "NEXT UP" PREVIEW -- lets the dispenser see (and print)
        // the upcoming patient's label/invoice BEFORE clicking "Call Next
        // Patient", so the medicine is already prepared by the time that
        // patient is actually called up. Previously the only way to find
        // a specific patient's invoice was to scroll/search the whole
        // "Pending Labels" queue below, which is exactly what made this
        // slow with a long list -- this surfaces the RIGHT one
        // automatically, no searching needed.
        //
        // ensureNextUpPanel() creates its container once and re-uses it
        // on every refresh (this function can be re-entered many times
        // per page visit) rather than re-appending a new one each time.
        function ensureNextUpPanel() {
            let panel = document.getElementById('dashDispatchNextUpPanel');
            if (panel) return panel;
            panel = document.createElement('div');
            panel.id = 'dashDispatchNextUpPanel';
            panel.style.cssText = 'margin-top:14px; border-top:1px solid #f1f5f9; padding-top:14px;';
            card.appendChild(panel);
            return panel;
        }

        // Reads who's next WITHOUT calling call_next_ticket() -- that RPC
        // actually dequeues a ticket (marks it "serving"), so using it
        // just to look would jump the patient's turn. This is a plain
        // SELECT using the exact same ordering call_next_ticket() itself
        // uses (priority desc, token_number asc), so "who's next" here
        // always agrees with who Call Next Patient will actually pull.
        async function loadNextUpPreview() {
            const panel = ensureNextUpPanel();
            panel.innerHTML = `<p style="color:#94a3b8; font-size:0.8rem; margin:0;"><i class="fa-solid fa-spinner fa-spin"></i> Checking who's next...</p>`;

            try {
                const today = new Date().toISOString().split('T')[0];
                const { data: nextTicket, error: ticketError } = await supabaseClient
                    .from('queue_tickets')
                    .select('id, token_number, patient_name, customer_id')
                    .eq('queue_date', today)
                    .eq('status', 'waiting_dispensing')
                    .order('priority', { ascending: false })
                    .order('token_number', { ascending: true })
                    .limit(1)
                    .maybeSingle();

                if (ticketError) throw ticketError;

                if (!nextTicket) {
                    panel.innerHTML = '';
                    return;
                }

                // No direct ticket<->invoice link exists in the schema
                // yet, so this matches on customer_id first (set on both
                // the ticket at registration and the sale at checkout in
                // the normal billing flow), falling back to matching the
                // patient's name on today's Retail sales if that comes up
                // empty -- e.g. a walk-in never tied to a customer record.
                const saleColumns = 'id, sale_id, customer_data, items, created_at, labels_printed_at, subtotal, tax, grand_total, payment, customer_id';
                let sale = null;

                if (nextTicket.customer_id) {
                    const { data } = await supabaseClient
                        .from('sales')
                        .select(saleColumns)
                        .eq('client_type', 'RETAIL')
                        .neq('is_quotation', true)
                        .eq('customer_id', nextTicket.customer_id)
                        .gte('created_at', startOfTodayIso())
                        .order('created_at', { ascending: false })
                        .limit(1)
                        .maybeSingle();
                    sale = data || null;
                }

                if (!sale && nextTicket.patient_name) {
                    const { data } = await supabaseClient
                        .from('sales')
                        .select(saleColumns)
                        .eq('client_type', 'RETAIL')
                        .neq('is_quotation', true)
                        .ilike('customer_data->>full_name', nextTicket.patient_name)
                        .gte('created_at', startOfTodayIso())
                        .order('created_at', { ascending: false })
                        .limit(1)
                        .maybeSingle();
                    sale = data || null;
                }

                if (sale) dispenseSaleCache[sale.id] = sale;
                renderNextUpPanel(panel, nextTicket, sale);
            } catch (err) {
                console.warn('Could not load next-up preview:', err);
                panel.innerHTML = '';
            }
        }

        function renderNextUpPanel(panel, ticket, sale) {
            const header = `
                <div style="font-size:0.75rem; color:#94a3b8; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px;">
                    <i class="fa-solid fa-mortar-pestle"></i> Next Up -- Prepare Before Calling
                </div>
                <div style="font-weight:600; color:#0f172a; margin-bottom:8px;">#${ticket.token_number} -- ${ticket.patient_name}</div>
            `;

            if (!sale) {
                panel.innerHTML = header + `
                    <p style="color:#b45309; background:#fffbeb; border:1px solid #fde68a; border-radius:6px; padding:8px 10px; font-size:0.8rem; margin:0;">
                        <i class="fa-solid fa-triangle-exclamation"></i> No matching invoice found yet for this patient -- search by name below once billing is done, or check with the billing counter.
                    </p>
                `;
                return;
            }

            const printedBadge = sale.labels_printed_at
                ? `<span style="margin-left:8px; background:#dcfce7; color:#166534; padding:1px 8px; border-radius:8px; font-size:0.68rem; font-weight:600;">Labels Printed</span>`
                : '';

            panel.innerHTML = header + `
                <div style="background:#f8fafc; border-radius:8px; padding:10px 12px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                        <strong style="font-size:0.85rem;">${sale.sale_id}</strong>${printedBadge}
                    </div>
                    <div style="font-size:0.8rem; color:#475569; margin-bottom:8px;">
                        ${(sale.items || []).map(item => `${item.product_name} (Qty ${item.qty})`).join(', ') || 'No items on this invoice.'}
                    </div>
                    <div style="display:flex; gap:8px;">
                        <button type="button" class="btn btn-outline btn-sm dash-nextup-print-invoice-btn"><i class="fa-solid fa-file-invoice"></i> Print Invoice</button>
                        <button type="button" class="btn btn-outline btn-sm dash-nextup-print-labels-btn"><i class="fa-solid fa-print"></i> Print Label(s)</button>
                    </div>
                </div>
            `;

            panel.querySelector('.dash-nextup-print-invoice-btn')?.addEventListener('click', () => printInvoiceForSale(sale));
            panel.querySelector('.dash-nextup-print-labels-btn')?.addEventListener('click', () => {
                printLabelsForSale(sale).then(loadNextUpPreview);
            });
        }

        // 🔥 Window-level listeners are replaced (not stacked) on every
        // Dashboard revisit -- this script re-runs each time the module
        // loads, and a plain addEventListener here would otherwise add
        // one more listener per visit forever. The top bar's own
        // 'queueServingChanged' listener is safe without this because it
        // (and its setInterval/realtime channel) is only ever mounted
        // once for the whole session, outside the SPA content this
        // script lives in.
        if (window.__dispatchServingHandler) {
            window.removeEventListener('queueServingChanged', window.__dispatchServingHandler);
        }
        window.__dispatchServingHandler = (e) => {
            if (!e.detail || e.detail.stage !== 'dispensing') return;
            serving = e.detail.ticket;
            render();
        };
        window.addEventListener('queueServingChanged', window.__dispatchServingHandler);

        if (window.__dispatchWaitingHandler) {
            window.removeEventListener('queueWaitingCountChanged', window.__dispatchWaitingHandler);
        }
        window.__dispatchWaitingHandler = (e) => {
            if (!e.detail || e.detail.stage !== 'dispensing') return;
            const badge = document.getElementById('dashDispatchWaitingBadge');
            if (badge) badge.textContent = `${e.detail.count} waiting`;
            // A waiting-count change (new patient sent to dispensing,
            // priority escalation, etc.) can change who's next -- refresh
            // the preview so it never shows a stale patient.
            loadNextUpPreview();
        };
        window.addEventListener('queueWaitingCountChanged', window.__dispatchWaitingHandler);

        document.getElementById('dashDispatchNextBtn').addEventListener('click', async () => {
            const btn = document.getElementById('dashDispatchNextBtn');
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Calling...';
            try {
                const { data, error } = await supabaseClient.rpc('call_next_ticket', { p_stage: 'dispensing', p_counter: 'Dispatch' });
                if (error) throw error;
                // 🔥 FIX: call_next_ticket() is declared to RETURN a single
                // queue_tickets row (not SETOF), so when there's genuinely
                // no one left waiting, Postgres doesn't hand back "no rows"
                // -- it hands back ONE row where every column is null. That
                // object is still truthy in JS, so the old `if (!data)`
                // check never caught it: the "no one waiting" case fell
                // through to setServing(data) and the UI ended up showing
                // "Serving #null -- null" instead of going idle. Checking
                // .id specifically (present on every real ticket, always
                // null on the empty row) tells the two cases apart.
                if (!data || !data.id) {
                    alert('No patients waiting for dispensing right now.');
                } else {
                    setServing(data);
                }
                loadWaitingBadge();
                // The ticket just called was (almost always) the one the
                // preview below was just showing -- refresh it so it now
                // shows whoever is next in line to prepare for.
                loadNextUpPreview();
            } catch (err) {
                console.error('Error calling next ticket:', err);
                alert('Error calling next patient: ' + (err.message || err));
            } finally {
                btn.disabled = false;
                btn.innerHTML = '<i class="fa-solid fa-forward"></i> Call Next Patient';
            }
        });

        document.getElementById('dashDispatchCompleteBtn').addEventListener('click', async () => {
            if (!serving) return;
            try {
                const { error } = await supabaseClient.rpc('complete_dispensing_ticket', { p_ticket_id: serving.id });
                if (error) throw error;
                setServing(null);
                loadWaitingBadge();
                loadNextUpPreview();
            } catch (err) {
                console.error('Error completing dispensing:', err);
                alert('Error: ' + (err.message || err));
            }
        });

        document.getElementById('dashDispatchSkipBtn').addEventListener('click', async () => {
            if (!serving) return;
            if (!confirm(`Mark token #${serving.token_number} (${serving.patient_name}) as skipped?`)) return;
            try {
                const { error } = await supabaseClient.rpc('skip_ticket', { p_ticket_id: serving.id });
                if (error) throw error;
                setServing(null);
                loadWaitingBadge();
                loadNextUpPreview();
            } catch (err) {
                console.error('Error skipping ticket:', err);
                alert('Error: ' + (err.message || err));
            }
        });

        render();
        loadWaitingBadge(); // one-off -- live updates after this come via 'queueWaitingCountChanged' from the top bar's own polling/realtime, so this card doesn't need its own interval or channel subscription (which would otherwise stack up on every Dashboard revisit).
        loadNextUpPreview();
    }

    // ============================================
    // 🔥 ADDED: SHARED EXCHANGE RATE WIDGET
    // ============================================
    // Reads/writes the same `exchange_rates` table Account > Cash & Bank
    // already uses (see assets/js/shared-exchange-rate.js) -- setting it
    // here once means Payments, Purchase Orders, and Cash & Bank all pick
    // up the same default rate for the rest of the day instead of each
    // needing it re-typed separately.
    async function loadExchangeRateWidget() {
        const valueEl = document.getElementById('dashSidebarExchangeRateValue');
        const updatedEl = document.getElementById('dashSidebarExchangeRateUpdated');
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
    //     created_by uuid, created_by_name text, created_at timestamptz,
    //     target_type text default 'all' (values: 'all' | 'employee'),
    //     target_employee_id uuid null references employees(employee_id)
    //
    // 🔥 CHANGED: a notice can now be posted for EVERYONE (unchanged
    // behavior) or for one specific employee -- target_type/
    // target_employee_id above. A targeted notice only ever reaches that
    // one employee's own Dashboard sidebar (filtered server-side below,
    // not just hidden client-side -- someone else's browser never even
    // receives the row), plus Admin's own sidebar so whoever posted it
    // can still see/manage it. The targeted employee also gets a WhatsApp
    // message on their own number, same mechanism as the Leave/Advance
    // request notifications above (see notifyWhatsApp()) -- a legacy row
    // with no target_type at all (posted before this change) is treated
    // as 'all', same as an explicit 'all'.
    let noticeTargetEmployees = [];

    async function loadNoticeTargetEmployees() {
        const select = document.getElementById('dashPostNoticeTargetEmployee');
        if (!select) return;
        // Only Admin ever sees the Post Notice modal (the button that
        // opens it is hidden for everyone else), so skip the query
        // entirely for non-Admins rather than loading the whole employee
        // list on every single Dashboard visit for nothing.
        if (window.currentUserRole !== 'Admin') return;
        try {
            const { data, error } = await supabaseClient
                .from('employees')
                .select('employee_id, first_name, last_name, phone, status')
                .order('first_name', { ascending: true });
            if (error) throw error;

            // Only Active staff are offered as a notice target -- posting
            // (and WhatsApping) someone who's resigned/terminated makes no
            // sense.
            noticeTargetEmployees = (data || []).filter(e => !e.status || e.status === 'Active');

            select.innerHTML = noticeTargetEmployees.length === 0
                ? `<option value="">No active employees found</option>`
                : `<option value="">Select an employee...</option>` +
                    noticeTargetEmployees.map(e => `<option value="${e.employee_id}">${e.first_name} ${e.last_name}</option>`).join('');
        } catch (err) {
            console.warn('Could not load employees for Notice Board targeting:', err);
            select.innerHTML = `<option value="">Could not load employees</option>`;
        }
    }

    async function loadSidebarNotices() {
        const listEl = document.getElementById('dashSidebarNotices');
        const postBtn = document.getElementById('dashSidebarPostNoticeBtn');
        if (!listEl) return;

        const isAdmin = window.currentUserRole === 'Admin';
        if (postBtn) postBtn.style.display = isAdmin ? 'inline-block' : 'none';

        try {
            let query = supabaseClient
                .from('announcements')
                .select('*')
                .order('created_at', { ascending: false })
                .limit(5);

            // 🔥 ADDED: Admin sees every notice (so they can manage a
            // targeted one even though it isn't "theirs" to see) -- anyone
            // else only ever gets rows that are for everyone, or
            // specifically for them.
            if (!isAdmin) {
                query = currentEmployeeId
                    ? query.or(`target_type.is.null,target_type.eq.all,and(target_type.eq.employee,target_employee_id.eq.${currentEmployeeId})`)
                    : query.or('target_type.is.null,target_type.eq.all');
            }

            const { data, error } = await query;

            if (error) throw error;

            if (!data || data.length === 0) {
                listEl.innerHTML = `<p class="helper-text" style="font-size:0.75rem; padding:8px 0;">No notices right now.</p>`;
                return;
            }

            listEl.innerHTML = data.map(n => {
                const isTargeted = n.target_type === 'employee';
                // Resolved from the same employee list the "Specific
                // Employee" picker uses (see loadNoticeTargetEmployees())
                // rather than a join, so this never breaks if that join
                // isn't set up -- just falls back to a generic label.
                const targetEmp = isTargeted ? noticeTargetEmployees.find(e => e.employee_id === n.target_employee_id) : null;
                const targetName = isTargeted ? (targetEmp ? `${targetEmp.first_name} ${targetEmp.last_name}` : 'an employee') : null;
                // Only shown to Admin -- a targeted employee already knows
                // it's for them (it's the only reason they can see it at
                // all), but Admin needs the "who" since they see everyone's.
                const targetBadge = (isAdmin && isTargeted)
                    ? `<div style="display:inline-block; background:#fef3c7; color:#92400e; padding:1px 7px; border-radius:8px; font-size:0.65rem; font-weight:600; margin-top:4px;"><i class="fa-solid fa-user"></i> To: ${targetName}</div>`
                    : '';
                return `
                <div style="background:#eff6ff; border-radius:6px; padding:8px 10px; margin-bottom:6px; font-size:0.78rem; position:relative;">
                    <div style="color:#1e3a8a; padding-right:${isAdmin ? '18px' : '0'};">${n.message}</div>
                    <div style="color:#94a3b8; font-size:0.68rem; margin-top:3px;">${n.created_by_name || 'Admin'} · ${new Date(n.created_at).toLocaleDateString()}</div>
                    ${targetBadge}
                    ${isAdmin ? `<button onclick="deleteNotice('${n.id}')" style="position:absolute; top:6px; right:6px; background:none; border:none; color:#94a3b8; cursor:pointer; font-size:0.85rem;" title="Delete"><i class="fa-solid fa-xmark"></i></button>` : ''}
                </div>
            `;
            }).join('');
        } catch (err) {
            console.warn('Could not load notice board:', err);
            listEl.innerHTML = `<p class="helper-text" style="font-size:0.75rem; padding:8px 0; color:#dc2626;">Couldn't load notices.</p>`;
        }
    }

    window.deleteNotice = async function (id) {
        if (!confirm('Remove this notice?')) return;
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
    document.getElementById('dashSidebarOpenLeaveModalBtn').addEventListener('click', () => {
        document.getElementById('dashLeaveModal').style.display = 'flex';
    });
    document.getElementById('dashCloseLeaveModalBtn').addEventListener('click', () => {
        document.getElementById('dashLeaveModal').style.display = 'none';
    });
    document.getElementById('dashCancelLeaveBtn').addEventListener('click', () => {
        document.getElementById('dashLeaveModal').style.display = 'none';
    });

    document.getElementById('dashSidebarOpenExchangeRateModalBtn').addEventListener('click', async () => {
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

    // 🔥 ADDED: toggles the "Employee" picker on/off depending on who the
    // notice is for, and adjusts the helper text under Message to match --
    // so it's never left saying "Everyone sees this" while a specific
    // employee is actually selected.
    const dashPostNoticeTargetSelect = document.getElementById('dashPostNoticeTarget');
    const dashPostNoticeTargetEmployeeWrap = document.getElementById('dashPostNoticeTargetEmployeeWrap');
    const dashPostNoticeTargetEmployeeSelect = document.getElementById('dashPostNoticeTargetEmployee');
    const dashPostNoticeHelperText = document.getElementById('dashPostNoticeHelperText');
    function updatePostNoticeTargetUI() {
        const isEmployeeTarget = dashPostNoticeTargetSelect.value === 'employee';
        if (dashPostNoticeTargetEmployeeWrap) dashPostNoticeTargetEmployeeWrap.style.display = isEmployeeTarget ? 'block' : 'none';
        if (dashPostNoticeTargetEmployeeSelect) dashPostNoticeTargetEmployeeSelect.required = isEmployeeTarget;
        if (dashPostNoticeHelperText) {
            dashPostNoticeHelperText.textContent = isEmployeeTarget
                ? 'Only that employee sees this on their Dashboard sidebar -- they also get a WhatsApp message on their own number.'
                : 'Everyone sees this on the Dashboard sidebar the moment they open it.';
        }
    }
    if (dashPostNoticeTargetSelect) {
        dashPostNoticeTargetSelect.addEventListener('change', updatePostNoticeTargetUI);
    }

    document.getElementById('dashPostNoticeForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = document.getElementById('dashSubmitPostNoticeBtn');
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Posting...';

        try {
            const targetType = dashPostNoticeTargetSelect?.value === 'employee' ? 'employee' : 'all';
            const targetEmployeeId = targetType === 'employee' ? (dashPostNoticeTargetEmployeeSelect?.value || null) : null;

            if (targetType === 'employee' && !targetEmployeeId) {
                alert('Please choose which employee this notice is for.');
                return;
            }

            const message = document.getElementById('dashPostNoticeMessage').value.trim();
            const { data: sessionData } = await supabaseClient.auth.getSession();
            const { error } = await supabaseClient.from('announcements').insert([{
                message,
                target_type: targetType,
                target_employee_id: targetEmployeeId,
                created_by: sessionData?.session?.user?.id || null,
                created_by_name: window.currentUserName || 'Admin',
                created_at: new Date().toISOString()
            }]);
            if (error) throw error;

            // 🔥 ADDED: the targeted employee also gets this on WhatsApp,
            // on their own number -- fire-and-forget, same as every other
            // WhatsApp notification in this file, so a slow/failed send
            // never blocks the notice from posting.
            if (targetType === 'employee') {
                const targetEmp = noticeTargetEmployees.find(emp => emp.employee_id === targetEmployeeId);
                if (targetEmp?.phone) {
                    notifyWhatsApp(targetEmp.phone, WHATSAPP_TEMPLATES.NOTICE_BOARD, [
                        `${targetEmp.first_name} ${targetEmp.last_name}`,
                        message
                    ]);
                } else {
                    console.log('WhatsApp: targeted employee has no phone number on file -- skipping notification.');
                }
            }

            document.getElementById('dashPostNoticeForm').reset();
            updatePostNoticeTargetUI();
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
    // 🔥 ADDED: QUICK SALE (WALK-IN) -- collapsed "+" POS grid on the Dashboard
    // ============================================
    // A stripped-down Regular Retail sale with no patient details. It saves
    // the SAME shape as Retail POS's "Walk-in" button (client_type RETAIL,
    // client_sub_type REGULAR, customer_id null, customer_data.walk_in
    // true) so everything downstream -- the server-side accounting trigger
    // (post_retail_sale_accounting), stock deduction, the Dispensing queue
    // and invoice reprint -- treats it like any other regular retail sale.
    //
    // Pricing is the identical Regular Retail formula from retail/index.js's
    // updateRowRate(): pack cost (batch cost_price x pack size) marked up by
    // the exponential curve in company_settings. Quantity is in PACKS
    // (pack size = products.conversion_rate), stock comes off the
    // earliest-expiry batch first, spilling into the next batch if one
    // isn't enough (each batch part priced from its own cost).
    //
    // Discount: header-level only. sales.grand_total (what the till
    // collects and what the accounting trigger books) is AFTER discount;
    // the line items keep their full list rate/total. The discount itself
    // is recorded in sales.payment.discount_percent / discount_amount.
    // Bundle/kit products are not offered here (use Retail POS for those).
    function initQuickSale() {
        const card = document.getElementById('dashQsCard');
        if (!card) return;

        // Same gate as the Sales shortcut: roles that can't open the
        // Transaction module can't sell from here either.
        try {
            if (typeof ROLE_ACCESS !== 'undefined' && window.currentUserRole) {
                const allowed = ROLE_ACCESS[window.currentUserRole];
                if (Array.isArray(allowed) && !allowed.includes('transaction')) return;
            }
        } catch (e) { /* undetermined -> show */ }
        card.style.display = '';

        const toggleBtn = document.getElementById('dashQsToggleBtn');
        const body = document.getElementById('dashQsBody');
        const rowsEl = document.getElementById('dashQsRows');
        const discInput = document.getElementById('dashQsDiscPct');
        const saveBtn = document.getElementById('dashQsSaveBtn');
        const savePrintBtn = document.getElementById('dashQsSavePrintBtn');
        const clearBtn = document.getElementById('dashQsClearBtn');

        let catalog = null;          // [{id, product_name, conversion_rate, tax_percent, total_stock}]
        let catalogLoading = null;
        let saving = false;

        const money = n => 'K' + (Number(n) || 0).toFixed(2);
        const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
        const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

        // Same exponential curve as retail/index.js
        const cs = {
            max: Number(companySettings.retail_regular_markup_max_percent) || 60,
            min: Number(companySettings.retail_regular_markup_min_percent) || 30,
            costMin: Number(companySettings.markup_cost_min) || 1,
            costMax: Number(companySettings.markup_cost_max) || 600
        };
        function markupPercent(cost) {
            if (!(cs.costMax > cs.costMin) || cs.max <= 0 || cs.min <= 0) return cs.max;
            const c = Math.min(Math.max(cost, cs.costMin), cs.costMax);
            const t = (c - cs.costMin) / (cs.costMax - cs.costMin);
            return cs.max * Math.pow(cs.min / cs.max, t);
        }
        function packRate(batch, pack) {
            const costPerPack = (Number(batch.cost_price) || 0) * pack;
            return round2(costPerPack * (1 + markupPercent(costPerPack) / 100));
        }

        async function ensureCatalog() {
            if (catalog) return catalog;
            if (!catalogLoading) {
                catalogLoading = (async () => {
                    const all = [];
                    for (let from = 0; ; from += 1000) {
                        const { data, error } = await supabaseClient
                            .from('products')
                            .select('id, product_name, generic_name_id, conversion_rate, tax_percent, total_stock, is_bundle')
                            .order('product_name', { ascending: true })
                            .range(from, from + 999);
                        if (error) throw error;
                        all.push(...(data || []));
                        if (!data || data.length < 1000) break;
                    }
                    // Generic names, so an item can be found by either name.
                    const genericMap = {};
                    for (let from = 0; ; from += 1000) {
                        const { data: gens, error: gerr } = await supabaseClient
                            .from('generic_names')
                            .select('id, name')
                            .range(from, from + 999);
                        if (gerr) { console.warn('Quick sale: could not load generic names', gerr); break; }
                        (gens || []).forEach(g => { genericMap[g.id] = g.name; });
                        if (!gens || gens.length < 1000) break;
                    }
                    catalog = all.filter(p => !p.is_bundle).map(p => ({
                        ...p,
                        generic_name: genericMap[p.generic_name_id] || ''
                    }));
                    return catalog;
                })().catch(err => { catalogLoading = null; throw err; });
            }
            return catalogLoading;
        }

        async function fetchBatches(productId) {
            const { data, error } = await supabaseClient
                .from('batches')
                .select('id, batch_number, expiry_date, total_qty, cost_price')
                .eq('product_id', productId)
                .gt('total_qty', 0)
                .order('expiry_date', { ascending: true });
            if (error) throw error;
            return data || [];
        }

        // Splits `packs` across batches, earliest expiry first, whole packs only.
        function allocate(batches, pack, packs) {
            const parts = [];
            let remaining = packs;
            for (const b of batches) {
                if (remaining <= 0) break;
                const avail = Math.floor((Number(b.total_qty) || 0) / pack);
                if (avail <= 0) continue;
                const take = Math.min(avail, remaining);
                parts.push({ batch: b, packs: take, rate: packRate(b, pack) });
                remaining -= take;
            }
            return { parts, short: remaining };
        }
        function maxPacks(batches, pack) {
            return batches.reduce((s, b) => s + Math.floor((Number(b.total_qty) || 0) / pack), 0);
        }

        // ---------- rows ----------
        function newRow() {
            const tr = document.createElement('tr');
            tr._d = { product: null, batches: [], parts: [], short: 0, gross: 0 };
            tr.innerHTML = `
                <td style="position:relative;">
                    <input type="text" class="qs-in qs-item" placeholder="Type item name..." autocomplete="off">
                    <div class="qs-suggest"></div>
                </td>
                <td class="qs-pack" style="color:#475569;">--</td>
                <td class="num qs-rate" style="color:#475569;">--</td>
                <td><input type="number" class="qs-in qs-qty" min="1" step="1" inputmode="numeric" disabled></td>
                <td class="num"><div class="qs-total-cell" tabindex="0">0.00</div></td>
                <td><button type="button" class="qs-del" title="Remove row">&times;</button></td>`;
            wireRow(tr);
            return tr;
        }

        function addRow(focus) {
            const tr = newRow();
            rowsEl.appendChild(tr);
            if (focus) tr.querySelector('.qs-item').focus();
            return tr;
        }

        function lastRow() { return rowsEl.lastElementChild; }
        function rowIsFilled(tr) { return !!(tr._d.product && tr._d.parts.length && !tr._d.short); }

        function renderRow(tr) {
            const d = tr._d;
            const qtyEl = tr.querySelector('.qs-qty');
            const rateEl = tr.querySelector('.qs-rate');
            const packEl = tr.querySelector('.qs-pack');
            const totalEl = tr.querySelector('.qs-total-cell');
            if (!d.product) {
                packEl.textContent = '--'; rateEl.textContent = '--'; totalEl.textContent = '0.00';
                qtyEl.disabled = true; qtyEl.value = ''; qtyEl.classList.remove('bad');
                return;
            }
            const pack = Number(d.product.conversion_rate) || 1;
            packEl.textContent = pack + 's';
            const first = d.batches[0];
            rateEl.textContent = first ? Number(packRate(first, pack)).toFixed(2) : '--';
            rateEl.title = d.parts.length > 1 ? `Spans ${d.parts.length} batches (each priced from its own cost)` : '';
            totalEl.textContent = Number(d.gross).toFixed(2);
            qtyEl.classList.toggle('bad', d.short > 0);
            qtyEl.title = d.short > 0 ? `Only ${maxPacks(d.batches, pack)} pack(s) in stock` : '';
        }

        function recalcRow(tr) {
            const d = tr._d;
            if (!d.product) { d.parts = []; d.short = 0; d.gross = 0; return renderRow(tr); }
            const pack = Number(d.product.conversion_rate) || 1;
            const qty = parseInt(tr.querySelector('.qs-qty').value, 10) || 0;
            if (qty <= 0) { d.parts = []; d.short = 0; d.gross = 0; }
            else {
                const a = allocate(d.batches, pack, qty);
                d.parts = a.parts; d.short = a.short;
                d.gross = round2(a.parts.reduce((s, p) => s + p.packs * p.rate, 0));
            }
            renderRow(tr);
        }

        // Totals computed from the rows' current state (also used at save).
        function computeTotals(rows) {
            const pct = Math.min(Math.max(parseFloat(discInput.value) || 0, 0), 100);
            let grossAll = 0, grossTax = 0;
            rows.forEach(tr => {
                const d = tr._d;
                if (!d.product || !d.gross) return;
                const t = Number(d.product.tax_percent) || 0;
                grossAll += d.gross;
                if (t > 0) grossTax += d.gross * (t / (100 + t));
            });
            grossAll = round2(grossAll);
            grossTax = round2(grossTax);
            const discount = round2(grossAll * pct / 100);
            const grand = round2(grossAll - discount);
            // Stored split (after discount): tax scales with the discount.
            const taxNet = round2(grossTax * (1 - pct / 100));
            return { pct, grossAll, grossTax, subtotalGross: round2(grossAll - grossTax), discount, grand, taxNet, subtotalNet: round2(grand - taxNet) };
        }

        function refreshTotals() {
            const t = computeTotals([...rowsEl.children]);
            document.getElementById('dashQsSubtotal').textContent = money(t.subtotalGross);
            document.getElementById('dashQsTax').textContent = money(t.grossTax);
            document.getElementById('dashQsDiscAmt').textContent = '-' + money(t.discount);
            document.getElementById('dashQsGrand').textContent = money(t.grand);
            return t;
        }

        async function pickProduct(tr, product) {
            const d = tr._d;
            const itemEl = tr.querySelector('.qs-item');
            try {
                const batches = await fetchBatches(product.id);
                if (!batches.length) {
                    showToastSimple(`${product.product_name}: no stock available.`);
                    return;
                }
                const pack = Number(product.conversion_rate) || 1;
                if (!maxPacks(batches, pack)) {
                    showToastSimple(`${product.product_name}: less than one full pack (${pack}) in stock -- use Retail POS for loose units.`);
                    return;
                }
                d.product = product; d.batches = batches;
                itemEl.value = product.product_name;
                const qtyEl = tr.querySelector('.qs-qty');
                qtyEl.disabled = false;
                qtyEl.value = '1';
                recalcRow(tr);
                refreshTotals();
                qtyEl.focus(); qtyEl.select();
            } catch (err) {
                console.error('Quick sale: could not load batches', err);
                showToastSimple('Could not load stock for that item. Please try again.');
            }
        }

        function clearRowProduct(tr) {
            tr._d = { product: null, batches: [], parts: [], short: 0, gross: 0 };
            recalcRow(tr);
            refreshTotals();
        }

        function wireRow(tr) {
            const itemEl = tr.querySelector('.qs-item');
            const sg = tr.querySelector('.qs-suggest');
            const qtyEl = tr.querySelector('.qs-qty');
            const totalEl = tr.querySelector('.qs-total-cell');
            let matches = [];
            let active = -1;

            const hide = () => { sg.style.display = 'none'; active = -1; };
            const paintActive = () => [...sg.children].forEach((c, i) => c.classList.toggle('active', i === active));

            async function showMatches() {
                const q = itemEl.value.trim().toLowerCase();
                if (!q) { hide(); return; }
                let cat;
                try { cat = await ensureCatalog(); } catch (e) { showToastSimple('Could not load the item list.'); return; }
                const tokens = q.split(/\s+/).filter(Boolean);
                matches = cat.filter(p => {
                    const hay = ((p.product_name || '') + ' ' + (p.generic_name || '')).toLowerCase();
                    return tokens.every(t => hay.includes(t));
                }).sort((a, b) => {
                    const ai = (a.total_stock > 0 ? 0 : 1), bi = (b.total_stock > 0 ? 0 : 1);
                    if (ai !== bi) return ai - bi;
                    const rank = p => (p.product_name.toLowerCase().startsWith(q) ? 0 : (p.generic_name || '').toLowerCase().startsWith(q) ? 1 : 2);
                    const r = rank(a) - rank(b);
                    return r !== 0 ? r : a.product_name.localeCompare(b.product_name);
                }).slice(0, 15);
                if (!matches.length) { sg.innerHTML = '<div class="qs-sg" style="color:#94a3b8; cursor:default;">No matching item</div>'; sg.style.display = 'block'; active = -1; return; }
                sg.innerHTML = matches.map((p, i) =>
                    `<div class="qs-sg" data-i="${i}"><span><span style="font-weight:600; color:#0f172a;">${esc(p.product_name)}</span>${p.generic_name ? `<br><small style="color:#64748b;">${esc(p.generic_name)}</small>` : ''}</span><small style="${p.total_stock > 0 ? '' : 'color:#dc2626;'}">${p.total_stock > 0 ? p.total_stock + ' in stock' : 'out of stock'}</small></div>`).join('');
                sg.style.display = 'block';
                active = 0; paintActive();
            }

            itemEl.addEventListener('input', () => {
                if (tr._d.product) clearRowProduct(tr);
                showMatches();
            });
            const scrollActive = () => { const el = sg.children[active]; if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' }); };
            const listOpen = () => sg.style.display === 'block' && matches.length > 0;
            itemEl.addEventListener('keydown', e => {
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    if (!listOpen()) { showMatches(); return; }
                    active = (active + 1) % matches.length; paintActive(); scrollActive();
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    if (!listOpen()) return;
                    active = (active - 1 + matches.length) % matches.length; paintActive(); scrollActive();
                } else if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) {
                    // Enter or Tab takes the highlighted item and jumps to Qty.
                    if (listOpen() && matches[active]) { e.preventDefault(); const p = matches[active]; hide(); pickProduct(tr, p); }
                } else if (e.key === 'Escape') { hide(); }
            });
            itemEl.addEventListener('focus', () => { if (itemEl.value.trim() && !tr._d.product) showMatches(); });
            itemEl.addEventListener('blur', () => setTimeout(hide, 150));
            sg.addEventListener('mousemove', e => {
                const el = e.target.closest('.qs-sg[data-i]');
                if (el) { const i = parseInt(el.dataset.i, 10); if (i !== active) { active = i; paintActive(); } }
            });
            sg.addEventListener('mousedown', e => {
                const el = e.target.closest('.qs-sg[data-i]');
                if (!el) return;
                e.preventDefault();
                const p = matches[parseInt(el.dataset.i, 10)];
                hide();
                if (p) pickProduct(tr, p);
            });

            qtyEl.addEventListener('input', () => { recalcRow(tr); refreshTotals(); });
            qtyEl.addEventListener('keydown', e => {
                if (e.key === 'Enter') { e.preventDefault(); totalEl.focus(); }
            });

            // Arriving at Total (Tab/Enter from Qty) starts the next row.
            totalEl.addEventListener('focus', () => {
                if (tr === lastRow() && rowIsFilled(tr)) addRow(true);
                else if (tr === lastRow() && tr._d.short > 0) { qtyEl.focus(); }
            });

            tr.querySelector('.qs-del').addEventListener('click', () => {
                if (rowsEl.children.length <= 1) { resetAll(); return; }
                tr.remove();
                refreshTotals();
            });
        }

        function resetAll() {
            rowsEl.innerHTML = '';
            addRow(false);
            discInput.value = '0';
            document.getElementById('dashQsNote').value = '';
            document.getElementById('dashQsPayType').value = 'Cash';
            refreshTotals();
        }

        function setOpen(open) {
            body.style.display = open ? 'block' : 'none';
            toggleBtn.classList.toggle('open', open);
            toggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
            toggleBtn.title = open ? 'Close quick sale' : 'Open quick sale';
            if (open) {
                if (!rowsEl.children.length) addRow(false);
                ensureCatalog().catch(() => showToastSimple('Could not load the item list.'));
                const first = rowsEl.querySelector('.qs-item');
                if (first) first.focus();
            }
        }
        toggleBtn.addEventListener('click', () => setOpen(body.style.display === 'none'));
        // Lets the sidebar "Quick Sale" shortcut open it too.
        window.dashOpenQuickSale = () => {
            setOpen(true);
            card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        };

        discInput.addEventListener('input', refreshTotals);
        clearBtn.addEventListener('click', resetAll);

        // ---------- save ----------
        async function deductStock(qtyByBatch) {
            for (const [batchId, units] of qtyByBatch.entries()) {
                let done = false;
                for (let attempt = 0; attempt < 4 && !done; attempt++) {
                    const { data: cur, error: readErr } = await supabaseClient.from('batches').select('total_qty').eq('id', batchId).maybeSingle();
                    if (readErr || !cur) throw new Error('Could not read stock to deduct: ' + (readErr?.message || 'batch missing'));
                    const { data: upd, error: updErr } = await supabaseClient.from('batches')
                        .update({ total_qty: cur.total_qty - units })
                        .eq('id', batchId).eq('total_qty', cur.total_qty).select('id');
                    if (updErr) throw new Error('Stock deduction failed: ' + updErr.message);
                    if (upd && upd.length) done = true;
                }
                if (!done) throw new Error('Stock changed while saving (another sale?). Please try again.');
            }
        }

        async function save(andPrint) {
            if (saving) return;
            saving = true;
            [saveBtn, savePrintBtn, clearBtn].forEach(b => b.disabled = true);
            const origSave = saveBtn.innerHTML, origPrint = savePrintBtn.innerHTML;
            (andPrint ? savePrintBtn : saveBtn).innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
            try {
                const rows = [...rowsEl.children].filter(tr => tr._d.product && (parseInt(tr.querySelector('.qs-qty').value, 10) || 0) > 0);
                if (!rows.length) { showToastSimple('Add at least one item.'); return; }

                // Re-read live stock for every item so a stale screen can't oversell.
                const shownGrand = computeTotals(rows).grand;
                for (const tr of rows) {
                    tr._d.batches = await fetchBatches(tr._d.product.id);
                    recalcRow(tr);
                }
                const bad = rows.find(tr => tr._d.short > 0 || !tr._d.parts.length);
                if (bad) {
                    refreshTotals();
                    alert(`Not enough stock for ${bad._d.product.product_name}. Only ${maxPacks(bad._d.batches, Number(bad._d.product.conversion_rate) || 1)} pack(s) available. Please reduce the quantity.`);
                    return;
                }
                const t = computeTotals(rows);
                refreshTotals();
                if (Math.abs(t.grand - shownGrand) > 0.005) {
                    alert('Prices or stock changed since you entered these items. The totals have been refreshed -- please check them and press Save again.');
                    return;
                }
                if (t.grand <= 0) { showToastSimple('Total is zero -- nothing to save.'); return; }

                const payType = document.getElementById('dashQsPayType').value || 'Cash';
                const payNote = document.getElementById('dashQsNote').value.trim();
                const prefix = companySettings.retail_prefix_regular || companySettings.invoice_prefix || 'GRI';

                const items = [];
                const qtyByBatch = new Map();
                for (const tr of rows) {
                    const p = tr._d.product;
                    const pack = Number(p.conversion_rate) || 1;
                    for (const part of tr._d.parts) {
                        items.push({
                            product_id: p.id,
                            product_name: p.product_name,
                            generic_name: p.generic_name || '',
                            batch_id: part.batch.id,
                            batch_number: part.batch.batch_number,
                            expiry: part.batch.expiry_date ? new Date(part.batch.expiry_date).toLocaleDateString() : '',
                            qty: part.packs,
                            rate: part.rate,
                            pack_size: pack + 's',
                            tax_rate: Number(p.tax_percent) || 0,
                            total: round2(part.packs * part.rate),
                            days_supplied: 0,
                            how_to_take: '',
                            cost_per_unit: Number(part.batch.cost_price) || 0,
                            available_qty: part.batch.total_qty
                        });
                        qtyByBatch.set(part.batch.id, (qtyByBatch.get(part.batch.id) || 0) + part.packs * pack);
                    }
                }

                const makeId = () => `${prefix}-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;
                const nowIso = new Date().toISOString();
                const record = {
                    sale_id: makeId(),
                    type: 'COMPLETED',
                    prefix: prefix,
                    client_type: 'RETAIL',
                    client_sub_type: 'REGULAR',
                    customer_data: { type: 'REGULAR', walk_in: true, quick_sale: true, full_name: 'Walk-in Customer' },
                    customer_id: null,
                    claim_number: null,
                    bypass_number: null,
                    items: items,
                    payment: { type: payType, note: payNote, discount_percent: t.pct, discount_amount: t.discount },
                    subtotal: t.subtotalNet,
                    tax: t.taxNet,
                    grand_total: t.grand,
                    status: 'COMPLETED',
                    is_quotation: false,
                    created_at: nowIso,
                    updated_at: nowIso
                };

                let ins = await withAuthRetry(() => supabaseClient.from('sales').insert([record]).select());
                if (ins.error && (ins.error.code === '23505' || /duplicate key/i.test(ins.error.message || ''))) {
                    record.sale_id = makeId();
                    ins = await withAuthRetry(() => supabaseClient.from('sales').insert([record]).select());
                }
                if (ins.error || !ins.data || !ins.data.length) {
                    alert('❌ Error saving sale:\n' + (ins.error?.message || 'no row returned'));
                    return;
                }
                const saved = ins.data[0];

                const saleItems = items.map(i => ({
                    sale_id: saved.id,
                    product_id: i.product_id,
                    batch_id: i.batch_id,
                    quantity: i.qty,
                    unit_price: i.rate,
                    pack_size: i.pack_size,
                    tax_rate: i.tax_rate,
                    total: i.total,
                    days_supplied: 0,
                    cost_per_unit: i.cost_per_unit
                }));
                const itemRes = await withAuthRetry(() => supabaseClient.from('sale_items').insert(saleItems));
                if (itemRes.error) {
                    await supabaseClient.from('sales').delete().eq('id', saved.id);
                    alert('❌ Failed to save sale items. Sale cancelled.\n' + itemRes.error.message);
                    return;
                }

                try {
                    await deductStock(qtyByBatch);
                } catch (stockErr) {
                    console.error('Quick sale stock error:', stockErr);
                    alert(`⚠️ Sale ${saved.sale_id} was saved but stock could NOT be fully deducted:\n${stockErr.message}\n\nPlease tell an admin so stock can be corrected.`);
                }

                try {
                    const { data: posted } = await supabaseClient.rpc('sale_accounting_entry_exists', { p_sale_id: saved.sale_id });
                    if (posted === false) {
                        alert(`⚠️ Sale ${saved.sale_id} saved and stock deducted, but its accounting entries were NOT found. Please tell an admin/accountant.`);
                    }
                } catch (accErr) { console.warn('Could not verify accounting entry:', accErr); }

                showToastSimple(`Sale ${saved.sale_id} saved -- ${money(t.grand)}.`);
                if (andPrint) {
                    try { await printInvoiceForSale(saved); } catch (pe) { console.error('Quick sale print failed:', pe); }
                }
                resetAll();
                rowsEl.querySelector('.qs-item')?.focus();
                try { await loadDispenseQueue(); } catch (e) { /* queue refresh is best-effort */ }
            } catch (err) {
                console.error('Quick sale error:', err);
                alert('❌ Error saving sale:\n' + (err.message || err));
            } finally {
                saving = false;
                [saveBtn, savePrintBtn, clearBtn].forEach(b => b.disabled = false);
                saveBtn.innerHTML = origSave; savePrintBtn.innerHTML = origPrint;
            }
        }
        saveBtn.addEventListener('click', () => save(false));
        savePrintBtn.addEventListener('click', () => save(true));

        resetAll();
    }

    // ============================================
    // INIT
    // ============================================
    // 🔥 FIX: each dashboard widget is now isolated with its own try/catch.
    // Previously these ran as one plain await chain -- a single unhandled
    // error in ANY one widget (e.g. the loadMyAdvances() crash above)
    // silently aborted the whole sequence, so every widget listed AFTER
    // the failing one never ran at all, with nothing visible to say why.
    // Now one broken widget only loses that widget, not everything below it.
    async function safeInit(label, fn) {
        try {
            await fn();
        } catch (error) {
            console.error(`❌ Dashboard widget "${label}" failed to load:`, error);
        }
    }

    await safeInit('resolveCurrentEmployee', resolveCurrentEmployee);
    await safeInit('loadMyLeave', loadMyLeave);
    await safeInit('loadMyAdvances', loadMyAdvances);
    await safeInit('loadMonthSummary', loadMonthSummary);
    await safeInit('loadAdminApprovals', loadAdminApprovals);
    await safeInit('loadDispenseQueue', loadDispenseQueue);
    await safeInit('initDispatchQueueCard', initDispatchQueueCard);
    await safeInit('initQuickSale', initQuickSale);
    await safeInit('loadExchangeRateWidget', loadExchangeRateWidget);
    await safeInit('loadSidebarStats', loadSidebarStats);
    await safeInit('loadNoticeTargetEmployees', loadNoticeTargetEmployees);
    await safeInit('loadSidebarNotices', loadSidebarNotices);

    console.log("✅ Dashboard initialized successfully!");
})();
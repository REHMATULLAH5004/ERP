// ============================================
// ANNUAL ATTENDANCE & LEAVE REPORT
// ============================================
// One place to see a whole calendar year for an employee (or every
// employee at once): required working hours, actual attended hours,
// overtime, present/absent days, leave broken out by type, and the
// annual-leave entitlement/remaining balance -- everything the other
// HR pages only ever show one month (or one employee) at a time.
//
// "Required Hours" reuses the exact same day-classification rule
// overtime already uses elsewhere (getDayCategory/REGULAR_HOURS from
// assets/js/shared-attendance-utils.js, loaded globally): 9h on a
// normal working day, 5h on the half-day adjacent to a Sat/Sun off
// day, 0h on the employee's own weekly off day or a public holiday.
// That keeps this report's idea of "should have worked this many
// hours" consistent with how overtime is actually calculated, instead
// of inventing a second, different definition of a standard day.
//
// Leave days taken/remaining mirrors leave/index.js: Annual + Emergency
// share one balance (sick and Unpaid don't touch it), counted from
// leave_requests with status = 'Approved'. Present/Absent/Incomplete
// mirror the same attendance-status rules as hr-view.js's calendar and
// register (see the 🔥 FIX notes there for why 'Leave' on the
// attendance record itself is authoritative, independent of whether
// its leave_requests row happens to be Approved).
// ============================================

(async function initAnnualReportPage() {
    console.log("Annual Report initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    const empSelect = document.getElementById('annReportEmployee');
    const yearSelect = document.getElementById('annReportYear');
    const thead = document.getElementById('annReportThead');
    const tbody = document.getElementById('annReportBody');

    let employees = [];
    let lastRenderedYear = null;
    let lastRenderedEmployeeName = 'All Employees';

    // ============================================
    // INIT: employee dropdown + year dropdown
    // ============================================
    async function loadEmployees() {
        const { data, error } = await supabaseClient
            .from('employees')
            .select('employee_id, first_name, last_name')
            .eq('status', 'Active')
            .order('first_name');
        if (error) { console.error(error); return; }
        employees = data || [];
        employees.forEach(emp => {
            empSelect.innerHTML += `<option value="${emp.employee_id}">${emp.first_name} ${emp.last_name}</option>`;
        });
    }

    function loadYears() {
        const currentYear = new Date().getFullYear();
        // 6 years back is plenty for any payroll/HR audit; add more by
        // just widening this range if ever needed.
        for (let y = currentYear; y >= currentYear - 5; y--) {
            yearSelect.innerHTML += `<option value="${y}">${y}</option>`;
        }
        yearSelect.value = String(currentYear);
    }

    // ============================================
    // CORE: pull a year's worth of data and bucket it per employee,
    // per month. One set of queries covers both "all employees" and
    // "single employee" modes -- the caller just decides how to roll
    // the monthly buckets up (sum all 12 months into one row, or show
    // the 12 rows as-is).
    // ============================================
    async function loadYearData(year, onlyEmployeeId) {
        // 🔥 CHANGED: don't consider any month before September 2026
        // (see LEAVE_TRACKING_START in shared-attendance-utils.js) --
        // yearStart used to always be Jan 1. For 2026 this means Jan-Aug
        // simply never accumulate anything in the per-month buckets
        // below (they stay at their blankMonth() zeros); a later year
        // with no cutoff inside it starts at its own Jan 1 as normal.
        const yearStart = effectiveYearStart(year);
        const todayStr = formatDateLocal(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
        const yearEndFull = `${year}-12-31`;
        // A year still in progress only counts up to today -- otherwise
        // every employee would show hundreds of "missing" required hours
        // for days that haven't happened yet.
        const yearEnd = yearEndFull < todayStr ? yearEndFull : todayStr;

        const employeeIds = onlyEmployeeId ? [onlyEmployeeId] : employees.map(e => e.employee_id);
        if (employeeIds.length === 0) return {};

        const [jobsRes, holidaysRes, attendanceRes, leaveRes] = await Promise.all([
            supabaseClient.from('employee_employment')
                .select('employee_id, weekly_off_day, annual_leave_days, joining_date, is_fixed_pay')
                .in('employee_id', employeeIds),
            supabaseClient.from('public_holidays').select('holiday_date')
                .gte('holiday_date', yearStart).lte('holiday_date', yearEndFull),
            supabaseClient.from('employee_attendance').select('employee_id, attendance_date, check_in, check_out, status, overtime_hours')
                .in('employee_id', employeeIds)
                .gte('attendance_date', yearStart).lte('attendance_date', yearEnd),
            supabaseClient.from('leave_requests').select('employee_id, leave_type, start_date, end_date, status')
                .in('employee_id', employeeIds)
                .eq('status', 'Approved')
                .lte('start_date', yearEndFull).gte('end_date', yearStart)
        ]);

        const jobByEmployee = {};
        (jobsRes.data || []).forEach(j => { jobByEmployee[j.employee_id] = j; });

        const holidaySet = new Set((holidaysRes.data || []).map(h => h.holiday_date));

        const attendanceByEmployee = {};
        (attendanceRes.data || []).forEach(a => {
            if (!attendanceByEmployee[a.employee_id]) attendanceByEmployee[a.employee_id] = {};
            attendanceByEmployee[a.employee_id][a.attendance_date] = a;
        });

        // Expand each approved leave request into individual dates within
        // the year, split by type, clipped to yearEnd (not yearEndFull --
        // leave days that haven't happened yet in an in-progress year
        // don't belong in a "taken so far" count).
        const leaveDatesByEmployee = {}; // employee_id -> { dateStr: leave_type }
        (leaveRes.data || []).forEach(l => {
            let d = new Date(Math.max(new Date(l.start_date), new Date(yearStart)));
            const end = new Date(Math.min(new Date(l.end_date), new Date(yearEnd)));
            if (!leaveDatesByEmployee[l.employee_id]) leaveDatesByEmployee[l.employee_id] = {};
            while (d <= end) {
                const dateStr = formatDateLocal(d.getFullYear(), d.getMonth(), d.getDate());
                leaveDatesByEmployee[l.employee_id][dateStr] = l.leave_type;
                d.setDate(d.getDate() + 1);
            }
        });

        // ---- Walk every day of the (clipped) year once, bucketing
        // everything into 12 per-employee-per-month accumulators. ----
        const blankMonth = () => ({
            requiredHours: 0, attendedHours: 0, overtimeHours: 0,
            presentDays: 0, absentDays: 0, incompleteDays: 0,
            annualLeaveDays: 0, sickLeaveDays: 0, unpaidLeaveDays: 0, otherLeaveDays: 0
        });

        const monthsByEmployee = {};
        employeeIds.forEach(id => {
            monthsByEmployee[id] = Array.from({ length: 12 }, blankMonth);
        });

        employeeIds.forEach(empId => {
            const job = jobByEmployee[empId] || {};
            const weeklyOffDay = job.weekly_off_day || null;
            const joiningDate = job.joining_date || null;
            const empAttendance = attendanceByEmployee[empId] || {};
            const empLeaveDates = leaveDatesByEmployee[empId] || {};

            let d = new Date(Math.max(new Date(yearStart), joiningDate ? new Date(joiningDate) : new Date(yearStart)));
            const end = new Date(yearEnd);
            while (d <= end) {
                const dateStr = formatDateLocal(d.getFullYear(), d.getMonth(), d.getDate());
                const monthBucket = monthsByEmployee[empId][d.getMonth()];
                const dayOfWeek = d.getDay();
                const isHoliday = holidaySet.has(dateStr);
                const record = empAttendance[dateStr];
                const leaveType = empLeaveDates[dateStr];

                // Required hours: 0 on a public holiday or the employee's
                // own off day, otherwise the Half/Full day rule.
                if (!isHoliday) {
                    const dayCategory = getDayCategory(weeklyOffDay, dayOfWeek);
                    monthBucket.requiredHours += (REGULAR_HOURS[dayCategory] || 0);
                }

                // Attendance status -- same precedence as hr-view.js's
                // calendar/register (see its 🔥 FIX comments): a Present
                // check-in wins outright, then an explicit Absent, then
                // the attendance record's own 'Leave' status (authoritative
                // regardless of leave_requests approval), then Incomplete,
                // then a leave_requests-only day (approved leave spanning
                // days with no attendance row of their own yet).
                if (record && record.check_in) {
                    monthBucket.presentDays++;
                    if (record.check_out) {
                        const [h1, m1] = record.check_in.split(':').map(Number);
                        const [h2, m2] = record.check_out.split(':').map(Number);
                        const minutes = (h2 * 60 + m2) - (h1 * 60 + m1);
                        if (minutes > 0) monthBucket.attendedHours += minutes / 60;
                    }
                    monthBucket.overtimeHours += Number(record.overtime_hours) || 0;
                } else if (record && record.status === 'Absent') {
                    monthBucket.absentDays++;
                } else if (record && record.status === 'Leave') {
                    tallyLeaveDay(monthBucket, leaveType || 'Annual');
                } else if (record && record.status !== 'Off' && record.status !== 'Holiday Off') {
                    monthBucket.incompleteDays++;
                } else if (leaveType) {
                    tallyLeaveDay(monthBucket, leaveType);
                }

                d.setDate(d.getDate() + 1);
            }
        });

        return {
            monthsByEmployee,
            // annual_leave_days is a FULL YEAR figure -- prorated via
            // entitlementForYear() the same way the Leave page and
            // Payroll do, so all three agree on an employee's
            // entitlement for this (possibly cutoff-shortened) year.
            entitlementByEmployee: Object.fromEntries(employeeIds.map(id => [id, entitlementForYear((jobByEmployee[id] || {}).annual_leave_days, year)]))
        };
    }

    function tallyLeaveDay(monthBucket, leaveType) {
        if (leaveType === 'Annual' || leaveType === 'Emergency') monthBucket.annualLeaveDays++;
        else if (leaveType === 'Sick') monthBucket.sickLeaveDays++;
        else if (leaveType === 'Unpaid') monthBucket.unpaidLeaveDays++;
        else monthBucket.otherLeaveDays++;
    }

    function sumMonths(months) {
        return months.reduce((acc, m) => {
            Object.keys(m).forEach(k => { acc[k] = (acc[k] || 0) + m[k]; });
            return acc;
        }, {});
    }

    const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    // entitlementForYear() can return a fractional number (an
    // annual_leave_days value that doesn't divide evenly by 12) --
    // display to 1 decimal only when it isn't a whole number.
    const fmt = n => Number.isInteger(n) ? n : n.toFixed(1);

    function statsRowCells(s) {
        const variance = s.attendedHours - s.requiredHours;
        return `
            <td style="text-align:right;">${s.requiredHours.toFixed(1)}</td>
            <td style="text-align:right;">${s.attendedHours.toFixed(1)}</td>
            <td style="text-align:right; color:${variance < 0 ? '#dc2626' : '#15803d'};">${variance >= 0 ? '+' : ''}${variance.toFixed(1)}</td>
            <td style="text-align:right;">${s.overtimeHours.toFixed(1)}</td>
            <td style="text-align:center; color:#15803d;">${s.presentDays}</td>
            <td style="text-align:center; color:#dc2626;">${s.absentDays}</td>
            <td style="text-align:center; color:#8b5cf6;">${s.annualLeaveDays}</td>
            <td style="text-align:center;">${s.sickLeaveDays}</td>
            <td style="text-align:center;">${s.unpaidLeaveDays}</td>
            <td style="text-align:center; color:#d97706;">${s.incompleteDays}</td>
        `;
    }

    const STATS_HEADER_CELLS = `
        <th style="text-align:right;">Required Hrs</th>
        <th style="text-align:right;">Attended Hrs</th>
        <th style="text-align:right;">Variance</th>
        <th style="text-align:right;">Overtime</th>
        <th>Present</th>
        <th>Absent</th>
        <th>Leave</th>
        <th>Sick</th>
        <th>Unpaid</th>
        <th>Incomplete</th>
    `;

    // ============================================
    // GENERATE (renders the on-page table)
    // ============================================
    window.generateAnnualReport = async function () {
        const year = Number(yearSelect.value);
        const empId = empSelect.value || null;
        lastRenderedYear = year;
        lastRenderedEmployeeName = empId ? (empSelect.options[empSelect.selectedIndex].textContent) : 'All Employees';

        tbody.innerHTML = `<tr><td colspan="13" style="text-align:center; padding:30px; color:#94a3b8;"><i class="fa-solid fa-spinner fa-spin"></i> Crunching ${year}...</td></tr>`;

        const { monthsByEmployee, entitlementByEmployee } = await loadYearData(year, empId);

        if (empId) {
            renderSingleEmployeeView(empId, monthsByEmployee[empId], entitlementByEmployee[empId]);
        } else {
            renderAllEmployeesView(monthsByEmployee, entitlementByEmployee);
        }
    };

    function renderAllEmployeesView(monthsByEmployee, entitlementByEmployee) {
        thead.innerHTML = `
            <tr>
                <th style="text-align:left; padding-left:20px;">Employee</th>
                ${STATS_HEADER_CELLS}
                <th>Entitlement</th>
                <th>Remaining</th>
            </tr>
        `;

        const rowsHtml = employees.map(emp => {
            const months = monthsByEmployee[emp.employee_id];
            if (!months) return '';
            const s = sumMonths(months);
            const entitlement = entitlementByEmployee[emp.employee_id] || 0;
            const remaining = entitlement - s.annualLeaveDays;
            return `
                <tr>
                    <td style="padding-left:20px; font-weight:500; white-space:nowrap;">${emp.first_name} ${emp.last_name}</td>
                    ${statsRowCells(s)}
                    <td style="text-align:center;">${fmt(entitlement)}</td>
                    <td style="text-align:center; font-weight:600; color:${remaining < 0 ? '#dc2626' : '#15803d'};">${fmt(remaining)}</td>
                </tr>
            `;
        }).join('');

        tbody.innerHTML = rowsHtml || `<tr><td colspan="13" style="text-align:center; padding:30px; color:#94a3b8;">No active employees found.</td></tr>`;
    }

    function renderSingleEmployeeView(empId, months, entitlement) {
        if (!months) {
            tbody.innerHTML = `<tr><td colspan="11" style="text-align:center; padding:30px; color:#94a3b8;">No data found.</td></tr>`;
            return;
        }

        thead.innerHTML = `
            <tr>
                <th style="text-align:left; padding-left:20px;">Month</th>
                ${STATS_HEADER_CELLS}
            </tr>
        `;

        const monthRows = months.map((s, i) => `
            <tr>
                <td style="padding-left:20px; font-weight:500;">${MONTH_LABELS[i]}</td>
                ${statsRowCells(s)}
            </tr>
        `).join('');

        const total = sumMonths(months);
        const remaining = entitlement - total.annualLeaveDays;
        const totalRow = `
            <tr style="border-top:2px solid #0f172a; font-weight:700;">
                <td style="padding-left:20px;">Total</td>
                ${statsRowCells(total)}
            </tr>
            <tr>
                <td style="padding-left:20px; color:#64748b; font-weight:500;" colspan="11">
                    Annual Leave Entitlement: ${fmt(entitlement)}d &middot; Taken: ${total.annualLeaveDays}d &middot;
                    Remaining: <strong style="color:${remaining < 0 ? '#dc2626' : '#15803d'};">${fmt(remaining)}d</strong>
                </td>
            </tr>
        `;

        tbody.innerHTML = monthRows + totalRow;
    }

    // ============================================
    // PRINT -- reuses whatever table is currently rendered on-page
    // rather than recomputing, so what prints always matches what's
    // on screen.
    // ============================================
    window.printAnnualReport = function () {
        if (!lastRenderedYear) { alert('Click Generate first.'); return; }

        const printWindow = window.open('', '_blank', 'width=1200,height=700');
        if (!printWindow) { alert('Please allow popups to print.'); return; }

        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Annual Report - ${lastRenderedYear}</title>
                <style>
                    @page { size: landscape; margin: 12mm; }
                    body { font-family: Arial, sans-serif; color: #0f172a; }
                    h1 { margin-bottom: 2px; font-size: 1.3rem; }
                    .subtitle { color: #64748b; margin-top: 0; margin-bottom: 14px; font-size: 0.85rem; }
                    table { border-collapse: collapse; width: 100%; font-size: 0.72rem; }
                    th, td { border: 1px solid #e2e8f0; padding: 4px 6px; }
                    th { background: #f1f5f9; }
                </style>
            </head>
            <body>
                <h1>Annual Attendance &amp; Leave Report</h1>
                <p class="subtitle">${lastRenderedYear} &middot; ${lastRenderedEmployeeName} &middot; Generated ${new Date().toLocaleString()}</p>
                <table>
                    <thead>${thead.innerHTML}</thead>
                    <tbody>${tbody.innerHTML}</tbody>
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
    await loadEmployees();
    loadYears();
    console.log("✅ Annual Report initialized successfully!");
})();

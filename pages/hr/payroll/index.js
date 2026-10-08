// ============================================
// PAYROLL - CALCULATION ENGINE + PAYMENT
// ============================================
// Formulas verified against the worked example given (K6,500 gross ->
// K280 PAYE, K325 NAPSA, K65 NHIMA, K5,830 net) before writing any of
// this. Order of operations: leave deduction reduces Basic Pay first,
// overtime pay is added on top to get Gross, PAYE is calculated on the
// FULL Gross (not reduced by NAPSA/NHIMA first), then NAPSA and NHIMA
// are subtracted to get Net.
//
// SCHEMA THIS FILE NEEDS:
//   payroll_records (new table) -- see the ALTER/CREATE note at the
//   bottom of this comment block for the exact SQL.
// ============================================

(async function initPayrollPage() {
    console.log("Payroll initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    // ============================================
    // 🔥 CHART OF ACCOUNTS
    // ============================================
    const REQUIRED_ACCOUNTS = [
        { code: '6250', name: 'Salary & Wages Expense', type: 'Expense', category: 'Operating Expense', normal_balance: 'Debit' },
        { code: '6260', name: 'Statutory Contributions Expense', type: 'Expense', category: 'Operating Expense', normal_balance: 'Debit' },
        { code: '2150', name: 'PAYE Payable', type: 'Liability', category: 'Current Liability', normal_balance: 'Credit' },
        { code: '2160', name: 'NAPSA Payable', type: 'Liability', category: 'Current Liability', normal_balance: 'Credit' },
        { code: '2170', name: 'NHIMA Payable', type: 'Liability', category: 'Current Liability', normal_balance: 'Credit' },
        { code: '1111', name: 'Cash in Hand (ZMW)', type: 'Asset', category: 'Current Asset', normal_balance: 'Debit' },
        { code: '1121', name: 'Bank - ZMW', type: 'Asset', category: 'Current Asset', normal_balance: 'Debit' }
    ];

    async function ensureChartOfAccounts() {
        try {
            for (const account of REQUIRED_ACCOUNTS) {
                const { data: existing } = await supabaseClient
                    .from('chart_of_accounts').select('code').eq('code', account.code).maybeSingle();
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

    // ============================================
    // STATUTORY RATES (Zambia)
    // ============================================
    const NAPSA_RATE = 0.05;
    const NAPSA_CAP = 1861.80;
    const NHIMA_RATE = 0.01;
    const OVERTIME_DIVISOR = 195; // Basic Pay / 195 = hourly rate

    function calculatePAYE(grossSalary) {
        let tax = 0;
        let remaining = grossSalary;

        const band1 = Math.min(remaining, 5100); remaining -= band1; tax += band1 * 0;
        if (remaining > 0) { const band2 = Math.min(remaining, 2000); remaining -= band2; tax += band2 * 0.20; }
        if (remaining > 0) { const band3 = Math.min(remaining, 2100); remaining -= band3; tax += band3 * 0.30; }
        if (remaining > 0) { tax += remaining * 0.37; }
        return tax;
    }

    let currentBreakdown = null; // cached rows for the selected month, keyed by employee_id
    let paidByEmployee = {}; // who's already paid for the selected month, keyed by employee_id -- shared by renderPayrollTable, Pay All, and Print All Payslips

    // ============================================
    // 🔥 CALCULATE PAYROLL FOR THE SELECTED MONTH
    // ============================================
    window.calculatePayroll = async function () {
        const monthValue = document.getElementById('payrollMonthPicker').value;
        if (!monthValue) { alert('Please pick a month first.'); return; }

        const [year, month] = monthValue.split('-').map(Number);
        const monthStart = new Date(year, month - 1, 1).toISOString().split('T')[0];
        const monthEnd = new Date(year, month, 0).toISOString().split('T')[0];
        const daysInMonth = new Date(year, month, 0).getDate();
        // 🔥 CHANGED: don't consider any month before September 2026
        // (see LEAVE_TRACKING_START in shared-attendance-utils.js) --
        // yearStart used to always be Jan 1.
        const yearStart = effectiveYearStart(year);

        const tbody = document.getElementById('payrollTableBody');
        tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:30px;color:#94a3b8;"><i class="fa-solid fa-spinner fa-spin"></i> Calculating...</td></tr>`;

        const [employeesRes, jobsRes, unpaidLeaveRes, annualLeaveRes, attendanceRes, alreadyPaidRes] = await Promise.all([
            supabaseClient.from('employees').select('employee_id, first_name, last_name').eq('status', 'Active').order('first_name'),
            // bank_name/bank_branch/bank_account_number: not used in the
            // payroll calculation itself, just carried through on each
            // breakdown so the Bank Report/CSV export can read them
            // straight off currentBreakdown without a second query.
            supabaseClient.from('employee_employment').select('employee_id, basic_pay, allowances, is_fixed_pay, annual_leave_days, bank_name, bank_branch, bank_account_number'),
            supabaseClient.from('leave_requests').select('employee_id, start_date, end_date')
                .eq('leave_type', 'Unpaid').eq('status', 'Approved')
                .lte('start_date', monthEnd).gte('end_date', monthStart),
            // 🔥 ADDED: every Approved Annual/Emergency request from the
            // start of the CALENDAR YEAR through the end of this payroll
            // month -- not just this month -- so we can tell how much of
            // the employee's entitlement was already used up before this
            // month started. Mirrors the "Annual + Emergency share one
            // balance" rule from the Leave page (leave/index.js).
            supabaseClient.from('leave_requests').select('employee_id, start_date, end_date')
                .in('leave_type', ['Annual', 'Emergency']).eq('status', 'Approved')
                .lte('start_date', monthEnd).gte('end_date', yearStart),
            supabaseClient.from('employee_attendance').select('employee_id, overtime_hours')
                .gte('attendance_date', monthStart).lte('attendance_date', monthEnd),
            supabaseClient.from('payroll_records').select('employee_id, net_pay, paid_at')
                .eq('pay_period_month', month).eq('pay_period_year', year)
        ]);

        const jobByEmployee = {};
        (jobsRes.data || []).forEach(j => { jobByEmployee[j.employee_id] = j; });

        // Clip each unpaid leave request to days actually within this month
        const unpaidDaysByEmployee = {};
        (unpaidLeaveRes.data || []).forEach(l => {
            let d = new Date(Math.max(new Date(l.start_date), new Date(monthStart)));
            const end = new Date(Math.min(new Date(l.end_date), new Date(monthEnd)));
            let days = 0;
            while (d <= end) { days++; d.setDate(d.getDate() + 1); }
            unpaidDaysByEmployee[l.employee_id] = (unpaidDaysByEmployee[l.employee_id] || 0) + days;
        });

        // 🔥 ADDED: Annual/Emergency leave only deducts salary once the
        // employee has used up their yearly entitlement -- days within
        // the balance are free, same as the Leave page shows them. Walk
        // each approved request day-by-day (clipped to this calendar
        // year through this payroll month) and sort each day into
        // "before this month" vs "within this month" per employee, so we
        // know how much entitlement was already spent walking into this
        // month before deciding how much of THIS month's leave still
        // fits inside what's left of it.
        const annualDaysBeforeMonthByEmployee = {};
        const annualDaysThisMonthByEmployee = {};
        (annualLeaveRes.data || []).forEach(l => {
            let d = new Date(Math.max(new Date(l.start_date), new Date(yearStart)));
            const end = new Date(Math.min(new Date(l.end_date), new Date(monthEnd)));
            while (d <= end) {
                const dateStr = formatDateLocal(d.getFullYear(), d.getMonth(), d.getDate());
                if (dateStr < monthStart) {
                    annualDaysBeforeMonthByEmployee[l.employee_id] = (annualDaysBeforeMonthByEmployee[l.employee_id] || 0) + 1;
                } else {
                    annualDaysThisMonthByEmployee[l.employee_id] = (annualDaysThisMonthByEmployee[l.employee_id] || 0) + 1;
                }
                d.setDate(d.getDate() + 1);
            }
        });

        const overtimeHoursByEmployee = {};
        (attendanceRes.data || []).forEach(a => {
            overtimeHoursByEmployee[a.employee_id] = (overtimeHoursByEmployee[a.employee_id] || 0) + (a.overtime_hours || 0);
        });

        paidByEmployee = {};
        (alreadyPaidRes.data || []).forEach(p => { paidByEmployee[p.employee_id] = p; });

        currentBreakdown = {};

        const rows = (employeesRes.data || []).map(emp => {
            const job = jobByEmployee[emp.employee_id] || {};
            const basicPay = job.basic_pay || 0;
            const allowances = job.allowances || 0;
            const isFixedPay = job.is_fixed_pay ?? true;

            // Fixed employees: no leave deduction, no overtime, ever.
            // Allowances applies to everyone regardless -- it's a fixed
            // pay component unrelated to attendance, same reasoning
            // that exempts Fixed employees from leave/overtime doesn't
            // apply here.
            const explicitUnpaidDays = isFixedPay ? 0 : (unpaidDaysByEmployee[emp.employee_id] || 0);

            // 🔥 ADDED: Annual/Emergency leave only costs salary once the
            // employee has run out of entitlement for the year -- days
            // still within the balance are free, matching what the Leave
            // page already shows as the employee's remaining balance.
            // annualDaysBeforeMonth = how much of the entitlement was
            // already spent walking INTO this month; whatever's left of
            // the entitlement absorbs this month's days first, and only
            // the days beyond that get deducted. annual_leave_days is a
            // FULL YEAR figure -- prorated via entitlementForYear() the
            // same way the Leave page does, so the two pages never
            // disagree on how much entitlement an employee has this year
            // (24 -> 8, 48 -> 16 for 2026's Sep-Dec-only scope).
            const entitlement = entitlementForYear(job.annual_leave_days, year);
            const annualDaysBeforeMonth = isFixedPay ? 0 : (annualDaysBeforeMonthByEmployee[emp.employee_id] || 0);
            const annualDaysThisMonth = isFixedPay ? 0 : (annualDaysThisMonthByEmployee[emp.employee_id] || 0);
            const entitlementLeftAtMonthStart = Math.max(0, entitlement - annualDaysBeforeMonth);
            const unpaidAnnualDays = Math.max(0, annualDaysThisMonth - entitlementLeftAtMonthStart);

            const unpaidDays = explicitUnpaidDays + unpaidAnnualDays;
            const dailyRate = daysInMonth > 0 ? basicPay / daysInMonth : 0;
            const leaveDeduction = dailyRate * unpaidDays;
            const effectiveBasicPay = Math.max(0, basicPay - leaveDeduction);

            const overtimeHours = isFixedPay ? 0 : (overtimeHoursByEmployee[emp.employee_id] || 0);
            const hourlyRate = basicPay / OVERTIME_DIVISOR;
            const overtimePay = overtimeHours * hourlyRate * 1; // straight time, no 1.5x premium

            // 🔥 FIX: Gross was missing Allowances entirely -- Basic Pay
            // was being treated as if it WERE the full Gross Salary,
            // which happened to match the original worked example (no
            // separate allowances in it) but is wrong the moment an
            // employee actually has any. Gross = Basic + Allowances +
            // Overtime, per the original spec.
            const grossSalary = effectiveBasicPay + allowances + overtimePay;
            const paye = calculatePAYE(grossSalary);
            const napsaEmployee = Math.min(grossSalary * NAPSA_RATE, NAPSA_CAP);
            // NHIMA base: ONLY the actual basic pay earned this period --
            // deliberately excludes both Allowances and Overtime, per the
            // original spec ("NHIMA is calculated strictly on Basic Pay,
            // excluding allowances"). Using effectiveBasicPay here (not
            // grossSalary) already achieved this correctly before
            // Allowances existed; still correct now that Allowances is a
            // separate line that never enters this calculation.
            const nhimaEmployee = effectiveBasicPay * NHIMA_RATE;
            const netPay = grossSalary - paye - napsaEmployee - nhimaEmployee;

            // Employer matching contributions -- real additional company
            // expense, not deducted from the employee.
            const napsaEmployer = napsaEmployee;
            const nhimaEmployer = nhimaEmployee;

            const breakdown = {
                employeeId: emp.employee_id, name: `${emp.first_name} ${emp.last_name}`,
                basicPay, allowances, unpaidDays, explicitUnpaidDays, unpaidAnnualDays, leaveDeduction, overtimeHours, overtimePay,
                grossSalary, paye, napsaEmployee, napsaEmployer, nhimaEmployee, nhimaEmployer, netPay,
                daysInMonth, month, year,
                bankName: job.bank_name || '', bankBranch: job.bank_branch || '', bankAccount: job.bank_account_number || ''
            };
            currentBreakdown[emp.employee_id] = breakdown;

            const alreadyPaid = paidByEmployee[emp.employee_id];

            return { breakdown, alreadyPaid };
        });

        renderPayrollTable(rows);
    };

    function formatNumber(num) {
        return (num || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    // 🔥 ADDED: a leave deduction can now come from two different places
    // -- explicit 'Unpaid' leave (always deducted) and Annual/Emergency
    // leave that ran past the employee's yearly entitlement (deducted
    // only once the balance is used up). Spell out which is which
    // instead of a single opaque "Xd unpaid", wherever this shows up
    // (payroll table, payslip, Pay confirmation).
    function unpaidDaysLabel(explicitUnpaidDays, unpaidAnnualDays) {
        const parts = [];
        if (explicitUnpaidDays > 0) parts.push(`${explicitUnpaidDays}d unpaid leave`);
        if (unpaidAnnualDays > 0) parts.push(`${unpaidAnnualDays}d beyond annual leave balance`);
        return parts.join(' + ');
    }

    // ============================================
    // 🔥 ADDED: payroll can only be PROCESSED (actually paid) between
    // the 1st and 5th of each month -- previewing/calculating stays
    // available anytime, only the Pay action itself is gated.
    // ============================================
    function isWithinPayrollWindow() {
        const dayOfMonth = new Date().getDate();
        return dayOfMonth >= 1 && dayOfMonth <= 5;
    }

    function renderPayrollTable(rows) {
        const tbody = document.getElementById('payrollTableBody');
        if (rows.length === 0) {
            tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:30px;color:#94a3b8;">No active employees found.</td></tr>`;
            return;
        }

        const canPay = isWithinPayrollWindow();

        tbody.innerHTML = rows.map(({ breakdown: b, alreadyPaid }) => `
            <tr>
                <td style="padding-left:20px; font-weight:500;">${b.name}</td>
                <td style="text-align:right;">
                    K${formatNumber(b.basicPay)}
                    ${b.allowances > 0 ? `<br><small style="color:#94a3b8;">+K${formatNumber(b.allowances)} allow.</small>` : ''}
                </td>
                <td style="text-align:right; color:${b.leaveDeduction > 0 ? '#dc2626' : '#94a3b8'};">
                    ${b.leaveDeduction > 0 ? '-K' + formatNumber(b.leaveDeduction) : '-'}
                    ${b.unpaidDays > 0 ? `<br><small>${unpaidDaysLabel(b.explicitUnpaidDays, b.unpaidAnnualDays)}</small>` : ''}
                </td>
                <td style="text-align:right; color:${b.overtimePay > 0 ? '#059669' : '#94a3b8'};">
                    ${b.overtimePay > 0 ? '+K' + formatNumber(b.overtimePay) : '-'}
                    ${b.overtimeHours > 0 ? `<br><small>${b.overtimeHours.toFixed(1)}h</small>` : ''}
                </td>
                <td style="text-align:right; font-weight:600;">K${formatNumber(b.grossSalary)}</td>
                <td style="text-align:right;">K${formatNumber(b.paye)}</td>
                <td style="text-align:right;">K${formatNumber(b.napsaEmployee)}</td>
                <td style="text-align:right;">K${formatNumber(b.nhimaEmployee)}</td>
                <td style="text-align:right; font-weight:700; color:#059669;">K${formatNumber(b.netPay)}</td>
                <td style="text-align:center; padding-right:20px;">
                    ${alreadyPaid
                        ? `<span style="background:#dcfce7;color:#15803d;padding:3px 10px;border-radius:10px;font-size:0.75rem;"><i class="fa-solid fa-check"></i> Paid</span>
                           <button class="btn btn-outline btn-sm" style="margin-left:4px;" onclick="printPayslip('${b.employeeId}')" title="Print payslip"><i class="fa-solid fa-print"></i></button>`
                        : canPay
                            ? `<button class="btn btn-success btn-sm" onclick="openPayConfirm('${b.employeeId}')">Pay</button>`
                            : `<button class="btn btn-sm" disabled title="Salary payments can only be processed between the 1st and 5th of the month" style="background:#e2e8f0; color:#94a3b8; cursor:not-allowed;">Pay</button>`
                    }
                </td>
            </tr>
        `).join('');
    }

    // ============================================
    // 🔥 ADDED: PRINT PAYSLIP
    // ============================================
    // Pulls from the saved payroll_records row, not the live in-memory
    // breakdown -- if attendance or leave data changed after payment,
    // a fresh Calculate would show different numbers than what was
    // actually paid. The payslip must always reflect what was actually
    // recorded and paid, not a recalculation.
    // 🔥 Shared payslip markup -- one employee's slip content (no
    // <html>/<head>/print-script wrapper), used by both printPayslip
    // (one employee, popup prints immediately) and printAllPayslips
    // (many employees, one popup, one slip per printed page). Keeping
    // this in one place means the two print paths can never drift apart
    // in what a payslip actually shows.
    function buildPayslipBlockHtml(emp, r, advanceDeducted, netBeforeAdvance, monthLabel, paidFromLabel) {
        return `
            <h1>Payslip</h1>
            <p class="subtitle">${monthLabel} &middot; ${emp.first_name} ${emp.last_name}${emp.employee_code ? ' (' + emp.employee_code + ')' : ''} &middot; Paid ${new Date(r.paid_at).toLocaleDateString()} via ${paidFromLabel}</p>

            <div class="section-title">Earnings</div>
            <div class="row"><span>Basic Pay</span><span>K${formatNumber(r.basic_pay)}</span></div>
            ${r.allowances > 0 ? `<div class="row"><span>Allowances</span><span>K${formatNumber(r.allowances)}</span></div>` : ''}
            ${r.leave_deduction > 0 ? `<div class="row neg"><span>Leave Deduction (${unpaidDaysLabel(r.unpaid_leave_days - (r.unpaid_annual_leave_days || 0), r.unpaid_annual_leave_days || 0)})</span><span>-K${formatNumber(r.leave_deduction)}</span></div>` : ''}
            ${r.overtime_pay > 0 ? `<div class="row pos"><span>Overtime (${Number(r.overtime_hours).toFixed(1)}h)</span><span>+K${formatNumber(r.overtime_pay)}</span></div>` : ''}
            <div class="row total"><span>Gross Salary</span><span>K${formatNumber(r.gross_salary)}</span></div>

            <div class="section-title">Statutory Deductions</div>
            <div class="row neg"><span>PAYE</span><span>-K${formatNumber(r.paye)}</span></div>
            <div class="row neg"><span>NAPSA</span><span>-K${formatNumber(r.napsa)}</span></div>
            <div class="row neg"><span>NHIMA</span><span>-K${formatNumber(r.nhima)}</span></div>

            ${advanceDeducted > 0 ? `
            <div class="row total" style="border-top:1px solid #e2e8f0; font-size:1rem;"><span>Net Pay (before advance)</span><span>K${formatNumber(netBeforeAdvance)}</span></div>
            <div class="section-title">Advance Recovery</div>
            <div class="row neg"><span>Salary Advance Deduction</span><span>-K${formatNumber(advanceDeducted)}</span></div>
            ` : ''}

            <div class="row total"><span>Net Pay (Take-Home)</span><span>K${formatNumber(r.net_pay)}</span></div>

            <p style="margin-top:30px; font-size:0.7rem; color:#94a3b8;">This is a system-generated payslip.</p>
        `;
    }

    window.printPayslip = async function (employeeId) {
        const cached = currentBreakdown[employeeId];
        if (!cached) return;

        const [empRes, recordRes] = await Promise.all([
            supabaseClient.from('employees').select('first_name, last_name, employee_code').eq('employee_id', employeeId).maybeSingle(),
            supabaseClient.from('payroll_records').select('*')
                .eq('employee_id', employeeId)
                .eq('pay_period_month', cached.month)
                .eq('pay_period_year', cached.year)
                .maybeSingle()
        ]);

        if (!recordRes.data) {
            alert('No saved payroll record found for this employee/month.');
            return;
        }

        const r = recordRes.data;
        const emp = empRes.data || {};

        // 🔥 ADDED: look up any advance deduction linked to this specific
        // payroll record, so the payslip shows why take-home was reduced
        // rather than just a smaller net pay with no explanation.
        const { data: recovery } = await supabaseClient
            .from('advance_recoveries').select('amount')
            .eq('payroll_record_id', r.id).eq('method', 'Payroll Deduction').maybeSingle();
        const advanceDeducted = recovery?.amount || 0;
        const netBeforeAdvance = r.net_pay + advanceDeducted;

        const monthLabel = new Date(r.pay_period_year, r.pay_period_month - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        const paidFromLabel = r.paid_from === '1121' ? 'Bank (ZMW)' : 'Cash in Hand (ZMW)';

        const printWindow = window.open('', '_blank', 'width=700,height=800');
        if (!printWindow) { alert('Please allow popups to print.'); return; }

        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Payslip - ${emp.first_name} ${emp.last_name} - ${monthLabel}</title>
                <style>
                    body { font-family: Arial, sans-serif; padding: 30px; color: #0f172a; max-width: 600px; margin: 0 auto; }
                    h1 { font-size: 1.3rem; margin-bottom: 2px; }
                    .subtitle { color: #64748b; margin-top: 0; margin-bottom: 20px; font-size: 0.85rem; }
                    .row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #f1f5f9; }
                    .row.total { border-top: 2px solid #0f172a; border-bottom: none; font-weight: 700; font-size: 1.1rem; padding-top: 10px; margin-top: 6px; }
                    .section-title { font-weight: 600; margin-top: 18px; margin-bottom: 4px; color: #475569; font-size: 0.8rem; text-transform: uppercase; }
                    .neg { color: #dc2626; }
                    .pos { color: #059669; }
                </style>
            </head>
            <body>
                ${buildPayslipBlockHtml(emp, r, advanceDeducted, netBeforeAdvance, monthLabel, paidFromLabel)}
                <script>window.onload = function() { window.print(); };<\/script>
            </body>
            </html>
        `);
        printWindow.document.close();
    };

    // ============================================
    // 🔥 ADDED: PRINT ALL PAYSLIPS -- one print job covering every paid
    // employee for the selected month: a one-page payroll register
    // (salary printout) summarizing everyone, followed by each
    // employee's individual payslip (same markup as printPayslip, via
    // buildPayslipBlockHtml) on its own page. Called automatically right
    // after a successful "Pay All" run, and also available as its own
    // button for reprinting any month that already has paid employees.
    //
    // employeeIds: optional array to restrict to specific employees
    // (used by confirmPayAll for "just the batch I paid"). Without it,
    // prints every employee currently on record as paid for the
    // selected month.
    // ============================================
    window.printAllPayslips = async function (employeeIds) {
        if (!currentBreakdown) { alert('Pick a month and click Calculate first.'); return; }

        const ids = employeeIds && employeeIds.length ? employeeIds : Object.keys(paidByEmployee);
        if (ids.length === 0) {
            alert('No paid employees found for this month yet.');
            return;
        }

        const [year, month] = (() => {
            const first = currentBreakdown[ids[0]] || Object.values(currentBreakdown)[0];
            return [first.year, first.month];
        })();

        const [empRes, recordsRes, recoveriesRes] = await Promise.all([
            supabaseClient.from('employees').select('employee_id, first_name, last_name, employee_code').in('employee_id', ids),
            supabaseClient.from('payroll_records').select('*')
                .in('employee_id', ids).eq('pay_period_month', month).eq('pay_period_year', year),
            supabaseClient.from('advance_recoveries').select('payroll_record_id, amount, method').eq('method', 'Payroll Deduction')
        ]);

        const empById = {};
        (empRes.data || []).forEach(e => { empById[e.employee_id] = e; });

        const recoveryByRecordId = {};
        (recoveriesRes.data || []).forEach(rec => { recoveryByRecordId[rec.payroll_record_id] = rec.amount; });

        const records = (recordsRes.data || []).filter(r => empById[r.employee_id]);
        if (records.length === 0) {
            alert('No saved payroll records found for the selected employees/month.');
            return;
        }

        const monthLabel = new Date(year, month - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        const paidFromLabel = code => code === '1121' ? 'Bank (ZMW)' : 'Cash in Hand (ZMW)';

        // Keep register + slips in the same stable order as the payroll table.
        records.sort((a, b) => (empById[a.employee_id]?.first_name || '').localeCompare(empById[b.employee_id]?.first_name || ''));

        const totalNet = records.reduce((s, r) => s + (r.net_pay || 0), 0);
        const registerRows = records.map(r => {
            const emp = empById[r.employee_id] || {};
            return `
                <tr>
                    <td style="padding:4px 8px;">${emp.first_name || ''} ${emp.last_name || ''}</td>
                    <td style="text-align:right;">K${formatNumber(r.basic_pay)}</td>
                    <td style="text-align:right;">K${formatNumber(r.gross_salary)}</td>
                    <td style="text-align:right;">K${formatNumber(r.paye)}</td>
                    <td style="text-align:right;">K${formatNumber(r.napsa)}</td>
                    <td style="text-align:right;">K${formatNumber(r.nhima)}</td>
                    <td style="text-align:right; font-weight:600;">K${formatNumber(r.net_pay)}</td>
                    <td>${r.paid_at ? new Date(r.paid_at).toLocaleDateString() : ''}</td>
                </tr>
            `;
        }).join('');

        const slipBlocks = records.map(r => {
            const emp = empById[r.employee_id] || {};
            const advanceDeducted = recoveryByRecordId[r.id] || 0;
            const netBeforeAdvance = r.net_pay + advanceDeducted;
            return `<div class="slip-page">${buildPayslipBlockHtml(emp, r, advanceDeducted, netBeforeAdvance, monthLabel, paidFromLabel(r.paid_from))}</div>`;
        }).join('');

        const printWindow = window.open('', '_blank', 'width=900,height=800');
        if (!printWindow) { alert('Please allow popups to print.'); return; }

        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Payroll Register &amp; Payslips - ${monthLabel}</title>
                <style>
                    @page { margin: 12mm; }
                    body { font-family: Arial, sans-serif; color: #0f172a; }
                    h1 { font-size: 1.3rem; margin-bottom: 2px; }
                    .subtitle { color: #64748b; margin-top: 0; margin-bottom: 16px; font-size: 0.85rem; }
                    table { border-collapse: collapse; width: 100%; font-size: 0.75rem; margin-bottom: 10px; }
                    th, td { border: 1px solid #e2e8f0; padding: 4px 6px; }
                    th { background: #f1f5f9; text-align: right; }
                    th:first-child, td:first-child { text-align: left; }
                    tfoot td { font-weight: 700; border-top: 2px solid #0f172a; }

                    .register-page { page-break-after: always; }
                    .slip-page { max-width: 600px; margin: 0 auto; page-break-after: always; }
                    .slip-page:last-child { page-break-after: auto; }
                    .slip-page h1 { font-size: 1.3rem; margin-bottom: 2px; }
                    .slip-page .subtitle { margin-bottom: 20px; }
                    .row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #f1f5f9; }
                    .row.total { border-top: 2px solid #0f172a; border-bottom: none; font-weight: 700; font-size: 1.1rem; padding-top: 10px; margin-top: 6px; }
                    .section-title { font-weight: 600; margin-top: 18px; margin-bottom: 4px; color: #475569; font-size: 0.8rem; text-transform: uppercase; }
                    .neg { color: #dc2626; }
                    .pos { color: #059669; }
                </style>
            </head>
            <body>
                <div class="register-page">
                    <h1>Payroll Register</h1>
                    <p class="subtitle">${monthLabel} &middot; ${records.length} employee(s) &middot; Generated ${new Date().toLocaleString()}</p>
                    <table>
                        <thead>
                            <tr>
                                <th style="text-align:left;">Employee</th>
                                <th>Basic Pay</th><th>Gross</th><th>PAYE</th><th>NAPSA</th><th>NHIMA</th><th>Net Pay</th><th style="text-align:left;">Paid</th>
                            </tr>
                        </thead>
                        <tbody>${registerRows}</tbody>
                        <tfoot>
                            <tr><td colspan="6" style="text-align:right;">Total Net Pay</td><td style="text-align:right;">K${formatNumber(totalNet)}</td><td></td></tr>
                        </tfoot>
                    </table>
                </div>
                ${slipBlocks}
                <script>window.onload = function() { window.print(); };<\/script>
            </body>
            </html>
        `);
        printWindow.document.close();
    };

    // ============================================
    // 🔥 ADDED: BANK REPORT -- the batch-payment list handed/uploaded to
    // the bank so it can pay everyone's salary in one go: Employee,
    // Bank, Branch, Account Number, Net Pay. Deliberately reads straight
    // off currentBreakdown (the live Calculate result), NOT saved
    // payroll_records like Print All Payslips does -- this report's job
    // is to be the INSTRUCTION you hand the bank before paying, not a
    // receipt of having already paid, so it has to work before Pay All
    // has even run. bank_name/bank_branch/bank_account_number ride along
    // on every breakdown already (see the employee_employment select in
    // calculatePayroll), so no extra query is needed here.
    //
    // Rows with K0 net pay are skipped outright (nothing to submit for
    // them); rows missing bank details are still INCLUDED (so nobody's
    // pay silently disappears from the report) but visibly flagged --
    // better to catch it here than have the bank reject the batch.
    // ============================================
    function bankReportRows() {
        if (!currentBreakdown) return null;
        return Object.values(currentBreakdown)
            .filter(b => b.netPay > 0)
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    window.printBankReport = function () {
        const rows = bankReportRows();
        if (!rows) { alert('Pick a month and click Calculate first.'); return; }
        if (rows.length === 0) { alert('No employees with a net pay amount for this month yet.'); return; }

        const { month, year } = rows[0];
        const monthLabel = new Date(year, month - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        const missingCount = rows.filter(r => !r.bankName || !r.bankAccount).length;
        const totalNet = rows.reduce((s, r) => s + r.netPay, 0);

        const rowsHtml = rows.map(r => {
            const missing = !r.bankName || !r.bankAccount;
            return `
                <tr style="${missing ? 'background:#fef2f2;' : ''}">
                    <td style="padding:4px 8px;">${r.name}${missing ? ' <span style="color:#dc2626; font-weight:600;">⚠ missing bank details</span>' : ''}</td>
                    <td>${r.bankName || '-'}</td>
                    <td>${r.bankBranch || '-'}</td>
                    <td>${r.bankAccount || '-'}</td>
                    <td style="text-align:right; font-weight:600;">K${formatNumber(r.netPay)}</td>
                </tr>
            `;
        }).join('');

        const printWindow = window.open('', '_blank', 'width=1000,height=700');
        if (!printWindow) { alert('Please allow popups to print.'); return; }

        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Bank Payment Report - ${monthLabel}</title>
                <style>
                    @page { margin: 12mm; }
                    body { font-family: Arial, sans-serif; color: #0f172a; }
                    h1 { font-size: 1.3rem; margin-bottom: 2px; }
                    .subtitle { color: #64748b; margin-top: 0; margin-bottom: 10px; font-size: 0.85rem; }
                    .warn { color: #dc2626; font-size: 0.8rem; margin-bottom: 14px; }
                    table { border-collapse: collapse; width: 100%; font-size: 0.8rem; }
                    th, td { border: 1px solid #e2e8f0; padding: 5px 8px; }
                    th { background: #f1f5f9; text-align: left; }
                    tfoot td { font-weight: 700; border-top: 2px solid #0f172a; text-align: right; }
                </style>
            </head>
            <body>
                <h1>Bank Payment Report</h1>
                <p class="subtitle">${monthLabel} &middot; ${rows.length} employee(s) &middot; Generated ${new Date().toLocaleString()}</p>
                ${missingCount > 0 ? `<p class="warn">⚠ ${missingCount} employee(s) below are missing bank details -- add them in Employee Management before submitting this to the bank.</p>` : ''}
                <table>
                    <thead>
                        <tr><th>Employee</th><th>Bank</th><th>Branch</th><th>Account Number</th><th style="text-align:right;">Net Pay</th></tr>
                    </thead>
                    <tbody>${rowsHtml}</tbody>
                    <tfoot>
                        <tr><td colspan="4">Total</td><td>K${formatNumber(totalNet)}</td></tr>
                    </tfoot>
                </table>
                <script>window.onload = function() { window.print(); };<\/script>
            </body>
            </html>
        `);
        printWindow.document.close();
    };

    // 🔥 ADDED: same data as printBankReport, as a downloadable CSV --
    // most banks' bulk/batch salary upload accepts (or can be matched
    // to) a plain CSV of name/account/amount, which is far more useful
    // for actually SUBMITTING a payment than a printed page someone
    // would have to retype.
    window.exportBankReportCsv = function () {
        const rows = bankReportRows();
        if (!rows) { alert('Pick a month and click Calculate first.'); return; }
        if (rows.length === 0) { alert('No employees with a net pay amount for this month yet.'); return; }

        const { month, year } = rows[0];

        // Excel/most bank portals expect a comma-separated value to be
        // quoted, and a literal quote inside a value doubled -- names are
        // free text and could in principle contain either.
        const csvField = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const header = ['Employee Name', 'Bank Name', 'Branch / Sort Code', 'Account Number', 'Amount (ZMW)'];
        const lines = [header.map(csvField).join(',')];
        rows.forEach(r => {
            lines.push([r.name, r.bankName, r.bankBranch, r.bankAccount, r.netPay.toFixed(2)].map(csvField).join(','));
        });

        const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `bank-payment-${year}-${String(month).padStart(2, '0')}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    };

    // ============================================
    // 🔥 ADDED: STATUTORY PAYMENTS -- what's owed to ZRA/NAPSA/NHIMA,
    // computed directly from the liability accounts' actual journal
    // activity (credits from payroll runs minus debits from payments
    // already made), not a separately-tracked number that could drift
    // out of sync with the real ledger.
    // ============================================
    const STATUTORY_ACCOUNTS = [
        { code: '2150', name: 'PAYE', authority: 'ZRA', color: '#2563eb' },
        { code: '2160', name: 'NAPSA', authority: 'NAPSA', color: '#8b5cf6' },
        { code: '2170', name: 'NHIMA', authority: 'NHIMA', color: '#0891b2' }
    ];

    async function loadStatutoryPayments() {
        const grid = document.getElementById('statutoryPaymentsGrid');
        if (!grid) return;

        const { data: lines, error } = await supabaseClient
            .from('journal_lines')
            .select('account_code, debit, credit')
            .in('account_code', STATUTORY_ACCOUNTS.map(a => a.code));

        if (error) {
            grid.innerHTML = `<div style="grid-column:1/-1; text-align:center; color:#dc2626; padding:20px;">Error loading balances.</div>`;
            return;
        }

        const balances = {};
        STATUTORY_ACCOUNTS.forEach(a => { balances[a.code] = 0; });
        (lines || []).forEach(l => {
            if (balances[l.account_code] === undefined) return;
            balances[l.account_code] += (l.credit || 0) - (l.debit || 0);
        });

        grid.innerHTML = STATUTORY_ACCOUNTS.map(a => {
            const owed = Math.max(0, balances[a.code]);
            return `
                <div style="text-align:center; padding:16px; background:#f8fafc; border-radius:8px; border-left:4px solid ${a.color};">
                    <div style="font-size:0.75rem; color:#64748b; text-transform:uppercase; margin-bottom:4px;">${a.name} owed to ${a.authority}</div>
                    <div style="font-size:1.4rem; font-weight:700; margin-bottom:10px;">K${formatNumber(owed)}</div>
                    ${owed > 0.01
                        ? `<button class="btn btn-primary btn-sm" onclick="openPayStatutory('${a.code}', '${a.name}', '${a.authority}', ${owed})">Pay</button>`
                        : `<span style="font-size:0.75rem; color:#94a3b8;"><i class="fa-solid fa-check"></i> Nothing owed</span>`
                    }
                </div>
            `;
        }).join('');
    }

    window.openPayStatutory = function (accountCode, name, authority, owed) {
        document.getElementById('payStatutoryTitle').innerHTML = `<i class="fa-solid fa-landmark" style="color:#8b5cf6;"></i> Pay ${name} to ${authority}`;
        document.getElementById('statutoryPayAmount').value = owed.toFixed(2);
        document.getElementById('statutoryOutstandingNote').textContent = `Outstanding: K${formatNumber(owed)}`;
        document.getElementById('payStatutoryModal').dataset.accountCode = accountCode;
        document.getElementById('payStatutoryModal').dataset.name = name;
        document.getElementById('payStatutoryModal').style.display = 'flex';
    };

    window.confirmStatutoryPayment = async function () {
        const modal = document.getElementById('payStatutoryModal');
        const accountCode = modal.dataset.accountCode;
        const name = modal.dataset.name;
        const amount = parseFloat(document.getElementById('statutoryPayAmount').value);
        const paidFrom = document.getElementById('statutoryPayFrom').value;

        if (!amount || amount <= 0) { alert('Enter a valid amount.'); return; }

        const btn = document.getElementById('confirmStatutoryPayBtn');
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';

        try {
            const journal = {
                entry_date: new Date().toISOString().split('T')[0],
                reference: `STAT-${accountCode}-${Date.now().toString().slice(-6)}`,
                description: `${name} payment`,
                journal_number: `ST-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
                status: 'Posted',
                created_at: new Date().toISOString()
            };
            const { data: journalData, error: jError } = await supabaseClient.from('journal_entries').insert([journal]).select();
            if (jError) throw jError;

            const lines = [
                { journal_entry_id: journalData[0].id, account_code: accountCode, description: `${name} paid`, debit: amount, credit: 0 },
                { journal_entry_id: journalData[0].id, account_code: paidFrom, description: `${name} paid`, debit: 0, credit: amount }
            ];
            const { error: lineError } = await supabaseClient.from('journal_lines').insert(lines);
            if (lineError) throw lineError;

            modal.style.display = 'none';
            alert(`✅ K${formatNumber(amount)} paid for ${name}.`);
            await loadStatutoryPayments();
        } catch (error) {
            alert('Error processing statutory payment: ' + error.message);
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-check"></i> Confirm Payment';
        }
    };

    // ============================================
    // PAY CONFIRMATION
    // ============================================
    window.openPayConfirm = async function (employeeId) {
        // 🔥 Defense in depth -- the button is disabled outside the
        // window already, but this guards against the function being
        // triggered any other way (e.g. directly via console).
        if (!isWithinPayrollWindow()) {
            alert('Salary payments can only be processed between the 1st and 5th of the month.');
            return;
        }

        const b = currentBreakdown[employeeId];
        if (!b) return;

        document.getElementById('payConfirmTitle').innerHTML = `<i class="fa-solid fa-money-check-dollar" style="color:#059669;"></i> Pay ${b.name}`;
        document.getElementById('payConfirmBreakdown').innerHTML = `
            <div style="display:flex; justify-content:space-between; padding:4px 0;"><span>Basic Pay</span><span>K${formatNumber(b.basicPay)}</span></div>
            ${b.allowances > 0 ? `<div style="display:flex; justify-content:space-between; padding:4px 0;"><span>Allowances</span><span>K${formatNumber(b.allowances)}</span></div>` : ''}
            ${b.leaveDeduction > 0 ? `<div style="display:flex; justify-content:space-between; padding:4px 0; color:#dc2626;"><span>Leave Deduction (${unpaidDaysLabel(b.explicitUnpaidDays, b.unpaidAnnualDays)})</span><span>-K${formatNumber(b.leaveDeduction)}</span></div>` : ''}
            ${b.overtimePay > 0 ? `<div style="display:flex; justify-content:space-between; padding:4px 0; color:#059669;"><span>Overtime (${b.overtimeHours.toFixed(1)}h)</span><span>+K${formatNumber(b.overtimePay)}</span></div>` : ''}
            <div style="display:flex; justify-content:space-between; padding:4px 0; font-weight:600; border-top:1px solid #e2e8f0; margin-top:4px;"><span>Gross Salary</span><span>K${formatNumber(b.grossSalary)}</span></div>
            <div style="display:flex; justify-content:space-between; padding:4px 0; color:#dc2626;"><span>PAYE</span><span>-K${formatNumber(b.paye)}</span></div>
            <div style="display:flex; justify-content:space-between; padding:4px 0; color:#dc2626;"><span>NAPSA</span><span>-K${formatNumber(b.napsaEmployee)}</span></div>
            <div style="display:flex; justify-content:space-between; padding:4px 0; color:#dc2626;"><span>NHIMA</span><span>-K${formatNumber(b.nhimaEmployee)}</span></div>
            <div style="display:flex; justify-content:space-between; padding:6px 0; font-weight:700; font-size:1.1rem; border-top:2px solid #0f172a; margin-top:4px; color:#059669;"><span>Net Pay</span><span>K${formatNumber(b.netPay)}</span></div>
        `;

        // 🔥 ADDED: fetch outstanding advance balance for this employee --
        // opening_advance + approved advance_requests - all recoveries.
        const [empRes, requestsRes, recoveriesRes] = await Promise.all([
            supabaseClient.from('employees').select('opening_advance').eq('employee_id', employeeId).maybeSingle(),
            supabaseClient.from('advance_requests').select('amount').eq('employee_id', employeeId).eq('status', 'Approved'),
            supabaseClient.from('advance_recoveries').select('amount').eq('employee_id', employeeId)
        ]);
        const openingAdvance = empRes.data?.opening_advance || 0;
        const approvedTotal = (requestsRes.data || []).reduce((s, r) => s + (r.amount || 0), 0);
        const recoveredTotal = (recoveriesRes.data || []).reduce((s, r) => s + (r.amount || 0), 0);
        const outstanding = openingAdvance + approvedTotal - recoveredTotal;

        const advanceSection = document.getElementById('payAdvanceSection');
        const deductionInput = document.getElementById('payAdvanceDeduction');
        deductionInput.value = 0;
        if (outstanding > 0.01) {
            const maxDeduction = Math.min(outstanding, b.netPay);
            advanceSection.style.display = 'block';
            deductionInput.max = maxDeduction.toFixed(2);
            document.getElementById('payAdvanceOutstandingNote').textContent = `Outstanding advance: K${formatNumber(outstanding)} (max deductible this payment: K${formatNumber(maxDeduction)})`;
        } else {
            advanceSection.style.display = 'none';
        }

        document.getElementById('payConfirmModal').dataset.employeeId = employeeId;
        document.getElementById('payConfirmModal').dataset.outstandingAdvance = outstanding;
        document.getElementById('payConfirmModal').style.display = 'flex';
    };

    // ============================================
    // 🔥 CORE PAY LOGIC -- shared by the single-employee "Pay" button
    // (confirmPayEmployee, below) and the "Pay All" bulk action
    // (confirmPayAll, further down). Does the actual DB writes for ONE
    // employee and returns a result object; it touches no DOM, shows no
    // alert, and does not refresh the table -- callers do that once,
    // after either one employee or the whole batch is done, instead of
    // after every single row.
    //
    // NOTE: not wrapped in a DB transaction (the underlying client
    // doesn't expose one here) -- journal_entries, journal_lines,
    // payroll_records and advance_recoveries are written as separate
    // sequential inserts. If one fails partway through, earlier inserts
    // for THIS employee already committed; callers get an error back but
    // nothing here rolls itself back. This was true before this refactor
    // too (see git history), just now shared by both call sites instead
    // of duplicated.
    // ============================================
    async function processEmployeePay(employeeId, { advanceDeduction = 0, paidFrom }) {
        const b = currentBreakdown[employeeId];
        if (!b) return { success: false, error: new Error('No breakdown cached for this employee -- run Calculate first.') };

        try {
            // ---- POST THE JOURNAL ENTRY ----
            // Debit: Salary Expense (gross) + Statutory Contributions
            //   Expense (employer NAPSA + employer NHIMA)
            // Credit: PAYE/NAPSA/NHIMA Payable (statutory total = employee
            //   + employer portions) + Cash/Bank (net pay MINUS any
            //   advance deduction) + Employee Advances (the deducted
            //   portion, if any -- reduces the asset instead of paying it
            //   out as cash). Total credits still equal net pay + payables
            //   regardless of how the cash-vs-advance split works out.
            // Verified balanced against the worked example before writing
            // any of this code.
            const journal = {
                entry_date: new Date().toISOString().split('T')[0],
                reference: `PAYROLL-${b.year}-${String(b.month).padStart(2, '0')}-${employeeId.slice(0, 8)}`,
                description: `Payroll: ${b.name} - ${b.year}-${String(b.month).padStart(2, '0')}`,
                journal_number: `PR-${b.year}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
                status: 'Posted',
                created_at: new Date().toISOString()
            };
            const { data: journalData, error: jError } = await supabaseClient.from('journal_entries').insert([journal]).select();
            if (jError) throw jError;

            const statutoryExpense = b.napsaEmployer + b.nhimaEmployer;
            const cashPortion = b.netPay - advanceDeduction;

            const lines = [
                { journal_entry_id: journalData[0].id, account_code: '6250', description: `Gross salary: ${b.name}`, debit: b.grossSalary, credit: 0 },
                { journal_entry_id: journalData[0].id, account_code: '6260', description: `Employer NAPSA+NHIMA: ${b.name}`, debit: statutoryExpense, credit: 0 },
                { journal_entry_id: journalData[0].id, account_code: '2150', description: `PAYE withheld: ${b.name}`, debit: 0, credit: b.paye },
                { journal_entry_id: journalData[0].id, account_code: '2160', description: `NAPSA (employee+employer): ${b.name}`, debit: 0, credit: b.napsaEmployee + b.napsaEmployer },
                { journal_entry_id: journalData[0].id, account_code: '2170', description: `NHIMA (employee+employer): ${b.name}`, debit: 0, credit: b.nhimaEmployee + b.nhimaEmployer },
                { journal_entry_id: journalData[0].id, account_code: paidFrom, description: `Net pay: ${b.name}`, debit: 0, credit: cashPortion }
            ];
            if (advanceDeduction > 0) {
                lines.push({ journal_entry_id: journalData[0].id, account_code: '1300', description: `Advance recovered from salary: ${b.name}`, debit: 0, credit: advanceDeduction });
            }
            const { error: lineError } = await supabaseClient.from('journal_lines').insert(lines);
            if (lineError) throw lineError;

            // ---- SAVE THE PAYROLL RECORD ----
            const { data: sessionData } = await supabaseClient.auth.getSession();
            const { data: recordData, error: recordError } = await supabaseClient.from('payroll_records').insert([{
                employee_id: employeeId,
                pay_period_month: b.month,
                pay_period_year: b.year,
                basic_pay: b.basicPay,
                allowances: b.allowances,
                unpaid_leave_days: b.unpaidDays,
                unpaid_annual_leave_days: b.unpaidAnnualDays,
                leave_deduction: b.leaveDeduction,
                overtime_hours: b.overtimeHours,
                overtime_pay: b.overtimePay,
                gross_salary: b.grossSalary,
                paye: b.paye,
                napsa: b.napsaEmployee,
                nhima: b.nhimaEmployee,
                net_pay: cashPortion,
                paid_from: paidFrom,
                paid_at: new Date().toISOString(),
                paid_by: sessionData?.session?.user?.id || null
            }]).select();
            if (recordError) throw recordError;

            // 🔥 ADDED: record the advance recovery, linked back to this
            // payroll record.
            if (advanceDeduction > 0) {
                const { error: recoveryError } = await supabaseClient.from('advance_recoveries').insert([{
                    employee_id: employeeId, amount: advanceDeduction, method: 'Payroll Deduction',
                    recovered_at: new Date().toISOString(), recorded_by: sessionData?.session?.user?.id || null,
                    payroll_record_id: recordData[0].id
                }]);
                if (recoveryError) throw recoveryError;
            }

            return { success: true, cashPortion, name: b.name };
        } catch (error) {
            console.error(`Error processing payment for ${b.name}:`, error);
            return { success: false, error, name: b.name };
        }
    }

    window.confirmPayEmployee = async function () {
        const employeeId = document.getElementById('payConfirmModal').dataset.employeeId;
        const outstandingAdvance = parseFloat(document.getElementById('payConfirmModal').dataset.outstandingAdvance) || 0;
        const b = currentBreakdown[employeeId];
        if (!b) return;

        // 🔥 ADDED: advance deduction -- validated against both the
        // outstanding balance and net pay, so it's never possible to
        // deduct more than either allows.
        const advanceDeduction = parseFloat(document.getElementById('payAdvanceDeduction').value) || 0;
        if (advanceDeduction > outstandingAdvance) {
            alert(`Cannot deduct more than the outstanding advance (K${formatNumber(outstandingAdvance)}).`);
            return;
        }
        if (advanceDeduction > b.netPay) {
            alert(`Cannot deduct more than the net pay (K${formatNumber(b.netPay)}).`);
            return;
        }

        const paidFrom = document.getElementById('payFromAccount').value;
        const btn = document.getElementById('confirmPayBtn');
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';

        try {
            await ensureChartOfAccounts();
            const result = await processEmployeePay(employeeId, { advanceDeduction, paidFrom });
            if (!result.success) throw result.error;

            document.getElementById('payConfirmModal').style.display = 'none';
            alert(`✅ ${b.name} paid K${formatNumber(result.cashPortion)} net${advanceDeduction > 0 ? ` (K${formatNumber(advanceDeduction)} recovered from advance)` : ''}.`);
            await window.calculatePayroll();
            await loadStatutoryPayments();
        } catch (error) {
            console.error('Error processing payment:', error);
            alert('Error processing payment: ' + error.message);
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-check"></i> Confirm Payment';
        }
    };

    // ============================================
    // 🔥 ADDED: PAY ALL -- pays every employee for the selected month
    // who isn't already paid, in one action. Reuses processEmployeePay
    // per employee (same journal/payroll_records writes as the
    // individual Pay button, same isWithinPayrollWindow gate), looped
    // SEQUENTIALLY rather than in parallel -- these are real accounting
    // writes and running them concurrently would race on
    // ensureChartOfAccounts and make a partial-failure harder to reason
    // about. Advance deductions are NOT handled here by design: an
    // employee with an outstanding advance still needs the individual
    // "Pay" button so someone decides the deduction amount for them --
    // the "Pay All" confirmation modal says this explicitly. The
    // per-employee Pay button keeps working exactly as before; this is
    // purely additive.
    // ============================================
    window.openPayAllConfirm = function () {
        if (!currentBreakdown) { alert('Pick a month and click Calculate first.'); return; }
        if (!isWithinPayrollWindow()) {
            alert('Salary payments can only be processed between the 1st and 5th of the month.');
            return;
        }

        const unpaidIds = Object.keys(currentBreakdown).filter(id => !paidByEmployee[id]);
        if (unpaidIds.length === 0) {
            alert('Everyone for this month is already paid.');
            return;
        }

        const totalNet = unpaidIds.reduce((sum, id) => sum + currentBreakdown[id].netPay, 0);

        document.getElementById('payAllSummary').innerHTML = `
            <div style="display:flex; justify-content:space-between; padding:4px 0;"><span>Employees to pay</span><span style="font-weight:600;">${unpaidIds.length}</span></div>
            <div style="display:flex; justify-content:space-between; padding:6px 0; font-weight:700; font-size:1.1rem; border-top:2px solid #0f172a; margin-top:4px; color:#059669;"><span>Total Net Pay</span><span>K${formatNumber(totalNet)}</span></div>
        `;
        document.getElementById('payAllConfirmModal').dataset.employeeIds = JSON.stringify(unpaidIds);
        document.getElementById('payAllProgress').style.display = 'none';
        document.getElementById('payAllProgress').innerHTML = '';
        document.getElementById('payAllConfirmModal').style.display = 'flex';
    };

    window.confirmPayAll = async function () {
        const modal = document.getElementById('payAllConfirmModal');
        const employeeIds = JSON.parse(modal.dataset.employeeIds || '[]');
        if (employeeIds.length === 0) return;

        // Defense in depth, same reasoning as openPayConfirm/openPayAllConfirm.
        if (!isWithinPayrollWindow()) {
            alert('Salary payments can only be processed between the 1st and 5th of the month.');
            modal.style.display = 'none';
            return;
        }

        const paidFrom = document.getElementById('payAllFromAccount').value;
        const confirmBtn = document.getElementById('confirmPayAllBtn');
        const cancelBtn = document.getElementById('payAllCancelBtn');
        const progress = document.getElementById('payAllProgress');
        confirmBtn.disabled = true;
        cancelBtn.disabled = true;
        progress.style.display = 'block';

        // Hoisted out of the loop -- it's idempotent/account-level, not
        // per-employee, so there's no point re-checking it N times.
        await ensureChartOfAccounts();

        const succeeded = [];
        const failed = [];
        for (let i = 0; i < employeeIds.length; i++) {
            const employeeId = employeeIds[i];
            const name = currentBreakdown[employeeId]?.name || employeeId;
            progress.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Paying ${i + 1} of ${employeeIds.length}: ${name}...`;
            const result = await processEmployeePay(employeeId, { advanceDeduction: 0, paidFrom });
            if (result.success) {
                succeeded.push(result.name);
            } else {
                failed.push(`${result.name || name}: ${result.error?.message || 'unknown error'}`);
            }
        }

        modal.style.display = 'none';
        confirmBtn.disabled = false;
        cancelBtn.disabled = false;
        progress.style.display = 'none';

        let summary = `✅ Paid ${succeeded.length} of ${employeeIds.length} employee(s).`;
        if (failed.length > 0) {
            summary += `\n\n⚠️ ${failed.length} failed:\n` + failed.join('\n');
        }
        alert(summary);

        await window.calculatePayroll();
        await loadStatutoryPayments();

        // Per the request this feature was built for: Pay All should
        // also produce the combined salary printout + slips for
        // everyone just paid, instead of making someone print each
        // payslip one by one afterward.
        if (succeeded.length > 0) {
            // paidByEmployee was just refreshed by the calculatePayroll()
            // call above, so this is simply "whichever of the employees we
            // attempted this run are now on record as paid."
            const idsToPrint = employeeIds.filter(id => paidByEmployee[id]);
            await window.printAllPayslips(idsToPrint);
        }
    };

    // ============================================
    // INIT
    // ============================================
    await ensureChartOfAccounts();
    const now = new Date();
    document.getElementById('payrollMonthPicker').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    await loadStatutoryPayments();

    console.log("✅ Payroll initialized successfully!");
})();


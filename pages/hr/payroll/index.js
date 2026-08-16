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

        const tbody = document.getElementById('payrollTableBody');
        tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:30px;color:#94a3b8;"><i class="fa-solid fa-spinner fa-spin"></i> Calculating...</td></tr>`;

        const [employeesRes, jobsRes, unpaidLeaveRes, attendanceRes, alreadyPaidRes] = await Promise.all([
            supabaseClient.from('employees').select('employee_id, first_name, last_name').eq('status', 'Active').order('first_name'),
            supabaseClient.from('employee_employment').select('employee_id, basic_pay, allowances, is_fixed_pay'),
            supabaseClient.from('leave_requests').select('employee_id, start_date, end_date')
                .eq('leave_type', 'Unpaid').eq('status', 'Approved')
                .lte('start_date', monthEnd).gte('end_date', monthStart),
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

        const overtimeHoursByEmployee = {};
        (attendanceRes.data || []).forEach(a => {
            overtimeHoursByEmployee[a.employee_id] = (overtimeHoursByEmployee[a.employee_id] || 0) + (a.overtime_hours || 0);
        });

        const paidByEmployee = {};
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
            const unpaidDays = isFixedPay ? 0 : (unpaidDaysByEmployee[emp.employee_id] || 0);
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
                basicPay, allowances, unpaidDays, leaveDeduction, overtimeHours, overtimePay,
                grossSalary, paye, napsaEmployee, napsaEmployer, nhimaEmployee, nhimaEmployer, netPay,
                daysInMonth, month, year
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
                    ${b.unpaidDays > 0 ? `<br><small>${b.unpaidDays}d unpaid</small>` : ''}
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
                <h1>Payslip</h1>
                <p class="subtitle">${monthLabel} &middot; ${emp.first_name} ${emp.last_name}${emp.employee_code ? ' (' + emp.employee_code + ')' : ''} &middot; Paid ${new Date(r.paid_at).toLocaleDateString()} via ${paidFromLabel}</p>

                <div class="section-title">Earnings</div>
                <div class="row"><span>Basic Pay</span><span>K${formatNumber(r.basic_pay)}</span></div>
                ${r.allowances > 0 ? `<div class="row"><span>Allowances</span><span>K${formatNumber(r.allowances)}</span></div>` : ''}
                ${r.leave_deduction > 0 ? `<div class="row neg"><span>Leave Deduction (${r.unpaid_leave_days} unpaid day(s))</span><span>-K${formatNumber(r.leave_deduction)}</span></div>` : ''}
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
                <script>window.onload = function() { window.print(); };<\/script>
            </body>
            </html>
        `);
        printWindow.document.close();
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
            ${b.leaveDeduction > 0 ? `<div style="display:flex; justify-content:space-between; padding:4px 0; color:#dc2626;"><span>Leave Deduction (${b.unpaidDays}d unpaid)</span><span>-K${formatNumber(b.leaveDeduction)}</span></div>` : ''}
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

            document.getElementById('payConfirmModal').style.display = 'none';
            alert(`✅ ${b.name} paid K${formatNumber(cashPortion)} net${advanceDeduction > 0 ? ` (K${formatNumber(advanceDeduction)} recovered from advance)` : ''}.`);
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
    // INIT
    // ============================================
    await ensureChartOfAccounts();
    const now = new Date();
    document.getElementById('payrollMonthPicker').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    await loadStatutoryPayments();

    console.log("✅ Payroll initialized successfully!");
})();


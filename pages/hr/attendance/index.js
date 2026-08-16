// ============================================
// ATTENDANCE MANAGEMENT CONTROLLER
// ============================================

(async function initAttendancePage() {
    console.log("Attendance page initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }

    // ============================================
    // DOM REFERENCES
    // ============================================
    const modal = document.getElementById('attendanceModal');
    const closeModalBtn = document.getElementById('closeAttendanceModalBtn');
    const cancelModalBtn = document.getElementById('cancelAttendanceModalBtn');
    const manualBtn = document.getElementById('manualEntryBtn');
    const saveBtn = document.getElementById('saveAttendanceBtn');
    const form = document.getElementById('attendanceForm');
    const tbody = document.getElementById('attendanceTableBody');
    const datePicker = document.getElementById('attendanceDate');
    const refreshBtn = document.getElementById('refreshAttendanceBtn');
    const empSelect = document.getElementById('attEmployee');

    const quickClockDropdown = document.getElementById('quickClockDropdown');
    const quickClockInBtn = document.getElementById('quickClockInBtn');
    const quickClockOutBtn = document.getElementById('quickClockOutBtn');

    const holidayModal = document.getElementById('holidayModal');
    const closeHolidayModalBtn = document.getElementById('closeHolidayModalBtn');
    const publicHolidayBtn = document.getElementById('publicHolidayBtn');
    const holidayTableBody = document.getElementById('holidayTableBody');
    const addHolidayBtn = document.getElementById('addHolidayBtn');
    const holidayName = document.getElementById('holidayName');
    const holidayDate = document.getElementById('holidayDate');

    // MARK ABSENT DOM REFERENCES (NEW)
    const absentModal = document.getElementById('absentModal');
    const closeAbsentModalBtn = document.getElementById('closeAbsentModalBtn');
    const cancelAbsentModalBtn = document.getElementById('cancelAbsentModalBtn');
    const markAbsentBtn = document.getElementById('markAbsentBtn');
    const absentForm = document.getElementById('absentForm');
    const absentEmployee = document.getElementById('absentEmployee');
    const absentDate = document.getElementById('absentDate');
    const saveAbsentBtn = document.getElementById('saveAbsentBtn');

    // ============================================
    // LOAD QUICK CLOCK DROPDOWN
    // ============================================
    async function loadQuickClockDropdown() {
        try {
            const { data, error } = await supabaseClient
                .from('employees')
                .select(`
                    employee_id,
                    employee_code,
                    first_name,
                    last_name,
                    employment:employee_employment!employee_employment_employee_id_fkey (
                        is_fixed_pay,
                        weekly_off_day
                    )
                `)
                .eq('status', 'Active')
                .order('first_name');

            if (error) throw error;

            quickClockDropdown.innerHTML = `<option value="">-- Select Employee --</option>`;
            data.forEach(emp => {
                const job = emp.employment?.[0] || {};
                const weeklyOffDay = job.weekly_off_day || '';
                const isFixedPay = job.is_fixed_pay ?? true;
                
                const displayText = `${emp.employee_code} — ${emp.first_name} ${emp.last_name}`;
                quickClockDropdown.innerHTML += `
                    <option value="${emp.employee_id}" 
                            data-weeklyoff="${weeklyOffDay}" 
                            data-fixed="${isFixedPay}">
                        ${displayText}
                    </option>
                `;
            });
        } catch (error) {
            console.error("Error loading quick clock dropdown:", error);
        }
    }

    // ============================================
    // HELPER: Check Public Holiday
    // ============================================
    // Day classification + overtime rule now lives in
    // assets/js/shared-attendance-utils.js, loaded once in the root
    // index.html -- available globally to every SPA sub-module. This
    // used to be duplicated here, in clock_in.html, hr_view.js, and
    // dashboard_view.js. One source now, so a future rule change can't
    // accidentally miss one of them.
    // ============================================

    async function isPublicHoliday(dateStr) {
        const { data, error } = await supabaseClient
            .from('public_holidays')
            .select('name')
            .eq('holiday_date', dateStr)
            .maybeSingle();
        if (error) return false;
        return data ? data.name : false;
    }

    // ============================================
    // HELPER: Format Time
    // ============================================
    function formatTime(timeStr) {
        if (!timeStr) return '--:-- --';
        const [hour, minute] = timeStr.split(':');
        const h = parseInt(hour);
        const ampm = h >= 12 ? 'PM' : 'AM';
        const h12 = h % 12 || 12;
        return `${String(h12).padStart(2, '0')}:${minute} ${ampm}`;
    }

    // ============================================
    // HELPER: Calculate Minutes Worked
    // ============================================
    function calculateMinutesWorked(checkIn, checkOut) {
        if (!checkIn || !checkOut) return 0;
        const [h1, m1] = checkIn.split(':').map(Number);
        const [h2, m2] = checkOut.split(':').map(Number);
        const start = h1 * 60 + m1;
        const end = h2 * 60 + m2;
        return end - start;
    }

    // ============================================
    // 🔥 ADDED: weekly-off detection, matching what Employee Management
    // now actually stores. Previously this was inferred by matching the
    // employee's schedule NAME against hardcoded strings like 'Sunday
    // Off Shift' / 'Saturday Off Shift' -- that whole concept (Work
    // Schedule, schedule_id) was removed from Employee Management, so
    // every one of those checks would now silently always be false,
    // meaning no employee would ever be auto-detected as having a day
    // off. This reads the explicit per-employee weekly_off_day field
    // instead, which supports ANY day of the week, not just Sat/Sun.
    // (isWeeklyOffDay itself now lives in shared-attendance-utils.js)
    // ============================================

    // ============================================
    // HANDLE QUICK CLOCK IN/OUT
    // ============================================
    async function handleQuickClock(isClockIn) {
        const selected = quickClockDropdown.options[quickClockDropdown.selectedIndex];
        const employeeId = quickClockDropdown.value;
        
        if (!employeeId) {
            alert("Please select an employee from the dropdown.");
            quickClockDropdown.focus();
            return;
        }

        const weeklyOffDay = selected.dataset.weeklyoff || '';
        const isFixedPay = selected.dataset.fixed === 'true';
        const firstName = selected.text.split('—')[1]?.trim()?.split(' ')[0] || 'Employee';
        const lastName = selected.text.split('—')[1]?.trim()?.split(' ')[1] || '';

        const today = new Date().toISOString().split('T')[0];
        const nowTime = new Date().toTimeString().split(' ')[0];
        const isHoliday = await isPublicHoliday(today);
        const dayOfWeek = new Date().getDay();

        try {
            const { data: existing } = await supabaseClient
                .from('employee_attendance')
                .select('attendance_id, check_in, check_out')
                .eq('employee_id', employeeId)
                .eq('attendance_date', today)
                .maybeSingle();

            if (isClockIn) {
                if (existing) {
                    if (existing.check_in) {
                        alert(`${firstName} ${lastName} already clocked in today at ${formatTime(existing.check_in)}.`);
                        return;
                    } else {
                        await supabaseClient
                            .from('employee_attendance')
                            .update({ check_in: nowTime })
                            .eq('attendance_id', existing.attendance_id);
                    }
                } else {
                    await supabaseClient
                        .from('employee_attendance')
                        .insert([{
                            employee_id: employeeId,
                            attendance_date: today,
                            check_in: nowTime
                        }]);
                }
                alert(`✅ ${firstName} ${lastName} clocked in at ${formatTime(nowTime)}.`);
                quickClockDropdown.value = '';
                await loadAttendance();

            } else {
                if (!existing || !existing.check_in) {
                    alert(`${firstName} ${lastName} has not clocked in today.`);
                    return;
                }

                if (existing.check_out) {
                    alert(`${firstName} ${lastName} already clocked out today at ${formatTime(existing.check_out)}.`);
                    return;
                }

                // 🔥 FIX: previously only ever counted overtime for
                // holiday or off-day work (all hours OT) -- never for
                // simply staying late on a normal working day. Now uses
                // the half-day/full-day rule: Off day or Holiday = every
                // hour worked is OT; the day adjacent to a Sat/Sun off
                // day is a 5-hour Half day; every other working day is a
                // 9-hour Full day; OT only starts counting once more
                // than 1 hour past the regular threshold.
                const hoursWorked = calculateMinutesWorked(existing.check_in, nowTime) / 60;
                const dayCategory = getDayCategory(weeklyOffDay, dayOfWeek);
                const { isOvertime, overtimeHours } = computeOvertime(isFixedPay, isHoliday, dayCategory, hoursWorked);

                // Determine Day Type and Status
                const minutesWorked = calculateMinutesWorked(existing.check_in, nowTime);
                let status = 'Present';
                let dayType = 'Work';

                if (isWeeklyOffDay(weeklyOffDay, dayOfWeek)) {
                    dayType = 'Off';
                    status = 'Off';
                } else if (isHoliday) {
                    dayType = 'Holiday';
                    status = isOvertime ? 'Holiday OT' : 'Holiday';
                } else if (minutesWorked < 450) {
                    status = 'Short Day';
                }

                const { error: updateError } = await supabaseClient
                    .from('employee_attendance')
                    .update({
                        check_out: nowTime,
                        overtime_hours: overtimeHours,
                        is_overtime: isOvertime,
                        status: status,
                        day_type: dayType,
                        working_hours: hoursWorked
                    })
                    .eq('attendance_id', existing.attendance_id);

                if (updateError) throw updateError;

                // 🔥 FIX: this used to estimate overtime PAY using a
                // hardcoded fake K5000 salary and an unrelated /160
                // divisor -- since no real salary field existed at all.
                // Real overtime pay calculation belongs in the payroll
                // engine, using the employee's actual Basic Pay and the
                // correct /195 hourly rate; this alert just reports hours.
                alert(`✅ ${firstName} ${lastName} clocked out at ${formatTime(nowTime)}.${isOvertime ? ` Overtime: ${overtimeHours.toFixed(1)}h` : ''}`);
                
                quickClockDropdown.value = '';
                await loadAttendance();
            }

        } catch (error) {
            console.error("Error recording attendance:", error);
            alert("❌ Error recording attendance: " + error.message);
        }
    }

    // ============================================
    // LOAD ATTENDANCE TABLE
    // ============================================
    async function loadAttendance() {
        const selectedDate = datePicker.value || new Date().toISOString().split('T')[0];
        datePicker.value = selectedDate;

        try {
            const { data: employees, error: empError } = await supabaseClient
                .from('employees')
                .select(`
                    employee_id,
                    first_name,
                    last_name,
                    employment:employee_employment!employee_employment_employee_id_fkey (
                        pay_category,
                        weekly_off_day
                    )
                `)
                .eq('status', 'Active')
                .order('first_name');

            if (empError) throw empError;

            const { data: attendance, error: attError } = await supabaseClient
                .from('employee_attendance')
                .select('*')
                .eq('attendance_date', selectedDate);

            if (attError) throw attError;

            const attMap = {};
            attendance.forEach(a => attMap[a.employee_id] = a);

            if (!employees || employees.length === 0) {
                tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 30px; color: #94a3b8;">No active employees found.</td></tr>`;
                renderAttendanceSummary([]);
                return;
            }

            const rows = employees.map(emp => {
                const job = emp.employment?.[0] || {};
                const attRecord = attMap[emp.employee_id];
                const checkIn = attRecord?.check_in || null;
                const checkOut = attRecord?.check_out || null;
                const dayType = attRecord?.day_type || 'Work';
                const statusText = attRecord?.status || 'Absent';
                const isOvertime = attRecord?.is_overtime || false;
                return { emp, job, checkIn, checkOut, dayType, statusText, isOvertime };
            });

            renderAttendanceSummary(rows);

            // 🔥 Richer rendering: avatar initials (matching Employee
            // Management's style), status icons, Fixed/Regular pay
            // category badge, and a subtle left-border accent per row
            // reflecting status -- previously this was a completely plain
            // text table.
            tbody.innerHTML = rows.map(({ emp, job, checkIn, checkOut, dayType, statusText, isOvertime }) => {
                const initials = (emp.first_name?.charAt(0) || '') + (emp.last_name?.charAt(0) || '');
                const isFixed = job.pay_category === 'Fixed';

                let badgeBg = '#dcfce7', badgeColor = '#15803d', borderColor = '#22c55e', icon = 'fa-circle-check';
                let displayLabel = statusText;

                if (dayType === 'Off') {
                    badgeBg = '#f1f5f9'; badgeColor = '#64748b'; borderColor = '#cbd5e1'; icon = 'fa-mug-hot';
                    displayLabel = 'Off';
                } else if (dayType === 'Holiday') {
                    badgeBg = '#fef9c3'; badgeColor = '#854d0e'; borderColor = '#eab308'; icon = 'fa-calendar-day';
                    displayLabel = statusText;
                } else if (statusText === 'Short Day') {
                    badgeBg = '#ffedd5'; badgeColor = '#c2410c'; borderColor = '#f97316'; icon = 'fa-hourglass-half';
                } else if (statusText === 'Absent') {
                    badgeBg = '#fee2e2'; badgeColor = '#dc2626'; borderColor = '#ef4444'; icon = 'fa-circle-xmark';
                } else if (checkIn && !checkOut) {
                    badgeBg = '#dbeafe'; badgeColor = '#1d4ed8'; borderColor = '#3b82f6'; icon = 'fa-clock';
                    displayLabel = 'Clocked In';
                }

                return `
                <tr style="border-left: 3px solid ${borderColor};">
                    <td style="padding-left: 17px; display: flex; align-items: center; gap: 10px; font-weight: 500;">
                        <div style="width: 32px; height: 32px; background: #dbeafe; color: #2563eb; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 0.8rem; flex-shrink: 0;">
                            ${initials}
                        </div>
                        <div>
                            <div>${emp.first_name} ${emp.last_name}</div>
                            <div style="font-size: 0.7rem; color: #94a3b8;">
                                ${isFixed ? '<i class="fa-solid fa-lock"></i> Fixed' : '<i class="fa-solid fa-arrows-up-down"></i> Regular'}
                                ${job.weekly_off_day ? ` · Off: ${job.weekly_off_day}` : ''}
                            </div>
                        </div>
                    </td>
                    <td>${new Date(selectedDate).toLocaleDateString()}</td>
                    <td>${formatTime(checkIn)}</td>
                    <td>${formatTime(checkOut)}</td>
                    <td style="padding-right: 20px; text-align: right;">
                        <span style="background: ${badgeBg}; color: ${badgeColor}; padding: 4px 10px; border-radius: 10px; font-size: 0.75rem; display: inline-flex; align-items: center; gap: 5px; font-weight: 500;">
                            <i class="fa-solid ${icon}"></i> ${displayLabel}${isOvertime && dayType !== 'Off' ? ' (OT)' : ''}
                        </span>
                    </td>
                </tr>
                `;
            }).join('');

        } catch (error) {
            console.error("Error loading attendance:", error);
            tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 30px; color: #dc2626;">Error loading records.</td></tr>`;
        }
    }

    // ============================================
    // 🔥 ADDED: quick summary counts above the table
    // ============================================
    function renderAttendanceSummary(rows) {
        const el = document.getElementById('attendanceSummary');
        if (!el) return;

        const present = rows.filter(r => r.checkIn && r.dayType === 'Work' && r.statusText !== 'Absent').length;
        const absent = rows.filter(r => r.statusText === 'Absent').length;
        const off = rows.filter(r => r.dayType === 'Off').length;
        const onHoliday = rows.filter(r => r.dayType === 'Holiday').length;
        const overtime = rows.filter(r => r.isOvertime).length;

        el.innerHTML = `
            <div class="att-stat" style="border-left-color:#22c55e;"><span class="att-stat-num">${present}</span><span class="att-stat-label">Present</span></div>
            <div class="att-stat" style="border-left-color:#ef4444;"><span class="att-stat-num">${absent}</span><span class="att-stat-label">Absent</span></div>
            <div class="att-stat" style="border-left-color:#94a3b8;"><span class="att-stat-num">${off}</span><span class="att-stat-label">Off Today</span></div>
            <div class="att-stat" style="border-left-color:#eab308;"><span class="att-stat-num">${onHoliday}</span><span class="att-stat-label">Holiday</span></div>
            <div class="att-stat" style="border-left-color:#3b82f6;"><span class="att-stat-num">${overtime}</span><span class="att-stat-label">Overtime</span></div>
        `;
    }

    // ============================================
    // QUICK CLOCK EVENT LISTENERS
    // ============================================
    quickClockInBtn.addEventListener('click', () => handleQuickClock(true));
    quickClockOutBtn.addEventListener('click', () => handleQuickClock(false));

    // ============================================
    // PUBLIC HOLIDAY FUNCTIONS
    // ============================================
    async function loadHolidays() {
        try {
            const { data, error } = await supabaseClient
                .from('public_holidays')
                .select('*')
                .order('holiday_date', { ascending: true });

            if (error) throw error;

            if (!data || data.length === 0) {
                holidayTableBody.innerHTML = `<tr><td colspan="3" style="text-align: center; padding: 20px; color: #94a3b8;">No public holidays added yet.</td></tr>`;
                return;
            }

            holidayTableBody.innerHTML = data.map(h => `
                <tr>
                    <td style="padding: 8px; font-weight: 500;">${h.name}</td>
                    <td style="padding: 8px;">${new Date(h.holiday_date).toLocaleDateString()}</td>
                    <td style="padding: 8px; text-align: right;">
                        <button onclick="deleteHoliday('${h.holiday_id}')" style="background: none; border: none; color: #dc2626; cursor: pointer;">
                            <i class="fa-regular fa-trash-can"></i>
                        </button>
                    </td>
                </tr>
            `).join('');

        } catch (error) {
            console.error("Error loading holidays:", error);
            holidayTableBody.innerHTML = `<tr><td colspan="3" style="text-align: center; padding: 20px; color: #dc2626;">Error loading holidays.</td></tr>`;
        }
    }

    window.deleteHoliday = async function(holidayId) {
        if (!confirm("Are you sure you want to delete this public holiday?")) return;
        try {
            await supabaseClient.from('public_holidays').delete().eq('holiday_id', holidayId);
            loadHolidays();
            loadAttendance();
        } catch (error) {
            alert("Error deleting holiday.");
        }
    };

    publicHolidayBtn.addEventListener('click', () => {
        holidayModal.style.display = 'flex';
        loadHolidays();
    });

    closeHolidayModalBtn.addEventListener('click', () => {
        holidayModal.style.display = 'none';
    });

    addHolidayBtn.addEventListener('click', async () => {
        const name = holidayName.value.trim();
        const date = holidayDate.value;
        if (!name || !date) return alert("Please enter both name and date.");

        try {
            const { error } = await supabaseClient
                .from('public_holidays')
                .insert([{ name, holiday_date: date }]);
            if (error) throw error;

            holidayName.value = '';
            holidayDate.value = '';
            loadHolidays();
            loadAttendance();
            alert('✅ Public Holiday added successfully!');
        } catch (error) {
            alert('Error adding holiday: ' + error.message);
        }
    });

    // ============================================
    // MARK ABSENT / OFF MODAL (NEW)
    // ============================================
    async function loadAbsentEmployeeDropdown() {
        try {
            const { data, error } = await supabaseClient
                .from('employees')
                .select('employee_id, first_name, last_name')
                .eq('status', 'Active')
                .order('first_name');

            if (error) throw error;

            absentEmployee.innerHTML = `<option value="">Select Employee</option>`;
            data.forEach(emp => {
                absentEmployee.innerHTML += `<option value="${emp.employee_id}">${emp.first_name} ${emp.last_name}</option>`;
            });
        } catch (error) {
            console.error("Error loading employees:", error);
        }
    }

    function openAbsentModal() {
        absentModal.style.display = 'flex';
        absentForm.reset();
        absentDate.value = datePicker.value;
        loadAbsentEmployeeDropdown();
    }

    function closeAbsentModal() {
        absentModal.style.display = 'none';
    }

    markAbsentBtn.addEventListener('click', openAbsentModal);
    closeAbsentModalBtn.addEventListener('click', closeAbsentModal);
    cancelAbsentModalBtn.addEventListener('click', closeAbsentModal);
    absentModal.addEventListener('click', (e) => {
        if (e.target === absentModal) closeAbsentModal();
    });

    // ============================================
    // SAVE ABSENT / OFF (WITH SMART DETECTION)
    // ============================================
    absentForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        saveAbsentBtn.disabled = true;
        saveAbsentBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;

        const employeeId = absentEmployee.value;
        const selectedDate = absentDate.value;

        if (!employeeId || !selectedDate) {
            alert("Please select an employee and date.");
            saveAbsentBtn.disabled = false;
            saveAbsentBtn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Save Status`;
            return;
        }
        // 🔥 ADDED: reject future dates -- the max attribute on the input
        // is a soft UI hint, this is the actual enforcement.
        if (selectedDate > todayStrForInputs) {
            alert("Cannot mark attendance for a future date.");
            saveAbsentBtn.disabled = false;
            saveAbsentBtn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Save Status`;
            return;
        }

        try {
            // Fetch the employee's schedule and fixed pay status
            const { data: empData, error: empError } = await supabaseClient
                .from('employees')
                .select(`
                    employment:employee_employment!employee_employment_employee_id_fkey (
                        is_fixed_pay,
                        weekly_off_day
                    )
                `)
                .eq('employee_id', employeeId)
                .single();

            if (empError) throw empError;

            const job = empData.employment?.[0] || {};
            const weeklyOffDay = job.weekly_off_day || '';

            const isHoliday = await isPublicHoliday(selectedDate);
            const dayOfWeek = new Date(selectedDate).getDay();

            // Determine Day Type and Status
            let dayType = 'Work';
            let status = 'Absent';

            if (isWeeklyOffDay(weeklyOffDay, dayOfWeek)) {
                dayType = 'Off';
                status = 'Off';
            } else if (isHoliday) {
                dayType = 'Holiday';
                status = 'Holiday Off';
            }

            // Check if a record already exists
            const { data: existing } = await supabaseClient
                .from('employee_attendance')
                .select('attendance_id')
                .eq('employee_id', employeeId)
                .eq('attendance_date', selectedDate)
                .maybeSingle();

            if (existing) {
                const { error: updateError } = await supabaseClient.from('employee_attendance').update({
                    check_in: null,
                    check_out: null,
                    overtime_hours: 0,
                    is_overtime: false,
                    status: status,
                    day_type: dayType
                }).eq('attendance_id', existing.attendance_id);
                
                if (updateError) throw updateError;
            } else {
                const { error: insertError } = await supabaseClient.from('employee_attendance').insert([{
                    employee_id: employeeId,
                    attendance_date: selectedDate,
                    check_in: null,
                    check_out: null,
                    overtime_hours: 0,
                    is_overtime: false,
                    status: status,
                    day_type: dayType
                }]);
                
                if (insertError) throw insertError;
            }

            saveAbsentBtn.innerHTML = `<i class="fa-solid fa-check"></i> Saved!`;
            setTimeout(() => {
                saveAbsentBtn.disabled = false;
                saveAbsentBtn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Save Status`;
            }, 1000);

            alert('✅ Status recorded successfully!');
            closeAbsentModal();
            await loadAttendance();

        } catch (error) {
            console.error("Error saving status:", error);
            alert('❌ Error saving status: ' + error.message);
            saveAbsentBtn.disabled = false;
            saveAbsentBtn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Save Status`;
        }
    });

    // ============================================
    // MANUAL ENTRY & REFRESH
    // ============================================
    async function loadEmployeeDropdown() {
        try {
            const { data, error } = await supabaseClient
                .from('employees')
                .select('employee_id, first_name, last_name')
                .eq('status', 'Active')
                .order('first_name');

            if (error) throw error;

            empSelect.innerHTML = `<option value="">Select Employee</option>`;
            data.forEach(emp => {
                empSelect.innerHTML += `<option value="${emp.employee_id}">${emp.first_name} ${emp.last_name}</option>`;
            });
        } catch (error) {
            console.error("Error loading employees:", error);
        }
    }

    function openModal() {
        modal.style.display = 'flex';
        form.reset();
        document.getElementById('attDate').value = datePicker.value;
        loadEmployeeDropdown();
    }

    function closeModal() {
        modal.style.display = 'none';
    }

    manualBtn.addEventListener('click', openModal);
    closeModalBtn.addEventListener('click', closeModal);
    cancelModalBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    datePicker.addEventListener('change', loadAttendance);
    refreshBtn.addEventListener('click', loadAttendance);

    // ============================================
    // FIXED: MANUAL ENTRY SUBMIT
    // ============================================
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        saveBtn.disabled = true;
        saveBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;

        const employeeId = empSelect.value;
        const selectedDate = document.getElementById('attDate').value;
        const checkIn = document.getElementById('attClockIn').value || null;
        const checkOut = document.getElementById('attClockOut').value || null;

        if (!employeeId || !selectedDate) {
            alert("Please select an employee and date.");
            saveBtn.disabled = false;
            saveBtn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Save Entry`;
            return;
        }
        // 🔥 ADDED: reject future dates -- same enforcement as Mark Absent.
        if (selectedDate > todayStrForInputs) {
            alert("Cannot enter attendance for a future date.");
            saveBtn.disabled = false;
            saveBtn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Save Entry`;
            return;
        }

        try {
            // Fetch the employee's schedule and fixed pay status
            const { data: empData, error: empError } = await supabaseClient
                .from('employees')
                .select(`
                    employment:employee_employment!employee_employment_employee_id_fkey (
                        is_fixed_pay,
                        weekly_off_day
                    )
                `)
                .eq('employee_id', employeeId)
                .single();

            if (empError) throw empError;

            const job = empData.employment?.[0] || {};
            const weeklyOffDay = job.weekly_off_day || '';
            const isFixedPay = job.is_fixed_pay ?? true;

            const isHoliday = await isPublicHoliday(selectedDate);
            const dayOfWeek = new Date(selectedDate).getDay();

            // 🔥 FIX: same corrected overtime rule as the Quick Clock Out
            // handler -- half-day/full-day thresholds with a 1-hour
            // grace, not just "any off-day/holiday work is all OT".
            let overtimeHours = 0;
            let isOvertime = false;
            let dayType = 'Work';
            let status = 'Present';
            let hoursWorked = null; // 🔥 null when not applicable (e.g. an Absent-only entry), not 0

            if (checkIn && checkOut) {
                const minutesWorked = calculateMinutesWorked(checkIn, checkOut);
                hoursWorked = minutesWorked / 60;
                const dayCategory = getDayCategory(weeklyOffDay, dayOfWeek);
                const otResult = computeOvertime(isFixedPay, isHoliday, dayCategory, hoursWorked);
                isOvertime = otResult.isOvertime;
                overtimeHours = otResult.overtimeHours;

                if (isHoliday) {
                    dayType = 'Holiday';
                    status = isOvertime ? 'Holiday OT' : 'Holiday';
                } else if (dayCategory === 'Off') {
                    status = isOvertime ? 'Overtime' : 'Present';
                } else if (minutesWorked < 450) {
                    status = 'Short Day';
                }
            }

            // Determine Off days (No clock-in required)
            if (!checkIn && isWeeklyOffDay(weeklyOffDay, dayOfWeek)) {
                dayType = 'Off';
                status = 'Off';
            } else if (!checkIn && isHoliday) {
                dayType = 'Holiday';
                status = 'Holiday Off';
            } else if (!checkIn) {
                status = 'Absent';
            }

            // Check if a record already exists
            const { data: existing } = await supabaseClient
                .from('employee_attendance')
                .select('attendance_id')
                .eq('employee_id', employeeId)
                .eq('attendance_date', selectedDate)
                .maybeSingle();

            if (existing) {
                const { error: updateError } = await supabaseClient.from('employee_attendance').update({
                    check_in: checkIn,
                    check_out: checkOut,
                    overtime_hours: overtimeHours,
                    is_overtime: isOvertime,
                    status: status,
                    day_type: dayType,
                    working_hours: hoursWorked
                }).eq('attendance_id', existing.attendance_id);
                
                if (updateError) throw updateError;
            } else {
                const { error: insertError } = await supabaseClient.from('employee_attendance').insert([{
                    employee_id: employeeId,
                    attendance_date: selectedDate,
                    check_in: checkIn,
                    check_out: checkOut,
                    overtime_hours: overtimeHours,
                    is_overtime: isOvertime,
                    status: status,
                    day_type: dayType,
                    working_hours: hoursWorked
                }]);
                
                if (insertError) throw insertError;
            }

            saveBtn.innerHTML = `<i class="fa-solid fa-check"></i> Saved!`;
            setTimeout(() => {
                saveBtn.disabled = false;
                saveBtn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Save Entry`;
            }, 1000);

            alert('✅ Attendance recorded successfully!');
            closeModal();
            await loadAttendance();

        } catch (error) {
            console.error("Error saving attendance:", error);
            alert('❌ Error saving attendance: ' + error.message);
            saveBtn.disabled = false;
            saveBtn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Save Entry`;
        }
    });

    // ============================================
    // 🔥 ADDED: prevent entering attendance for future dates -- applies
    // to Mark Absent and Manual Entry only. holidayDate is deliberately
    // left open, since public holidays are set in advance.
    // ============================================
    const todayForInputs = new Date();
    const todayStrForInputs = `${todayForInputs.getFullYear()}-${String(todayForInputs.getMonth() + 1).padStart(2, '0')}-${String(todayForInputs.getDate()).padStart(2, '0')}`;
    const absentDateInput = document.getElementById('absentDate');
    const attDateInput = document.getElementById('attDate');
    if (absentDateInput) absentDateInput.max = todayStrForInputs;
    if (attDateInput) attDateInput.max = todayStrForInputs;

    // ============================================
    // INITIALIZE
    // ============================================
    await loadQuickClockDropdown();
    await loadAttendance();
    
    console.log("✅ Attendance Management initialized successfully!");
})();
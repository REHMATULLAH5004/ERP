// ============================================
// FINGERPRINT CLOCK-IN STATION
// ============================================
// Replaces the old QR Clock-In Station. Runs on the PC physically
// connected to the SecuGen HUPx reader. Flow:
//   1. Load every active employee's enrolled fingerprint template
//      (from employee_fingerprints -- enrolled via the "Enroll
//      Fingerprint" button on the Attendance page).
//   2. On "Scan Finger", capture a fresh scan via SecuGen WebAPI
//      (assets/js/secugen-webapi.js) and compare it against every
//      enrolled template to figure out who just scanned.
//   3. Once identified, clock that employee in or out using the EXACT
//      same day-type/overtime rule as the Attendance page's Quick
//      Clock (assets/js/shared-attendance-utils.js), writing to the
//      same employee_attendance table.
//
// Whoever is logged into the ERP on this kiosk PC needs to be an
// Admin (or otherwise satisfy employee_attendance's write_own_or_admin
// policy) for this to be able to clock in OTHER employees -- same
// requirement Quick Clock already has today.
// ============================================

(async function initFingerprintStation() {
    console.log("Fingerprint Clock-In Station initializing...");

    if (typeof supabaseClient === 'undefined') {
        console.error("❌ supabaseClient is not defined.");
        return;
    }
    if (typeof captureFingerprint !== 'function' || typeof identifyFingerprint !== 'function') {
        console.error("❌ secugen-webapi.js is not loaded.");
        return;
    }

    const iconEl = document.getElementById('fpStationIcon');
    const messageEl = document.getElementById('fpStationMessage');
    const subMessageEl = document.getElementById('fpStationSubMessage');
    const scanBtn = document.getElementById('fpStationScanBtn');

    let candidates = []; // { employee_id, first_name, last_name, template, weeklyOffDay, isFixedPay }
    let isScanning = false;

    // ============================================
    // LOAD ENROLLED EMPLOYEES + TEMPLATES
    // ============================================
    async function loadCandidates() {
        try {
            const { data, error } = await supabaseClient
                .from('employee_fingerprints')
                .select(`
                    employee_id,
                    template,
                    employees!employee_fingerprints_employee_id_fkey (
                        first_name,
                        last_name,
                        status,
                        employment:employee_employment!employee_employment_employee_id_fkey (
                            is_fixed_pay,
                            weekly_off_day
                        )
                    )
                `);

            if (error) throw error;

            candidates = (data || [])
                .filter(row => row.employees && row.employees.status === 'Active')
                .map(row => {
                    const job = row.employees.employment?.[0] || {};
                    return {
                        employee_id: row.employee_id,
                        template: row.template,
                        firstName: row.employees.first_name,
                        lastName: row.employees.last_name,
                        weeklyOffDay: job.weekly_off_day || '',
                        isFixedPay: job.is_fixed_pay ?? true,
                    };
                });

            console.log(`✅ Loaded ${candidates.length} enrolled fingerprint(s).`);
        } catch (error) {
            console.error("Error loading enrolled fingerprints:", error);
            setState('error', 'Could not load enrolled employees', error.message);
        }
    }

    // ============================================
    // UI STATE HELPERS
    // ============================================
    function setState(kind, message, subMessage) {
        const styles = {
            idle: { icon: 'fa-fingerprint', color: '#0f766e' },
            scanning: { icon: 'fa-spinner fa-spin', color: '#2563eb' },
            success: { icon: 'fa-circle-check', color: '#22c55e' },
            error: { icon: 'fa-triangle-exclamation', color: '#dc2626' },
            unknown: { icon: 'fa-circle-question', color: '#f59e0b' },
        };
        const style = styles[kind] || styles.idle;
        iconEl.innerHTML = `<i class="fa-solid ${style.icon}"></i>`;
        iconEl.style.color = style.color;
        messageEl.textContent = message;
        subMessageEl.textContent = subMessage || '';
    }

    function formatTime(timeStr) {
        if (!timeStr) return '--:--';
        const [hour, minute] = timeStr.split(':');
        const h = parseInt(hour);
        const ampm = h >= 12 ? 'PM' : 'AM';
        const h12 = h % 12 || 12;
        return `${String(h12).padStart(2, '0')}:${minute} ${ampm}`;
    }

    function calculateMinutesWorked(checkIn, checkOut) {
        const [h1, m1] = checkIn.split(':').map(Number);
        const [h2, m2] = checkOut.split(':').map(Number);
        return (h2 * 60 + m2) - (h1 * 60 + m1);
    }

    async function isPublicHoliday(dateStr) {
        const { data } = await supabaseClient
            .from('public_holidays')
            .select('name')
            .eq('holiday_date', dateStr)
            .maybeSingle();
        return data ? data.name : false;
    }

    // ============================================
    // CLOCK IN / OUT (mirrors Attendance page's handleQuickClock)
    // ============================================
    async function clockEmployee(candidate) {
        const today = new Date().toISOString().split('T')[0];
        const nowTime = new Date().toTimeString().split(' ')[0];
        const dayOfWeek = new Date().getDay();
        const name = `${candidate.firstName} ${candidate.lastName}`;

        const { data: existing, error: existingError } = await supabaseClient
            .from('employee_attendance')
            .select('attendance_id, check_in, check_out')
            .eq('employee_id', candidate.employee_id)
            .eq('attendance_date', today)
            .maybeSingle();

        if (existingError) throw existingError;

        if (!existing || !existing.check_in) {
            // CLOCK IN
            if (existing) {
                await supabaseClient
                    .from('employee_attendance')
                    .update({ check_in: nowTime })
                    .eq('attendance_id', existing.attendance_id);
            } else {
                await supabaseClient
                    .from('employee_attendance')
                    .insert([{ employee_id: candidate.employee_id, attendance_date: today, check_in: nowTime }]);
            }
            setState('success', `Welcome, ${name}`, `Clocked in at ${formatTime(nowTime)}.`);
            return;
        }

        if (existing.check_out) {
            setState('unknown', name, `Already clocked out today at ${formatTime(existing.check_out)}.`);
            return;
        }

        // CLOCK OUT
        const isHoliday = await isPublicHoliday(today);
        const hoursWorked = calculateMinutesWorked(existing.check_in, nowTime) / 60;
        const dayCategory = getDayCategory(candidate.weeklyOffDay, dayOfWeek);
        const { isOvertime, overtimeHours } = computeOvertime(candidate.isFixedPay, isHoliday, dayCategory, hoursWorked);

        const minutesWorked = calculateMinutesWorked(existing.check_in, nowTime);
        let status = 'Present';
        let dayType = 'Work';

        if (isWeeklyOffDay(candidate.weeklyOffDay, dayOfWeek)) {
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
                working_hours: hoursWorked,
            })
            .eq('attendance_id', existing.attendance_id);

        if (updateError) throw updateError;

        setState('success', `Bye, ${name}`, `Clocked out at ${formatTime(nowTime)}.${isOvertime ? ` Overtime: ${overtimeHours.toFixed(1)}h` : ''}`);
    }

    // ============================================
    // SCAN BUTTON
    // ============================================
    async function handleScan() {
        if (isScanning) return;
        isScanning = true;
        scanBtn.disabled = true;

        setState('scanning', 'Scanning...', 'Place a finger firmly on the reader.');

        try {
            if (candidates.length === 0) {
                await loadCandidates();
            }
            if (candidates.length === 0) {
                setState('error', 'No fingerprints enrolled yet', 'Enroll employees first from the Attendance page.');
                return;
            }

            const capture = await captureFingerprint();
            if (!capture.ok) {
                setState('error', "Couldn't read the fingerprint", capture.errorMessage);
                return;
            }

            const result = await identifyFingerprint(capture.template, candidates);

            if (!result.matched) {
                if (result.reason === 'ambiguous') {
                    setState('unknown', "Couldn't confirm who this is", 'The scan matched more than one person closely. Please try again.');
                } else {
                    setState('unknown', 'Fingerprint not recognized', "Not enrolled yet, or didn't scan clearly -- please try again, or use Manual Entry.");
                }
                return;
            }

            await clockEmployee(result.candidate);
        } catch (error) {
            console.error("Error during fingerprint clock-in:", error);
            setState('error', 'Something went wrong', error.message || 'Please try again.');
        } finally {
            isScanning = false;
            scanBtn.disabled = false;
        }
    }

    scanBtn.addEventListener('click', handleScan);

    // ============================================
    // INITIALIZE
    // ============================================
    await loadCandidates();
    console.log("✅ Fingerprint Clock-In Station initialized successfully!");
})();

// ============================================
// SHARED ATTENDANCE & DATE UTILITIES
// ============================================
// Single canonical source for logic that was previously duplicated
// across four separate files: attendance_index.js, hr_view.js,
// dashboard_view.js, and clock_in.html. Each copy had to be updated by
// hand whenever the rule changed, with no automatic way to catch a
// missed one -- this file exists specifically to remove that risk.
//
// Loaded once, globally:
//   - Included via a normal <script> tag in the root index.html, so
//     every SPA sub-module (which all share one browser page/JS
//     context regardless of how their own script got injected) can
//     call these functions directly, no import needed.
//   - Also included via its own <script> tag in clock_in.html, since
//     that page is a genuine standalone document, not injected into
//     the SPA shell.
//
// If this rule ever needs to change again, it changes here once, and
// every page automatically stays in sync -- that was the whole point.
// ============================================

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function isWeeklyOffDay(weeklyOffDay, dayOfWeek) {
    if (!weeklyOffDay) return false;
    return weeklyOffDay === DAY_NAMES[dayOfWeek];
}

// Builds a YYYY-MM-DD date string directly from local year/month/day
// components, with zero timezone conversion. Deliberately NOT using
// `new Date(y,m,d).toISOString()` -- that converts to UTC first, which
// silently shifts the date back a full day in any timezone ahead of
// UTC (Zambia is UTC+2). This was a real, previously-shipped bug.
function formatDateLocal(year, month, day) {
    return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// ============================================
// Day classification + overtime rule
// ============================================
// Off:  the employee's actual weekly off day -- if they work it
//       anyway, every hour worked is overtime.
// Half: the day ADJACENT to a Saturday/Sunday off day specifically
//       (Sunday-off -> Saturday is half day; Saturday-off -> Sunday
//       is half day). 5 regular hours; working more than 1 hour past
//       that (i.e. over 6h) starts counting overtime.
// Full: every other working day. 9 regular hours; working more than
//       1 hour past that (over 10h) starts counting overtime.
// Employees whose off day isn't Saturday or Sunday have no half-day
// concept -- every working day is Full for them.
// Fixed-pay employees: no overtime, no deduction, ever -- this is
// checked by the caller before any of this runs.
// ============================================
const REGULAR_HOURS = { Half: 5, Full: 9 };
const OVERTIME_GRACE_HOURS = 1;

function getDayCategory(weeklyOffDay, dayOfWeek) {
    if (isWeeklyOffDay(weeklyOffDay, dayOfWeek)) return 'Off';
    if (weeklyOffDay === 'Sunday' && dayOfWeek === 6) return 'Half';   // Saturday
    if (weeklyOffDay === 'Saturday' && dayOfWeek === 0) return 'Half'; // Sunday
    return 'Full';
}

function computeOvertime(isFixedPay, isHoliday, dayCategory, hoursWorked) {
    if (isFixedPay) return { isOvertime: false, overtimeHours: 0 };

    // Holiday or the employee's own off day: every hour worked is
    // overtime, no regular-hours threshold applies at all.
    if (isHoliday || dayCategory === 'Off') {
        return { isOvertime: hoursWorked > 0, overtimeHours: Math.max(0, hoursWorked) };
    }

    const threshold = REGULAR_HOURS[dayCategory] || REGULAR_HOURS.Full;
    if (hoursWorked > threshold + OVERTIME_GRACE_HOURS) {
        return { isOvertime: true, overtimeHours: hoursWorked - threshold };
    }
    return { isOvertime: false, overtimeHours: 0 };
}
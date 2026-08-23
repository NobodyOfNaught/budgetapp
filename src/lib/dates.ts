// Minimal calendar-date helpers. Dates are plain 'YYYY-MM-DD' strings and
// months are 'YYYY-MM-01' strings (see docs/plan.md — a budget date is a
// calendar date, not an instant, so there's no timezone handling anywhere
// here on purpose). The month helpers below are pure string/integer math;
// the day-level helpers added for PR 6 (addDays/addMonths/addYears) use
// `Date.UTC` purely as a calendar-arithmetic scratchpad — never `new
// Date()`, never anything that reads wall-clock/local time — and always
// convert straight back to a plain string. UTC here means "a fixed
// reference," not "the transaction's timezone"; there still isn't one.

/** Truncates a 'YYYY-MM-DD' date to its containing month, 'YYYY-MM-01'. */
export function monthOf(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function parseMonth(month: string): { year: number; month: number } {
  return { year: Number(month.slice(0, 4)), month: Number(month.slice(5, 7)) };
}

function formatMonth(year: number, month: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
}

/** The month immediately after `month` ('YYYY-MM-01' in and out). */
export function nextMonth(month: string): string {
  const { year, month: m } = parseMonth(month);
  return m === 12 ? formatMonth(year + 1, 1) : formatMonth(year, m + 1);
}

/** -1 / 0 / 1, ordering two 'YYYY-MM-01' strings chronologically. */
export function compareMonths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Inclusive [start, end] list of months, chronological order. */
export function monthRange(start: string, end: string): string[] {
  const months: string[] = [];
  for (let m = start; compareMonths(m, end) <= 0; m = nextMonth(m)) {
    months.push(m);
  }
  return months;
}

/** The number of month-steps from `a` to `b` ('YYYY-MM-01' or 'YYYY-MM-DD',
 * truncated) — positive if `b` is later, negative if earlier. */
export function monthsBetween(a: string, b: string): number {
  const pa = parseMonth(monthOf(a));
  const pb = parseMonth(monthOf(b));
  return (pb.year - pa.year) * 12 + (pb.month - pa.month);
}

interface DateParts {
  year: number;
  month: number; // 1-12
  day: number;
}

function parseDate(date: string): DateParts {
  return { year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)), day: Number(date.slice(8, 10)) };
}

function formatDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function daysInMonth(year: number, month: number): number {
  // Day 0 of the NEXT month is the last day of THIS one — Date.UTC handles
  // the December-rollover and leap-year cases for free.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** `date` plus `days` (may be negative), 'YYYY-MM-DD' in and out. */
export function addDays(date: string, days: number): string {
  const { year, month, day } = parseDate(date);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return formatDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/**
 * `date` plus `months` (may be negative), 'YYYY-MM-DD' in and out. Clamps
 * the day-of-month into the target month rather than overflowing —
 * Jan 31 + 1 month is Feb 28 (or Feb 29), not Mar 2/3. This is what keeps a
 * target anchored on the 31st from silently drifting across the year; see
 * test/domain/targets.test.ts's month-end clamping case.
 */
export function addMonths(date: string, months: number): string {
  const { year, month, day } = parseDate(date);
  const total = (year * 12 + (month - 1)) + months;
  const targetYear = Math.floor(total / 12);
  const targetMonth = (total % 12) + 1; // 1-12
  const clampedDay = Math.min(day, daysInMonth(targetYear, targetMonth));
  return formatDate(targetYear, targetMonth, clampedDay);
}

/** `date` plus `years` (may be negative) — same clamping as addMonths (Feb 29 -> Feb 28 on a non-leap year). */
export function addYears(date: string, years: number): string {
  return addMonths(date, years * 12);
}

/** Inclusive [start, end] list of calendar days, chronological order — the
 * day-granularity equivalent of monthRange above. Plain string comparison
 * is enough to order two 'YYYY-MM-DD' dates (no compareDates helper exists
 * or is needed for the same reason none of the callers elsewhere in this
 * codebase need one). */
export function dateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    dates.push(d);
  }
  return dates;
}

/** Whole calendar days from `a` to `b` ('YYYY-MM-DD') — positive if `b` is
 * later. Exact (via Date.UTC), not an approximation — used to cap a
 * daily-report date range before dateRange would build a huge array. */
export function daysBetween(a: string, b: string): number {
  const pa = parseDate(a);
  const pb = parseDate(b);
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((Date.UTC(pb.year, pb.month - 1, pb.day) - Date.UTC(pa.year, pa.month - 1, pa.day)) / msPerDay);
}

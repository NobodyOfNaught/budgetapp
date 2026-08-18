// Minimal calendar-month helpers. Dates are plain 'YYYY-MM-DD' strings and
// months are 'YYYY-MM-01' strings (see docs/plan.md — a budget date is a
// calendar date, not an instant, so there's no timezone handling anywhere
// here on purpose). Pure string/integer math only.

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

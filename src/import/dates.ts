// Shared date parsing for statement parsers. Pure: no I/O.

const US_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/**
 * Converts a US-style `M/D/YYYY` date (no zero-padding required, e.g.
 * "8/6/2026") into the `YYYY-MM-DD` string the rest of the app uses.
 * `null` for anything that doesn't match — callers push a skipped row.
 *
 * Originally private to becu.ts; pulled out here once aacu.ts needed the
 * identical logic — both are US bank exports using the same date shape.
 */
export function toIsoDate(raw: string): string | null {
  const match = US_DATE_RE.exec(raw.trim());
  if (!match) return null;
  const [, month, day, year] = match;
  return `${year}-${month!.padStart(2, '0')}-${day!.padStart(2, '0')}`;
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_MONTH_NAME_RE = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/;

/**
 * Converts a `DD-Mon-YYYY` date (e.g. "18-Aug-2026") into `YYYY-MM-DD`.
 * `null` for anything that doesn't match, including a well-shaped string
 * with a month name that isn't real ("18-Xyz-2026") — callers push a
 * skipped row rather than guessing.
 *
 * Vancity's export uses this shape; the US credit unions (becu, aacu) use
 * `M/D/YYYY` above, and Wise/Neo emit ISO already.
 */
export function toIsoDateFromDayMonthName(raw: string): string | null {
  const match = DAY_MONTH_NAME_RE.exec(raw.trim());
  if (!match) return null;
  const [, day, monthName, year] = match;
  const monthIndex = MONTH_NAMES.indexOf(monthName!.toLowerCase());
  if (monthIndex === -1) return null;
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${day!.padStart(2, '0')}`;
}

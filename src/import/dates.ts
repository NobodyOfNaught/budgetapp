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

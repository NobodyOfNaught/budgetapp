// Minor-unit helpers for the API boundary (accepting/displaying decimal
// amounts) — the ledger engine and schema only ever deal in integer minor
// units, never floats. MVP assumption, called out explicitly: every
// currency here uses 2 decimal places, matching the single-display-currency
// MVP scope. A real ISO 4217 minor-unit table (JPY has 0, some currencies
// have 3) is multi-currency phase-5 work, not needed while the app only
// ever shows one currency.

const DECIMAL_RE = /^-?\d+(\.\d{1,2})?$/;

/**
 * Parses a user-facing decimal string (e.g. "12.34", "-5", "0") into
 * integer minor units (1234, -500, 0). Throws on anything that isn't a
 * plain decimal with at most 2 fraction digits — callers should catch and
 * turn this into a 400, same pattern as the rest of the API.
 */
export function parseAmountToMinor(input: string): number {
  const trimmed = input.trim();
  if (!DECIMAL_RE.test(trimmed)) {
    throw new Error(`invalid amount: ${input}`);
  }
  const [whole, fraction = ''] = trimmed.replace('-', '').split('.');
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return trimmed.startsWith('-') ? -minor : minor;
}

/** Formats integer minor units as a fixed 2-decimal string — no currency symbol, that's a display concern. */
export function formatMinorAsDecimal(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

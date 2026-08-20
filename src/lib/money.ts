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

// ---------------------------------------------------------------------------
// Foreign-currency conversion — see accounts.fxRateMicros (src/db/schema.ts)
// and docs/plan.md's PR 15 notes. Integer rate, not float, for the same
// reason amounts are integer minor units: money math must never touch a
// float. A rate isn't money, but multiplying an integer minor-unit amount
// by one is, so the same discipline applies.
// ---------------------------------------------------------------------------

const RATE_SCALE = 1_000_000;
const RATE_RE = /^\d+(\.\d+)?$/;
// Generous but not unbounded — catches a fat-fingered "100" (meant "1.00")
// or a rate typed in the wrong direction without hand-picking real-world
// currency pairs.
const MAX_RATE = 1000;

/**
 * Parses a user-facing exchange-rate string (e.g. "0.73") into integer
 * micros (730000) — budget-currency per 1 unit of account currency. Throws
 * on non-numeric input, zero/negative (a rate of 0 or below isn't a
 * currency conversion, it's a bug), or anything above MAX_RATE.
 */
export function parseFxRateToMicros(input: string): number {
  const trimmed = input.trim();
  // Accept a comma as the decimal separator too (e.g. "0,73") — common
  // outside the US, and the alternative is rejecting it as invalid_fx_rate
  // with no indication of why, which is exactly what happened with a real
  // Neo import: the UI's generic "could not import" catch-all (see
  // ImportForm.tsx) gave no hint the actual problem was a comma. Only
  // normalized when the whole string is digits-comma-digits, so a
  // thousands-separator typo like "1,234" isn't silently reinterpreted.
  const normalized = /^\d+,\d+$/.test(trimmed) ? trimmed.replace(',', '.') : trimmed;
  if (!RATE_RE.test(normalized)) {
    throw new Error(`invalid exchange rate: ${input}`);
  }
  const rate = Number(normalized);
  if (rate <= 0 || rate > MAX_RATE) {
    throw new Error(`invalid exchange rate: ${input}`);
  }
  return Math.round(rate * RATE_SCALE);
}

/**
 * Converts a native-currency minor-unit amount into the budget's currency,
 * given a rate from parseFxRateToMicros. Rounds to the nearest minor unit
 * PER ROW (not accumulated pre-rounding across many rows) — see
 * src/routes/imports.ts, which calls this once per imported transaction,
 * matching how a real card statement's own USD-equivalent column would
 * round each charge independently.
 */
export function convertToBudgetMinor(amountMinor: number, fxRateMicros: number): number {
  return Math.round((amountMinor * fxRateMicros) / RATE_SCALE);
}

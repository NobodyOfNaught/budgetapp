// Normalised output of a statement parser — the shape src/routes/imports.ts
// turns into rows, independent of which provider produced it. Plain types
// with no drizzle/Cloudflare imports, matching src/domain/'s discipline, so
// every parser is testable as a pure string-in/data-out function.

/** A plain inflow or outflow on one account, in one currency. */
export interface ParsedOrdinary {
  kind: 'ordinary';
  /** Stable per-account dedupe key — becomes transactions.import_id. */
  importId: string;
  date: string; // 'YYYY-MM-DD'
  /** Signed, in `currencyCode`'s minor units. Negative is an outflow. */
  amountMinor: number;
  currencyCode: string;
  /** Merchant/counterparty as printed by the provider; stored verbatim in import_payee_raw. */
  payeeRaw: string | null;
  memo: string | null;
  /** The provider's own category label, if it had one — a suggestion only. */
  providerCategory: string | null;
}

/**
 * A movement between two of the user's own balances. Both legs are given
 * explicitly rather than derived, because a cross-currency conversion has
 * genuinely different magnitudes on each side and the effective rate IS the
 * ratio between them — see docs/plan.md on why no rate table is involved.
 */
export interface ParsedTransfer {
  kind: 'transfer';
  importId: string;
  date: string;
  /** Money leaving: negative, in `fromCurrencyCode`. */
  fromAmountMinor: number;
  fromCurrencyCode: string;
  /** Money arriving: positive, in `toCurrencyCode`. */
  toAmountMinor: number;
  toCurrencyCode: string;
  memo: string | null;
}

export type ParsedRow = ParsedOrdinary | ParsedTransfer;

/** A row the parser deliberately did not import, with the reason, so the UI can show it rather than silently losing it. */
export interface SkippedRow {
  /** The provider's own identifier for the row, for the user to look up. */
  reference: string;
  reason: string;
}

export interface ParseResult {
  rows: ParsedRow[];
  skipped: SkippedRow[];
  /** Every currency the file touches, so the caller knows which accounts it needs. */
  currencies: string[];
  /** Raw data-row count (excluding the header), for the batch summary. */
  rowCount: number;
}

/** A statement parser: file text in, normalised rows out. Pure. */
export type StatementParser = (csvText: string) => ParseResult;

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
  /**
   * Merchant/counterparty EXACTLY as the provider printed it (the full raw
   * description) — stored verbatim in import_payee_raw. This is what
   * src/import/rules.ts's payee_rules match against, deliberately BEFORE
   * any cleanup, so a rule can recover anything payeeName or the shared
   * cleanPayeeName heuristic (src/import/payee-name.ts) throws away.
   */
  payeeRaw: string | null;
  /**
   * The provider's own best attempt at a clean name — its own vocabulary
   * stripped (e.g. BECU's "POS Withdrawal - " prefix and "- Card Ending In
   * NNNN" suffix), nothing more. This is what the route layer
   * (src/routes/imports.ts) runs the SHARED cleanPayeeName heuristic over
   * when no rule matches; null when the provider has nothing better than
   * payeeRaw to offer. A provider whose own fields are already clean (Wise)
   * sets this equal to payeeRaw — see src/import/wise.ts.
   */
  payeeName: string | null;
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
  /**
   * Names discovered in the file that `options.members` can select among —
   * set only by providers whose file has no fixed participant list of its
   * own (Splitwise's per-person columns; see src/import/splitwise.ts).
   * Present (even with 0 rows imported) so the UI can offer the choice
   * BEFORE a real import via POST .../imports/inspect. Undefined for
   * providers where the concept doesn't apply (Wise, BECU).
   */
  participants?: string[];
}

/**
 * Per-provider import choices — currently just Splitwise's "whose expenses
 * belong to this budget". Optional and ignored by providers that don't use
 * it (Wise, BECU), which is what keeps this an additive widening of the
 * parser signature rather than a breaking one.
 */
export interface ImportOptions {
  members?: string[];
}

/**
 * A statement parser: file text (plus optional per-provider options) in,
 * normalised rows out. Pure.
 *
 * `fileText`, not `csvText` — most providers here are CSV, but OFX/QFX/QBO
 * is SGML (see src/import/ofx.ts), and the contract never cared which.
 */
export type StatementParser = (fileText: string, options?: ImportOptions) => ParseResult;

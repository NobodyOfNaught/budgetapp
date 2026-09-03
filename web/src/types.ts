// Mirrors the JSON shapes src/routes/auth.ts and src/routes/budgets.ts
// return. Kept as plain types here rather than imported from src/ — the
// Worker and the SPA are typechecked as separate programs (see
// tsconfig.web.json / tsconfig.worker.json) and only ever talk over HTTP.

export interface CurrentUser {
  id: string;
  email: string;
  displayName: string | null;
}

export interface BudgetSummary {
  id: string;
  name: string;
  currencyCode: string;
  role: 'owner' | 'editor' | 'viewer';
}

/** GET /budgets/:budgetId — the single budget, with settings the list endpoint doesn't carry. */
export interface BudgetDetail {
  id: string;
  name: string;
  currencyCode: string;
  /** 'YYYY-MM-DD', or null for no cutoff. Statement rows dated before it are skipped at import. */
  importCutoffDate: string | null;
}

export interface MeResponse {
  user: CurrentUser;
  budgets: BudgetSummary[];
}

export type ConsumeResponse =
  | { status: 'invalid' }
  | { status: 'expired' }
  | { status: 'needs_confirmation' }
  | { status: 'signed_in'; user: CurrentUser; budgetId: string };

export type AccountType =
  | 'checking'
  | 'savings'
  | 'cash'
  | 'credit_card'
  | 'line_of_credit'
  | 'tracking_asset'
  | 'tracking_liability';

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  onBudget: boolean;
  currencyCode: string;
  note: string | null;
  closedAt: number | null;
  sortOrder: number;
  importProvider: string | null;
  /** JSON string of ImportOptions (e.g. `{"members":[...]}`), remembered from the account's last import — see ImportForm.tsx. */
  importOptions: string | null;
  /** Budget-currency-per-1-unit-of-account-currency, x1,000,000 — null means no rate on file. See AccountForm.tsx/ImportForm.tsx. */
  fxRateMicros: number | null;
  /** 'YYYY-MM-DD' of the newest transaction on this account, or null when it has none. Unapproved rows count — see the accounts route. */
  lastTransactionDate: string | null;
}

export type CategoryKind = 'spending' | 'credit_card_payment' | 'income';

export interface Category {
  id: string;
  groupId: string;
  name: string;
  kind: CategoryKind;
  linkedAccountId: string | null;
  hiddenAt: number | null;
  sortOrder: number;
  note: string | null;
}

export interface CategoryGroup {
  id: string;
  name: string;
  isSystem: boolean;
  hiddenAt: number | null;
  sortOrder: number;
  categories: Category[];
}

export interface Payee {
  id: string;
  name: string;
  transferAccountId: string | null;
}

export type ClearedStatus = 'uncleared' | 'cleared' | 'reconciled';

/**
 * The subset of a transaction's fields TransactionForm actually needs to
 * prefill an edit (id, date, amount, payee, category, memo, cleared,
 * transfer/split shape). Both RegisterTransaction and ReviewTransaction
 * are supersets of this, so either can be passed to TransactionForm's
 * `editing` prop without a cast — the form itself has never needed to
 * know which screen it was opened from.
 */
export interface EditableTransaction {
  id: string;
  date: string;
  amountMinor: number;
  categoryId: string | null;
  payeeName: string | null;
  memo: string | null;
  cleared: ClearedStatus;
  transferAccountId: string | null;
  isSplit: boolean;
}

export interface RegisterTransaction extends EditableTransaction {
  payeeId: string | null;
  /** false for statement-imported rows still awaiting review — see ReviewImport.tsx. */
  approved: boolean;
  balance: number;
}

export interface RegisterResponse {
  accountBalance: number;
  clearedBalance: number;
  total: number;
  transactions: RegisterTransaction[];
}

// Mirrors src/domain/types.ts's CategoryMonthResult / MonthResult, as
// returned by GET/PUT /budgets/:id/months/:month — see src/routes/months.ts.
export interface CategoryMonthAmounts {
  assigned: number;
  activity: number;
  available: number;
}

export type TargetIntervalUnit = 'week' | 'month' | 'year' | 'once';
export type TargetStatus = 'funded' | 'short' | 'building';

// Mirrors src/domain/types.ts's TargetResult, embedded in MonthView, and
// src/routes/targets.ts's TargetView (the raw stored target from GET/PUT
// .../targets), which is a slightly different, string-amount shape.
export interface TargetResultView {
  categoryId: string;
  amountMinor: number;
  neededMinor: number;
  nextDueDate: string | null;
  status: TargetStatus;
}

export interface MonthView {
  month: string;
  readyToAssign: number;
  categories: Record<string, CategoryMonthAmounts>;
  targets: Record<string, TargetResultView>;
  /**
   * Balances at the END of this month, in the budget's currency. Under the
   * unified card model these close exactly:
   * `cashOnHandMinor === readyToAssign + sum(category available)`. See the
   * doc comment on src/routes/months.ts's MonthView.
   */
  cashOnHandMinor: number;
  creditDebtMinor: number;
  /**
   * Uncategorized spending on credit accounts this month — negative for a
   * charge. It comes off Ready to Assign (and earmarks the same amount
   * against the card), so it's what explains a negative Ready to Assign.
   * Kept apart from income: see src/domain/types.ts's MonthResult.
   */
  unbudgetedCardSpending: number;
}

/** GET/PUT /budgets/:id/targets(/:categoryId) — the raw stored target, decimal amount like everywhere else at the API boundary. */
export interface TargetView {
  categoryId: string;
  amount: string;
  intervalUnit: TargetIntervalUnit;
  intervalCount: number;
  dueDate: string | null;
}

/** One entry from GET /budgets/:id/upcoming — a real calendar occurrence, independent of month boundaries. */
export interface UpcomingOccurrence {
  categoryId: string;
  categoryName: string;
  dueDate: string;
  amountMinor: number;
  lastPaidDate: string | null;
}

// ---------------------------------------------------------------------------
// Statement import — mirrors src/routes/imports.ts. See src/import/ for the
// per-provider parsers these shapes come out of.
// ---------------------------------------------------------------------------

export interface ImportSkippedRow {
  reference: string;
  reason: string;
}

export interface ImportReconciliation {
  accountName: string;
  statementBalanceMinor: number;
  accountBalanceMinor: number;
  /** account minus statement. Zero means the two agree exactly. */
  differenceMinor: number;
  currencyCode: string;
  asOfDate: string | null;
  /** Rows the cutoff held back, which is the most common innocent explanation for a difference. */
  rowsHeldBackByCutoff: number;
}

export interface ImportSummary {
  batchId: string;
  rowCount: number;
  imported: number;
  duplicates: number;
  /**
   * Rows held back by the import cutoff, and the cutoff that did it.
   * Reported apart from `skipped` because it's a guard working as asked,
   * not a row the parser couldn't handle. See src/routes/imports.ts.
   */
  beforeCutoff: number;
  cutoffDate: string | null;
  skipped: ImportSkippedRow[];
  /** Currency sub-accounts the file turned out to need, created on the fly. */
  accountsCreated: string[];
  /**
   * The account's balance after the import against the balance the bank
   * itself reported in the file (OFX/QFX `<LEDGERBAL>`). Null when the
   * format carries no balance — every CSV provider. See
   * reconcileAgainstStatement in src/routes/imports.ts.
   */
  reconciliation: ImportReconciliation | null;
}

/**
 * A row that could be the other half of this one, from
 * GET .../transactions/:id/transfer-candidates — opposite amount, different
 * account, dated within a few days. See src/routes/transactions.ts.
 */
export interface TransferCandidate {
  id: string;
  accountId: string;
  accountName: string;
  date: string;
  amountMinor: number;
  currencyCode: string;
  memo: string | null;
  importPayeeRaw: string | null;
  /**
   * True when this leg is in a different currency from the row being
   * linked. Same-currency matches are exact offsets; cross-currency ones
   * can only ever be close, so they're surfaced as such rather than
   * presented with the same confidence. See src/routes/transactions.ts's
   * CROSS_CURRENCY_TOLERANCE.
   */
  approximate: boolean;
  /**
   * For a same-currency pair, how much of the outflow never arrived — a
   * wire or conversion fee taken in transit. Linking books it as its own
   * transaction in the paying account rather than letting it vanish from
   * the budget. 0 for an exact match and for every cross-currency
   * candidate. See src/routes/transactions.ts's sameCurrencyFeeMinor.
   */
  feeMinor: number;
}

/** One past import run — GET .../imports. What DELETE .../imports/:batchId undoes. */
export interface ImportBatch {
  id: string;
  accountId: string;
  accountName: string;
  provider: string;
  filename: string;
  rowCount: number;
  importedCount: number;
  skippedCount: number;
  createdAt: number;
}

/**
 * DELETE .../imports/:batchId's response. `removed` can exceed the
 * batch's own row count — undoing cascades to a transfer sibling (or its
 * carved-out fee) wherever it lives, including outside this batch, the
 * same way deleting either leg by hand already does. `removedOutsideBatch`
 * is how many of those there were.
 */
export interface UndoImportResult {
  removed: number;
  approvedRemoved: number;
  removedOutsideBatch: number;
}

/** One row awaiting review — imported but not yet approved. */
export interface ReviewTransaction {
  id: string;
  date: string;
  amountMinor: number;
  currencyCode: string;
  categoryId: string | null;
  memo: string | null;
  cleared: ClearedStatus;
  /** false for a row still awaiting review. Always false in the default query; only varies when fetched with includeApproved. */
  approved: boolean;
  /** True for a split parent — its children (not returned here) carry the real per-category amounts. See Register.tsx's identical flag. */
  isSplit: boolean;
  accountId: string;
  accountName: string;
  payeeName: string | null;
  importPayeeRaw: string | null;
  transferAccountId: string | null;
  /**
   * The other leg of the transfer, when this row is one. Its amount is
   * shown alongside this row's rather than assumed to be the mirror
   * image: across currencies the two legs are different numbers by
   * definition, and within one currency they can differ by a fee taken in
   * transit. All null when the row isn't a transfer.
   */
  transferAccountName: string | null;
  transferDate: string | null;
  transferAmountMinor: number | null;
  transferCurrencyCode: string | null;
  /**
   * The transfer leg this row is a carved-out fee of — see
   * src/routes/transactions.ts's link-transfer. All null for anything
   * that isn't a fee row.
   */
  feeForAccountName: string | null;
  feeForDate: string | null;
  feeForAmountMinor: number | null;
  feeForCurrencyCode: string | null;
}

// ---------------------------------------------------------------------------
// Reports — mirrors src/routes/reports.ts. Category/group names aren't sent
// by these endpoints (the client already has them via categoryGroups, same
// pattern as Register.tsx's categoryNameById), so responses carry ids only.
// ---------------------------------------------------------------------------

export interface SpendingReport {
  start: string;
  end: string;
  categories: { categoryId: string; spentMinor: number }[];
}

export interface IncomeExpenseReport {
  months: { month: string; incomeMinor: number; expenseMinor: number }[];
}

/** Shared by NetWorthReport and NetWorthDailyReport — see src/domain/reports.ts's `unvaluedForeignAccounts`. */
export interface UnvaluedAccount {
  accountId: string;
  name: string;
  currencyCode: string;
}

export interface NetWorthReport {
  months: { month: string; assetsMinor: number; liabilitiesMinor: number; netWorthMinor: number }[];
  /**
   * Foreign-currency accounts with no exchange rate on file. Their balance
   * couldn't be revalued, so it's still an accumulated sum of each
   * transaction's own conversion — a figure that isn't really the value of
   * anything. Surfaced so the UI can say so. See src/domain/reports.ts.
   */
  unvalued: UnvaluedAccount[];
}

/** Same report, day granularity — see GET .../reports/net-worth/daily. */
export interface NetWorthDailyReport {
  days: { date: string; assetsMinor: number; liabilitiesMinor: number; netWorthMinor: number }[];
  unvalued: UnvaluedAccount[];
}

// ---------------------------------------------------------------------------
// Payee rules — mirrors src/routes/payee-rules.ts. Overrides the generic
// cleanPayeeName heuristic (src/import/payee-name.ts) for any provider's
// import, matched against a row's raw statement text (ReviewTransaction's
// importPayeeRaw above) rather than its cleaned-up payeeName.
// ---------------------------------------------------------------------------

export interface PayeeRule {
  id: string;
  matchText: string;
  payeeName: string;
  categoryId: string | null;
}

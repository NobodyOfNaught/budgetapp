// Plain, dependency-free types for the ledger engine's inputs and outputs.
// Deliberately NOT imported from src/db/schema.ts — the domain layer stays
// free of drizzle-orm (or any Cloudflare/DB import) so it's testable as
// pure functions over plain arrays. See docs/plan.md's "ledger engine"
// section.
//
// Scope boundary: this module computes category-level budget math only —
// assigned/activity/available per category, per month, and the running
// Ready to Assign balance. Account BALANCES (summing transactions per
// account) are simple enough to do with SQL directly wherever they're
// needed and aren't part of this module. Category lifecycle (hidden/
// deleted/created-mid-history) is a presentation concern layered on top by
// the caller — this engine computes a result for every category it's given,
// for every month in range, and leaves filtering to whoever calls it.

export type AccountKind =
  | 'checking'
  | 'savings'
  | 'cash'
  | 'credit_card'
  | 'line_of_credit'
  | 'tracking_asset'
  | 'tracking_liability';

export const CREDIT_ACCOUNT_KINDS: ReadonlySet<AccountKind> = new Set(['credit_card', 'line_of_credit']);

export interface AccountRow {
  id: string;
  type: AccountKind;
  onBudget: boolean;
}

export type CategoryKind = 'spending' | 'credit_card_payment' | 'income';

export interface CategoryRow {
  id: string;
  kind: CategoryKind;
  /** Set only for kind === 'credit_card_payment' — the account it earmarks payment for. */
  linkedAccountId: string | null;
}

export interface CategoryMonthRow {
  categoryId: string;
  month: string; // 'YYYY-MM-01'
  assignedMinor: number;
}

export interface TransactionRow {
  id: string;
  accountId: string;
  date: string; // 'YYYY-MM-DD'
  /** Signed, already converted to the budget's display currency — see docs/plan.md. */
  budgetAmountMinor: number;
  categoryId: string | null;
  /** Set on both legs of a transfer. Which account the other leg is on doesn't matter to this engine. */
  transferTransactionId: string | null;
  /** Set on split children. The parent itself is excluded from ledger math — its children carry it. */
  parentTransactionId: string | null;
  deletedAt: number | null;
}

export interface CategoryMonthResult {
  categoryId: string;
  assigned: number;
  activity: number;
  available: number;
}

export interface MonthResult {
  month: string;
  /** Running Ready to Assign balance as of the end of this month. */
  readyToAssign: number;
  categories: Record<string, CategoryMonthResult>;
}

export interface LedgerInput {
  accounts: AccountRow[];
  categories: CategoryRow[];
  categoryMonths: CategoryMonthRow[];
  transactions: TransactionRow[];
  /** Compute the fold-forward through and including this month. */
  throughMonth: string;
}

export interface LedgerResult {
  /** One entry per month from the earliest relevant month through `throughMonth`, chronological. */
  months: MonthResult[];
}

// ---------------------------------------------------------------------------
// Targets — a category's funding obligation. See src/domain/targets.ts for
// the derivation ("how much should I assign this month", "when's this next
// due"). Deliberately its own module rather than folded into computeLedger:
// the ledger is the record of what happened; targets are a standing rule
// layered on top of that record, and neither needs the other's internals.
// ---------------------------------------------------------------------------

export type IntervalUnit = 'week' | 'month' | 'year' | 'once';

export interface TargetRow {
  categoryId: string;
  amountMinor: number;
  intervalUnit: IntervalUnit;
  /** Ignored when intervalUnit is 'once'. */
  intervalCount: number;
  /** 'YYYY-MM-DD'. The first-ever occurrence for a recurring target, the
   * deadline for a one-time target, or null for an open-ended savings goal
   * with no deadline at all (only valid when intervalUnit is 'once'). */
  dueDate: string | null;
}

export type TargetStatus = 'funded' | 'short' | 'building';

export interface TargetResult {
  categoryId: string;
  /** The raw target amount, carried through for display next to `neededMinor`. */
  amountMinor: number;
  /** How much more to assign THIS month to stay on track. Falls to 0 as the
   * user assigns — see computeTargets for the per-recurrence formulas. */
  neededMinor: number;
  /** First occurrence on or after the start of the month being computed,
   * or null for a 'building' target, or an elapsed one-time target. */
  nextDueDate: string | null;
  status: TargetStatus;
}

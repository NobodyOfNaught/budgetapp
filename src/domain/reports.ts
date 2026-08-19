// Net worth trending. Pure functions over plain arrays — same discipline as
// ledger.ts/targets.ts. See docs/plan.md's "The ledger engine" scope-boundary
// note: a single point-in-time account balance is simple enough to do with
// SQL directly and isn't part of the domain layer, but a TREND across many
// months is a fold (each month's snapshot depends on every row before it,
// same shape as computeLedger's carryover), so it earns one small pure
// function here rather than N ad hoc per-month SQL aggregations at the route
// layer. Spending-by-category and income-vs-expense need no equivalent —
// they're built directly on top of computeLedger's own per-month output at
// the route layer (src/routes/reports.ts) rather than duplicated here, since
// computeLedger already computes exactly those numbers correctly.

import { nextMonth } from '../lib/dates';
import { CREDIT_ACCOUNT_KINDS, type AccountKind } from './types';

/** Liability account kinds for net-worth classification — credit accounts
 * (already used for the payment-category mechanic) plus tracking_liability,
 * which has no ledger role but is still debt. */
const LIABILITY_ACCOUNT_KINDS: ReadonlySet<AccountKind> = new Set([
  ...CREDIT_ACCOUNT_KINDS,
  'tracking_liability',
]);

export interface AccountBalanceRow {
  accountId: string;
  date: string; // 'YYYY-MM-DD'
  budgetAmountMinor: number;
}

export interface NetWorthAccountRow {
  id: string;
  type: AccountKind;
}

export interface NetWorthPoint {
  month: string; // 'YYYY-MM-01'
  /** Sum of balances for non-liability accounts, as of this month's last day. */
  assetsMinor: number;
  /** Sum of balances for liability accounts (credit cards, lines of credit,
   * tracking liabilities) — naturally negative, since an outflow/balance-owed
   * is negative throughout this schema. */
  liabilitiesMinor: number;
  /** assetsMinor + liabilitiesMinor. */
  netWorthMinor: number;
}

/**
 * Folds every transaction row forward once, snapshotting a running
 * per-account balance at the end of each month in `months`. `months` must be
 * ascending 'YYYY-MM-01' strings (see src/lib/dates.ts's monthRange) — every
 * row dated before a given month's end contributes to that month's
 * snapshot, whether or not it falls in an earlier month than the first
 * requested one (a balance carries forward from history the caller didn't
 * ask to see individually). An account absent from `accounts` (a data gap)
 * is silently excluded from both totals, same defensive posture as
 * computeLedger's unknown-counterpart handling.
 */
export function netWorthTrend(
  rows: AccountBalanceRow[],
  accounts: NetWorthAccountRow[],
  months: string[],
): NetWorthPoint[] {
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const balanceByAccount = new Map<string, number>();
  let rowIndex = 0;
  const points: NetWorthPoint[] = [];

  for (const month of months) {
    const monthEndExclusive = nextMonth(month); // first day of the FOLLOWING month
    while (rowIndex < sorted.length && sorted[rowIndex]!.date < monthEndExclusive) {
      const row = sorted[rowIndex]!;
      balanceByAccount.set(row.accountId, (balanceByAccount.get(row.accountId) ?? 0) + row.budgetAmountMinor);
      rowIndex++;
    }

    let assetsMinor = 0;
    let liabilitiesMinor = 0;
    for (const [accountId, balance] of balanceByAccount) {
      const account = accountsById.get(accountId);
      if (!account) continue;
      if (LIABILITY_ACCOUNT_KINDS.has(account.type)) liabilitiesMinor += balance;
      else assetsMinor += balance;
    }

    points.push({ month, assetsMinor, liabilitiesMinor, netWorthMinor: assetsMinor + liabilitiesMinor });
  }

  return points;
}

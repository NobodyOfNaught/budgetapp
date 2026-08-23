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

import { addDays, nextMonth } from '../lib/dates';
import { convertToBudgetMinor } from '../lib/money';
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
  /** Native amount, in the ACCOUNT's currency. What a foreign account's balance is revalued from — see netWorthTrend. */
  amountMinor: number;
  /** Per-transaction conversion into the budget's currency. Only used for an account this function can't revalue (see the no-rate fallback below). */
  budgetAmountMinor: number;
}

export interface NetWorthAccountRow {
  id: string;
  type: AccountKind;
  currencyCode: string;
  /** Budget-currency-per-1-unit-of-account-currency, x1,000,000 (migrations/0007). null = no rate on file. */
  fxRateMicros: number | null;
}

export interface NetWorthSnapshot {
  /** Sum of balances for non-liability accounts, as of this snapshot's date. */
  assetsMinor: number;
  /** Sum of balances for liability accounts (credit cards, lines of credit,
   * tracking liabilities) — naturally negative, since an outflow/balance-owed
   * is negative throughout this schema. */
  liabilitiesMinor: number;
  /** assetsMinor + liabilitiesMinor. */
  netWorthMinor: number;
}

export interface NetWorthPoint extends NetWorthSnapshot {
  month: string; // 'YYYY-MM-01'
}

export interface NetWorthDailyPoint extends NetWorthSnapshot {
  date: string; // 'YYYY-MM-DD'
}

/**
 * Snapshots a running per-account balance at the end of each month in
 * `months` (ascending 'YYYY-MM-01' strings — see src/lib/dates.ts's
 * monthRange). A thin wrapper over foldNetWorthSnapshots below, which does
 * the actual folding and carries the doc comment on how a balance gets
 * revalued; this function only decides the snapshot granularity (month
 * boundaries) and re-attaches each month's label to its snapshot.
 */
export function netWorthTrend(
  rows: AccountBalanceRow[],
  accounts: NetWorthAccountRow[],
  months: string[],
  budgetCurrencyCode: string,
): NetWorthPoint[] {
  // month-end-exclusive: the first day of the FOLLOWING month.
  const snapshots = foldNetWorthSnapshots(rows, accounts, months.map(nextMonth), budgetCurrencyCode);
  return months.map((month, i) => ({ month, ...snapshots[i]! }));
}

/**
 * Same fold as netWorthTrend, one snapshot per exact calendar day instead
 * of per month — for the "daily net worth" view, where the reader picks
 * exact days rather than months. `dates` must be ascending 'YYYY-MM-DD'
 * strings (see src/lib/dates.ts's dateRange). Shares foldNetWorthSnapshots
 * with the monthly version rather than a second copy of the revaluation
 * logic — the only difference is the granularity of the snapshot boundary
 * (day-end-exclusive here vs. month-end-exclusive there).
 */
export function netWorthDailyTrend(
  rows: AccountBalanceRow[],
  accounts: NetWorthAccountRow[],
  dates: string[],
  budgetCurrencyCode: string,
): NetWorthDailyPoint[] {
  // day-end-exclusive: the day immediately after.
  const snapshots = foldNetWorthSnapshots(rows, accounts, dates.map((d) => addDays(d, 1)), budgetCurrencyCode);
  return dates.map((date, i) => ({ date, ...snapshots[i]! }));
}

/**
 * The fold shared by netWorthTrend and netWorthDailyTrend. `exclusiveUpperBounds`
 * is an ascending list of 'YYYY-MM-DD' dates, each meaning "every row
 * strictly before this date belongs to this snapshot" — the caller decides
 * the granularity (month-end-exclusive vs. day-end-exclusive) by how it
 * builds this list; the fold itself doesn't know or care which.
 *
 * FOREIGN-CURRENCY ACCOUNTS ARE REVALUED, NOT ACCUMULATED. A balance is
 * worth what it converts to at ONE rate today — not the sum of what each
 * transaction was worth on its own day. Summing per-transaction
 * conversions (which is what this function used to do) doesn't produce the
 * value of anything: buy CAD 100 at 0.70 and sell CAD 100 at 0.80 and the
 * accumulated figure says -$10 for an account holding nothing at all. So
 * for an account whose currency isn't the budget's, this folds the NATIVE
 * amounts and converts the resulting balance once, per snapshot. Per-
 * transaction conversion stays correct for what it's actually for —
 * category activity in src/domain/ledger.ts, where historical cost IS the
 * right answer, because what spending cost you doesn't change when the
 * rate moves afterwards. Flow is historical; stock is current.
 *
 * Two consequences worth knowing. Applying today's rate to every snapshot
 * means past ones RESTATE as the rate moves — inherent to revaluing with a
 * single stored rate, and still strictly better than accumulating an
 * artifact. And a foreign account with NO rate can't be revalued at all,
 * so it falls back to the old accumulated sum; the route reports those
 * accounts (see unvaluedForeignAccounts below) so the UI can say the
 * number is an estimate rather than present it as fact.
 *
 * An account absent from `accounts` (a data gap) is silently excluded from
 * both totals, same defensive posture as computeLedger's unknown-
 * counterpart handling.
 */
function foldNetWorthSnapshots(
  rows: AccountBalanceRow[],
  accounts: NetWorthAccountRow[],
  exclusiveUpperBounds: string[],
  budgetCurrencyCode: string,
): NetWorthSnapshot[] {
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Both running sums are kept per account: `native` is what a foreign
  // account gets revalued from, `budget` is the fallback for one that
  // can't be revalued. For an account already in the budget's currency the
  // two are equal by construction (insertTransaction defaults
  // budgetAmountMinor to amountMinor), so that branch is a no-op.
  const balanceByAccount = new Map<string, { native: number; budget: number }>();
  let rowIndex = 0;
  const snapshots: NetWorthSnapshot[] = [];

  for (const bound of exclusiveUpperBounds) {
    while (rowIndex < sorted.length && sorted[rowIndex]!.date < bound) {
      const row = sorted[rowIndex]!;
      const running = balanceByAccount.get(row.accountId) ?? { native: 0, budget: 0 };
      running.native += row.amountMinor;
      running.budget += row.budgetAmountMinor;
      balanceByAccount.set(row.accountId, running);
      rowIndex++;
    }

    let assetsMinor = 0;
    let liabilitiesMinor = 0;
    for (const [accountId, balance] of balanceByAccount) {
      const account = accountsById.get(accountId);
      if (!account) continue;
      // Keyed off the CURRENCY, not merely off having a rate: nothing stops
      // a rate being stored on an account that's already in the budget's
      // currency (src/routes/accounts.ts parses fxRate regardless), and
      // applying one there would silently scale a balance that needs no
      // conversion at all.
      const isForeign = account.currencyCode !== budgetCurrencyCode;
      const value =
        isForeign && account.fxRateMicros !== null
          ? convertToBudgetMinor(balance.native, account.fxRateMicros)
          : balance.budget;
      if (LIABILITY_ACCOUNT_KINDS.has(account.type)) liabilitiesMinor += value;
      else assetsMinor += value;
    }

    snapshots.push({ assetsMinor, liabilitiesMinor, netWorthMinor: assetsMinor + liabilitiesMinor });
  }

  return snapshots;
}

/**
 * The accounts netWorthTrend could not revalue: foreign currency, no rate
 * on file, so their contribution is still the accumulated per-transaction
 * sum rather than a real conversion of the balance. Surfaced by the route
 * (see src/routes/reports.ts) so the UI can mark the figure an estimate
 * and prompt for a rate, instead of presenting a number nothing stands
 * behind. Only accounts that actually hold rows are reported — an empty
 * account contributes 0 either way, so there is nothing to caveat.
 */
export function unvaluedForeignAccounts<T extends NetWorthAccountRow>(
  rows: AccountBalanceRow[],
  accounts: T[],
  budgetCurrencyCode: string,
): T[] {
  const withRows = new Set(rows.map((r) => r.accountId));
  return accounts.filter(
    (a) => a.currencyCode !== budgetCurrencyCode && a.fxRateMicros === null && withRows.has(a.id),
  );
}

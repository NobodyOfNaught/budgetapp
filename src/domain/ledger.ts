// The ledger engine. Pure functions over plain arrays — no I/O, no
// Cloudflare imports, nothing async. See docs/plan.md's "The ledger engine"
// section for the formulas this implements; this file is the executable
// version of that spec, and test/domain/ledger.test.ts is what proves it
// matches.

import { compareMonths, monthOf, monthRange } from '../lib/dates';
import {
  CREDIT_ACCOUNT_KINDS,
  type AccountRow,
  type CategoryMonthResult,
  type CategoryRow,
  type LedgerInput,
  type LedgerResult,
  type MonthResult,
  type TransactionRow,
} from './types';

/**
 * Computes every month's category activity/available and the running Ready
 * to Assign balance, from the earliest month touched by any transaction or
 * assignment up through `input.throughMonth`. Carryover and Ready to Assign
 * both depend on the PRECEDING month's numbers, so this is fundamentally a
 * fold, not something that can be computed for a single month in isolation
 * without walking everything before it.
 */
export function computeLedger(input: LedgerInput): LedgerResult {
  const liveTransactions = input.transactions.filter(
    (t) => t.deletedAt === null && compareMonths(monthOf(t.date), input.throughMonth) <= 0,
  );
  const categoryMonths = input.categoryMonths.filter((cm) => compareMonths(cm.month, input.throughMonth) <= 0);

  // Split PARENTS are a register-display artifact (one line for the whole
  // amount) — their children carry the real per-category portions, so
  // parents are excluded entirely from ledger math. A parent has
  // categoryId === null by construction, so without this exclusion it
  // would otherwise be misread as an "uncategorized" transaction below.
  const parentIds = new Set(
    liveTransactions.map((t) => t.parentTransactionId).filter((id): id is string => id !== null),
  );
  const ledgerRows = liveTransactions.filter((t) => !parentIds.has(t.id));

  const accountsById = new Map(input.accounts.map((a) => [a.id, a]));
  const categoriesById = new Map(input.categories.map((c) => [c.id, c]));
  const paymentCategoryByAccountId = new Map(
    input.categories
      .filter((c) => c.kind === 'credit_card_payment' && c.linkedAccountId !== null)
      .map((c) => [c.linkedAccountId as string, c.id]),
  );

  const months = monthRangeFor(ledgerRows, categoryMonths, input.throughMonth);

  const rowsByMonth = groupBy(ledgerRows, (t) => monthOf(t.date));
  const assignedByMonth = groupBy(categoryMonths, (cm) => cm.month);

  const prevAvailable = new Map<string, number>(); // categoryId -> available at end of previous month
  let readyToAssign = 0;
  const results: MonthResult[] = [];

  for (const month of months) {
    const { activityByCategory, incomeThisMonth, unbudgetedCardSpending } = accumulateMonth(
      rowsByMonth.get(month) ?? [],
      accountsById,
      categoriesById,
      paymentCategoryByAccountId,
    );

    const assignedThisMonth = new Map((assignedByMonth.get(month) ?? []).map((cm) => [cm.categoryId, cm.assignedMinor]));

    let totalAssigned = 0;
    let cashOverspendingRealized = 0;
    const categories: Record<string, CategoryMonthResult> = {};

    for (const category of input.categories) {
      const assigned = assignedThisMonth.get(category.id) ?? 0;
      totalAssigned += assigned;

      const prior = prevAvailable.get(category.id) ?? 0;
      let carryover: number;
      if (prior >= 0) {
        carryover = prior;
      } else if (category.kind === 'credit_card_payment') {
        // A payment category carries what is owed on its card, and every
        // charge now earmarks INTO it (see accumulateMonth), so it is
        // normally positive and this branch rarely fires. When it does,
        // negative means the card was OVERPAID — more money sent than was
        // owed — which is not cash overspending and must not be clawed
        // back from next month's Ready to Assign. Resetting it would also
        // break the identity the category rests on:
        // available = -(card balance) + assigned.
        carryover = prior;
      } else {
        // Spent cash you hadn't budgeted for. The shortfall must come from
        // somewhere real: reset this category to 0 and pull the gap out of
        // next month's Ready to Assign instead of pretending it vanished.
        carryover = 0;
        cashOverspendingRealized += -prior;
      }

      const activity = activityByCategory.get(category.id) ?? 0;
      const available = carryover + assigned + activity;
      categories[category.id] = { categoryId: category.id, assigned, activity, available };
      prevAvailable.set(category.id, available);
    }

    // unbudgetedCardSpending is negative for a charge: spending on a card
    // without a category draws on Ready to Assign, exactly as the same
    // spending would from a cash account. It is added rather than
    // subtracted because it already carries the transaction's own sign.
    readyToAssign =
      readyToAssign + incomeThisMonth + unbudgetedCardSpending - totalAssigned - cashOverspendingRealized;
    results.push({ month, readyToAssign, incomeThisMonth, unbudgetedCardSpending, categories });
  }

  return { months: results };
}

function monthRangeFor(
  transactions: TransactionRow[],
  categoryMonths: { month: string }[],
  throughMonth: string,
): string[] {
  let earliest: string | undefined;
  for (const t of transactions) {
    const m = monthOf(t.date);
    if (earliest === undefined || compareMonths(m, earliest) < 0) earliest = m;
  }
  for (const cm of categoryMonths) {
    if (earliest === undefined || compareMonths(cm.month, earliest) < 0) earliest = cm.month;
  }
  return monthRange(earliest ?? throughMonth, throughMonth);
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}

/**
 * The core per-row rules. Every row is judged independently on three
 * things: is its account on-budget, is it categorized, and — the one that
 * makes credit cards work — is its account a credit account. See
 * docs/plan.md's "The ledger engine" section for the formulas; the
 * reasoning behind each branch's SIGN is spelled out below because it is
 * genuinely not obvious and was the easiest part of this file to get
 * backwards.
 */
function accumulateMonth(
  rows: TransactionRow[],
  accountsById: Map<string, AccountRow>,
  categoriesById: Map<string, CategoryRow>,
  paymentCategoryByAccountId: Map<string, string>,
): { activityByCategory: Map<string, number>; incomeThisMonth: number; unbudgetedCardSpending: number } {
  const activityByCategory = new Map<string, number>();
  const add = (categoryId: string, amount: number) =>
    activityByCategory.set(categoryId, (activityByCategory.get(categoryId) ?? 0) + amount);

  let incomeThisMonth = 0;
  // Kept apart from incomeThisMonth deliberately. Both fold into Ready to
  // Assign, but incomeThisMonth is ALSO the income line of the
  // income-vs-expense report (src/routes/reports.ts) — folding card
  // spending into it would render card debt as negative income.
  let unbudgetedCardSpending = 0;

  for (const row of rows) {
    const account = accountsById.get(row.accountId);
    if (!account || !account.onBudget) continue; // tracking accounts: no ledger effect at all

    const isCredit = CREDIT_ACCOUNT_KINDS.has(account.type);
    const isTransfer = row.transferTransactionId !== null;

    if (row.categoryId !== null) {
      const category = categoriesById.get(row.categoryId);
      if (!category) continue; // defensive — shouldn't happen with valid input

      if (category.kind === 'income') {
        incomeThisMonth += row.budgetAmountMinor;
        continue;
      }

      // 'spending' or 'credit_card_payment' categorization: the plain,
      // direct rule. A $50 outflow categorized here reduces this
      // category's available by $50, full stop — this is also exactly how
      // paying a credit card works (the checking-side leg, categorized to
      // the payment category, outflow, drains it — no different from
      // spending against any other category).
      add(category.id, row.budgetAmountMinor);

      // The credit-card mechanic: a SPENDING-categorized purchase on a
      // credit account ALSO earmarks the offsetting amount in that card's
      // payment category, with the OPPOSITE sign of the transaction. A -$50
      // purchase categorized to Groceries contributes +$50 here — money
      // that was "available" in Groceries has effectively moved to
      // "available to pay the card", since you didn't actually spend cash.
      // A +$30 refund (reversing part of a purchase) contributes -$30:
      // less is owed, so less needs to be earmarked. This is what keeps
      // "sum of all categories' available" from silently drifting when
      // spending happens on credit instead of cash — the purchase and its
      // doubling are a wash across the two categories.
      if (category.kind === 'spending' && isCredit) {
        const paymentCategoryId = paymentCategoryByAccountId.get(account.id);
        if (paymentCategoryId) add(paymentCategoryId, -row.budgetAmountMinor);
      }
      continue;
    }

    // Uncategorized. A transfer with no explicit category between two
    // ON-BUDGET accounts (checking -> savings) means exactly what it looks
    // like: money moving within the budget, no category or Ready to Assign
    // effect either way. Critically, this is also what keeps a credit-card
    // PAYMENT from being double-counted: the card-side leg of a payment is
    // an uncategorized transfer between two on-budget accounts, so it
    // contributes nothing — only the checking-side leg (categorized to the
    // payment category, handled above) drains the earmark.
    //
    // A transfer crossing the on-budget/off-budget boundary is a different
    // thing entirely, and gets the opposite treatment: money arriving from
    // a tracking account (an investment withdrawal, or — see src/import/ —
    // a foreign-currency balance converted into the budget's currency) is
    // NEW money to assign, and money sent out to one has left the budget.
    // Both are Ready to Assign movements, exactly like an uncategorized
    // inflow/outflow on an ordinary account, which is what the
    // `incomeThisMonth` line below already does for the non-transfer case.
    if (isTransfer) {
      const counterpart = row.transferAccountId !== null ? accountsById.get(row.transferAccountId) : undefined;
      // Unknown counterpart stays a no-op rather than guessing — inventing
      // Ready to Assign out of a data gap is the worse failure.
      if (counterpart && !counterpart.onBudget) {
        incomeThisMonth += row.budgetAmountMinor;
      }
      continue;
    }

    if (isCredit) {
      // Uncategorized card activity — a charge nobody has filed yet, or
      // most often a starting balance, debt that existed before this
      // budget did. It takes the SAME shape as the categorized purchase
      // above: the amount lands in a bucket, and the card's payment
      // category gets the opposite.
      //
      // The only difference is which bucket. A categorized purchase draws
      // on its spending category; an uncategorized one has no category to
      // draw on, so it draws on Ready to Assign — which is precisely what
      // "uncategorized" means everywhere else in this function.
      //
      // This branch used to add the amount to the payment category
      // UNDOUBLED, on the reasoning that a -$100 starting balance should
      // read -$100 there ("prompting the user to assign real money to
      // cover it — never +$100, which would conjure spendable-looking
      // money"). The concern was right; the remedy put two opposite sign
      // conventions in one category. A purchase adds a POSITIVE earmark,
      // raw debt added NEGATIVE debt, and a card payment has to drain the
      // first while leaving the second alone — with nothing in the payment
      // itself to say which it is paying. That is unresolvable, and it is
      // why sum(on-budget balances) never quite equalled
      // readyToAssign + sum(available).
      //
      // Doubling instead conjures nothing: the +$100 earmark is matched by
      // -$100 off Ready to Assign, so the pair nets to zero and the
      // shortfall shows up as Ready to Assign going negative — which is
      // the honest reading of owing money you never budgeted for. See
      // docs/plan.md's PR 18 notes for the worked comparison.
      unbudgetedCardSpending += row.budgetAmountMinor;
      const paymentCategoryId = paymentCategoryByAccountId.get(account.id);
      if (paymentCategoryId) add(paymentCategoryId, -row.budgetAmountMinor);
      // No payment category exists for this account yet: the earmark half
      // is silently dropped. The API layer is responsible for every credit
      // account always having one; this pure function degrades gracefully
      // rather than throwing on a data gap that shouldn't occur in
      // practice.
    } else {
      // Uncategorized inflow/outflow on an ordinary on-budget account is
      // money moving straight to/from Ready to Assign — this is what makes
      // a starting balance work with no special category required: it's
      // just an uncategorized inflow, dated at account creation.
      incomeThisMonth += row.budgetAmountMinor;
    }
  }

  return { activityByCategory, incomeThisMonth, unbudgetedCardSpending };
}

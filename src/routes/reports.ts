import { and, eq, isNull, lt } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { requireBudgetMember } from '../auth/middleware';
import { getDb, type Db } from '../db/client';
import { accounts, budgets, categories, categoryMonths, transactions } from '../db/schema';
import { computeLedger } from '../domain/ledger';
import { netWorthDailyTrend, netWorthTrend, unvaluedForeignAccounts } from '../domain/reports';
import { addDays, compareMonths, dateRange, daysBetween, monthRange, nextMonth } from '../lib/dates';
import { budgetIdParam } from '../lib/params';
import type { AppEnv } from '../types/hono';

const MONTH_RE = /^\d{4}-\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// A daily net-worth range builds one point per calendar day in JS (see
// netWorthDailyTrend) rather than aggregating in SQL, so an unbounded range
// is an unbounded array — this caps it at a size that's still generous for
// "daily net worth" (over a decade) while keeping the response and the
// fold bounded. Monthly has no equivalent cap: a month range this long
// would be over a thousand YEARS of months, not a realistic query.
const MAX_DAILY_RANGE_DAYS = 4000;

const rangeQuerySchema = z.object({
  start: z.string().regex(MONTH_RE, 'expected YYYY-MM'),
  end: z.string().regex(MONTH_RE, 'expected YYYY-MM'),
});

const dailyRangeQuerySchema = z.object({
  start: z.string().regex(DATE_RE, 'expected YYYY-MM-DD'),
  end: z.string().regex(DATE_RE, 'expected YYYY-MM-DD'),
});

/** Parses/validates `start`/`end` query params into 'YYYY-MM-01' month
 * strings, `start <= end` — shared by all three report endpoints below. */
function parseRange(c: Context<AppEnv>): { start: string; end: string } | null {
  const parsed = rangeQuerySchema.safeParse({ start: c.req.query('start'), end: c.req.query('end') });
  if (!parsed.success) return null;
  const start = `${parsed.data.start}-01`;
  const end = `${parsed.data.end}-01`;
  if (compareMonths(start, end) > 0) return null;
  return { start, end };
}

/** Same shape as parseRange but for exact 'YYYY-MM-DD' days — the net-worth
 * daily endpoint's own range, independent of the month-only one above. */
function parseDailyRange(c: Context<AppEnv>): { start: string; end: string } | null {
  const parsed = dailyRangeQuerySchema.safeParse({ start: c.req.query('start'), end: c.req.query('end') });
  if (!parsed.success) return null;
  const { start, end } = parsed.data;
  if (start > end) return null;
  return { start, end };
}

export const reportsRoute = new Hono<AppEnv>();
reportsRoute.use('*', requireBudgetMember('viewer'));

// Spending by category over [start, end] — built entirely on top of
// computeLedger's own per-month activity (src/domain/ledger.ts), not a
// second implementation of "which rows count as spending". Reuses the exact
// same fetch shape as src/routes/months.ts's computeMonthView.
reportsRoute.get('/spending', async (c) => {
  const budgetId = budgetIdParam(c);
  const range = parseRange(c);
  if (!range) return c.json({ error: 'invalid_range' }, 400);

  const db = getDb(c.env);
  const [accountRows, categoryRows, categoryMonthRows, transactionRows] = await loadLedgerInputs(db, budgetId, range.end);

  const result = computeLedger({
    accounts: accountRows,
    categories: categoryRows,
    categoryMonths: categoryMonthRows,
    transactions: transactionRows,
    throughMonth: range.end,
  });

  const spendingCategoryIds = new Set(categoryRows.filter((cat) => cat.kind === 'spending').map((cat) => cat.id));
  const spentByCategory = new Map<string, number>();
  for (const month of result.months) {
    if (compareMonths(month.month, range.start) < 0) continue;
    for (const [categoryId, activity] of Object.entries(month.categories)) {
      if (!spendingCategoryIds.has(categoryId)) continue;
      spentByCategory.set(categoryId, (spentByCategory.get(categoryId) ?? 0) + activity.activity);
    }
  }

  return c.json({
    start: range.start,
    end: range.end,
    categories: [...spentByCategory.entries()].map(([categoryId, spentMinor]) => ({ categoryId, spentMinor })),
  });
});

// Income vs. expense per month over [start, end] — income reuses
// computeLedger's incomeThisMonth (see domain/types.ts's doc comment on why
// that field exists); expense is the negated sum of 'spending'-kind
// category activity for the same month, i.e. real cash+credit spending,
// excluding the credit_card_payment categories that would otherwise
// double-count a purchase already counted when it was made.
reportsRoute.get('/income-expense', async (c) => {
  const budgetId = budgetIdParam(c);
  const range = parseRange(c);
  if (!range) return c.json({ error: 'invalid_range' }, 400);

  const db = getDb(c.env);
  const [accountRows, categoryRows, categoryMonthRows, transactionRows] = await loadLedgerInputs(db, budgetId, range.end);

  const result = computeLedger({
    accounts: accountRows,
    categories: categoryRows,
    categoryMonths: categoryMonthRows,
    transactions: transactionRows,
    throughMonth: range.end,
  });

  const spendingCategoryIds = new Set(categoryRows.filter((cat) => cat.kind === 'spending').map((cat) => cat.id));
  const months = result.months
    .filter((month) => compareMonths(month.month, range.start) >= 0)
    .map((month) => {
      let spendingActivity = 0;
      for (const [categoryId, activity] of Object.entries(month.categories)) {
        if (spendingCategoryIds.has(categoryId)) spendingActivity += activity.activity;
      }
      return { month: month.month, incomeMinor: month.incomeThisMonth, expenseMinor: -spendingActivity };
    });

  return c.json({ months });
});

// Net worth trend over [start, end] — see src/domain/reports.ts's
// netWorthTrend. Needs every transaction up through `end` (not just ones
// dated on/after `start`) because a month's balance is a running total
// carried from all of history, not just what happened within the range.
reportsRoute.get('/net-worth', async (c) => {
  const budgetId = budgetIdParam(c);
  const range = parseRange(c);
  if (!range) return c.json({ error: 'invalid_range' }, 400);

  const db = getDb(c.env);
  const [budgetRow, accountRows, balanceRows] = await loadNetWorthInputs(db, budgetId, nextMonth(range.end));
  const budgetCurrencyCode = budgetRow[0]?.currencyCode;
  if (!budgetCurrencyCode) return c.json({ error: 'not_found' }, 404);

  const months = monthRange(range.start, range.end);
  const points = netWorthTrend(balanceRows, accountRows, months, budgetCurrencyCode);

  // Foreign accounts with no rate on file: their balance couldn't be
  // revalued, so it's still an accumulated per-transaction sum. Reported
  // rather than silently folded in — see src/domain/reports.ts.
  const unvalued = unvaluedForeignAccounts(balanceRows, accountRows, budgetCurrencyCode).map((a) => ({
    accountId: a.id,
    name: a.name,
    currencyCode: a.currencyCode,
  }));

  return c.json({ months: points, unvalued });
});

// Same report, day granularity instead of month — for the "daily net
// worth" view, where the reader picks exact days rather than months and
// optionally overlays a trailing N-day moving average (computed client-
// side over this response; see web/src/components/NetWorthChart.tsx). Same
// shape as /net-worth otherwise, right down to the unvalued list — just
// dateRange/netWorthDailyTrend in place of monthRange/netWorthTrend.
reportsRoute.get('/net-worth/daily', async (c) => {
  const budgetId = budgetIdParam(c);
  const range = parseDailyRange(c);
  if (!range) return c.json({ error: 'invalid_range' }, 400);
  if (daysBetween(range.start, range.end) > MAX_DAILY_RANGE_DAYS) {
    return c.json({ error: 'range_too_large', maxDays: MAX_DAILY_RANGE_DAYS }, 400);
  }

  const db = getDb(c.env);
  const [budgetRow, accountRows, balanceRows] = await loadNetWorthInputs(db, budgetId, addDays(range.end, 1));
  const budgetCurrencyCode = budgetRow[0]?.currencyCode;
  if (!budgetCurrencyCode) return c.json({ error: 'not_found' }, 404);

  const days = dateRange(range.start, range.end);
  const points = netWorthDailyTrend(balanceRows, accountRows, days, budgetCurrencyCode);

  const unvalued = unvaluedForeignAccounts(balanceRows, accountRows, budgetCurrencyCode).map((a) => ({
    accountId: a.id,
    name: a.name,
    currencyCode: a.currencyCode,
  }));

  return c.json({ days: points, unvalued });
});

/** The accounts + balance-affecting transactions loadNetWorthInputs shares
 * between /net-worth and /net-worth/daily — everything up to but not
 * including `throughDateExclusive`, since a snapshot's balance is a
 * running total carried from all of history, not just what happened
 * within the requested range. Filtered at the D1 level (not fetched whole
 * and trimmed in JS) the same way loadLedgerInputs below already does. */
async function loadNetWorthInputs(db: Db, budgetId: string, throughDateExclusive: string) {
  return Promise.all([
    db.select({ currencyCode: budgets.currencyCode }).from(budgets).where(eq(budgets.id, budgetId)).limit(1),
    db
      .select({
        id: accounts.id,
        name: accounts.name,
        type: accounts.type,
        currencyCode: accounts.currencyCode,
        fxRateMicros: accounts.fxRateMicros,
      })
      .from(accounts)
      .where(eq(accounts.budgetId, budgetId)),
    db
      .select({
        accountId: transactions.accountId,
        date: transactions.date,
        amountMinor: transactions.amountMinor,
        budgetAmountMinor: transactions.budgetAmountMinor,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.budgetId, budgetId),
          isNull(transactions.deletedAt),
          isNull(transactions.parentTransactionId), // split parents carry no real balance impact of their own — see docs/plan.md
          lt(transactions.date, throughDateExclusive),
        ),
      ),
  ]);
}

/** The same accounts/categories/categoryMonths/transactions fetch shape as
 * src/routes/months.ts's computeMonthView — every report here folds
 * computeLedger the same way the budget screen does. */
async function loadLedgerInputs(db: Db, budgetId: string, throughMonth: string) {
  return Promise.all([
    db.select({ id: accounts.id, type: accounts.type, onBudget: accounts.onBudget }).from(accounts).where(eq(accounts.budgetId, budgetId)),
    db
      .select({ id: categories.id, kind: categories.kind, linkedAccountId: categories.linkedAccountId })
      .from(categories)
      .where(eq(categories.budgetId, budgetId)),
    db
      .select({ categoryId: categoryMonths.categoryId, month: categoryMonths.month, assignedMinor: categoryMonths.assignedMinor })
      .from(categoryMonths)
      .where(eq(categoryMonths.budgetId, budgetId)),
    db
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        date: transactions.date,
        budgetAmountMinor: transactions.budgetAmountMinor,
        categoryId: transactions.categoryId,
        transferTransactionId: transactions.transferTransactionId,
        transferAccountId: transactions.transferAccountId,
        parentTransactionId: transactions.parentTransactionId,
        deletedAt: transactions.deletedAt,
      })
      .from(transactions)
      .where(and(eq(transactions.budgetId, budgetId), isNull(transactions.deletedAt), lt(transactions.date, nextMonth(throughMonth)))),
  ]);
}

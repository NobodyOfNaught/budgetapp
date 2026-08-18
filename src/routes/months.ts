import { and, eq, isNull, lt } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireBudgetMember } from '../auth/middleware';
import { computeLedger } from '../domain/ledger';
import type { MonthResult } from '../domain/types';
import { getDb, type Db } from '../db/client';
import { accounts, categories, categoryMonths, transactions } from '../db/schema';
import { nextMonth } from '../lib/dates';
import { budgetIdParam } from '../lib/params';
import { parseAmountToMinor } from '../lib/money';
import type { AppEnv } from '../types/hono';

const MONTH_RE = /^\d{4}-\d{2}$/;

/**
 * Loads everything the ledger engine needs for one budget and folds it
 * forward through `month` (see docs/plan.md's "The ledger engine" — this
 * is the one place in the app that calls it). Accounts and categories are
 * fetched WITHOUT filtering hidden/deleted/closed: a category deleted last
 * week still needs to be here for last month's activity to compute
 * correctly. Filtering those out of what the UI *displays* is a separate
 * concern, already handled by GET /categories and GET /accounts.
 */
async function computeMonthView(db: Db, budgetId: string, month: string): Promise<MonthResult> {
  const [accountRows, categoryRows, categoryMonthRows, transactionRows] = await Promise.all([
    db.select({ id: accounts.id, type: accounts.type, onBudget: accounts.onBudget }).from(accounts).where(eq(accounts.budgetId, budgetId)),
    db
      .select({ id: categories.id, kind: categories.kind, linkedAccountId: categories.linkedAccountId })
      .from(categories)
      .where(eq(categories.budgetId, budgetId)),
    db
      .select({ categoryId: categoryMonths.categoryId, month: categoryMonths.month, assignedMinor: categoryMonths.assignedMinor })
      .from(categoryMonths)
      .where(eq(categoryMonths.budgetId, budgetId)),
    // Only need transactions dated on or before the target month — the
    // engine ignores anything later anyway, so this keeps the payload from
    // growing with the budget's full future.
    db
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        date: transactions.date,
        budgetAmountMinor: transactions.budgetAmountMinor,
        categoryId: transactions.categoryId,
        transferTransactionId: transactions.transferTransactionId,
        parentTransactionId: transactions.parentTransactionId,
        deletedAt: transactions.deletedAt,
      })
      .from(transactions)
      .where(and(eq(transactions.budgetId, budgetId), isNull(transactions.deletedAt), lt(transactions.date, nextMonth(month)))),
  ]);

  const result = computeLedger({
    accounts: accountRows,
    categories: categoryRows,
    categoryMonths: categoryMonthRows,
    transactions: transactionRows,
    throughMonth: month,
  });

  return result.months[result.months.length - 1] ?? { month, readyToAssign: 0, categories: {} };
}

const assignmentsSchema = z.object({
  assignments: z
    .array(
      z.object({
        categoryId: z.string().min(1),
        // Absolute new value for the month, not a delta — the client
        // already has the current amount from a prior GET, so "move money"
        // is just two entries in one batch (source -X, destination +X).
        assigned: z.string(),
      }),
    )
    .min(1),
});

export const monthsRoute = new Hono<AppEnv>();
monthsRoute.use('*', requireBudgetMember('viewer'));

monthsRoute.get('/:month', async (c) => {
  const budgetId = budgetIdParam(c);
  const monthParam = c.req.param('month');
  if (!MONTH_RE.test(monthParam)) return c.json({ error: 'invalid_month' }, 400);

  const db = getDb(c.env);
  const view = await computeMonthView(db, budgetId, `${monthParam}-01`);
  return c.json(view);
});

monthsRoute.put('/:month/assignments', requireBudgetMember('editor'), async (c) => {
  const budgetId = budgetIdParam(c);
  const monthParam = c.req.param('month');
  if (!MONTH_RE.test(monthParam)) return c.json({ error: 'invalid_month' }, 400);
  const month = `${monthParam}-01`;

  const parsed = assignmentsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);

  const db = getDb(c.env);

  // Validate every entry before writing any of them — a batch (e.g. "move
  // money": two entries) should never apply half of itself.
  const categoryRows = await db
    .select({ id: categories.id, kind: categories.kind })
    .from(categories)
    .where(and(eq(categories.budgetId, budgetId), isNull(categories.deletedAt)));
  const categoryById = new Map(categoryRows.map((cat) => [cat.id, cat]));

  const updates: { categoryId: string; assignedMinor: number }[] = [];
  for (const entry of parsed.data.assignments) {
    const category = categoryById.get(entry.categoryId);
    if (!category) return c.json({ error: 'invalid_category' }, 400);
    // 'income' categories feed Ready to Assign directly from transactions
    // (see docs/plan.md) — they have no "available" of their own to assign
    // into. 'spending' and 'credit_card_payment' are both real targets.
    if (category.kind === 'income') return c.json({ error: 'cannot_assign_to_income_category' }, 400);
    let assignedMinor: number;
    try {
      assignedMinor = parseAmountToMinor(entry.assigned);
    } catch {
      return c.json({ error: 'invalid_amount' }, 400);
    }
    updates.push({ categoryId: entry.categoryId, assignedMinor });
  }

  for (const u of updates) {
    await db
      .insert(categoryMonths)
      .values({ categoryId: u.categoryId, month, budgetId, assignedMinor: u.assignedMinor })
      .onConflictDoUpdate({
        target: [categoryMonths.categoryId, categoryMonths.month],
        set: { assignedMinor: u.assignedMinor },
      });
  }

  const view = await computeMonthView(db, budgetId, month);
  return c.json(view);
});

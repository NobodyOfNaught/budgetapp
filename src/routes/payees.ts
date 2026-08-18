import { and, eq, isNull, like } from 'drizzle-orm';
import { Hono } from 'hono';
import { requireBudgetMember } from '../auth/middleware';
import { getDb } from '../db/client';
import { payees } from '../db/schema';
import { budgetIdParam } from '../lib/params';
import type { AppEnv } from '../types/hono';

export const payeesRoute = new Hono<AppEnv>();
payeesRoute.use('*', requireBudgetMember('viewer'));

// No POST here — payees are created on the fly by the transactions
// endpoint from whatever name the user types (see src/budget/payees.ts).
// Includes transfer payees ("Transfer : Savings") alongside ordinary ones:
// the register's payee picker doubles as the transfer-target picker, same
// as YNAB, distinguished in the response by transferAccountId being set.
payeesRoute.get('/', async (c) => {
  const budgetId = budgetIdParam(c);
  const q = c.req.query('q')?.trim();
  const db = getDb(c.env);

  const conditions = [eq(payees.budgetId, budgetId), isNull(payees.deletedAt)];
  if (q) conditions.push(like(payees.name, `%${q}%`));

  const rows = await db
    .select()
    .from(payees)
    .where(and(...conditions))
    .orderBy(payees.name)
    .limit(50);

  return c.json({ payees: rows });
});

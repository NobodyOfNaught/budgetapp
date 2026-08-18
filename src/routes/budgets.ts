import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { requireAuth, requireBudgetMember } from '../auth/middleware';
import { getDb } from '../db/client';
import { budgetMembers, budgets } from '../db/schema';
import type { AppEnv } from '../types/hono';

export const budgetsRoute = new Hono<AppEnv>();

budgetsRoute.use('*', requireAuth);

budgetsRoute.get('/', async (c) => {
  const db = getDb(c.env);
  const rows = await db
    .select({ id: budgets.id, name: budgets.name, currencyCode: budgets.currencyCode, role: budgetMembers.role })
    .from(budgetMembers)
    .innerJoin(budgets, eq(budgets.id, budgetMembers.budgetId))
    .where(eq(budgetMembers.userId, c.get('user').id));

  return c.json({ budgets: rows });
});

// The first route in the app gated by requireBudgetMember — see
// src/auth/middleware.ts. Everything budget-scoped in later PRs (accounts,
// categories, transactions) mounts under /budgets/:budgetId/... and reuses
// this exact middleware, not a bespoke ownership check per route.
budgetsRoute.get('/:budgetId', requireBudgetMember('viewer'), async (c) => {
  const db = getDb(c.env);
  const budgetId = c.req.param('budgetId');

  const [budget] = await db
    .select({ id: budgets.id, name: budgets.name, currencyCode: budgets.currencyCode })
    .from(budgets)
    .where(eq(budgets.id, budgetId))
    .limit(1);

  if (!budget) return c.json({ error: 'not_found' }, 404);

  return c.json({ budget, role: c.get('budgetRole') });
});

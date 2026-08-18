import type { Context } from 'hono';
import type { AppEnv } from '../types/hono';

/**
 * Reads the `:budgetId` route param. Every resource route file (accounts,
 * categories, transactions, payees) is mounted as a sub-app nested under
 * `/budgets/:budgetId/...`, so from each sub-app's OWN type signature Hono
 * can't statically prove the param exists (it only knows about segments
 * declared in that sub-app's own route patterns) — it types as
 * `string | undefined` even though `requireBudgetMember` (which every
 * budget-scoped route runs first) already guarantees it's present. This
 * narrows that without a redundant runtime check duplicating what the
 * middleware already enforced; the throw only fires on an actual routing
 * misconfiguration, never on a real request.
 */
export function budgetIdParam(c: Context<AppEnv>): string {
  const id = c.req.param('budgetId');
  if (!id) throw new Error('budgetId param missing — route not mounted under /budgets/:budgetId');
  return id;
}

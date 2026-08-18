import { and, eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { getDb } from '../db/client';
import { budgetMembers, users } from '../db/schema';
import type { AppEnv } from '../types/hono';
import { getActiveSession, touchSession } from './session';

export const SESSION_COOKIE = '__Host-session';
export const CHALLENGE_COOKIE = 'bapp_challenge';

/** 401s unless a valid, unexpired, unrevoked session cookie is present. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const sessionId = getCookie(c, SESSION_COOKIE);
  if (!sessionId) return c.json({ error: 'unauthorized' }, 401);

  const db = getDb(c.env);
  const session = await getActiveSession(db, sessionId);
  if (!session) return c.json({ error: 'unauthorized' }, 401);

  const [user] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  await touchSession(db, session);
  c.set('user', user);
  c.set('session', session);
  await next();
};

const ROLE_RANK = { viewer: 0, editor: 1, owner: 2 } as const;
type BudgetRole = keyof typeof ROLE_RANK;

/**
 * 403s unless the signed-in user is a member of the `:budgetId` route param
 * with at least `minRole`. Every authorization check for budget-scoped data
 * goes through budget_members — see docs/plan.md — so this one middleware,
 * not a per-route ownership check, is what sharing later plugs into: an
 * invite flow just inserts more rows here, no route changes.
 *
 * Must run after `requireAuth` (reads `c.get('user')`).
 *
 * Cheap to stack: a resource's whole sub-app can apply the loosest role
 * that covers any of its routes (e.g. 'viewer' for everything), and
 * individual mutating routes add a stricter check on top — a repeated call
 * reads the role this one already fetched instead of re-querying D1.
 */
export function requireBudgetMember(minRole: BudgetRole = 'viewer'): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const existingRole = c.get('budgetRole');
    if (existingRole !== undefined) {
      if (ROLE_RANK[existingRole] < ROLE_RANK[minRole]) return c.json({ error: 'forbidden' }, 403);
      return next();
    }

    const user = c.get('user');
    const budgetId = c.req.param('budgetId');
    if (!budgetId) return c.json({ error: 'bad_request' }, 400);

    const db = getDb(c.env);
    const [membership] = await db
      .select()
      .from(budgetMembers)
      .where(and(eq(budgetMembers.budgetId, budgetId), eq(budgetMembers.userId, user.id)))
      .limit(1);

    if (!membership || ROLE_RANK[membership.role] < ROLE_RANK[minRole]) {
      return c.json({ error: 'forbidden' }, 403);
    }

    c.set('budgetRole', membership.role);
    await next();
  };
}

import { and, eq, isNull } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { getDb } from '../db/client';
import { apiTokens, budgetMembers, users } from '../db/schema';
import { sha256Hex } from '../lib/crypto';
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

/**
 * What an API token may do: method + path pattern, nothing else. Everything
 * not listed is a 403 for a token, even where a session would be allowed.
 *
 * The list is the import workflow and the reads it needs, no more: find the
 * budget, find the account, run the import (and Splitwise's inspect step,
 * which reads a file's member names so the import can choose them). It
 * excludes, on purpose, everything that edits or deletes existing data —
 * a token that leaks can at worst add rows that land UNAPPROVED in the
 * review queue, every one of them undoable as a batch.
 */
const API_TOKEN_ROUTES: ReadonlyArray<readonly [string, RegExp]> = [
  ['GET', /^\/api\/v1\/budgets\/?$/],
  ['GET', /^\/api\/v1\/budgets\/[^/]+\/?$/],
  ['GET', /^\/api\/v1\/budgets\/[^/]+\/accounts\/?$/],
  ['POST', /^\/api\/v1\/budgets\/[^/]+\/imports\/?$/],
  ['POST', /^\/api\/v1\/budgets\/[^/]+\/imports\/inspect\/?$/],
];

export function isApiTokenRoute(method: string, path: string): boolean {
  return API_TOKEN_ROUTES.some(([m, re]) => m === method && re.test(path));
}

/**
 * Accepts a session cookie OR an `Authorization: Bearer` API token
 * (migrations/0012). Used on the budget routes only; /auth/* stays
 * session-only via plain `requireAuth`, so a token can never mint tokens,
 * read /me, or sign out a browser.
 *
 * A request that presents a bearer header is judged on the token ALONE —
 * an invalid token is a 401 even if a valid session cookie rides along,
 * rather than silently falling back to the cookie. A client that thinks it
 * is using a token should learn that it isn't.
 *
 * CSRF is unaffected: the same-origin check in src/lib/csrf.ts still runs
 * first on every mutation, and a token client simply sends a matching
 * Origin header. A browser cannot attach an Authorization header to a
 * cross-site request without a CORS preflight this app never grants.
 */
export const requireAuthOrApiToken: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header('Authorization');
  if (!header) return requireAuth(c, next);

  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match?.[1]) return c.json({ error: 'unauthorized' }, 401);

  const db = getDb(c.env);
  const [row] = await db
    .select({ id: apiTokens.id, userId: apiTokens.userId })
    .from(apiTokens)
    .where(and(eq(apiTokens.tokenHash, await sha256Hex(match[1])), isNull(apiTokens.revokedAt)))
    .limit(1);
  if (!row) return c.json({ error: 'unauthorized' }, 401);

  if (!isApiTokenRoute(c.req.method, c.req.path)) {
    return c.json({ error: 'forbidden', detail: 'API tokens may only read the budget and run imports' }, 403);
  }

  const [user] = await db.select().from(users).where(eq(users.id, row.userId)).limit(1);
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  await db.update(apiTokens).set({ lastUsedAt: Date.now() }).where(eq(apiTokens.id, row.id));
  c.set('user', user);
  await next();
};

/**
 * 403s unless the signed-in user belongs to the `:budgetId` route param.
 *
 * This used to rank viewer < editor < owner, for budget sharing that was
 * planned and never built. The site is now one person's, so every member is
 * the owner and the ladder only ever answered "yes" — it is gone, and with
 * it the per-route role arguments that 42 routes carried.
 *
 * What remains is NOT a formality: it is the check that a budget id in the
 * URL belongs to the person asking. budget_members stays as the table that
 * records that link (its `role` column is still written, always 'owner',
 * because it is NOT NULL and dropping it would be a breaking migration for
 * no gain).
 *
 * Must run after `requireAuth` (reads `c.get('user')`). Applied once per
 * sub-app with `.use('*', requireBudgetMember)`.
 */
export const requireBudgetMember: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get('user');
  const budgetId = c.req.param('budgetId');
  if (!budgetId) return c.json({ error: 'bad_request' }, 400);

  const db = getDb(c.env);
  const [membership] = await db
    .select({ budgetId: budgetMembers.budgetId })
    .from(budgetMembers)
    .where(and(eq(budgetMembers.budgetId, budgetId), eq(budgetMembers.userId, user.id)))
    .limit(1);

  if (!membership) return c.json({ error: 'forbidden' }, 403);
  await next();
};

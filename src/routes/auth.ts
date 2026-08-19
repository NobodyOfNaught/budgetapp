import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { CHALLENGE_COOKIE, requireAuth, SESSION_COOKIE } from '../auth/middleware';
import { isEmailOverLimit, isIpOverLimit } from '../auth/rate-limit';
import { createSession, revokeSession } from '../auth/session';
import { consumeMagicLinkToken, createMagicLinkToken } from '../auth/tokens';
import { signInUser } from '../auth/users';
import { getDb } from '../db/client';
import { budgetMembers, budgets } from '../db/schema';
import type { EmailSender } from '../lib/email';
import type { AppEnv } from '../types/hono';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CHALLENGE_MAX_AGE_SECONDS = 15 * 60;
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

function clientIp(c: { req: { header(name: string): string | undefined } }): string {
  return c.req.header('CF-Connecting-IP') ?? 'unknown';
}

/**
 * A factory, not a module-level app, so the email sender is injected rather
 * than hardcoded — src/index.ts wires the real ConsoleEmailSender, tests
 * wire a capturing one. The raw magic-link token is never persisted
 * anywhere (only its hash — see src/auth/tokens.ts), so this is the only
 * way to observe it in a test.
 */
export function createAuthRoutes(emailSender: EmailSender): Hono<AppEnv> {
  const auth = new Hono<AppEnv>();

  // Always 200, identical response whether or not the address has an
  // account — see docs/plan.md's auth flow section. Only a malformed
  // address (a client input error, not an enumeration signal) gets a 400.
  auth.post('/magic-link', async (c) => {
    const body = await c.req.json<{ email?: unknown }>().catch(() => ({}) as { email?: unknown });
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (!EMAIL_RE.test(email)) {
      return c.json({ error: 'invalid_email' }, 400);
    }
    const emailNormalized = email.toLowerCase();

    const db = getDb(c.env);
    const ip = clientIp(c);
    const overLimit = (await isIpOverLimit(c.env, ip)) || (await isEmailOverLimit(db, emailNormalized));

    if (!overLimit) {
      const { token, challenge, expiresAt } = await createMagicLinkToken(db, {
        emailNormalized,
        ip,
        ua: c.req.header('User-Agent'),
      });

      const confirmUrl = `${new URL(c.req.url).origin}/auth/confirm?token=${encodeURIComponent(token)}`;
      await emailSender.sendMagicLink({ to: email, confirmUrl }, c.env);

      setCookie(c, CHALLENGE_COOKIE, challenge, {
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        path: '/',
        maxAge: CHALLENGE_MAX_AGE_SECONDS,
        expires: new Date(expiresAt),
      });
    }
    // If over limit: skip issuing a token/email/cookie, but respond exactly
    // as if we had — no signal to the caller either way.

    return c.json({ status: 'ok' });
  });

  auth.post('/consume', async (c) => {
    const body = await c.req
      .json<{ token?: unknown; confirm?: unknown }>()
      .catch(() => ({}) as { token?: unknown; confirm?: unknown });
    const token = typeof body.token === 'string' ? body.token : '';
    const confirm = body.confirm === true;
    if (!token) return c.json({ error: 'bad_request' }, 400);

    const db = getDb(c.env);
    const outcome = await consumeMagicLinkToken(db, {
      token,
      cookieChallenge: getCookie(c, CHALLENGE_COOKIE),
      confirm,
    });

    if (outcome.status !== 'claimed') {
      return c.json({ status: outcome.status });
    }

    const { user, budgetId } = await signInUser(db, outcome.emailNormalized);
    const session = await createSession(db, { userId: user.id, ip: clientIp(c), ua: c.req.header('User-Agent') });

    deleteCookie(c, CHALLENGE_COOKIE, { path: '/' });
    setCookie(c, SESSION_COOKIE, session.id, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_MAX_AGE_SECONDS,
      expires: new Date(session.expiresAt),
    });

    return c.json({
      status: 'signed_in',
      user: { id: user.id, email: user.email, displayName: user.displayName },
      budgetId,
    });
  });

  auth.post('/logout', requireAuth, async (c) => {
    const db = getDb(c.env);
    await revokeSession(db, c.get('session').id);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ status: 'ok' });
  });

  auth.get('/me', requireAuth, async (c) => {
    const db = getDb(c.env);
    const user = c.get('user');

    const rows = await db
      .select({ id: budgets.id, name: budgets.name, currencyCode: budgets.currencyCode, role: budgetMembers.role })
      .from(budgetMembers)
      .innerJoin(budgets, eq(budgets.id, budgetMembers.budgetId))
      .where(eq(budgetMembers.userId, user.id));

    return c.json({
      user: { id: user.id, email: user.email, displayName: user.displayName },
      budgets: rows,
    });
  });

  return auth;
}

import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import type { Hono } from 'hono';
import { createApp } from '../src/index';
import type { EmailSender, MagicLinkEmail } from '../src/lib/email';
import type { AppEnv } from '../src/types/hono';

export const ORIGIN = 'http://example.com';

export class CapturingEmailSender implements EmailSender {
  sent: MagicLinkEmail[] = [];
  async sendMagicLink(email: MagicLinkEmail): Promise<void> {
    this.sent.push(email);
  }
}

export function req(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.method && init.method !== 'GET') headers.set('Origin', ORIGIN);
  if (init.body) headers.set('Content-Type', 'application/json');
  if (init.cookie) headers.set('Cookie', init.cookie);
  return new Request(ORIGIN + path, { ...init, headers }) as Request<unknown, IncomingRequestCfProperties>;
}

/** Pulls a named cookie's value out of a Set-Cookie response header. */
export function cookieValue(setCookieHeader: string | null, name: string): string | undefined {
  if (!setCookieHeader) return undefined;
  const match = new RegExp(`${name}=([^;]+)`).exec(setCookieHeader);
  return match?.[1];
}

/** Runs one request through a Hono app with a fresh execution context, per-request like a real Worker invocation. */
export async function call(app: Hono<AppEnv>, request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** JSON request through `call`, with the session cookie attached and the body pre-parsed. */
export async function callJson<T>(
  app: Hono<AppEnv>,
  sessionCookie: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const res = await call(app, req(path, { ...init, cookie: `__Host-session=${sessionCookie}` }));
  const body = (await res.json().catch(() => undefined)) as T;
  return { status: res.status, body };
}

// Children before parents, respecting every FK in migrations/*.sql — a
// budget row can't be deleted while an account/category/etc. still
// references it. Shared by every test file's beforeEach so adding a table
// only means updating it here.
const TABLES_CHILDREN_FIRST = [
  'transactions',
  'category_months',
  'category_targets',
  'categories',
  'category_groups',
  'payees',
  'accounts',
  'budget_members',
  'budgets',
  'sessions',
  'auth_tokens',
  'users',
];

export async function resetDb(): Promise<void> {
  for (const table of TABLES_CHILDREN_FIRST) {
    await env.DB.prepare(`delete from ${table}`).run();
  }
}

/**
 * Signs in a brand-new user via a fresh magic link (auto-confirmed, same
 * "device") and returns an authenticated app handle plus their
 * auto-created budget id — the standard fixture every budget-scoped test
 * needs. AUTH_RATE_LIMITER state persists across tests in a file (it's
 * runtime state, not a D1 row), so the fake client IP is keyed off the
 * email to keep each caller's rate-limit budget independent — see
 * test/auth.test.ts for the fuller explanation.
 */
export async function signInNewUser(
  email: string,
): Promise<{ app: Hono<AppEnv>; sessionCookie: string; budgetId: string }> {
  const emailSender = new CapturingEmailSender();
  const app = createApp(emailSender);

  const linkRes = await call(
    app,
    req('/api/v1/auth/magic-link', {
      method: 'POST',
      body: JSON.stringify({ email }),
      headers: { 'CF-Connecting-IP': email },
    }),
  );
  const challengeCookie = cookieValue(linkRes.headers.get('Set-Cookie'), 'bapp_challenge');
  const sent = emailSender.sent[0];
  if (!sent) throw new Error('magic-link email was not sent — check the request above');
  const token = new URL(sent.confirmUrl).searchParams.get('token');
  if (!token) throw new Error('confirm URL had no token');

  const consumeRes = await call(
    app,
    req('/api/v1/auth/consume', {
      method: 'POST',
      body: JSON.stringify({ token }),
      cookie: `bapp_challenge=${challengeCookie}`,
    }),
  );
  const body = await consumeRes.json<{ budgetId: string }>();
  const sessionCookie = cookieValue(consumeRes.headers.get('Set-Cookie'), '__Host-session');
  if (!sessionCookie) throw new Error('sign-in did not set a session cookie');

  return { app, sessionCookie, budgetId: body.budgetId };
}

import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import type { EmailSender, MagicLinkEmail } from '../src/lib/email';

const ORIGIN = 'http://example.com';

// Each test gets a clean slate — auth_tokens/users/etc. would otherwise
// accumulate across tests in this file and skew the rate-limit-cooldown
// assertion in particular.
beforeEach(async () => {
  for (const table of ['budget_members', 'budgets', 'sessions', 'auth_tokens', 'users']) {
    await env.DB.prepare(`delete from ${table}`).run();
  }
});

class CapturingEmailSender implements EmailSender {
  sent: MagicLinkEmail[] = [];
  async sendMagicLink(email: MagicLinkEmail): Promise<void> {
    this.sent.push(email);
  }
}

function req(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.method && init.method !== 'GET') headers.set('Origin', ORIGIN);
  if (init.body) headers.set('Content-Type', 'application/json');
  if (init.cookie) headers.set('Cookie', init.cookie);
  return new Request(ORIGIN + path, { ...init, headers }) as Request<unknown, IncomingRequestCfProperties>;
}

/** Pulls a named cookie's value out of a Set-Cookie response header. */
function cookieValue(setCookieHeader: string | null, name: string): string | undefined {
  if (!setCookieHeader) return undefined;
  const match = new RegExp(`${name}=([^;]+)`).exec(setCookieHeader);
  return match?.[1];
}

async function requestMagicLink(email: string) {
  const emailSender = new CapturingEmailSender();
  const app = createApp(emailSender);
  const ctx = createExecutionContext();
  // AUTH_RATE_LIMITER's simulated state persists across tests within this
  // file (it's runtime state, not a D1 row `beforeEach` can reset), and its
  // window (10 requests / 60s) is shared per IP key. Every test uses a
  // distinct email, so keying the fake client IP off the email keeps each
  // test's budget independent instead of exhausting one shared "unknown"
  // bucket across the whole file.
  const res = await app.fetch(
    req('/api/v1/auth/magic-link', {
      method: 'POST',
      body: JSON.stringify({ email }),
      headers: { 'CF-Connecting-IP': email },
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const challengeCookie = cookieValue(res.headers.get('Set-Cookie'), 'bapp_challenge');
  const sent = emailSender.sent[0];
  const token = sent ? new URL(sent.confirmUrl).searchParams.get('token')! : undefined;
  return { res, app, token, challengeCookie };
}

describe('POST /api/v1/auth/magic-link', () => {
  it('rejects a malformed email with 400', async () => {
    const { res } = await requestMagicLink('not-an-email');
    expect(res.status).toBe(400);
  });

  it('always returns 200 + ok for a well-formed email, account or not', async () => {
    const { res, token, challengeCookie } = await requestMagicLink('new-user@example.com');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(token).toBeTruthy();
    expect(challengeCookie).toBeTruthy();
  });

  it('rejects a cross-origin request (no matching Origin header)', async () => {
    const app = createApp(new CapturingEmailSender());
    const ctx = createExecutionContext();
    const request = new Request(`${ORIGIN}/api/v1/auth/magic-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ email: 'a@example.com' }),
    }) as Request<unknown, IncomingRequestCfProperties>;
    const res = await app.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(403);
  });

  it('silently cools down after repeated requests for the same email', async () => {
    const email = 'hammered@example.com';
    let lastSentCount = 0;
    for (let i = 0; i < 6; i++) {
      const { res, app } = await requestMagicLink(email);
      expect(res.status).toBe(200); // identical response every time
      void app;
    }
    // The 6th request (limit is 5 per window) should not have produced a
    // 6th queued email — check by asking a fresh capture how many total
    // tokens exist for this email via one more request's sender instance
    // isn't directly observable across instances, so assert indirectly:
    // a direct DB count confirms the cooldown actually suppressed writes.
    const rows = await env.DB.prepare('select count(*) as n from auth_tokens where email_normalized = ?')
      .bind(email)
      .first<{ n: number }>();
    lastSentCount = rows?.n ?? 0;
    expect(lastSentCount).toBe(5); // 6 requests, 6th silently dropped
  });
});

describe('POST /api/v1/auth/consume', () => {
  it('signs in immediately when the challenge cookie matches', async () => {
    const { app, token, challengeCookie } = await requestMagicLink('same-device@example.com');
    const ctx = createExecutionContext();
    const res = await app.fetch(
      req('/api/v1/auth/consume', {
        method: 'POST',
        body: JSON.stringify({ token }),
        cookie: `bapp_challenge=${challengeCookie}`,
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const body = await res.json<{ status: string; user: { email: string }; budgetId: string }>();
    expect(body.status).toBe('signed_in');
    expect(body.user.email).toBe('same-device@example.com');
    expect(body.budgetId).toBeTruthy();
    expect(cookieValue(res.headers.get('Set-Cookie'), '__Host-session')).toBeTruthy();
  });

  it('auto-creates exactly one budget for a brand-new user', async () => {
    const { app, token, challengeCookie } = await requestMagicLink('budget-check@example.com');
    const ctx = createExecutionContext();
    await app.fetch(
      req('/api/v1/auth/consume', {
        method: 'POST',
        body: JSON.stringify({ token }),
        cookie: `bapp_challenge=${challengeCookie}`,
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    const rows = await env.DB.prepare(
      `select count(*) as n from budget_members bm
       join users u on u.id = bm.user_id
       where u.email_normalized = ?`,
    )
      .bind('budget-check@example.com')
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it('needs confirmation when the challenge cookie is missing (different device)', async () => {
    const { app, token } = await requestMagicLink('other-device@example.com');
    const ctx = createExecutionContext();
    const res = await app.fetch(
      req('/api/v1/auth/consume', { method: 'POST', body: JSON.stringify({ token }) }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(await res.json()).toEqual({ status: 'needs_confirmation' });
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('signs in via explicit confirm after needs_confirmation', async () => {
    const { app, token } = await requestMagicLink('confirm-me@example.com');
    const ctx = createExecutionContext();
    const res = await app.fetch(
      req('/api/v1/auth/consume', { method: 'POST', body: JSON.stringify({ token, confirm: true }) }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const body = await res.json<{ status: string }>();
    expect(body.status).toBe('signed_in');
  });

  it('rejects an unknown token as invalid', async () => {
    const app = createApp(new CapturingEmailSender());
    const ctx = createExecutionContext();
    const res = await app.fetch(
      req('/api/v1/auth/consume', { method: 'POST', body: JSON.stringify({ token: 'not-a-real-token' }) }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(await res.json()).toEqual({ status: 'invalid' });
  });

  it('a token can only be consumed once', async () => {
    const { app, token, challengeCookie } = await requestMagicLink('one-shot@example.com');
    const ctx1 = createExecutionContext();
    const first = await app.fetch(
      req('/api/v1/auth/consume', {
        method: 'POST',
        body: JSON.stringify({ token }),
        cookie: `bapp_challenge=${challengeCookie}`,
      }),
      env,
      ctx1,
    );
    await waitOnExecutionContext(ctx1);
    expect((await first.json<{ status: string }>()).status).toBe('signed_in');

    const ctx2 = createExecutionContext();
    const second = await app.fetch(
      req('/api/v1/auth/consume', {
        method: 'POST',
        body: JSON.stringify({ token }),
        cookie: `bapp_challenge=${challengeCookie}`,
      }),
      env,
      ctx2,
    );
    await waitOnExecutionContext(ctx2);
    expect(await second.json()).toEqual({ status: 'invalid' });
  });
});

describe('session-gated routes', () => {
  async function signIn(email: string) {
    const { app, token, challengeCookie } = await requestMagicLink(email);
    const ctx = createExecutionContext();
    const res = await app.fetch(
      req('/api/v1/auth/consume', {
        method: 'POST',
        body: JSON.stringify({ token }),
        cookie: `bapp_challenge=${challengeCookie}`,
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const body = await res.json<{ budgetId: string }>();
    const sessionCookie = cookieValue(res.headers.get('Set-Cookie'), '__Host-session');
    return { app, sessionCookie: sessionCookie!, budgetId: body.budgetId };
  }

  it('GET /me is 401 without a session cookie', async () => {
    const app = createApp(new CapturingEmailSender());
    const ctx = createExecutionContext();
    const res = await app.fetch(req('/api/v1/auth/me'), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });

  it('GET /me returns the user and their auto-created budget when signed in', async () => {
    const { app, sessionCookie } = await signIn('me-route@example.com');
    const ctx = createExecutionContext();
    const res = await app.fetch(req('/api/v1/auth/me', { cookie: `__Host-session=${sessionCookie}` }), env, ctx);
    await waitOnExecutionContext(ctx);
    const body = await res.json<{ user: { email: string }; budgets: { role: string }[] }>();
    expect(body.user.email).toBe('me-route@example.com');
    expect(body.budgets).toHaveLength(1);
    expect(body.budgets[0]?.role).toBe('owner');
  });

  it('GET /budgets/:id is 403 for a budget the user does not belong to', async () => {
    const { app: appA, sessionCookie: cookieA } = await signIn('user-a@example.com');
    const { budgetId: budgetB } = await signIn('user-b@example.com');

    const ctx = createExecutionContext();
    const res = await appA.fetch(
      req(`/api/v1/budgets/${budgetB}`, { cookie: `__Host-session=${cookieA}` }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(403);
  });

  it('GET /budgets/:id is 200 for the caller’s own budget', async () => {
    const { app, sessionCookie, budgetId } = await signIn('own-budget@example.com');
    const ctx = createExecutionContext();
    const res = await app.fetch(
      req(`/api/v1/budgets/${budgetId}`, { cookie: `__Host-session=${sessionCookie}` }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const body = await res.json<{ role: string }>();
    expect(body.role).toBe('owner');
  });

  it('POST /logout revokes the session', async () => {
    const { app, sessionCookie } = await signIn('logout-me@example.com');
    const ctx1 = createExecutionContext();
    await app.fetch(req('/api/v1/auth/logout', { method: 'POST', cookie: `__Host-session=${sessionCookie}` }), env, ctx1);
    await waitOnExecutionContext(ctx1);

    const ctx2 = createExecutionContext();
    const res = await app.fetch(req('/api/v1/auth/me', { cookie: `__Host-session=${sessionCookie}` }), env, ctx2);
    await waitOnExecutionContext(ctx2);
    expect(res.status).toBe(401);
  });
});

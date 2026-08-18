import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { call, CapturingEmailSender, cookieValue, req, resetDb, signInNewUser } from './helpers';

// Each test gets a clean slate — auth_tokens/users/etc. would otherwise
// accumulate across tests in this file and skew the rate-limit-cooldown
// assertion in particular.
beforeEach(resetDb);

async function requestMagicLink(email: string) {
  const emailSender = new CapturingEmailSender();
  const app = createApp(emailSender);
  // See test/helpers.ts's signInNewUser doc comment: the fake client IP is
  // keyed off the email so the shared AUTH_RATE_LIMITER state doesn't leak
  // across tests in this file.
  const res = await call(
    app,
    req('/api/v1/auth/magic-link', {
      method: 'POST',
      body: JSON.stringify({ email }),
      headers: { 'CF-Connecting-IP': email },
    }),
  );
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
    const request = new Request(`http://example.com/api/v1/auth/magic-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ email: 'a@example.com' }),
    }) as Request<unknown, IncomingRequestCfProperties>;
    const res = await call(app, request);
    expect(res.status).toBe(403);
  });

  it('silently cools down after repeated requests for the same email', async () => {
    const email = 'hammered@example.com';
    for (let i = 0; i < 6; i++) {
      const { res } = await requestMagicLink(email);
      expect(res.status).toBe(200); // identical response every time
    }
    // The 6th request (limit is 5 per window) should not have produced a
    // 6th queued email — check by asking a fresh capture how many total
    // tokens exist for this email via one more request's sender instance
    // isn't directly observable across instances, so assert indirectly:
    // a direct DB count confirms the cooldown actually suppressed writes.
    const rows = await env.DB.prepare('select count(*) as n from auth_tokens where email_normalized = ?')
      .bind(email)
      .first<{ n: number }>();
    expect(rows?.n).toBe(5); // 6 requests, 6th silently dropped
  });
});

describe('POST /api/v1/auth/consume', () => {
  it('signs in immediately when the challenge cookie matches', async () => {
    const { app, token, challengeCookie } = await requestMagicLink('same-device@example.com');
    const res = await call(
      app,
      req('/api/v1/auth/consume', {
        method: 'POST',
        body: JSON.stringify({ token }),
        cookie: `bapp_challenge=${challengeCookie}`,
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ status: string; user: { email: string }; budgetId: string }>();
    expect(body.status).toBe('signed_in');
    expect(body.user.email).toBe('same-device@example.com');
    expect(body.budgetId).toBeTruthy();
    expect(cookieValue(res.headers.get('Set-Cookie'), '__Host-session')).toBeTruthy();
  });

  it('auto-creates exactly one budget for a brand-new user', async () => {
    await signInNewUser('budget-check@example.com');

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
    const res = await call(app, req('/api/v1/auth/consume', { method: 'POST', body: JSON.stringify({ token }) }));
    expect(await res.json()).toEqual({ status: 'needs_confirmation' });
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('signs in via explicit confirm after needs_confirmation', async () => {
    const { app, token } = await requestMagicLink('confirm-me@example.com');
    const res = await call(
      app,
      req('/api/v1/auth/consume', { method: 'POST', body: JSON.stringify({ token, confirm: true }) }),
    );
    const body = await res.json<{ status: string }>();
    expect(body.status).toBe('signed_in');
  });

  it('rejects an unknown token as invalid', async () => {
    const app = createApp(new CapturingEmailSender());
    const res = await call(
      app,
      req('/api/v1/auth/consume', { method: 'POST', body: JSON.stringify({ token: 'not-a-real-token' }) }),
    );
    expect(await res.json()).toEqual({ status: 'invalid' });
  });

  it('a token can only be consumed once', async () => {
    const { app, token, challengeCookie } = await requestMagicLink('one-shot@example.com');
    const first = await call(
      app,
      req('/api/v1/auth/consume', {
        method: 'POST',
        body: JSON.stringify({ token }),
        cookie: `bapp_challenge=${challengeCookie}`,
      }),
    );
    expect((await first.json<{ status: string }>()).status).toBe('signed_in');

    const second = await call(
      app,
      req('/api/v1/auth/consume', {
        method: 'POST',
        body: JSON.stringify({ token }),
        cookie: `bapp_challenge=${challengeCookie}`,
      }),
    );
    expect(await second.json()).toEqual({ status: 'invalid' });
  });
});

describe('session-gated routes', () => {
  it('GET /me is 401 without a session cookie', async () => {
    const app = createApp(new CapturingEmailSender());
    const res = await call(app, req('/api/v1/auth/me'));
    expect(res.status).toBe(401);
  });

  it('GET /me returns the user and their auto-created budget when signed in', async () => {
    const { app, sessionCookie } = await signInNewUser('me-route@example.com');
    const res = await call(app, req('/api/v1/auth/me', { cookie: `__Host-session=${sessionCookie}` }));
    const body = await res.json<{ user: { email: string }; budgets: { role: string }[] }>();
    expect(body.user.email).toBe('me-route@example.com');
    expect(body.budgets).toHaveLength(1);
    expect(body.budgets[0]?.role).toBe('owner');
  });

  it('GET /budgets/:id is 403 for a budget the user does not belong to', async () => {
    const { app: appA, sessionCookie: cookieA } = await signInNewUser('user-a@example.com');
    const { budgetId: budgetB } = await signInNewUser('user-b@example.com');

    const res = await call(appA, req(`/api/v1/budgets/${budgetB}`, { cookie: `__Host-session=${cookieA}` }));
    expect(res.status).toBe(403);
  });

  it('GET /budgets/:id is 200 for the caller’s own budget', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('own-budget@example.com');
    const res = await call(app, req(`/api/v1/budgets/${budgetId}`, { cookie: `__Host-session=${sessionCookie}` }));
    expect(res.status).toBe(200);
    const body = await res.json<{ role: string }>();
    expect(body.role).toBe('owner');
  });

  it('POST /logout revokes the session', async () => {
    const { app, sessionCookie } = await signInNewUser('logout-me@example.com');
    await call(app, req('/api/v1/auth/logout', { method: 'POST', cookie: `__Host-session=${sessionCookie}` }));
    const res = await call(app, req('/api/v1/auth/me', { cookie: `__Host-session=${sessionCookie}` }));
    expect(res.status).toBe(401);
  });
});

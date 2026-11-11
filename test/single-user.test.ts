import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { CapturingEmailSender, call, callJson, cookieValue, req, resetDb, signInNewUser } from './helpers';

// The production sign-in policy: existing users only. Every other test file
// uses anyoneMaySignIn so each test gets an isolated user — this one is the
// only place the real lock is exercised, so it builds the app with
// createApp's DEFAULT policy, exactly as src/index.ts does. The owner is
// created first through the open policy, standing in for the user row that
// already exists in every real environment.

beforeEach(resetDb);

async function requestLink(email: string) {
  const sender = new CapturingEmailSender();
  const app = createApp(sender);
  const res = await call(
    app,
    req('/api/v1/auth/magic-link', { method: 'POST', body: JSON.stringify({ email }), headers: { 'CF-Connecting-IP': email } }),
  );
  return { app, sender, res };
}

describe('single-user sign-in lock', () => {
  it('lets an existing user sign in again', async () => {
    await signInNewUser('owner@example.com');
    const { app, sender, res } = await requestLink('owner@example.com');
    expect(res.status).toBe(200);
    expect(sender.sent).toHaveLength(1);

    const token = new URL(sender.sent[0]!.confirmUrl).searchParams.get('token')!;
    const challenge = cookieValue(res.headers.get('Set-Cookie'), 'bapp_challenge');
    const consumed = await call(
      app,
      req('/api/v1/auth/consume', { method: 'POST', body: JSON.stringify({ token }), cookie: `bapp_challenge=${challenge}` }),
    );
    expect(await consumed.json()).toMatchObject({ status: 'signed_in' });
  });

  it('matches an existing user case-insensitively', async () => {
    await signInNewUser('owner@example.com');
    const { sender } = await requestLink('Owner@Example.COM');
    expect(sender.sent).toHaveLength(1);
  });

  it('refuses an unknown address WITHOUT revealing it: same 200, no email, no cookie', async () => {
    // Identical to the owner's response from the outside, so the endpoint
    // can't be used to discover the owner's address or to send mail from
    // this domain to strangers.
    await signInNewUser('owner@example.com');
    const { sender, res } = await requestLink('stranger@example.com');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(sender.sent).toHaveLength(0);
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('never creates a user — an empty database admits nobody', async () => {
    // Fails closed by construction: no configuration to forget.
    const { sender } = await requestLink('owner@example.com');
    expect(sender.sent).toHaveLength(0);
    const { results } = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').all<{ n: number }>();
    expect(results[0]!.n).toBe(0);
  });

  it('refuses at consume a link minted for a user who was removed afterwards', async () => {
    // The issue-time check alone is not enough: signInUser find-or-creates,
    // so a still-valid link for a deleted user would otherwise recreate them.
    const { results: before } = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').all<{ n: number }>();
    expect(before[0]!.n).toBe(0);
    await env.DB.prepare(
      "INSERT INTO users (id, email, email_normalized, created_at) VALUES ('u-gone', 'gone@example.com', 'gone@example.com', 0)",
    ).run();
    const { app, sender, res } = await requestLink('gone@example.com');
    expect(sender.sent).toHaveLength(1);
    await env.DB.prepare("DELETE FROM users WHERE id = 'u-gone'").run();

    const token = new URL(sender.sent[0]!.confirmUrl).searchParams.get('token')!;
    const challenge = cookieValue(res.headers.get('Set-Cookie'), 'bapp_challenge');
    const consumed = await call(
      app,
      req('/api/v1/auth/consume', { method: 'POST', body: JSON.stringify({ token }), cookie: `bapp_challenge=${challenge}` }),
    );
    expect(await consumed.json()).toEqual({ status: 'invalid' });
    const { results: after } = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').all<{ n: number }>();
    expect(after[0]!.n).toBe(0);
  });
});

describe('budget isolation', () => {
  // The role ladder is gone; what is left of requireBudgetMember is the
  // check that a budget id in the URL belongs to the caller. Nothing pinned
  // that before this test, and an earlier draft of the role removal briefly
  // dropped it from GET /budgets/:budgetId — so it is pinned on both the
  // budget itself and a sub-resource.
  it("refuses another user's budget, on the budget and on its sub-resources", async () => {
    const a = await signInNewUser('a@example.com');
    const b = await signInNewUser('b@example.com');

    for (const path of [`/api/v1/budgets/${b.budgetId}`, `/api/v1/budgets/${b.budgetId}/accounts`]) {
      const { status } = await callJson(a.app, a.sessionCookie, path);
      expect(status, path).toBe(403);
    }
    // ...while the owner still gets in.
    const { status } = await callJson(b.app, b.sessionCookie, `/api/v1/budgets/${b.budgetId}`);
    expect(status).toBe(200);
  });
});

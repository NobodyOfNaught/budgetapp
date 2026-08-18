import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { call, callJson, req, resetDb, signInNewUser } from './helpers';

beforeEach(resetDb);

describe('POST /api/v1/budgets/:budgetId/accounts', () => {
  it('creates an ordinary account', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('accounts-basic@example.com');
    const { status, body } = await callJson<{ account: { id: string; onBudget: boolean } }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/accounts`,
      { method: 'POST', body: JSON.stringify({ name: 'Checking', type: 'checking' }) },
    );
    expect(status).toBe(201);
    expect(body.account.onBudget).toBe(true);

    const list = await callJson<{ accounts: { name: string }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/accounts`,
    );
    expect(list.body.accounts.map((a) => a.name)).toContain('Checking');
  });

  it('defaults tracking accounts to off-budget', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('accounts-tracking@example.com');
    const { body } = await callJson<{ account: { onBudget: boolean } }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/accounts`,
      { method: 'POST', body: JSON.stringify({ name: 'Investments', type: 'tracking_asset' }) },
    );
    expect(body.account.onBudget).toBe(false);
  });

  it('a starting balance becomes an uncategorized inflow transaction', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('accounts-starting@example.com');
    const { body } = await callJson<{ account: { id: string } }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/accounts`,
      {
        method: 'POST',
        body: JSON.stringify({ name: 'Checking', type: 'checking', startingBalance: '500.00', startingBalanceDate: '2026-01-01' }),
      },
    );

    const row = await env.DB.prepare(
      'select amount_minor, category_id, date from transactions where account_id = ?',
    )
      .bind(body.account.id)
      .first<{ amount_minor: number; category_id: string | null; date: string }>();
    expect(row).toMatchObject({ amount_minor: 50000, category_id: null, date: '2026-01-01' });
  });

  it('a credit account gets a linked payment category automatically', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('accounts-credit@example.com');
    const { body } = await callJson<{ account: { id: string } }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/accounts`,
      { method: 'POST', body: JSON.stringify({ name: 'Visa', type: 'credit_card' }) },
    );

    const { body: cats } = await callJson<{
      groups: { name: string; isSystem: boolean; categories: { name: string; kind: string; linkedAccountId: string }[] }[];
    }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/categories`);

    const systemGroup = cats.groups.find((g) => g.isSystem);
    expect(systemGroup?.name).toBe('Credit Card Payments');
    expect(systemGroup?.categories).toHaveLength(1);
    expect(systemGroup?.categories[0]).toMatchObject({ name: 'Visa', kind: 'credit_card_payment', linkedAccountId: body.account.id });
  });

  it('a negative credit-card starting balance lands directly on the payment category (no spending category involved)', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('accounts-credit-start@example.com');
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/accounts`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Visa', type: 'credit_card', startingBalance: '-100.00' }),
    });

    const row = await env.DB.prepare(
      `select amount_minor, category_id from transactions t
       join accounts a on a.id = t.account_id
       where a.name = 'Visa'`,
    ).first<{ amount_minor: number; category_id: string | null }>();
    expect(row?.amount_minor).toBe(-10000);
    expect(row?.category_id).toBeNull(); // uncategorized — see docs/plan.md; the ledger engine routes this to Payment
  });

  it('rejects an unknown account type', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('accounts-invalid-type@example.com');
    const { status } = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/accounts`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Mystery', type: 'bitcoin_wallet' }),
    });
    expect(status).toBe(400);
  });

  it('403s for a user who is not a member of the budget', async () => {
    const { budgetId } = await signInNewUser('accounts-owner@example.com');
    const { app: outsiderApp, sessionCookie: outsiderCookie } = await signInNewUser('accounts-outsider@example.com');
    const { status } = await callJson(outsiderApp, outsiderCookie, `/api/v1/budgets/${budgetId}/accounts`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Sneaky', type: 'checking' }),
    });
    expect(status).toBe(403);
  });
});

describe('PATCH /api/v1/budgets/:budgetId/accounts/:accountId', () => {
  it('renames an account and keeps a credit account’s payment category name in sync', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('accounts-rename@example.com');
    const { body } = await callJson<{ account: { id: string } }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/accounts`,
      { method: 'POST', body: JSON.stringify({ name: 'Visa', type: 'credit_card' }) },
    );

    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/accounts/${body.account.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Visa Signature' }),
    });

    const { body: cats } = await callJson<{ groups: { categories: { name: string; linkedAccountId: string | null }[] }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/categories`,
    );
    const paymentCat = cats.groups.flatMap((g) => g.categories).find((c) => c.linkedAccountId === body.account.id);
    expect(paymentCat?.name).toBe('Visa Signature');
  });

  it('closes an account', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('accounts-close@example.com');
    const { body } = await callJson<{ account: { id: string } }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/accounts`,
      { method: 'POST', body: JSON.stringify({ name: 'Old Savings', type: 'savings' }) },
    );

    const { status } = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/accounts/${body.account.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ closed: true }),
    });
    expect(status).toBe(200);

    const row = await env.DB.prepare('select closed_at from accounts where id = ?')
      .bind(body.account.id)
      .first<{ closed_at: number | null }>();
    expect(row?.closed_at).not.toBeNull();
  });
});

// Sanity check that call()/req() still behave with no cookie at all.
describe('unauthenticated access', () => {
  it('401s without a session', async () => {
    const { app, budgetId } = await signInNewUser('accounts-noauth@example.com');
    const res = await call(app, req(`/api/v1/budgets/${budgetId}/accounts`));
    expect(res.status).toBe(401);
  });
});

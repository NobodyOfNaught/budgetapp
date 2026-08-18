import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { callJson, resetDb, signInNewUser } from './helpers';

beforeEach(resetDb);

interface MonthView {
  month: string;
  readyToAssign: number;
  categories: Record<string, { assigned: number; activity: number; available: number }>;
}

async function createAccount(
  app: Awaited<ReturnType<typeof signInNewUser>>['app'],
  sessionCookie: string,
  budgetId: string,
  body: Record<string, unknown>,
) {
  const { body: res } = await callJson<{ account: { id: string } }>(
    app,
    sessionCookie,
    `/api/v1/budgets/${budgetId}/accounts`,
    { method: 'POST', body: JSON.stringify(body) },
  );
  return res.account.id;
}

async function spendingCategoryIds(
  app: Awaited<ReturnType<typeof signInNewUser>>['app'],
  sessionCookie: string,
  budgetId: string,
) {
  const { body } = await callJson<{ groups: { categories: { id: string; kind: string }[] }[] }>(
    app,
    sessionCookie,
    `/api/v1/budgets/${budgetId}/categories`,
  );
  return body.groups.flatMap((g) => g.categories).filter((c) => c.kind === 'spending');
}

describe('GET /api/v1/budgets/:budgetId/months/:month', () => {
  it('is all zero on a brand-new budget, but lists the seeded categories', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('months-empty@example.com');
    const { status, body } = await callJson<MonthView>(app, sessionCookie, `/api/v1/budgets/${budgetId}/months/2026-03`);
    expect(status).toBe(200);
    expect(body.readyToAssign).toBe(0);
    const values = Object.values(body.categories);
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((c) => c.assigned === 0 && c.activity === 0 && c.available === 0)).toBe(true);
  });

  it('reflects income, an assignment, and a purchase — matching the ledger engine by hand', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('months-basic@example.com');
    const accountId = await createAccount(app, sessionCookie, budgetId, { name: 'Checking', type: 'checking' });
    const [groceries] = await spendingCategoryIds(app, sessionCookie, budgetId);

    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId, date: '2026-03-01', amount: '200.00' }), // income
    });
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/months/2026-03/assignments`, {
      method: 'PUT',
      body: JSON.stringify({ assignments: [{ categoryId: groceries!.id, assigned: '50.00' }] }),
    });
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId, date: '2026-03-05', amount: '-30.00', categoryId: groceries!.id }),
    });

    const { body } = await callJson<MonthView>(app, sessionCookie, `/api/v1/budgets/${budgetId}/months/2026-03`);
    expect(body.categories[groceries!.id]).toEqual({
      categoryId: groceries!.id,
      assigned: 5000,
      activity: -3000,
      available: 2000,
    });
    expect(body.readyToAssign).toBe(15000); // 20000 income - 5000 assigned
  });

  it('carries a positive available forward into the next month, matching the domain engine', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('months-carry@example.com');
    const accountId = await createAccount(app, sessionCookie, budgetId, { name: 'Checking', type: 'checking' });
    const [groceries] = await spendingCategoryIds(app, sessionCookie, budgetId);

    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId, date: '2026-03-01', amount: '100.00' }),
    });
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/months/2026-03/assignments`, {
      method: 'PUT',
      body: JSON.stringify({ assignments: [{ categoryId: groceries!.id, assigned: '40.00' }] }),
    });

    const { body } = await callJson<MonthView>(app, sessionCookie, `/api/v1/budgets/${budgetId}/months/2026-04`);
    expect(body.categories[groceries!.id]?.available).toBe(4000); // carried forward, untouched
  });
});

describe('PUT .../months/:month/assignments', () => {
  it('a single assignment persists and shows up on the next GET', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('months-assign@example.com');
    const [groceries] = await spendingCategoryIds(app, sessionCookie, budgetId);

    const { status } = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/months/2026-03/assignments`, {
      method: 'PUT',
      body: JSON.stringify({ assignments: [{ categoryId: groceries!.id, assigned: '75.00' }] }),
    });
    expect(status).toBe(200);

    const { body } = await callJson<MonthView>(app, sessionCookie, `/api/v1/budgets/${budgetId}/months/2026-03`);
    expect(body.categories[groceries!.id]?.assigned).toBe(7500);
  });

  it('re-assigning the same category replaces the value rather than adding to it', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('months-reassign@example.com');
    const [groceries] = await spendingCategoryIds(app, sessionCookie, budgetId);

    for (const amount of ['50.00', '80.00']) {
      await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/months/2026-03/assignments`, {
        method: 'PUT',
        body: JSON.stringify({ assignments: [{ categoryId: groceries!.id, assigned: amount }] }),
      });
    }

    const { body } = await callJson<MonthView>(app, sessionCookie, `/api/v1/budgets/${budgetId}/months/2026-03`);
    expect(body.categories[groceries!.id]?.assigned).toBe(8000); // not 130.00
  });

  it('"move money" is one batch touching two categories, and leaves Ready to Assign untouched', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('months-move@example.com');
    const accountId = await createAccount(app, sessionCookie, budgetId, { name: 'Checking', type: 'checking' });
    const [groceries, rent] = await spendingCategoryIds(app, sessionCookie, budgetId);

    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId, date: '2026-03-01', amount: '200.00' }),
    });
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/months/2026-03/assignments`, {
      method: 'PUT',
      body: JSON.stringify({ assignments: [{ categoryId: groceries!.id, assigned: '50.00' }] }),
    });

    // Move $20 from Groceries to Rent in one batch.
    const { body } = await callJson<MonthView>(app, sessionCookie, `/api/v1/budgets/${budgetId}/months/2026-03/assignments`, {
      method: 'PUT',
      body: JSON.stringify({
        assignments: [
          { categoryId: groceries!.id, assigned: '30.00' },
          { categoryId: rent!.id, assigned: '20.00' },
        ],
      }),
    });

    expect(body.categories[groceries!.id]?.assigned).toBe(3000);
    expect(body.categories[rent!.id]?.assigned).toBe(2000);
    expect(body.readyToAssign).toBe(15000); // 20000 - 5000 total assigned either way, unaffected by the move
  });

  it('assigning to a credit account’s payment category works (covering a starting-balance-style deficit)', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('months-payment-cat@example.com');
    await createAccount(app, sessionCookie, budgetId, {
      name: 'Visa',
      type: 'credit_card',
      startingBalance: '-40.00',
      // The route defaults an unspecified starting-balance date to *today*
      // (see src/routes/accounts.ts) — pin it into the month under test so
      // this doesn't silently break every August.
      startingBalanceDate: '2026-03-01',
    });
    const { body: cats } = await callJson<{ groups: { categories: { id: string; kind: string }[] }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/categories`,
    );
    const paymentCat = cats.groups.flatMap((g) => g.categories).find((c) => c.kind === 'credit_card_payment')!;

    const { body: before } = await callJson<MonthView>(app, sessionCookie, `/api/v1/budgets/${budgetId}/months/2026-03`);
    expect(before.categories[paymentCat.id]?.available).toBe(-4000);

    const { body: after } = await callJson<MonthView>(app, sessionCookie, `/api/v1/budgets/${budgetId}/months/2026-03/assignments`, {
      method: 'PUT',
      body: JSON.stringify({ assignments: [{ categoryId: paymentCat.id, assigned: '40.00' }] }),
    });
    expect(after.categories[paymentCat.id]?.available).toBe(0); // covered
  });

  it('rejects assigning to a category from a different budget', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('months-foreign-cat@example.com');
    const { app: otherApp, sessionCookie: otherCookie, budgetId: otherBudgetId } = await signInNewUser(
      'months-foreign-cat-other@example.com',
    );
    const [foreignCategory] = await spendingCategoryIds(otherApp, otherCookie, otherBudgetId);

    const { status } = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/months/2026-03/assignments`, {
      method: 'PUT',
      body: JSON.stringify({ assignments: [{ categoryId: foreignCategory!.id, assigned: '10.00' }] }),
    });
    expect(status).toBe(400);
  });

  it('rejects assigning to an income-kind category', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('months-income-cat@example.com');
    // No creation path in the app ever produces an income-kind category
    // (uncategorized inflows are how income normally works — see
    // docs/plan.md) — inserted directly to prove the defensive check in
    // src/routes/months.ts actually fires, not just that it's unreachable.
    const { body: groups } = await callJson<{ groups: { id: string }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/categories`,
    );
    const groupId = groups.groups[0]!.id;
    const incomeCategoryId = 'test-income-category';
    await env.DB.prepare(
      'insert into categories (id, budget_id, group_id, name, kind, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(incomeCategoryId, budgetId, groupId, 'Salary', 'income', Date.now(), Date.now())
      .run();

    const { status } = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/months/2026-03/assignments`, {
      method: 'PUT',
      body: JSON.stringify({ assignments: [{ categoryId: incomeCategoryId, assigned: '10.00' }] }),
    });
    expect(status).toBe(400);
  });

  it('rejects an invalid amount and an invalid month format', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('months-invalid@example.com');
    const [groceries] = await spendingCategoryIds(app, sessionCookie, budgetId);

    const badAmount = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/months/2026-03/assignments`, {
      method: 'PUT',
      body: JSON.stringify({ assignments: [{ categoryId: groceries!.id, assigned: 'lots' }] }),
    });
    expect(badAmount.status).toBe(400);

    const badMonth = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/months/not-a-month`);
    expect(badMonth.status).toBe(400);
  });
});

describe('authorization', () => {
  it('403s for a user who is not a budget member', async () => {
    const { budgetId } = await signInNewUser('months-owner@example.com');
    const { app: outsiderApp, sessionCookie: outsiderCookie } = await signInNewUser('months-outsider@example.com');

    const res = await callJson(outsiderApp, outsiderCookie, `/api/v1/budgets/${budgetId}/months/2026-03`);
    expect(res.status).toBe(403);
  });
});

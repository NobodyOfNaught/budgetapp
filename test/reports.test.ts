import { beforeEach, describe, expect, it } from 'vitest';
import { callJson, resetDb, signInNewUser } from './helpers';

beforeEach(resetDb);

interface SpendingReport {
  start: string;
  end: string;
  categories: { categoryId: string; spentMinor: number }[];
}

interface IncomeExpenseReport {
  months: { month: string; incomeMinor: number; expenseMinor: number }[];
}

interface NetWorthReport {
  months: { month: string; assetsMinor: number; liabilitiesMinor: number; netWorthMinor: number }[];
  unvalued: { accountId: string; name: string; currencyCode: string }[];
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

async function categoryIds(
  app: Awaited<ReturnType<typeof signInNewUser>>['app'],
  sessionCookie: string,
  budgetId: string,
) {
  const { body } = await callJson<{ groups: { categories: { id: string; name: string; kind: string }[] }[] }>(
    app,
    sessionCookie,
    `/api/v1/budgets/${budgetId}/categories`,
  );
  return body.groups.flatMap((g) => g.categories);
}

describe('GET /api/v1/budgets/:budgetId/reports/spending', () => {
  it('sums ordinary spending, a split, and a credit-card purchase by category — excluding the payment category', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('reports-spending@example.com');
    const checking = await createAccount(app, sessionCookie, budgetId, { name: 'Checking', type: 'checking' });
    const card = await createAccount(app, sessionCookie, budgetId, { name: 'Card', type: 'credit_card' });
    const cats = await categoryIds(app, sessionCookie, budgetId);
    const groceries = cats.find((c) => c.name === 'Groceries')!;
    const dining = cats.find((c) => c.name === 'Dining Out')!;

    // Ordinary spending.
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: checking, date: '2026-03-05', amount: '-40.00', categoryId: groceries.id }),
    });
    // A split, one part into the same category.
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'split',
        accountId: checking,
        date: '2026-03-10',
        splits: [
          { amount: '-10.00', categoryId: groceries.id },
          { amount: '-15.00', categoryId: dining.id },
        ],
      }),
    });
    // A credit-card purchase — should count under Groceries, NOT the auto-created payment category.
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: card, date: '2026-03-12', amount: '-25.00', categoryId: groceries.id }),
    });

    const { status, body } = await callJson<SpendingReport>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/reports/spending?start=2026-03&end=2026-03`,
    );
    expect(status).toBe(200);

    const byId = new Map(body.categories.map((c) => [c.categoryId, c.spentMinor]));
    expect(byId.get(groceries.id)).toBe(-7500); // -40 - 10 - 25
    expect(byId.get(dining.id)).toBe(-1500);
    // The credit_card_payment category the card's creation auto-created
    // must not appear — it's not a 'spending'-kind category, and its own
    // activity (the doubled earmark from the card purchase above) is a
    // different number entirely, not "spending".
    const payment = cats.find((c) => c.kind === 'credit_card_payment')!;
    expect(payment).toBeDefined();
    expect(byId.has(payment.id)).toBe(false);
  });

  it('is empty outside the requested range', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('reports-spending-range@example.com');
    const checking = await createAccount(app, sessionCookie, budgetId, { name: 'Checking', type: 'checking' });
    const [groceries] = await categoryIds(app, sessionCookie, budgetId);

    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: checking, date: '2026-01-05', amount: '-40.00', categoryId: groceries!.id }),
    });

    const { body } = await callJson<SpendingReport>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/reports/spending?start=2026-03&end=2026-03`,
    );
    // The category still appears (every spending category does, every
    // month — same convention as GET .../months/:month) but with zero
    // activity, since the $40 purchase was dated in January, outside range.
    expect(body.categories.find((c) => c.categoryId === groceries!.id)?.spentMinor).toBe(0);
  });
});

describe('GET /api/v1/budgets/:budgetId/reports/income-expense', () => {
  it('reports income, a boundary-crossing transfer, and spending across two months', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('reports-income-expense@example.com');
    const checking = await createAccount(app, sessionCookie, budgetId, { name: 'Checking', type: 'checking' });
    const investing = await createAccount(app, sessionCookie, budgetId, { name: 'Investing', type: 'tracking_asset' });
    const [groceries] = await categoryIds(app, sessionCookie, budgetId);

    // Month 1: $500 uncategorized inflow (income), $60 spent on Groceries.
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: checking, date: '2026-03-01', amount: '500.00' }),
    });
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: checking, date: '2026-03-05', amount: '-60.00', categoryId: groceries!.id }),
    });
    // Month 2: $100 sent to the tracking account — leaves the budget, so
    // it's an expense-like negative contribution to incomeThisMonth.
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'transfer', accountId: checking, transferToAccountId: investing, date: '2026-04-01', amount: '100.00' }),
    });

    const { status, body } = await callJson<IncomeExpenseReport>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/reports/income-expense?start=2026-03&end=2026-04`,
    );
    expect(status).toBe(200);

    const march = body.months.find((m) => m.month === '2026-03-01')!;
    expect(march.incomeMinor).toBe(50000);
    expect(march.expenseMinor).toBe(6000);

    const april = body.months.find((m) => m.month === '2026-04-01')!;
    expect(april.incomeMinor).toBe(-10000); // money left the budget
    expect(april.expenseMinor).toBe(0);
  });
});

describe('GET /api/v1/budgets/:budgetId/reports/net-worth', () => {
  it('trends assets and liabilities across an on-budget and a tracking account', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('reports-net-worth@example.com');
    await createAccount(app, sessionCookie, budgetId, {
      name: 'Checking',
      type: 'checking',
      startingBalance: '1000.00',
      startingBalanceDate: '2026-03-01',
    });
    await createAccount(app, sessionCookie, budgetId, {
      name: 'Card',
      type: 'credit_card',
      startingBalance: '-200.00',
      startingBalanceDate: '2026-03-01',
    });

    const { status, body } = await callJson<NetWorthReport>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/reports/net-worth?start=2026-03&end=2026-03`,
    );
    expect(status).toBe(200);
    expect(body.months).toEqual([{ month: '2026-03-01', assetsMinor: 100000, liabilitiesMinor: -20000, netWorthMinor: 80000 }]);
    expect(body.unvalued).toEqual([]); // single-currency budget, nothing to caveat
  });

  it('values a foreign account’s BALANCE at its rate, not the sum of its transactions’ own conversions', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('reports-net-worth-fx@example.com');
    await createAccount(app, sessionCookie, budgetId, {
      name: 'Neo',
      type: 'credit_card',
      currencyCode: 'CAD',
      fxRate: '0.73',
      startingBalance: '-1000.00',
      startingBalanceDate: '2026-03-01',
    });

    const { body } = await callJson<NetWorthReport>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/reports/net-worth?start=2026-03&end=2026-03`,
    );
    // CAD 1000.00 owed -> USD 730.00 at the account's rate.
    expect(body.months[0]?.liabilitiesMinor).toBe(-73000);
    expect(body.unvalued).toEqual([]);
  });

  it('reports a foreign account with no rate as unvalued rather than passing its estimate off as fact', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('reports-net-worth-unvalued@example.com');
    const accountId = await createAccount(app, sessionCookie, budgetId, {
      name: 'Cash (CAD)',
      type: 'tracking_asset',
      currencyCode: 'CAD',
      startingBalance: '1282.68',
      startingBalanceDate: '2026-03-01',
    });

    const { body } = await callJson<NetWorthReport>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/reports/net-worth?start=2026-03&end=2026-03`,
    );
    // No rate to revalue with, so the accumulated figure stands — but it is
    // named, so the UI can mark it an estimate.
    expect(body.months[0]?.assetsMinor).toBe(128268);
    expect(body.unvalued).toEqual([{ accountId, name: 'Cash (CAD)', currencyCode: 'CAD' }]);
  });
});

describe('report authorization and validation', () => {
  it('400s on a missing or malformed date range', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('reports-invalid@example.com');
    const { status } = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/reports/spending`);
    expect(status).toBe(400);

    const { status: status2 } = await callJson(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/reports/spending?start=2026-05&end=2026-03`, // end before start
    );
    expect(status2).toBe(400);
  });

  it('403s for a non-member', async () => {
    const owner = await signInNewUser('reports-owner@example.com');
    const outsider = await signInNewUser('reports-outsider@example.com');

    const { status } = await callJson(
      outsider.app,
      outsider.sessionCookie,
      `/api/v1/budgets/${owner.budgetId}/reports/net-worth?start=2026-03&end=2026-03`,
    );
    expect(status).toBe(403);
  });
});

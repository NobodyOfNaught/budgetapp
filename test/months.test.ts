import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { callJson, resetDb, signInNewUser } from './helpers';

beforeEach(resetDb);

interface MonthView {
  month: string;
  readyToAssign: number;
  categories: Record<string, { assigned: number; activity: number; available: number }>;
  cashOnHandMinor: number;
  creditDebtMinor: number;
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

  // PR 15: proves ledger.ts needed zero changes to support a budgetable
  // foreign-currency credit card — it already reads budgetAmountMinor
  // exclusively (see src/domain/ledger.ts's accumulateMonth). The row
  // under test gets its budgetAmountMinor from a real statement import
  // (src/routes/imports.ts), which is where the PR 15 conversion work
  // actually lives; this test is purely about what the ledger engine does
  // with a correctly-converted row once it exists.
  it('a budgeted CAD credit card: a categorized charge moves the USD category and earmarks the payment category, both converted', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('months-fx-ledger@example.com');
    const { body: created } = await callJson<{ account: { id: string; onBudget: boolean } }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/accounts`,
      { method: 'POST', body: JSON.stringify({ name: 'Neo', type: 'credit_card', currencyCode: 'CAD', fxRate: '0.73' }) },
    );
    expect(created.account.onBudget).toBe(true);

    const wiseHeader =
      'ID,Status,Direction,"Created on","Finished on","Source fee amount","Source fee currency",' +
      '"Target fee amount","Target fee currency","Source name","Source amount (after fees)","Source currency",' +
      '"Target name","Target amount (after fees)","Target currency","Exchange rate",Reference,Batch,' +
      '"Created by",Category,Note';
    const timHortonsCad =
      '"CARD_TRANSACTION-9100000001",COMPLETED,OUT,"2026-03-05 08:00:00","2026-03-05 08:00:00",0.00,CAD,,,' +
      '"Palle Helenius",100.00,CAD,"Tim Hortons",100.00,CAD,1.0000000000000000,,,"Palle Helenius",Groceries,';
    const wiseCsv = [wiseHeader, timHortonsCad, ''].join('\n');

    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/imports`, {
      method: 'POST',
      body: JSON.stringify({ accountId: created.account.id, provider: 'wise', filename: 'neo.csv', csv: wiseCsv }),
    });

    const [groceries] = await spendingCategoryIds(app, sessionCookie, budgetId);
    const { body: cats } = await callJson<{ groups: { categories: { id: string; kind: string; linkedAccountId: string | null }[] }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/categories`,
    );
    const paymentCat = cats.groups.flatMap((g) => g.categories).find((c) => c.linkedAccountId === created.account.id)!;

    const { body: review } = await callJson<{ transactions: { id: string; payeeName: string | null }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/imports/review`,
    );
    const row = review.transactions.find((r) => r.payeeName === 'Tim Hortons')!;
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/imports/review`, {
      method: 'PATCH',
      body: JSON.stringify({ updates: [{ transactionId: row.id, categoryId: groceries!.id, approved: true }] }),
    });

    const { body: month } = await callJson<MonthView>(app, sessionCookie, `/api/v1/budgets/${budgetId}/months/2026-03`);
    // -100.00 CAD * 0.73 = -73.00 USD -> -7300 minor.
    expect(month.categories[groceries!.id]?.activity).toBe(-7300);
    // Credit-card earmark: the opposite sign, in the same converted amount.
    expect(month.categories[paymentCat.id]?.activity).toBe(7300);
    expect(month.categories[paymentCat.id]?.available).toBe(7300); // no assignment yet, carryover 0
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

describe('covering an overspent category', () => {
  // The arithmetic behind BudgetMonth.tsx's "Cover" button, pinned here
  // because the button is a one-line UI affordance over a claim about the
  // ledger: assigning `assigned - available` lands available on EXACTLY
  // zero. That falls out of available = assigned + activity + carryover —
  // substituting assigned' = assigned - available gives available' =
  // available - available — so it holds whatever the activity and
  // carryover happen to be, which is what makes a single button safe.
  async function overspent(email: string) {
    const { app, sessionCookie, budgetId } = await signInNewUser(email);
    const accountId = await createAccount(app, sessionCookie, budgetId, { name: 'Checking', type: 'checking' });
    const [category] = await spendingCategoryIds(app, sessionCookie, budgetId);

    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId, date: '2026-03-01', amount: '500.00' }),
    });
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'ordinary',
        accountId,
        date: '2026-03-10',
        amount: '-64.73',
        categoryId: category!.id,
      }),
    });
    return { app, sessionCookie, budgetId, categoryId: category!.id };
  }

  async function month(
    app: Awaited<ReturnType<typeof signInNewUser>>['app'],
    cookie: string,
    budgetId: string,
    m = '2026-03',
  ) {
    const { body } = await callJson<MonthView>(app, cookie, `/api/v1/budgets/${budgetId}/months/${m}`);
    return body;
  }

  it('lands available on exactly zero from nothing assigned', async () => {
    // The screenshot case: Boogie at assigned 0.00, available -64.73.
    const { app, sessionCookie, budgetId, categoryId } = await overspent('cover-basic@example.com');

    const before = await month(app, sessionCookie, budgetId);
    expect(before.categories[categoryId]).toMatchObject({ assigned: 0, available: -6473 });

    const amounts = before.categories[categoryId]!;
    const { body: after } = await callJson<MonthView>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/months/2026-03/assignments`,
      {
        method: 'PUT',
        body: JSON.stringify({
          assignments: [{ categoryId, assigned: ((amounts.assigned - amounts.available) / 100).toFixed(2) }],
        }),
      },
    );
    expect(after.categories[categoryId]).toMatchObject({ assigned: 6473, available: 0 });
  });

  it('lands on zero when the category already had money assigned', async () => {
    // assigned - available is an ADJUSTMENT, not a replacement: 20.00
    // already assigned against -44.73 available must end at 64.73, not
    // at 44.73. Getting this backwards is the obvious way to write the
    // button wrong, and it looks right on the zero-assigned case above.
    const { app, sessionCookie, budgetId, categoryId } = await overspent('cover-partial@example.com');
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/months/2026-03/assignments`, {
      method: 'PUT',
      body: JSON.stringify({ assignments: [{ categoryId, assigned: '20.00' }] }),
    });

    const before = await month(app, sessionCookie, budgetId);
    expect(before.categories[categoryId]).toMatchObject({ assigned: 2000, available: -4473 });

    const amounts = before.categories[categoryId]!;
    const { body: after } = await callJson<MonthView>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/months/2026-03/assignments`,
      {
        method: 'PUT',
        body: JSON.stringify({
          assignments: [{ categoryId, assigned: ((amounts.assigned - amounts.available) / 100).toFixed(2) }],
        }),
      },
    );
    expect(after.categories[categoryId]).toMatchObject({ assigned: 6473, available: 0 });
  });

  it('lands on zero when a balance carried in from last month', async () => {
    // The carryover case, and the reason the button must read `available`
    // rather than `-activity`. A spending category can only be negative in
    // the month it was overspent — cash overspending resets to 0 the next
    // month and comes out of Ready to Assign instead (see
    // src/domain/ledger.ts) — so the way `available` diverges from this
    // month's activity is a POSITIVE balance rolling in. Here 20.00 rolls
    // from March into April and 64.73 is spent in April: available is
    // -44.73, but the assignment needed is 44.73, not the 64.73 that
    // activity alone would suggest.
    const { app, sessionCookie, budgetId } = await signInNewUser('cover-carryover@example.com');
    const accountId = await createAccount(app, sessionCookie, budgetId, { name: 'Checking', type: 'checking' });
    const [category] = await spendingCategoryIds(app, sessionCookie, budgetId);
    const categoryId = category!.id;

    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId, date: '2026-03-01', amount: '500.00' }),
    });
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/months/2026-03/assignments`, {
      method: 'PUT',
      body: JSON.stringify({ assignments: [{ categoryId, assigned: '20.00' }] }),
    });
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId, date: '2026-04-10', amount: '-64.73', categoryId }),
    });

    const april = await month(app, sessionCookie, budgetId, '2026-04');
    const amounts = april.categories[categoryId]!;
    expect(amounts).toMatchObject({ assigned: 0, activity: -6473, available: -4473 });

    const { body: after } = await callJson<MonthView>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/months/2026-04/assignments`,
      {
        method: 'PUT',
        body: JSON.stringify({
          assignments: [{ categoryId, assigned: ((amounts.assigned - amounts.available) / 100).toFixed(2) }],
        }),
      },
    );
    expect(after.categories[categoryId]).toMatchObject({ assigned: 4473, available: 0 });
  });
});

describe('what actually backs Ready to Assign', () => {
  async function month(
    app: Awaited<ReturnType<typeof signInNewUser>>['app'],
    cookie: string,
    budgetId: string,
    m: string,
  ) {
    const { body } = await callJson<MonthView>(app, cookie, `/api/v1/budgets/${budgetId}/months/${m}`);
    return body;
  }

  it('in a cash-only budget, cash on hand IS Ready to Assign plus every available', async () => {
    // The identity people expect, and it holds exactly — no credit cards
    // involved. This is the baseline the credit-card case below departs
    // from, so it is pinned first.
    const { app, sessionCookie, budgetId } = await signInNewUser('backing-cash-only@example.com');
    const accountId = await createAccount(app, sessionCookie, budgetId, { name: 'Checking', type: 'checking' });
    const [groceries] = await spendingCategoryIds(app, sessionCookie, budgetId);

    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId, date: '2026-03-01', amount: '500.00' }),
    });
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/months/2026-03/assignments`, {
      method: 'PUT',
      body: JSON.stringify({ assignments: [{ categoryId: groceries!.id, assigned: '200.00' }] }),
    });
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId, date: '2026-03-10', amount: '-75.00', categoryId: groceries!.id }),
    });

    const view = await month(app, sessionCookie, budgetId, '2026-03');
    const sumAvailable = Object.values(view.categories).reduce((s, c) => s + c.available, 0);

    expect(view.cashOnHandMinor).toBe(42500); // 500.00 in, 75.00 spent
    expect(view.creditDebtMinor).toBe(0);
    expect(view.readyToAssign + sumAvailable).toBe(view.cashOnHandMinor);
  });

  it('with a credit card, the gap is exactly the categorized card spending', async () => {
    // Why Ready to Assign can legitimately read higher than the cash
    // backing it. A card purchase moves money twice — the spending
    // category falls and the card's payment category rises, leaving
    // sum(available) unchanged — while the card balance falls. So the
    // identity picks up one extra term, and this pins what it is.
    const { app, sessionCookie, budgetId } = await signInNewUser('backing-with-card@example.com');
    const checking = await createAccount(app, sessionCookie, budgetId, { name: 'Checking', type: 'checking' });
    const card = await createAccount(app, sessionCookie, budgetId, { name: 'Visa', type: 'credit_card' });
    const [groceries] = await spendingCategoryIds(app, sessionCookie, budgetId);

    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: checking, date: '2026-03-01', amount: '500.00' }),
    });
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/months/2026-03/assignments`, {
      method: 'PUT',
      body: JSON.stringify({ assignments: [{ categoryId: groceries!.id, assigned: '200.00' }] }),
    });
    // 75.00 of groceries on the CARD.
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: card, date: '2026-03-10', amount: '-75.00', categoryId: groceries!.id }),
    });

    const view = await month(app, sessionCookie, budgetId, '2026-03');
    const sumAvailable = Object.values(view.categories).reduce((s, c) => s + c.available, 0);

    expect(view.cashOnHandMinor).toBe(50000); // untouched — nothing left chequing
    expect(view.creditDebtMinor).toBe(-7500);

    // cash + debt = RTA + sum(available) + categorized card spending
    expect(view.cashOnHandMinor + view.creditDebtMinor).toBe(view.readyToAssign + sumAvailable + -7500);
    // Note what that means here: the debt IS the categorized spending, so
    // the two extra terms cancel and the cash identity still holds. A
    // card purchase alone does not make Ready to Assign overstate cash —
    // the next case is what does.
    expect(view.readyToAssign + sumAvailable).toBe(view.cashOnHandMinor);
  });

  it('UNcategorized card debt is what pushes Ready to Assign above the cash backing it', async () => {
    // The real-world shape: a card imported with a balance already on it.
    // That row is uncategorized on a credit account, so the ledger sends
    // it straight into the payment category as debt nobody has budgeted
    // for — it never passes through Ready to Assign, which therefore keeps
    // reading as though the money were free. This is the case worth
    // showing on screen, because the headline number looks healthier than
    // the budget is and nothing about it says so.
    const { app, sessionCookie, budgetId } = await signInNewUser('backing-card-debt@example.com');
    const checking = await createAccount(app, sessionCookie, budgetId, { name: 'Checking', type: 'checking' });
    const card = await createAccount(app, sessionCookie, budgetId, { name: 'Visa', type: 'credit_card' });

    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: checking, date: '2026-03-01', amount: '500.00' }),
    });
    // Pre-existing card balance, uncategorized, as an import leaves it.
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: card, date: '2026-03-02', amount: '-300.00' }),
    });

    const view = await month(app, sessionCookie, budgetId, '2026-03');
    const sumAvailable = Object.values(view.categories).reduce((s, c) => s + c.available, 0);

    expect(view.cashOnHandMinor).toBe(50000);
    expect(view.creditDebtMinor).toBe(-30000);
    // Ready to Assign still reads the full 500 — the card debt went to the
    // payment category, not through here.
    expect(view.readyToAssign).toBe(50000);
    expect(sumAvailable).toBe(-30000);
    // So RTA alone matches cash, but only because the 300 of debt is
    // parked in a category showing -300. Assigning all 500 would leave
    // nothing for a card that needs 300.
    expect(view.readyToAssign + sumAvailable).toBe(20000);
    expect(view.readyToAssign).toBeGreaterThan(view.readyToAssign + sumAvailable);
  });

  it('reports balances as at the END of the month being viewed, not today', async () => {
    // The figures sit beside a month's Ready to Assign, so they have to be
    // scoped the same way — otherwise looking at a past month would pair
    // its RTA with a balance from the future.
    const { app, sessionCookie, budgetId } = await signInNewUser('backing-month-scoped@example.com');
    const accountId = await createAccount(app, sessionCookie, budgetId, { name: 'Checking', type: 'checking' });

    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId, date: '2026-03-01', amount: '100.00' }),
    });
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId, date: '2026-04-01', amount: '250.00' }),
    });

    expect((await month(app, sessionCookie, budgetId, '2026-03')).cashOnHandMinor).toBe(10000);
    expect((await month(app, sessionCookie, budgetId, '2026-04')).cashOnHandMinor).toBe(35000);
  });

  it('counts a split once, not twice', async () => {
    // The parent carries the total and the children carry the parts, so a
    // naive sum over every row would double every split.
    const { app, sessionCookie, budgetId } = await signInNewUser('backing-splits@example.com');
    const accountId = await createAccount(app, sessionCookie, budgetId, { name: 'Checking', type: 'checking' });
    const cats = await spendingCategoryIds(app, sessionCookie, budgetId);

    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'split',
        accountId,
        date: '2026-03-05',
        splits: [
          { amount: '-30.00', categoryId: cats[0]!.id },
          { amount: '-20.00', categoryId: cats[1]!.id },
        ],
      }),
    });

    expect((await month(app, sessionCookie, budgetId, '2026-03')).cashOnHandMinor).toBe(-5000);
  });

  it('ignores tracking accounts — they are not budget money', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('backing-tracking@example.com');
    const checking = await createAccount(app, sessionCookie, budgetId, { name: 'Checking', type: 'checking' });
    const tracked = await createAccount(app, sessionCookie, budgetId, { name: 'Brokerage', type: 'tracking_asset' });

    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: checking, date: '2026-03-01', amount: '100.00' }),
    });
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: tracked, date: '2026-03-01', amount: '9000.00' }),
    });

    expect((await month(app, sessionCookie, budgetId, '2026-03')).cashOnHandMinor).toBe(10000);
  });
});

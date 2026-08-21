import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { computeLedger } from '../src/domain/ledger';
import type { AccountRow, CategoryRow, TransactionRow } from '../src/domain/types';
import { callJson, resetDb, signInNewUser } from './helpers';

beforeEach(resetDb);

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

/**
 * An ordinary spending category to use in a test. NOT groups[0].categories[0]
 * — the auto-created "Credit Card Payments" system group deliberately sorts
 * first (sortOrder: -1, see src/budget/payment-categories.ts), so a naive
 * first-category pick silently grabs a payment category once any credit
 * account exists in the budget.
 */
async function firstCategoryId(
  app: Awaited<ReturnType<typeof signInNewUser>>['app'],
  sessionCookie: string,
  budgetId: string,
) {
  const { body } = await callJson<{ groups: { categories: { id: string; kind: string }[] }[] }>(
    app,
    sessionCookie,
    `/api/v1/budgets/${budgetId}/categories`,
  );
  const spending = body.groups.flatMap((g) => g.categories).find((c) => c.kind === 'spending');
  if (!spending) throw new Error('no spending category found');
  return spending.id;
}

describe('POST /api/v1/budgets/:budgetId/transactions — ordinary', () => {
  it('creates an ordinary transaction and it appears in the register', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('txn-ordinary@example.com');
    const accountId = await createAccount(app, sessionCookie, budgetId, { name: 'Checking', type: 'checking' });

    const { status } = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId, date: '2026-01-10', amount: '-42.50', payeeName: 'Cafe' }),
    });
    expect(status).toBe(201);

    const { body } = await callJson<{ transactions: { payeeName: string; amountMinor: number }[]; accountBalance: number }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/accounts/${accountId}/transactions`,
    );
    expect(body.transactions).toHaveLength(1);
    expect(body.transactions[0]).toMatchObject({ payeeName: 'Cafe', amountMinor: -4250 });
    expect(body.accountBalance).toBe(-4250);
  });

  it('rejects an invalid amount format', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('txn-bad-amount@example.com');
    const accountId = await createAccount(app, sessionCookie, budgetId, { name: 'Checking', type: 'checking' });
    const { status } = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId, date: '2026-01-10', amount: 'twelve dollars' }),
    });
    expect(status).toBe(400);
  });

  it('rejects a category id belonging to a different budget', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('txn-cross-budget-cat@example.com');
    const accountId = await createAccount(app, sessionCookie, budgetId, { name: 'Checking', type: 'checking' });

    const { app: otherApp, sessionCookie: otherCookie, budgetId: otherBudgetId } = await signInNewUser(
      'txn-cross-budget-cat-other@example.com',
    );
    const foreignCategoryId = await firstCategoryId(otherApp, otherCookie, otherBudgetId);

    const { status } = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId, date: '2026-01-10', amount: '-10.00', categoryId: foreignCategoryId }),
    });
    expect(status).toBe(400);
  });
});

describe('register: running balance, cleared balance, search, filters', () => {
  it('computes running balance oldest-to-newest and shows newest first', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('txn-running-balance@example.com');
    const accountId = await createAccount(app, sessionCookie, budgetId, { name: 'Checking', type: 'checking' });

    for (const [date, amount] of [
      ['2026-01-01', '100.00'],
      ['2026-01-05', '-30.00'],
      ['2026-01-10', '-20.00'],
    ] as const) {
      await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
        method: 'POST',
        body: JSON.stringify({ kind: 'ordinary', accountId, date, amount }),
      });
    }

    const { body } = await callJson<{ transactions: { date: string; balance: number }[]; accountBalance: number }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/accounts/${accountId}/transactions`,
    );
    // Newest first.
    expect(body.transactions.map((t) => t.date)).toEqual(['2026-01-10', '2026-01-05', '2026-01-01']);
    // Running balance as of each row, chronologically: 10000, 7000, 5000.
    expect(body.transactions.map((t) => t.balance)).toEqual([5000, 7000, 10000]);
    expect(body.accountBalance).toBe(5000);
  });

  it('reports cleared balance separately from the full account balance', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('txn-cleared-balance@example.com');
    const accountId = await createAccount(app, sessionCookie, budgetId, { name: 'Checking', type: 'checking' });

    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId, date: '2026-01-01', amount: '100.00', cleared: 'cleared' }),
    });
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId, date: '2026-01-02', amount: '-15.00' }), // uncleared
    });

    const { body } = await callJson<{ accountBalance: number; clearedBalance: number }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/accounts/${accountId}/transactions`,
    );
    expect(body.accountBalance).toBe(8500);
    expect(body.clearedBalance).toBe(10000);
  });

  it('filters by search text and by cleared status', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('txn-search-filter@example.com');
    const accountId = await createAccount(app, sessionCookie, budgetId, { name: 'Checking', type: 'checking' });
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId, date: '2026-01-01', amount: '-5.00', payeeName: 'Coffee Shop', cleared: 'cleared' }),
    });
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId, date: '2026-01-02', amount: '-60.00', payeeName: 'Gas Station' }),
    });

    const bySearch = await callJson<{ transactions: { payeeName: string }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/accounts/${accountId}/transactions?search=coffee`,
    );
    expect(bySearch.body.transactions.map((t) => t.payeeName)).toEqual(['Coffee Shop']);

    const byCleared = await callJson<{ transactions: { payeeName: string }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/accounts/${accountId}/transactions?cleared=cleared`,
    );
    expect(byCleared.body.transactions.map((t) => t.payeeName)).toEqual(['Coffee Shop']);
  });
});

describe('splits', () => {
  it('creates a split with a parent + children, and the register shows one line flagged isSplit', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('txn-split-create@example.com');
    const accountId = await createAccount(app, sessionCookie, budgetId, { name: 'Checking', type: 'checking' });
    const { body: cats } = await callJson<{ groups: { categories: { id: string }[] }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/categories`,
    );
    const allCats = cats.groups.flatMap((g) => g.categories);
    const [catA, catB] = allCats;

    const { status, body } = await callJson<{ transactionId: string }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/transactions`,
      {
        method: 'POST',
        body: JSON.stringify({
          kind: 'split',
          accountId,
          date: '2026-01-15',
          payeeName: 'Superstore',
          splits: [
            { amount: '-60.00', categoryId: catA!.id },
            { amount: '-40.00', categoryId: catB!.id },
          ],
        }),
      },
    );
    expect(status).toBe(201);

    const { body: register } = await callJson<{ transactions: { id: string; amountMinor: number; isSplit: boolean }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/accounts/${accountId}/transactions`,
    );
    expect(register.transactions).toHaveLength(1); // children don't appear as their own register line
    expect(register.transactions[0]).toMatchObject({ id: body.transactionId, amountMinor: -10000, isSplit: true });

    const children = await env.DB.prepare('select category_id, amount_minor from transactions where parent_transaction_id = ? order by amount_minor')
      .bind(body.transactionId)
      .all<{ category_id: string; amount_minor: number }>();
    expect(children.results).toEqual([
      { category_id: catA!.id, amount_minor: -6000 },
      { category_id: catB!.id, amount_minor: -4000 },
    ]);
  });

  it('replacing splits via edit removes the old children and inserts new ones', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('txn-split-edit@example.com');
    const accountId = await createAccount(app, sessionCookie, budgetId, { name: 'Checking', type: 'checking' });
    const catId = await firstCategoryId(app, sessionCookie, budgetId);

    const { body } = await callJson<{ transactionId: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'split',
        accountId,
        date: '2026-01-15',
        splits: [
          { amount: '-10.00', categoryId: catId },
          { amount: '-10.00', categoryId: catId },
        ],
      }),
    });

    // Splits require at least 2 parts by design (see updateTransactionSchema
    // — a 1-line "split" isn't a split, that's just editing categoryId).
    const patchRes = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions/${body.transactionId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        splits: [
          { amount: '-15.00', categoryId: catId },
          { amount: '-10.00', categoryId: catId },
        ],
      }),
    });
    expect(patchRes.status).toBe(200);

    const liveChildren = await env.DB.prepare(
      'select amount_minor from transactions where parent_transaction_id = ? and deleted_at is null order by amount_minor',
    )
      .bind(body.transactionId)
      .all<{ amount_minor: number }>();
    expect(liveChildren.results).toEqual([{ amount_minor: -1500 }, { amount_minor: -1000 }]);

    const parent = await env.DB.prepare('select amount_minor from transactions where id = ?')
      .bind(body.transactionId)
      .first<{ amount_minor: number }>();
    expect(parent?.amount_minor).toBe(-2500); // parent recomputed to match its children
  });
});

// PR 15 follow-up: statement import (imports.ts) and an account's starting
// balance (accounts.ts) already convert budgetAmountMinor via the
// account's fx_rate_micros; manually adding/editing a transaction directly
// through this route did not, until now — see budgetAmountFor in
// src/routes/transactions.ts.
describe('budgetable foreign-currency accounts: manual entry converts budgetAmountMinor', () => {
  async function foreignAccount(app: Awaited<ReturnType<typeof signInNewUser>>['app'], sessionCookie: string, budgetId: string) {
    return createAccount(app, sessionCookie, budgetId, { name: 'Neo', type: 'credit_card', currencyCode: 'CAD', fxRate: '0.73' });
  }

  it('an ordinary transaction converts on create', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('txn-fx-ordinary-create@example.com');
    const accountId = await foreignAccount(app, sessionCookie, budgetId);

    const { body } = await callJson<{ transactionId: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId, date: '2026-01-10', amount: '-100.00', payeeName: 'Tim Hortons' }),
    });

    const row = await env.DB.prepare('select amount_minor as amountMinor, budget_amount_minor as budgetAmountMinor from transactions where id = ?')
      .bind(body.transactionId)
      .first<{ amountMinor: number; budgetAmountMinor: number }>();
    expect(row?.amountMinor).toBe(-10000); // native CAD, unconverted
    expect(row?.budgetAmountMinor).toBe(-7300); // -100.00 * 0.73 = -73.00 USD
  });

  it('an ordinary transaction re-converts on an amount edit', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('txn-fx-ordinary-edit@example.com');
    const accountId = await foreignAccount(app, sessionCookie, budgetId);
    const { body } = await callJson<{ transactionId: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId, date: '2026-01-10', amount: '-100.00' }),
    });

    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions/${body.transactionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ amount: '-50.00' }),
    });

    const row = await env.DB.prepare('select amount_minor as amountMinor, budget_amount_minor as budgetAmountMinor from transactions where id = ?')
      .bind(body.transactionId)
      .first<{ amountMinor: number; budgetAmountMinor: number }>();
    expect(row?.amountMinor).toBe(-5000);
    expect(row?.budgetAmountMinor).toBe(-3650); // -50.00 * 0.73 = -36.50 USD
  });

  it('a split converts each child AND the parent (sum of the converted children)', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('txn-fx-split-create@example.com');
    const accountId = await foreignAccount(app, sessionCookie, budgetId);
    const catId = await firstCategoryId(app, sessionCookie, budgetId);

    const { body } = await callJson<{ transactionId: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'split',
        accountId,
        date: '2026-01-15',
        splits: [
          { amount: '-60.00', categoryId: catId },
          { amount: '-40.00', categoryId: catId },
        ],
      }),
    });

    const parent = await env.DB.prepare('select budget_amount_minor as budgetAmountMinor from transactions where id = ?')
      .bind(body.transactionId)
      .first<{ budgetAmountMinor: number }>();
    expect(parent?.budgetAmountMinor).toBe(-7300); // -100.00 CAD total * 0.73

    const children = await env.DB.prepare(
      'select budget_amount_minor as budgetAmountMinor from transactions where parent_transaction_id = ? order by budget_amount_minor',
    )
      .bind(body.transactionId)
      .all<{ budgetAmountMinor: number }>();
    expect(children.results).toEqual([{ budgetAmountMinor: -4380 }, { budgetAmountMinor: -2920 }]); // -60*0.73, -40*0.73
  });

  it('a split re-converts on edit', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('txn-fx-split-edit@example.com');
    const accountId = await foreignAccount(app, sessionCookie, budgetId);
    const catId = await firstCategoryId(app, sessionCookie, budgetId);
    const { body } = await callJson<{ transactionId: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'split',
        accountId,
        date: '2026-01-15',
        splits: [
          { amount: '-10.00', categoryId: catId },
          { amount: '-10.00', categoryId: catId },
        ],
      }),
    });

    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions/${body.transactionId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        splits: [
          { amount: '-15.00', categoryId: catId },
          { amount: '-10.00', categoryId: catId },
        ],
      }),
    });

    const parent = await env.DB.prepare('select budget_amount_minor as budgetAmountMinor from transactions where id = ?')
      .bind(body.transactionId)
      .first<{ budgetAmountMinor: number }>();
    expect(parent?.budgetAmountMinor).toBe(-1825); // -25.00 CAD * 0.73 = -18.25 USD

    const children = await env.DB.prepare(
      'select budget_amount_minor as budgetAmountMinor from transactions where parent_transaction_id = ? and deleted_at is null order by budget_amount_minor',
    )
      .bind(body.transactionId)
      .all<{ budgetAmountMinor: number }>();
    expect(children.results).toEqual([{ budgetAmountMinor: -1095 }, { budgetAmountMinor: -730 }]); // -15*0.73, -10*0.73
  });

  it('an account in the budget currency (no rate) is unaffected — budgetAmountMinor stays native', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('txn-fx-native-unaffected@example.com');
    const accountId = await createAccount(app, sessionCookie, budgetId, { name: 'Checking', type: 'checking' });

    const { body } = await callJson<{ transactionId: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId, date: '2026-01-10', amount: '-42.50' }),
    });

    const row = await env.DB.prepare('select amount_minor as amountMinor, budget_amount_minor as budgetAmountMinor from transactions where id = ?')
      .bind(body.transactionId)
      .first<{ amountMinor: number; budgetAmountMinor: number }>();
    expect(row?.amountMinor).toBe(-4250);
    expect(row?.budgetAmountMinor).toBe(-4250);
  });
});

// Documents the ONE correct shape for paying a credit card, because two
// plausible-looking alternatives silently give the wrong answer and
// nothing in the UI steers you. See docs/plan.md's income/RTA notes.
describe('paying a credit card: the shape that actually drains the earmark', () => {
  async function setup(email: string) {
    const { app, sessionCookie, budgetId } = await signInNewUser(email);
    const checking = await createAccount(app, sessionCookie, budgetId, { name: 'Checking', type: 'checking' });
    const card = await createAccount(app, sessionCookie, budgetId, { name: 'Visa', type: 'credit_card' });
    const groceries = await firstCategoryId(app, sessionCookie, budgetId);
    const { body: cats } = await callJson<{ groups: { categories: { id: string; linkedAccountId: string | null }[] }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/categories`,
    );
    const paymentCat = cats.groups.flatMap((g) => g.categories).find((c) => c.linkedAccountId === card)!.id;

    // $50 of groceries on the card in March -> $50 earmarked in Payment.
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: card, date: '2026-03-05', amount: '-50.00', categoryId: groceries }),
    });
    return { app, sessionCookie, budgetId, checking, card, paymentCat };
  }

  async function paymentAvailable(
    app: Awaited<ReturnType<typeof signInNewUser>>['app'],
    cookie: string,
    budgetId: string,
    paymentCat: string,
  ) {
    const { body } = await callJson<{ categories: Record<string, { available: number }> }>(
      app,
      cookie,
      `/api/v1/budgets/${budgetId}/months/2026-03`,
    );
    return body.categories[paymentCat]?.available;
  }

  it('a LINKED transfer whose outflow leg is categorized to Payment drains it to zero', async () => {
    const { app, sessionCookie, budgetId, checking, card, paymentCat } = await setup('cc-pay-correct@example.com');
    expect(await paymentAvailable(app, sessionCookie, budgetId, paymentCat)).toBe(5000);

    // Both halves arrive as separate imported rows, so they start
    // uncategorized — linking REQUIRES that (is_categorized is a 400).
    const { body: out } = await callJson<{ transactionId: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: checking, date: '2026-03-20', amount: '-50.00' }),
    });
    const { body: inn } = await callJson<{ transactionId: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: card, date: '2026-03-20', amount: '50.00' }),
    });
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions/${out.transactionId}/link-transfer`, {
      method: 'POST',
      body: JSON.stringify({ otherTransactionId: inn.transactionId }),
    });
    // ...then categorize the OUTFLOW leg. Order matters: link first
    // (needs both uncategorized), categorize second.
    const { status } = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions/${out.transactionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ categoryId: paymentCat }),
    });
    expect(status).toBe(200);

    expect(await paymentAvailable(app, sessionCookie, budgetId, paymentCat)).toBe(0);
  });

  it('linking a card payment categorizes the paying leg on its own — no follow-up needed', async () => {
    // The gap this closes. Both halves of an imported card payment arrive
    // uncategorized, and link-transfer REFUSES a categorized leg, so a
    // payment built by linking could never have the categorized leg the
    // ledger needs — real cash left chequing while the earmark sat
    // untouched. Linking now recognizes the shape and does it.
    const { app, sessionCookie, budgetId, checking, card, paymentCat } = await setup('cc-pay-autocat@example.com');
    expect(await paymentAvailable(app, sessionCookie, budgetId, paymentCat)).toBe(5000);

    const { body: out } = await callJson<{ transactionId: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: checking, date: '2026-03-20', amount: '-50.00' }),
    });
    const { body: inn } = await callJson<{ transactionId: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: card, date: '2026-03-20', amount: '50.00' }),
    });

    const { body: linked } = await callJson<{ paymentCategoryId: string | null }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/transactions/${out.transactionId}/link-transfer`,
      { method: 'POST', body: JSON.stringify({ otherTransactionId: inn.transactionId }) },
    );
    expect(linked.paymentCategoryId).toBe(paymentCat);

    // Drained without any PATCH — that is the whole point.
    expect(await paymentAvailable(app, sessionCookie, budgetId, paymentCat)).toBe(0);

    // The CARD leg stays uncategorized: it is the half the ledger skips.
    const rows = await env.DB.prepare('select id, category_id as categoryId from transactions where id in (?, ?)')
      .bind(out.transactionId, inn.transactionId)
      .all<{ id: string; categoryId: string | null }>();
    expect(rows.results.find((r) => r.id === out.transactionId)?.categoryId).toBe(paymentCat);
    expect(rows.results.find((r) => r.id === inn.transactionId)?.categoryId).toBeNull();
  });

  it('works when the link is initiated from the CARD side', async () => {
    const { app, sessionCookie, budgetId, checking, card, paymentCat } = await setup('cc-pay-autocat-reverse@example.com');
    const { body: out } = await callJson<{ transactionId: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: checking, date: '2026-03-20', amount: '-50.00' }),
    });
    const { body: inn } = await callJson<{ transactionId: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: card, date: '2026-03-20', amount: '50.00' }),
    });
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions/${inn.transactionId}/link-transfer`, {
      method: 'POST',
      body: JSON.stringify({ otherTransactionId: out.transactionId }),
    });
    expect(await paymentAvailable(app, sessionCookie, budgetId, paymentCat)).toBe(0);
  });

  it('leaves a cash ADVANCE alone — money out of a card is not a payment', async () => {
    // Direction is checked, not assumed. Money leaving a credit account
    // increases the debt; categorizing that to the payment category would
    // claim a payment had been made.
    const { app, sessionCookie, budgetId, checking, card, paymentCat } = await setup('cc-advance@example.com');
    const { body: cardOut } = await callJson<{ transactionId: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: card, date: '2026-03-20', amount: '-50.00' }),
    });
    const { body: cashIn } = await callJson<{ transactionId: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: checking, date: '2026-03-20', amount: '50.00' }),
    });
    const { body: linked } = await callJson<{ paymentCategoryId: string | null }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/transactions/${cardOut.transactionId}/link-transfer`,
      { method: 'POST', body: JSON.stringify({ otherTransactionId: cashIn.transactionId }) },
    );
    expect(linked.paymentCategoryId).toBeNull();
    // Payment still reads just the grocery purchase's 50. The advance's
    // card leg is now a LINKED transfer between two on-budget accounts,
    // which the ledger skips entirely — so it neither drains the earmark
    // (correct: nothing was paid) nor adds to it.
    expect(await paymentAvailable(app, sessionCookie, budgetId, paymentCat)).toBe(5000);
  });

  it('does not touch a transfer between two non-card accounts', async () => {
    const { app, sessionCookie, budgetId, checking } = await setup('cc-plain-transfer@example.com');
    const savings = await createAccount(app, sessionCookie, budgetId, { name: 'Savings', type: 'savings' });
    const { body: out } = await callJson<{ transactionId: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: checking, date: '2026-03-20', amount: '-50.00' }),
    });
    const { body: inn } = await callJson<{ transactionId: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: savings, date: '2026-03-20', amount: '50.00' }),
    });
    const { body: linked } = await callJson<{ paymentCategoryId: string | null }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/transactions/${out.transactionId}/link-transfer`,
      { method: 'POST', body: JSON.stringify({ otherTransactionId: inn.transactionId }) },
    );
    expect(linked.paymentCategoryId).toBeNull();
  });

  it('unlinking clears the payment category it set, restoring the earmark', async () => {
    // A payment category on a row no longer paired with that card claims
    // to pay down a card it is not connected to — the same reason the
    // "Transfer : X" payee is cleared on unlink.
    const { app, sessionCookie, budgetId, checking, card, paymentCat } = await setup('cc-pay-unlink@example.com');
    const { body: out } = await callJson<{ transactionId: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: checking, date: '2026-03-20', amount: '-50.00' }),
    });
    const { body: inn } = await callJson<{ transactionId: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: card, date: '2026-03-20', amount: '50.00' }),
    });
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions/${out.transactionId}/link-transfer`, {
      method: 'POST',
      body: JSON.stringify({ otherTransactionId: inn.transactionId }),
    });
    expect(await paymentAvailable(app, sessionCookie, budgetId, paymentCat)).toBe(0);

    const { body: unlinked } = await callJson<{ clearedCategories: number }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/transactions/${out.transactionId}/unlink-transfer`,
      { method: 'POST' },
    );
    expect(unlinked.clearedCategories).toBe(1);
    // 0.00 under the unified model. With the pair broken, the grocery
    // purchase's +50 earmark stands, and the card-side inflow is once
    // again an ordinary uncategorized row on a credit account — which now
    // means +50 to Ready to Assign and -50 off the earmark, netting the
    // category back to zero. (Under the old rules this read 100.00,
    // because raw card rows went into the category undoubled.)
    expect(await paymentAvailable(app, sessionCookie, budgetId, paymentCat)).toBe(0);
  });

  it('a category the USER chose survives unlinking', async () => {
    // Only the auto-set shape is cleared — a payment category pointing at
    // the other leg's account. Anything else is the user's decision.
    const { app, sessionCookie, budgetId, checking } = await setup('cc-pay-user-category@example.com');
    const savings = await createAccount(app, sessionCookie, budgetId, { name: 'Savings', type: 'savings' });
    const groceries = await firstCategoryId(app, sessionCookie, budgetId);
    const { body: out } = await callJson<{ transactionId: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: checking, date: '2026-03-20', amount: '-50.00' }),
    });
    const { body: inn } = await callJson<{ transactionId: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: savings, date: '2026-03-20', amount: '50.00' }),
    });
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions/${out.transactionId}/link-transfer`, {
      method: 'POST',
      body: JSON.stringify({ otherTransactionId: inn.transactionId }),
    });
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions/${out.transactionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ categoryId: groceries }),
    });
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions/${out.transactionId}/unlink-transfer`, {
      method: 'POST',
    });
    const row = await env.DB.prepare('select category_id as categoryId from transactions where id = ?')
      .bind(out.transactionId)
      .first<{ categoryId: string | null }>();
    expect(row?.categoryId).toBe(groceries);
  });

  it('the same two rows left UNLINKED double-count against the payment category', async () => {
    // The trap: each row looks individually reasonable and the account
    // balances are right, but nothing ties them together, so the ledger
    // sees a payment out of chequing AND an unexplained inflow on the
    // card. Under the unified model the first drains the earmark (-50)
    // and the second takes another -50 off it, leaving Payment at -50 —
    // reading as an overpaid card when nothing of the sort happened.
    //
    // (Under the old rules this read +50 rather than -50; the shape was
    // wrong either way, which is the point of the case. Linking the pair
    // is what makes it right, and the test above shows linking now does
    // the categorizing for you.)
    const { app, sessionCookie, budgetId, checking, card, paymentCat } = await setup('cc-pay-unlinked@example.com');

    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: checking, date: '2026-03-20', amount: '-50.00', categoryId: paymentCat }),
    });
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: card, date: '2026-03-20', amount: '50.00' }),
    });

    expect(await paymentAvailable(app, sessionCookie, budgetId, paymentCat)).toBe(-5000); // NOT 0
  });
});

describe('transfers', () => {
  it('creates both legs, linked, with correct opposite-signed amounts, visible in each account’s register', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('txn-transfer-create@example.com');
    const checkingId = await createAccount(app, sessionCookie, budgetId, { name: 'Checking', type: 'checking' });
    const savingsId = await createAccount(app, sessionCookie, budgetId, { name: 'Savings', type: 'savings' });

    const { body } = await callJson<{ transactionId: string; pairedTransactionId: string }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/transactions`,
      {
        method: 'POST',
        body: JSON.stringify({ kind: 'transfer', accountId: checkingId, transferToAccountId: savingsId, date: '2026-01-20', amount: '200.00' }),
      },
    );

    const checkingRegister = await callJson<{ transactions: { id: string; amountMinor: number; payeeName: string }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/accounts/${checkingId}/transactions`,
    );
    expect(checkingRegister.body.transactions[0]).toMatchObject({ id: body.transactionId, amountMinor: -20000, payeeName: 'Transfer : Savings' });

    const savingsRegister = await callJson<{ transactions: { id: string; amountMinor: number; payeeName: string }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/accounts/${savingsId}/transactions`,
    );
    expect(savingsRegister.body.transactions[0]).toMatchObject({ id: body.pairedTransactionId, amountMinor: 20000, payeeName: 'Transfer : Checking' });
  });

  it('deleting one leg cascades to delete the paired leg too', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('txn-transfer-delete@example.com');
    const checkingId = await createAccount(app, sessionCookie, budgetId, { name: 'Checking', type: 'checking' });
    const savingsId = await createAccount(app, sessionCookie, budgetId, { name: 'Savings', type: 'savings' });
    const { body } = await callJson<{ transactionId: string; pairedTransactionId: string }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/transactions`,
      { method: 'POST', body: JSON.stringify({ kind: 'transfer', accountId: checkingId, transferToAccountId: savingsId, date: '2026-01-20', amount: '50.00' }) },
    );

    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions/${body.transactionId}`, { method: 'DELETE' });

    const paired = await env.DB.prepare('select deleted_at from transactions where id = ?').bind(body.pairedTransactionId).first<{ deleted_at: number | null }>();
    expect(paired?.deleted_at).not.toBeNull();
  });
});

describe('credit card mechanics, end to end through the real ledger engine', () => {
  it('a purchase moves money to the payment category, and paying the card drains it — verified by feeding real API-created data into computeLedger', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('txn-credit-e2e@example.com');
    const checkingId = await createAccount(app, sessionCookie, budgetId, { name: 'Checking', type: 'checking' });
    const cardId = await createAccount(app, sessionCookie, budgetId, { name: 'Visa', type: 'credit_card' });
    const groceriesId = await firstCategoryId(app, sessionCookie, budgetId);

    // Income so Groceries can be funded from something real.
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: checkingId, date: '2026-01-01', amount: '500.00' }),
    });
    // Purchase on the card, categorized to Groceries.
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: cardId, date: '2026-01-05', amount: '-50.00', categoryId: groceriesId, payeeName: 'Supermarket' }),
    });

    // Find the payment category the account-creation step auto-made.
    const { body: cats } = await callJson<{ groups: { categories: { id: string; kind: string; linkedAccountId: string | null }[] }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/categories`,
    );
    const allCats = cats.groups.flatMap((g) => g.categories);
    const paymentCatId = allCats.find((c) => c.kind === 'credit_card_payment')!.id;

    // Pay $50 from checking to the card, categorized to Payment.
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'transfer',
        accountId: checkingId,
        transferToAccountId: cardId,
        date: '2026-01-10',
        amount: '50.00', // positive magnitude moving checking -> card, per the transfer contract
        categoryId: paymentCatId,
      }),
    });

    // Pull everything straight from D1 (bypassing the API, since there's no
    // budget-month endpoint yet — that's PR 5) and feed it to the SAME pure
    // engine tested in isolation in PR 3, to prove the two actually agree.
    const rawAccountRows = (
      await env.DB.prepare('select id, type, on_budget as onBudget from accounts where budget_id = ?').bind(budgetId).all()
    ).results as unknown as { id: string; type: AccountRow['type']; onBudget: number }[];
    const categoryRows = (await env.DB.prepare('select id, kind, linked_account_id as linkedAccountId from categories where budget_id = ?').bind(budgetId).all()).results as unknown as CategoryRow[];
    const txnRows = (
      await env.DB
        .prepare(
          `select id, account_id as accountId, date, budget_amount_minor as budgetAmountMinor,
                  category_id as categoryId, transfer_transaction_id as transferTransactionId,
                  parent_transaction_id as parentTransactionId, deleted_at as deletedAt
           from transactions where budget_id = ?`,
        )
        .bind(budgetId)
        .all()
    ).results as unknown as TransactionRow[];

    const result = computeLedger({
      accounts: rawAccountRows.map((a) => ({ id: a.id, type: a.type, onBudget: !!a.onBudget })),
      categories: categoryRows,
      categoryMonths: [],
      transactions: txnRows,
      throughMonth: '2026-01-01',
    });

    const month = result.months[0]!;
    expect(month.categories[groceriesId]?.activity).toBe(-5000);
    expect(month.categories[paymentCatId]?.available).toBe(0); // earmarked +50, then paid -50: fully drained
  });
});

describe('linking two existing transactions as a transfer', () => {
  /** Two uncategorized, opposite-amount rows in different accounts — the shape a pair of imports lands in. */
  async function twoHalves(
    email: string,
    opts: { amountA?: string; amountB?: string; dateA?: string; dateB?: string } = {},
  ) {
    const ctx = await signInNewUser(email);
    const { app, sessionCookie, budgetId } = ctx;
    const bankId = await createAccount(app, sessionCookie, budgetId, { name: 'Bank', type: 'checking' });
    const clearingId = await createAccount(app, sessionCookie, budgetId, { name: 'Splitwise', type: 'checking' });

    const mk = async (accountId: string, date: string, amount: string) => {
      const { body } = await callJson<{ transactionId: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
        method: 'POST',
        body: JSON.stringify({ kind: 'ordinary', accountId, date, amount }),
      });
      return body.transactionId;
    };

    const outflowId = await mk(bankId, opts.dateA ?? '2026-08-10', opts.amountA ?? '-190.00');
    const inflowId = await mk(clearingId, opts.dateB ?? '2026-08-10', opts.amountB ?? '190.00');
    return { ...ctx, bankId, clearingId, outflowId, inflowId };
  }

  it('suggests the opposite-amount row in another account as a candidate', async () => {
    const { app, sessionCookie, budgetId, outflowId, inflowId, clearingId } = await twoHalves('txn-link-suggest@example.com');

    const { body } = await callJson<{ candidates: { id: string; accountId: string; accountName: string; amountMinor: number }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/transactions/${outflowId}/transfer-candidates`,
    );
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0]).toMatchObject({ id: inflowId, accountId: clearingId, accountName: 'Splitwise', amountMinor: 19000 });
  });

  it('offers a match a few days apart, but not one outside the window', async () => {
    const near = await twoHalves('txn-link-near@example.com', { dateA: '2026-08-10', dateB: '2026-08-13' });
    const nearRes = await callJson<{ candidates: unknown[] }>(
      near.app,
      near.sessionCookie,
      `/api/v1/budgets/${near.budgetId}/transactions/${near.outflowId}/transfer-candidates`,
    );
    expect(nearRes.body.candidates).toHaveLength(1);

    const far = await twoHalves('txn-link-far@example.com', { dateA: '2026-08-10', dateB: '2026-09-10' });
    const farRes = await callJson<{ candidates: unknown[] }>(
      far.app,
      far.sessionCookie,
      `/api/v1/budgets/${far.budgetId}/transactions/${far.outflowId}/transfer-candidates`,
    );
    expect(farRes.body.candidates).toEqual([]);
  });

  it('links the pair, giving each leg the other account’s transfer payee', async () => {
    const { app, sessionCookie, budgetId, bankId, clearingId, outflowId, inflowId } = await twoHalves('txn-link-do@example.com');

    const { status } = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions/${outflowId}/link-transfer`, {
      method: 'POST',
      body: JSON.stringify({ otherTransactionId: inflowId }),
    });
    expect(status).toBe(200);

    const bank = await callJson<{ transactions: { id: string; payeeName: string; transferAccountId: string }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/accounts/${bankId}/transactions`,
    );
    expect(bank.body.transactions[0]).toMatchObject({ id: outflowId, payeeName: 'Transfer : Splitwise', transferAccountId: clearingId });

    const clearing = await callJson<{ transactions: { id: string; payeeName: string; transferAccountId: string }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/accounts/${clearingId}/transactions`,
    );
    expect(clearing.body.transactions[0]).toMatchObject({ id: inflowId, payeeName: 'Transfer : Bank', transferAccountId: bankId });
  });

  it('leaves Ready to Assign unchanged — the whole point of linking being safe on existing data', async () => {
    const { app, sessionCookie, budgetId, outflowId, inflowId } = await twoHalves('txn-link-rta@example.com');

    const before = await callJson<{ readyToAssign: number }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/months/2026-08`);
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions/${outflowId}/link-transfer`, {
      method: 'POST',
      body: JSON.stringify({ otherTransactionId: inflowId }),
    });
    const after = await callJson<{ readyToAssign: number }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/months/2026-08`);

    expect(after.body.readyToAssign).toBe(before.body.readyToAssign);
  });

  it('refuses a categorized row — linking one would silently move money', async () => {
    const { app, sessionCookie, budgetId, outflowId, inflowId } = await twoHalves('txn-link-categorized@example.com');
    const groups = await callJson<{ groups: { categories: { id: string; name: string }[] }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/categories`,
    );
    const categoryId = groups.body.groups.flatMap((g) => g.categories).find((cat) => cat.name === 'Groceries')!.id;
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions/${outflowId}`, {
      method: 'PATCH',
      body: JSON.stringify({ categoryId }),
    });

    const { status, body } = await callJson<{ error: string }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/transactions/${outflowId}/link-transfer`,
      { method: 'POST', body: JSON.stringify({ otherTransactionId: inflowId }) },
    );
    expect(status).toBe(400);
    expect(body.error).toBe('is_categorized');

    // ...and the candidate search reports the same blocker rather than offering a doomed match.
    const candidates = await callJson<{ candidates: unknown[]; blocked: string }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/transactions/${outflowId}/transfer-candidates`,
    );
    expect(candidates.body).toMatchObject({ candidates: [], blocked: 'is_categorized' });
  });

  it('refuses amounts that do not offset, and a row already in a transfer', async () => {
    const { app, sessionCookie, budgetId, outflowId, inflowId } = await twoHalves('txn-link-refuse@example.com', {
      amountB: '191.00',
    });
    const mismatch = await callJson<{ error: string }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/transactions/${outflowId}/link-transfer`,
      { method: 'POST', body: JSON.stringify({ otherTransactionId: inflowId }) },
    );
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error).toBe('amounts_do_not_offset');

    const ok = await twoHalves('txn-link-twice@example.com');
    await callJson(ok.app, ok.sessionCookie, `/api/v1/budgets/${ok.budgetId}/transactions/${ok.outflowId}/link-transfer`, {
      method: 'POST',
      body: JSON.stringify({ otherTransactionId: ok.inflowId }),
    });
    const again = await callJson<{ error: string }>(
      ok.app,
      ok.sessionCookie,
      `/api/v1/budgets/${ok.budgetId}/transactions/${ok.outflowId}/link-transfer`,
      { method: 'POST', body: JSON.stringify({ otherTransactionId: ok.inflowId }) },
    );
    expect(again.status).toBe(400);
    expect(again.body.error).toBe('already_a_transfer');
  });

  it('unlinks back to two ordinary transactions, both surviving', async () => {
    const { app, sessionCookie, budgetId, bankId, clearingId, outflowId, inflowId } = await twoHalves('txn-unlink@example.com');
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions/${outflowId}/link-transfer`, {
      method: 'POST',
      body: JSON.stringify({ otherTransactionId: inflowId }),
    });

    const { status } = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions/${outflowId}/unlink-transfer`, {
      method: 'POST',
    });
    expect(status).toBe(200);

    for (const accountId of [bankId, clearingId]) {
      const reg = await callJson<{ transactions: { transferAccountId: string | null; payeeName: string | null }[] }>(
        app,
        sessionCookie,
        `/api/v1/budgets/${budgetId}/accounts/${accountId}/transactions`,
      );
      expect(reg.body.transactions).toHaveLength(1); // both halves still there
      expect(reg.body.transactions[0]).toMatchObject({ transferAccountId: null, payeeName: null });
    }
  });
});

// PR 14 required both legs in the same currency (currency_mismatch was a
// 400). That left the commonest real cross-border movement unlinkable: pay
// a foreign account from a domestic one and the two legs are different
// numbers by definition. See docs/plan.md's Phase 5 notes.
describe('linking a transfer across currencies', () => {
  async function crossCurrencySetup(email: string) {
    const { app, sessionCookie, budgetId } = await signInNewUser(email);
    // CAD chequing at a nominal 0.73, and a USD account.
    const cad = await createAccount(app, sessionCookie, budgetId, {
      name: 'Vancity',
      type: 'checking',
      currencyCode: 'CAD',
      fxRate: '0.73',
    });
    const usd = await createAccount(app, sessionCookie, budgetId, { name: 'Wise USD', type: 'checking' });

    // CAD 2093.80 out -> budgetAmountMinor -152847 at the nominal rate.
    const { body: out } = await callJson<{ transactionId: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: cad, date: '2026-08-14', amount: '-2093.80' }),
    });
    // USD 1500.00 actually arrived — the realized value.
    const { body: inn } = await callJson<{ transactionId: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: usd, date: '2026-08-14', amount: '1500.00' }),
    });
    return { app, sessionCookie, budgetId, cad, usd, outId: out.transactionId, inId: inn.transactionId };
  }

  async function readyToAssign(app: Awaited<ReturnType<typeof signInNewUser>>['app'], cookie: string, budgetId: string) {
    const { body } = await callJson<{ readyToAssign: number }>(app, cookie, `/api/v1/budgets/${budgetId}/months/2026-08`);
    return body.readyToAssign;
  }

  it('offers the opposite-signed foreign row as an approximate candidate', async () => {
    const { app, sessionCookie, budgetId, inId } = await crossCurrencySetup('xfx-candidate@example.com');
    const { body } = await callJson<{ candidates: { id: string; currencyCode: string; approximate: boolean }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/transactions/${inId}/transfer-candidates`,
    );
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0]).toMatchObject({ currencyCode: 'CAD', approximate: true });
  });

  it('does not offer a foreign row whose value is outside the tolerance band', async () => {
    const { app, sessionCookie, budgetId, cad } = await crossCurrencySetup('xfx-out-of-band@example.com');
    // A CAD 50.00 outflow is nowhere near the USD 1500.00 inflow.
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: cad, date: '2026-08-14', amount: '-50.00' }),
    });
    const { body: reg } = await callJson<{ transactions: { id: string; amountMinor: number }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/accounts/${cad}/transactions`,
    );
    const small = reg.transactions.find((r) => r.amountMinor === -5000)!;
    const { body } = await callJson<{ candidates: { id: string }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/transactions/${small.id}/transfer-candidates`,
    );
    expect(body.candidates).toEqual([]);
  });

  it('links the pair and rewrites the CAD leg to the amount that actually arrived', async () => {
    const { app, sessionCookie, budgetId, outId, inId } = await crossCurrencySetup('xfx-link@example.com');

    const { status } = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions/${outId}/link-transfer`, {
      method: 'POST',
      body: JSON.stringify({ otherTransactionId: inId }),
    });
    expect(status).toBe(200);

    const rows = await env.DB.prepare(
      'select id, amount_minor as amountMinor, budget_amount_minor as budgetAmountMinor from transactions where id in (?, ?)',
    )
      .bind(outId, inId)
      .all<{ id: string; amountMinor: number; budgetAmountMinor: number }>();
    const out = rows.results.find((r) => r.id === outId)!;
    const inn = rows.results.find((r) => r.id === inId)!;

    // Natives untouched — the accounts still hold what they hold.
    expect(out.amountMinor).toBe(-209380);
    expect(inn.amountMinor).toBe(150000);
    // Budget values are now exactly equal and opposite, taken from the USD
    // leg. The CAD leg was -152847 at the nominal 0.73; the realized rate
    // was 1500.00/2093.80, so it is corrected to -150000.
    expect(out.budgetAmountMinor).toBe(-150000);
    expect(inn.budgetAmountMinor).toBe(150000);
  });

  it('leaves Ready to Assign unchanged — the same invariant PR 14 established for same-currency links', async () => {
    const { app, sessionCookie, budgetId, outId, inId } = await crossCurrencySetup('xfx-rta@example.com');
    const before = await readyToAssign(app, sessionCookie, budgetId);

    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions/${outId}/link-transfer`, {
      method: 'POST',
      body: JSON.stringify({ otherTransactionId: inId }),
    });

    // Before linking the two rows contributed -152847 and +150000 — a
    // 2847 discrepancy that was silently sitting in Ready to Assign
    // because the nominal rate disagreed with reality. Linking makes them
    // an exact pair, so the pair now nets to zero AND the discrepancy is
    // gone. That is a real change, not a no-op, and it is the correction:
    // RTA should not have been carrying the difference between a nominal
    // rate and what the bank actually paid.
    const after = await readyToAssign(app, sessionCookie, budgetId);
    expect(before).toBe(-2847);
    expect(after).toBe(0);
  });

  it('refuses two legs pointing the same direction — that is not a transfer', async () => {
    const { app, sessionCookie, budgetId, cad, inId } = await crossCurrencySetup('xfx-same-sign@example.com');
    const { body: alsoIn } = await callJson<{ transactionId: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: cad, date: '2026-08-14', amount: '2093.80' }),
    });

    const { status, body } = await callJson<{ error: string }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/transactions/${inId}/link-transfer`,
      { method: 'POST', body: JSON.stringify({ otherTransactionId: alsoIn.transactionId }) },
    );
    expect(status).toBe(400);
    expect(body.error).toBe('amounts_do_not_offset');
  });

  it('refuses a same-currency pair whose gap is too large to be a fee', async () => {
    // This case originally asserted that same-currency matching required
    // an EXACT offset, on the reasoning that within one currency an exact
    // counterpart always exists. A real Vancity -> Wise CAD transfer
    // disproved it: 1900.31 CAD left, 1900.00 CAD arrived, both legs CAD,
    // 0.31 kept as a fee — a genuine transfer the exact rule could not
    // express at all. So a fee-shaped gap is now accepted and booked as
    // its own row (see the fee suite below), and what stays refused is a
    // gap too large to be a fee.
    //
    // The amounts here changed with the expectation for that reason: the
    // original -100.00 against +99.00 is a 1.00 gap, which IS fee-shaped
    // and now links. -100.00 against +50.00 is not.
    const { app, sessionCookie, budgetId, usd } = await crossCurrencySetup('xfx-same-currency-strict@example.com');
    const other = await createAccount(app, sessionCookie, budgetId, { name: 'BECU', type: 'checking' });
    const { body: a } = await callJson<{ transactionId: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: usd, date: '2026-08-20', amount: '-100.00' }),
    });
    const { body: b } = await callJson<{ transactionId: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: other, date: '2026-08-20', amount: '50.00' }),
    });

    const { status, body } = await callJson<{ error: string }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/transactions/${a.transactionId}/link-transfer`,
      { method: 'POST', body: JSON.stringify({ otherTransactionId: b.transactionId }) },
    );
    expect(status).toBe(400);
    expect(body.error).toBe('amounts_do_not_offset');
  });

  it('refuses when neither leg is in the budget currency and the outflow account has no rate', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('xfx-no-rate@example.com');
    const cad = await createAccount(app, sessionCookie, budgetId, {
      name: 'CAD acct',
      type: 'tracking_asset',
      currencyCode: 'CAD',
    });
    const eur = await createAccount(app, sessionCookie, budgetId, {
      name: 'EUR acct',
      type: 'tracking_asset',
      currencyCode: 'EUR',
    });
    const { body: out } = await callJson<{ transactionId: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: cad, date: '2026-08-14', amount: '-100.00' }),
    });
    const { body: inn } = await callJson<{ transactionId: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: eur, date: '2026-08-14', amount: '65.00' }),
    });

    const { status, body } = await callJson<{ error: string }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/transactions/${out.transactionId}/link-transfer`,
      { method: 'POST', body: JSON.stringify({ otherTransactionId: inn.transactionId }) },
    );
    expect(status).toBe(400);
    expect(body.error).toBe('needs_fx_rate_to_link');
  });
});

describe('authorization', () => {
  it('403s for a user who is not a budget member', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('txn-owner@example.com');
    const accountId = await createAccount(app, sessionCookie, budgetId, { name: 'Checking', type: 'checking' });
    const { app: outsiderApp, sessionCookie: outsiderCookie } = await signInNewUser('txn-outsider@example.com');

    const { status } = await callJson(outsiderApp, outsiderCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId, date: '2026-01-01', amount: '-1.00' }),
    });
    expect(status).toBe(403);
  });
});

describe('linking a same-currency transfer that lost a fee in transit', () => {
  // The real pair this was built for, transcribed from the live budget: a
  // Vancity bill payment of 1900.31 CAD landing in a Wise CAD balance as
  // 1900.00 CAD three days later, Wise keeping 0.31. Both legs CAD, so
  // PR 14's exact-opposite rule refused the link outright.
  //
  // The two CAD accounts deliberately carry DIFFERENT rates (0.73 and
  // 0.72), which is not a contrivance — it is exactly what the live
  // budget holds, and it is what exposed the second bug fixed here (see
  // the Ready to Assign case below).
  async function feeSetup(email: string) {
    const { app, sessionCookie, budgetId } = await signInNewUser(email);
    const vancity = await createAccount(app, sessionCookie, budgetId, {
      name: 'Vancity Gold',
      type: 'checking',
      currencyCode: 'CAD',
      fxRate: '0.73',
    });
    const wise = await createAccount(app, sessionCookie, budgetId, {
      name: 'Wise CAD',
      type: 'checking',
      currencyCode: 'CAD',
      fxRate: '0.72',
    });

    const { body: out } = await callJson<{ transactionId: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: vancity, date: '2026-07-25', amount: '-1900.31' }),
    });
    const { body: inn } = await callJson<{ transactionId: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: wise, date: '2026-07-28', amount: '1900.00' }),
    });
    return { app, sessionCookie, budgetId, vancity, wise, outId: out.transactionId, inId: inn.transactionId };
  }

  async function rowsIn(accountId: string) {
    const res = await env.DB.prepare(
      'select id, amount_minor as amountMinor, budget_amount_minor as budgetAmountMinor, category_id as categoryId,' +
        ' memo, fee_for_transaction_id as feeFor from transactions where account_id = ? and deleted_at is null order by amount_minor',
    )
      .bind(accountId)
      .all<{
        id: string;
        amountMinor: number;
        budgetAmountMinor: number;
        categoryId: string | null;
        memo: string | null;
        feeFor: string | null;
      }>();
    return res.results;
  }

  it('offers the short inflow as a candidate, naming the exact fee', async () => {
    const { app, sessionCookie, budgetId, outId } = await feeSetup('fee-candidate@example.com');
    const { body } = await callJson<{ candidates: { amountMinor: number; feeMinor: number; approximate: boolean }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/transactions/${outId}/transfer-candidates`,
    );
    expect(body.candidates).toHaveLength(1);
    // Not `approximate` — that flag means "different currencies, so the
    // amounts can't match". These are both CAD and the gap is a known,
    // exact fee, which is a different thing and reported as its own field.
    expect(body.candidates[0]).toMatchObject({ amountMinor: 190000, feeMinor: 31, approximate: false });
  });

  it('still offers an exactly-matching pair, with no fee', async () => {
    const { app, sessionCookie, budgetId, wise } = await feeSetup('fee-exact@example.com');
    const { body: exact } = await callJson<{ transactionId: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: wise, date: '2026-07-25', amount: '-500.00' }),
    });
    const { body } = await callJson<{ candidates: { id: string; feeMinor: number }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/transactions/${exact.transactionId}/transfer-candidates`,
    );
    expect(body.candidates).toEqual([]);
  });

  it('refuses a pair where MORE arrived than left — that is not a fee', async () => {
    const { app, sessionCookie, budgetId, wise, outId } = await feeSetup('fee-backwards@example.com');
    // 1900.50 in against 1900.31 out. A fee only ever subtracts, so this
    // direction is not offered no matter how small the gap.
    const { body: tooBig } = await callJson<{ transactionId: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: wise, date: '2026-07-26', amount: '1900.50' }),
    });
    const { body } = await callJson<{ candidates: { id: string }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/transactions/${outId}/transfer-candidates`,
    );
    expect(body.candidates.map((c) => c.id)).not.toContain(tooBig.transactionId);

    const { status, body: err } = await callJson<{ error: string }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/transactions/${outId}/link-transfer`,
      { method: 'POST', body: JSON.stringify({ otherTransactionId: tooBig.transactionId }) },
    );
    expect(status).toBe(400);
    expect(err.error).toBe('amounts_do_not_offset');
  });

  it('refuses a gap too large to be a fee', async () => {
    const { app, sessionCookie, budgetId, wise, outId } = await feeSetup('fee-too-large@example.com');
    // 1800.00 against 1900.31 is a 100.31 gap — past both the flat 5.00
    // allowance and 2% of the outflow (38.01).
    const { body: way } = await callJson<{ transactionId: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: wise, date: '2026-07-26', amount: '1800.00' }),
    });
    const { status } = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions/${outId}/link-transfer`, {
      method: 'POST',
      body: JSON.stringify({ otherTransactionId: way.transactionId }),
    });
    expect(status).toBe(400);
  });

  it('admits a flat fee on a small transfer that 2% alone would reject', async () => {
    const { app, sessionCookie, budgetId, vancity, wise } = await feeSetup('fee-small-transfer@example.com');
    // 20.00 out, 19.00 in. 1.00 is 5% of the outflow — outside the
    // proportional band, inside the flat 5.00 one. Real fees behave this
    // way: near-flat on small amounts, proportional on large ones.
    const { body: out } = await callJson<{ transactionId: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: vancity, date: '2026-05-02', amount: '-20.00' }),
    });
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: wise, date: '2026-05-02', amount: '19.00' }),
    });
    const { body } = await callJson<{ candidates: { feeMinor: number }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/transactions/${out.transactionId}/transfer-candidates`,
    );
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0]?.feeMinor).toBe(100);
  });

  it('links the pair, shrinking the outflow and booking the fee as its own row', async () => {
    const { app, sessionCookie, budgetId, vancity, wise, outId, inId } = await feeSetup('fee-link@example.com');

    const { status, body } = await callJson<{ feeMinor: number; feeTransactionId: string }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/transactions/${outId}/link-transfer`,
      { method: 'POST', body: JSON.stringify({ otherTransactionId: inId }) },
    );
    expect(status).toBe(200);
    expect(body.feeMinor).toBe(31);

    const vancityRows = await rowsIn(vancity);
    expect(vancityRows).toHaveLength(2);

    const leg = vancityRows.find((r) => r.id === outId)!;
    const fee = vancityRows.find((r) => r.id === body.feeTransactionId)!;
    expect(leg.amountMinor).toBe(-190000);
    expect(fee.amountMinor).toBe(-31);
    expect(fee.feeFor).toBe(outId);
    expect(fee.memo).toBe('Fee on transfer to Wise CAD');
    // Uncategorized by default — the user picks where it belongs.
    expect(fee.categoryId).toBeNull();

    // THE point of the whole exercise: the account still holds exactly
    // what the bank said it does. -1900.00 + -0.31 = -1900.31.
    expect(leg.amountMinor + fee.amountMinor).toBe(-190031);

    const wiseRows = await rowsIn(wise);
    expect(wiseRows).toHaveLength(1);
    expect(wiseRows[0]?.amountMinor).toBe(190000);
  });

  it('categorizes the fee when asked', async () => {
    const { app, sessionCookie, budgetId, vancity, outId, inId } = await feeSetup('fee-categorized@example.com');
    const categoryId = await firstCategoryId(app, sessionCookie, budgetId);

    const { body } = await callJson<{ feeTransactionId: string }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/transactions/${outId}/link-transfer`,
      { method: 'POST', body: JSON.stringify({ otherTransactionId: inId, feeCategoryId: categoryId }) },
    );
    const fee = (await rowsIn(vancity)).find((r) => r.id === body.feeTransactionId)!;
    expect(fee.categoryId).toBe(categoryId);
    // Converted at the PAYING account's rate, like any other spending on it.
    expect(fee.budgetAmountMinor).toBe(-23); // -31 CAD at 0.73
  });

  it('leaves an uncategorized fee in the review queue, which is how it gets categorized', async () => {
    // The whole point of defaulting the fee to uncategorized is that the
    // user decides where it belongs, and /review (a plain approved=false
    // filter, not an import-only one) is this app's mechanism for that.
    // Inserting it approved — insertTransaction's default — made it
    // uncategorized AND invisible, which is the worst of both.
    const { app, sessionCookie, budgetId, outId, inId } = await feeSetup('fee-review@example.com');

    const { body: linked } = await callJson<{ feeTransactionId: string }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/transactions/${outId}/link-transfer`,
      { method: 'POST', body: JSON.stringify({ otherTransactionId: inId }) },
    );

    const { body } = await callJson<{ transactions: { id: string; amountMinor: number; memo: string | null }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/imports/review`,
    );
    const queued = body.transactions.find((t) => t.id === linked.feeTransactionId);
    expect(queued).toBeDefined();
    expect(queued?.amountMinor).toBe(-31);
    expect(queued?.memo).toBe('Fee on transfer to Wise CAD');

    // The two transfer legs themselves are NOT in the queue — they are
    // settled, not awaiting a decision.
    const ids = body.transactions.map((t) => t.id);
    expect(ids).not.toContain(outId);
    expect(ids).not.toContain(inId);
  });

  it('does not queue a fee that was categorized outright', async () => {
    const { app, sessionCookie, budgetId, outId, inId } = await feeSetup('fee-review-skip@example.com');
    const categoryId = await firstCategoryId(app, sessionCookie, budgetId);

    const { body: linked } = await callJson<{ feeTransactionId: string }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/transactions/${outId}/link-transfer`,
      { method: 'POST', body: JSON.stringify({ otherTransactionId: inId, feeCategoryId: categoryId }) },
    );

    const { body } = await callJson<{ transactions: { id: string }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/imports/review`,
    );
    expect(body.transactions.map((t) => t.id)).not.toContain(linked.feeTransactionId);
  });

  it('rejects a fee category that is not in this budget', async () => {
    const { app, sessionCookie, budgetId, outId, inId } = await feeSetup('fee-bad-category@example.com');
    const { status, body } = await callJson<{ error: string }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/transactions/${outId}/link-transfer`,
      { method: 'POST', body: JSON.stringify({ otherTransactionId: inId, feeCategoryId: 'nope' }) },
    );
    expect(status).toBe(400);
    expect(body.error).toBe('category_not_found');
  });

  it('leaves the two legs exactly offsetting in budget currency, despite the accounts holding different rates', async () => {
    // The second bug this change fixes. Before it, the same-currency link
    // path never touched budgetAmountMinor at all — it only normalized
    // the cross-currency case. Two CAD accounts at 0.73 and 0.72 would
    // therefore end up linked with legs of -1387.00 and +1368.00, which
    // do NOT offset, quietly leaking the rate difference into Ready to
    // Assign. Same currency was assumed to imply the same rate; PR 15
    // made that false.
    const { app, sessionCookie, budgetId, outId, inId } = await feeSetup('fee-budget-offset@example.com');

    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions/${outId}/link-transfer`, {
      method: 'POST',
      body: JSON.stringify({ otherTransactionId: inId }),
    });

    const res = await env.DB.prepare(
      'select id, budget_amount_minor as budgetAmountMinor from transactions where id in (?, ?)',
    )
      .bind(outId, inId)
      .all<{ id: string; budgetAmountMinor: number }>();
    const out = res.results.find((r) => r.id === outId)!;
    const inn = res.results.find((r) => r.id === inId)!;

    // Neither leg is in the budget's currency (both CAD, budget USD), so
    // the outflow's own account rate decides: -190000 at 0.73 = -138700.
    expect(out.budgetAmountMinor).toBe(-138700);
    expect(inn.budgetAmountMinor).toBe(138700);
    expect(out.budgetAmountMinor + inn.budgetAmountMinor).toBe(0);
  });

  it('moves Ready to Assign by the fee alone — the transfer itself stays neutral', async () => {
    const { app, sessionCookie, budgetId, outId, inId } = await feeSetup('fee-rta@example.com');

    async function readyToAssign() {
      const { body } = await callJson<{ readyToAssign: number }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/months/2026-07`);
      return body.readyToAssign;
    }

    // Unlinked, the two rows are uncategorized inflow/outflow on
    // on-budget accounts, so both hit Ready to Assign at their own
    // account's nominal rate: -138723 + 136800.
    expect(await readyToAssign()).toBe(-1923);

    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions/${outId}/link-transfer`, {
      method: 'POST',
      body: JSON.stringify({ otherTransactionId: inId }),
    });

    // Afterwards the transfer contributes nothing at all, and the only
    // remaining Ready to Assign movement is the fee row: -31 CAD at the
    // paying account's 0.73. The 1923 that was sitting in RTA purely
    // because two CAD accounts disagreed about the rate is gone.
    expect(await readyToAssign()).toBe(-23);
  });

  it('unlinking folds the fee back into the leg and removes the fee row', async () => {
    const { app, sessionCookie, budgetId, vancity, outId, inId } = await feeSetup('fee-unlink@example.com');

    const { body: linked } = await callJson<{ feeTransactionId: string }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/transactions/${outId}/link-transfer`,
      { method: 'POST', body: JSON.stringify({ otherTransactionId: inId }) },
    );

    const { body: unlinked } = await callJson<{ feeRestoredMinor: number }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/transactions/${outId}/unlink-transfer`,
      { method: 'POST' },
    );
    expect(unlinked.feeRestoredMinor).toBe(31);

    const rows = await rowsIn(vancity);
    // Back to exactly the one row the statement printed.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(outId);
    expect(rows[0]?.amountMinor).toBe(-190031);
    // Recomputed at the account's own rate, not arithmetic on two
    // separately-rounded budget figures.
    expect(rows[0]?.budgetAmountMinor).toBe(-138723);

    const gone = await env.DB.prepare('select deleted_at as deletedAt from transactions where id = ?')
      .bind(linked.feeTransactionId)
      .first<{ deletedAt: number | null }>();
    expect(gone?.deletedAt).not.toBeNull();
  });

  it('unlinking from the INFLOW side restores the fee too', async () => {
    // The fee hangs off the outflow leg, but unlink can be called on
    // either half, so both are checked for fees.
    const { app, sessionCookie, budgetId, vancity, outId, inId } = await feeSetup('fee-unlink-other-side@example.com');
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions/${outId}/link-transfer`, {
      method: 'POST',
      body: JSON.stringify({ otherTransactionId: inId }),
    });

    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions/${inId}/unlink-transfer`, { method: 'POST' });

    const rows = await rowsIn(vancity);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amountMinor).toBe(-190031);
  });

  it('deleting the transfer takes the fee row with it', async () => {
    const { app, sessionCookie, budgetId, vancity, wise, outId, inId } = await feeSetup('fee-delete@example.com');
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions/${outId}/link-transfer`, {
      method: 'POST',
      body: JSON.stringify({ otherTransactionId: inId }),
    });

    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions/${outId}`, { method: 'DELETE' });

    // Both legs go (transfer cascade) and so does the fee — leaving a
    // lone -0.31 "fee on transfer" beside a transfer that no longer
    // exists would be worse than either outcome.
    expect(await rowsIn(vancity)).toEqual([]);
    expect(await rowsIn(wise)).toEqual([]);
  });
});

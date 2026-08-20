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

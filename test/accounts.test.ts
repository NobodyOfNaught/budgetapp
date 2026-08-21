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

// PR 15: a foreign-currency account is forced off-budget UNLESS it has an
// exchange rate — see src/routes/accounts.ts's isBudgetable. These are a
// regression guard for every account that predates this PR (including the
// Wise-imported CAD sub-account, which has never had a rate and must stay
// exactly as off-budget as before).
describe('foreign currency + exchange rate', () => {
  it('a foreign-currency account with a rate is on-budget', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('accounts-fx-onbudget@example.com');
    const { status, body } = await callJson<{
      account: { onBudget: boolean; fxRateMicros: number | null };
      forcedOffBudget: boolean;
    }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/accounts`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Neo', type: 'credit_card', currencyCode: 'CAD', fxRate: '0.73' }),
    });
    expect(status).toBe(201);
    expect(body.account.onBudget).toBe(true);
    expect(body.account.fxRateMicros).toBe(730000);
    expect(body.forcedOffBudget).toBe(false);
  });

  it('a foreign-currency account with no rate stays off-budget — the pre-PR-15 default, unchanged', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('accounts-fx-offbudget@example.com');
    const { body } = await callJson<{ account: { onBudget: boolean; fxRateMicros: number | null }; forcedOffBudget: boolean }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/accounts`,
      { method: 'POST', body: JSON.stringify({ name: 'Wise (CAD)', type: 'checking', currencyCode: 'CAD' }) },
    );
    expect(body.account.onBudget).toBe(false);
    expect(body.account.fxRateMicros).toBeNull();
    expect(body.forcedOffBudget).toBe(true);
  });

  it('rejects an invalid exchange rate', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('accounts-fx-invalid@example.com');
    for (const bad of ['0', '-0.73', 'abc', '1001']) {
      const { status, body } = await callJson<{ error: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/accounts`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Neo', type: 'credit_card', currencyCode: 'CAD', fxRate: bad }),
      });
      expect(status).toBe(400);
      expect(body.error).toBe('invalid_fx_rate');
    }
  });

  it('a foreign starting balance converts to budget_amount_minor via the rate, leaving amount_minor native', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('accounts-fx-starting@example.com');
    const { body } = await callJson<{ account: { id: string } }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/accounts`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Neo',
        type: 'credit_card',
        currencyCode: 'CAD',
        fxRate: '0.73',
        startingBalance: '-100.00',
      }),
    });

    const row = await env.DB.prepare('select amount_minor, budget_amount_minor from transactions where account_id = ?')
      .bind(body.account.id)
      .first<{ amount_minor: number; budget_amount_minor: number }>();
    expect(row?.amount_minor).toBe(-10000); // native CAD
    expect(row?.budget_amount_minor).toBe(-7300); // converted at 0.73
  });

  it('PATCH updates the remembered rate without retroactively changing onBudget', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('accounts-fx-patch-rate@example.com');
    const { body: created } = await callJson<{ account: { id: string; onBudget: boolean } }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/accounts`,
      { method: 'POST', body: JSON.stringify({ name: 'Neo', type: 'credit_card', currencyCode: 'CAD', fxRate: '0.73' }) },
    );

    const { status } = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/accounts/${created.account.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ fxRate: '0.75' }),
    });
    expect(status).toBe(200);

    const row = await env.DB.prepare('select fx_rate_micros, on_budget from accounts where id = ?')
      .bind(created.account.id)
      .first<{ fx_rate_micros: number | null; on_budget: number }>();
    expect(row?.fx_rate_micros).toBe(750000);
    expect(row?.on_budget).toBe(1); // unchanged — PATCH never recomputes onBudget
  });

  it('PATCH clears the rate with fxRate: null, again leaving onBudget untouched', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('accounts-fx-patch-clear@example.com');
    const { body: created } = await callJson<{ account: { id: string } }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/accounts`,
      { method: 'POST', body: JSON.stringify({ name: 'Neo', type: 'credit_card', currencyCode: 'CAD', fxRate: '0.73' }) },
    );

    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/accounts/${created.account.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ fxRate: null }),
    });

    const row = await env.DB.prepare('select fx_rate_micros, on_budget from accounts where id = ?')
      .bind(created.account.id)
      .first<{ fx_rate_micros: number | null; on_budget: number }>();
    expect(row?.fx_rate_micros).toBeNull();
    expect(row?.on_budget).toBe(1); // still on-budget — the account this leaves in the "needs a rate again" state that imports.ts's missing_fx_rate guard exists for, see test/imports.test.ts
  });

  it('renaming a currency sub-account does not break which account future imports route to', async () => {
    // The auto-created sub-account is named after whatever the primary was
    // called at import time, so it drifts. Renaming has to be safe:
    // resolveCurrencyAccount (src/routes/imports.ts) looks up by
    // (budget, currency, provider), NEVER by name.
    const { app, sessionCookie, budgetId } = await signInNewUser('accounts-rename-subaccount@example.com');
    const wise = await callJson<{ account: { id: string } }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/accounts`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Cash', type: 'checking', importProvider: 'wise' }),
    });

    const header =
      'ID,Status,Direction,"Created on","Finished on","Source fee amount","Source fee currency",' +
      '"Target fee amount","Target fee currency","Source name","Source amount (after fees)","Source currency",' +
      '"Target name","Target amount (after fees)","Target currency","Exchange rate",Reference,Batch,' +
      '"Created by",Category,Note';
    const cadLeg =
      '"CARD_TRANSACTION-4145111585",COMPLETED,OUT,"2026-08-03 17:11:26","2026-08-03 17:11:26",0.07,CAD,,,' +
      '"Palle Helenius",15.70,CAD,"Taste of Europe Enterp",11.18,USD,0.7118960000000000,,,"Palle Helenius",Groceries,';
    const usdLeg =
      '"CARD_TRANSACTION-4145111585",COMPLETED,OUT,"2026-08-03 17:11:26","2026-08-03 17:11:26",0.00,USD,,,' +
      '"Palle Helenius",23.32,USD,"Taste of Europe Enterp",23.32,USD,1.0000000000000000,,,"Palle Helenius",Groceries,';
    const csv = [header, cadLeg, usdLeg, ''].join('\n');

    async function importFile() {
      return callJson<{ accountsCreated: string[] }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/imports`, {
        method: 'POST',
        body: JSON.stringify({ accountId: wise.body.account.id, provider: 'wise', filename: 'w.csv', csv }),
      });
    }

    const first = await importFile();
    expect(first.body.accountsCreated).toEqual(['Cash (CAD)']);

    const { body: listed } = await callJson<{ accounts: { id: string; name: string; currencyCode: string }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/accounts`,
    );
    const subAccount = listed.accounts.find((a) => a.currencyCode === 'CAD')!;

    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/accounts/${subAccount.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Wise (CAD)', fxRate: '0.72' }),
    });

    // Re-importing routes the CAD rows to the SAME (renamed) account —
    // nothing new is created despite the name no longer matching.
    const second = await importFile();
    expect(second.body.accountsCreated).toEqual([]);

    const cadAccounts = await env.DB.prepare(
      "select id, name, fx_rate_micros from accounts where budget_id = ? and currency_code = 'CAD' and deleted_at is null",
    )
      .bind(budgetId)
      .all<{ id: string; name: string; fx_rate_micros: number }>();
    expect(cadAccounts.results).toHaveLength(1);
    expect(cadAccounts.results[0]).toMatchObject({ id: subAccount.id, name: 'Wise (CAD)', fx_rate_micros: 720000 });
  });

  it('PATCH changes which statement parser the account uses, and can clear it', async () => {
    // Settable at creation since PR 7 but not afterwards — an account set
    // up before a provider existed, or pointed at the wrong one, was stuck.
    const { app, sessionCookie, budgetId } = await signInNewUser('accounts-patch-provider@example.com');
    const { body: created } = await callJson<{ account: { id: string } }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/accounts`,
      { method: 'POST', body: JSON.stringify({ name: 'Neo', type: 'credit_card', importProvider: 'wise' }) },
    );

    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/accounts/${created.account.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ importProvider: 'neo' }),
    });
    let row = await env.DB.prepare('select import_provider from accounts where id = ?')
      .bind(created.account.id)
      .first<{ import_provider: string | null }>();
    expect(row?.import_provider).toBe('neo');

    // Omitting it leaves it alone; null clears it.
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/accounts/${created.account.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Neo Mastercard' }),
    });
    row = await env.DB.prepare('select import_provider from accounts where id = ?')
      .bind(created.account.id)
      .first<{ import_provider: string | null }>();
    expect(row?.import_provider).toBe('neo');

    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/accounts/${created.account.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ importProvider: null }),
    });
    row = await env.DB.prepare('select import_provider from accounts where id = ?')
      .bind(created.account.id)
      .first<{ import_provider: string | null }>();
    expect(row?.import_provider).toBeNull();
  });

  it('PATCH rejects an invalid exchange rate', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('accounts-fx-patch-invalid@example.com');
    const { body: created } = await callJson<{ account: { id: string } }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/accounts`,
      { method: 'POST', body: JSON.stringify({ name: 'Neo', type: 'credit_card', currencyCode: 'CAD' }) },
    );

    const { status, body } = await callJson<{ error: string }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/accounts/${created.account.id}`,
      { method: 'PATCH', body: JSON.stringify({ fxRate: 'not-a-number' }) },
    );
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_fx_rate');
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

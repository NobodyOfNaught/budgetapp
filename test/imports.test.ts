import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { callJson, resetDb, signInNewUser } from './helpers';

beforeEach(resetDb);

const HEADER =
  'ID,Status,Direction,"Created on","Finished on","Source fee amount","Source fee currency",' +
  '"Target fee amount","Target fee currency","Source name","Source amount (after fees)","Source currency",' +
  '"Target name","Target amount (after fees)","Target currency","Exchange rate",Reference,Batch,' +
  '"Created by",Category,Note';

const GIANT_FOOD =
  '"CARD_TRANSACTION-4113574733",COMPLETED,OUT,"2026-07-27 15:09:01","2026-07-27 15:09:01",0.00,USD,,,' +
  '"Palle Helenius",149.18,USD,"Giant Food",149.18,USD,1.0000000000000000,,,"Palle Helenius",Groceries,';

// The two legs of one $34.50 purchase, funded from a CAD balance and a USD balance.
const SPLIT_CAD =
  '"CARD_TRANSACTION-4145111585",COMPLETED,OUT,"2026-08-03 17:11:26","2026-08-03 17:11:26",0.07,CAD,,,' +
  '"Palle Helenius",15.70,CAD,"Taste of Europe Enterp",11.18,USD,0.7118960000000000,,,"Palle Helenius",Groceries,';
const SPLIT_USD =
  '"CARD_TRANSACTION-4145111585",COMPLETED,OUT,"2026-08-03 17:11:26","2026-08-03 17:11:26",0.00,USD,,,' +
  '"Palle Helenius",23.32,USD,"Taste of Europe Enterp",23.32,USD,1.0000000000000000,,,"Palle Helenius",Groceries,';

const BOUNCED =
  'TRANSFER-2247430954,REFUNDED,OUT,"2026-07-13 15:13:30","2026-07-21 07:28:57",1.41,USD,,,' +
  '"Palle Helenius",3.54,USD,"Palle Helenius",5.0,CAD,1.41395,,,"Palle Helenius",General,';

// A single-currency CAD purchase (source and target both CAD, unlike
// SPLIT_CAD/SPLIT_USD above) — used to exercise budgetAmountMinor
// conversion on a foreign primary account (PR 15), since a mismatched
// currency here would instead take the resolveCurrencyAccount branch.
const TIM_HORTONS_CAD =
  '"CARD_TRANSACTION-9000000001",COMPLETED,OUT,"2026-08-05 08:00:00","2026-08-05 08:00:00",0.00,CAD,,,' +
  '"Palle Helenius",100.00,CAD,"Tim Hortons",100.00,CAD,1.0000000000000000,,,"Palle Helenius",Groceries,';

function csv(...rows: string[]): string {
  return [HEADER, ...rows, ''].join('\n');
}

type App = Awaited<ReturnType<typeof signInNewUser>>['app'];

interface ImportSummary {
  batchId: string;
  rowCount: number;
  imported: number;
  duplicates: number;
  beforeCutoff: number;
  cutoffDate: string | null;
  skipped: { reference: string; reason: string }[];
  accountsCreated: string[];
}

interface ReviewRow {
  id: string;
  date: string;
  amountMinor: number;
  currencyCode: string;
  categoryId: string | null;
  accountName: string;
  payeeName: string | null;
  importPayeeRaw: string | null;
  transferAccountId: string | null;
  transferAccountName: string | null;
  transferDate: string | null;
  transferAmountMinor: number | null;
  transferCurrencyCode: string | null;
  feeForAccountName: string | null;
  feeForDate: string | null;
  feeForAmountMinor: number | null;
  feeForCurrencyCode: string | null;
  cleared: string;
  approved: boolean;
  isSplit: boolean;
}

async function createAccount(app: App, cookie: string, budgetId: string, body: Record<string, unknown>) {
  const { body: res } = await callJson<{
    account: { id: string; currencyCode: string; onBudget: boolean; fxRateMicros: number | null };
    forcedOffBudget: boolean;
  }>(
    app,
    cookie,
    `/api/v1/budgets/${budgetId}/accounts`,
    { method: 'POST', body: JSON.stringify(body) },
  );
  return res;
}

async function importCsv(app: App, cookie: string, budgetId: string, accountId: string, text: string, extra: Record<string, unknown> = {}) {
  return callJson<ImportSummary>(app, cookie, `/api/v1/budgets/${budgetId}/imports`, {
    method: 'POST',
    body: JSON.stringify({ accountId, provider: 'wise', filename: 'statement.csv', csv: text, ...extra }),
  });
}

async function review(app: App, cookie: string, budgetId: string, includeApproved = false) {
  const qs = includeApproved ? '?includeApproved=true' : '';
  const { body } = await callJson<{ transactions: ReviewRow[] }>(app, cookie, `/api/v1/budgets/${budgetId}/imports/review${qs}`);
  return body.transactions;
}

describe('POST /imports', () => {
  it('imports a plain purchase unapproved, with the payee and the suggested category filled in', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('import-basic@example.com');
    const account = await createAccount(app, sessionCookie, budgetId, { name: 'Wise', type: 'checking' });

    const { status, body } = await importCsv(app, sessionCookie, budgetId, account.account.id, csv(GIANT_FOOD));
    expect(status).toBe(201);
    expect(body.imported).toBe(1);
    expect(body.skipped).toEqual([]);

    const rows = await review(app, sessionCookie, budgetId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amountMinor).toBe(-14918);
    expect(rows[0]?.payeeName).toBe('Giant Food');
    expect(rows[0]?.importPayeeRaw).toBe('Giant Food');
    // Wise's "Groceries" maps onto the seeded Groceries category.
    expect(rows[0]?.categoryId).not.toBeNull();
  });

  it('reports an outbound refund as skipped rather than silently dropping it', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('import-skip@example.com');
    const account = await createAccount(app, sessionCookie, budgetId, { name: 'Wise', type: 'checking' });

    const { body } = await importCsv(app, sessionCookie, budgetId, account.account.id, csv(GIANT_FOOD, BOUNCED));
    expect(body.imported).toBe(1);
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0]?.reference).toBe('TRANSFER-2247430954');
  });

  it('is idempotent — re-importing the same file adds nothing', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('import-dedupe@example.com');
    const account = await createAccount(app, sessionCookie, budgetId, { name: 'Wise', type: 'checking' });

    await importCsv(app, sessionCookie, budgetId, account.account.id, csv(GIANT_FOOD, SPLIT_CAD, SPLIT_USD));
    const first = await review(app, sessionCookie, budgetId);

    const { body: second } = await importCsv(app, sessionCookie, budgetId, account.account.id, csv(GIANT_FOOD, SPLIT_CAD, SPLIT_USD));
    expect(second.imported).toBe(0);
    expect(second.duplicates).toBeGreaterThan(0);
    expect(await review(app, sessionCookie, budgetId)).toHaveLength(first.length);
  });

  it('rejects an unknown provider and a foreign account id', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('import-invalid@example.com');
    const account = await createAccount(app, sessionCookie, budgetId, { name: 'Wise', type: 'checking' });

    const badProvider = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/imports`, {
      method: 'POST',
      body: JSON.stringify({ accountId: account.account.id, provider: 'nope', filename: 'f.csv', csv: csv(GIANT_FOOD) }),
    });
    expect(badProvider.status).toBe(400);

    const badAccount = await importCsv(app, sessionCookie, budgetId, 'no-such-account', csv(GIANT_FOOD));
    expect(badAccount.status).toBe(400);
  });
});

describe('split-currency purchase', () => {
  it('auto-creates the foreign balance as a tracking account and records the full purchase value', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('import-split@example.com');
    const account = await createAccount(app, sessionCookie, budgetId, { name: 'Wise', type: 'checking' });

    const { body } = await importCsv(app, sessionCookie, budgetId, account.account.id, csv(SPLIT_CAD, SPLIT_USD));
    expect(body.accountsCreated).toEqual(['Wise (CAD)']);

    const rows = await review(app, sessionCookie, budgetId);
    // One purchase for the real $34.50, plus both legs of the conversion.
    const purchase = rows.find((r) => r.payeeName === 'Taste of Europe Enterp');
    expect(purchase?.amountMinor).toBe(-3450);
    expect(purchase?.currencyCode).toBe('USD');

    const cadLeg = rows.find((r) => r.currencyCode === 'CAD');
    expect(cadLeg?.amountMinor).toBe(-1577); // 15.70 + 0.07 fee
    expect(cadLeg?.accountName).toBe('Wise (CAD)');

    const usdIn = rows.find((r) => r.amountMinor === 1118 && r.currencyCode === 'USD');
    expect(usdIn).toBeDefined();
  });

  it('leaves the USD account balance at exactly what really left it', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('import-split-balance@example.com');
    const account = await createAccount(app, sessionCookie, budgetId, { name: 'Wise', type: 'checking' });
    await importCsv(app, sessionCookie, budgetId, account.account.id, csv(SPLIT_CAD, SPLIT_USD));

    const { body } = await callJson<{ accountBalance: number }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/accounts/${account.account.id}/transactions`,
    );
    // -34.50 purchase + 11.18 converted in = -23.32, the USD leg exactly.
    expect(body.accountBalance).toBe(-2332);
  });
});

describe('foreign-currency accounts', () => {
  it('are forced off-budget, and say so', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('import-currency@example.com');
    const created = await createAccount(app, sessionCookie, budgetId, { name: 'Wise CAD', type: 'checking', currencyCode: 'CAD' });
    expect(created.account.currencyCode).toBe('CAD');
    expect(created.account.onBudget).toBe(false);
    expect(created.forcedOffBudget).toBe(true);
  });

  it('an account in the budget currency stays on-budget', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('import-currency-same@example.com');
    const created = await createAccount(app, sessionCookie, budgetId, { name: 'Wise', type: 'checking', currencyCode: 'USD' });
    expect(created.account.onBudget).toBe(true);
    expect(created.forcedOffBudget).toBe(false);
  });
});

// PR 15: a foreign-currency account with a rate is budgetable, and its
// imported rows must carry a real converted budgetAmountMinor rather than
// the native-currency fallback that was safe only while foreign accounts
// were unconditionally off-budget — see src/routes/imports.ts.
describe('budgetable foreign-currency import', () => {
  it('accepts a comma-decimal rate typed by a user whose locale uses one — real Neo failure otherwise', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('import-fx-comma@example.com');
    const created = await createAccount(app, sessionCookie, budgetId, { name: 'Neo', type: 'credit_card', currencyCode: 'CAD' });
    expect(created.account.onBudget).toBe(false); // no rate yet

    const { status, body } = await importCsv(app, sessionCookie, budgetId, created.account.id, csv(TIM_HORTONS_CAD), {
      fxRate: '0,73',
    });
    expect(status).toBe(201);
    expect(body.imported).toBe(1);

    const { body: accountsList } = await callJson<{ accounts: { id: string; fxRateMicros: number | null }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/accounts`,
    );
    expect(accountsList.accounts.find((a) => a.id === created.account.id)?.fxRateMicros).toBe(730000);
  });

  it('converts budgetAmountMinor using the supplied rate — native and budget currency disagree', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('import-fx-convert@example.com');
    const created = await createAccount(app, sessionCookie, budgetId, {
      name: 'Neo',
      type: 'credit_card',
      currencyCode: 'CAD',
      fxRate: '0.73',
    });
    expect(created.account.onBudget).toBe(true);
    expect(created.forcedOffBudget).toBe(false);

    const { status, body } = await importCsv(app, sessionCookie, budgetId, created.account.id, csv(TIM_HORTONS_CAD));
    expect(status).toBe(201);
    expect(body.imported).toBe(1);

    const rows = await review(app, sessionCookie, budgetId);
    const row = rows.find((r) => r.payeeName === 'Tim Hortons')!;
    expect(row.currencyCode).toBe('CAD');
    expect(row.amountMinor).toBe(-10000); // native: -100.00 CAD, unconverted

    // Approve it into a spending category and check the budget-currency
    // (USD) side through the month view — the only place budgetAmountMinor
    // surfaces, since the register always shows native currency.
    const { body: cats } = await callJson<{ groups: { categories: { id: string; kind: string }[] }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/categories`,
    );
    const groceries = cats.groups.flatMap((g) => g.categories).find((c) => c.kind === 'spending')!;
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/imports/review`, {
      method: 'PATCH',
      body: JSON.stringify({ updates: [{ transactionId: row.id, categoryId: groceries.id, approved: true }] }),
    });

    const { body: month } = await callJson<{ categories: Record<string, { activity: number }> }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/months/2026-08`,
    );
    // -100.00 CAD * 0.73 = -73.00 USD -> -7300 minor, not the native -10000.
    expect(month.categories[groceries.id]?.activity).toBe(-7300);
  });

  it('400s missing_fx_rate when an on-budget foreign account has no rate to use', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('import-fx-missing@example.com');
    const created = await createAccount(app, sessionCookie, budgetId, {
      name: 'Neo',
      type: 'credit_card',
      currencyCode: 'CAD',
      fxRate: '0.73',
    });
    expect(created.account.onBudget).toBe(true);

    // Strip the rate directly in the DB, NOT through the API: PATCH now
    // refuses to leave a foreign account on-budget with no rate
    // (needs_fx_rate_to_budget), so this state is no longer reachable
    // through any route. It remains reachable in DATA — any account that
    // predates that guardrail — which is exactly why the import-time check
    // has to stay. Same posture as test/months.test.ts inserting an
    // income-kind category with raw SQL to prove its defensive check
    // fires rather than merely being unreachable.
    await env.DB.prepare('update accounts set fx_rate_micros = null where id = ?').bind(created.account.id).run();
    const stranded = await env.DB.prepare('select on_budget, fx_rate_micros from accounts where id = ?')
      .bind(created.account.id)
      .first<{ on_budget: number; fx_rate_micros: number | null }>();
    expect(stranded).toMatchObject({ on_budget: 1, fx_rate_micros: null }); // the state under test really exists

    const { status, body } = await importCsv(app, sessionCookie, budgetId, created.account.id, csv(TIM_HORTONS_CAD));
    expect(status).toBe(400);
    expect((body as unknown as { error: string }).error).toBe('missing_fx_rate');
    expect(await review(app, sessionCookie, budgetId)).toEqual([]); // nothing written
  });

  it('remembers a per-import rate onto the account for next time', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('import-fx-remember@example.com');
    // No rate at creation — an existing tracking-only CAD account, like a
    // Wise sub-account, that the user now wants to budget going forward.
    const created = await createAccount(app, sessionCookie, budgetId, { name: 'Neo', type: 'credit_card', currencyCode: 'CAD' });
    expect(created.account.onBudget).toBe(false); // no rate yet, so still off-budget

    // The account stays off-budget (PATCH never recomputes that — see
    // src/routes/accounts.ts), so imports.ts's missing_fx_rate guard,
    // which only fires for an on-budget account, doesn't apply here. The
    // import goes through on the supplied rate alone, and that rate must
    // still be persisted as the account's new default.
    const { status } = await importCsv(app, sessionCookie, budgetId, created.account.id, csv(TIM_HORTONS_CAD), { fxRate: '0.80' });
    expect(status).toBe(201);

    const { body: accountsList } = await callJson<{ accounts: { id: string; fxRateMicros: number | null }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/accounts`,
    );
    const saved = accountsList.accounts.find((a) => a.id === created.account.id);
    expect(saved?.fxRateMicros).toBe(800000); // the supplied 0.80, not the account's earlier 0.73
  });
});

describe('PATCH /imports/review', () => {
  it('categorizes and approves, taking the row out of the queue', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('import-approve@example.com');
    const account = await createAccount(app, sessionCookie, budgetId, { name: 'Wise', type: 'checking' });
    await importCsv(app, sessionCookie, budgetId, account.account.id, csv(GIANT_FOOD));

    const [row] = await review(app, sessionCookie, budgetId);
    const { body: cats } = await callJson<{ groups: { categories: { id: string; kind: string }[] }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/categories`,
    );
    const category = cats.groups.flatMap((g) => g.categories).find((cat) => cat.kind === 'spending')!;

    const { status } = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/imports/review`, {
      method: 'PATCH',
      body: JSON.stringify({ updates: [{ transactionId: row!.id, categoryId: category.id, approved: true }] }),
    });
    expect(status).toBe(200);
    expect(await review(app, sessionCookie, budgetId)).toHaveLength(0);
  });

  it('rejects the whole batch if any transaction or category is not this budget’s', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('import-approve-foreign@example.com');
    const account = await createAccount(app, sessionCookie, budgetId, { name: 'Wise', type: 'checking' });
    await importCsv(app, sessionCookie, budgetId, account.account.id, csv(GIANT_FOOD));
    const [row] = await review(app, sessionCookie, budgetId);

    const badTxn = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/imports/review`, {
      method: 'PATCH',
      body: JSON.stringify({ updates: [{ transactionId: 'nope', approved: true }] }),
    });
    expect(badTxn.status).toBe(400);

    const badCategory = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/imports/review`, {
      method: 'PATCH',
      body: JSON.stringify({ updates: [{ transactionId: row!.id, categoryId: 'nope', approved: true }] }),
    });
    expect(badCategory.status).toBe(400);
    // Still queued — the rejected batch wrote nothing.
    expect(await review(app, sessionCookie, budgetId)).toHaveLength(1);
  });
});

describe('GET /imports', () => {
  it('lists past import runs, newest first, and excludes an undone batch', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('import-history@example.com');
    const wise = await createAccount(app, sessionCookie, budgetId, { name: 'Wise', type: 'checking' });
    const cash = await createAccount(app, sessionCookie, budgetId, { name: 'Cash', type: 'checking' });

    const { body: first } = await importCsv(app, sessionCookie, budgetId, cash.account.id, csv(GIANT_FOOD));
    const { body: second } = await importCsv(app, sessionCookie, budgetId, wise.account.id, csv(SPLIT_CAD, SPLIT_USD));

    const { status, body } = await callJson<{ batches: { id: string; accountName: string; filename: string; importedCount: number }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/imports`,
    );
    expect(status).toBe(200);
    expect(body.batches.map((b) => b.id)).toEqual([second.batchId, first.batchId]); // newest first
    expect(body.batches.find((b) => b.id === first.batchId)?.accountName).toBe('Cash');
    // SPLIT_CAD + SPLIT_USD import as one purchase plus one conversion transfer.
    expect(body.batches.find((b) => b.id === second.batchId)?.importedCount).toBe(2);

    // Undo the mistaken one — it drops out of the list, the other stays.
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/imports/${first.batchId}`, { method: 'DELETE' });
    const { body: after } = await callJson<{ batches: { id: string }[] }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/imports`);
    expect(after.batches.map((b) => b.id)).toEqual([second.batchId]);
  });
});

describe('DELETE /imports/:batchId', () => {
  it('undoes the whole import', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('import-undo@example.com');
    const account = await createAccount(app, sessionCookie, budgetId, { name: 'Wise', type: 'checking' });
    const { body } = await importCsv(app, sessionCookie, budgetId, account.account.id, csv(GIANT_FOOD, SPLIT_CAD, SPLIT_USD));

    const { status } = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/imports/${body.batchId}`, { method: 'DELETE' });
    expect(status).toBe(200);
    expect(await review(app, sessionCookie, budgetId)).toHaveLength(0);

    const { body: register } = await callJson<{ accountBalance: number }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/accounts/${account.account.id}/transactions`,
    );
    expect(register.accountBalance).toBe(0);
  });

  it('re-importing the same file to the same account after an undo succeeds cleanly — regression for the soft-deleted-row unique-index bug', async () => {
    // A soft-deleted transaction must not occupy its (account_id, import_id)
    // slot forever — undo, then import again, has to behave exactly like
    // importing fresh. This previously threw an uncaught UNIQUE constraint
    // violation on the very first row (see migrations/0005), surfacing to
    // the user as a generic "could not import that file" error with no
    // batch record left behind at all.
    const { app, sessionCookie, budgetId } = await signInNewUser('import-undo-reimport@example.com');
    const account = await createAccount(app, sessionCookie, budgetId, { name: 'Wise', type: 'checking' });

    const { body: first } = await importCsv(app, sessionCookie, budgetId, account.account.id, csv(GIANT_FOOD, SPLIT_CAD, SPLIT_USD));
    const reviewCountBeforeUndo = (await review(app, sessionCookie, budgetId)).length; // a transfer's two legs are two real rows
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/imports/${first.batchId}`, { method: 'DELETE' });
    expect(await review(app, sessionCookie, budgetId)).toHaveLength(0);

    const { status, body: second } = await importCsv(app, sessionCookie, budgetId, account.account.id, csv(GIANT_FOOD, SPLIT_CAD, SPLIT_USD));
    expect(status).toBe(201);
    expect(second.imported).toBe(first.imported); // fully re-imported, none blocked as a false "duplicate"
    expect(second.duplicates).toBe(0);
    expect(await review(app, sessionCookie, budgetId)).toHaveLength(reviewCountBeforeUndo);
  });

  it('404s for a batch that is not this budget’s', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('import-undo-missing@example.com');
    const { status } = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/imports/nope`, { method: 'DELETE' });
    expect(status).toBe(404);
  });
});

describe('payee rules and the generic naming heuristic — provider-agnostic', () => {
  const becuHeader = '"Date","No.","Description","Debit","Credit"';
  function becuCsv(...rows: string[]): string {
    return [becuHeader, ...rows, ''].join('\n');
  }
  const GIANT_FOOD_ROW =
    '"8/14/2026","","POS Withdrawal - 160000101207 GIANT FOOD INC #152 13 COLESVILLE   MDUS - Card Ending In 1658","-109.21",""';

  async function createRule(app: App, cookie: string, budgetId: string, body: Record<string, unknown>) {
    return callJson(app, cookie, `/api/v1/budgets/${budgetId}/payee-rules`, { method: 'POST', body: JSON.stringify(body) });
  }

  it('with no matching rule, falls back to the generic cleanPayeeName heuristic over BECU\'s own best-effort name', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('import-becu-heuristic@example.com');
    const account = await createAccount(app, sessionCookie, budgetId, { name: 'BECU', type: 'checking' });

    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/imports`, {
      method: 'POST',
      body: JSON.stringify({ accountId: account.account.id, provider: 'becu', filename: 'statement.csv', csv: becuCsv(GIANT_FOOD_ROW) }),
    });

    const [row] = await review(app, sessionCookie, budgetId);
    expect(row?.payeeName).toBe('GIANT FOOD INC #152');
    expect(row?.importPayeeRaw).toBe(
      'POS Withdrawal - 160000101207 GIANT FOOD INC #152 13 COLESVILLE   MDUS - Card Ending In 1658',
    );
  });

  it('a matching rule outranks the heuristic and sets the category', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('import-becu-rule@example.com');
    const account = await createAccount(app, sessionCookie, budgetId, { name: 'BECU', type: 'checking' });
    const { body: cats } = await callJson<{ groups: { categories: { id: string; kind: string }[] }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/categories`,
    );
    const groceries = cats.groups.flatMap((g) => g.categories).find((c) => c.kind === 'spending')!;

    await createRule(app, sessionCookie, budgetId, { matchText: 'GIANT FOOD INC', payeeName: 'Giant Food', categoryId: groceries.id });

    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/imports`, {
      method: 'POST',
      body: JSON.stringify({ accountId: account.account.id, provider: 'becu', filename: 'statement.csv', csv: becuCsv(GIANT_FOOD_ROW) }),
    });

    const [row] = await review(app, sessionCookie, budgetId);
    expect(row?.payeeName).toBe('Giant Food'); // not the heuristic's "GIANT FOOD INC #152"
    expect(row?.categoryId).toBe(groceries.id); // rule beats the (nonexistent, for BECU) provider suggestion
  });

  it('the same rule applies to a Wise import too — rules and the heuristic are not BECU-specific', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('import-wise-rule@example.com');
    const account = await createAccount(app, sessionCookie, budgetId, { name: 'Wise', type: 'checking' });
    await createRule(app, sessionCookie, budgetId, { matchText: 'Giant Food', payeeName: 'Giant Food (renamed)' });

    await importCsv(app, sessionCookie, budgetId, account.account.id, csv(GIANT_FOOD));

    const [row] = await review(app, sessionCookie, budgetId);
    expect(row?.payeeName).toBe('Giant Food (renamed)');
    expect(row?.importPayeeRaw).toBe('Giant Food'); // verbatim text untouched regardless
  });

  it('re-importing the same BECU file is a no-op, including the two identical Zelle rows', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('import-becu-dedupe@example.com');
    const account = await createAccount(app, sessionCookie, budgetId, { name: 'BECU', type: 'checking' });
    const zelleRows = becuCsv(
      GIANT_FOOD_ROW,
      '"8/2/2026","","Transfer Withdrawal -  Zelle LEMERY ROLLINS (800)233-2328","-70.80",""',
      '"8/2/2026","","Transfer Withdrawal -  Zelle LEMERY ROLLINS (800)233-2328","-70.80",""',
    );

    const { body: first } = await callJson<ImportSummary>(app, sessionCookie, `/api/v1/budgets/${budgetId}/imports`, {
      method: 'POST',
      body: JSON.stringify({ accountId: account.account.id, provider: 'becu', filename: 'statement.csv', csv: zelleRows }),
    });
    expect(first.imported).toBe(3);
    const afterFirst = await review(app, sessionCookie, budgetId);
    expect(afterFirst).toHaveLength(3);

    const { body: second } = await callJson<ImportSummary>(app, sessionCookie, `/api/v1/budgets/${budgetId}/imports`, {
      method: 'POST',
      body: JSON.stringify({ accountId: account.account.id, provider: 'becu', filename: 'statement.csv', csv: zelleRows }),
    });
    expect(second.imported).toBe(0);
    expect(second.duplicates).toBe(3);
    expect(await review(app, sessionCookie, budgetId)).toHaveLength(3);
  });
});

describe('which Wise account you import into does not change where rows land', () => {
  // resolveCurrencyAccount matches on (budget, currency, provider) — never
  // on "is this the account the user picked" — so a multi-balance export
  // fans out to the same accounts either way. Worth pinning: the natural
  // assumption is that importing into the CAD account files everything
  // under CAD, and acting on that assumption is how a statement ends up
  // looking like it went somewhere unexpected.
  const MIXED = [SPLIT_CAD, SPLIT_USD, GIANT_FOOD];

  async function importInto(email: string, primaryCurrency: 'USD' | 'CAD') {
    const { app, sessionCookie, budgetId } = await signInNewUser(email);
    // Both Wise balances exist up front, as they would after any earlier import.
    const usd = await createAccount(app, sessionCookie, budgetId, {
      name: 'Wise USD',
      type: 'checking',
      importProvider: 'wise',
    });
    const cad = await createAccount(app, sessionCookie, budgetId, {
      name: 'Wise CAD',
      type: 'checking',
      currencyCode: 'CAD',
      fxRate: '0.72',
      importProvider: 'wise',
    });

    const primary = primaryCurrency === 'USD' ? usd : cad;
    await importCsv(app, sessionCookie, budgetId, primary.account.id, csv(...MIXED));

    const rows = await review(app, sessionCookie, budgetId);
    return rows
      .map((r) => `${r.accountName} ${r.currencyCode} ${r.amountMinor}`)
      .sort()
      .join(' | ');
  }

  it('fans out identically whether the USD or the CAD balance is picked', async () => {
    const viaUsd = await importInto('import-wise-primary-usd@example.com', 'USD');
    const viaCad = await importInto('import-wise-primary-cad@example.com', 'CAD');

    expect(viaUsd).toBe(viaCad);
    // And it really did split across both accounts rather than pooling.
    expect(viaUsd).toContain('Wise CAD CAD');
    expect(viaUsd).toContain('Wise USD USD');
  });
});

describe('a Wise top-up lands as an inflow, converted by the account it lands in', () => {
  const TOP_UP_CAD =
    'TRANSFER-2270774033,COMPLETED,IN,"2026-07-25 23:08:26","2026-07-28 10:05:13",0.31,CAD,,,' +
    '"Palle Helenius",1900.00,CAD,"Palle Helenius",1900.0,CAD,1.0,,,"Palle Helenius","Money added",';

  it('credits the CAD sub-account instead of debiting it', async () => {
    // The regression this pair of fixes exists for: funding Wise from an
    // external bank is direction IN with the user's name on both sides,
    // and used to be read as an internal conversion — a DEBIT against a
    // balance that had never received the money. See src/import/wise.ts.
    const { app, sessionCookie, budgetId } = await signInNewUser('import-wise-topup@example.com');
    const account = await createAccount(app, sessionCookie, budgetId, { name: 'Wise', type: 'checking' });

    const { body } = await importCsv(app, sessionCookie, budgetId, account.account.id, csv(TOP_UP_CAD));
    expect(body.accountsCreated).toEqual(['Wise (CAD)']);

    const rows = await review(app, sessionCookie, budgetId);
    expect(rows).toHaveLength(1); // one inflow, NOT a two-legged conversion
    expect(rows[0]).toMatchObject({ amountMinor: 190000, currencyCode: 'CAD', accountName: 'Wise (CAD)' });
  });

  it('converts that inflow using the SUB-account’s rate, not the primary’s', async () => {
    // The row lands in Wise (CAD), which is not the account the user
    // picked. Before this fix a secondary account's ordinary rows kept
    // their native amount as budgetAmountMinor — so 1900 CAD would have
    // counted as 1900 USD the moment the sub-account went on-budget.
    const { app, sessionCookie, budgetId } = await signInNewUser('import-wise-topup-rate@example.com');
    const account = await createAccount(app, sessionCookie, budgetId, { name: 'Wise', type: 'checking' });
    await importCsv(app, sessionCookie, budgetId, account.account.id, csv(TOP_UP_CAD));

    const { body: list } = await callJson<{ accounts: { id: string; name: string }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/accounts`,
    );
    const sub = list.accounts.find((a) => a.name === 'Wise (CAD)')!;
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/accounts/${sub.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ fxRate: '0.72' }),
    });

    // Re-import after undoing, so the rate is on file when rows are written.
    const { body: batches } = await callJson<{ batches: { id: string }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/imports`,
    );
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/imports/${batches.batches[0]!.id}`, { method: 'DELETE' });
    await importCsv(app, sessionCookie, budgetId, account.account.id, csv(TOP_UP_CAD));

    const row = await env.DB.prepare(
      'select amount_minor a, budget_amount_minor b from transactions where account_id = ? and deleted_at is null',
    )
      .bind(sub.id)
      .first<{ a: number; b: number }>();
    expect(row?.a).toBe(190000); // native CAD, untouched
    expect(row?.b).toBe(136800); // 1900.00 * 0.72 = 1368.00 USD
  });
});

describe('Vancity: parser and the generic heuristic split the work', () => {
  const VANCITY_HEADER = 'Date,Description,Debits,Credits,Balance';
  function vancityCsv(...rows: string[]): string {
    return [VANCITY_HEADER, ...rows, ''].join('\n');
  }

  it('collapses the triplicated name in the parser, then lets cleanPayeeName cut the reference number', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('import-vancity-payees@example.com');
    const account = await createAccount(app, sessionCookie, budgetId, {
      name: 'Vancity',
      type: 'checking',
      currencyCode: 'CAD',
      fxRate: '0.72',
    });

    const { status, body } = await callJson<ImportSummary>(app, sessionCookie, `/api/v1/budgets/${budgetId}/imports`, {
      method: 'POST',
      body: JSON.stringify({
        accountId: account.account.id,
        provider: 'vancity',
        filename: 'vancity.csv',
        csv: vancityCsv(
          '14-Aug-2026,Payroll deposit INOVATEC INOVATEC INOVATEC,,2455.48,2803.59',
          '14-Aug-2026,Bill payment-online WISE 6154 180470,2093.80,,709.79',
          '25-Jul-2026,Bill payment-online VANCITY VISA 2476 376282,200.00,,1902.94',
        ),
      }),
    });
    expect(status).toBe(201);
    expect(body.imported).toBe(3);

    const rows = await review(app, sessionCookie, budgetId);
    const names = rows.map((r) => r.payeeName).sort();
    // The stutter is gone (parser's job) AND the trailing per-payment
    // reference number is gone (the route-layer heuristic's job) — neither
    // alone produces these.
    expect(names).toEqual(['INOVATEC', 'VANCITY VISA', 'WISE']);

    // The untouched description survives for payee_rules to match on.
    const payroll = rows.find((r) => r.payeeName === 'INOVATEC')!;
    expect(payroll.importPayeeRaw).toBe('Payroll deposit INOVATEC INOVATEC INOVATEC');
    expect(payroll.currencyCode).toBe('CAD');
  });
});

describe('Splitwise: options plumbing', () => {
  const SPLITWISE_HEADER = 'Date,Description,Category,Cost,Currency,Steve,kristine sandt,Palle Helenius,Katherine Atwill';
  function splitwiseCsv(...rows: string[]): string {
    return [SPLITWISE_HEADER, ...rows, ''].join('\n');
  }
  const RENT_ROW = '2025-07-01,July rent,Rent,1700.00,USD,0.00,-850.00,-850.00,1700.00';
  const OUR_TWO = ['kristine sandt', 'Palle Helenius'];

  it('POST /imports/inspect reports the file\'s participants and writes nothing', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('splitwise-inspect@example.com');

    const { status, body } = await callJson<{ participants: string[]; rowCount: number }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/imports/inspect`,
      { method: 'POST', body: JSON.stringify({ provider: 'splitwise', csv: splitwiseCsv(RENT_ROW) }) },
    );
    expect(status).toBe(200);
    expect(body.participants).toEqual(['Steve', 'kristine sandt', 'Palle Helenius', 'Katherine Atwill']);
    expect(body.rowCount).toBe(1);

    expect(await review(app, sessionCookie, budgetId)).toEqual([]); // nothing written
  });

  it('rejects a Splitwise import with no members selected', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('splitwise-no-members@example.com');
    const account = await createAccount(app, sessionCookie, budgetId, { name: 'Splitwise', type: 'checking' });

    const { status, body } = await callJson<{ error: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/imports`, {
      method: 'POST',
      body: JSON.stringify({ accountId: account.account.id, provider: 'splitwise', filename: 'sw.csv', csv: splitwiseCsv(RENT_ROW) }),
    });
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_options');
    expect(await review(app, sessionCookie, budgetId)).toEqual([]);
  });

  it('persists the member selection onto the account, and a second import pre-fills it', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('splitwise-remember@example.com');
    const account = await createAccount(app, sessionCookie, budgetId, { name: 'Splitwise', type: 'checking' });

    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/imports`, {
      method: 'POST',
      body: JSON.stringify({
        accountId: account.account.id,
        provider: 'splitwise',
        filename: 'sw.csv',
        csv: splitwiseCsv(RENT_ROW),
        options: { members: OUR_TWO },
      }),
    });

    const { body: accountsList } = await callJson<{ accounts: { id: string; importOptions: string | null }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/accounts`,
    );
    const saved = accountsList.accounts.find((a) => a.id === account.account.id);
    expect(saved?.importOptions && JSON.parse(saved.importOptions)).toEqual({ members: OUR_TWO });
  });

  it('imports the net position for the selected members, categorized, and leaves out zero-net rows', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('splitwise-import@example.com');
    const account = await createAccount(app, sessionCookie, budgetId, { name: 'Splitwise', type: 'checking' });

    const { status, body } = await callJson<ImportSummary>(app, sessionCookie, `/api/v1/budgets/${budgetId}/imports`, {
      method: 'POST',
      body: JSON.stringify({
        accountId: account.account.id,
        provider: 'splitwise',
        filename: 'sw.csv',
        csv: splitwiseCsv(
          RENT_ROW, // net -1700 for our pair — Katherine fronted it
          '2025-08-06,Groceries ,Groceries,107.00,USD,-26.75,-26.75,80.25,-26.75', // net +53.50 — Palle fronted it
          '2025-07-02,kristine s. paid Palle H.,Payment,1008.35,USD,0.00,1008.35,-1008.35,0.00', // nets to 0 for our pair — skipped
        ),
        options: { members: OUR_TWO },
      }),
    });
    expect(status).toBe(201);
    expect(body.imported).toBe(2);
    expect(body.skipped).toHaveLength(1);

    const rows = await review(app, sessionCookie, budgetId);
    const rent = rows.find((r) => r.amountMinor === -170000)!;
    expect(rent.categoryId).not.toBeNull(); // Rent -> Rent/Mortgage
    const groceryReimbursement = rows.find((r) => r.amountMinor === 5350)!;
    expect(groceryReimbursement.categoryId).not.toBeNull(); // Groceries -> Groceries
  });
});

describe('authorization', () => {
  it('403s list, review, import and undo for a non-member', async () => {
    const { budgetId } = await signInNewUser('import-owner@example.com');
    const { app: outsider, sessionCookie: outsiderCookie } = await signInNewUser('import-outsider@example.com');

    expect((await callJson(outsider, outsiderCookie, `/api/v1/budgets/${budgetId}/imports`)).status).toBe(403);
    expect((await callJson(outsider, outsiderCookie, `/api/v1/budgets/${budgetId}/imports/review`)).status).toBe(403);
    expect((await importCsv(outsider, outsiderCookie, budgetId, 'x', csv(GIANT_FOOD))).status).toBe(403);
    expect(
      (await callJson(outsider, outsiderCookie, `/api/v1/budgets/${budgetId}/imports/anything`, { method: 'DELETE' })).status,
    ).toBe(403);
    expect(
      (
        await callJson(outsider, outsiderCookie, `/api/v1/budgets/${budgetId}/imports/inspect`, {
          method: 'POST',
          body: JSON.stringify({ provider: 'wise', csv: csv(GIANT_FOOD) }),
        })
      ).status,
    ).toBe(403);
  });
});

describe('the review queue names what a transfer is linked to', () => {
  // "(transfer)" told the user a row was linked without saying to what,
  // which is the one thing worth confirming about a transfer — and it
  // matters more now that the two legs need not be equal: they differ by
  // a conversion rate, or by a fee taken in transit.
  async function linkedPair(email: string) {
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
      body: JSON.stringify({ kind: 'ordinary', accountId: vancity.account.id, date: '2026-07-25', amount: '-1900.31' }),
    });
    const { body: inn } = await callJson<{ transactionId: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId: wise.account.id, date: '2026-07-28', amount: '1900.00' }),
    });
    const { body: linked } = await callJson<{ feeTransactionId: string }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/transactions/${out.transactionId}/link-transfer`,
      { method: 'POST', body: JSON.stringify({ otherTransactionId: inn.transactionId }) },
    );
    return { app, sessionCookie, budgetId, outId: out.transactionId, inId: inn.transactionId, feeId: linked.feeTransactionId };
  }

  it('carries the fee row and names the transfer leg it was carved from', async () => {
    const { app, sessionCookie, budgetId, feeId } = await linkedPair('review-fee-context@example.com');
    const rows = await review(app, sessionCookie, budgetId);

    const fee = rows.find((r) => r.id === feeId)!;
    expect(fee.feeForAccountName).toBe('Vancity Gold');
    expect(fee.feeForDate).toBe('2026-07-25');
    // The leg AFTER the fee was carved out — what the transfer actually
    // moved, not the pre-fee figure the statement printed.
    expect(fee.feeForAmountMinor).toBe(-190000);
    expect(fee.feeForCurrencyCode).toBe('CAD');
    // A fee is not itself a transfer, so the transfer fields stay empty.
    expect(fee.transferAccountName).toBeNull();
  });

  it('names the counterpart account and its own amount on a transfer leg', async () => {
    const { app, sessionCookie, budgetId, outId, inId } = await linkedPair('review-transfer-context@example.com');
    // Both legs are approved by the link, so put one back in the queue the
    // way an imported row would arrive.
    await env.DB.prepare('update transactions set approved = 0 where id in (?, ?)').bind(outId, inId).run();

    const rows = await review(app, sessionCookie, budgetId);
    const out = rows.find((r) => r.id === outId)!;
    expect(out.transferAccountName).toBe('Wise CAD');
    expect(out.transferDate).toBe('2026-07-28');
    expect(out.transferAmountMinor).toBe(190000);
    expect(out.transferCurrencyCode).toBe('CAD');

    // And symmetrically from the other side.
    const inn = rows.find((r) => r.id === inId)!;
    expect(inn.transferAccountName).toBe('Vancity Gold');
    expect(inn.transferAmountMinor).toBe(-190000);
  });

  it('leaves every transfer field null on an ordinary row', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('review-no-transfer@example.com');
    const account = await createAccount(app, sessionCookie, budgetId, { name: 'Wise', type: 'checking' });
    await importCsv(app, sessionCookie, budgetId, account.account.id, csv(GIANT_FOOD));

    const [row] = await review(app, sessionCookie, budgetId);
    expect(row?.transferAccountId).toBeNull();
    expect(row?.transferAccountName).toBeNull();
    expect(row?.transferAmountMinor).toBeNull();
    expect(row?.feeForAccountName).toBeNull();
  });
});

describe('the import cutoff date', () => {
  // A bank export doesn't respect the date a budget started: a file
  // downloaded for last month routinely carries a year of history, and
  // every older row would otherwise import as a real transaction moving
  // balances and Ready to Assign. GIANT_FOOD is dated 2026-07-27,
  // SPLIT_* 2026-08-03, TIM_HORTONS_CAD 2026-08-05.
  async function setup(email: string) {
    const { app, sessionCookie, budgetId } = await signInNewUser(email);
    const account = await createAccount(app, sessionCookie, budgetId, { name: 'Wise', type: 'checking' });
    return { app, sessionCookie, budgetId, accountId: account.account.id };
  }

  it('skips rows dated before the cutoff and says so', async () => {
    const { app, sessionCookie, budgetId, accountId } = await setup('cutoff-basic@example.com');
    const { body } = await importCsv(app, sessionCookie, budgetId, accountId, csv(GIANT_FOOD, SPLIT_USD), {
      cutoffDate: '2026-08-01',
    });

    expect(body.imported).toBe(1);
    expect(body.beforeCutoff).toBe(1);
    expect(body.cutoffDate).toBe('2026-08-01');
    // Reported, not silently dropped — a guard that quietly discards data
    // is its own kind of bug.
    expect(body.skipped).toContainEqual({
      reference: 'Giant Food',
      reason: 'dated 2026-07-27, before the 2026-08-01 cutoff',
    });

    const rows = await review(app, sessionCookie, budgetId);
    expect(rows.map((r) => r.date)).toEqual(['2026-08-03']);
  });

  it('keeps a row dated exactly ON the cutoff', async () => {
    // "prior to which it will not import" — the cutoff date itself is
    // inside the window, so setting it to the day you started budgeting
    // imports that day.
    const { app, sessionCookie, budgetId, accountId } = await setup('cutoff-boundary@example.com');
    const { body } = await importCsv(app, sessionCookie, budgetId, accountId, csv(GIANT_FOOD), {
      cutoffDate: '2026-07-27',
    });
    expect(body.imported).toBe(1);
    expect(body.beforeCutoff).toBe(0);
  });

  it('remembers the cutoff on the budget, so the next import is guarded without retyping it', async () => {
    const { app, sessionCookie, budgetId, accountId } = await setup('cutoff-remembered@example.com');
    await importCsv(app, sessionCookie, budgetId, accountId, csv(SPLIT_USD), { cutoffDate: '2026-08-01' });

    // Second import supplies NO cutoff at all — this is the whole point:
    // the failure being guarded against is forgetting, so a guard you
    // must remember to type is not a guard.
    const { body } = await importCsv(app, sessionCookie, budgetId, accountId, csv(GIANT_FOOD));
    expect(body.imported).toBe(0);
    expect(body.beforeCutoff).toBe(1);
    expect(body.cutoffDate).toBe('2026-08-01');

    const { body: budget } = await callJson<{ budget: { importCutoffDate: string | null } }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}`,
    );
    expect(budget.budget.importCutoffDate).toBe('2026-08-01');
  });

  it('an explicit null clears the stored cutoff', async () => {
    const { app, sessionCookie, budgetId, accountId } = await setup('cutoff-clear@example.com');
    await importCsv(app, sessionCookie, budgetId, accountId, csv(SPLIT_USD), { cutoffDate: '2026-08-01' });

    const { body } = await importCsv(app, sessionCookie, budgetId, accountId, csv(GIANT_FOOD), { cutoffDate: null });
    expect(body.imported).toBe(1);
    expect(body.beforeCutoff).toBe(0);
    expect(body.cutoffDate).toBeNull();

    const { body: budget } = await callJson<{ budget: { importCutoffDate: string | null } }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}`,
    );
    expect(budget.budget.importCutoffDate).toBeNull();
  });

  it('imports everything when no cutoff has ever been set', async () => {
    const { app, sessionCookie, budgetId, accountId } = await setup('cutoff-absent@example.com');
    const { body } = await importCsv(app, sessionCookie, budgetId, accountId, csv(GIANT_FOOD, SPLIT_USD));
    expect(body.imported).toBe(2);
    expect(body.beforeCutoff).toBe(0);
    expect(body.cutoffDate).toBeNull();
  });

  it('holds back a cross-currency transfer row too, not just ordinary ones', async () => {
    // The two SPLIT_* legs are one purchase funded from a CAD balance,
    // which the parser emits as a transfer plus an ordinary row. Both
    // carry a date and both must respect the cutoff — filtering only
    // ordinary rows would let a transfer through and strand its pair.
    const { app, sessionCookie, budgetId, accountId } = await setup('cutoff-transfer@example.com');
    const { body } = await importCsv(app, sessionCookie, budgetId, accountId, csv(SPLIT_CAD, SPLIT_USD), {
      cutoffDate: '2026-09-01',
    });
    expect(body.imported).toBe(0);
    expect(body.beforeCutoff).toBe(2);
  });

  it('rejects a malformed cutoff rather than ignoring it', async () => {
    const { app, sessionCookie, budgetId, accountId } = await setup('cutoff-malformed@example.com');
    const { status } = await importCsv(app, sessionCookie, budgetId, accountId, csv(GIANT_FOOD), {
      cutoffDate: 'last August',
    });
    expect(status).toBe(400);
  });
});

describe('reviewing (and editing) transactions already approved', () => {
  // The default query is unapproved-only, unchanged; ?includeApproved=true
  // widens it to everything, so a mistake that already slipped past
  // approval (a miscategorized purchase, an uncategorized starting
  // balance) is findable without hunting through each account's register.
  async function setup(email: string) {
    const { app, sessionCookie, budgetId } = await signInNewUser(email);
    const account = await createAccount(app, sessionCookie, budgetId, { name: 'Checking', type: 'checking' });
    return { app, sessionCookie, budgetId, accountId: account.account.id };
  }

  it('the default query still excludes approved rows', async () => {
    const { app, sessionCookie, budgetId, accountId } = await setup('review-approved-default@example.com');
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId, date: '2026-03-01', amount: '100.00' }), // approved: true by default
    });
    expect(await review(app, sessionCookie, budgetId)).toEqual([]);
  });

  it('includeApproved=true returns it, with approved: true', async () => {
    const { app, sessionCookie, budgetId, accountId } = await setup('review-approved-included@example.com');
    const { body: created } = await callJson<{ transactionId: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId, date: '2026-03-01', amount: '100.00' }),
    });
    const rows = await review(app, sessionCookie, budgetId, true);
    const row = rows.find((r) => r.id === created.transactionId);
    expect(row).toBeDefined();
    expect(row?.approved).toBe(true);
  });

  it('mixes approved and unapproved rows in one list, each flagged correctly', async () => {
    const { app, sessionCookie, budgetId, accountId } = await setup('review-approved-mixed@example.com');
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId, date: '2026-03-01', amount: '100.00' }), // approved
    });
    await importCsv(app, sessionCookie, budgetId, accountId, csv(GIANT_FOOD)); // unapproved

    const rows = await review(app, sessionCookie, budgetId, true);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.approved)).toHaveLength(1);
    expect(rows.filter((r) => !r.approved)).toHaveLength(1);
  });

  it('PATCH /review still recategorizes an already-approved row (approved stays true)', async () => {
    // Fixing a mistake found this way shouldn't require a round trip
    // through "unapprove, fix, reapprove" — the same PATCH already used
    // for approving works directly on an approved row.
    const { app, sessionCookie, budgetId, accountId } = await setup('review-approved-recategorize@example.com');
    const { body: created } = await callJson<{ transactionId: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId, date: '2026-03-01', amount: '-50.00' }),
    });
    const { body: cats } = await callJson<{ groups: { categories: { id: string; kind: string }[] }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/categories`,
    );
    const categoryId = cats.groups.flatMap((g) => g.categories).find((c) => c.kind === 'spending')!.id;

    const { status } = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/imports/review`, {
      method: 'PATCH',
      body: JSON.stringify({ updates: [{ transactionId: created.transactionId, categoryId, approved: true }] }),
    });
    expect(status).toBe(200);

    const rows = await review(app, sessionCookie, budgetId, true);
    const row = rows.find((r) => r.id === created.transactionId);
    expect(row?.categoryId).toBe(categoryId);
    expect(row?.approved).toBe(true);
  });

  it('flags a split parent with isSplit, categoryId null — its children carry the real category', async () => {
    const { app, sessionCookie, budgetId, accountId } = await setup('review-approved-split@example.com');
    const { body: cats } = await callJson<{ groups: { categories: { id: string; kind: string }[] }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/categories`,
    );
    const spending = cats.groups.flatMap((g) => g.categories).filter((c) => c.kind === 'spending');

    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'split',
        accountId,
        date: '2026-03-01',
        splits: [
          { amount: '-30.00', categoryId: spending[0]!.id },
          { amount: '-20.00', categoryId: spending[1]!.id },
        ],
      }),
    });

    const rows = await review(app, sessionCookie, budgetId, true);
    // Only the parent — children carry parent_transaction_id and are
    // excluded from this list, same as the register and the ledger.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isSplit).toBe(true);
    expect(rows[0]?.categoryId).toBeNull();
    expect(rows[0]?.amountMinor).toBe(-5000);
  });

  it('an unapproved row reports isSplit: false and approved: false', async () => {
    const { app, sessionCookie, budgetId, accountId } = await setup('review-not-split-not-approved@example.com');
    await importCsv(app, sessionCookie, budgetId, accountId, csv(GIANT_FOOD));
    const [row] = await review(app, sessionCookie, budgetId);
    expect(row?.isSplit).toBe(false);
    expect(row?.approved).toBe(false);
  });
});

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

function csv(...rows: string[]): string {
  return [HEADER, ...rows, ''].join('\n');
}

type App = Awaited<ReturnType<typeof signInNewUser>>['app'];

interface ImportSummary {
  batchId: string;
  rowCount: number;
  imported: number;
  duplicates: number;
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
}

async function createAccount(app: App, cookie: string, budgetId: string, body: Record<string, unknown>) {
  const { body: res } = await callJson<{ account: { id: string; currencyCode: string; onBudget: boolean }; forcedOffBudget: boolean }>(
    app,
    cookie,
    `/api/v1/budgets/${budgetId}/accounts`,
    { method: 'POST', body: JSON.stringify(body) },
  );
  return res;
}

async function importCsv(app: App, cookie: string, budgetId: string, accountId: string, text: string) {
  return callJson<ImportSummary>(app, cookie, `/api/v1/budgets/${budgetId}/imports`, {
    method: 'POST',
    body: JSON.stringify({ accountId, provider: 'wise', filename: 'statement.csv', csv: text }),
  });
}

async function review(app: App, cookie: string, budgetId: string) {
  const { body } = await callJson<{ transactions: ReviewRow[] }>(app, cookie, `/api/v1/budgets/${budgetId}/imports/review`);
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
  });
});

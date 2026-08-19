import { beforeEach, describe, expect, it } from 'vitest';
import { callJson, resetDb, signInNewUser } from './helpers';

beforeEach(resetDb);

type App = Awaited<ReturnType<typeof signInNewUser>>['app'];

interface RuleView {
  id: string;
  matchText: string;
  payeeName: string;
  categoryId: string | null;
}

interface ReviewRow {
  id: string;
  categoryId: string | null;
  payeeName: string | null;
  importPayeeRaw: string | null;
}

const BECU_HEADER = '"Date","No.","Description","Debit","Credit"';

function becuCsv(...rows: string[]): string {
  return [BECU_HEADER, ...rows, ''].join('\n');
}

async function createRule(app: App, cookie: string, budgetId: string, body: Record<string, unknown>) {
  return callJson<{ rule: RuleView }>(app, cookie, `/api/v1/budgets/${budgetId}/payee-rules`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function listRules(app: App, cookie: string, budgetId: string) {
  const { body } = await callJson<{ rules: RuleView[] }>(app, cookie, `/api/v1/budgets/${budgetId}/payee-rules`);
  return body.rules;
}

async function createAccount(app: App, cookie: string, budgetId: string, body: Record<string, unknown>) {
  const { body: res } = await callJson<{ account: { id: string } }>(app, cookie, `/api/v1/budgets/${budgetId}/accounts`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return res.account.id;
}

async function review(app: App, cookie: string, budgetId: string) {
  const { body } = await callJson<{ transactions: ReviewRow[] }>(app, cookie, `/api/v1/budgets/${budgetId}/imports/review`);
  return body.transactions;
}

async function spendingCategoryIds(app: App, cookie: string, budgetId: string) {
  const { body } = await callJson<{ groups: { categories: { id: string; kind: string }[] }[] }>(
    app,
    cookie,
    `/api/v1/budgets/${budgetId}/categories`,
  );
  return body.groups.flatMap((g) => g.categories).filter((c) => c.kind === 'spending');
}

describe('GET/POST /payee-rules', () => {
  it('creates a rule and it shows up on the next GET', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('rules-create@example.com');
    const { status, body } = await createRule(app, sessionCookie, budgetId, { matchText: 'GIANT FOOD', payeeName: 'Giant Food' });
    expect(status).toBe(201);
    expect(body.rule).toEqual({ id: body.rule.id, matchText: 'GIANT FOOD', payeeName: 'Giant Food', categoryId: null });

    const rules = await listRules(app, sessionCookie, budgetId);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.payeeName).toBe('Giant Food');
  });

  it('accepts an optional category', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('rules-category@example.com');
    const [category] = await spendingCategoryIds(app, sessionCookie, budgetId);

    const { status, body } = await createRule(app, sessionCookie, budgetId, {
      matchText: 'GIANT FOOD',
      payeeName: 'Giant Food',
      categoryId: category!.id,
    });
    expect(status).toBe(201);
    expect(body.rule.categoryId).toBe(category!.id);
  });

  it('rejects a category from a different budget', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('rules-foreign-category@example.com');
    const other = await signInNewUser('rules-foreign-other@example.com');
    const [foreignCategory] = await spendingCategoryIds(other.app, other.sessionCookie, other.budgetId);

    const { status } = await createRule(app, sessionCookie, budgetId, {
      matchText: 'X',
      payeeName: 'Y',
      categoryId: foreignCategory!.id,
    });
    expect(status).toBe(400);
  });

  it('rejects a blank matchText or payeeName', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('rules-blank@example.com');
    expect((await createRule(app, sessionCookie, budgetId, { matchText: '', payeeName: 'X' })).status).toBe(400);
    expect((await createRule(app, sessionCookie, budgetId, { matchText: 'X', payeeName: '' })).status).toBe(400);
  });
});

describe('PATCH /payee-rules/:ruleId', () => {
  it('updates fields independently, leaving the rest untouched', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('rules-update@example.com');
    const { body: created } = await createRule(app, sessionCookie, budgetId, { matchText: 'GIANT FOOD', payeeName: 'Giant Food' });

    const { status } = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/payee-rules/${created.rule.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ payeeName: 'Giant Food Co' }),
    });
    expect(status).toBe(200);

    const rules = await listRules(app, sessionCookie, budgetId);
    expect(rules[0]?.payeeName).toBe('Giant Food Co');
    expect(rules[0]?.matchText).toBe('GIANT FOOD');
  });

  it('404s for a rule that is not this budget’s', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('rules-update-missing@example.com');
    const { status } = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/payee-rules/nope`, {
      method: 'PATCH',
      body: JSON.stringify({ payeeName: 'X' }),
    });
    expect(status).toBe(404);
  });
});

describe('DELETE /payee-rules/:ruleId', () => {
  it('soft-deletes — the rule stops appearing', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('rules-delete@example.com');
    const { body: created } = await createRule(app, sessionCookie, budgetId, { matchText: 'GIANT FOOD', payeeName: 'Giant Food' });

    const { status } = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/payee-rules/${created.rule.id}`, {
      method: 'DELETE',
    });
    expect(status).toBe(200);
    expect(await listRules(app, sessionCookie, budgetId)).toHaveLength(0);
  });
});

describe('POST /payee-rules/apply', () => {
  it('rewrites payee and category on unapproved rows a rule now matches, and leaves approved rows untouched', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('rules-apply@example.com');
    const accountId = await createAccount(app, sessionCookie, budgetId, { name: 'BECU', type: 'checking' });
    const [groceries] = await spendingCategoryIds(app, sessionCookie, budgetId);

    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/imports`, {
      method: 'POST',
      body: JSON.stringify({
        accountId,
        provider: 'becu',
        filename: 'statement.csv',
        csv: becuCsv(
          '"8/14/2026","","POS Withdrawal - 160000101207 GIANT FOOD INC #152 13 COLESVILLE   MDUS - Card Ending In 1658","-109.21",""',
          '"8/17/2026","","External Deposit - AMERICANAIRLINES DIRECT DEPOSIT - PAYROLL","","1071.48"',
        ),
      }),
    });

    const before = await review(app, sessionCookie, budgetId);
    const giantFoodRow = before.find((r) => r.importPayeeRaw?.includes('GIANT FOOD'))!;
    expect(giantFoodRow.payeeName).toBe('GIANT FOOD INC #152'); // the generic heuristic's best effort
    expect(giantFoodRow.categoryId).toBeNull(); // BECU never suggests a category

    // Approve the OTHER row first, so /apply's "leave approved rows alone" is exercised for real.
    const payrollRow = before.find((r) => r.importPayeeRaw?.includes('PAYROLL'))!;
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/imports/review`, {
      method: 'PATCH',
      body: JSON.stringify({ updates: [{ transactionId: payrollRow.id, approved: true }] }),
    });

    await createRule(app, sessionCookie, budgetId, { matchText: 'GIANT FOOD INC', payeeName: 'Giant Food', categoryId: groceries!.id });

    const { status, body } = await callJson<{ updated: number }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/payee-rules/apply`, {
      method: 'POST',
    });
    expect(status).toBe(200);
    expect(body.updated).toBe(1); // only the still-unapproved row a rule now matches

    const after = await review(app, sessionCookie, budgetId);
    expect(after).toHaveLength(1); // the approved payroll row left the queue and stays out
    expect(after[0]?.payeeName).toBe('Giant Food');
    expect(after[0]?.categoryId).toBe(groceries!.id);
  });

  it('leaves the category alone when the matching rule sets only a payee', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('rules-apply-payee-only@example.com');
    const accountId = await createAccount(app, sessionCookie, budgetId, { name: 'BECU', type: 'checking' });
    const [groceries] = await spendingCategoryIds(app, sessionCookie, budgetId);

    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/imports`, {
      method: 'POST',
      body: JSON.stringify({
        accountId,
        provider: 'becu',
        filename: 'statement.csv',
        csv: becuCsv(
          '"8/14/2026","","POS Withdrawal - 160000101207 GIANT FOOD INC #152 13 COLESVILLE   MDUS - Card Ending In 1658","-109.21",""',
        ),
      }),
    });
    const [row] = await review(app, sessionCookie, budgetId);
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/imports/review`, {
      method: 'PATCH',
      body: JSON.stringify({ updates: [{ transactionId: row!.id, categoryId: groceries!.id }] }),
    });

    await createRule(app, sessionCookie, budgetId, { matchText: 'GIANT FOOD INC', payeeName: 'Giant Food' }); // no categoryId
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/payee-rules/apply`, { method: 'POST' });

    const [after] = await review(app, sessionCookie, budgetId);
    expect(after?.payeeName).toBe('Giant Food');
    expect(after?.categoryId).toBe(groceries!.id); // untouched, not cleared
  });
});

describe('authorization', () => {
  it('403s every payee-rules endpoint for a non-member', async () => {
    const owner = await signInNewUser('rules-owner@example.com');
    const outsider = await signInNewUser('rules-outsider@example.com');

    expect((await callJson(outsider.app, outsider.sessionCookie, `/api/v1/budgets/${owner.budgetId}/payee-rules`)).status).toBe(403);
    expect((await createRule(outsider.app, outsider.sessionCookie, owner.budgetId, { matchText: 'X', payeeName: 'Y' })).status).toBe(
      403,
    );
    expect(
      (await callJson(outsider.app, outsider.sessionCookie, `/api/v1/budgets/${owner.budgetId}/payee-rules/apply`, { method: 'POST' }))
        .status,
    ).toBe(403);
  });
});

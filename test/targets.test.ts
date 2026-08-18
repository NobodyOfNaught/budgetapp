import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { callJson, resetDb, signInNewUser } from './helpers';

beforeEach(resetDb);

interface TargetView {
  categoryId: string;
  amount: string;
  intervalUnit: 'week' | 'month' | 'year' | 'once';
  intervalCount: number;
  dueDate: string | null;
}

interface MonthView {
  month: string;
  readyToAssign: number;
  categories: Record<string, { assigned: number; activity: number; available: number }>;
  targets: Record<string, { categoryId: string; amountMinor: number; neededMinor: number; nextDueDate: string | null; status: string }>;
}

interface UpcomingOccurrence {
  categoryId: string;
  categoryName: string;
  dueDate: string;
  amountMinor: number;
  lastPaidDate: string | null;
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

describe('PUT /api/v1/budgets/:budgetId/targets/:categoryId', () => {
  it('creates a target and it shows up on the next GET', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('targets-create@example.com');
    const [rent] = await spendingCategoryIds(app, sessionCookie, budgetId);

    const { status } = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/targets/${rent!.id}`, {
      method: 'PUT',
      body: JSON.stringify({ amount: '900.00', intervalUnit: 'month', intervalCount: 1, dueDate: '2026-01-01' }),
    });
    expect(status).toBe(200);

    const { body } = await callJson<{ targets: TargetView[] }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/targets`);
    expect(body.targets).toEqual([
      { categoryId: rent!.id, amount: '900.00', intervalUnit: 'month', intervalCount: 1, dueDate: '2026-01-01' },
    ]);
  });

  it('replaces the existing target rather than creating a second row for the same category', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('targets-upsert@example.com');
    const [rent] = await spendingCategoryIds(app, sessionCookie, budgetId);

    for (const amount of ['900.00', '950.00']) {
      await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/targets/${rent!.id}`, {
        method: 'PUT',
        body: JSON.stringify({ amount, intervalUnit: 'month', intervalCount: 1, dueDate: '2026-01-01' }),
      });
    }

    const { body } = await callJson<{ targets: TargetView[] }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/targets`);
    expect(body.targets).toHaveLength(1);
    expect(body.targets[0]?.amount).toBe('950.00');
  });

  it('accepts a once target with no due date at all (open-ended build)', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('targets-openended@example.com');
    const [savings] = await spendingCategoryIds(app, sessionCookie, budgetId);

    const { status } = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/targets/${savings!.id}`, {
      method: 'PUT',
      body: JSON.stringify({ amount: '5000.00', intervalUnit: 'once' }),
    });
    expect(status).toBe(200);

    const { body } = await callJson<{ targets: TargetView[] }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/targets`);
    expect(body.targets[0]).toEqual({ categoryId: savings!.id, amount: '5000.00', intervalUnit: 'once', intervalCount: 1, dueDate: null });
  });

  it('rejects a recurring target missing intervalCount', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('targets-missing-count@example.com');
    const [rent] = await spendingCategoryIds(app, sessionCookie, budgetId);

    const { status } = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/targets/${rent!.id}`, {
      method: 'PUT',
      body: JSON.stringify({ amount: '900.00', intervalUnit: 'month' }),
    });
    expect(status).toBe(400);
  });

  it('rejects a zero or negative amount', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('targets-bad-amount@example.com');
    const [rent] = await spendingCategoryIds(app, sessionCookie, budgetId);

    for (const amount of ['0.00', '-50.00', 'lots']) {
      const { status } = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/targets/${rent!.id}`, {
        method: 'PUT',
        body: JSON.stringify({ amount, intervalUnit: 'month', intervalCount: 1 }),
      });
      expect(status).toBe(400);
    }
  });

  it('rejects a category from a different budget', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('targets-foreign@example.com');
    const { app: otherApp, sessionCookie: otherCookie, budgetId: otherBudgetId } = await signInNewUser('targets-foreign-other@example.com');
    const [foreignCategory] = await spendingCategoryIds(otherApp, otherCookie, otherBudgetId);

    const { status } = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/targets/${foreignCategory!.id}`, {
      method: 'PUT',
      body: JSON.stringify({ amount: '10.00', intervalUnit: 'month', intervalCount: 1 }),
    });
    expect(status).toBe(400);
  });

  it('rejects targeting an income-kind category', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('targets-income@example.com');
    const { body: groups } = await callJson<{ groups: { id: string }[] }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/categories`);
    const groupId = groups.groups[0]!.id;
    const incomeCategoryId = 'test-income-category';
    await env.DB.prepare(
      'insert into categories (id, budget_id, group_id, name, kind, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(incomeCategoryId, budgetId, groupId, 'Salary', 'income', Date.now(), Date.now())
      .run();

    const { status } = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/targets/${incomeCategoryId}`, {
      method: 'PUT',
      body: JSON.stringify({ amount: '10.00', intervalUnit: 'month', intervalCount: 1 }),
    });
    expect(status).toBe(400);
  });
});

describe('DELETE /api/v1/budgets/:budgetId/targets/:categoryId', () => {
  it('soft-deletes the target so it no longer appears', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('targets-delete@example.com');
    const [rent] = await spendingCategoryIds(app, sessionCookie, budgetId);
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/targets/${rent!.id}`, {
      method: 'PUT',
      body: JSON.stringify({ amount: '900.00', intervalUnit: 'month', intervalCount: 1 }),
    });

    const { status } = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/targets/${rent!.id}`, { method: 'DELETE' });
    expect(status).toBe(200);

    const { body } = await callJson<{ targets: TargetView[] }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/targets`);
    expect(body.targets).toEqual([]);
  });

  it('a deleted target can be recreated fresh (the partial unique index allows it)', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('targets-recreate@example.com');
    const [rent] = await spendingCategoryIds(app, sessionCookie, budgetId);
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/targets/${rent!.id}`, {
      method: 'PUT',
      body: JSON.stringify({ amount: '900.00', intervalUnit: 'month', intervalCount: 1 }),
    });
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/targets/${rent!.id}`, { method: 'DELETE' });

    const { status } = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/targets/${rent!.id}`, {
      method: 'PUT',
      body: JSON.stringify({ amount: '1000.00', intervalUnit: 'month', intervalCount: 1 }),
    });
    expect(status).toBe(200);

    const { body } = await callJson<{ targets: TargetView[] }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/targets`);
    expect(body.targets).toEqual([{ categoryId: rent!.id, amount: '1000.00', intervalUnit: 'month', intervalCount: 1, dueDate: null }]);
  });

  it('404s deleting a target that was never set', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('targets-delete-missing@example.com');
    const [rent] = await spendingCategoryIds(app, sessionCookie, budgetId);
    const { status } = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/targets/${rent!.id}`, { method: 'DELETE' });
    expect(status).toBe(404);
  });
});

describe('GET /api/v1/budgets/:budgetId/months/:month carries targets', () => {
  it('includes the Needed math alongside the ledger result', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('targets-month-view@example.com');
    const [rent] = await spendingCategoryIds(app, sessionCookie, budgetId);
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/targets/${rent!.id}`, {
      method: 'PUT',
      body: JSON.stringify({ amount: '900.00', intervalUnit: 'month', intervalCount: 1, dueDate: '2026-01-01' }),
    });

    const { body } = await callJson<MonthView>(app, sessionCookie, `/api/v1/budgets/${budgetId}/months/2026-03`);
    expect(body.targets[rent!.id]).toEqual({
      categoryId: rent!.id,
      amountMinor: 90000,
      neededMinor: 90000,
      nextDueDate: '2026-03-01',
      status: 'short',
    });
  });

  it('a category with no target simply has no entry in targets', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('targets-no-target@example.com');
    const { body } = await callJson<MonthView>(app, sessionCookie, `/api/v1/budgets/${budgetId}/months/2026-03`);
    expect(Object.keys(body.targets)).toEqual([]);
  });
});

describe('GET /api/v1/budgets/:budgetId/upcoming', () => {
  it('returns occurrences sorted by date, across categories, with lastPaidDate', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('targets-upcoming@example.com');
    const [rent, groceries] = await spendingCategoryIds(app, sessionCookie, budgetId);
    const accountRes = await callJson<{ account: { id: string } }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/accounts`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Checking', type: 'checking' }),
    });
    const accountId = accountRes.body.account.id;

    const today = new Date().toISOString().slice(0, 10);
    // A due date already in the recent past so its FIRST occurrence still
    // lands inside the 60-day upcoming window from today.
    const past = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);

    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/targets/${rent!.id}`, {
      method: 'PUT',
      body: JSON.stringify({ amount: '900.00', intervalUnit: 'month', intervalCount: 1, dueDate: past }),
    });
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/targets/${groceries!.id}`, {
      method: 'PUT',
      body: JSON.stringify({ amount: '50.00', intervalUnit: 'week', intervalCount: 3, dueDate: past }),
    });
    // A real payment against groceries, so lastPaidDate has something to report.
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'ordinary', accountId, date: past, amount: '-50.00', categoryId: groceries!.id }),
    });

    const { status, body } = await callJson<{ occurrences: UpcomingOccurrence[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/upcoming?days=60`,
    );
    expect(status).toBe(200);
    expect(body.occurrences.length).toBeGreaterThan(0);
    // Sorted chronologically.
    const dates = body.occurrences.map((o) => o.dueDate);
    expect([...dates].sort()).toEqual(dates);
    // Every occurrence lands within [today, today+60].
    expect(body.occurrences.every((o) => o.dueDate >= today)).toBe(true);

    const groceriesOccurrence = body.occurrences.find((o) => o.categoryId === groceries!.id);
    expect(groceriesOccurrence?.lastPaidDate).toBe(past);
    expect(groceriesOccurrence?.categoryName).toBeTruthy();
  });

  it('omits an open-ended target with no due date', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('targets-upcoming-openended@example.com');
    const [savings] = await spendingCategoryIds(app, sessionCookie, budgetId);
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/targets/${savings!.id}`, {
      method: 'PUT',
      body: JSON.stringify({ amount: '5000.00', intervalUnit: 'once' }),
    });

    const { body } = await callJson<{ occurrences: UpcomingOccurrence[] }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/upcoming`);
    expect(body.occurrences.find((o) => o.categoryId === savings!.id)).toBeUndefined();
  });

  it('rejects an out-of-range days parameter', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('targets-upcoming-badquery@example.com');
    const { status } = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/upcoming?days=9999`);
    expect(status).toBe(400);
  });
});

describe('authorization', () => {
  it('403s target reads/writes and /upcoming for a non-member', async () => {
    const { budgetId, categoryId } = await (async () => {
      const owner = await signInNewUser('targets-owner@example.com');
      const [rent] = await spendingCategoryIds(owner.app, owner.sessionCookie, owner.budgetId);
      return { budgetId: owner.budgetId, categoryId: rent!.id };
    })();
    const { app: outsiderApp, sessionCookie: outsiderCookie } = await signInNewUser('targets-outsider@example.com');

    const getTargets = await callJson(outsiderApp, outsiderCookie, `/api/v1/budgets/${budgetId}/targets`);
    expect(getTargets.status).toBe(403);

    const putTarget = await callJson(outsiderApp, outsiderCookie, `/api/v1/budgets/${budgetId}/targets/${categoryId}`, {
      method: 'PUT',
      body: JSON.stringify({ amount: '10.00', intervalUnit: 'month', intervalCount: 1 }),
    });
    expect(putTarget.status).toBe(403);

    const upcoming = await callJson(outsiderApp, outsiderCookie, `/api/v1/budgets/${budgetId}/upcoming`);
    expect(upcoming.status).toBe(403);
  });
});

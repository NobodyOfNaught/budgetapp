import { beforeEach, describe, expect, it } from 'vitest';
import { callJson, resetDb, signInNewUser } from './helpers';

beforeEach(resetDb);

describe('GET /api/v1/budgets/:budgetId/categories', () => {
  it('lists the seeded default groups and categories on a fresh budget', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('cats-seeded@example.com');
    const { body } = await callJson<{ groups: { name: string; categories: { name: string }[] }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/categories`,
    );
    expect(body.groups.length).toBeGreaterThan(0);
    expect(body.groups.some((g) => g.categories.some((c) => c.name === 'Groceries'))).toBe(true);
  });
});

describe('category groups', () => {
  it('creates, renames, and deletes an empty group', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('cats-group@example.com');
    const created = await callJson<{ group: { id: string } }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/categories/groups`,
      { method: 'POST', body: JSON.stringify({ name: 'Fun Stuff' }) },
    );
    expect(created.status).toBe(201);

    const renamed = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/categories/groups/${created.body.group.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Fun Money' }),
    });
    expect(renamed.status).toBe(200);

    const deleted = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/categories/groups/${created.body.group.id}`, {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(200);
  });

  it('refuses to delete a non-empty group', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('cats-nonempty-group@example.com');
    const { body: groups } = await callJson<{ groups: { name: string; id: string }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/categories`,
    );
    const seeded = groups.groups[0]!;
    const { status } = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/categories/groups/${seeded.id}`, {
      method: 'DELETE',
    });
    expect(status).toBe(400);
  });

  it('refuses to modify the system-managed Credit Card Payments group', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('cats-system-group@example.com');
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/accounts`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Visa', type: 'credit_card' }),
    });
    const { body: cats } = await callJson<{ groups: { id: string; isSystem: boolean }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/categories`,
    );
    const systemGroup = cats.groups.find((g) => g.isSystem)!;
    const { status } = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/categories/groups/${systemGroup.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(status).toBe(400);
  });
});

describe('categories', () => {
  it('creates, moves, hides, and deletes an ordinary category', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('cats-basic@example.com');
    const { body: groups } = await callJson<{ groups: { id: string }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/categories`,
    );
    const [groupA, groupB] = groups.groups;

    const created = await callJson<{ category: { id: string; kind: string } }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/categories`,
      { method: 'POST', body: JSON.stringify({ name: 'Hobbies', groupId: groupA!.id }) },
    );
    expect(created.status).toBe(201);
    expect(created.body.category.kind).toBe('spending'); // never user-settable — see src/routes/categories.ts

    const moved = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/categories/${created.body.category.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ groupId: groupB!.id, hidden: true }),
    });
    expect(moved.status).toBe(200);

    const deleted = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/categories/${created.body.category.id}`, {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(200);
  });

  it('refuses to edit or delete a system-managed (credit_card_payment) category directly', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('cats-system-cat@example.com');
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/accounts`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Visa', type: 'credit_card' }),
    });
    const { body: cats } = await callJson<{ groups: { categories: { id: string; kind: string }[] }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/categories`,
    );
    const paymentCat = cats.groups.flatMap((g) => g.categories).find((c) => c.kind === 'credit_card_payment')!;

    const patch = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/categories/${paymentCat.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Hijacked' }),
    });
    expect(patch.status).toBe(400);

    const del = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/categories/${paymentCat.id}`, {
      method: 'DELETE',
    });
    expect(del.status).toBe(400);
  });
});

describe('GET /api/v1/budgets/:budgetId/payees', () => {
  it('is empty on a fresh budget and filters by name after a payee exists', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('payees-basic@example.com');
    const empty = await callJson<{ payees: unknown[] }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/payees`);
    expect(empty.body.payees).toHaveLength(0);

    const {
      body: { account },
    } = await callJson<{ account: { id: string } }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/accounts`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Checking', type: 'checking' }),
    });
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'ordinary',
        accountId: account.id,
        date: '2026-01-05',
        amount: '-12.34',
        payeeName: 'Corner Store',
      }),
    });

    const found = await callJson<{ payees: { name: string }[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/payees?q=corner`,
    );
    expect(found.body.payees.map((p) => p.name)).toEqual(['Corner Store']);
  });
});

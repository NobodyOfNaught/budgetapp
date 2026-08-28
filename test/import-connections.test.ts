import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { callJson, resetDb, signInNewUser } from './helpers';

beforeEach(resetDb);

interface ConnectionSummary {
  id: string;
  provider: string;
  label: string;
  externalId: string | null;
  lastUsedAt: number | null;
  createdAt: number;
}

const TOKEN = 'wise-personal-token-do-not-leak';

async function createConnection(
  app: Awaited<ReturnType<typeof signInNewUser>>['app'],
  cookie: string,
  budgetId: string,
  credential = TOKEN,
) {
  return callJson<{ connection: ConnectionSummary }>(app, cookie, `/api/v1/budgets/${budgetId}/import-connections`, {
    method: 'POST',
    body: JSON.stringify({ provider: 'wise_json', label: 'My Wise', credential }),
  });
}

describe('import connections', () => {
  it('stores a credential and returns metadata without it', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('conn-create@example.com');
    const created = await createConnection(app, sessionCookie, budgetId);

    expect(created.status).toBe(201);
    expect(created.body.connection.label).toBe('My Wise');
    expect(created.body.connection.provider).toBe('wise_json');
    expect(JSON.stringify(created.body)).not.toContain(TOKEN);
  });

  it('never returns the credential from the list endpoint either', async () => {
    // The whole point of this table: a stored secret goes in and does not
    // come back out, including for the owner who put it there. The only
    // way to change one is to replace it.
    const { app, sessionCookie, budgetId } = await signInNewUser('conn-writeonly@example.com');
    await createConnection(app, sessionCookie, budgetId);

    const listed = await callJson<{ connections: ConnectionSummary[]; credentialsKeyConfigured: boolean }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/import-connections`,
    );
    expect(listed.status).toBe(200);
    expect(listed.body.connections).toHaveLength(1);
    expect(listed.body.credentialsKeyConfigured).toBe(true);
    expect(JSON.stringify(listed.body)).not.toContain(TOKEN);
    // Nor any field that could hold it.
    expect(Object.keys(listed.body.connections[0]!)).toEqual([
      'id',
      'provider',
      'label',
      'externalId',
      'lastUsedAt',
      'createdAt',
    ]);
  });

  it('does not store the credential in the clear', async () => {
    // Reading the row directly, because "the API does not return it" and
    // "it is not sitting in the database as plaintext" are different
    // claims and only the second one survives a database leak.
    const { app, sessionCookie, budgetId } = await signInNewUser('conn-atrest@example.com');
    await createConnection(app, sessionCookie, budgetId);

    const row = await env.DB.prepare(
      'SELECT credential_ciphertext, credential_iv FROM import_connections WHERE budget_id = ?',
    )
      .bind(budgetId)
      .first<{ credential_ciphertext: string; credential_iv: string }>();

    expect(row).not.toBeNull();
    expect(row!.credential_ciphertext).not.toContain(TOKEN);
    expect(row!.credential_ciphertext).not.toContain('wise');
    expect(row!.credential_iv.length).toBeGreaterThan(0);
  });

  it('replaces a credential without disturbing the label', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('conn-replace@example.com');
    const created = await createConnection(app, sessionCookie, budgetId);
    const id = created.body.connection.id;

    const updated = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/import-connections/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ credential: 'a-different-token' }),
    });
    expect(updated.status).toBe(200);

    const row = await env.DB.prepare('SELECT label, credential_ciphertext FROM import_connections WHERE id = ?')
      .bind(id)
      .first<{ label: string; credential_ciphertext: string }>();
    expect(row!.label).toBe('My Wise');
    expect(row!.credential_ciphertext).not.toContain('a-different-token');
  });

  it('rejects an update that changes nothing', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('conn-noop@example.com');
    const created = await createConnection(app, sessionCookie, budgetId);
    const result = await callJson<{ error: string }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/import-connections/${created.body.connection.id}`,
      { method: 'PUT', body: JSON.stringify({}) },
    );
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('nothing_to_update');
  });

  it('rejects an unknown provider rather than storing a credential nothing can use', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('conn-provider@example.com');
    const result = await callJson<{ error: string }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/import-connections`,
      { method: 'POST', body: JSON.stringify({ provider: 'not-a-bank', label: 'x', credential: 'y' }) },
    );
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('unknown_provider');
  });

  it('soft-deletes, so a removed connection stops being listed', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('conn-delete@example.com');
    const created = await createConnection(app, sessionCookie, budgetId);

    const deleted = await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/import-connections/${created.body.connection.id}`, {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(200);

    const listed = await callJson<{ connections: ConnectionSummary[] }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/import-connections`,
    );
    expect(listed.body.connections).toEqual([]);
  });

  it('will not read another budget’s connection', async () => {
    const a = await signInNewUser('conn-tenant-a@example.com');
    const b = await signInNewUser('conn-tenant-b@example.com');
    const created = await createConnection(a.app, a.sessionCookie, a.budgetId);

    const stolen = await callJson<{ error: string }>(
      b.app,
      b.sessionCookie,
      `/api/v1/budgets/${b.budgetId}/import-connections/${created.body.connection.id}`,
      { method: 'PUT', body: JSON.stringify({ label: 'mine now' }) },
    );
    expect(stolen.status).toBe(404);
  });
});

describe('POST /imports/wise/fetch credential source', () => {
  it('refuses both a token and a connectionId, rather than picking one', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('fetch-both@example.com');
    const result = await callJson<{ error: string; detail: string }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/imports/wise/fetch`,
      { method: 'POST', body: JSON.stringify({ token: 'x', connectionId: 'y' }) },
    );
    expect(result.status).toBe(400);
    expect(result.body.detail).toContain('exactly one');
  });

  it('refuses neither', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('fetch-neither@example.com');
    const result = await callJson<{ detail: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/imports/wise/fetch`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(result.status).toBe(400);
    expect(result.body.detail).toContain('exactly one');
  });

  it('reports a connectionId that does not exist as not found', async () => {
    const { app, sessionCookie, budgetId } = await signInNewUser('fetch-missing@example.com');
    const result = await callJson<{ error: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/imports/wise/fetch`, {
      method: 'POST',
      body: JSON.stringify({ connectionId: 'nope' }),
    });
    expect(result.status).toBe(404);
    expect(result.body.error).toBe('connection_not_found');
  });

  it('asks for a start date when there is nothing to infer one from', async () => {
    // A fresh budget: no Wise transactions and no cutoff, so there is no
    // honest default and the route says so instead of inventing one.
    const { app, sessionCookie, budgetId } = await signInNewUser('fetch-norange@example.com');
    const created = await createConnection(app, sessionCookie, budgetId);
    const result = await callJson<{ error: string }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/imports/wise/fetch`, {
      method: 'POST',
      body: JSON.stringify({ connectionId: created.body.connection.id }),
    });
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('no_start_date');
  });
});

describe('provider families', () => {
  it('imports an API statement into the account created for the CSV provider, rather than duplicating it', async () => {
    // 'wise' parses the web-UI CSV export and 'wise_json' the API
    // statement, but both describe the same balances. Matching accounts on
    // the exact provider string meant the first API import after a switch
    // did not recognise the existing CAD account and created a second one
    // beside it.
    const { app, sessionCookie, budgetId } = await signInNewUser('family@example.com');

    const usd = await callJson<{ account: { id: string } }>(app, sessionCookie, `/api/v1/budgets/${budgetId}/accounts`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Wise USD', type: 'checking', importProvider: 'wise' }),
    });
    await callJson(app, sessionCookie, `/api/v1/budgets/${budgetId}/accounts`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Wise CAD', type: 'checking', currencyCode: 'CAD', importProvider: 'wise', fxRate: '0.72' }),
    });

    // One CAD row, imported as wise_json against the USD account.
    const statement = JSON.stringify({
      transactions: [
        {
          type: 'DEBIT',
          date: '2026-08-14T16:36:49.421391Z',
          amount: { value: -5.62, currency: 'CAD' },
          totalFees: { value: 0.02, currency: 'CAD' },
          details: { type: 'CARD', description: 'Card transaction', merchant: { name: 'Usps Po' } },
          referenceNumber: 'CARD-4193630446',
        },
      ],
    });

    const { body } = await callJson<{ accountsCreated: string[]; imported: number }>(
      app,
      sessionCookie,
      `/api/v1/budgets/${budgetId}/imports`,
      {
        method: 'POST',
        body: JSON.stringify({
          accountId: usd.body.account.id,
          provider: 'wise_json',
          filename: 'wise.json',
          csv: statement,
        }),
      },
    );

    // The existing "Wise CAD" absorbed it; nothing new was invented.
    expect(body.accountsCreated).toEqual([]);
    expect(body.imported).toBe(1);
  });
});

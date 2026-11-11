import { beforeEach, describe, expect, it } from 'vitest';
import { call, callJson, req, resetDb, signInNewUser } from './helpers';

// The import API (migrations/0012): Claude posts statement files with a
// bearer token instead of the owner uploading them in a browser. The token
// is deliberately narrower than a session — see API_TOKEN_ROUTES in
// src/auth/middleware.ts.

beforeEach(resetDb);

// Two real rows and the real <LEDGERBAL> from the owner's Vancity Visa
// "CURRENT" QFX export (2026-09-03), trimmed to what the parser reads.
const VANCITY_QFX = `OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX>
<CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>
<CURDEF>CAD
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260823000000
<TRNAMT>-7.92
<FITID>20260823000000D573424064666235100007291335
<NAME>CLOUDFLARE
</STMTTRN>
<STMTTRN>
<TRNTYPE>FEE
<DTPOSTED>20260824000000
<TRNAMT>-25.00
<FITID>20260824000000D0000
<NAME>OVERLIMIT FEE
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>-6536.21
<DTASOF>20260903000229
</LEDGERBAL>
</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1>
</OFX>`;

async function setup(email: string) {
  const owner = await signInNewUser(email);
  const { body } = await callJson<{ secret: string; token: { id: string } }>(owner.app, owner.sessionCookie, '/api/v1/api-tokens', {
    method: 'POST',
    body: JSON.stringify({ label: 'Claude' }),
  });
  const { body: acct } = await callJson<{ account: { id: string } }>(
    owner.app,
    owner.sessionCookie,
    `/api/v1/budgets/${owner.budgetId}/accounts`,
    { method: 'POST', body: JSON.stringify({ name: 'Vancity Visa', type: 'credit_card', currencyCode: 'CAD', fxRate: '0.72' }) },
  );
  return { ...owner, secret: body.secret, tokenId: body.token.id, accountId: acct.account.id };
}

/** A request authenticated ONLY by the bearer token — no cookie. */
function withToken(app: Parameters<typeof call>[0], secret: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${secret}`);
  return call(app, req(path, { ...init, headers }));
}

describe('creating and listing tokens', () => {
  it('returns the raw token exactly once, and never lists it or its hash', async () => {
    const { app, sessionCookie, secret } = await setup('tok-create@example.com');
    expect(secret).toMatch(/^bapp_[0-9a-f]{64}$/);

    const { body } = await callJson<{ tokens: Record<string, unknown>[] }>(app, sessionCookie, '/api/v1/api-tokens');
    expect(body.tokens).toHaveLength(1);
    expect(Object.keys(body.tokens[0]!).sort()).toEqual(['createdAt', 'id', 'label', 'lastUsedAt']);
    expect(JSON.stringify(body)).not.toContain(secret.slice(5));
  });
});

describe('what a token can do', () => {
  it('imports a statement end to end: find the budget, find the account, import', async () => {
    const { app, secret, budgetId, accountId } = await setup('tok-import@example.com');

    const budgets = await withToken(app, secret, '/api/v1/budgets');
    expect(budgets.status).toBe(200);
    const accounts = await (await withToken(app, secret, `/api/v1/budgets/${budgetId}/accounts`)).json<{
      accounts: { id: string; name: string }[];
    }>();
    expect(accounts.accounts.map((a) => a.name)).toContain('Vancity Visa');

    const res = await withToken(app, secret, `/api/v1/budgets/${budgetId}/imports`, {
      method: 'POST',
      body: JSON.stringify({ accountId, provider: 'ofx', filename: 'transactions_CURRENT.qfx', csv: VANCITY_QFX }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ imported: number; reconciliation: { statementBalanceMinor: number } | null }>();
    expect(body.imported).toBe(2);
    // The balance check rides along, so a token import is checked exactly
    // like a browser one.
    expect(body.reconciliation?.statementBalanceMinor).toBe(-653621);
  });

  it('records when a token was last used', async () => {
    const { app, sessionCookie, secret } = await setup('tok-used@example.com');
    await withToken(app, secret, '/api/v1/budgets');
    const { body } = await callJson<{ tokens: { lastUsedAt: number | null }[] }>(app, sessionCookie, '/api/v1/api-tokens');
    expect(body.tokens[0]!.lastUsedAt).toEqual(expect.any(Number));
  });
});

describe('what a token can NOT do', () => {
  it('cannot edit, delete or browse beyond the import allowlist', async () => {
    const { app, secret, budgetId, accountId } = await setup('tok-scope@example.com');
    const refused: [string, string, unknown?][] = [
      ['PATCH', `/api/v1/budgets/${budgetId}/accounts/${accountId}`, { name: 'renamed' }],
      ['GET', `/api/v1/budgets/${budgetId}/transactions`],
      ['POST', `/api/v1/budgets/${budgetId}/transactions`, {}],
      ['GET', `/api/v1/budgets/${budgetId}/imports/review`],
      ['POST', `/api/v1/budgets/${budgetId}/import-connections`, {}],
    ];
    for (const [method, path, body] of refused) {
      const res = await withToken(app, secret, path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  it('cannot reach token management or /auth — those are session-only', async () => {
    const { app, secret } = await setup('tok-mgmt@example.com');
    for (const [method, path] of [
      ['GET', '/api/v1/api-tokens'],
      ['POST', '/api/v1/api-tokens'],
      ['GET', '/api/v1/auth/me'],
    ] as const) {
      const res = await withToken(app, secret, path, { method, ...(method === 'POST' ? { body: '{"label":"x"}' } : {}) });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it("cannot reach another user's budget — membership still applies", async () => {
    const a = await setup('tok-a@example.com');
    const b = await setup('tok-b@example.com');
    const res = await withToken(a.app, a.secret, `/api/v1/budgets/${b.budgetId}/imports`, {
      method: 'POST',
      body: JSON.stringify({ accountId: b.accountId, provider: 'ofx', filename: 'x.qfx', csv: VANCITY_QFX }),
    });
    expect(res.status).toBe(403);
  });

  it('stops working the moment it is revoked', async () => {
    const { app, sessionCookie, secret, tokenId } = await setup('tok-revoke@example.com');
    expect((await withToken(app, secret, '/api/v1/budgets')).status).toBe(200);
    const { status } = await callJson(app, sessionCookie, `/api/v1/api-tokens/${tokenId}`, { method: 'DELETE' });
    expect(status).toBe(200);
    expect((await withToken(app, secret, '/api/v1/budgets')).status).toBe(401);
  });

  it('is judged alone: a bad token is 401 even with a valid session cookie attached', async () => {
    // No silent fallback to the cookie — a client that believes it is
    // using a token must find out when it isn't.
    const { app, sessionCookie } = await setup('tok-nofallback@example.com');
    const headers = new Headers({ Authorization: 'Bearer bapp_not-a-real-token' });
    const res = await call(app, req('/api/v1/budgets', { headers, cookie: `__Host-session=${sessionCookie}` }));
    expect(res.status).toBe(401);
  });

  it('still needs a same-origin Origin header on a POST (CSRF unchanged)', async () => {
    const { app, secret, budgetId, accountId } = await setup('tok-csrf@example.com');
    const res = await call(
      app,
      new Request(`http://example.com/api/v1/budgets/${budgetId}/imports`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId, provider: 'ofx', filename: 'x.qfx', csv: VANCITY_QFX }),
      }),
    );
    expect(res.status).toBe(403);
  });
});

import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireBudgetMember } from '../auth/middleware';
import { getDb, type Db } from '../db/client';
import { importConnections } from '../db/schema';
import { IMPORT_PROVIDERS, isImportProvider } from '../import';
import { decryptSecret, encryptSecret } from '../lib/crypto';
import { ulid } from '../lib/ids';
import { budgetIdParam } from '../lib/params';
import type { AppEnv } from '../types/hono';

/**
 * Stored provider credentials, scoped to a budget.
 *
 * The rule this whole file exists to enforce: a stored credential goes IN
 * and never comes back OUT. No response here contains a decrypted secret,
 * including for the owner who stored it — the only way to change one is to
 * replace it. `loadConnectionSecret` is the single decrypt path, and it is
 * used by the import routes to talk to the provider, never to answer a
 * request.
 *
 * See migrations/0010 for why these are rows rather than Worker secrets,
 * and src/lib/crypto.ts for the envelope scheme.
 */

/** Everything a client is ever told about a connection. Deliberately no ciphertext, no IV, no token. */
interface ConnectionSummary {
  id: string;
  provider: string;
  label: string;
  externalId: string | null;
  lastUsedAt: number | null;
  createdAt: number;
}

const createSchema = z.object({
  provider: z.string().min(1),
  label: z.string().trim().min(1).max(100),
  /** Write-only. Never echoed back by any endpoint. */
  credential: z.string().min(1).max(4000),
});

const updateSchema = z.object({
  label: z.string().trim().min(1).max(100).optional(),
  /** Omitted leaves the stored credential alone; supplied replaces it. */
  credential: z.string().min(1).max(4000).optional(),
});

function missingKey() {
  return {
    error: 'credentials_key_missing',
    detail:
      'CREDENTIALS_KEY is not set in this environment, so credentials cannot be encrypted. Set it with `wrangler secret put CREDENTIALS_KEY`.',
  } as const;
}

/**
 * Decrypts one connection's credential for use against a provider.
 *
 * Lives here rather than in the import routes so that every decrypt goes
 * through the same place, and so the "never returned to a client" rule has
 * one file to be true in. A decrypt failure means the stored bytes no
 * longer match the key (rotated CREDENTIALS_KEY, or a row copied between
 * environments) — reported as a connection that needs re-entering, never
 * retried.
 */
export async function loadConnectionSecret(
  db: Db,
  env: AppEnv['Bindings'],
  budgetId: string,
  connectionId: string,
): Promise<{ credential: string; externalId: string | null } | { error: 'not_found' | 'no_key' | 'undecryptable' }> {
  if (!env.CREDENTIALS_KEY) return { error: 'no_key' };

  const [row] = await db
    .select()
    .from(importConnections)
    .where(
      and(
        eq(importConnections.id, connectionId),
        eq(importConnections.budgetId, budgetId),
        isNull(importConnections.deletedAt),
      ),
    )
    .limit(1);
  if (!row) return { error: 'not_found' };

  try {
    const credential = await decryptSecret(env.CREDENTIALS_KEY, {
      ciphertext: row.credentialCiphertext,
      iv: row.credentialIv,
    });
    return { credential, externalId: row.externalId };
  } catch {
    return { error: 'undecryptable' };
  }
}

/** Records that a connection was actually used, so a stale one is visible rather than silently rotting. */
export async function markConnectionUsed(db: Db, connectionId: string, now: number): Promise<void> {
  await db
    .update(importConnections)
    .set({ lastUsedAt: now, updatedAt: now })
    .where(eq(importConnections.id, connectionId));
}

export const importConnectionsRoute = new Hono<AppEnv>();

// Listing is metadata only, so a viewer may see THAT a connection exists
// without being able to use or read it. Everything that writes requires
// owner: storing a credential for an external financial service is not a
// shared editor's call.
importConnectionsRoute.use('*', requireBudgetMember('viewer'));

importConnectionsRoute.get('/', async (c) => {
  const db = getDb(c.env);
  const rows = await db
    .select({
      id: importConnections.id,
      provider: importConnections.provider,
      label: importConnections.label,
      externalId: importConnections.externalId,
      lastUsedAt: importConnections.lastUsedAt,
      createdAt: importConnections.createdAt,
    })
    .from(importConnections)
    .where(and(eq(importConnections.budgetId, budgetIdParam(c)), isNull(importConnections.deletedAt)));

  const connections: ConnectionSummary[] = rows;
  // Reported so the UI can explain "connections exist but cannot be used"
  // rather than failing at fetch time with something cryptic.
  return c.json({ connections, credentialsKeyConfigured: !!c.env.CREDENTIALS_KEY });
});

importConnectionsRoute.post('/', requireBudgetMember('owner'), async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const { provider, label, credential } = parsed.data;

  if (!isImportProvider(provider)) {
    return c.json({ error: 'unknown_provider', providers: IMPORT_PROVIDERS }, 400);
  }
  if (!c.env.CREDENTIALS_KEY) return c.json(missingKey(), 503);

  const now = Date.now();
  const id = ulid(now);
  const sealed = await encryptSecret(c.env.CREDENTIALS_KEY, credential);
  await getDb(c.env)
    .insert(importConnections)
    .values({
      id,
      budgetId: budgetIdParam(c),
      provider,
      label,
      credentialCiphertext: sealed.ciphertext,
      credentialIv: sealed.iv,
      createdByUserId: c.get('user').id,
      createdAt: now,
      updatedAt: now,
    });

  return c.json({ connection: { id, provider, label, externalId: null, lastUsedAt: null, createdAt: now } }, 201);
});

importConnectionsRoute.put('/:connectionId', requireBudgetMember('owner'), async (c) => {
  const parsed = updateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const { label, credential } = parsed.data;
  if (label === undefined && credential === undefined) {
    return c.json({ error: 'nothing_to_update' }, 400);
  }
  if (credential !== undefined && !c.env.CREDENTIALS_KEY) return c.json(missingKey(), 503);

  const db = getDb(c.env);
  const budgetId = budgetIdParam(c);
  const connectionId = c.req.param('connectionId');
  const [existing] = await db
    .select({ id: importConnections.id })
    .from(importConnections)
    .where(
      and(
        eq(importConnections.id, connectionId),
        eq(importConnections.budgetId, budgetId),
        isNull(importConnections.deletedAt),
      ),
    )
    .limit(1);
  if (!existing) return c.json({ error: 'not_found' }, 404);

  const now = Date.now();
  const changes: Record<string, unknown> = { updatedAt: now };
  if (label !== undefined) changes.label = label;
  if (credential !== undefined && c.env.CREDENTIALS_KEY) {
    const sealed = await encryptSecret(c.env.CREDENTIALS_KEY, credential);
    changes.credentialCiphertext = sealed.ciphertext;
    changes.credentialIv = sealed.iv;
    // A replaced credential may belong to a different provider account, so
    // the cached external id is no longer known to be right.
    changes.externalId = null;
  }
  await db.update(importConnections).set(changes).where(eq(importConnections.id, connectionId));

  return c.json({ status: 'ok' });
});

importConnectionsRoute.delete('/:connectionId', requireBudgetMember('owner'), async (c) => {
  const db = getDb(c.env);
  const now = Date.now();
  const budgetId = budgetIdParam(c);
  const connectionId = c.req.param('connectionId');

  const [existing] = await db
    .select({ id: importConnections.id })
    .from(importConnections)
    .where(
      and(
        eq(importConnections.id, connectionId),
        eq(importConnections.budgetId, budgetId),
        isNull(importConnections.deletedAt),
      ),
    )
    .limit(1);
  if (!existing) return c.json({ error: 'not_found' }, 404);

  await db
    .update(importConnections)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(importConnections.id, connectionId));
  return c.json({ status: 'ok' });
});

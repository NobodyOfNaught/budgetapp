import { and, desc, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware';
import { getDb } from '../db/client';
import { apiTokens } from '../db/schema';
import { randomHex, sha256Hex } from '../lib/crypto';
import { ulid } from '../lib/ids';
import type { AppEnv } from '../types/hono';

/**
 * Create, list and revoke API tokens (migrations/0012).
 *
 * Session-only — plain `requireAuth`, NOT requireAuthOrApiToken — so a
 * token can never be used to mint another token or to see which ones
 * exist. Managing credentials is something only the person at the browser
 * does.
 *
 * The raw token appears in exactly one response, the one that creates it.
 * Only its SHA-256 is stored, so it cannot be shown again: a lost token is
 * revoked and replaced, never recovered.
 */
export const apiTokensRoute = new Hono<AppEnv>();
apiTokensRoute.use('*', requireAuth);

/** Recognisable in logs and secret scanners; the 64 hex chars after it are 256 random bits. */
const TOKEN_PREFIX = 'bapp_';

const createSchema = z.object({ label: z.string().trim().min(1).max(100) });

apiTokensRoute.get('/', async (c) => {
  const rows = await getDb(c.env)
    .select({
      id: apiTokens.id,
      label: apiTokens.label,
      lastUsedAt: apiTokens.lastUsedAt,
      createdAt: apiTokens.createdAt,
    })
    .from(apiTokens)
    .where(and(eq(apiTokens.userId, c.get('user').id), isNull(apiTokens.revokedAt)))
    .orderBy(desc(apiTokens.createdAt));
  return c.json({ tokens: rows });
});

apiTokensRoute.post('/', async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);

  const now = Date.now();
  const id = ulid(now);
  const token = `${TOKEN_PREFIX}${randomHex(32)}`;
  await getDb(c.env)
    .insert(apiTokens)
    .values({ id, userId: c.get('user').id, label: parsed.data.label, tokenHash: await sha256Hex(token), createdAt: now });

  return c.json({ token: { id, label: parsed.data.label, lastUsedAt: null, createdAt: now }, secret: token }, 201);
});

apiTokensRoute.delete('/:tokenId', async (c) => {
  const db = getDb(c.env);
  const now = Date.now();
  const result = await db
    .update(apiTokens)
    .set({ revokedAt: now })
    .where(
      and(eq(apiTokens.id, c.req.param('tokenId')), eq(apiTokens.userId, c.get('user').id), isNull(apiTokens.revokedAt)),
    )
    .returning({ id: apiTokens.id });
  if (result.length === 0) return c.json({ error: 'not_found' }, 404);
  return c.json({ status: 'ok' });
});

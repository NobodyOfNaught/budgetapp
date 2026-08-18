import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { authTokens } from '../db/schema';
import { randomHex, sha256Hex } from '../lib/crypto';
import { ulid } from '../lib/ids';

const TOKEN_EXPIRY_MS = 15 * 60 * 1000;

export interface IssuedMagicLink {
  token: string;
  challenge: string;
  expiresAt: number;
}

/**
 * Creates a magic-link token row. Only its hash is stored (see
 * src/lib/crypto.ts) — the raw `token` goes in the emailed link and the raw
 * `challenge` goes in a short-lived cookie set alongside it, so possession
 * of either secret proves nothing was read out of the database.
 */
export async function createMagicLinkToken(
  db: Db,
  params: { emailNormalized: string; ip: string | undefined; ua: string | undefined },
): Promise<IssuedMagicLink> {
  const token = randomHex(32);
  const challenge = randomHex(32);
  const now = Date.now();
  const expiresAt = now + TOKEN_EXPIRY_MS;

  await db.insert(authTokens).values({
    id: ulid(now),
    emailNormalized: params.emailNormalized,
    tokenHash: await sha256Hex(token),
    purpose: 'magic_link',
    challengeHash: await sha256Hex(challenge),
    expiresAt,
    createdIp: params.ip,
    createdUa: params.ua,
    createdAt: now,
  });

  return { token, challenge, expiresAt };
}

export type ConsumeOutcome =
  | { status: 'invalid' }
  | { status: 'expired' }
  | { status: 'needs_confirmation' }
  | { status: 'claimed'; emailNormalized: string };

/**
 * Validates and, if appropriate, atomically claims a magic-link token.
 * Doesn't touch users/sessions itself — see src/routes/auth.ts, which signs
 * the user in only after this returns `claimed`.
 *
 * `needs_confirmation` (challenge cookie missing or from a different
 * browser/device than the one that requested the link) leaves the token
 * UNCLAIMED so the client's "Confirm sign-in" button can retry with
 * `confirm: true` — proof of possessing the emailed token is itself
 * sufficient to sign in; the challenge cookie only decides whether that
 * extra click is needed.
 */
export async function consumeMagicLinkToken(
  db: Db,
  params: { token: string; cookieChallenge: string | undefined; confirm: boolean },
): Promise<ConsumeOutcome> {
  const tokenHash = await sha256Hex(params.token);
  const [row] = await db
    .select()
    .from(authTokens)
    .where(eq(authTokens.tokenHash, tokenHash))
    .limit(1);

  if (!row || row.purpose !== 'magic_link' || row.consumedAt !== null) {
    return { status: 'invalid' };
  }
  if (row.expiresAt <= Date.now()) {
    return { status: 'expired' };
  }

  const challengeMatches =
    params.cookieChallenge !== undefined &&
    (await sha256Hex(params.cookieChallenge)) === row.challengeHash;

  if (!challengeMatches && !params.confirm) {
    return { status: 'needs_confirmation' };
  }

  // Claim atomically: the WHERE clause only matches if still unconsumed at
  // the moment of the write, so a double-submit (double click, React
  // StrictMode, a retried request) can't sign in twice from one token.
  const result = await db
    .update(authTokens)
    .set({ consumedAt: Date.now() })
    .where(and(eq(authTokens.id, row.id), isNull(authTokens.consumedAt)))
    .run();

  if (result.meta.changes === 0) {
    return { status: 'invalid' }; // lost the race to claim it
  }

  return { status: 'claimed', emailNormalized: row.emailNormalized };
}

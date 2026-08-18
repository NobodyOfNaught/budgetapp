import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { sessions } from '../db/schema';
import { randomHex } from '../lib/crypto';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// Extending expiresAt on every single request would mean a D1 write per
// request for every signed-in user. Only re-extend once the session hasn't
// been touched in a day; still a sliding 30-day window, far fewer writes.
const TOUCH_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Sessions are opaque random tokens stored in D1 — the id IS the secret
 * (256 bits), looked up by exact primary-key match. Not a JWT: revoking one
 * is a single UPDATE, which matters once budgets are shared and a member
 * needs to be kicked out immediately rather than waiting for a token to
 * expire on its own.
 */
export async function createSession(
  db: Db,
  params: { userId: string; ip: string | undefined; ua: string | undefined },
): Promise<{ id: string; expiresAt: number }> {
  const id = randomHex(32);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;

  await db.insert(sessions).values({
    id,
    userId: params.userId,
    expiresAt,
    lastSeenAt: now,
    userAgent: params.ua,
    ip: params.ip,
    createdAt: now,
  });

  return { id, expiresAt };
}

export type Session = typeof sessions.$inferSelect;

export async function getActiveSession(db: Db, sessionId: string): Promise<Session | undefined> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt), gt(sessions.expiresAt, Date.now())))
    .limit(1);
  return row;
}

/** Sliding-window refresh, throttled — see TOUCH_INTERVAL_MS above. */
export async function touchSession(db: Db, session: Session): Promise<void> {
  const now = Date.now();
  if (now - session.lastSeenAt < TOUCH_INTERVAL_MS) return;
  await db
    .update(sessions)
    .set({ lastSeenAt: now, expiresAt: now + SESSION_TTL_MS })
    .where(eq(sessions.id, session.id));
}

export async function revokeSession(db: Db, sessionId: string): Promise<void> {
  await db.update(sessions).set({ revokedAt: Date.now() }).where(eq(sessions.id, sessionId));
}

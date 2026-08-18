import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { payees } from '../db/schema';
import { ulid } from '../lib/ids';

/**
 * Finds an existing payee by exact name, or creates one — the "payee with
 * autocomplete" flow from docs/plan.md's MVP scope: the register form just
 * sends whatever name the user typed, and gets a payeeId back either way.
 * Matching is case-sensitive exact-string (no COLLATE NOCASE, no fuzzy
 * matching) — fine for the MVP; real matching/learning is phase-4 import
 * work (payee_rules in the roadmap), not needed for manual entry.
 */
export async function getOrCreatePayee(db: Db, budgetId: string, name: string, now: number): Promise<string> {
  const trimmed = name.trim();
  const [existing] = await db
    .select({ id: payees.id })
    .from(payees)
    .where(and(eq(payees.budgetId, budgetId), eq(payees.name, trimmed), isNull(payees.deletedAt)))
    .limit(1);
  if (existing) return existing.id;

  const id = ulid(now);
  await db.insert(payees).values({ id, budgetId, name: trimmed, createdAt: now, updatedAt: now });
  return id;
}

/**
 * The payee a transfer leg shows — "Transfer : <other account>" — linked
 * via payees.transferAccountId so the UI can offer transfers through the
 * same payee picker as ordinary payees (see docs/plan.md's schema notes).
 * One such payee per (budget, other account) pair, reused by both legs.
 */
export async function getOrCreateTransferPayee(
  db: Db,
  budgetId: string,
  otherAccountId: string,
  otherAccountName: string,
  now: number,
): Promise<string> {
  const [existing] = await db
    .select({ id: payees.id })
    .from(payees)
    .where(and(eq(payees.budgetId, budgetId), eq(payees.transferAccountId, otherAccountId), isNull(payees.deletedAt)))
    .limit(1);
  if (existing) return existing.id;

  const id = ulid(now);
  await db.insert(payees).values({
    id,
    budgetId,
    name: `Transfer : ${otherAccountName}`,
    transferAccountId: otherAccountId,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

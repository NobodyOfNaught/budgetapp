import { eq } from 'drizzle-orm';
import { seedDefaultCategories } from '../budget/seed';
import type { Db } from '../db/client';
import { budgetMembers, budgets, users } from '../db/schema';
import { ulid } from '../lib/ids';

export type User = typeof users.$inferSelect;

/**
 * Finds or creates the user for a just-verified email, then makes sure they
 * land in at least one budget — auto-creating one on first sign-in, per the
 * plan's MVP scope. Every authorization check downstream reads
 * budget_members, so "auto-created" here is genuinely just "insert a row",
 * not a special case sharing later has to unwind.
 */
export async function signInUser(db: Db, emailNormalized: string): Promise<{ user: User; budgetId: string }> {
  const now = Date.now();
  const user = await findOrCreateUser(db, emailNormalized, now);
  const budgetId = await ensureDefaultBudget(db, user.id, now);
  return { user, budgetId };
}

async function findOrCreateUser(db: Db, emailNormalized: string, now: number): Promise<User> {
  const [existing] = await db.select().from(users).where(eq(users.emailNormalized, emailNormalized)).limit(1);
  if (existing) {
    await db.update(users).set({ lastLoginAt: now }).where(eq(users.id, existing.id));
    return { ...existing, lastLoginAt: now };
  }

  const created: User = {
    id: ulid(now),
    email: emailNormalized, // we only ever see the normalized form once the
    emailNormalized, // token round-trips — see docs/plan.md's auth section.
    displayName: null,
    createdAt: now,
    lastLoginAt: now,
  };

  try {
    await db.insert(users).values(created);
    return created;
  } catch {
    // Lost a race against a concurrent first sign-in for the same brand-new
    // email (e.g. the link opened on two devices at once) — the unique
    // index on emailNormalized rejected our insert. Whoever won is the
    // user; read them back rather than erroring.
    const [row] = await db.select().from(users).where(eq(users.emailNormalized, emailNormalized)).limit(1);
    if (!row) throw new Error('user insert failed and no row could be read back');
    return row;
  }
}

async function ensureDefaultBudget(db: Db, userId: string, now: number): Promise<string> {
  const [membership] = await db
    .select({ budgetId: budgetMembers.budgetId })
    .from(budgetMembers)
    .where(eq(budgetMembers.userId, userId))
    .limit(1);
  if (membership) return membership.budgetId;

  // Narrow, accepted race: a user confirming two separate never-before-used
  // magic links at the same instant could each pass the check above and
  // create two budgets. Requires two outstanding tokens for the same user
  // confirmed concurrently — rare enough not to guard against for the MVP.
  const budgetId = ulid(now);
  await db.insert(budgets).values({
    id: budgetId,
    name: 'My Budget',
    currencyCode: 'USD',
    createdAt: now,
    revision: 0,
  });
  await db.insert(budgetMembers).values({ budgetId, userId, role: 'owner', createdAt: now });
  await seedDefaultCategories(db, budgetId, now);
  return budgetId;
}

import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { categories, categoryGroups } from '../db/schema';
import { ulid } from '../lib/ids';

const SYSTEM_GROUP_NAME = 'Credit Card Payments';

/**
 * Finds or creates the payment category for a credit account — "auto-
 * created and auto-managed" per docs/plan.md's MVP scope. Lives in a
 * lazily-created isSystem category group shared by every credit account in
 * the budget, so nothing shows up until the user actually has a card.
 * Called from POST /accounts whenever a credit_card or line_of_credit
 * account is created.
 */
export async function ensurePaymentCategory(
  db: Db,
  params: { budgetId: string; accountId: string; accountName: string },
  now: number,
): Promise<string> {
  const [existing] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.linkedAccountId, params.accountId), isNull(categories.deletedAt)))
    .limit(1);
  if (existing) return existing.id;

  const groupId = await ensureSystemGroup(db, params.budgetId, now);

  const categoryId = ulid(now);
  await db.insert(categories).values({
    id: categoryId,
    budgetId: params.budgetId,
    groupId,
    name: params.accountName,
    kind: 'credit_card_payment',
    linkedAccountId: params.accountId,
    createdAt: now,
    updatedAt: now,
  });
  return categoryId;
}

async function ensureSystemGroup(db: Db, budgetId: string, now: number): Promise<string> {
  const [existing] = await db
    .select({ id: categoryGroups.id })
    .from(categoryGroups)
    .where(
      and(eq(categoryGroups.budgetId, budgetId), eq(categoryGroups.isSystem, true), isNull(categoryGroups.deletedAt)),
    )
    .limit(1);
  if (existing) return existing.id;

  const groupId = ulid(now);
  await db.insert(categoryGroups).values({
    id: groupId,
    budgetId,
    name: SYSTEM_GROUP_NAME,
    isSystem: true,
    sortOrder: -1, // pinned above the user's own groups
    createdAt: now,
    updatedAt: now,
  });
  return groupId;
}

/** Keeps a payment category's display name in sync with its account — "auto-managed". Called on account rename. */
export async function renamePaymentCategory(db: Db, accountId: string, newAccountName: string, now: number): Promise<void> {
  await db
    .update(categories)
    .set({ name: newAccountName, updatedAt: now })
    .where(and(eq(categories.linkedAccountId, accountId), isNull(categories.deletedAt)));
}

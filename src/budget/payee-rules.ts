import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { categories, payeeRules } from '../db/schema';
import type { PayeeRule } from '../import/rules';

/**
 * Loads a budget's live payee_rules, oldest-created-first — matchPayeeRule
 * (src/import/rules.ts) relies on that order to break a length tie in
 * favor of the older rule. A rule pointing at a category that's since been
 * deleted has its categoryId dropped here rather than left dangling, the
 * same guard a provider's own category suggestion already gets in
 * src/routes/imports.ts's findCategoryIdByName.
 *
 * Shared by src/routes/imports.ts (applied to every row at import time) and
 * src/routes/payee-rules.ts (re-applied to the review queue on demand) —
 * one loader, so the two can never disagree about which rules are live.
 */
export async function loadActivePayeeRules(db: Db, budgetId: string): Promise<PayeeRule[]> {
  const rows = await db
    .select({
      id: payeeRules.id,
      matchText: payeeRules.matchText,
      payeeName: payeeRules.payeeName,
      categoryId: payeeRules.categoryId,
      ruleCategoryDeletedAt: categories.deletedAt,
    })
    .from(payeeRules)
    .leftJoin(categories, eq(categories.id, payeeRules.categoryId))
    .where(and(eq(payeeRules.budgetId, budgetId), isNull(payeeRules.deletedAt)))
    .orderBy(asc(payeeRules.createdAt));

  return rows.map((r) => ({
    id: r.id,
    matchText: r.matchText,
    payeeName: r.payeeName,
    categoryId: r.categoryId !== null && r.ruleCategoryDeletedAt === null ? r.categoryId : null,
  }));
}

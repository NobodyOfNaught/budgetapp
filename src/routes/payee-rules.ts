import { and, desc, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireBudgetMember } from '../auth/middleware';
import { loadActivePayeeRules } from '../budget/payee-rules';
import { getOrCreatePayee } from '../budget/payees';
import { getDb, type Db } from '../db/client';
import { categories, payeeRules, transactions } from '../db/schema';
import { matchPayeeRule } from '../import/rules';
import { ulid } from '../lib/ids';
import { budgetIdParam } from '../lib/params';
import type { AppEnv } from '../types/hono';

const upsertSchema = z.object({
  matchText: z.string().trim().min(1).max(200),
  payeeName: z.string().trim().min(1).max(200),
  categoryId: z.string().min(1).nullable().optional(),
});

async function categoryExists(db: Db, budgetId: string, categoryId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.id, categoryId), eq(categories.budgetId, budgetId), isNull(categories.deletedAt)))
    .limit(1);
  return !!row;
}

function toRuleView(row: typeof payeeRules.$inferSelect) {
  return { id: row.id, matchText: row.matchText, payeeName: row.payeeName, categoryId: row.categoryId };
}

export const payeeRulesRoute = new Hono<AppEnv>();
payeeRulesRoute.use('*', requireBudgetMember('viewer'));

payeeRulesRoute.get('/', async (c) => {
  const budgetId = budgetIdParam(c);
  const db = getDb(c.env);
  const rows = await db
    .select()
    .from(payeeRules)
    .where(and(eq(payeeRules.budgetId, budgetId), isNull(payeeRules.deletedAt)))
    .orderBy(desc(payeeRules.createdAt));
  return c.json({ rules: rows.map(toRuleView) });
});

payeeRulesRoute.post('/', requireBudgetMember('editor'), async (c) => {
  const budgetId = budgetIdParam(c);
  const parsed = upsertSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const input = parsed.data;

  const db = getDb(c.env);
  if (input.categoryId && !(await categoryExists(db, budgetId, input.categoryId))) {
    return c.json({ error: 'invalid_category' }, 400);
  }

  const now = Date.now();
  const id = ulid(now);
  await db.insert(payeeRules).values({
    id,
    budgetId,
    matchText: input.matchText,
    payeeName: input.payeeName,
    categoryId: input.categoryId ?? null,
    createdAt: now,
    updatedAt: now,
  });

  return c.json({ rule: { id, matchText: input.matchText, payeeName: input.payeeName, categoryId: input.categoryId ?? null } }, 201);
});

payeeRulesRoute.patch('/:ruleId', requireBudgetMember('editor'), async (c) => {
  const budgetId = budgetIdParam(c);
  const ruleId = c.req.param('ruleId');
  const parsed = upsertSchema.partial().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const input = parsed.data;

  const db = getDb(c.env);
  const [existing] = await db
    .select({ id: payeeRules.id })
    .from(payeeRules)
    .where(and(eq(payeeRules.id, ruleId), eq(payeeRules.budgetId, budgetId), isNull(payeeRules.deletedAt)))
    .limit(1);
  if (!existing) return c.json({ error: 'not_found' }, 404);

  if (input.categoryId !== undefined && input.categoryId !== null && !(await categoryExists(db, budgetId, input.categoryId))) {
    return c.json({ error: 'invalid_category' }, 400);
  }

  const now = Date.now();
  const patch: { updatedAt: number; matchText?: string; payeeName?: string; categoryId?: string | null } = { updatedAt: now };
  if (input.matchText !== undefined) patch.matchText = input.matchText;
  if (input.payeeName !== undefined) patch.payeeName = input.payeeName;
  if (input.categoryId !== undefined) patch.categoryId = input.categoryId;
  await db.update(payeeRules).set(patch).where(eq(payeeRules.id, ruleId));

  return c.json({ status: 'ok' });
});

payeeRulesRoute.delete('/:ruleId', requireBudgetMember('editor'), async (c) => {
  const budgetId = budgetIdParam(c);
  const ruleId = c.req.param('ruleId');
  const db = getDb(c.env);

  const [existing] = await db
    .select({ id: payeeRules.id })
    .from(payeeRules)
    .where(and(eq(payeeRules.id, ruleId), eq(payeeRules.budgetId, budgetId), isNull(payeeRules.deletedAt)))
    .limit(1);
  if (!existing) return c.json({ error: 'not_found' }, 404);

  await db.update(payeeRules).set({ deletedAt: Date.now() }).where(eq(payeeRules.id, ruleId));
  return c.json({ status: 'ok' });
});

/**
 * Re-runs the budget's live rules over whatever's still sitting in the
 * review queue — the workflow this exists for is "import, notice the mess,
 * write a rule, want it applied to what I'm already looking at" without
 * deleting the batch and re-importing. Only UNAPPROVED rows are touched —
 * an approved row is something a human already confirmed, and a rule must
 * not silently redo that. A row a rule does NOT match is left exactly as
 * it was; this only fixes what a new or edited rule now covers.
 */
payeeRulesRoute.post('/apply', requireBudgetMember('editor'), async (c) => {
  const budgetId = budgetIdParam(c);
  const db = getDb(c.env);

  const rules = await loadActivePayeeRules(db, budgetId);
  const rows = await db
    .select({ id: transactions.id, importPayeeRaw: transactions.importPayeeRaw })
    .from(transactions)
    .where(
      and(
        eq(transactions.budgetId, budgetId),
        eq(transactions.approved, false),
        isNull(transactions.deletedAt),
        isNull(transactions.parentTransactionId),
      ),
    );

  const now = Date.now();
  let updated = 0;
  for (const row of rows) {
    if (!row.importPayeeRaw) continue;
    const match = matchPayeeRule(rules, row.importPayeeRaw);
    if (!match) continue;

    const payeeId = await getOrCreatePayee(db, budgetId, match.payeeName, now);
    const patch: { updatedAt: number; payeeId: string; categoryId?: string | null } = { updatedAt: now, payeeId };
    // A payee-only rule (no categoryId) leaves whatever category is
    // already set alone — it must not blow away a category the provider
    // suggested or the user already picked in review.
    if (match.categoryId !== null) patch.categoryId = match.categoryId;
    await db.update(transactions).set(patch).where(eq(transactions.id, row.id));
    updated++;
  }

  return c.json({ status: 'ok', updated });
});

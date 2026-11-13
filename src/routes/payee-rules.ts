import { and, desc, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireBudgetMember } from '../auth/middleware';
import { loadActivePayeeRules } from '../budget/payee-rules';
import { getOrCreatePayee } from '../budget/payees';
import { getDb, type Db } from '../db/client';
import { categories, payeeRules, transactions } from '../db/schema';
import { matchPayeeRule } from '../import/rules';
import { parseAmountToMinor } from '../lib/money';
import { ulid } from '../lib/ids';
import { budgetIdParam } from '../lib/params';
import type { AppEnv } from '../types/hono';

/**
 * A band end arrives as a plain decimal string in the budget's currency
 * ("50", "50.00") or null for "no limit". Strings rather than numbers for
 * the same reason every other amount in this API is one: no float ever
 * touches money. The sign is rejected, not stripped — the band is a
 * magnitude, and a "-50" is far more likely a mistake than an intention.
 */
const bandEndSchema = z
  .string()
  .trim()
  .min(1)
  .nullable()
  .optional()
  .transform((value, ctx) => {
    if (value === undefined || value === null) return value;
    let minor: number;
    try {
      minor = parseAmountToMinor(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'expected an amount like "50" or "50.00"' });
      return z.NEVER;
    }
    if (minor < 0) {
      ctx.addIssue({ code: 'custom', message: 'a price band is a size, not a signed amount — use a positive number' });
      return z.NEVER;
    }
    return minor;
  });

const ruleFields = z.object({
  matchText: z.string().trim().min(1).max(200),
  payeeName: z.string().trim().min(1).max(200),
  categoryId: z.string().min(1).nullable().optional(),
  /** Inclusive lower end of the price band, budget currency; null/omitted = none. */
  amountMin: bandEndSchema,
  /** Inclusive upper end of the price band, budget currency; null/omitted = none. */
  amountMax: bandEndSchema,
});

const BAND_ORDER_ISSUE = {
  message: 'amountMin must not be greater than amountMax',
  path: ['amountMin'],
};
const bandInOrder = (v: { amountMin?: number | null; amountMax?: number | null }) =>
  v.amountMin == null || v.amountMax == null || v.amountMin <= v.amountMax;

const upsertSchema = ruleFields.refine(bandInOrder, BAND_ORDER_ISSUE);
const patchSchema = ruleFields.partial().refine(bandInOrder, BAND_ORDER_ISSUE);

async function categoryExists(db: Db, budgetId: string, categoryId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.id, categoryId), eq(categories.budgetId, budgetId), isNull(categories.deletedAt)))
    .limit(1);
  return !!row;
}

function toRuleView(row: typeof payeeRules.$inferSelect) {
  return {
    id: row.id,
    matchText: row.matchText,
    payeeName: row.payeeName,
    categoryId: row.categoryId,
    amountMinMinor: row.amountMinMinor,
    amountMaxMinor: row.amountMaxMinor,
  };
}

export const payeeRulesRoute = new Hono<AppEnv>();
payeeRulesRoute.use('*', requireBudgetMember);

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

payeeRulesRoute.post('/', async (c) => {
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
    amountMinMinor: input.amountMin ?? null,
    amountMaxMinor: input.amountMax ?? null,
    createdAt: now,
    updatedAt: now,
  });

  return c.json(
    {
      rule: {
        id,
        matchText: input.matchText,
        payeeName: input.payeeName,
        categoryId: input.categoryId ?? null,
        amountMinMinor: input.amountMin ?? null,
        amountMaxMinor: input.amountMax ?? null,
      },
    },
    201,
  );
});

payeeRulesRoute.patch('/:ruleId', async (c) => {
  const budgetId = budgetIdParam(c);
  const ruleId = c.req.param('ruleId');
  const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const input = parsed.data;

  const db = getDb(c.env);
  const [existing] = await db
    .select({ id: payeeRules.id, amountMinMinor: payeeRules.amountMinMinor, amountMaxMinor: payeeRules.amountMaxMinor })
    .from(payeeRules)
    .where(and(eq(payeeRules.id, ruleId), eq(payeeRules.budgetId, budgetId), isNull(payeeRules.deletedAt)))
    .limit(1);
  if (!existing) return c.json({ error: 'not_found' }, 404);

  // The request may send only ONE end of the band, so the order check that
  // ran in the schema saw half the picture. Re-check against what the rule
  // will actually hold once this patch lands. `undefined` leaves a side
  // alone; an explicit null clears it.
  const nextMin = input.amountMin === undefined ? existing.amountMinMinor : input.amountMin;
  const nextMax = input.amountMax === undefined ? existing.amountMaxMinor : input.amountMax;
  if (nextMin !== null && nextMax !== null && nextMin > nextMax) {
    return c.json({ error: 'invalid_body', detail: 'amountMin must not be greater than amountMax' }, 400);
  }

  if (input.categoryId !== undefined && input.categoryId !== null && !(await categoryExists(db, budgetId, input.categoryId))) {
    return c.json({ error: 'invalid_category' }, 400);
  }

  const now = Date.now();
  const patch: {
    updatedAt: number;
    matchText?: string;
    payeeName?: string;
    categoryId?: string | null;
    amountMinMinor?: number | null;
    amountMaxMinor?: number | null;
  } = { updatedAt: now };
  if (input.matchText !== undefined) patch.matchText = input.matchText;
  if (input.payeeName !== undefined) patch.payeeName = input.payeeName;
  if (input.categoryId !== undefined) patch.categoryId = input.categoryId;
  if (input.amountMin !== undefined) patch.amountMinMinor = input.amountMin;
  if (input.amountMax !== undefined) patch.amountMaxMinor = input.amountMax;
  await db.update(payeeRules).set(patch).where(eq(payeeRules.id, ruleId));

  return c.json({ status: 'ok' });
});

payeeRulesRoute.delete('/:ruleId', async (c) => {
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
payeeRulesRoute.post('/apply', async (c) => {
  const budgetId = budgetIdParam(c);
  const db = getDb(c.env);

  const rules = await loadActivePayeeRules(db, budgetId);
  const rows = await db
    .select({
      id: transactions.id,
      importPayeeRaw: transactions.importPayeeRaw,
      budgetAmountMinor: transactions.budgetAmountMinor,
    })
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
    // The price band is judged on what the row is worth in the budget's
    // currency, which is exactly what budgetAmountMinor stores.
    const match = matchPayeeRule(rules, row.importPayeeRaw, row.budgetAmountMinor);
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

import { and, eq, isNull, max } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireBudgetMember } from '../auth/middleware';
import { getDb } from '../db/client';
import { categories, categoryTargets, transactions } from '../db/schema';
import { occurrenceAtStep } from '../domain/targets';
import type { IntervalUnit } from '../domain/types';
import { addDays } from '../lib/dates';
import { ulid } from '../lib/ids';
import { parseAmountToMinor } from '../lib/money';
import { budgetIdParam } from '../lib/params';
import type { AppEnv } from '../types/hono';

const INTERVAL_UNITS = ['week', 'month', 'year', 'once'] as const satisfies readonly IntervalUnit[];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateSchema = z.string().regex(DATE_RE, 'expected YYYY-MM-DD');

// Bounds the /upcoming occurrence walk — the query's own day window is
// capped at 365, so even a weekly cadence (the densest case) needs well
// under 365 steps; this is purely a defensive backstop.
const MAX_UPCOMING_STEPS = 2000;

const upsertTargetSchema = z
  .object({
    amount: z.string(),
    intervalUnit: z.enum(INTERVAL_UNITS),
    // Ignored (and not required) when intervalUnit is 'once' — a one-time
    // target either has a single dueDate or none at all.
    intervalCount: z.number().int().min(1).optional(),
    dueDate: dateSchema.nullable().optional(),
  })
  .refine((v) => v.intervalUnit === 'once' || v.intervalCount !== undefined, {
    message: 'intervalCount is required unless intervalUnit is "once"',
    path: ['intervalCount'],
  });

function toTargetView(row: typeof categoryTargets.$inferSelect) {
  return {
    categoryId: row.categoryId,
    amount: (row.amountMinor / 100).toFixed(2),
    intervalUnit: row.intervalUnit,
    intervalCount: row.intervalCount,
    dueDate: row.dueDate,
  };
}

export const targetsRoute = new Hono<AppEnv>();
targetsRoute.use('*', requireBudgetMember('viewer'));

targetsRoute.get('/', async (c) => {
  const budgetId = budgetIdParam(c);
  const db = getDb(c.env);
  const rows = await db
    .select()
    .from(categoryTargets)
    .where(and(eq(categoryTargets.budgetId, budgetId), isNull(categoryTargets.deletedAt)));
  return c.json({ targets: rows.map(toTargetView) });
});

targetsRoute.put('/:categoryId', requireBudgetMember('editor'), async (c) => {
  const budgetId = budgetIdParam(c);
  const categoryId = c.req.param('categoryId');
  const parsed = upsertTargetSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const input = parsed.data;

  const db = getDb(c.env);
  const [category] = await db
    .select({ id: categories.id, kind: categories.kind })
    .from(categories)
    .where(and(eq(categories.id, categoryId), eq(categories.budgetId, budgetId), isNull(categories.deletedAt)))
    .limit(1);
  if (!category) return c.json({ error: 'invalid_category' }, 400);
  // 'income' categories feed Ready to Assign directly from transactions —
  // see src/routes/months.ts's identical check — there's no "available" of
  // their own for a target to aim at.
  if (category.kind === 'income') return c.json({ error: 'cannot_target_income_category' }, 400);

  let amountMinor: number;
  try {
    amountMinor = parseAmountToMinor(input.amount);
  } catch {
    return c.json({ error: 'invalid_amount' }, 400);
  }
  if (amountMinor <= 0) return c.json({ error: 'invalid_amount' }, 400);

  const now = Date.now();
  const [existing] = await db
    .select({ id: categoryTargets.id })
    .from(categoryTargets)
    .where(and(eq(categoryTargets.categoryId, categoryId), isNull(categoryTargets.deletedAt)))
    .limit(1);

  const values = {
    amountMinor,
    intervalUnit: input.intervalUnit,
    intervalCount: input.intervalUnit === 'once' ? 1 : (input.intervalCount ?? 1),
    dueDate: input.dueDate ?? null,
    updatedAt: now,
  };

  if (existing) {
    await db.update(categoryTargets).set(values).where(eq(categoryTargets.id, existing.id));
  } else {
    await db.insert(categoryTargets).values({ id: ulid(now), budgetId, categoryId, createdAt: now, ...values });
  }

  return c.json({ status: 'ok' });
});

targetsRoute.delete('/:categoryId', requireBudgetMember('editor'), async (c) => {
  const budgetId = budgetIdParam(c);
  const categoryId = c.req.param('categoryId');
  const db = getDb(c.env);

  const [existing] = await db
    .select({ id: categoryTargets.id })
    .from(categoryTargets)
    .where(
      and(eq(categoryTargets.categoryId, categoryId), eq(categoryTargets.budgetId, budgetId), isNull(categoryTargets.deletedAt)),
    )
    .limit(1);
  if (!existing) return c.json({ error: 'not_found' }, 404);

  await db.update(categoryTargets).set({ deletedAt: Date.now() }).where(eq(categoryTargets.id, existing.id));
  return c.json({ status: 'ok' });
});

// The "Coming up" timeline — occurrences across every category with a live
// target, expanded onto real calendar dates and sorted, independent of
// month boundaries entirely. This is the deliberately real-clock-anchored
// counterpart to computeTargets's month-relative view (see
// src/domain/targets.ts's doc comment) — it answers "what's due soon from
// right now", not "how much to assign this month".
export const upcomingRoute = new Hono<AppEnv>();
upcomingRoute.use('*', requireBudgetMember('viewer'));

const upcomingQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(365).default(60) });

upcomingRoute.get('/', async (c) => {
  const budgetId = budgetIdParam(c);
  const parsed = upcomingQuerySchema.safeParse({ days: c.req.query('days') });
  if (!parsed.success) return c.json({ error: 'invalid_query', issues: parsed.error.issues }, 400);

  const db = getDb(c.env);
  const today = new Date().toISOString().slice(0, 10);
  const horizon = addDays(today, parsed.data.days);

  const [targetRows, categoryRows, lastPaidRows] = await Promise.all([
    db
      .select()
      .from(categoryTargets)
      .where(and(eq(categoryTargets.budgetId, budgetId), isNull(categoryTargets.deletedAt))),
    db
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(and(eq(categories.budgetId, budgetId), isNull(categories.deletedAt))),
    db
      .select({ categoryId: transactions.categoryId, lastPaidDate: max(transactions.date) })
      .from(transactions)
      .where(and(eq(transactions.budgetId, budgetId), isNull(transactions.deletedAt)))
      .groupBy(transactions.categoryId),
  ]);

  const categoryNameById = new Map(categoryRows.map((cat) => [cat.id, cat.name]));
  const lastPaidByCategory = new Map(lastPaidRows.map((r) => [r.categoryId, r.lastPaidDate]));

  const occurrences: { categoryId: string; categoryName: string; dueDate: string; amountMinor: number; lastPaidDate: string | null }[] =
    [];

  for (const target of targetRows) {
    if (target.dueDate === null) continue; // open-ended build goal — nothing to schedule
    const categoryName = categoryNameById.get(target.categoryId);
    if (categoryName === undefined) continue; // category hidden/deleted since the target was set

    if (target.intervalUnit === 'once') {
      if (target.dueDate >= today && target.dueDate <= horizon) {
        occurrences.push({
          categoryId: target.categoryId,
          categoryName,
          dueDate: target.dueDate,
          amountMinor: target.amountMinor,
          lastPaidDate: lastPaidByCategory.get(target.categoryId) ?? null,
        });
      }
      continue;
    }

    // Walk every recurring occurrence landing inside [today, horizon].
    // Uses occurrenceAtStep (src/domain/targets.ts) rather than repeatedly
    // stepping off a previous RESULT — that function's own doc comment
    // explains why: addMonths/addYears clamp the day-of-month, and
    // stepping off an already-clamped date would carry the clamp forward
    // permanently instead of clamping fresh against each target month.
    for (let steps = 0; steps <= MAX_UPCOMING_STEPS; steps++) {
      const occurrence = occurrenceAtStep(target.dueDate, target.intervalUnit, target.intervalCount, steps);
      if (occurrence > horizon) break;
      if (occurrence >= today) {
        occurrences.push({
          categoryId: target.categoryId,
          categoryName,
          dueDate: occurrence,
          amountMinor: target.amountMinor,
          lastPaidDate: lastPaidByCategory.get(target.categoryId) ?? null,
        });
      }
    }
  }

  occurrences.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));
  return c.json({ occurrences });
});


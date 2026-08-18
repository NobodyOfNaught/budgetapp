import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireBudgetMember } from '../auth/middleware';
import { getDb } from '../db/client';
import { categories, categoryGroups } from '../db/schema';
import { budgetIdParam } from '../lib/params';
import { ulid } from '../lib/ids';
import type { AppEnv } from '../types/hono';

const createGroupSchema = z.object({ name: z.string().trim().min(1).max(120) });
const updateGroupSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  sortOrder: z.number().int().optional(),
  hidden: z.boolean().optional(),
});

const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(120),
  groupId: z.string().min(1),
});
const updateCategorySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  groupId: z.string().min(1).optional(),
  sortOrder: z.number().int().optional(),
  hidden: z.boolean().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
});

export const categoriesRoute = new Hono<AppEnv>();
categoriesRoute.use('*', requireBudgetMember('viewer'));

// Groups with their categories nested — the shape both the register's
// category picker and (later) the budget screen want.
categoriesRoute.get('/', async (c) => {
  const budgetId = budgetIdParam(c);
  const db = getDb(c.env);

  const groups = await db
    .select()
    .from(categoryGroups)
    .where(and(eq(categoryGroups.budgetId, budgetId), isNull(categoryGroups.deletedAt)))
    .orderBy(categoryGroups.sortOrder);
  const cats = await db
    .select()
    .from(categories)
    .where(and(eq(categories.budgetId, budgetId), isNull(categories.deletedAt)))
    .orderBy(categories.sortOrder);

  const catsByGroup = new Map<string, typeof cats>();
  for (const cat of cats) {
    const list = catsByGroup.get(cat.groupId);
    if (list) list.push(cat);
    else catsByGroup.set(cat.groupId, [cat]);
  }

  return c.json({
    groups: groups.map((g) => ({ ...g, categories: catsByGroup.get(g.id) ?? [] })),
  });
});

categoriesRoute.post('/groups', requireBudgetMember('editor'), async (c) => {
  const budgetId = budgetIdParam(c);
  const parsed = createGroupSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);

  const db = getDb(c.env);
  const now = Date.now();
  const id = ulid(now);
  await db.insert(categoryGroups).values({ id, budgetId, name: parsed.data.name, createdAt: now, updatedAt: now });
  return c.json({ group: { id, name: parsed.data.name } }, 201);
});

categoriesRoute.patch('/groups/:groupId', requireBudgetMember('editor'), async (c) => {
  const budgetId = budgetIdParam(c);
  const groupId = c.req.param('groupId');
  const parsed = updateGroupSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const input = parsed.data;

  const db = getDb(c.env);
  const [existing] = await db
    .select()
    .from(categoryGroups)
    .where(and(eq(categoryGroups.id, groupId), eq(categoryGroups.budgetId, budgetId), isNull(categoryGroups.deletedAt)))
    .limit(1);
  if (!existing) return c.json({ error: 'not_found' }, 404);
  if (existing.isSystem) return c.json({ error: 'system_managed' }, 400);

  const now = Date.now();
  await db
    .update(categoryGroups)
    .set({
      name: input.name ?? existing.name,
      sortOrder: input.sortOrder ?? existing.sortOrder,
      hiddenAt: input.hidden === undefined ? existing.hiddenAt : input.hidden ? now : null,
      updatedAt: now,
    })
    .where(eq(categoryGroups.id, groupId));

  return c.json({ status: 'ok' });
});

categoriesRoute.delete('/groups/:groupId', requireBudgetMember('editor'), async (c) => {
  const budgetId = budgetIdParam(c);
  const groupId = c.req.param('groupId');
  const db = getDb(c.env);

  const [existing] = await db
    .select()
    .from(categoryGroups)
    .where(and(eq(categoryGroups.id, groupId), eq(categoryGroups.budgetId, budgetId), isNull(categoryGroups.deletedAt)))
    .limit(1);
  if (!existing) return c.json({ error: 'not_found' }, 404);
  if (existing.isSystem) return c.json({ error: 'system_managed' }, 400);

  const [remaining] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.groupId, groupId), isNull(categories.deletedAt)))
    .limit(1);
  if (remaining) return c.json({ error: 'group_not_empty' }, 400);

  await db.update(categoryGroups).set({ deletedAt: Date.now() }).where(eq(categoryGroups.id, groupId));
  return c.json({ status: 'ok' });
});

categoriesRoute.post('/', requireBudgetMember('editor'), async (c) => {
  const budgetId = budgetIdParam(c);
  const parsed = createCategorySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const input = parsed.data;

  const db = getDb(c.env);
  const [group] = await db
    .select({ id: categoryGroups.id })
    .from(categoryGroups)
    .where(and(eq(categoryGroups.id, input.groupId), eq(categoryGroups.budgetId, budgetId), isNull(categoryGroups.deletedAt)))
    .limit(1);
  if (!group) return c.json({ error: 'invalid_group' }, 400);

  const now = Date.now();
  const id = ulid(now);
  // 'kind' is never user-settable through this endpoint — 'income' and
  // 'credit_card_payment' categories are system-managed (see
  // src/budget/payment-categories.ts); everything a user creates by hand
  // is an ordinary spending category.
  await db.insert(categories).values({
    id,
    budgetId,
    groupId: input.groupId,
    name: input.name,
    kind: 'spending',
    createdAt: now,
    updatedAt: now,
  });
  return c.json({ category: { id, name: input.name, groupId: input.groupId, kind: 'spending' } }, 201);
});

categoriesRoute.patch('/:categoryId', requireBudgetMember('editor'), async (c) => {
  const budgetId = budgetIdParam(c);
  const categoryId = c.req.param('categoryId');
  const parsed = updateCategorySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const input = parsed.data;

  const db = getDb(c.env);
  const [existing] = await db
    .select()
    .from(categories)
    .where(and(eq(categories.id, categoryId), eq(categories.budgetId, budgetId), isNull(categories.deletedAt)))
    .limit(1);
  if (!existing) return c.json({ error: 'not_found' }, 404);
  if (existing.kind !== 'spending') return c.json({ error: 'system_managed' }, 400);

  if (input.groupId) {
    const [group] = await db
      .select({ id: categoryGroups.id })
      .from(categoryGroups)
      .where(and(eq(categoryGroups.id, input.groupId), eq(categoryGroups.budgetId, budgetId), isNull(categoryGroups.deletedAt)))
      .limit(1);
    if (!group) return c.json({ error: 'invalid_group' }, 400);
  }

  const now = Date.now();
  await db
    .update(categories)
    .set({
      name: input.name ?? existing.name,
      groupId: input.groupId ?? existing.groupId,
      sortOrder: input.sortOrder ?? existing.sortOrder,
      hiddenAt: input.hidden === undefined ? existing.hiddenAt : input.hidden ? now : null,
      note: input.note === undefined ? existing.note : input.note,
      updatedAt: now,
    })
    .where(eq(categories.id, categoryId));

  return c.json({ status: 'ok' });
});

categoriesRoute.delete('/:categoryId', requireBudgetMember('editor'), async (c) => {
  const budgetId = budgetIdParam(c);
  const categoryId = c.req.param('categoryId');
  const db = getDb(c.env);

  const [existing] = await db
    .select()
    .from(categories)
    .where(and(eq(categories.id, categoryId), eq(categories.budgetId, budgetId), isNull(categories.deletedAt)))
    .limit(1);
  if (!existing) return c.json({ error: 'not_found' }, 404);
  if (existing.kind !== 'spending') return c.json({ error: 'system_managed' }, 400);

  // Soft delete only — see docs/plan.md: any month with historical
  // activity against this category still needs it present when the ledger
  // engine computes that month. Hiding, not this, is what a user normally
  // wants for "I don't use this anymore but keep my history".
  await db.update(categories).set({ deletedAt: Date.now() }).where(eq(categories.id, categoryId));
  return c.json({ status: 'ok' });
});

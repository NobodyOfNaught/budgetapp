import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireBudgetMember } from '../auth/middleware';
import { ensurePaymentCategory, renamePaymentCategory } from '../budget/payment-categories';
import { insertTransaction } from '../budget/transactions';
import { getDb } from '../db/client';
import { accounts, budgets } from '../db/schema';
import { CREDIT_ACCOUNT_KINDS, type AccountKind } from '../domain/types';
import { convertToBudgetMinor, parseAmountToMinor, parseFxRateToMicros } from '../lib/money';
import { ulid } from '../lib/ids';
import { budgetIdParam } from '../lib/params';
import type { AppEnv } from '../types/hono';

const ACCOUNT_TYPES = [
  'checking',
  'savings',
  'cash',
  'credit_card',
  'line_of_credit',
  'tracking_asset',
  'tracking_liability',
] as const satisfies readonly AccountKind[];

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

const createAccountSchema = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.enum(ACCOUNT_TYPES),
  onBudget: z.boolean().optional(),
  note: z.string().trim().max(2000).optional(),
  startingBalance: z.string().optional(),
  startingBalanceDate: dateSchema.optional(),
  /** ISO 4217, defaults to the budget's. A currency other than the budget's forces the account off-budget UNLESS fxRate is also supplied — see below. */
  currencyCode: z.string().trim().length(3).toUpperCase().optional(),
  /** Budget-currency-per-1-unit-of-account-currency, e.g. "0.73" for CAD in a USD budget. Required for a foreign-currency account to be on-budget. */
  fxRate: z.string().trim().optional(),
  /** Which statement parser this account's files use, when it was set up for import. */
  importProvider: z.string().trim().min(1).max(40).optional(),
});

const updateAccountSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  note: z.string().trim().max(2000).nullable().optional(),
  sortOrder: z.number().int().optional(),
  closed: z.boolean().optional(),
  /** Updates or clears (null) the account's remembered exchange rate — see createAccountSchema's fxRate. Does not retroactively re-convert existing transactions or change onBudget. */
  fxRate: z.string().trim().nullable().optional(),
});

export const accountsRoute = new Hono<AppEnv>();

// Every route here needs at least a member; POST/PATCH additionally
// require 'editor' below — see requireBudgetMember's stacking note.
accountsRoute.use('*', requireBudgetMember('viewer'));

accountsRoute.get('/', async (c) => {
  const db = getDb(c.env);
  const rows = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.budgetId, budgetIdParam(c)), isNull(accounts.deletedAt)))
    .orderBy(accounts.sortOrder);
  return c.json({ accounts: rows });
});

accountsRoute.post('/', requireBudgetMember('editor'), async (c) => {
  const budgetId = budgetIdParam(c);
  const parsed = createAccountSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const input = parsed.data;

  const db = getDb(c.env);
  const now = Date.now();

  const [budget] = await db.select({ currencyCode: budgets.currencyCode }).from(budgets).where(eq(budgets.id, budgetId)).limit(1);
  if (!budget) return c.json({ error: 'not_found' }, 404);

  const currencyCode = input.currencyCode ?? budget.currencyCode;
  const isForeignCurrency = currencyCode !== budget.currencyCode;

  let fxRateMicros: number | null = null;
  if (input.fxRate !== undefined) {
    try {
      fxRateMicros = parseFxRateToMicros(input.fxRate);
    } catch {
      return c.json({ error: 'invalid_fx_rate' }, 400);
    }
  }

  // A foreign-currency account with NO rate is forced OFF-budget: budget
  // math sums budgetAmountMinor, and without a rate there is nothing
  // honest to put there but the native amount, which would silently
  // inject foreign numbers into budget-currency categories. Supplying a
  // rate (see fxRateMicros above) makes the account budgetable like any
  // other — see src/lib/money.ts's convertToBudgetMinor and
  // docs/plan.md's PR 15 notes. Money crossing into the budget from an
  // account that stays off-budget still works as a transfer, which the
  // ledger engine treats as income (see src/domain/ledger.ts).
  const isBudgetable = !isForeignCurrency || fxRateMicros !== null;
  const onBudget = isBudgetable ? (input.onBudget ?? !input.type.startsWith('tracking_')) : false;
  const accountId = ulid(now);

  await db.insert(accounts).values({
    id: accountId,
    budgetId,
    name: input.name,
    type: input.type,
    onBudget,
    currencyCode,
    fxRateMicros,
    importProvider: input.importProvider ?? null,
    note: input.note ?? null,
    createdAt: now,
    updatedAt: now,
  });

  if (CREDIT_ACCOUNT_KINDS.has(input.type)) {
    await ensurePaymentCategory(db, { budgetId, accountId, accountName: input.name }, now);
  }

  if (input.startingBalance !== undefined) {
    let minor: number;
    try {
      minor = parseAmountToMinor(input.startingBalance);
    } catch {
      return c.json({ error: 'invalid_starting_balance' }, 400);
    }
    if (minor !== 0) {
      // Uncategorized, on purpose — see docs/plan.md's ledger engine notes:
      // this is what makes it flow to Ready to Assign (cash accounts) or
      // read as negative on the payment category (credit accounts) with no
      // special-casing needed here at all.
      await insertTransaction(
        db,
        {
          budgetId,
          accountId,
          date: input.startingBalanceDate ?? todayUtc(),
          amountMinor: minor,
          currencyCode,
          budgetAmountMinor: fxRateMicros !== null ? convertToBudgetMinor(minor, fxRateMicros) : undefined,
          cleared: 'cleared',
        },
        now,
      );
    }
  }

  return c.json(
    {
      account: { id: accountId, name: input.name, type: input.type, onBudget, currencyCode, fxRateMicros },
      // Surfaced so the UI can explain the demotion rather than silently
      // producing an account that doesn't behave the way the user picked.
      forcedOffBudget: isForeignCurrency && !isBudgetable,
    },
    201,
  );
});

accountsRoute.patch('/:accountId', requireBudgetMember('editor'), async (c) => {
  const budgetId = budgetIdParam(c);
  const accountId = c.req.param('accountId');
  const parsed = updateAccountSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const input = parsed.data;

  const db = getDb(c.env);
  const [existing] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.budgetId, budgetId), isNull(accounts.deletedAt)))
    .limit(1);
  if (!existing) return c.json({ error: 'not_found' }, 404);

  let fxRateMicros = existing.fxRateMicros;
  if (input.fxRate !== undefined) {
    if (input.fxRate === null) {
      fxRateMicros = null;
    } else {
      try {
        fxRateMicros = parseFxRateToMicros(input.fxRate);
      } catch {
        return c.json({ error: 'invalid_fx_rate' }, 400);
      }
    }
  }

  const now = Date.now();
  await db
    .update(accounts)
    .set({
      name: input.name ?? existing.name,
      note: input.note === undefined ? existing.note : input.note,
      sortOrder: input.sortOrder ?? existing.sortOrder,
      closedAt: input.closed === undefined ? existing.closedAt : input.closed ? now : null,
      fxRateMicros,
      updatedAt: now,
    })
    .where(eq(accounts.id, accountId));

  if (input.name && input.name !== existing.name && CREDIT_ACCOUNT_KINDS.has(existing.type)) {
    await renamePaymentCategory(db, accountId, input.name, now);
  }

  return c.json({ status: 'ok' });
});

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

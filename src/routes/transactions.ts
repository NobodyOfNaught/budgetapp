import { and, asc, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireBudgetMember } from '../auth/middleware';
import {
  insertSplitTransaction,
  insertTransaction,
  insertTransferPair,
  softDeleteTransactionCascade,
  type SplitPart,
} from '../budget/transactions';
import { getOrCreatePayee, getOrCreateTransferPayee } from '../budget/payees';
import { getDb, type Db } from '../db/client';
import { accounts, categories, payees, transactions } from '../db/schema';
import { budgetIdParam } from '../lib/params';
import { parseAmountToMinor } from '../lib/money';
import type { AppEnv } from '../types/hono';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const clearedSchema = z.enum(['uncleared', 'cleared', 'reconciled']);
const CLEARED_VALUES = new Set(clearedSchema.options);

const baseFields = {
  accountId: z.string().min(1),
  date: dateSchema,
  memo: z.string().trim().max(1000).nullable().optional(),
  cleared: clearedSchema.optional(),
};

const splitPartSchema = z.object({
  amount: z.string(),
  categoryId: z.string().min(1).nullable(),
  memo: z.string().trim().max(1000).nullable().optional(),
});

const createTransactionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ordinary'),
    ...baseFields,
    amount: z.string(),
    payeeName: z.string().trim().min(1).max(200).optional(),
    categoryId: z.string().min(1).nullable().optional(),
  }),
  z.object({
    kind: z.literal('split'),
    ...baseFields,
    payeeName: z.string().trim().min(1).max(200).optional(),
    splits: z.array(splitPartSchema).min(2),
  }),
  z.object({
    kind: z.literal('transfer'),
    ...baseFields,
    amount: z.string(),
    transferToAccountId: z.string().min(1),
    categoryId: z.string().min(1).nullable().optional(),
  }),
]);

const updateTransactionSchema = z.object({
  date: dateSchema.optional(),
  amount: z.string().optional(), // ordinary transactions only
  categoryId: z.string().min(1).nullable().optional(),
  payeeName: z.string().trim().min(1).max(200).optional(), // ordinary/split only, not transfer legs
  memo: z.string().trim().max(1000).nullable().optional(),
  cleared: clearedSchema.optional(),
  splits: z.array(splitPartSchema).min(2).optional(), // replaces all children
});

async function categoryExists(db: Db, budgetId: string, categoryId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.id, categoryId), eq(categories.budgetId, budgetId), isNull(categories.deletedAt)))
    .limit(1);
  return !!row;
}

async function parseAmountOr400(amount: string): Promise<number | null> {
  try {
    return parseAmountToMinor(amount);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Create / edit / delete — mounted at /budgets/:budgetId/transactions
// ---------------------------------------------------------------------------

export const transactionsRoute = new Hono<AppEnv>();
transactionsRoute.use('*', requireBudgetMember('viewer'));

transactionsRoute.post('/', requireBudgetMember('editor'), async (c) => {
  const budgetId = budgetIdParam(c);
  const parsed = createTransactionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const input = parsed.data;

  const db = getDb(c.env);
  const now = Date.now();

  const [account] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, input.accountId), eq(accounts.budgetId, budgetId), isNull(accounts.deletedAt)))
    .limit(1);
  if (!account) return c.json({ error: 'invalid_account' }, 400);

  if (input.kind === 'transfer') {
    if (input.transferToAccountId === input.accountId) return c.json({ error: 'cannot_transfer_to_self' }, 400);
    const [toAccount] = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, input.transferToAccountId), eq(accounts.budgetId, budgetId), isNull(accounts.deletedAt)))
      .limit(1);
    if (!toAccount) return c.json({ error: 'invalid_transfer_account' }, 400);

    // `amount` is the positive magnitude moving from `accountId` to
    // `transferToAccountId` — an outflow on the source, an inflow on the
    // destination. (Not the literal signed amount on the source leg.)
    const minor = await parseAmountOr400(input.amount);
    if (minor === null) return c.json({ error: 'invalid_amount' }, 400);

    let categoryId: string | null = null;
    if (input.categoryId) {
      if (!(await categoryExists(db, budgetId, input.categoryId))) return c.json({ error: 'invalid_category' }, 400);
      categoryId = input.categoryId;
    }

    const fromPayeeId = await getOrCreateTransferPayee(db, budgetId, toAccount.id, toAccount.name, now);
    const toPayeeId = await getOrCreateTransferPayee(db, budgetId, account.id, account.name, now);

    const { fromId, toId } = await insertTransferPair(
      db,
      {
        budgetId,
        from: { accountId: account.id, currencyCode: account.currencyCode, amountMinor: -minor, categoryId },
        fromPayeeId,
        to: { accountId: toAccount.id, currencyCode: toAccount.currencyCode, amountMinor: minor, categoryId: null },
        toPayeeId,
        date: input.date,
        memo: input.memo ?? null,
        cleared: input.cleared ?? 'uncleared',
      },
      now,
    );

    return c.json({ transactionId: fromId, pairedTransactionId: toId }, 201);
  }

  if (input.kind === 'split') {
    const parts: SplitPart[] = [];
    for (const s of input.splits) {
      const minor = await parseAmountOr400(s.amount);
      if (minor === null) return c.json({ error: 'invalid_amount' }, 400);
      if (s.categoryId && !(await categoryExists(db, budgetId, s.categoryId))) {
        return c.json({ error: 'invalid_category' }, 400);
      }
      parts.push({ categoryId: s.categoryId, amountMinor: minor, memo: s.memo ?? null });
    }

    const payeeId = input.payeeName ? await getOrCreatePayee(db, budgetId, input.payeeName, now) : null;
    const id = await insertSplitTransaction(
      db,
      {
        budgetId,
        accountId: account.id,
        date: input.date,
        currencyCode: account.currencyCode,
        payeeId,
        memo: input.memo ?? null,
        cleared: input.cleared ?? 'uncleared',
        parts,
      },
      now,
    );
    return c.json({ transactionId: id }, 201);
  }

  // ordinary
  const minor = await parseAmountOr400(input.amount);
  if (minor === null) return c.json({ error: 'invalid_amount' }, 400);
  if (input.categoryId && !(await categoryExists(db, budgetId, input.categoryId))) {
    return c.json({ error: 'invalid_category' }, 400);
  }
  const payeeId = input.payeeName ? await getOrCreatePayee(db, budgetId, input.payeeName, now) : null;
  const id = await insertTransaction(
    db,
    {
      budgetId,
      accountId: account.id,
      date: input.date,
      amountMinor: minor,
      currencyCode: account.currencyCode,
      categoryId: input.categoryId ?? null,
      payeeId,
      memo: input.memo ?? null,
      cleared: input.cleared ?? 'uncleared',
    },
    now,
  );
  return c.json({ transactionId: id }, 201);
});

transactionsRoute.patch('/:transactionId', requireBudgetMember('editor'), async (c) => {
  const budgetId = budgetIdParam(c);
  const transactionId = c.req.param('transactionId');
  const parsed = updateTransactionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const input = parsed.data;

  const db = getDb(c.env);
  const [existing] = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, transactionId), eq(transactions.budgetId, budgetId), isNull(transactions.deletedAt)))
    .limit(1);
  if (!existing) return c.json({ error: 'not_found' }, 404);
  if (existing.parentTransactionId !== null) {
    return c.json({ error: 'edit_the_parent_transaction_instead' }, 400);
  }

  const isTransfer = existing.transferTransactionId !== null;
  const children = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.parentTransactionId, transactionId));
  const isSplit = children.length > 0;

  // Deliberately narrow scope for MVP: shape (ordinary/split/transfer)
  // can't be changed via edit, only the fields that stay meaningful within
  // whatever shape it already has. Changing shape or amount is delete +
  // recreate — see src/budget/transactions.ts and docs/plan.md.
  if (input.amount !== undefined && (isSplit || isTransfer)) {
    return c.json({ error: 'cannot_edit_amount_of_split_or_transfer' }, 400);
  }
  if (input.splits !== undefined && isTransfer) {
    return c.json({ error: 'cannot_convert_transfer_to_split' }, 400);
  }
  if (input.categoryId !== undefined && isSplit && input.splits === undefined) {
    return c.json({ error: 'set_category_via_splits_on_a_split_transaction' }, 400);
  }
  if (input.payeeName !== undefined && isTransfer) {
    return c.json({ error: 'transfer_payee_is_system_managed' }, 400);
  }

  const now = Date.now();

  if (input.categoryId !== undefined && input.categoryId !== null) {
    if (!(await categoryExists(db, budgetId, input.categoryId))) return c.json({ error: 'invalid_category' }, 400);
  }

  let amountMinor: number | undefined;
  if (input.amount !== undefined) {
    const minor = await parseAmountOr400(input.amount);
    if (minor === null) return c.json({ error: 'invalid_amount' }, 400);
    amountMinor = minor;
  }

  let payeeId: string | null | undefined;
  if (input.payeeName !== undefined) {
    payeeId = await getOrCreatePayee(db, budgetId, input.payeeName, now);
  }

  if (input.splits !== undefined) {
    const parts: SplitPart[] = [];
    for (const s of input.splits) {
      const minor = await parseAmountOr400(s.amount);
      if (minor === null) return c.json({ error: 'invalid_amount' }, 400);
      if (s.categoryId && !(await categoryExists(db, budgetId, s.categoryId))) {
        return c.json({ error: 'invalid_category' }, 400);
      }
      parts.push({ categoryId: s.categoryId, amountMinor: minor, memo: s.memo ?? null });
    }
    for (const child of children) {
      await db.update(transactions).set({ deletedAt: now, updatedAt: now }).where(eq(transactions.id, child.id));
    }
    amountMinor = parts.reduce((sum, p) => sum + p.amountMinor, 0);
    for (const part of parts) {
      await insertTransaction(
        db,
        {
          budgetId,
          accountId: existing.accountId,
          date: input.date ?? existing.date,
          amountMinor: part.amountMinor,
          currencyCode: existing.currencyCode,
          categoryId: part.categoryId,
          payeeId: payeeId !== undefined ? payeeId : existing.payeeId,
          memo: part.memo ?? null,
          cleared: input.cleared ?? existing.cleared,
          parentTransactionId: transactionId,
        },
        now,
      );
    }
  }

  await db
    .update(transactions)
    .set({
      date: input.date ?? existing.date,
      amountMinor: amountMinor ?? existing.amountMinor,
      budgetAmountMinor: amountMinor ?? existing.budgetAmountMinor,
      categoryId: isSplit ? null : input.categoryId !== undefined ? input.categoryId : existing.categoryId,
      payeeId: payeeId !== undefined ? payeeId : existing.payeeId,
      memo: input.memo !== undefined ? input.memo : existing.memo,
      cleared: input.cleared ?? existing.cleared,
      updatedAt: now,
    })
    .where(eq(transactions.id, transactionId));

  // A transfer's two legs represent one event — keep date/memo/cleared in
  // sync on both sides. Amount, accounts, and payee are never touched here
  // (blocked above / system-managed), so this can't desynchronize anything
  // that matters to the ledger engine.
  if (isTransfer && existing.transferTransactionId) {
    await db
      .update(transactions)
      .set({
        date: input.date ?? existing.date,
        memo: input.memo !== undefined ? input.memo : existing.memo,
        cleared: input.cleared ?? existing.cleared,
        updatedAt: now,
      })
      .where(eq(transactions.id, existing.transferTransactionId));
  }

  return c.json({ status: 'ok' });
});

transactionsRoute.delete('/:transactionId', requireBudgetMember('editor'), async (c) => {
  const budgetId = budgetIdParam(c);
  const transactionId = c.req.param('transactionId');
  const db = getDb(c.env);

  const [existing] = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.id, transactionId), eq(transactions.budgetId, budgetId), isNull(transactions.deletedAt)))
    .limit(1);
  if (!existing) return c.json({ error: 'not_found' }, 404);

  await softDeleteTransactionCascade(db, transactionId, Date.now());
  return c.json({ status: 'ok' });
});

// ---------------------------------------------------------------------------
// Register list — mounted at /budgets/:budgetId/accounts/:accountId/transactions
// ---------------------------------------------------------------------------

export const accountRegisterRoute = new Hono<AppEnv>();
accountRegisterRoute.use('*', requireBudgetMember('viewer'));

accountRegisterRoute.get('/', async (c) => {
  const budgetId = budgetIdParam(c);
  // Same situation as budgetIdParam (see src/lib/params.ts): this sub-app
  // is mounted at a compound path (/:budgetId/accounts/:accountId/...) it
  // doesn't itself declare, so Hono can't statically prove the param
  // exists here even though the route can only ever be reached with one.
  const accountId = c.req.param('accountId');
  if (!accountId) return c.json({ error: 'bad_request' }, 400);
  const db = getDb(c.env);

  const [account] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.budgetId, budgetId)))
    .limit(1);
  if (!account) return c.json({ error: 'not_found' }, 404);

  const search = c.req.query('search')?.trim().toLowerCase();
  const clearedParam = c.req.query('cleared');
  const cleared = clearedParam && CLEARED_VALUES.has(clearedParam as never) ? clearedParam : undefined;
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 100, 1), 500);
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0);

  // Fetch every top-level (non-split-child) transaction for this account,
  // oldest first, so the running balance is a straightforward forward sum —
  // this must include rows a search/cleared filter would later hide, since
  // "balance after this transaction" is a fact about ALL history, not just
  // the filtered subset a user happens to be looking at.
  const rows = await db
    .select({
      id: transactions.id,
      date: transactions.date,
      amountMinor: transactions.amountMinor,
      categoryId: transactions.categoryId,
      memo: transactions.memo,
      cleared: transactions.cleared,
      payeeId: transactions.payeeId,
      payeeName: payees.name,
      transferAccountId: transactions.transferAccountId,
      approved: transactions.approved,
      createdAt: transactions.createdAt,
    })
    .from(transactions)
    .leftJoin(payees, eq(payees.id, transactions.payeeId))
    .where(
      and(eq(transactions.accountId, accountId), isNull(transactions.deletedAt), isNull(transactions.parentTransactionId)),
    )
    .orderBy(asc(transactions.date), asc(transactions.createdAt));

  const splitParentIds = new Set(
    (
      await db
        .select({ parentTransactionId: transactions.parentTransactionId })
        .from(transactions)
        .where(and(eq(transactions.accountId, accountId), isNull(transactions.deletedAt)))
    )
      .map((r) => r.parentTransactionId)
      .filter((id): id is string => id !== null),
  );

  let running = 0;
  let clearedBalance = 0;
  const withBalance = rows.map((r) => {
    running += r.amountMinor;
    if (r.cleared !== 'uncleared') clearedBalance += r.amountMinor;
    return { ...r, isSplit: splitParentIds.has(r.id), balance: running };
  });

  const accountBalance = running;
  withBalance.reverse(); // newest first for display

  let filtered = withBalance;
  if (cleared) filtered = filtered.filter((r) => r.cleared === cleared);
  if (search) {
    filtered = filtered.filter(
      (r) => r.payeeName?.toLowerCase().includes(search) || r.memo?.toLowerCase().includes(search),
    );
  }

  return c.json({
    accountBalance,
    clearedBalance,
    total: filtered.length,
    transactions: filtered.slice(offset, offset + limit),
  });
});

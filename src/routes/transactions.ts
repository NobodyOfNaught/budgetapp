import { and, asc, eq, gte, inArray, isNull, lte, ne } from 'drizzle-orm';
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
import { accounts, budgets, categories, payees, transactions } from '../db/schema';
import { addDays } from '../lib/dates';
import { budgetIdParam } from '../lib/params';
import { convertToBudgetMinor, parseAmountToMinor } from '../lib/money';
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

/**
 * Value in the budget's currency for a manually-entered amount on this
 * account — mirrors the conversion src/routes/imports.ts already applies
 * to imported rows and src/routes/accounts.ts applies to a starting
 * balance. `undefined` (not the account's own currency's amount) when
 * there's no rate on file, so insertTransaction's own
 * `budgetAmountMinor ?? amountMinor` fallback applies — correct whenever
 * the account IS the budget's currency, which is every account without a
 * rate by construction (see accounts.ts's isBudgetable).
 */
function budgetAmountFor(account: { fxRateMicros: number | null }, minor: number): number | undefined {
  return account.fxRateMicros !== null ? convertToBudgetMinor(minor, account.fxRateMicros) : undefined;
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
        fxRateMicros: account.fxRateMicros,
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
      budgetAmountMinor: budgetAmountFor(account, minor),
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

  // Only needed when the amount is actually changing (ordinary or split) —
  // the account's rate, if any, is what makes budgetAmountMinor a real
  // conversion here rather than the native-amount fallback. See
  // budgetAmountFor above; existing.accountId can't change on an edit.
  let fxRateMicros: number | null = null;
  if (input.amount !== undefined || input.splits !== undefined) {
    const [acct] = await db
      .select({ fxRateMicros: accounts.fxRateMicros })
      .from(accounts)
      .where(eq(accounts.id, existing.accountId))
      .limit(1);
    fxRateMicros = acct?.fxRateMicros ?? null;
  }

  let amountMinor: number | undefined;
  let budgetAmountMinor: number | undefined;
  if (input.amount !== undefined) {
    const minor = await parseAmountOr400(input.amount);
    if (minor === null) return c.json({ error: 'invalid_amount' }, 400);
    amountMinor = minor;
    budgetAmountMinor = fxRateMicros !== null ? convertToBudgetMinor(minor, fxRateMicros) : minor;
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
    // Same rule as insertSplitTransaction: convert each part, then sum
    // those for the parent, rather than independently converting the
    // total — keeps the parent exactly equal to the sum of its children.
    budgetAmountMinor = 0;
    for (const part of parts) {
      const partBudgetAmountMinor = fxRateMicros !== null ? convertToBudgetMinor(part.amountMinor, fxRateMicros) : part.amountMinor;
      budgetAmountMinor += partBudgetAmountMinor;
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
          budgetAmountMinor: partBudgetAmountMinor,
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
      budgetAmountMinor: budgetAmountMinor ?? existing.budgetAmountMinor,
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
// Linking two ALREADY-EXISTING transactions as a transfer.
//
// The create path above builds a transfer as a fresh pair of rows. That
// can't help when both halves already exist — the common case being two
// statement imports of the same real money movement: a Venmo outflow on a
// bank account and the matching settlement inflow on the Splitwise
// clearing account (see src/import/splitwise.ts). Those arrive as two
// independent uncategorized rows; this turns them into one linked event.
//
// Linking two UNCATEGORIZED rows between two ON-BUDGET accounts is a
// deliberate no-op for the ledger: an uncategorized non-transfer row on an
// on-budget account moves Ready to Assign by its amount (see
// src/domain/ledger.ts), so an equal-and-opposite pair already nets to
// zero; afterwards both legs hit the isTransfer branch and contribute
// nothing at all. Same total, less ambiguity. What linking DOES buy is
// that the pair can no longer drift apart: a stray category or payee rule
// can't silently turn one half into spending, and a pair straddling a
// month boundary stops distorting either month's income.
//
// The uncategorized requirement is enforced, not assumed — a categorized
// leg genuinely changes the arithmetic (category activity stays, but the
// counterpart's Ready to Assign movement disappears), so refusing is the
// only way to keep "link" from silently moving money.
// ---------------------------------------------------------------------------

/** How far apart two rows may be dated and still be offered as a match. */
const TRANSFER_MATCH_WINDOW_DAYS = 5;

/**
 * How far a CROSS-CURRENCY candidate's budget-currency value may sit from
 * the source row's before it stops being offered.
 *
 * Same-currency matching stays exact — see the candidate query below —
 * because "a near-miss match on money is a guess" and an exact
 * counterpart always exists. Across currencies no exact counterpart CAN
 * exist: the two legs are different amounts by definition, and the only
 * thing relating them is a rate nobody recorded at the time. The source
 * row's own budgetAmountMinor is computed from its account's NOMINAL
 * rate, while the real transfer settled at whatever the bank actually
 * gave — a real pair in this budget lands 1.9% apart on exactly that
 * gap. So a band is the only workable rule, and the choice is between an
 * approximate suggestion the user confirms or no feature at all.
 *
 * 10% is wide enough for a stale account rate plus conversion fees, and
 * narrow enough that unrelated amounts don't collide. Candidates are
 * flagged `approximate` so the UI can say the match is not exact, and the
 * link itself corrects both legs to an exact pair regardless (see
 * POST /link-transfer), so a wrong pick is visible and reversible rather
 * than silently absorbed.
 */
const CROSS_CURRENCY_TOLERANCE = 0.1;

const linkTransferSchema = z.object({ otherTransactionId: z.string().min(1) });

/** The columns both the candidate search and the link validation need. */
const linkableColumns = {
  id: transactions.id,
  accountId: transactions.accountId,
  date: transactions.date,
  amountMinor: transactions.amountMinor,
  budgetAmountMinor: transactions.budgetAmountMinor,
  currencyCode: transactions.currencyCode,
  categoryId: transactions.categoryId,
  memo: transactions.memo,
  transferTransactionId: transactions.transferTransactionId,
  parentTransactionId: transactions.parentTransactionId,
  importPayeeRaw: transactions.importPayeeRaw,
};

/** True when this row is a split parent — those are never linkable (their children carry the categories). */
async function hasSplitChildren(db: Db, transactionId: string): Promise<boolean> {
  const children = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.parentTransactionId, transactionId), isNull(transactions.deletedAt)))
    .limit(1);
  return children.length > 0;
}

/**
 * Why a row can't take part in a link, or null when it can. Shared by the
 * candidate search (to pick a starting row) and by the link itself (to
 * check both sides), so the button the UI offers and the rule the API
 * enforces can't drift apart.
 */
async function transferLinkBlocker(
  db: Db,
  row: { id: string; transferTransactionId: string | null; parentTransactionId: string | null; categoryId: string | null },
): Promise<string | null> {
  if (row.transferTransactionId !== null) return 'already_a_transfer';
  if (row.parentTransactionId !== null) return 'is_a_split_child';
  if (row.categoryId !== null) return 'is_categorized';
  if (await hasSplitChildren(db, row.id)) return 'is_a_split';
  return null;
}

// Candidate matches for one transaction: the opposite amount, in a
// different account, dated within TRANSFER_MATCH_WINDOW_DAYS, and itself
// linkable. Exact-amount only — a near-miss match on money is a guess, and
// this feature exists to remove ambiguity, not add it.
transactionsRoute.get('/:transactionId/transfer-candidates', async (c) => {
  const budgetId = budgetIdParam(c);
  const transactionId = c.req.param('transactionId');
  const db = getDb(c.env);

  const [row] = await db
    .select(linkableColumns)
    .from(transactions)
    .where(and(eq(transactions.id, transactionId), eq(transactions.budgetId, budgetId), isNull(transactions.deletedAt)))
    .limit(1);
  if (!row) return c.json({ error: 'not_found' }, 404);

  const blocker = await transferLinkBlocker(db, row);
  if (blocker) return c.json({ candidates: [], blocked: blocker });

  const earliest = addDays(row.date, -TRANSFER_MATCH_WINDOW_DAYS);
  const latest = addDays(row.date, TRANSFER_MATCH_WINDOW_DAYS);

  // Everything linkable in the window, in ANY account and currency. The
  // amount rule is applied in JS below rather than in SQL because it
  // differs by currency — exact for a same-currency pair, a tolerance
  // band across currencies (see CROSS_CURRENCY_TOLERANCE).
  const rows = await db
    .select({ ...linkableColumns, accountName: accounts.name })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(
      and(
        eq(transactions.budgetId, budgetId),
        isNull(transactions.deletedAt),
        isNull(transactions.transferTransactionId),
        isNull(transactions.parentTransactionId),
        isNull(transactions.categoryId),
        ne(transactions.accountId, row.accountId),
        gte(transactions.date, earliest),
        lte(transactions.date, latest),
      ),
    )
    .orderBy(asc(transactions.date))
    .limit(200);

  // A split parent has no parentTransactionId of its own, so it survives
  // the query above — filter it out here, where the child lookup lives.
  const candidates = [];
  for (const candidate of rows) {
    const sameCurrency = candidate.currencyCode === row.currencyCode;

    // Same currency keeps PR 14's exact-opposite rule untouched.
    if (sameCurrency && candidate.amountMinor !== -row.amountMinor) continue;

    // Across currencies the legs are different numbers by definition, so
    // compare what they're each WORTH in the budget's currency, and only
    // within a band. Requires opposite signs — one side out, one side in.
    if (!sameCurrency) {
      if (row.budgetAmountMinor === 0 || candidate.budgetAmountMinor === 0) continue;
      if (Math.sign(candidate.budgetAmountMinor) === Math.sign(row.budgetAmountMinor)) continue;
      const expected = Math.abs(row.budgetAmountMinor);
      const drift = Math.abs(Math.abs(candidate.budgetAmountMinor) - expected) / expected;
      if (drift > CROSS_CURRENCY_TOLERANCE) continue;
    }

    if (await hasSplitChildren(db, candidate.id)) continue;
    candidates.push({
      id: candidate.id,
      accountId: candidate.accountId,
      accountName: candidate.accountName,
      date: candidate.date,
      amountMinor: candidate.amountMinor,
      currencyCode: candidate.currencyCode,
      memo: candidate.memo,
      importPayeeRaw: candidate.importPayeeRaw,
      /** True when the two legs are in different currencies, so the match is a near-miss by nature rather than an exact offset. */
      approximate: !sameCurrency,
    });
    if (candidates.length >= 20) break;
  }

  return c.json({ candidates });
});

transactionsRoute.post('/:transactionId/link-transfer', requireBudgetMember('editor'), async (c) => {
  const budgetId = budgetIdParam(c);
  const transactionId = c.req.param('transactionId');
  const parsed = linkTransferSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const { otherTransactionId } = parsed.data;
  if (otherTransactionId === transactionId) return c.json({ error: 'cannot_link_to_self' }, 400);

  const db = getDb(c.env);
  const rows = await db
    .select(linkableColumns)
    .from(transactions)
    .where(
      and(
        inArray(transactions.id, [transactionId, otherTransactionId]),
        eq(transactions.budgetId, budgetId),
        isNull(transactions.deletedAt),
      ),
    );
  const first = rows.find((r) => r.id === transactionId);
  const second = rows.find((r) => r.id === otherTransactionId);
  if (!first || !second) return c.json({ error: 'not_found' }, 404);

  for (const row of [first, second]) {
    const blocker = await transferLinkBlocker(db, row);
    if (blocker) return c.json({ error: blocker }, 400);
  }

  if (first.accountId === second.accountId) return c.json({ error: 'same_account' }, 400);

  const [firstAccount] = await db.select().from(accounts).where(eq(accounts.id, first.accountId)).limit(1);
  const [secondAccount] = await db.select().from(accounts).where(eq(accounts.id, second.accountId)).limit(1);
  if (!firstAccount || !secondAccount) return c.json({ error: 'invalid_account' }, 400);

  const sameCurrency = first.currencyCode === second.currencyCode;

  // Same currency: exact opposites, unchanged from PR 14. Also rejects a
  // 0/0 pair, which is not a transfer of anything and would link two
  // unrelated rows on a technicality.
  if (sameCurrency && (first.amountMinor !== -second.amountMinor || first.amountMinor === 0)) {
    return c.json({ error: 'amounts_do_not_offset' }, 400);
  }

  // Cross-currency: the two legs are DIFFERENT numbers by definition, so
  // "equal and opposite" can only be required of what they're worth, not
  // of the native amounts. All that's demanded of the natives is that one
  // is an outflow and the other an inflow.
  if (!sameCurrency && (first.amountMinor === 0 || second.amountMinor === 0 || Math.sign(first.amountMinor) === Math.sign(second.amountMinor))) {
    return c.json({ error: 'amounts_do_not_offset' }, 400);
  }

  // What the movement was actually WORTH, in the budget's currency.
  //
  // Linking must stay Ready-to-Assign-neutral — PR 14's whole invariant —
  // and that only holds if the two legs' budgetAmountMinor are exactly
  // equal and opposite. Across currencies they generally aren't: each was
  // converted independently at its own account's NOMINAL rate, while the
  // transfer settled at whatever the bank actually gave. So one side is
  // chosen as the truth and the other is set to its negation.
  //
  // The budget-currency leg wins when there is one, because it needs no
  // conversion at all — it IS the realized value, which beats any stored
  // rate. That is the same "derive the effective rate from the two legs"
  // principle the Wise importer already uses (see src/routes/imports.ts),
  // and it corrects the other leg from nominal to realized in the process.
  let firstBudgetAmountMinor = first.budgetAmountMinor;
  let secondBudgetAmountMinor = second.budgetAmountMinor;
  if (!sameCurrency) {
    const [budget] = await db
      .select({ currencyCode: budgets.currencyCode })
      .from(budgets)
      .where(eq(budgets.id, budgetId))
      .limit(1);
    if (!budget) return c.json({ error: 'not_found' }, 404);

    if (first.currencyCode === budget.currencyCode) {
      secondBudgetAmountMinor = -firstBudgetAmountMinor;
    } else if (second.currencyCode === budget.currencyCode) {
      firstBudgetAmountMinor = -secondBudgetAmountMinor;
    } else {
      // Neither leg is in the budget's currency (CAD -> EUR in a USD
      // budget), so nothing here is a realized budget-currency figure.
      // Fall back to converting the OUTFLOW leg at its account's rate and
      // mirroring it — still exactly equal and opposite, still
      // RTA-neutral, just resting on a nominal rate rather than a
      // realized one. Without a rate there is nothing honest to use.
      const firstIsOutflow = first.amountMinor < 0;
      const outflowAccount = firstIsOutflow ? firstAccount : secondAccount;
      const outflow = firstIsOutflow ? first : second;
      if (outflowAccount.fxRateMicros === null) {
        return c.json({ error: 'needs_fx_rate_to_link' }, 400);
      }
      const outflowValue = convertToBudgetMinor(outflow.amountMinor, outflowAccount.fxRateMicros);
      firstBudgetAmountMinor = firstIsOutflow ? outflowValue : -outflowValue;
      secondBudgetAmountMinor = -firstBudgetAmountMinor;
    }
  }

  const now = Date.now();
  // Each leg's payee names the OTHER account, matching what the create
  // path builds (see getOrCreateTransferPayee) so a linked transfer is
  // indistinguishable from one entered as a transfer in the first place.
  const firstPayeeId = await getOrCreateTransferPayee(db, budgetId, secondAccount.id, secondAccount.name, now);
  const secondPayeeId = await getOrCreateTransferPayee(db, budgetId, firstAccount.id, firstAccount.name, now);

  await db
    .update(transactions)
    .set({
      transferTransactionId: second.id,
      transferAccountId: second.accountId,
      payeeId: firstPayeeId,
      budgetAmountMinor: firstBudgetAmountMinor,
      updatedAt: now,
    })
    .where(eq(transactions.id, first.id));
  await db
    .update(transactions)
    .set({
      transferTransactionId: first.id,
      transferAccountId: first.accountId,
      payeeId: secondPayeeId,
      budgetAmountMinor: secondBudgetAmountMinor,
      updatedAt: now,
    })
    .where(eq(transactions.id, second.id));

  return c.json({ status: 'ok' });
});

// Undoes a link, leaving both rows exactly as ordinary transactions again
// (payee cleared along with the link, since a "Transfer : X" payee on an
// unlinked row would be a lie). Deliberately available for links this
// endpoint didn't create too — a transfer entered by hand can be split
// back apart without deleting and re-entering both halves.
transactionsRoute.post('/:transactionId/unlink-transfer', requireBudgetMember('editor'), async (c) => {
  const budgetId = budgetIdParam(c);
  const transactionId = c.req.param('transactionId');
  const db = getDb(c.env);

  const [row] = await db
    .select({ id: transactions.id, transferTransactionId: transactions.transferTransactionId })
    .from(transactions)
    .where(and(eq(transactions.id, transactionId), eq(transactions.budgetId, budgetId), isNull(transactions.deletedAt)))
    .limit(1);
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (row.transferTransactionId === null) return c.json({ error: 'not_a_transfer' }, 400);

  const now = Date.now();
  const clearLink = { transferTransactionId: null, transferAccountId: null, payeeId: null, updatedAt: now };
  await db.update(transactions).set(clearLink).where(eq(transactions.id, row.id));
  // The sibling may already be gone (deleting one leg cascades to the
  // other) — scoping by budget keeps this from touching anything else.
  await db
    .update(transactions)
    .set(clearLink)
    .where(and(eq(transactions.id, row.transferTransactionId), eq(transactions.budgetId, budgetId)));

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

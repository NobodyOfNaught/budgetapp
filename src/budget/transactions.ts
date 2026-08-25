import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { transactions } from '../db/schema';
import { ulid } from '../lib/ids';
import { convertToBudgetMinor } from '../lib/money';

export type ClearedStatus = 'uncleared' | 'cleared' | 'reconciled';

export interface NewTransactionInput {
  /** Pre-generated id — needed when two rows must reference each other's id before either is inserted (a transfer pair). Defaults to a fresh ulid. */
  id?: string;
  budgetId: string;
  accountId: string;
  date: string;
  amountMinor: number;
  currencyCode: string;
  categoryId?: string | null;
  payeeId?: string | null;
  memo?: string | null;
  cleared?: ClearedStatus;
  transferTransactionId?: string | null;
  transferAccountId?: string | null;
  parentTransactionId?: string | null;
  /** Set only on a fee row carved out of a transfer leg — see migrations/0008_transfer_fee_link.sql. */
  feeForTransactionId?: string | null;
  /** Value in the BUDGET's currency. Defaults to amountMinor (same-currency case). */
  budgetAmountMinor?: number;
  /** Statement-import provenance — see src/import/ and the partial unique index on (account_id, import_id). */
  importId?: string | null;
  importBatchId?: string | null;
  importPayeeRaw?: string | null;
  /** Imported rows land unapproved so they surface in the review queue; manual entry is approved outright. */
  approved?: boolean;
}

/**
 * Inserts a single ordinary transaction row. budgetAmountMinor defaults to
 * amountMinor — correct whenever the account's currency IS the budget's,
 * which is every manually-entered transaction. Callers holding a real
 * conversion (statement import, which gets a per-row rate from the file
 * itself — see src/import/wise.ts) pass it explicitly. Everything
 * downstream (the ledger engine, every report) sums budgetAmountMinor, not
 * amountMinor, so that override is the whole multi-currency seam.
 */
export async function insertTransaction(db: Db, input: NewTransactionInput, now: number): Promise<string> {
  const id = input.id ?? ulid(now);
  await db.insert(transactions).values({
    id,
    budgetId: input.budgetId,
    accountId: input.accountId,
    date: input.date,
    amountMinor: input.amountMinor,
    currencyCode: input.currencyCode,
    budgetAmountMinor: input.budgetAmountMinor ?? input.amountMinor,
    categoryId: input.categoryId ?? null,
    payeeId: input.payeeId ?? null,
    memo: input.memo ?? null,
    cleared: input.cleared ?? 'uncleared',
    transferTransactionId: input.transferTransactionId ?? null,
    transferAccountId: input.transferAccountId ?? null,
    parentTransactionId: input.parentTransactionId ?? null,
    feeForTransactionId: input.feeForTransactionId ?? null,
    importId: input.importId ?? null,
    importBatchId: input.importBatchId ?? null,
    importPayeeRaw: input.importPayeeRaw ?? null,
    approved: input.approved ?? true,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export interface SplitPart {
  categoryId: string | null;
  amountMinor: number;
  memo?: string | null;
}

/**
 * Inserts a split parent (categoryId null, amount = sum of parts — the
 * single line the register/account-balance math sees) plus one child row
 * per part (each carrying its own category and portion of the amount).
 * See docs/plan.md's ledger engine section: the parent is excluded from
 * all category/Ready-to-Assign math, its children carry it.
 */
export async function insertSplitTransaction(
  db: Db,
  input: {
    budgetId: string;
    accountId: string;
    date: string;
    currencyCode: string;
    payeeId: string | null;
    memo: string | null;
    cleared: ClearedStatus;
    parts: SplitPart[];
    /** The account's fx_rate_micros, when set — see src/lib/money.ts. Converts each part AND the parent (as the sum of the converted parts, not an independent conversion of the total, so the parent stays exactly equal to the sum of its children). */
    fxRateMicros?: number | null;
  },
  now: number,
): Promise<string> {
  const totalMinor = input.parts.reduce((sum, p) => sum + p.amountMinor, 0);
  const convertedParts =
    input.fxRateMicros != null ? input.parts.map((p) => convertToBudgetMinor(p.amountMinor, input.fxRateMicros!)) : null;
  const parentId = await insertTransaction(
    db,
    {
      budgetId: input.budgetId,
      accountId: input.accountId,
      date: input.date,
      amountMinor: totalMinor,
      currencyCode: input.currencyCode,
      payeeId: input.payeeId,
      memo: input.memo,
      cleared: input.cleared,
      budgetAmountMinor: convertedParts?.reduce((sum, m) => sum + m, 0),
    },
    now,
  );

  for (const [i, part] of input.parts.entries()) {
    await insertTransaction(
      db,
      {
        budgetId: input.budgetId,
        accountId: input.accountId,
        date: input.date,
        amountMinor: part.amountMinor,
        currencyCode: input.currencyCode,
        categoryId: part.categoryId,
        payeeId: input.payeeId,
        memo: part.memo ?? null,
        cleared: input.cleared,
        parentTransactionId: parentId,
        budgetAmountMinor: convertedParts?.[i],
      },
      now,
    );
  }

  return parentId;
}

interface TransferLeg {
  accountId: string;
  currencyCode: string;
  amountMinor: number;
  categoryId?: string | null;
  /** Value in the BUDGET's currency; defaults to amountMinor. Set per leg on a cross-currency transfer. */
  budgetAmountMinor?: number;
  /** Per-leg dedupe key. The two legs sit on different accounts but must not collide if they ever share one. */
  importId?: string | null;
}

/**
 * Inserts both legs of a transfer, cross-referencing each other's id via
 * transferTransactionId — "find the other leg" is then a plain primary-key
 * lookup. Left uncategorized by default on both sides (the common case:
 * money moving between the user's own on-budget accounts, no budget
 * effect); pass `from.categoryId` to categorize the outflow leg, which is
 * how paying a credit card works — see docs/plan.md's ledger engine notes.
 */
export async function insertTransferPair(
  db: Db,
  input: {
    budgetId: string;
    from: TransferLeg;
    fromPayeeId: string;
    to: TransferLeg;
    toPayeeId: string;
    date: string;
    memo: string | null;
    cleared: ClearedStatus;
    importBatchId?: string | null;
    approved?: boolean;
  },
  now: number,
): Promise<{ fromId: string; toId: string }> {
  // Both ids are generated up front, before either row is inserted, so
  // each leg can reference the other's id as its transferTransactionId.
  const fromId = ulid(now);
  const toId = ulid(now);

  await insertTransaction(
    db,
    {
      id: fromId,
      budgetId: input.budgetId,
      accountId: input.from.accountId,
      date: input.date,
      amountMinor: input.from.amountMinor,
      currencyCode: input.from.currencyCode,
      categoryId: input.from.categoryId ?? null,
      payeeId: input.fromPayeeId,
      memo: input.memo,
      cleared: input.cleared,
      transferTransactionId: toId,
      transferAccountId: input.to.accountId,
      budgetAmountMinor: input.from.budgetAmountMinor,
      importId: input.from.importId ?? null,
      importBatchId: input.importBatchId ?? null,
      approved: input.approved,
    },
    now,
  );
  await insertTransaction(
    db,
    {
      id: toId,
      budgetId: input.budgetId,
      accountId: input.to.accountId,
      date: input.date,
      amountMinor: input.to.amountMinor,
      currencyCode: input.to.currencyCode,
      categoryId: input.to.categoryId ?? null,
      payeeId: input.toPayeeId,
      memo: input.memo,
      cleared: input.cleared,
      transferTransactionId: fromId,
      transferAccountId: input.from.accountId,
      budgetAmountMinor: input.to.budgetAmountMinor,
      importId: input.to.importId ?? null,
      importBatchId: input.importBatchId ?? null,
      approved: input.approved,
    },
    now,
  );

  return { fromId, toId };
}

/**
 * Soft-deletes a transaction and cascades to whatever it's structurally
 * tied to: a split parent's children, a carved-out fee row, or a transfer's
 * sibling leg — wherever that sibling lives, including a different account
 * or a different import batch entirely. Deleting a split child directly
 * (bypassing its parent) is left unguarded — the UI never does this, only
 * whole-transaction delete on the parent.
 *
 * Returns every transaction id actually transitioned to deleted — the
 * primary one plus whatever cascaded — so a caller working through many
 * rows at once (see the import-undo route) can tell which of those were
 * incidental: a sibling this call reached but the caller never asked for.
 * Idempotent: called again on an already-deleted id, it does nothing and
 * returns an empty list — the exact case a batch containing BOTH legs of
 * one transfer hits, since the first call already cascaded to the second.
 */
export async function softDeleteTransactionCascade(db: Db, transactionId: string, now: number): Promise<string[]> {
  const [row] = await db.select().from(transactions).where(eq(transactions.id, transactionId)).limit(1);
  if (!row || row.deletedAt !== null) return [];

  const deletedIds = [transactionId];

  const children = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.parentTransactionId, transactionId));
  for (const child of children) {
    await db.update(transactions).set({ deletedAt: now, updatedAt: now }).where(eq(transactions.id, child.id));
    deletedIds.push(child.id);
  }

  // A fee carved out of this row when it was linked as a transfer (see
  // migrations/0008_transfer_fee_link.sql) is part of the same real
  // movement — leaving it behind would strand a lone -0.31 "fee" against a
  // transfer that no longer exists.
  const fees = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.feeForTransactionId, transactionId));
  for (const fee of fees) {
    await db.update(transactions).set({ deletedAt: now, updatedAt: now }).where(eq(transactions.id, fee.id));
    deletedIds.push(fee.id);
  }

  await db.update(transactions).set({ deletedAt: now, updatedAt: now }).where(eq(transactions.id, transactionId));

  if (row.transferTransactionId) {
    const [sibling] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.id, row.transferTransactionId))
      .limit(1);
    if (sibling && sibling.deletedAt === null) {
      await db.update(transactions).set({ deletedAt: now, updatedAt: now }).where(eq(transactions.id, sibling.id));
      deletedIds.push(sibling.id);
    }
  }

  return deletedIds;
}

import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireBudgetMember } from '../auth/middleware';
import { loadActivePayeeRules } from '../budget/payee-rules';
import { getOrCreatePayee, getOrCreateTransferPayee } from '../budget/payees';
import { insertTransaction, insertTransferPair } from '../budget/transactions';
import { getDb, type Db } from '../db/client';
import { accounts, budgets, categories, importBatches, payees, transactions } from '../db/schema';
import { IMPORT_PROVIDERS, isImportProvider, parseStatement, suggestCategoryName, type ImportProvider } from '../import';
import { cleanPayeeName } from '../import/payee-name';
import { matchPayeeRule, type PayeeRule } from '../import/rules';
import { ulid } from '../lib/ids';
import { budgetIdParam } from '../lib/params';
import type { AppEnv } from '../types/hono';

/**
 * The final payee name + category for one imported row, applying the
 * layering described in docs/plan.md's PR 9 notes: a matching payee_rule
 * wins outright (matched against the FULL raw description, never a cleaned
 * name); otherwise the generic cleanPayeeName heuristic runs over the
 * provider's own best-effort name (or the raw text, if the provider has
 * none). Shared by every provider — this is what makes rules and the
 * heuristic apply to Wise imports exactly as they do to BECU's.
 */
function resolveImportPayee(
  rules: PayeeRule[],
  row: { payeeRaw: string | null; payeeName: string | null },
): { payeeName: string | null; ruleCategoryId: string | null } {
  const rawText = row.payeeRaw ?? '';
  const match = rawText !== '' ? matchPayeeRule(rules, rawText) : null;
  if (match) return { payeeName: match.payeeName, ruleCategoryId: match.categoryId };

  const bestEffort = row.payeeName ?? row.payeeRaw;
  return { payeeName: bestEffort ? cleanPayeeName(bestEffort) : null, ruleCategoryId: null };
}

// Statement files are small (a year of card activity is a few hundred rows,
// well under 100KB) so the CSV arrives as a plain JSON string field and is
// parsed inline. No R2, no multipart, no Queues — those are for the
// large-file path the plan defers, and adding them here would be
// infrastructure with nothing to do.
const MAX_CSV_BYTES = 2_000_000;

const importSchema = z.object({
  accountId: z.string().min(1),
  provider: z.string().min(1),
  filename: z.string().trim().min(1).max(255),
  csv: z.string().min(1).max(MAX_CSV_BYTES),
});

const reviewUpdateSchema = z.object({
  updates: z
    .array(
      z.object({
        transactionId: z.string().min(1),
        /** null clears the category; omitted leaves it as-is. */
        categoryId: z.string().min(1).nullable().optional(),
        approved: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(500),
});

/**
 * Finds the account holding `currencyCode` for this import, creating one if
 * the file turns out to touch a currency the user hasn't set up. Wise files
 * routinely draw on a second balance the user never thinks of as a separate
 * account, and failing the whole import to make them go create it by hand
 * would be a worse experience than creating it and saying so. Non-budget
 * currencies come out off-budget — see the note in src/routes/accounts.ts.
 */
async function resolveCurrencyAccount(
  db: Db,
  input: {
    budgetId: string;
    primaryAccount: { id: string; name: string; currencyCode: string; importProvider: string | null };
    currencyCode: string;
    provider: ImportProvider;
  },
  now: number,
): Promise<{ id: string; name: string; created: boolean }> {
  if (input.currencyCode === input.primaryAccount.currencyCode) {
    return { id: input.primaryAccount.id, name: input.primaryAccount.name, created: false };
  }

  const existing = await db
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .where(
      and(
        eq(accounts.budgetId, input.budgetId),
        eq(accounts.currencyCode, input.currencyCode),
        eq(accounts.importProvider, input.provider),
        isNull(accounts.deletedAt),
      ),
    )
    .limit(1);
  const found = existing[0];
  if (found) return { ...found, created: false };

  // Named after the account the user actually set up, so the pair reads as
  // one thing ("Wise" / "Wise (CAD)") in the sidebar.
  const name = `${input.primaryAccount.name} (${input.currencyCode})`;
  const id = ulid(now);
  await db.insert(accounts).values({
    id,
    budgetId: input.budgetId,
    name,
    type: 'tracking_asset',
    onBudget: false,
    currencyCode: input.currencyCode,
    importProvider: input.provider,
    createdAt: now,
    updatedAt: now,
  });
  return { id, name, created: true };
}

export const importsRoute = new Hono<AppEnv>();
importsRoute.use('*', requireBudgetMember('viewer'));

importsRoute.get('/providers', (c) => c.json({ providers: IMPORT_PROVIDERS }));

/**
 * Recent import runs, newest first — what DELETE /:batchId below actually
 * targets. Exists so a mistaken import (wrong account picked, wrong file)
 * can be found and undone from the UI at any point afterward, not only in
 * the one-time summary shown right after POST / — that summary disappears
 * the moment the user navigates away, which is exactly when a mistake is
 * often first noticed.
 */
importsRoute.get('/', async (c) => {
  const budgetId = budgetIdParam(c);
  const db = getDb(c.env);

  const rows = await db
    .select({
      id: importBatches.id,
      accountId: importBatches.accountId,
      accountName: accounts.name,
      provider: importBatches.provider,
      filename: importBatches.filename,
      rowCount: importBatches.rowCount,
      importedCount: importBatches.importedCount,
      skippedCount: importBatches.skippedCount,
      createdAt: importBatches.createdAt,
    })
    .from(importBatches)
    .innerJoin(accounts, eq(accounts.id, importBatches.accountId))
    .where(and(eq(importBatches.budgetId, budgetId), isNull(importBatches.deletedAt)))
    .orderBy(desc(importBatches.createdAt));

  return c.json({ batches: rows });
});

/**
 * The review queue: everything imported but not yet approved, across every
 * account in the budget. Ordered newest-first because that's what a user
 * catching up on an import wants to see.
 */
importsRoute.get('/review', async (c) => {
  const budgetId = budgetIdParam(c);
  const db = getDb(c.env);

  const rows = await db
    .select({
      id: transactions.id,
      date: transactions.date,
      amountMinor: transactions.amountMinor,
      currencyCode: transactions.currencyCode,
      categoryId: transactions.categoryId,
      memo: transactions.memo,
      accountId: transactions.accountId,
      accountName: accounts.name,
      payeeName: payees.name,
      importPayeeRaw: transactions.importPayeeRaw,
      transferAccountId: transactions.transferAccountId,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .leftJoin(payees, eq(payees.id, transactions.payeeId))
    .where(
      and(
        eq(transactions.budgetId, budgetId),
        eq(transactions.approved, false),
        isNull(transactions.deletedAt),
        isNull(transactions.parentTransactionId),
      ),
    )
    .orderBy(desc(transactions.date), desc(transactions.createdAt));

  return c.json({ transactions: rows });
});

importsRoute.patch('/review', requireBudgetMember('editor'), async (c) => {
  const budgetId = budgetIdParam(c);
  const parsed = reviewUpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const db = getDb(c.env);

  // Validate the whole batch before writing any of it — same rule as
  // PUT .../months/:month/assignments: a half-applied batch is worse than
  // a rejected one.
  const ids = parsed.data.updates.map((u) => u.transactionId);
  const owned = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.budgetId, budgetId), inArray(transactions.id, ids), isNull(transactions.deletedAt)));
  if (owned.length !== new Set(ids).size) return c.json({ error: 'invalid_transaction' }, 400);

  const categoryIds = parsed.data.updates
    .map((u) => u.categoryId)
    .filter((id): id is string => typeof id === 'string');
  if (categoryIds.length > 0) {
    const validCategories = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.budgetId, budgetId), inArray(categories.id, categoryIds), isNull(categories.deletedAt)));
    if (validCategories.length !== new Set(categoryIds).size) return c.json({ error: 'invalid_category' }, 400);
  }

  const now = Date.now();
  for (const update of parsed.data.updates) {
    const patch: { updatedAt: number; categoryId?: string | null; approved?: boolean } = { updatedAt: now };
    if (update.categoryId !== undefined) patch.categoryId = update.categoryId;
    if (update.approved !== undefined) patch.approved = update.approved;
    await db.update(transactions).set(patch).where(eq(transactions.id, update.transactionId));
  }

  return c.json({ status: 'ok', updated: parsed.data.updates.length });
});

importsRoute.post('/', requireBudgetMember('editor'), async (c) => {
  const budgetId = budgetIdParam(c);
  const parsed = importSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const input = parsed.data;

  if (!isImportProvider(input.provider)) return c.json({ error: 'unknown_provider' }, 400);
  const provider = input.provider;

  const db = getDb(c.env);
  const [budget] = await db.select({ currencyCode: budgets.currencyCode }).from(budgets).where(eq(budgets.id, budgetId)).limit(1);
  if (!budget) return c.json({ error: 'not_found' }, 404);

  const [primaryAccount] = await db
    .select({ id: accounts.id, name: accounts.name, currencyCode: accounts.currencyCode, importProvider: accounts.importProvider })
    .from(accounts)
    .where(and(eq(accounts.id, input.accountId), eq(accounts.budgetId, budgetId), isNull(accounts.deletedAt)))
    .limit(1);
  if (!primaryAccount) return c.json({ error: 'invalid_account' }, 400);

  let parseResult;
  try {
    parseResult = parseStatement(provider, input.csv);
  } catch {
    return c.json({ error: 'could_not_parse_file' }, 400);
  }

  const now = Date.now();
  const batchId = ulid(now);

  // Resolve every currency the file touches to an account up front, so a
  // half-done import can't leave rows stranded partway through.
  const accountByCurrency = new Map<string, { id: string; name: string; created: boolean }>();
  for (const currencyCode of parseResult.currencies) {
    accountByCurrency.set(
      currencyCode,
      await resolveCurrencyAccount(db, { budgetId, primaryAccount, currencyCode, provider }, now),
    );
  }

  // Skip rows already present from an earlier import of an overlapping
  // file. The partial unique index on (account_id, import_id) is the real
  // guarantee; checking first just lets us report the count honestly
  // instead of surfacing a constraint error.
  const existingImportIds = new Set(
    (
      await db
        .select({ importId: transactions.importId, accountId: transactions.accountId })
        .from(transactions)
        .where(and(eq(transactions.budgetId, budgetId), isNull(transactions.deletedAt)))
    )
      .filter((r) => r.importId !== null)
      .map((r) => `${r.accountId}:${r.importId}`),
  );

  // Rules and the generic naming heuristic apply to every provider, not
  // just the one that motivated them — see docs/plan.md's PR 9 notes and
  // resolveImportPayee above.
  const rules = await loadActivePayeeRules(db, budgetId);

  let imported = 0;
  let duplicates = 0;

  for (const row of parseResult.rows) {
    if (row.kind === 'ordinary') {
      const account = accountByCurrency.get(row.currencyCode);
      if (!account) continue;
      if (existingImportIds.has(`${account.id}:${row.importId}`)) {
        duplicates++;
        continue;
      }

      const resolved = resolveImportPayee(rules, row);
      const payeeId = resolved.payeeName ? await getOrCreatePayee(db, budgetId, resolved.payeeName, now) : null;
      // A user rule outranks the provider's own category guess — an
      // explicit rule is more intentional than a label the file happened
      // to carry.
      const suggestedName = suggestCategoryName(provider, row.providerCategory);
      const categoryId =
        resolved.ruleCategoryId ?? (suggestedName ? await findCategoryIdByName(db, budgetId, suggestedName) : null);

      await insertTransaction(
        db,
        {
          budgetId,
          accountId: account.id,
          date: row.date,
          amountMinor: row.amountMinor,
          currencyCode: row.currencyCode,
          // Equal to amountMinor by definition when the account is in the
          // budget's currency. For a foreign account it is NOT a real
          // conversion — but such accounts are off-budget, so this value
          // never reaches the ledger's sums (see src/routes/accounts.ts).
          budgetAmountMinor: row.amountMinor,
          categoryId,
          payeeId,
          memo: row.memo,
          cleared: 'cleared',
          importId: row.importId,
          importBatchId: batchId,
          importPayeeRaw: row.payeeRaw,
          approved: false,
        },
        now,
      );
      imported++;
      continue;
    }

    const fromAccount = accountByCurrency.get(row.fromCurrencyCode);
    const toAccount = accountByCurrency.get(row.toCurrencyCode);
    if (!fromAccount || !toAccount || fromAccount.id === toAccount.id) continue;
    if (existingImportIds.has(`${fromAccount.id}:${row.importId}:from`)) {
      duplicates++;
      continue;
    }

    await insertTransferPair(
      db,
      {
        budgetId,
        from: {
          accountId: fromAccount.id,
          currencyCode: row.fromCurrencyCode,
          amountMinor: row.fromAmountMinor,
          // The exchanged value is the OTHER leg's amount — the rate is the
          // ratio of the two legs, exactly as docs/plan.md describes, with
          // no rate table involved.
          budgetAmountMinor: row.toCurrencyCode === budget.currencyCode ? -row.toAmountMinor : row.fromAmountMinor,
          importId: `${row.importId}:from`,
        },
        fromPayeeId: await getOrCreateTransferPayee(db, budgetId, toAccount.id, toAccount.name, now),
        to: {
          accountId: toAccount.id,
          currencyCode: row.toCurrencyCode,
          amountMinor: row.toAmountMinor,
          budgetAmountMinor: row.toCurrencyCode === budget.currencyCode ? row.toAmountMinor : -row.fromAmountMinor,
          importId: `${row.importId}:to`,
        },
        toPayeeId: await getOrCreateTransferPayee(db, budgetId, fromAccount.id, fromAccount.name, now),
        date: row.date,
        memo: row.memo,
        cleared: 'cleared',
        importBatchId: batchId,
        approved: false,
      },
      now,
    );
    imported++;
  }

  await db.insert(importBatches).values({
    id: batchId,
    budgetId,
    accountId: primaryAccount.id,
    provider,
    filename: input.filename,
    rowCount: parseResult.rowCount,
    importedCount: imported,
    skippedCount: parseResult.skipped.length,
    createdAt: now,
  });

  return c.json(
    {
      batchId,
      rowCount: parseResult.rowCount,
      imported,
      duplicates,
      skipped: parseResult.skipped,
      accountsCreated: [...accountByCurrency.values()].filter((a) => a.created).map((a) => a.name),
    },
    201,
  );
});

/** Undoes a whole import. Import writes real rows, so this is the escape hatch when a file turns out to be wrong. */
importsRoute.delete('/:batchId', requireBudgetMember('editor'), async (c) => {
  const budgetId = budgetIdParam(c);
  const batchId = c.req.param('batchId');
  const db = getDb(c.env);

  const [batch] = await db
    .select({ id: importBatches.id })
    .from(importBatches)
    .where(and(eq(importBatches.id, batchId), eq(importBatches.budgetId, budgetId), isNull(importBatches.deletedAt)))
    .limit(1);
  if (!batch) return c.json({ error: 'not_found' }, 404);

  const now = Date.now();
  await db
    .update(transactions)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(transactions.budgetId, budgetId), eq(transactions.importBatchId, batchId), isNull(transactions.deletedAt)));
  await db.update(importBatches).set({ deletedAt: now }).where(eq(importBatches.id, batchId));

  return c.json({ status: 'ok' });
});

async function findCategoryIdByName(db: Db, budgetId: string, name: string): Promise<string | null> {
  const [row] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.budgetId, budgetId), eq(categories.name, name), isNull(categories.deletedAt)))
    .limit(1);
  return row?.id ?? null;
}

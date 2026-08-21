import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
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
import { convertToBudgetMinor, parseFxRateToMicros } from '../lib/money';
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

// Per-provider import choices — currently just Splitwise's "whose expenses
// belong to this budget" (src/import/splitwise.ts's ImportOptions). Kept
// permissive at the schema level (members is optional here); providers
// that need it non-empty enforce that themselves below, so a provider that
// doesn't use options at all is never forced to send this field.
const importOptionsSchema = z.object({
  members: z.array(z.string().min(1)).optional(),
});

const importSchema = z.object({
  accountId: z.string().min(1),
  provider: z.string().min(1),
  filename: z.string().trim().min(1).max(255),
  csv: z.string().min(1).max(MAX_CSV_BYTES),
  options: importOptionsSchema.optional(),
  // Budget-currency-per-1-unit-of-account-currency, e.g. "0.73" — an
  // account property, not a parser choice (unlike `options` above), so it
  // sits at the top level and is remembered on accounts.fxRateMicros
  // directly rather than inside the importOptions JSON blob. See
  // src/routes/accounts.ts's fxRate handling, which this mirrors.
  fxRate: z.string().trim().optional(),
  // 'YYYY-MM-DD'. Rows dated before this are skipped instead of written.
  // Like fxRate, a budget property rather than a parser choice: supplying
  // one both applies it to THIS import and remembers it on the budget as
  // the default for every later one. Explicit null clears it.
  cutoffDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
    .nullable()
    .optional(),
});

const inspectSchema = z.object({
  provider: z.string().min(1),
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
 * Parses a file WITHOUT writing anything, so the UI can show provider-
 * specific choices (currently: Splitwise's per-person columns) before
 * committing to a real import. Calling parseStatement with no options is
 * safe for every provider — Wise/BECU ignore the argument entirely, and
 * Splitwise itself is inert without a member selection (every row's net
 * is 0 against an empty selection, so nothing is ever written even if this
 * result were mistakenly fed to POST / directly).
 */
importsRoute.post('/inspect', requireBudgetMember('editor'), async (c) => {
  const parsed = inspectSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const input = parsed.data;

  if (!isImportProvider(input.provider)) return c.json({ error: 'unknown_provider' }, 400);

  let parseResult;
  try {
    parseResult = parseStatement(input.provider, input.csv);
  } catch {
    return c.json({ error: 'could_not_parse_file' }, 400);
  }

  return c.json({ participants: parseResult.participants ?? [], rowCount: parseResult.rowCount });
});

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

/** Hard cap on how many rows /review returns in one page — see the includeApproved note below. */
const REVIEW_ROW_LIMIT = 500;

/**
 * The review queue: everything imported but not yet approved, across every
 * account in the budget — plus, with `?includeApproved=true`, every OTHER
 * transaction too, for catching a mistake that already slipped past
 * approval (an uncategorized starting balance, a miscategorized purchase).
 * That mode is a superset of the default, not a different screen: same
 * columns, same edit affordances, just a wider `approved` filter.
 *
 * Ordered newest-first because that's what a user catching up wants to
 * see, and capped at REVIEW_ROW_LIMIT for the same reason the register
 * list caps at 500 — an unbounded whole-budget query has no natural upper
 * bound the way one account's history does.
 */
importsRoute.get('/review', async (c) => {
  const budgetId = budgetIdParam(c);
  const db = getDb(c.env);
  const includeApproved = c.req.query('includeApproved') === 'true';

  // The other half of a transfer, and the account it sits in. "(transfer)"
  // alone told the user a row was linked but not to WHAT, which is the one
  // thing worth confirming about a transfer — and it matters more since
  // the two legs need not be equal any more: they differ by a conversion
  // rate, or by a fee taken in transit (see src/routes/transactions.ts's
  // sameCurrencyFeeMinor). Seeing "-1900.00 CAD -> Wise CAD +1900.00 CAD"
  // is what makes a mislink obvious.
  const counterpart = alias(transactions, 'counterpart');
  const counterpartAccount = alias(accounts, 'counterpart_account');
  // The transfer leg a FEE row was carved out of — same question ("what
  // is this attached to?") for the rows that aren't transfers themselves.
  const feeParent = alias(transactions, 'fee_parent');
  const feeParentAccount = alias(accounts, 'fee_parent_account');

  const rows = await db
    .select({
      id: transactions.id,
      date: transactions.date,
      amountMinor: transactions.amountMinor,
      currencyCode: transactions.currencyCode,
      categoryId: transactions.categoryId,
      memo: transactions.memo,
      cleared: transactions.cleared,
      approved: transactions.approved,
      accountId: transactions.accountId,
      accountName: accounts.name,
      payeeName: payees.name,
      importPayeeRaw: transactions.importPayeeRaw,
      transferAccountId: transactions.transferAccountId,
      transferAccountName: counterpartAccount.name,
      transferDate: counterpart.date,
      transferAmountMinor: counterpart.amountMinor,
      transferCurrencyCode: counterpart.currencyCode,
      feeForAccountName: feeParentAccount.name,
      feeForDate: feeParent.date,
      feeForAmountMinor: feeParent.amountMinor,
      feeForCurrencyCode: feeParent.currencyCode,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .leftJoin(payees, eq(payees.id, transactions.payeeId))
    .leftJoin(counterpart, eq(counterpart.id, transactions.transferTransactionId))
    .leftJoin(counterpartAccount, eq(counterpartAccount.id, counterpart.accountId))
    .leftJoin(feeParent, eq(feeParent.id, transactions.feeForTransactionId))
    .leftJoin(feeParentAccount, eq(feeParentAccount.id, feeParent.accountId))
    .where(
      and(
        eq(transactions.budgetId, budgetId),
        includeApproved ? undefined : eq(transactions.approved, false),
        isNull(transactions.deletedAt),
        isNull(transactions.parentTransactionId),
      ),
    )
    .orderBy(desc(transactions.date), desc(transactions.createdAt))
    .limit(REVIEW_ROW_LIMIT);

  // A split PARENT has categoryId === null by construction (its children
  // carry the real per-category portions — see src/domain/ledger.ts), so
  // without this it would render as just another uncategorized row. Only
  // reachable via includeApproved: imports never produce splits, and a
  // manually-entered split is approved outright, so the default
  // (unapproved-only) query never sees one.
  const splitParentIds = includeApproved
    ? new Set(
        (
          await db
            .select({ parentTransactionId: transactions.parentTransactionId })
            .from(transactions)
            .where(and(eq(transactions.budgetId, budgetId), isNull(transactions.deletedAt)))
        )
          .map((r) => r.parentTransactionId)
          .filter((id): id is string => id !== null),
      )
    : new Set<string>();

  return c.json({ transactions: rows.map((r) => ({ ...r, isSplit: splitParentIds.has(r.id) })) });
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

  // Splitwise's file has no fixed participant list of its own — a member
  // selection is the only thing that says which people's expenses belong
  // to THIS budget. Importing with none selected would write nothing
  // silently (every row's net is 0), which is worse than rejecting it
  // outright — see src/import/splitwise.ts.
  if (provider === 'splitwise' && (input.options?.members?.length ?? 0) === 0) {
    return c.json({ error: 'invalid_options' }, 400);
  }

  const db = getDb(c.env);
  const [budget] = await db
    .select({ currencyCode: budgets.currencyCode, importCutoffDate: budgets.importCutoffDate })
    .from(budgets)
    .where(eq(budgets.id, budgetId))
    .limit(1);
  if (!budget) return c.json({ error: 'not_found' }, 404);

  const [primaryAccount] = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      currencyCode: accounts.currencyCode,
      importProvider: accounts.importProvider,
      onBudget: accounts.onBudget,
      fxRateMicros: accounts.fxRateMicros,
    })
    .from(accounts)
    .where(and(eq(accounts.id, input.accountId), eq(accounts.budgetId, budgetId), isNull(accounts.deletedAt)))
    .limit(1);
  if (!primaryAccount) return c.json({ error: 'invalid_account' }, 400);

  // A rate typed in for THIS import overrides (and, below, updates) the
  // one remembered on the account; otherwise fall back to that remembered
  // rate. Only meaningful when the account's own currency differs from the
  // budget's — see src/routes/accounts.ts's identical fxRate handling,
  // which this mirrors rather than reimplements independently.
  let suppliedFxRateMicros: number | undefined;
  if (input.fxRate !== undefined) {
    try {
      suppliedFxRateMicros = parseFxRateToMicros(input.fxRate);
    } catch {
      return c.json({ error: 'invalid_fx_rate' }, 400);
    }
  }
  const isPrimaryForeign = primaryAccount.currencyCode !== budget.currencyCode;
  const effectiveFxRateMicros = suppliedFxRateMicros ?? primaryAccount.fxRateMicros ?? undefined;
  // An on-budget foreign account with no rate anywhere shouldn't be
  // reachable (account creation requires one to go on-budget in the first
  // place — see src/routes/accounts.ts) but is checked explicitly rather
  // than assumed, since a rate can be cleared later via PATCH. Never fall
  // back to native-as-budget here — that's the exact bug this PR exists
  // to close.
  if (isPrimaryForeign && primaryAccount.onBudget && effectiveFxRateMicros === undefined) {
    return c.json({ error: 'missing_fx_rate' }, 400);
  }

  let parseResult;
  try {
    parseResult = parseStatement(provider, input.csv, input.options);
  } catch {
    return c.json({ error: 'could_not_parse_file' }, 400);
  }

  // A cutoff typed in for THIS import overrides (and, below, updates) the
  // one remembered on the budget; otherwise fall back to that remembered
  // one. Explicit null means "clear it", which is distinct from omitting
  // the field — hence the `!== undefined` test rather than a truthiness
  // check. Same shape as the fxRate handling above.
  const effectiveCutoffDate = input.cutoffDate !== undefined ? input.cutoffDate : budget.importCutoffDate;

  // Drop everything dated before the cutoff, BEFORE any account is
  // resolved or any row written — a bank export routinely carries far
  // more history than the window the user actually wanted, and every one
  // of those rows would otherwise land as a real transaction moving
  // balances and Ready to Assign.
  //
  // Skipped rather than silently dropped: they join parseResult.skipped
  // with a reason naming the cutoff, so the import summary says what
  // happened and why. A guard that quietly discards data is its own kind
  // of bug — the same reasoning as the parsers' own skip reporting (see
  // src/import/wise.ts).
  let beforeCutoff = 0;
  if (effectiveCutoffDate !== null && effectiveCutoffDate !== undefined) {
    const cutoff = effectiveCutoffDate;
    const kept = [];
    for (const row of parseResult.rows) {
      // Plain string comparison: both sides are 'YYYY-MM-DD', which sorts
      // lexicographically exactly as it does chronologically. The cutoff
      // date itself is KEPT — "prior to which it will not import" — so
      // setting it to the budget's start date imports that day's rows.
      if (row.date >= cutoff) {
        kept.push(row);
        continue;
      }
      beforeCutoff++;
      parseResult.skipped.push({
        reference: row.kind === 'ordinary' ? (row.payeeRaw ?? row.payeeName ?? row.importId) : row.importId,
        reason: `dated ${row.date}, before the ${cutoff} cutoff`,
      });
    }
    parseResult.rows = kept;
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

  // The rate to convert each destination account's rows with. The primary
  // uses the rate supplied for THIS import (falling back to its stored
  // one); every other account uses its own stored rate. Keyed by account
  // id so a row is converted by where it LANDS, which is not always the
  // account the user picked — see resolveCurrencyAccount.
  const rateByAccountId = new Map<string, number>();
  for (const [currencyCode, resolved] of accountByCurrency) {
    if (currencyCode === budget.currencyCode) continue; // no conversion needed
    if (resolved.id === primaryAccount.id) {
      if (effectiveFxRateMicros !== undefined) rateByAccountId.set(resolved.id, effectiveFxRateMicros);
      continue;
    }
    const [target] = await db
      .select({ fxRateMicros: accounts.fxRateMicros })
      .from(accounts)
      .where(eq(accounts.id, resolved.id))
      .limit(1);
    if (target?.fxRateMicros != null) rateByAccountId.set(resolved.id, target.fxRateMicros);
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
          // Equal to amountMinor when the account is in the budget's
          // currency, converted by whatever rate belongs to the account
          // the row LANDS in — which is not always the account the user
          // picked (see resolveCurrencyAccount and rateByAccountId).
          //
          // This deliberately covers secondary currency sub-accounts too.
          // It originally covered only the primary, on the reasoning that
          // a sub-account is "always off-budget so an unconverted value
          // never reaches category math". Both halves of that stopped
          // being true: an account can now be moved on-budget after the
          // fact, and net worth revalues from native amounts anyway. A
          // sub-account also only ever received TRANSFER legs back then,
          // which carry their own derived value — until the Wise
          // direction fix (src/import/wise.ts) made a top-up land here as
          // an ordinary row, at which point an unconverted CAD figure
          // would have been counted as budget-currency dollars outright.
          budgetAmountMinor: (() => {
            const rate = rateByAccountId.get(account.id);
            return rate !== undefined ? convertToBudgetMinor(row.amountMinor, rate) : row.amountMinor;
          })(),
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

  // Remembered so the next import against this account pre-fills the same
  // choice instead of re-asking from scratch — see migrations/0006 and
  // web/src/components/ImportForm.tsx. The rate is a real account column
  // (accounts.fxRateMicros — migrations/0007), not part of this JSON blob,
  // but is updated in the same place for the same reason.
  if (input.options || suppliedFxRateMicros !== undefined) {
    const patch: { updatedAt: number; importOptions?: string; fxRateMicros?: number } = { updatedAt: now };
    if (input.options) patch.importOptions = JSON.stringify(input.options);
    if (suppliedFxRateMicros !== undefined) patch.fxRateMicros = suppliedFxRateMicros;
    await db.update(accounts).set(patch).where(eq(accounts.id, primaryAccount.id));
  }

  // The cutoff is remembered on the BUDGET, not the account: "before I
  // started budgeting" is one date for the whole budget, and making it a
  // per-account setting would mean re-establishing it for every new
  // account — the same forgetting this exists to prevent.
  if (input.cutoffDate !== undefined && input.cutoffDate !== budget.importCutoffDate) {
    await db.update(budgets).set({ importCutoffDate: input.cutoffDate }).where(eq(budgets.id, budgetId));
  }

  return c.json(
    {
      batchId,
      rowCount: parseResult.rowCount,
      imported,
      duplicates,
      /** How many rows the cutoff held back, and the cutoff that did it — reported separately from `skipped` so the UI can call it out as the deliberate guard it is, not a parsing problem. */
      beforeCutoff,
      cutoffDate: effectiveCutoffDate ?? null,
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

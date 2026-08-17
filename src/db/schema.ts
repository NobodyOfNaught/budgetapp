// Drizzle schema — source of truth for the database structure.
//
// Two rules govern this file, from the project plan:
//  1. Every user-data (budget-scoped) table carries `budgetId`, and no query
//     joins across budgets. That single constraint is what makes sharing,
//     sharding, and per-tenant migration all tractable later.
//  2. New capabilities arrive as new tables, not new columns on hot tables.
//     `transactions` in particular carries a few columns today that the MVP
//     barely uses, because adding them later (after the table has millions
//     of rows) is expensive and adding a table later is free.
//
// migrations/0000_init.sql is the hand-authored SQL that creates this exact
// structure (including CHECK constraints, which drizzle-kit's D1 diffing
// does not always round-trip reliably). Keep the two in sync by hand; this
// file is what application code imports and queries against.

import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// ---------------------------------------------------------------------------
// Identity & access
// ---------------------------------------------------------------------------

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  emailNormalized: text('email_normalized').notNull().unique(),
  displayName: text('display_name'),
  createdAt: integer('created_at').notNull(),
  lastLoginAt: integer('last_login_at'),
});

export const authTokens = sqliteTable(
  'auth_tokens',
  {
    id: text('id').primaryKey(),
    emailNormalized: text('email_normalized').notNull(),
    tokenHash: text('token_hash').notNull(),
    // What the token authorizes: signing in, and later e.g. an invite accept.
    purpose: text('purpose', { enum: ['magic_link'] }).notNull(),
    // Hash of the short-lived `challenge` cookie set alongside the emailed
    // link, so the redeeming request can be tied to the browser that asked.
    challengeHash: text('challenge_hash').notNull(),
    expiresAt: integer('expires_at').notNull(),
    consumedAt: integer('consumed_at'),
    createdIp: text('created_ip'),
    createdUa: text('created_ua'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('auth_tokens_email_idx').on(t.emailNormalized),
    uniqueIndex('auth_tokens_token_hash_idx').on(t.tokenHash),
  ],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(), // opaque 256-bit random token, not a JWT — revocable
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    expiresAt: integer('expires_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
    revokedAt: integer('revoked_at'),
    userAgent: text('user_agent'),
    ip: text('ip'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const budgets = sqliteTable('budgets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  currencyCode: text('currency_code').notNull(), // ISO 4217, e.g. "CAD"
  createdAt: integer('created_at').notNull(),
  deletedAt: integer('deleted_at'),
  // Per-budget monotonic counter, bumped on every mutation to budget-scoped
  // data. Lets a client ask "what changed since revision N" — the delta-sync
  // primitive shared budgets need later. Impossible to add after the fact
  // once rows are hard-deleted, so soft deletes (deletedAt) go everywhere.
  revision: integer('revision').notNull().default(0),
});

// Every authorization check reads this table, even though the MVP only ever
// writes a single 'owner' row per budget. Sharing later is an invite table
// plus UI — no authorization code path changes.
export const budgetMembers = sqliteTable(
  'budget_members',
  {
    budgetId: text('budget_id')
      .notNull()
      .references(() => budgets.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role', { enum: ['owner', 'editor', 'viewer'] }).notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.budgetId, t.userId] }),
    index('budget_members_user_idx').on(t.userId),
  ],
);

// ---------------------------------------------------------------------------
// Budget data
// ---------------------------------------------------------------------------

export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    budgetId: text('budget_id')
      .notNull()
      .references(() => budgets.id),
    name: text('name').notNull(),
    type: text('type', {
      enum: [
        'checking',
        'savings',
        'cash',
        'credit_card',
        'line_of_credit',
        'tracking_asset',
        'tracking_liability',
      ],
    }).notNull(),
    onBudget: integer('on_budget', { mode: 'boolean' }).notNull(),
    // Present and enforced from day one — the multi-currency seam. The MVP
    // defaults every account to the budget's currency and the UI never
    // offers anything else; the column just has to already exist.
    currencyCode: text('currency_code').notNull(),
    closedAt: integer('closed_at'),
    sortOrder: integer('sort_order').notNull().default(0),
    note: text('note'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => [index('accounts_budget_idx').on(t.budgetId)],
);

export const payees = sqliteTable(
  'payees',
  {
    id: text('id').primaryKey(),
    budgetId: text('budget_id')
      .notNull()
      .references(() => budgets.id),
    name: text('name').notNull(),
    // Set when this payee represents "Transfer : <account>" — lets the UI
    // offer transfers through the same payee-picker as ordinary payees.
    transferAccountId: text('transfer_account_id').references(() => accounts.id),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => [index('payees_budget_idx').on(t.budgetId)],
);

export const categoryGroups = sqliteTable(
  'category_groups',
  {
    id: text('id').primaryKey(),
    budgetId: text('budget_id')
      .notNull()
      .references(() => budgets.id),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    isSystem: integer('is_system', { mode: 'boolean' }).notNull().default(false),
    hiddenAt: integer('hidden_at'),
    deletedAt: integer('deleted_at'),
  },
  (t) => [index('category_groups_budget_idx').on(t.budgetId)],
);

export const categories = sqliteTable(
  'categories',
  {
    id: text('id').primaryKey(),
    budgetId: text('budget_id')
      .notNull()
      .references(() => budgets.id),
    groupId: text('group_id')
      .notNull()
      .references(() => categoryGroups.id),
    name: text('name').notNull(),
    // 'credit_card_payment' categories are auto-created and auto-managed by
    // the ledger engine, one per credit account (linkedAccountId). See
    // src/domain for the carryover and earmarking rules that depend on kind.
    kind: text('kind', { enum: ['spending', 'credit_card_payment', 'income'] })
      .notNull()
      .default('spending'),
    linkedAccountId: text('linked_account_id').references(() => accounts.id),
    sortOrder: integer('sort_order').notNull().default(0),
    note: text('note'),
    hiddenAt: integer('hidden_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => [
    index('categories_budget_idx').on(t.budgetId),
    index('categories_group_idx').on(t.groupId),
  ],
);

// Stores ONLY what the user typed (assignedMinor). Activity and Available
// are always derived from transactions — never stored — so there is no
// cache to invalidate and no way for the displayed budget to disagree with
// the ledger behind it. See src/domain for the derivation.
export const categoryMonths = sqliteTable(
  'category_months',
  {
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id),
    month: text('month').notNull(), // 'YYYY-MM-01'
    budgetId: text('budget_id')
      .notNull()
      .references(() => budgets.id),
    assignedMinor: integer('assigned_minor').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.categoryId, t.month] }),
    index('category_months_budget_month_idx').on(t.budgetId, t.month),
  ],
);

// The hot table. Every column here is deliberate — see the plan's
// "Transactions — the hot table" section for why budgetAmountMinor,
// importId, and revision exist even though the MVP barely exercises them.
export const transactions = sqliteTable(
  'transactions',
  {
    id: text('id').primaryKey(),
    budgetId: text('budget_id')
      .notNull()
      .references(() => budgets.id),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    date: text('date').notNull(), // 'YYYY-MM-DD', a calendar date not an instant
    // Signed, in the ACCOUNT's own currency. Outflow negative, inflow positive.
    amountMinor: integer('amount_minor').notNull(),
    // Denormalized and immutable per row — which currency amountMinor is in.
    currencyCode: text('currency_code').notNull(),
    // amountMinor converted to the budget's display currency at THIS
    // transaction's own rate. Equals amountMinor until multi-currency ships.
    // All budget math sums this column, never amountMinor, so turning on
    // multi-currency later changes only what gets written at transaction
    // creation time — the ledger engine and every report already sum the
    // right column and never need to change.
    budgetAmountMinor: integer('budget_amount_minor').notNull(),
    payeeId: text('payee_id').references(() => payees.id),
    categoryId: text('category_id').references(() => categories.id),
    memo: text('memo'),
    cleared: text('cleared', { enum: ['uncleared', 'cleared', 'reconciled'] })
      .notNull()
      .default('uncleared'),
    approved: integer('approved', { mode: 'boolean' }).notNull().default(true),
    flagColor: text('flag_color'),
    // A transfer is two rows linked by transferTransactionId, each in its
    // own account's currency. The effective FX rate IS the ratio of the two
    // legs' amounts — no rate table needed for the "conversion rate from the
    // actual transaction" behaviour.
    transferTransactionId: text('transfer_transaction_id'),
    transferAccountId: text('transfer_account_id').references(() => accounts.id),
    parentTransactionId: text('parent_transaction_id'), // split sub-transactions
    // Bank-provided FITID or a content hash, set by statement import (later).
    // Paired with the partial unique index below, re-importing an
    // overlapping statement becomes an idempotent upsert, not a dedup project.
    importId: text('import_id'),
    importBatchId: text('import_batch_id'),
    importPayeeRaw: text('import_payee_raw'),
    scheduledTransactionId: text('scheduled_transaction_id'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
    revision: integer('revision').notNull().default(0),
  },
  (t) => [
    index('transactions_budget_account_date_idx').on(t.budgetId, t.accountId, t.date),
    index('transactions_budget_category_date_idx').on(t.budgetId, t.categoryId, t.date),
    index('transactions_transfer_idx').on(t.transferTransactionId),
    index('transactions_parent_idx').on(t.parentTransactionId),
    index('transactions_budget_revision_idx').on(t.budgetId, t.revision),
    uniqueIndex('transactions_account_import_idx')
      .on(t.accountId, t.importId)
      .where(sql`${t.importId} is not null`),
  ],
);

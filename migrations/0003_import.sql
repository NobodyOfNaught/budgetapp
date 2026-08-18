-- Statement import (PR 7). Two additive changes, both safe under the
-- expand/contract rule that governs this repo (see the plan's "Guarding the
-- shared production database"): one new table, one new nullable column.
--
-- import_batches records a single import run so that undoing one is a
-- single query against transactions.import_batch_id, rather than guessing
-- which rows came from which file. It records skipped_count as well as
-- imported_count on purpose — the Wise parser deliberately skips reversed
-- transfers and non-completed statuses, and a parser that drops rows
-- silently is worse than one that reports it.
--
-- accounts.import_provider just remembers which parser an account's files
-- use, so a repeat import doesn't have to re-ask. Nothing keys off it.
--
-- Everything else statement import needs already exists from 0000_init.sql:
-- transactions.import_id / import_batch_id / import_payee_raw / approved,
-- and the partial unique index transactions_account_import_idx that makes
-- re-importing an overlapping statement idempotent.

CREATE TABLE import_batches (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL REFERENCES budgets (id),
  account_id TEXT NOT NULL REFERENCES accounts (id),
  provider TEXT NOT NULL,
  filename TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  imported_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX import_batches_budget_idx ON import_batches (budget_id);

ALTER TABLE accounts ADD COLUMN import_provider TEXT;

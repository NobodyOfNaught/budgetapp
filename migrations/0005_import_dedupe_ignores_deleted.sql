-- Fixes a real bug surfaced by using the undo-import feature (PR 9's
-- undo-in-the-UI addition) for the first time: transactions_account_import_idx
-- (0000_init.sql) enforces (account_id, import_id) uniqueness across EVERY
-- row, including soft-deleted ones. Every other place in this app treats a
-- soft-deleted row as gone — including src/routes/imports.ts's own
-- pre-insert duplicate check, which already filters `deleted_at IS NULL`.
-- The index just never agreed: undo an import (sets deleted_at, doesn't
-- touch import_id), then re-import the same file to the same account, and
-- the very first row's INSERT hits a real UNIQUE constraint violation
-- against its own soft-deleted predecessor — an uncaught exception, since
-- the app believed (correctly, everywhere else) that a deleted row can't
-- collide with anything.
--
-- Rebuilding the index to also require `deleted_at IS NULL` only ever
-- LOOSENS what it blocks — nothing running today relies on a soft-deleted
-- row continuing to occupy its uniqueness slot, so this is safe under the
-- same expand/contract reasoning as any other additive migration despite
-- being an index change rather than a new column or table.
DROP INDEX transactions_account_import_idx;
CREATE UNIQUE INDEX transactions_account_import_idx
  ON transactions (account_id, import_id)
  WHERE import_id IS NOT NULL AND deleted_at IS NULL;

-- category_groups was the one table in 0000_init.sql missing created_at /
-- updated_at, an inconsistency with every other table (accounts, payees,
-- categories, transactions). Caught while building category_groups CRUD in
-- PR 4 — fixed here rather than carried forward.
--
-- SQLite's ALTER TABLE requires a non-NULL DEFAULT for a NOT NULL column
-- add. The table is empty in every environment (verified before writing
-- this migration — nothing has ever inserted a category_groups row yet),
-- so the literal 0 default below is never actually read by real data; the
-- application always supplies a real epoch-millis value on insert, exactly
-- like every other table's created_at/updated_at.

ALTER TABLE category_groups ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE category_groups ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;

-- category_targets: a category's funding obligation (amount, and how
-- often/when it's needed). See src/domain/targets.ts for the derivation
-- this feeds — "how much should I assign this month" and "when is this
-- next due" — and the plan's PR 6 notes for why it's a new table rather
-- than columns on categories or category_months: assigned/available stay a
-- record of what actually happened, while a target is a separate standing
-- rule layered on top.
--
-- (interval_unit, interval_count) covers monthly refills, "every N weeks",
-- quarterly/annual bills, and one-time-by-date or open-ended savings goals
-- with two small fields instead of a sprawling enum — see schema.ts's
-- comment on categoryTargets for the full mapping.
--
-- At most one live target per category, enforced by the partial unique
-- index below (not application code) — the same idiom as
-- transactions_account_import_idx.

CREATE TABLE category_targets (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL REFERENCES budgets (id),
  category_id TEXT NOT NULL REFERENCES categories (id),
  amount_minor INTEGER NOT NULL,
  interval_unit TEXT NOT NULL DEFAULT 'month'
    CHECK (interval_unit IN ('week', 'month', 'year', 'once')),
  interval_count INTEGER NOT NULL DEFAULT 1,
  due_date TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX category_targets_budget_idx ON category_targets (budget_id);
CREATE UNIQUE INDEX category_targets_category_idx
  ON category_targets (category_id)
  WHERE deleted_at IS NULL;

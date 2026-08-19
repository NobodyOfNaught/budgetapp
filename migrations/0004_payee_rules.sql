-- User-defined payee rules (PR 9). One additive table, safe under the
-- expand/contract rule (see the plan's "Guarding the shared production
-- database") — nothing running on `main` today references it.
--
-- A rule overrides the generic payee-naming heuristic (src/import/payee-name.ts)
-- for statement rows whose raw description contains match_text. Optionally
-- also sets a category, which matters most for providers like BECU that
-- carry no category column of their own at all. Rules are matched against
-- the FULL verbatim description (transactions.import_payee_raw), never
-- against the heuristic's own output, so a rule can recover anything the
-- heuristic discarded. Applied at the route layer (src/routes/imports.ts),
-- so every provider gets rules, not just the one that motivated them.
CREATE TABLE payee_rules (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL REFERENCES budgets (id),
  match_text TEXT NOT NULL,
  payee_name TEXT NOT NULL,
  category_id TEXT REFERENCES categories (id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX payee_rules_budget_idx ON payee_rules (budget_id);

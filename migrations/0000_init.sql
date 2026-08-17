-- Initial schema. Hand-authored to mirror src/db/schema.ts exactly, including
-- CHECK constraints and the partial unique index that drizzle-kit's D1
-- diffing does not always round-trip reliably. Keep the two in sync by hand.
--
-- See the project plan for the reasoning behind budget_amount_minor,
-- import_id, and revision on `transactions`, and for why every budget-scoped
-- table carries budget_id with no cross-budget joins.

-- ---------------------------------------------------------------------------
-- Identity & access
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL,
  display_name TEXT,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE UNIQUE INDEX users_email_normalized_idx ON users (email_normalized);

CREATE TABLE auth_tokens (
  id TEXT PRIMARY KEY,
  email_normalized TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('magic_link')),
  challenge_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_ip TEXT,
  created_ua TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX auth_tokens_email_idx ON auth_tokens (email_normalized);
CREATE UNIQUE INDEX auth_tokens_token_hash_idx ON auth_tokens (token_hash);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER,
  user_agent TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE budgets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  currency_code TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE budget_members (
  budget_id TEXT NOT NULL REFERENCES budgets (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (budget_id, user_id)
);
CREATE INDEX budget_members_user_idx ON budget_members (user_id);

-- ---------------------------------------------------------------------------
-- Budget data
-- ---------------------------------------------------------------------------

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL REFERENCES budgets (id),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'checking', 'savings', 'cash', 'credit_card', 'line_of_credit',
    'tracking_asset', 'tracking_liability'
  )),
  on_budget INTEGER NOT NULL,
  currency_code TEXT NOT NULL,
  closed_at INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX accounts_budget_idx ON accounts (budget_id);

CREATE TABLE payees (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL REFERENCES budgets (id),
  name TEXT NOT NULL,
  transfer_account_id TEXT REFERENCES accounts (id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX payees_budget_idx ON payees (budget_id);

CREATE TABLE category_groups (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL REFERENCES budgets (id),
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_system INTEGER NOT NULL DEFAULT 0,
  hidden_at INTEGER,
  deleted_at INTEGER
);
CREATE INDEX category_groups_budget_idx ON category_groups (budget_id);

CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL REFERENCES budgets (id),
  group_id TEXT NOT NULL REFERENCES category_groups (id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'spending'
    CHECK (kind IN ('spending', 'credit_card_payment', 'income')),
  linked_account_id TEXT REFERENCES accounts (id),
  sort_order INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  hidden_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX categories_budget_idx ON categories (budget_id);
CREATE INDEX categories_group_idx ON categories (group_id);

CREATE TABLE category_months (
  category_id TEXT NOT NULL REFERENCES categories (id),
  month TEXT NOT NULL,
  budget_id TEXT NOT NULL REFERENCES budgets (id),
  assigned_minor INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (category_id, month)
);
CREATE INDEX category_months_budget_month_idx ON category_months (budget_id, month);

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL REFERENCES budgets (id),
  account_id TEXT NOT NULL REFERENCES accounts (id),
  date TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency_code TEXT NOT NULL,
  budget_amount_minor INTEGER NOT NULL,
  payee_id TEXT REFERENCES payees (id),
  category_id TEXT REFERENCES categories (id),
  memo TEXT,
  cleared TEXT NOT NULL DEFAULT 'uncleared'
    CHECK (cleared IN ('uncleared', 'cleared', 'reconciled')),
  approved INTEGER NOT NULL DEFAULT 1,
  flag_color TEXT,
  transfer_transaction_id TEXT,
  transfer_account_id TEXT REFERENCES accounts (id),
  parent_transaction_id TEXT,
  import_id TEXT,
  import_batch_id TEXT,
  import_payee_raw TEXT,
  scheduled_transaction_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX transactions_budget_account_date_idx ON transactions (budget_id, account_id, date);
CREATE INDEX transactions_budget_category_date_idx ON transactions (budget_id, category_id, date);
CREATE INDEX transactions_transfer_idx ON transactions (transfer_transaction_id);
CREATE INDEX transactions_parent_idx ON transactions (parent_transaction_id);
CREATE INDEX transactions_budget_revision_idx ON transactions (budget_id, revision);
CREATE UNIQUE INDEX transactions_account_import_idx
  ON transactions (account_id, import_id)
  WHERE import_id IS NOT NULL;

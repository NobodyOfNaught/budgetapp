-- Stored provider credentials (PR 27). One additive table, safe under the
-- expand/contract rule (see the plan's "Guarding the shared production
-- database") — nothing running on `main` today references it.
--
-- WHY THIS IS NOT A WORKER SECRET. The obvious place for a Wise API token
-- is `wrangler secret put`, and that was the first attempt. It is wrong
-- here: a Worker secret is ONE global value for the whole deployment, while
-- a Wise token identifies ONE person's bank account. This app is
-- multi-user (see budget_members and its owner/editor/viewer roles), so a
-- secret-held token would mean every user of the deployment reading the
-- same person's transactions. Credentials therefore live per connection,
-- scoped to a budget, exactly as accounts and payee_rules are.
--
-- WHAT IS STORED. Never the token. `credential_ciphertext` is the token
-- encrypted with AES-256-GCM (see src/lib/crypto.ts) under an app-level key
-- held in the CREDENTIALS_KEY Worker secret, with a fresh random
-- `credential_iv` per encryption — reusing an IV under one key is the
-- classic way to break GCM, so it is stored per row rather than derived.
--
-- CREDENTIALS_KEY is itself a global Worker secret, which is legitimate for
-- exactly the reason a token is not: it is app infrastructure, not
-- anybody's identity. It makes each person's token per-connection
-- ciphertext instead of a shared global. Rotating it invalidates every
-- stored credential, which is recoverable — the user re-enters them — and
-- is the correct blast radius.
--
-- No API ever returns a decrypted credential. The read path exposes only
-- metadata (label, provider, when it was last used), so a stored token can
-- be replaced but never retrieved, including by an owner. `last_used_at`
-- exists so an unused or stale connection is visible rather than silently
-- rotting.
CREATE TABLE import_connections (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL REFERENCES budgets (id),
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  credential_ciphertext TEXT NOT NULL,
  credential_iv TEXT NOT NULL,
  -- The provider's own account identifier, when discovering it is
  -- expensive enough to be worth caching (Wise's profileId). Nullable
  -- because most providers have no such concept.
  external_id TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users (id),
  last_used_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX import_connections_budget_idx ON import_connections (budget_id);

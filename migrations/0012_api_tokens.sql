-- API tokens (PR 31) — one new table, additive under the expand/contract
-- rule: nothing on `main` today reads or writes it.
--
-- The site is one person's, and statement files now reach it through Claude
-- rather than the browser's upload form: the owner hands the files over in a
-- session, and Claude posts them to the import API. That needs a credential
-- that is not a browser session — a session cookie is bound to a browser,
-- expires on a sliding 30-day window, and carries the owner's FULL authority.
--
-- (PR 32 widened this: a token now has full authority over the budget routes,
-- minus token management and /auth. The paragraph below describes the
-- original imports-only design.)
--
-- So a token is deliberately narrower than a session: src/auth/middleware.ts
-- admits a token only to an explicit allowlist of routes (read the budget and
-- its accounts, run an import). It cannot mint or list tokens, edit or delete
-- transactions, or sign anyone in.
--
-- Only a SHA-256 of the token is stored, the same rule as magic-link tokens
-- (auth_tokens): the raw value is shown once at creation and exists nowhere
-- at rest. A row is revoked, never deleted, so last_used_at stays readable
-- after the fact.
--
-- This is a table rather than a Worker secret on purpose: tokens are created
-- and revoked from the app by the signed-in owner, with no deploy and no
-- access to the Cloudflare account required.
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE UNIQUE INDEX api_tokens_hash_idx ON api_tokens (token_hash);
CREATE INDEX api_tokens_user_idx ON api_tokens (user_id);

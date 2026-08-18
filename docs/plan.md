# Zero-Based Budgeting App — MVP Plan & Roadmap

## Context

`nobodyofnaught/budgetapp` is an empty repository. The goal is a YNAB-style zero-based
budgeting app on Cloudflare Workers, deployed automatically on merge to `main`, with
multi-user email magic-link auth.

Three capabilities are explicitly *future* work but must not require a rewrite when they
arrive:

1. **Shared budgets** — multiple users collaborating on one budget.
2. **Bank statement import** — upload, parse, dedupe, auto-categorize.
3. **Multi-currency** — accounts in different currencies, with the FX rate for a linked
   cross-currency transfer derived from the two actual transaction legs rather than a
   rate table.

So this plan is as much about the *schema and seams* as it is about the MVP feature set.
The MVP ships single-currency-display, single-user-per-budget, manual entry — but every
one of those three futures is a new table or a new code path, never a migration of a hot
table or a rewrite of the ledger engine.

## Decisions locked

| Decision | Choice |
|---|---|
| Stack | Hono JSON API on a Worker + Vite/React SPA served from Workers Static Assets, one deploy |
| Database | Cloudflare D1 + Drizzle ORM, migrations via `wrangler d1 migrations apply` |
| Money | Integer minor units, never floats |
| Multi-currency | Schema-complete from day one; MVP UI assumes one display currency |
| Email | Cloudflare Email Service binding (`env.EMAIL.send()`), behind a small `EmailSender` interface |
| Credit cards | Full YNAB-style payment categories in the MVP ledger engine |
| Branches | `main` = prod, `stg` = prod DB / app-only changes, `uat` = own DB |
| Sequencing | Foundation → auth → ledger engine → API/UI |

---

## Architecture

Single Worker. `/api/*` routes to Hono; everything else falls through to Static Assets
with `not_found_handling: "single-page-application"`. One `wrangler deploy`, one build,
no CORS, no second origin.

```
/
├── wrangler.jsonc          # prod (top-level) + env.stg + env.uat
├── package.json            # single package, no workspaces
├── migrations/             # numbered SQL, applied by wrangler
├── src/                    # Worker
│   ├── index.ts            # Hono app + asset fallthrough
│   ├── routes/             # auth, accounts, categories, transactions, months
│   ├── db/schema.ts        # Drizzle schema (source of truth)
│   ├── db/shard.ts         # getBudgetDb(env, budgetId) — the sharding seam
│   ├── domain/             # PURE ledger math, zero Cloudflare imports
│   ├── auth/               # magic link, sessions, CSRF
│   └── lib/                # money, dates, ids, email sender
├── web/                    # Vite + React + TanStack Query + Tailwind
└── test/                   # vitest + @cloudflare/vitest-pool-workers
```

`src/domain/` must stay dependency-free and synchronous — it takes plain arrays of rows
and returns computed months. That is what makes the budget math testable without a
database, and it is the part most likely to be wrong.

IDs are ULIDs (sortable, index-friendly, client-generatable — useful if offline support
ever lands). Calendar dates are `TEXT 'YYYY-MM-DD'`; a budget date is a calendar date, not
an instant, so no timezone handling. Months are `TEXT 'YYYY-MM-01'`. Timestamps are
`INTEGER` epoch millis UTC.

---

## Database design

The rule that governs everything: **every user-data row carries `budget_id`, and no query
ever joins across budgets.** That single constraint is what makes sharing, sharding, and
per-tenant migration all tractable later.

Second rule: **new capabilities should arrive as new tables.** Adding a table later is
free; adding a column to `transactions` after it has millions of rows, or changing a key,
is not. So the hot tables carry their future columns from day one even though the MVP
writes `NULL` into them.

### Identity & access

```
users            id, email, email_normalized UNIQUE, display_name, created_at, last_login_at
auth_tokens      id, email_normalized, token_hash, purpose, challenge_hash,
                 expires_at, consumed_at, created_ip, created_ua
sessions         id (256-bit random), user_id, expires_at, last_seen_at, revoked_at, ua, ip
budgets          id, name, currency_code, created_at, deleted_at, revision
budget_members   budget_id, user_id, role CHECK('owner','editor','viewer'), created_at
                 PRIMARY KEY (budget_id, user_id)
```

`budget_members` exists on day one and **every authorization check goes through it**, even
though the MVP only ever writes a single `owner` row per budget. This is the single most
important future-proofing decision in the plan: sharing later becomes an invite table plus
a UI, with no change to any authorization code path.

Sessions are opaque random tokens in D1, not JWTs — revocable, which matters once budgets
are shared.

### Budget data

```
accounts         id, budget_id, name,
                 type CHECK('checking','savings','cash','credit_card','line_of_credit',
                            'tracking_asset','tracking_liability'),
                 on_budget INTEGER, currency_code NOT NULL,
                 closed_at, sort_order, note, created_at, updated_at, deleted_at

payees           id, budget_id, name, transfer_account_id NULL,
                 created_at, updated_at, deleted_at

category_groups  id, budget_id, name, sort_order, is_system, hidden_at, deleted_at

categories       id, budget_id, group_id, name,
                 kind CHECK('spending','credit_card_payment','income') DEFAULT 'spending',
                 linked_account_id NULL,          -- set for credit_card_payment
                 sort_order, note, hidden_at, created_at, updated_at, deleted_at

category_months  category_id, month, budget_id, assigned_minor INTEGER NOT NULL DEFAULT 0
                 PRIMARY KEY (category_id, month)
```

`category_months` stores **only** what the user typed (`assigned`). Activity and available
are always derived — never stored — so there is no cache to invalidate and no way for the
displayed budget to disagree with the transactions behind it.

`accounts.currency_code` being present and enforced from day one is the multi-currency
seam. The MVP defaults it to the budget currency and the UI never offers anything else.

### Transactions — the hot table

```
transactions     id, budget_id, account_id, date,
                 amount_minor INTEGER NOT NULL,        -- signed, in the ACCOUNT's currency
                 currency_code NOT NULL,               -- denormalized, immutable per txn
                 budget_amount_minor INTEGER NOT NULL, -- converted to budget currency
                 payee_id NULL, category_id NULL, memo NULL,
                 cleared CHECK('uncleared','cleared','reconciled') DEFAULT 'uncleared',
                 approved INTEGER DEFAULT 1, flag_color NULL,
                 transfer_transaction_id NULL, transfer_account_id NULL,
                 parent_transaction_id NULL,           -- split sub-transactions
                 import_id NULL, import_batch_id NULL, import_payee_raw NULL,
                 scheduled_transaction_id NULL,
                 created_at, updated_at, deleted_at, revision
```

Indexes: `(budget_id, account_id, date)`, `(budget_id, category_id, date)`,
`(transfer_transaction_id)`, `(parent_transaction_id)`, `(budget_id, revision)`, and a
partial `UNIQUE (account_id, import_id) WHERE import_id IS NOT NULL`.

Three columns exist purely for the future and are worth justifying:

- **`budget_amount_minor`** — the amount converted into the budget's display currency at
  *this transaction's own rate*. For the MVP it always equals `amount_minor`. All budget
  math sums this column, never `amount_minor`. That means turning on multi-currency later
  changes only what gets *written* at transaction-creation time; the ledger engine and
  every report keep working untouched, and historical figures never drift when rates move.
- **`import_id` + the partial unique index** — a bank-provided FITID or a content hash.
  Re-importing an overlapping statement becomes an idempotent upsert instead of a
  deduplication project.
- **`revision`** (paired with `budgets.revision` as a per-budget counter, and `deleted_at`
  soft deletes everywhere) — lets a client ask "what changed since revision N". Delta sync
  is what shared budgets need to not feel broken, and it is impossible to bolt onto a table
  that hard-deletes.

**Cross-currency transfers need no extra columns.** A transfer is a pair of rows linked by
`transfer_transaction_id`; leg A holds `-10000` CAD and leg B holds `+7250` USD, each in
its own account's currency. The effective rate *is* the ratio of the two legs — exactly the
"conversion rate calculated from the actual transaction" behaviour requested. Nothing is
inferred from a rate table.

### Tables deliberately deferred

`budget_invites`, `import_batches`, `payee_rules`, `exchange_rates`,
`scheduled_transactions`, `category_targets`. All are additive — new tables referencing
columns that already exist. None require touching `transactions`.

---

## The ledger engine

This is the part worth getting right, and the reason it gets its own PR and its own test
suite. All of it lives in `src/domain/` as pure functions over plain rows.

```
activity(cat, month)  = Σ budget_amount_minor of non-deleted transactions in that month
                        for that category (split children count; split parents do not)

available(cat, month) = carryover(cat, month) + assigned(cat, month) + activity(cat, month)
```

**Carryover** is where the two account kinds diverge:

- Previous available **positive** → carries forward as-is.
- Previous available **negative** on a `spending` category → carries forward as **0**, and
  the shortfall is subtracted from the next month's Ready to Assign. You spent cash you
  had not budgeted; real money must cover it.
- Previous available **negative** on a `credit_card_payment` category → carries forward
  **negative**. You took on debt, not a cash shortfall; nothing should claw back next
  month's real money.

**Credit card payment categories** are derived, never stored as transactions:

- A purchase on a credit card account categorized to a spending category (`amount < 0`)
  contributes `+|amount|` to that card's payment category for that month — budgeted money
  moving from "groceries" to "money set aside to pay this card".
- A refund on the card (positive amount, spending category) contributes negatively.
- Paying the card is a transfer checking → card, categorized to the payment category,
  which drains the earmark.
- Interest and fees are ordinary card transactions and follow the same rule.

**Ready to Assign** for month M:

```
RTA(M) = incomeThrough(M) − assignedThrough(M) − cashOverspendingBefore(M)
```

Starting balances behave as YNAB's: an on-budget non-credit account's starting balance is
income to RTA; a credit card's starting balance is negative available on its payment
category.

**Performance.** Computing a month naively walks all history. The MVP does one pass per
budget: load `category_months` plus monthly activity aggregates in two queries, then fold
forward in JS. That is fine for years of data at this scale. A materialized
`category_month_cache` is the escape hatch if it ever isn't, and because available is
always derived, adding that cache is a pure optimization with no correctness risk.

**Testing.** A golden-case suite in `test/domain/` covering: rollover of positive balances;
cash overspending hitting next month's RTA; credit overspending staying negative; a
purchase on a card moving money to its payment category; paying the card draining it; a
refund reversing it; splits; transfers between on-budget accounts producing no category
activity; transfers to tracking accounts; and a cross-currency transfer pair. These tests
are the specification — write them alongside the engine, not after.

**Implemented in PR 3** (`src/domain/ledger.ts` + `test/domain/ledger.test.ts`, 30 tests,
all passing on the first run against hand-derived expected values). One rule the plan
didn't fully spell out, worked out from first principles against the starting-balance
requirement above: how **uncategorized** transactions route.

- Uncategorized, on-budget, non-credit account, not a transfer → straight to Ready to
  Assign (this is what makes a starting balance work with *no* special category: it's
  just an uncategorized inflow dated at account creation).
- Uncategorized, credit account, not a transfer → straight into that card's payment
  category, **undoubled, unflipped** — treated exactly as if categorized directly to
  Payment. This was the non-obvious part: applying the *purchase* doubling rule here (which
  would give `+|amount|`) produces a **positive** available with nothing real behind it —
  phantom spendable money for debt nobody assigned for. The correct behavior, matching
  "negative available" above, is the direct/unflipped rule: `-$100` uncategorized reads as
  `-$100` available, prompting the user to assign real money to cover it. Verified by hand
  against concrete numbers before writing any code (see the commit message).
- Uncategorized **transfer** legs (either account type) → zero effect, always. This is also
  what stops a credit-card *payment* from double-counting: the card-side leg of a payment
  transfer is an uncategorized transfer and lands here; only the checking-side leg
  (categorized to Payment) drains the earmark.
- Off-budget (tracking) account → zero effect, full stop, regardless of category.

The split-parent exclusion (`activity(cat, month)` from the formula above) is verified by
deliberately breaking it and confirming the "splits" test catches the regression — a parent
left in would misread as a large negative "uncategorized income", not just a missing
number.

---

## MVP scope

1. **Auth** — magic-link sign in, session cookie, sign out, rate limiting.
2. **Budgets** — auto-created on first login via `budget_members`; a budget switcher (near
   free, since the membership model already supports it).
3. **Accounts** — create, edit, close. Checking / savings / cash / credit card / line of
   credit / tracking. Starting balance.
4. **Categories** — groups and categories, rename, reorder, hide, delete. A sensible
   default set seeded on budget creation. Payment categories auto-created and auto-managed
   for each credit account.
5. **Transactions** — add / edit / delete, date, payee with autocomplete, category, memo,
   outflow / inflow, cleared toggle. Splits. Transfers.
6. **Budget screen** — month navigator, per-category Assigned / Activity / Available,
   Ready to Assign banner, inline assign editing, move money between categories, cover
   overspending.
7. **Account register** — running balance, search, filter, cleared balance vs account
   balance.
8. **Responsive layout** — usable on a phone.

Explicitly **not** in the MVP: targets/goals, reports, sharing, statement import,
scheduled transactions, net worth, full reconciliation flow, a mobile app.

**Items 3, 4, 5 (partial), and 7 implemented in PR 4** — accounts, categories, payees, and
transactions (create/edit/delete, splits, transfers) end to end, API and register UI. Item
6 (the budget screen — assign, move money, Ready to Assign) is PR 5; it's what finally
wires the PR 3 ledger engine into an endpoint. A few things worth recording:

- **A real bug the test suite caught before it shipped**: the transfer-creation handler
  had the source/destination sign backwards (`from.amountMinor = minor` instead of
  `-minor`) — money appeared to flow the wrong direction. Caught by
  `test/transactions.test.ts`'s transfer test, which is exactly why splits/transfers/the
  credit-card mechanic all got real assertions rather than "the endpoint returns 201".
  Fixed contract, stated plainly: a transfer's `amount` is the positive magnitude moving
  from the source account to the destination — sign is implied by which field is which,
  never by the sign the caller types.
- **The credit-card end-to-end test feeds real API-created data into `computeLedger`
  directly** (`test/transactions.test.ts`) — not a mock, the exact PR 3 engine — to prove
  the API and the engine actually agree on the purchase/payment sign conventions
  documented above. This is the test that would have caught it if the API had encoded the
  doubling rule differently than the engine expects.
- **`category_groups` was missing `created_at`/`updated_at`** (the one table in
  `0000_init.sql` inconsistent with every other table) — caught while building its CRUD
  routes, fixed in `migrations/0001_category_group_timestamps.sql`, applied to prod and
  uat (never `stg` — see "Guarding the shared production database"). The table was
  verifiably empty in every environment before the migration ran.
- **`zod` added as a direct dependency** — request bodies got materially more complex here
  (nested splits, discriminated ordinary/split/transfer shapes) than auth's two-field
  bodies, where hand-rolled `typeof` checks were still proportionate.
- **A local-dev gap surfaced by an actual browser smoke test** (Playwright against
  `wrangler dev`, not just the API test suite): local D1 migrations are not applied
  automatically — skipping `npm run db:migrate:local` produces "no such table" 500s on
  every request. Documented in the README; would have been a rough first-run experience
  otherwise.
- **Un-splitting a transaction back to a single category isn't exposed** — `PATCH
  .../transactions/:id`'s `splits` replacement requires at least 2 parts (same as create:
  a 1-line "split" isn't a split), consistent with the broader rule that shape can't
  change via edit. Delete and recreate covers it; a dedicated "remove last split" affordance
  is a UI nicety, not a gap in the API.

---

## Roadmap

**Phase 2 — Make it a budgeting tool, not a ledger.** Category targets/goals (monthly,
by-date, refill vs. build). Reports: spending by category, income vs. expense, net worth.
Scheduled/recurring transactions (`scheduled_transactions` table; `transactions.scheduled_transaction_id`
already exists). Full reconciliation with adjustment transactions.

**Phase 3 — Shared budgets.** `budget_invites` table, invite-by-email reusing the
magic-link token machinery. Roles enforced at the route layer — authorization already
reads `budget_members`, so this is mostly UI. Activity log from the `revision` stream.
Delta sync endpoint (`GET /budgets/:id/changes?since=N`) so two people on the same budget
see each other's edits.

**Phase 4 — Statement import.** CSV first with a column-mapping UI and per-bank saved
mappings; then OFX/QFX/QIF (structured, carries FITID); PDF last. Uploads land in R2,
parsing runs through Queues for anything large. `import_batches` tracks a run;
`transactions.import_id` makes re-imports idempotent. Auto-categorization via a
`payee_rules` table plus learned payee→category frequency, surfaced as an "approve
imported transactions" queue rather than silent writes. Transfer detection matches amount
and date across accounts and links the pair — which, when the two accounts hold different
currencies, is precisely the cross-currency case below.

**Phase 5 — Full multi-currency.** Multi-currency accounts in the UI. `budget_amount_minor`
starts carrying real conversions. Effective rate on a transfer derived from the two legs.
`exchange_rates` table for reporting-only conversions where no transaction supplies a rate.
FX revaluation of foreign-currency tracking accounts.

**Phase 6 — Beyond.** Bank feeds (Plaid / GoCardless / Salt Edge), public API, PWA with
offline entry.

---

## Sharding: the answer to "can we split the database later?"

Yes, and cheaply — because the enabling work is in the data model, not the infrastructure.

Current D1 limits on Workers Paid: **10 GB per database, 50,000 databases per account,
1 TB total storage**. A transaction row is on the order of 200 bytes, so 10 GB is tens of
millions of transactions — realistically thousands of active households in one database.
This is a problem for later, but the seam costs nothing now.

**Shard by budget.** Every user-data row already carries `budget_id` and nothing joins
across budgets, so a shard is just a set of budgets, and migrating a tenant is "copy its
rows, flip a routing row". When the day comes:

- A **control-plane** D1 holds `users`, `sessions`, `budgets`, `budget_members`, and a
  `budget_shards (budget_id → shard_key)` routing table, cached in KV.
- **Data-plane** D1s hold everything budget-scoped, bound statically as `SHARD_0…SHARD_N`.

One caveat worth knowing up front: **D1 bindings are static in `wrangler.jsonc`** — there
is no runtime "connect to database by ID". Adding a shard means adding a binding and
redeploying. With Workers Builds wired up that is a one-line commit, but it does mean
shards are provisioned deliberately rather than on demand.

**What the MVP does about it:** one accessor in `src/db/shard.ts` —

```ts
export function getBudgetDb(env: Env, budgetId: string): D1Database {
  return env.DB; // today: one database. later: routing table lookup.
}
```

— and the discipline that every budget-scoped query goes through it. Roughly twenty lines
now, instead of auditing every query later.

Sharing across shards still works: membership lives in the control plane while data lives
with the budget, so a user belonging to two budgets on two shards is two reads and no join.

If per-tenant isolation ever needs to be stricter, the other endpoint is a SQLite-backed
**Durable Object per budget** — addressable by name at runtime with no binding enumeration,
10 GB each, with point-in-time recovery. It trades away D1's migration tooling (you
hand-roll per-object migrations) and is not worth it now.

---

## Environments & deployment

No GitHub Actions. Everything runs through **Cloudflare Workers Builds** git integration —
it is both the deploy pipeline and the PR gate.

Three long-lived branches, three Workers, two databases:

| Branch | Worker | Database | Migrations | Non-prod branch builds |
|---|---|---|---|---|
| `main` | `budgetapp` | `budgetapp-db` (prod) | **applied** | disabled |
| `stg` | `budgetapp-stg` | `budgetapp-db` (prod) | **never** | disabled |
| `uat` | `budgetapp-uat` | `budgetapp-uat-db` | **applied** | **enabled** |

`wrangler.jsonc` uses the top level for production and `env.stg` / `env.uat` for the other
two. Each of the three Workers connects to this repo in the Cloudflare dashboard
(*Settings → Builds → Connect*) with its own production branch.

### Build and deploy commands

The build command is the gate — it runs the checks, so a type error or a failing ledger
test fails the build and nothing deploys:

```
build (all three):  npm ci && npm run check && npm run build
                    # check = tsc --noEmit && eslint . && vitest run
```

```
main deploy : npx wrangler d1 migrations apply budgetapp-db --remote && npx wrangler deploy
stg  deploy : node scripts/assert-schema-current.mjs && npx wrangler deploy --env stg
uat  deploy : npx wrangler d1 migrations apply budgetapp-uat-db --env uat --remote \
              && npx wrangler deploy --env uat
```

### PR checks without Actions

Enable **non-production branch builds on the `uat` Worker only**, with the non-production
deploy command set to:

```
npx wrangler versions upload --env uat
```

`versions upload` publishes a preview version with its own URL *without* shifting
production traffic. So every push to a feature branch builds, runs typecheck + lint +
tests, and produces a clickable preview running against the UAT database.

Cloudflare reports each build's result back to the commit as a GitHub **check run** — the
green/red entries above the merge button on a PR. Check runs are a GitHub feature, not a
GitHub Actions feature; the Cloudflare GitHub App (installed when the repo is connected)
posts them. There is no `.github/` directory in this repo and no Actions minutes are
consumed.

Optionally mark that check **required** in GitHub branch protection (Settings → Rulesets —
a repository setting, not a workflow file) so a red build blocks the merge rather than
just being visible. Note this can only be configured *after* the first build has run, since
GitHub only offers checks it has already seen.

Non-production builds stay **disabled** on the `stg` and `main` Workers. That is what stops
an arbitrary feature branch from ever executing against the production database.

### Guarding the shared production database

`stg` points at production data, so the invariant is: *`stg` may never run code that needs a
schema production does not already have.* `scripts/assert-schema-current.mjs` enforces it
directly — it shells out to `wrangler d1 migrations list --env stg --remote` and fails the
build if any migration in the repo is unapplied. This is stronger than blocking PRs that
touch `migrations/`, because it asserts the condition that actually matters rather than a
proxy for it.

The practical consequence, which is worth being explicit about since it refines the
promotion flow:

- **App-only changes**: feature → `uat` → `stg` → `main`.
- **Schema changes**: feature → `uat` → `main`, **skipping `stg`**. The guard will fail a
  `stg` build carrying an unapplied migration, by design — that is the flow working, not a
  problem to route around.

Two further consequences of `stg` sharing production data, both worth stating plainly:

1. The guard stops schema drift but **not** a bad write path. A `stg` build with a buggy
   mutation will damage real data. Treat `stg` deploys with production care.
2. Because `stg` and `main` run different code against the same schema, **every migration
   must be expand/contract**: add nullable columns, backfill, switch reads, drop in a later
   release — never rename or drop in a single migration.

Secrets (`EMAIL_FROM`, session signing key) are set per environment with `wrangler secret put`.

---

## Auth flow detail

*(Implemented in PR 2. Two details below were refined during implementation —
noted inline — everything else shipped as planned.)*

1. `POST /api/v1/auth/magic-link {email}` always returns 200 "check your email" — no
   account enumeration (a malformed address is a 400, not an enumeration case: format
   validation, not an existence check). Rate limited two ways, not one, because the
   native Rate Limiting binding turned out to only offer 10s/60s windows — too short to
   stop someone spamming a real inbox, only useful as a blunt per-IP abuse brake. So:
   an IP check via the binding (10 req/60s) **and** a deterministic email-keyed cooldown
   (max 5 tokens per email per 15 minutes, queried straight from `auth_tokens` —
   `src/auth/rate-limit.ts`). Over either limit: skip creating a token/sending mail, but
   respond identically — no signal either way.
2. Generate a 32-byte random token; store only its SHA-256 hash, 15-minute expiry,
   single use (claimed atomically — an `UPDATE ... WHERE consumed_at IS NULL`, so a
   double-submit can't sign in twice from one token). Set a short-lived `challenge`
   cookie bound to that token row.
3. Email sent through an `EmailSender` interface (`src/lib/email.ts`). **Only a
   console-logging implementation is wired up in PR 2** — real delivery (Cloudflare
   Email Service or otherwise) is deliberately deferred: this account has no verified
   sending domain yet, and the interface exists precisely so plugging in a real
   provider later is a one-file change plus one line where it's constructed, not a
   rewrite of the auth routes. Sign in during review by reading the confirm URL out of
   the Worker's logs (`wrangler tail`, or Live Logs in the dashboard).
4. The link opens a page that **POSTs** to consume the token — a GET would let corporate
   link scanners burn it. Matching `challenge` cookie signs in immediately; a different
   device (cookie missing/mismatched) returns `needs_confirmation` and leaves the token
   **unclaimed**, so the client's "Confirm sign-in" button can retry with `confirm: true`
   — possessing the emailed token is itself sufficient proof; the cookie only decides
   whether that extra click is needed.
5. Session row created; `__Host-session` cookie, `HttpOnly; Secure; SameSite=Lax`, 30-day
   sliding expiry (re-extended at most once per day of activity, not on every request —
   full re-extension on every hit would mean a D1 write per authenticated request).
   CSRF covered by SameSite plus an `Origin` check on every mutation
   (`src/lib/csrf.ts`).

---

## PR sequence

1. **Foundation** — scaffold, `wrangler.jsonc` with three envs, Drizzle schema, initial
   migration, health endpoint, `npm run check`, `scripts/assert-schema-current.mjs`. This
   session has live Cloudflare API credentials, so it provisions real resources rather than
   shipping placeholders: `wrangler d1 create` for `budgetapp-db` and `budgetapp-uat-db`
   (real IDs go into `wrangler.jsonc`), migrations applied, and one `wrangler deploy` per
   environment so `budgetapp` / `budgetapp-stg` / `budgetapp-uat` exist and serve the
   health check. Connecting each Worker to this GitHub repo in the dashboard
   (Settings → Builds → Connect) is not scriptable from here — the README documents that
   walkthrough precisely (production branch, build/deploy commands per env, non-production
   branch builds enabled only on `budgetapp-uat`) for the user to click through.
2. **Auth** — magic link end to end, sessions, rate limiting, `budget_members`-based
   authorization middleware, auto-created first budget.
3. **Ledger engine** — `src/domain/` pure module plus the golden test suite. No API, no UI.
   Reviewable purely on whether the math is right.
4. **Accounts & transactions API + register UI.**
5. **Budget screen** — month view, assign, move money, Ready to Assign.
6. **Polish** — responsive layout, empty states, keyboard entry in the register.

---

## Verification

- `npm run dev` — `wrangler dev` with a local D1 and a seed script; magic-link emails print
  the sign-in URL to the console.
- `npm test` — Vitest under `@cloudflare/vitest-pool-workers`, so route tests hit a real
  D1 in `workerd`, not a mock.
- **Manual acceptance for the MVP**, in one session: sign in by magic link → create a
  checking account and a credit card → seed categories → assign to Groceries → buy
  groceries on the card → confirm Groceries activity went down *and* the card's payment
  category went up by the same amount → pay the card from checking → confirm the payment
  category drained and both balances moved → overspend a cash category and confirm next
  month's Ready to Assign absorbed it → overspend on the card and confirm the payment
  category stayed negative instead → enter a split and a transfer → step forward a month
  and confirm rollovers.
- **Pipeline acceptance**, all via Workers Builds:
  1. Push a feature branch → confirm the `uat` Worker produces a preview version, that the
     check run appears on the PR, and that deliberately breaking a test turns it red.
  2. Merge to `uat` → confirm migrations apply to `budgetapp-uat-db` and the app is
     reachable.
  3. Push a branch carrying an unapplied migration to `stg` → confirm
     `assert-schema-current.mjs` fails the build before `wrangler deploy` runs.
  4. Merge to `main` → confirm migrations apply to prod and the deployment goes live.

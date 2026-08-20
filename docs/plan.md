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

`budget_invites`, `exchange_rates`, `scheduled_transactions`. All are additive — new tables
referencing columns that already exist. None require touching `transactions`.

`category_targets` was on this list through PR 5 — it landed in PR 6. `import_batches` was
on it through PR 6 — it landed in PR 7. `payee_rules` was on it through PR 8 — it landed in
PR 9 (all below).

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

**Item 6 implemented in PR 5** — the budget screen: `GET/PUT
/budgets/:id/months/:month` (`src/routes/months.ts`) is the one place in the app that
calls the PR 3 ledger engine, and `BudgetMonth.tsx` is the UI on top of it. A few things
worth recording:

- **"Move money" and "cover overspending" are the same batch PUT, not separate
  endpoints.** The client already has each category's current `assigned` from the last
  GET, so a move is just two entries in one `PUT .../assignments` call — source's new
  absolute value, destination's new absolute value — validated together and written
  together (never half a batch). Covering overspending is the identical operation with
  the negative-available category as the destination; the UI doesn't special-case it, per
  the per-row "Move" affordance's own inline explanation.
- **`assigned` is always an absolute new value for the month, never a delta** — both at
  the API boundary and in the client's move-money math (`fromAssigned - amountMinor`,
  `toAssigned + amountMinor`, computed from the last known-good server state, then sent
  as two absolute values). This is what makes a batch idempotent and race-free against a
  second stale write.
- **A real UI staleness bug, caught by a real-browser smoke test, not just the API test
  suite**: creating an account while already sitting on the Budget tab (the account form
  lives inline in the nav sidebar, so the tab never unmounts) changed Ready to Assign —
  new starting balance as income, or a new credit account's payment category — but
  `BudgetMonth` had already fetched on mount and had no reason to fetch again. Fixed by
  threading an `accountsVersion` counter down from `Budget.tsx`, bumped every time
  accounts reload, as an explicit extra dependency on `BudgetMonth`'s fetch effect —
  switching view tabs already remounts and refetches naturally; this covers the one path
  that doesn't.
- **Two test-authoring mistakes, not product bugs**, both caught immediately by the test
  run rather than surviving to manual testing: `CategoryMonthResult` carries a
  `categoryId` field that a hand-written `toEqual` expectation omitted; and a starting
  balance's date defaults to *today* server-side, which silently broke a test asserting
  against a fixed month once "today" and "the month under test" diverged — fixed by
  passing `startingBalanceDate` explicitly rather than relying on the default.
- Categories of `kind: 'income'` are rejected by `PUT .../assignments` (they feed Ready
  to Assign directly from uncategorized transactions and have no "available" of their
  own) — currently unreachable through any UI path since nothing creates one yet, but
  asserted directly against the route by inserting one with raw SQL in the test, so the
  defensive check is proven live rather than merely unreachable.

**`category_targets` (Phase 2's targets/goals item) pulled forward and implemented in
PR 6** — a category's funding obligation: an amount, and how often/when it's needed. It
exists to answer a question the budget screen alone couldn't: *the month is the funding
cadence, not the obligation's cadence.* A category's `available` is a running balance
with no monthly reset (see the ledger engine section above) — a bill due every 3 weeks
drifts across months and a quarterly bill isn't month-aligned at all, and neither fact
requires the app to care, because nothing about the ledger math depends on it. What was
missing was a layer that turns a real-world recurrence into "how much to assign this
month" and "when's this actually due" — that's `src/domain/targets.ts`, and it's a
second, deliberately separate pure module from the ledger engine, not a change to it.

- **Schema**: one new table, `category_targets` (`id, budget_id, category_id,
  amount_minor, interval_unit, interval_count, due_date`), with a partial unique index
  enforcing one live target per category. `(interval_unit, interval_count)` —
  `'week'|'month'|'year'|'once'` plus a count — covers every case (monthly refill,
  "every 3 weeks", quarterly, annual, one-time-by-date, open-ended savings goal) with two
  small fields instead of a sprawling enum. `migrations/0002_category_targets.sql` is a
  pure new-table migration — the blessed expand/contract shape — so this promotes
  feature → `uat` → `main`, **skipping `stg`** (see "Guarding the shared production
  database"); `scripts/assert-schema-current.mjs` is supposed to reject an unapplied
  migration on `stg`, and did.
- **Four funding formulas, one function** (`computeTargets`): a monthly refill tops
  `available` back up to the target, no date needed. A sub-monthly recurrence (the
  "every 3 weeks" case) asks for a **smoothed, steady monthly rate** — `round(amount ×
  (52 / intervalCount) / 12)` — rather than an amount that alternates with however many
  occurrences land in a given month; a category funded this way visibly dips in a
  two-occurrence month and recovers the next, which is the smoothing working, not drift.
  Everything else (quarterly, annual, one-time-by-date) spreads the remaining gap evenly
  across the months left before it's due. An elapsed one-time target, or a recurring
  target missing its anchor date, both collapse into the same "no more months to spread
  across, ask for the whole remaining gap now" case rather than needing their own branch.
  An open-ended goal (`once` with no date) has no forced monthly ask at all — just a
  running total.
- **A real double-counting bug, caught by hand-deriving a partially-assigned example
  before writing the golden tests**, not by a failing test: the first draft of the
  "spread the gap" formula computed the gap from `available` (which already includes
  whatever's been assigned this month) and then ALSO subtracted this month's assignment
  from the result — netting it out twice. Fixed by computing the gap from `available`
  with this month's own assignment backed out first (`baseAvailable = available -
  assignedThisMonth`), then subtracting the assignment only once, in the final step.
- **A real date-arithmetic bug, caught by the leap-year golden test**: walking a
  recurring occurrence forward was implemented by repeatedly adding one interval to the
  *previous computed occurrence*. `addMonths` clamps the day-of-month (Jan 31 + 1 month →
  Feb 28), so stepping off an already-clamped result carried that clamp forward
  permanently — Feb 28 + 1 month became Mar 28, silently losing the 31st forever instead
  of correctly landing on Mar 31. Fixed by always computing each candidate occurrence
  fresh from the *original* anchor date (`occurrenceAtStep`), never by adding to a
  previous result — exported and reused by `GET /upcoming`'s own occurrence walk for the
  same reason.
- **Two separate clocks, two separate computations, on purpose.** `computeTargets` takes
  no "today" — like the ledger engine, it's a pure fold over data plus a target *month*,
  and browsing forward a month is what advances `nextDueDate`. `GET
  /budgets/:id/upcoming` is the deliberately real-clock-anchored counterpart — "what's
  due in the next N days from right now" — and is a genuinely different question with a
  genuinely different answer; `UpcomingPanel` ("Coming up") is not month-scoped at all,
  which is the direct answer to *why bills due every 3 weeks or every 3 months don't need
  month boundaries to make sense.*
- UI: a per-category inline target editor (`TargetForm.tsx`), a **Needed** column on the
  budget screen with a funded/short/building indicator, and the "Coming up" panel above
  the budget table. A real-browser smoke test caught two locator bugs in the test script
  itself (not the app) worth recording as a general lesson: a Playwright locator that
  filters on "has a button labeled X" is a moving target if the action under test changes
  that very button's label (`Set target` → `Edit target`) — a later re-evaluation of the
  *same* locator can silently resolve to a *different* row. Fixed by locating rows by
  stable identity (category name) instead of by mutable UI state.

**Item 8 implemented in PR 6 (Polish)** — responsive layout, empty states, and keyboard
entry in the register, closing out the original MVP PR sequence. Frontend-only, no
schema change. A few things worth recording:

- **The house style is "zero CSS classes, all inline styles," and this PR breaks that on
  purpose in exactly one place.** A `@media` breakpoint can't be expressed inside a React
  inline `style` object, so a small, dedicated block was added to `web/src/styles.css`
  (`.app-shell`, `.budget-layout`, `.budget-nav`, `.table-scroll`, one
  `@media (max-width: 640px)` query) used *only* for the handful of structural elements
  that change shape at a breakpoint — colors, spacing, and every form still stay inline
  exactly as before. Below 640px the nav stacks above content (it's an unbounded list of
  account names, not a small fixed tab set, so stacking is both the simpler change and
  the better fit) and both wide tables (`BudgetMonth`'s 6 columns, `Register`'s 8) scroll
  horizontally inside their own bounded box rather than blowing out the page — verified
  in a real 375px-viewport smoke test: the page's own `scrollWidth` stayed at exactly the
  viewport width throughout.
- **Loading state was previously indistinguishable from "loaded and genuinely empty" in
  three places.** `Budget.tsx`, `BudgetMonth.tsx`, and `Register.tsx` all rendered a
  blank/all-zero UI in flight, while `Home.tsx`/`UpcomingPanel.tsx`/`ConfirmSignIn.tsx`
  already showed `<p>Loading…</p>` in the equivalent spot. Fixed by matching that exact
  precedent in all three. One consequence worth noting: `Budget.tsx`'s `categoryGroups`
  had to change its initial state from `[]` to `null` — `[]` can't be told apart from "no
  categories yet" the way `null` can, the same reasoning `accounts`'s `| null` state
  already used.
- **A budget with zero accounts rendered a fully-populated-looking all-zero category
  table with no explanation.** Fixed with one line — `Budget.tsx` already loads
  `accounts`, so its presence is passed down as a `hasAccounts` prop and `BudgetMonth`
  shows "Add an account to get started" above the (still-rendered, still harmless) table.
- **Keyboard entry, scoped narrowly to the register on purpose**: `autoFocus` on the
  Amount field when `TransactionForm` opens (Amount, not Payee — it's present in both
  `ordinary` and `transfer` modes, Payee isn't; the first split row's amount gets it
  instead in `split` mode), and Escape now cancels the form without saving. **Explicitly
  not built**: a rapid multi-entry flow (form reopening automatically after each save) —
  considered and scoped out in favor of the smaller, lower-risk change; saving still
  closes the form exactly as it always has, for every mode.
- No schema change means this is the first PR since targets (PR 6, the one that added
  `category_targets`) to use the full app-only promotion path — feature → `uat` → `stg`
  → `main` — rather than skipping `stg`.

**Statement import landed in PR 7** (`src/import/`, `src/routes/imports.ts`,
`import_batches`), driven by a real Wise export. Phase 4's CSV item is therefore partly
done — see the roadmap. What the file itself forced:

- **One purchase can span several rows sharing an ID.** When Wise funds a card payment
  from more than one currency balance it emits a row per balance:
  `CARD_TRANSACTION-4145111585` is 15.70 CAD → 11.18 USD *plus* 23.32 USD → 23.32 USD,
  one $34.50 purchase. **Deduplicating on the ID column alone silently drops real
  money**, so `src/import/wise.ts` groups by id and only then decides what a group means.
- **Fees sit outside the amount columns.** "Source amount (after fees)" is post-fee,
  verified against the export: `1136.36 CAD × 0.704002 = 800.00 USD` exactly, with the
  5.76 CAD fee on top. Every emitted amount is therefore amount + fee.
- **The split-currency model: a cross-currency transfer plus a full-value purchase.**
  Rather than truncating the purchase to its same-currency leg (balance-accurate, spend-
  wrong) or summing the legs onto one account (spend-accurate, balance-wrong), the
  foreign-funded part becomes an explicit conversion into the charged currency:
  ```
  transfer  Wise CAD → Wise USD   −15.77 CAD / +11.18 USD
  purchase  Wise USD, Taste of Europe        −34.50 USD  [Groceries]
  ```
  Both balances then reconcile to the cent AND the category sees the real $34.50. This is
  exactly what `insertTransferPair` was already built for — each leg carries its own
  currency and magnitude, and the effective rate is the ratio between them, no rate table
  involved. Verified end-to-end: importing the real 44-row file produces a USD balance of
  −1373.91 and a CAD balance of −1276.72, both matching an independent computation
  straight from the raw file.
- **Scoped multi-currency, not phase 5.** Accounts may now be created in any currency,
  but one that isn't the budget's is forced **off-budget**: budget math sums
  `budgetAmountMinor`, which needs a real per-transaction rate, and statement files supply
  one only where a conversion actually happened (a CAD purchase from a CAD balance carries
  no CAD→USD rate). Rather than invent rates, such accounts track their balance faithfully
  and stay out of categories/RTA. Fully budgetable foreign accounts remain phase-5 work.
- **A real pre-existing ledger bug this surfaced.** `accumulateMonth` bailed on *any*
  uncategorized transfer leg, so a transfer between an on-budget and an off-budget account
  had no Ready-to-Assign effect at all — money could enter or leave the budget entirely
  unrecorded, breaking the "sum of every category's available + RTA == on-budget cash"
  invariant by the transferred amount. Fixed by giving the domain `TransactionRow` a
  `transferAccountId` and treating a boundary-crossing leg as income. **An existing test
  asserted the buggy behaviour** (`readyToAssign` staying 0 on a transfer to a tracking
  account); its expectation was corrected with the reasoning recorded inline, and mirror
  cases added in both directions plus a defensive unknown-counterpart no-op.
- **Imported rows are real transactions with `approved = false`**, not a staging table —
  reusing three columns 0000_init.sql already carried for this. They move balances and RTA
  immediately (an uncategorized outflow correctly pulls RTA down; categorizing moves it
  into category activity), and the review queue is a filter over them. `import_batch_id`
  makes "undo this import" one query, which matters precisely because import writes real
  rows.
- **Skipped rows are reported, never silent.** Only `COMPLETED` and inbound `REFUNDED`
  import; an *outbound* refund is a bounced transfer whose money already came back, with
  no return row in the export, so importing it would double-count the outflow. The one
  such row in the sample file is surfaced by reference and reason in the import summary.
- Wise's own Category column pre-fills the review screen where a confident match exists
  (Groceries→Groceries, Transport→Transportation, Eating out→Dining Out,
  Entertainment→Fun Money, Bills→Utilities). Vague labels — General, Money added, Personal
  care — are deliberately left blank rather than guessed at.

**Reports landed in PR 8** (`src/domain/reports.ts`, `src/routes/reports.ts`,
`web/src/components/Reports.tsx`) — the three named in Phase 2's roadmap line: spending by
category, income vs. expense, net worth, all over a shared start/end month range. No schema
change; every number comes straight out of `transactions`/`categories`/`accounts`.

- **Reuse over reinvention, deliberately.** Spending-by-category and income-vs-expense are
  thin route-layer aggregations over `computeLedger`'s own per-month output
  (`src/domain/ledger.ts`), not a second implementation of "which rows count as spending or
  income" — that's real risk of the two readings drifting, which is exactly what happened
  once already (the PR 7 transfer-boundary bug). The one piece `computeLedger` folded
  internally but never returned — `incomeThisMonth` — is now exposed on `MonthResult`
  (purely additive) instead of being thrown away after updating Ready to Assign.
- **Net worth is different in kind and gets its own small fold.** Unlike category activity,
  an account balance carries no carryover/assignment logic — the plan's own domain-types
  comment already says a single point-in-time balance is "simple enough to do with SQL
  directly" and doesn't belong in the ledger module. But a *trend* across many months is
  still a fold (each snapshot depends on every row before it), so `netWorthTrend`
  (`src/domain/reports.ts`) is one small pure function, golden-tested the same way as
  `computeLedger`/`computeTargets`, walking a sorted transaction list once and snapshotting
  a running per-account balance at each requested month's end. Liability classification
  (`credit_card`, `line_of_credit`, `tracking_liability`) reuses the ledger's own
  `CREDIT_ACCOUNT_KINDS` plus one addition.
- **No charting dependency introduced.** This repo has none today, and every existing
  screen (`Register`, `BudgetMonth`, `UpcomingPanel`) is a plain HTML table with the same
  duplicated `formatMinor`/`amountColor` idiom — `Reports.tsx` stays consistent rather than
  being the first screen to pull one in for a single feature.
- No schema change means this is another app-only promotion — feature → `uat` → `stg` →
  `main` — like PR 6 and the PR 6 polish pass.

**BECU import + payee rules landed in PR 9** (`src/import/becu.ts`, `src/import/rules.ts`,
`src/import/payee-name.ts`, `payee_rules`), driven by a real BECU checking export (23 rows,
no header carrying anything like Wise's `ID`). Two things the file forced, and one design
decision that came out of them:

- **No transaction id column at all.** `transactions.import_id` becomes a literal composite
  (`date|amountMinor|description|occurrence`) rather than a bank-supplied id — the exact
  case `0000_init.sql`'s own comment anticipated ("bank-provided FITID or a content hash").
  The `occurrence` ordinal matters for real money: two byte-identical rows in the sample
  file (two separate $70.80 Zelle payments to the same person, same day) would otherwise
  collide under the partial unique index and the second would be silently dropped as a
  "duplicate" — the same class of bug Wise's multi-leg purchases exposed in PR 7.
- **One free-text description column carries everything** — transaction type, merchant,
  auth code, sometimes an address, sometimes a phone number. Asked to fix a specific bad
  name (`GIANT FOOD INC #152` should read `Giant Food`), the shape that emerged is
  heuristic-plus-override, not a hand-tuned parser: `cleanPayeeName` (best-effort, provider-
  agnostic) does what it can, and `payee_rules` (user-defined, case-insensitive substring →
  rename, optionally also categorize) fixes what it gets wrong — pulling the `payee_rules`
  table forward off the deferred list and the Phase 4 roadmap line, rather than leaving it
  for later.
- **The heuristic and rules both apply above the provider layer, in `src/routes/imports.ts`,
  not inside `becu.ts`.** A parser only strips its own bank's vocabulary (BECU's `payeeName`
  drops the leading "POS Withdrawal - " type prefix and the trailing "- Card Ending In
  NNNN"); the generic merchant-descriptor cleanup and every user rule run centrally, over
  every provider's output. Concretely: `ParsedOrdinary` splits one field into two —
  `payeeRaw` (verbatim, what a rule matches against — never the cleaned name, so a rule can
  recover anything the heuristic discarded) and `payeeName` (a provider's own best-effort,
  or equal to `payeeRaw` when the provider has nothing better, as Wise now sets it
  explicitly). This means Wise imports get rules and the heuristic too, for free — pinned by
  `test/imports.test.ts`'s "the same rule applies to a Wise import" case.
  `cleanPayeeName` is deliberately imperfect on two real rows in the sample file (a
  no-standalone-number address tail; a `WEB - KRISTINE SANDT …` deposit that collapses to
  just `WEB`) — that imperfection is the point: a hand-tuned regex chasing every real-world
  statement format would grow without bound and still lose to a human writing a one-line
  rule the first time a name comes out wrong.
- **`POST /budgets/:id/payee-rules/apply`** re-runs the budget's rules over whatever's still
  unapproved in the review queue, so writing a rule after seeing a bad name doesn't require
  deleting the batch and re-importing. Approved rows are never touched — a rule must not
  silently redo something a human already confirmed — and a payee-only rule (no category)
  leaves whatever category is already set alone rather than clearing it.
- Purely additive migration (one new table, `payee_rules`, referencing nothing `main`
  doesn't already have) — the normal `uat` → `stg` → `main` path, not the breaking-migration
  exception.

**Splitwise import landed in PR 10** (`src/import/splitwise.ts`,
`accounts.import_options`), the third import provider and the first that isn't a bank.
Splitwise tracks shared household expenses (rent, groceries, utilities) among four people;
two of them share this budget. The file has no account and no balance of its own — every
row is one shared expense, with a per-person column holding that person's net position
change (`paid − share`), summing to zero across the row. That shape forced a different
design than Wise/BECU:

- **The expense and the cash movement are separated**, and naively importing every row as
  an expense double-counts: rows the budget's own people fronted themselves already arrive
  through the bank import (Wise/BECU), so counting the Splitwise row too would book the
  same spend twice. Analysis of the real 284-row export confirmed the shape and the fix —
  **net position into a dedicated on-budget "Splitwise" clearing account**, not "import each
  row as an expense": for each row, sum the *selected* members' columns (their combined
  `paid − share`) and import that single net figure, categorized. Bank transactions are
  never touched. Where the budget's people fronted the cash, the Splitwise line is
  *positive* — the roommates' reimbursement — and cancels the portion of the bank charge
  that wasn't theirs. Reconciled to the cent against the file's own footer:
  `−32,584.53` (Splitwise rows) `− 4,123.94` (already-counted bank purchases) `=
  −36,708.47` (the independently-computed true share), and separately, expenses
  `−32,584.53` + settlements `+32,962.06` = `+377.53` = Palle `360.55` + Kristine `16.98`,
  the file's own footer.
- **Settlements import uncategorized on purpose.** A `Payment`-category row or a
  `Settle all balances` description is debt being paid off, not a new expense — its net
  cancels the matching (also-uncategorized) bank outflow in Ready to Assign without
  touching any category. A settlement between two *selected* members nets to zero and is
  skipped outright — money moving inside the shared budget has no effect on it.
- **Category mapping is deliberately incomplete** — `Groceries`, `Rent`/`Mortgage`, `Gas/
  fuel`/`Taxi`, the utility labels, and `Entertainment - Other` map onto seeded category
  names; `General` (the largest single bucket), `Household supplies`, and `Hotel` are left
  unmapped rather than guessed. This is exactly what PR 9's `payee_rules` are for — the
  rules layer already applies above every provider, so a rule like `Pepco` → Utilities
  reaches Splitwise rows for free.
- **`ImportOptions { members?: string[] }`** is a new optional parameter threaded through
  the whole parser pipeline (`StatementParser`, `parseStatement`, the `PARSERS` registry) —
  additive and backward-compatible, since Wise/BECU simply ignore it. `ParseResult` gained
  `participants?: string[]` so a provider can report discoverable choices (Splitwise's
  header names) back to the UI before a real import commits, via a new dry-run
  **`POST /budgets/:id/imports/inspect`** endpoint that parses and writes nothing.
  `accounts.import_options` (one nullable JSON column, mirroring the existing
  `accounts.import_provider`) remembers the last-used selection per account so repeat
  imports pre-check the same people.
- **`importId` is deliberately independent of which members are selected**
  (`date|description|costMinor|occurrence`) — it identifies the Splitwise *row*, not the
  imported net. Re-importing the same file with a different selection is therefore a no-op;
  changing the selection means undo, then re-import.
- Purely additive migration (one nullable column, `accounts.import_options`, that nothing
  on `main` references) — the normal `uat` → `stg` → `main` path, not the breaking-migration
  exception.

**Category and category-group CRUD landed in PR 12.** The API (`src/routes/categories.ts`)
had supported create/rename/reorder/hide/delete for both categories and groups since PR 4 —
correctly guarded against editing system-managed rows — but nothing in `web/src/` ever
rendered a control for any of it; `BudgetMonth.tsx` showed a category's name as plain,
uneditable text. This PR closes that gap entirely client-side, no backend changes:

- **Lives inline in `BudgetMonth.tsx`**, not a separate nav tab — categories are viewed here
  constantly, and it's the natural place for it. Per-group controls (Rename, Hide/Unhide,
  "+ Add category", and Delete when empty) sit in the group's header row; per-category
  controls (Rename, Hide/Unhide, Delete) sit next to the existing Set-target/Move buttons —
  same "extra `<tr>` toggled by a button" mechanic the file already used for those two.
  `CategoryGroupForm.tsx`/`CategoryForm.tsx` (new, tiny) mirror `AccountForm.tsx`'s
  toggle-a-create-form pattern; the CRUD handlers mirror `PayeeRules.tsx`'s
  apiFetch-in-a-try/catch, reload-after-mutation, `window.confirm`-before-delete shape.
- **`hidden` went from a schema field with no effect to a real one.** `hiddenAt` existed on
  both tables since PR 4 but nothing filtered on it — a "hidden" category looked identical to
  a visible one. The grid's row filter became `c.kind !== 'income' && (showHidden ||
  !c.hiddenAt)`, with a "Show hidden (N)" toggle below the table revealing hidden rows
  greyed out with an Unhide button. The `assignable` list (feeds the Move-to and target
  dropdowns) stays hidden-excluded regardless of `showHidden` — moving money into something
  hidden isn't the point of hiding it.
- **A real bug surfaced by writing the smoke test, fixed before shipping:** the group
  header's original early-return (`if (rows.length === 0) return null`) — reasonable when
  there was no way to act on an empty group — silently ate every freshly created group,
  since a brand-new group has zero categories by definition. "+ Add group" would work, the
  group would exist server-side, and then nothing would render at all: no way to add a
  category into it, no way to delete it, through the UI. Fixed by only collapsing a group
  when it has categories that are *all* filtered out by hiddenness — a genuinely empty group
  (`nonIncomeCount === 0`) always renders its header.
- **Delete stays a true soft-delete, distinct from Hide** — matching the API's own existing
  design (its DELETE handler's comment: hide is what a user normally wants for "don't use
  this anymore but keep history"; delete is offered too since it's allowed unconditionally
  for `spending` categories and soft-delete already preserves the row for historical ledger
  recomputation either way).
- **System-managed rows get zero controls, not disabled ones** — a group with `isSystem:
  true` (the auto-created "Credit Card Payments" group) or a category with `kind !==
  'spending'` renders name/amounts only, mirroring the API's own `400 system_managed`
  guardrails rather than offering a button that always fails.
- No migration — `web/src/types.ts` gained `sortOrder`/`note` (category) and
  `hiddenAt`/`sortOrder` (group), fields the API already serialized on the wire since PR 4
  but the frontend never declared.

**AACU import landed in PR 13** (`src/import/aacu.ts`), the fourth import provider and the
third bank/credit-union CSV (after Wise and BECU). Close to BECU's shape — `M/D/YYYY` dates,
sign decided by which of Debit/Credit is populated rather than the printed character, one
free-text description column carrying the transaction type — but two things about this
export are AACU's own, found by analyzing a real 52-row file before writing any parser code:

- **A `Status` column (`Posted`/`Pending`), and a pending row's description is printed in a
  structurally different shape than the same transaction once posted** — no
  `Withdrawal POS #… / … Card NNNN` wrapper at all, just the raw merchant string. Because
  `import_id` is content-derived (this format has no transaction-id column either), a pending
  row can never dedupe against its own later-posted version — importing it would guarantee a
  duplicate once the bank posts it. **Pending rows are skipped**, with a visible reason in the
  import summary, rather than imported as `uncleared`; they import normally, once, when they
  post. One deliberate test case: nine real rows have `Posted` status but contain the literal
  word `PENDING` inside Uber's own descriptor (`UBER * PENDING …`) — the parser has to key off
  the `Status` column, not scan description text, and a test pins exactly that.
- **Dividend credits print as `.01`, not `0.01`.** `parseAmountToMinor`
  (`src/lib/money.ts`) requires a digit before the decimal point and throws on a bare leading
  dot; copying BECU's amount reader verbatim would have silently dropped both dividend rows
  as "neither Debit nor Credit had a readable amount" — the kind of bug that's invisible
  unless you go looking for it, since a skip is only visible in the import summary's list, not
  a crash. Caught by reconciling the file's own running Balance column against the parser's
  output *before* writing the fix, and pinned by a regression test asserting `.01` parses to
  `1` minor unit.
- **`toIsoDate`** (BECU's private `M/D/YYYY` → `YYYY-MM-DD` converter) moved to a new shared
  `src/import/dates.ts` now that a second provider needs the identical logic — `becu.ts`
  imports it instead of declaring its own copy. The existing BECU golden-test suite is what
  guarantees the move is behavior-preserving.
- Verified end to end against the real file: walking the 51 posted rows from an implied
  opening balance of `$336.74` (the oldest row's own stated balance minus that row's signed
  amount) reproduces every stated `Balance` to the cent, ending at `$270.21` — net `−$66.53`.
  That balance-column reconciliation, not a hand-summed literal, is the whole-file test's
  ground truth (stronger than BECU's, which had no running-balance column to check against).
  A real-browser smoke test against the actual file confirmed the same `−$66.53` on a fresh
  account's register, cleaned merchant names, the pending row's skip reason visible in the UI,
  and a zero-row re-import.
- No migration, no route change — `cleared` stays hardcoded `'cleared'` for every provider
  (skipping pending rows means the parser contract doesn't need a `cleared` field), and
  `accounts.import_provider`/`import_batches.provider` are free-form `text` columns that
  needed no schema change to accept `'aacu'`.

**Linking two existing transactions as a transfer landed in PR 14**
(`src/routes/transactions.ts`, `web/src/components/Register.tsx`). Until now a transfer
could only be *created* as a fresh pair of rows, which is no help when both halves already
exist — the recurring case being one real money movement that arrives through two different
statement imports: a Venmo outflow on a bank account and the matching Splitwise settlement
inflow on the clearing account.

- **Linking is arithmetically a no-op, and that's the point.** An uncategorized
  non-transfer row on an on-budget account moves Ready to Assign by its own amount, so an
  equal-and-opposite pair already nets to zero before linking; afterwards both legs take
  `computeLedger`'s `isTransfer` branch and contribute nothing at all. Same total either
  way. What linking buys is that the pair can no longer *drift*: a stray category or a
  payee rule can't silently turn one half into spending, and a pair straddling a month
  boundary stops distorting either month's income. Pinned by a test asserting Ready to
  Assign is byte-identical before and after a link.
- **A categorized row is refused, not silently fixed.** That case genuinely changes the
  arithmetic (the category activity stays, but the counterpart's Ready-to-Assign movement
  disappears), so `is_categorized` is a 400 and the UI hides the button — the only way to
  keep "link" from moving money behind the user's back. Same for split parents/children,
  same account, currency mismatch, non-offsetting amounts, and a zero/zero pair (which is
  not a transfer of anything and would link two unrelated rows on a technicality).
- **Suggestions are exact-amount only**, opposite sign, different account, within
  `TRANSFER_MATCH_WINDOW_DAYS` (5) — a near-miss match on money is a guess, and this
  feature exists to remove ambiguity, not add it. Validated against the real UAT budget:
  across ~430 transactions the rule proposed exactly 3 pairs, all genuine settlements, no
  false-positive flood despite recurring round amounts like rent.
- **One shared eligibility check** (`transferLinkBlocker`) backs both the candidate search
  and the link itself, so the button the UI offers and the rule the API enforces can't
  drift apart — the candidate endpoint returns `{ candidates: [], blocked: <reason> }`
  rather than silently offering nothing.
- **Unlink is included**, and works on any transfer, not just links this endpoint made —
  mis-linking shouldn't be a trap whose only exit is deleting imported rows. Worth knowing
  the asymmetry: deleting one leg of a transfer cascades to delete *both*
  (`softDeleteTransactionCascade`), whereas unlinking leaves both rows intact as ordinary
  transactions.
- No migration, no schema change — `transactions.transfer_transaction_id`/
  `transfer_account_id` already existed; linking just sets them on rows that already exist.

**Neo Mastercard import + budgetable foreign-currency accounts landed in PR 15**
(`src/import/neo.ts`, `migrations/0007_account_fx_rate.sql`, `src/lib/money.ts`,
`src/routes/accounts.ts`, `src/routes/imports.ts`), driven by two real Neo statements (a
Canadian credit card, CAD, 20 rows total). This is the first account that's both foreign-
currency *and* actually budgeted — PR 7 deliberately scoped multi-currency to
off-budget-only (see above); this PR lifts that, for accounts with a rate.

- **The one dangerous assumption that had to be fixed first.** `src/routes/imports.ts`
  hardcoded `budgetAmountMinor: row.amountMinor` for every ordinary imported row, and
  `insertTransaction`'s fallback (`src/budget/transactions.ts`) is
  `input.budgetAmountMinor ?? input.amountMinor`. Both were safe only because a
  foreign-currency account could never be on-budget — the moment that restriction lifts,
  those two lines silently inject CAD numbers into USD categories. Fixing the conversion
  at both call sites (imports, and an account's starting balance) is the actual core of
  this PR; the parser itself is the easy part.
- **`src/domain/ledger.ts` needed zero changes.** It already reads `budgetAmountMinor`
  exclusively and gates only on `account.onBudget` — a foreign account with a *correct*
  `budgetAmountMinor` on every row gets right category activity, Ready to Assign, and
  credit-card payment-category mechanics for free. `test/months.test.ts` has a regression
  test that exists specifically to prove this: a CAD credit card with a rate, one
  categorized charge, asserting the converted USD activity and the payment-category
  earmark — no ledger code touched to make it pass.
- **Rate representation:** a new nullable `accounts.fx_rate_micros` (integer,
  budget-currency-per-1-unit-of-account-currency × 1,000,000 — `0.73` CAD→USD rate is
  `730000`), not a float, matching the no-floats-for-money discipline elsewhere in this
  codebase even though a rate isn't itself money. **Guardrail: a foreign-currency account
  may be on-budget only if it has a rate** — creating/updating one without a rate falls
  back to off-budget exactly as before (regression-tested against the existing
  Wise-CAD-subaccount case), and importing into an on-budget foreign account with no rate
  anywhere (typed-in or remembered) is a 400 `missing_fx_rate`, never a silent 1:1
  fallback. The rate is entered per import and remembered on the account
  (`accounts.fx_rate_micros`) as next time's default — the same "remember the last choice"
  shape as PR 10's `accounts.import_options`, but a real column rather than JSON, since an
  FX rate is an account property, not a per-provider parsing choice.
- **A `Status` column that includes `Declined`, not just `Posted`/`Pending`.** The real
  July file contains a $1,452.51 marina charge that was declined — never actually spent.
  Importing it would invent debt that doesn't exist, so `Declined` rows are skipped with a
  visible reason, same treatment as the `Pending` skip (a pending row can't dedupe against
  its own later-posted version — the same reasoning as AACU's `Pending` skip in PR 13).
  Verified end to end against both real files: 20 rows in, 18 imported (1 Declined + 1
  Pending skipped), and a real-browser smoke test confirmed the converted USD category
  activity, the "Neo" payment-category earmark, both skip reasons visible in the review
  summary, and a zero-row re-import.
- **A real UI staleness bug, caught by the smoke test, fixed before shipping:**
  `ReviewImport` only refetched on mount, so importing a second file while the Review tab
  was already open (not navigating to it fresh) left the table showing the first file's
  rows until something else happened to remount it — not Neo-specific, any two-file import
  session in one sitting hit this. Fixed with a `refreshToken` prop bumped by
  `Budget.tsx`'s `reloadUnapproved` (same shape as `BudgetMonth`'s existing
  `refreshToken`/`accountsVersion`).
- **A follow-up gap, found right after shipping the above and closed the same day:**
  manual transaction entry (`POST`/`PATCH /transactions`) didn't apply an account's
  `fx_rate_micros` — only statement import and an account's starting balance did. A
  manual charge on a budgeted foreign-currency account wrote `budgetAmountMinor =
  amountMinor` unconverted, the same bug class the rest of this PR fixes for import; it
  just wasn't in the originally-approved file list. **Closed for ordinary and split
  create/edit** (`budgetAmountFor` in `src/routes/transactions.ts`; a split's parent
  converts as the *sum of its converted children*, not an independent conversion of the
  total, so it stays exactly equal to the sum of its children — same rule
  `insertSplitTransaction` in `src/budget/transactions.ts` uses). **Deliberately still
  open: manual transfers between different-currency accounts** — `POST /transactions`'s
  transfer path applies one `amount` magnitude to both legs regardless of currency,
  which predates this PR entirely (it was latent because no foreign account could be
  on-budget before now) and needs its own pass across transfer create/edit, picking
  which side's rate governs each leg. Worth knowing: Neo's own `Payment Received` rows
  arrive through statement import, not a manual transfer, so they're already converted
  correctly — this gap only bites a manually-entered payment.
- **Also flagged, not fixed — a pre-existing data bug this PR's own investigation
  surfaced:** UAT's `Cash (CAD)` account has a manually-entered starting balance whose
  `budget_amount_minor` was never converted (`native = budget = 1282.68`, versus its
  Wise-imported rows, which carry a real ~1.428 implied rate) — overstating that account's
  contribution to net worth by roughly $383. Now that the rate machinery exists, this is a
  one-row data fix, offered to the user rather than applied automatically.
- No change to `docs/plan.md`'s "Guarding the shared production database" migration
  discipline — `fx_rate_micros` is purely additive (a new nullable column nothing on
  `main` currently references), so this shipped through the normal `uat` → `stg` → `main`
  path per `CLAUDE.md`, not the breaking-migration shortcut.

---

## Roadmap

**Phase 2 — Make it a budgeting tool, not a ledger.** ~~Category targets/goals (monthly,
by-date, refill vs. build).~~ **Landed in PR 6.** ~~Reports: spending by category, income
vs. expense, net worth.~~ **Landed in PR 8** — see above. Scheduled/recurring transactions
(`scheduled_transactions` table; `transactions.scheduled_transaction_id` already exists).
Full reconciliation with adjustment transactions.

**Phase 3 — Shared budgets.** `budget_invites` table, invite-by-email reusing the
magic-link token machinery. Roles enforced at the route layer — authorization already
reads `budget_members`, so this is mostly UI. Activity log from the `revision` stream.
Delta sync endpoint (`GET /budgets/:id/changes?since=N`) so two people on the same budget
see each other's edits.

**Phase 4 — Statement import.** *Partially landed in PR 7, PR 9, PR 10, PR 13, and PR 15* —
per-provider CSV parsers (Wise, then BECU, then Splitwise, then AACU, then Neo Mastercard),
an approve-imported-transactions queue, idempotent re-import, a provider-agnostic naming
heuristic plus user-defined `payee_rules`, and — new in PR 10 — a non-bank provider modeled
as a net-position clearing account with per-import member selection (see PR 10's notes
above). Still to come: learned
payee→category frequency (rules today are explicit, never inferred from history); a
column-mapping UI for arbitrary CSVs and per-bank saved mappings; then OFX/QFX/QIF
(structured, carries FITID); PDF last. Uploads land in R2, parsing runs through Queues for
anything large. `import_batches` tracks a run; `transactions.import_id` makes re-imports
idempotent. ~~Auto-matching a Splitwise settlement to its bank transaction as a transfer
would need cross-account amount/date matching.~~ **Landed in PR 14** — suggested matches
plus manual linking of two already-imported rows (see below). Still to come there: doing it
automatically at import time rather than on request, and the cross-currency case (PR 14
requires both legs in the same currency), which is precisely the Phase 5 work below.

**Phase 5 — Full multi-currency.** *Partially landed in PR 15* — a foreign-currency account
can now be genuinely on-budget, given a per-import exchange rate remembered on the account
(`accounts.fx_rate_micros`); `budget_amount_minor` carries a real conversion on that
account's imported rows, its starting balance, and (closed same-day as a fast follow-up)
manually-entered/edited ordinary and split transactions (see PR 15's notes above). Still to
come: the same conversion on manual **transfers** between different-currency accounts
(`POST /transactions`'s transfer path still applies one amount to both legs regardless of
currency — a known, flagged gap predating this PR, not yet closed); per-transaction/
historical rates rather than one flat rate per import; retroactive re-conversion when an
account's rate changes (today only future imports/entries pick up a new rate); an
`exchange_rates` table for reporting-only conversions where no transaction supplies a rate;
FX revaluation of foreign-currency balances over time.

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
| `stg` | `budgetapp-stg` | `budgetapp-db` (prod) | **applied — unless breaking** | disabled |
| `uat` | `budgetapp-uat` | `budgetapp-uat-db` | **applied** | **enabled** |

`stg`'s "unless breaking" is a per-migration judgment call, not a fixed policy — see
"Guarding the shared production database" below and, for the operational sequencing rule
an agent working in this repo follows (uat first, stop for approval, then stg/main), the
project's `CLAUDE.md`.

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
stg  deploy : npx wrangler d1 migrations apply budgetapp-db --env stg --remote && npx wrangler deploy --env stg
uat  deploy : npx wrangler d1 migrations apply budgetapp-uat-db --env uat --remote \
              && npx wrangler deploy --env uat
```

`stg`'s deploy command applies migrations now — see "Guarding the shared production
database" for when that step is deliberately skipped for a given promotion (rare, and a
per-migration decision, not a standing config).

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

`stg` points at production data, so the invariant is: *`stg` may never run code that needs
a schema production's currently-live code can't tolerate.* That's a narrower requirement
than "stg's schema must exactly match what's applied" — the original version of this
section required the latter, unconditionally skipping `stg` for every migration, which was
stricter than necessary. Since every migration in this repo is already required to be
expand/contract (below), most migrations are just as safe to apply to `stg` as an app-only
change is, and `stg` rehearsing them against real production data before `main` sees them
is a real extra checkpoint worth keeping, not one worth skipping by default.

The corrected promotion flow:

- **App-only changes**: feature → `uat` → `stg` → `main`. Unchanged.
- **Additive (expand-only) migrations** — a new table, a new nullable column, a new
  index; anything the code *currently live on `main`* can simply ignore because it never
  references it: feature → `uat` → `stg` → `main`. **This is now the default** for a
  migration-carrying change, matching the app-only path, because that's what
  expand/contract discipline (point 2 below) is supposed to guarantee is always safe.
- **A migration that would break the currently-live `main` code** (a rename, a drop, a new
  `NOT NULL` column with no safe default, an incompatible type change): feature → `uat` →
  `main`, **skipping `stg`**. `stg` is left on its previous version until `main` is
  promoted. This should be rare — it's precisely the case expand/contract exists to avoid
  needing.

Which bucket a given migration falls into is a judgment call made by reading its SQL, not
something a script can fully automate — `scripts/assert-schema-current.mjs`'s old
unconditional "any unapplied migration fails the `stg` build" behavior is no longer the
default `stg` deploy command (see the deploy commands above); it remains available as a
manual diagnostic if you want to check `budgetapp-db`'s pending-migration state before
deciding. See the project's `CLAUDE.md` for the full operational sequencing rule an agent
follows here, including the hard "stop and wait for UAT approval before touching
`stg`/`main`" gate.

Two further consequences of `stg` sharing production data, both worth stating plainly:

1. Even with the schema aligned, `stg` running a buggy mutation will damage real data.
   Treat `stg` deploys with production care regardless of whether this promotion carries a
   migration.
2. Because `stg` and `main` can briefly run different code against the same schema mid-
   promotion, **every migration must be expand/contract**: add nullable columns, backfill,
   switch reads, drop in a later release — never rename or drop in a single migration. This
   was already the rule; it's now also the reason the default case above is safe.

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
3. Email sent through an `EmailSender` interface (`src/lib/email.ts`). **PR 2 wired up
   only a console-logging implementation** — real delivery was deliberately deferred:
   the account had no verified sending domain yet, and the interface exists precisely
   so plugging in a real provider later is a one-file change plus one line where it's
   constructed, not a rewrite of the auth routes. **PR 11 landed that real provider,
   live in all three environments** — see below.

   **Real delivery via Cloudflare Email Service (PR 11).** The account now has a paid
   Workers plan and a custom domain (`budget-uat.naught.ca`) pointed at the
   `budgetapp-uat` Worker, so this was picked up. One correction along the way: the
   first instinct was Cloudflare's `send_email` binding as part of **Email Routing** —
   wrong tool, because that one only delivers to addresses pre-verified as a
   "destination address" in the dashboard, which can't work for arbitrary sign-up
   emails. The actual fit is **Cloudflare Email Service** (public beta, launched April
   2026, billed against the Workers Paid plan — 3,000 free sends/month, then
   $0.35/1000) — a genuine transactional sender for arbitrary recipients once a sending
   domain is onboarded (`wrangler email sending enable <domain>`). It happens to reuse
   the exact same `send_email` binding name/shape and `cloudflare:email`
   `EmailMessage`/`env.EMAIL.send()` API as Email Routing's binding, which is what made
   the first, wrong guess plausible.

   `CloudflareEmailSender` (`src/lib/email.ts`) is the new default in `src/index.ts`,
   replacing `ConsoleEmailSender` — safely, because it self-degrades to
   `ConsoleEmailSender` whenever `env.EMAIL`/`env.EMAIL_FROM` aren't both present.
   Landed in two steps:

   - **First, `uat` only**, verified end to end (a real magic-link email requested
     against the deployed `budgetapp-uat` Worker and confirmed received) before
     touching `stg`/`main`, per this file's deploy-gate discipline. `EMAIL_FROM` is a
     plain `var`, not a `wrangler secret put` value as originally anticipated below —
     it isn't sensitive, and a committed var is reviewable, the same treatment
     `ENVIRONMENT` already gets.
   - **Then extended to `stg` and `main`** — `noreply@budget-stg.naught.ca` and
     `noreply@budget.naught.ca` respectively, both onboarded with Cloudflare Email
     Service the same way. All three environments now send real mail; local
     `wrangler dev` (unscoped, top-level config) does too, but only against
     Miniflare's local simulation — no `remote: true` anywhere, so nothing outside an
     actual `wrangler deploy` ever calls the real API. One workflow side effect worth
     knowing: local dev's magic-link sign-in no longer prints the plain
     `[auth] magic link for ...: <url>` line — Miniflare's own send_email simulation
     log takes over instead, giving From/To/Subject plus file paths holding the
     text/HTML bodies (the confirm URL is inside those files) rather than the link
     inline. Still fully offline, just one extra step to read.

   Send failures are logged and swallowed, never thrown, everywhere — `/magic-link`'s
   "always 200, identical response" anti-enumeration invariant must survive a provider
   hiccup.

   One type-safety wrinkle from the `uat`-only step, resolved once `stg`/`main` caught
   up: every binding until then (`DB`, `AUTH_RATE_LIMITER`, `ASSETS`, `ENVIRONMENT`)
   was declared identically across all three `wrangler.jsonc` environments, so the app
   never had to type a binding that existed on only one of them. The ambient global
   `Env` type `wrangler types` generates mirrors the **top-level** config only
   (`Cloudflare.UatEnv` was a separate, unused-by-app-code shape) — so while `EMAIL`
   was `uat`-only, `EMAIL`/`EMAIL_FROM` had to be hand-added as *optional* fields on
   `AppEnv['Bindings']` in `src/types/hono.ts` rather than left to codegen. Once the
   binding+var were added to the top-level and `env.stg` blocks too, regenerating
   picked them up as required fields on the real ambient `Env` — the hand-augmentation
   in `hono.ts` was removed, back to plain `Bindings: Env`. `EmailSender.sendMagicLink`
   keeps its second parameter, `env: AppEnv['Bindings']`, threaded from `c.env` at the
   one call site in `src/routes/auth.ts` — still necessary regardless of how many
   environments have the binding, since it's only knowable per-request, not when
   `createApp()` builds the app once at module scope.
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

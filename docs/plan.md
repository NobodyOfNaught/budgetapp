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

`budget_invites`, `payee_rules`, `exchange_rates`, `scheduled_transactions`. All are
additive — new tables referencing columns that already exist. None require touching
`transactions`.

`category_targets` was on this list through PR 5 — it landed in PR 6. `import_batches`
was on it through PR 6 — it landed in PR 7 (both below).

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

---

## Roadmap

**Phase 2 — Make it a budgeting tool, not a ledger.** ~~Category targets/goals (monthly,
by-date, refill vs. build).~~ **Landed in PR 6** — see below. Reports: spending by
category, income vs. expense, net worth. Scheduled/recurring transactions
(`scheduled_transactions` table; `transactions.scheduled_transaction_id` already exists).
Full reconciliation with adjustment transactions.

**Phase 3 — Shared budgets.** `budget_invites` table, invite-by-email reusing the
magic-link token machinery. Roles enforced at the route layer — authorization already
reads `budget_members`, so this is mostly UI. Activity log from the `revision` stream.
Delta sync endpoint (`GET /budgets/:id/changes?since=N`) so two people on the same budget
see each other's edits.

**Phase 4 — Statement import.** *Partially landed in PR 7* — per-provider CSV parsers
(Wise first), an approve-imported-transactions queue, and idempotent re-import. Still to
come: a column-mapping UI for arbitrary CSVs and per-bank saved mappings; then OFX/QFX/QIF
(structured, carries FITID); PDF last. Uploads land in R2,
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

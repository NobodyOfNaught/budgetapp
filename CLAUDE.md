# Instructions for Claude working in this repo

This file is operational instructions for an agent working in this codebase — not user
documentation. See `docs/plan.md` for the actual product/architecture plan; this file only
covers *process*, and right now that means one thing: how deploys are sequenced.

## Deployment process

Three environments: `uat` (own database, `budgetapp-uat-db`), `stg` (shares the
**production** database, `budgetapp-db`), and `main`/prod (`budgetapp-db`). Full
architecture in `docs/plan.md`'s "Environments & deployment" section. This section is the
sequencing rule — read it before running any `wrangler deploy` or
`wrangler d1 migrations apply --remote` command.

### The rule, in order

1. **Always deploy to `uat` first**, migration included if there is one. Verify it —
   health check at minimum, a real smoke test where the change warrants one (see prior
   PRs' pattern: Playwright against `wrangler dev`, or exercising the deployed UAT URL
   directly).

2. **Stop. Do not deploy to `stg` or `main` until the user has tried the `uat` deployment
   and explicitly approved moving on.** This is a hard gate, not a suggestion — never
   cascade straight through all three environments in one turn just because `npm run
   check` passed. Report exactly what's live on UAT (URL, what changed, how to try it) and
   end your turn there. Only continue once the user says to.

3. Once approved, the `stg` step depends on whether this change carries a migration:

   - **No migration** — deploy to `stg`, confirm it's healthy, then deploy to `main`.
     Always goes through `stg`; there's no reason to skip it.

   - **Migration that does NOT break the currently-live `main` code** — apply it and
     deploy to `stg` too (same as the no-migration case), confirm healthy, then `main`.
     **This is the default for a migration-carrying change now, not the exception.** A
     migration qualifies here if it's purely additive: a new table, a new nullable
     column, a new index — anything the code *currently running on `main`* can simply
     ignore because it never references it. This is also just the "expand" half of the
     expand/contract discipline every migration in this repo is already supposed to
     follow (see `docs/plan.md`), so in practice this should be the common case.

   - **Migration that WOULD break the currently-live `main` code** — skip `stg` for this
     promotion: deploy `uat` → get approval → deploy straight to `main`. `stg` is left
     untouched, still on its previous version, until `main` is promoted (at which point
     `stg`'s *next* deploy will pick up both the new schema and the new code together).
     This is the rare case, reserved for something that genuinely can't be split into an
     expand/contract pair — a rename, a drop, a new `NOT NULL` column with no safe
     default, an incompatible type change.

4. **Judging which bucket a migration falls into is a real judgment call — make it
   explicitly, in one sentence, before deploying, and say so in your response to the
   user.** e.g. "additive only: new `import_batches` table + nullable
   `accounts.import_provider` column, nothing on `main` today references either — safe
   for `stg`." Skipping `stg` needs justification; it is not the cautious default.

### Commands, per environment

```sh
# uat — always first
npx wrangler d1 migrations apply budgetapp-uat-db --env uat --remote   # if there's a migration
npx wrangler deploy --env uat

# --- STOP for user approval before continuing ---

# stg — same shape as uat, now that stg/'s d1_databases entry carries
# migrations_dir (see wrangler.jsonc's stg block for why this wasn't
# always true). Run this for BOTH the no-migration case and the
# additive-migration case above.
npx wrangler d1 migrations apply budgetapp-db --env stg --remote   # if there's a migration
npx wrangler deploy --env stg

# main — last, always
npx wrangler d1 migrations apply budgetapp-db --remote   # if there's a migration
npx wrangler deploy --env=""
```

For the rare breaking-migration path, skip the `stg` block entirely and go straight from
the UAT approval to the `main` block.

After every deploy, check `<url>/api/v1/health` on whatever you just touched before
moving on or reporting done.

### Why this changed

The original design (see `docs/plan.md`'s "Guarding the shared production database" and
`scripts/assert-schema-current.mjs`) had `stg` **never** apply migrations — any
migration-carrying change skipped `stg` unconditionally and went straight `uat` → `main`.
That was stricter than necessary: since every migration here is already supposed to be
additive (expand/contract), most migrations are just as safe to rehearse against real
production data via `stg` as an app-only change is. The corrected rule above makes `stg`
the default checkpoint again for those, and reserves skipping it for the genuinely
unsafe case. `scripts/assert-schema-current.mjs` is no longer the default `stg` gate —
it's still a valid read-only diagnostic ("what's pending against `budgetapp-db` right
now") if you want to sanity-check state before deciding, but it's not run automatically
as part of the `stg` deploy anymore.

### If deploys are ever wired to real CI instead of run by hand

Everything above describes the commands to run by hand from this session, which is how
every deploy in this project has actually happened so far (the Cloudflare Workers Builds
git integration described in `docs/plan.md` is configured but not the live path, since
work stays on one feature branch rather than being pushed to `main`/`stg`/`uat`). If that
ever changes, the `budgetapp-stg` Worker's **Deploy command** in the Cloudflare dashboard
needs updating to match — from the old assert-only gate to:

```
npx wrangler d1 migrations apply budgetapp-db --env stg --remote && npx wrangler deploy --env stg
```

That's a manual dashboard edit only the user can make (same as the rest of Workers Builds
setup) — flag it rather than assuming it's already done.

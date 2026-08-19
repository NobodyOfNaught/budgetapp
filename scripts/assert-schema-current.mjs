#!/usr/bin/env node
// Optional manual diagnostic for `stg`, which shares the PRODUCTION database
// (see the plan: "Guarding the shared production database" and CLAUDE.md's
// "Deployment process"). It is no longer the default stg deploy-command gate
// — stg now applies migrations itself (`wrangler d1 migrations apply
// budgetapp-db --env stg --remote`) for anything additive, same as any other
// env, and only a migration judged to break the currently-live prod code
// skips stg entirely. This script still answers a narrower, useful question
// on demand: "is stg's schema fully caught up with what's been applied
// elsewhere?" — run it by hand if that's ever in doubt.

import { spawnSync } from 'node:child_process';

const DATABASE = 'budgetapp-db';

const result = spawnSync(
  'npx',
  ['wrangler', 'd1', 'migrations', 'list', DATABASE, '--env', 'stg', '--remote'],
  { encoding: 'utf8' },
);

if (result.error) {
  console.error('Failed to run `wrangler d1 migrations list`:', result.error);
  process.exit(1);
}

const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
console.log(output.trim());

if (result.status !== 0) {
  console.error('\n✗ wrangler d1 migrations list exited non-zero — treating as unsafe to deploy.');
  process.exit(1);
}

// wrangler prints the filenames of any UNAPPLIED migrations (this command's
// entire job is "view a list of unapplied migration files") inside a
// box-drawn table, e.g. "│ 0001_add_foo.sql │" — so this matches the
// filename pattern anywhere in the output, not anchored to a full line.
const pending = [...new Set(output.match(/\d{4}_[\w-]+\.sql/g) ?? [])];

if (pending.length > 0) {
  console.error(
    `\n✗ ${DATABASE} (stg) is missing ${pending.length} migration(s): ${pending.join(', ')}\n` +
      '  Apply it with `wrangler d1 migrations apply budgetapp-db --env stg --remote`\n' +
      '  (unless it is judged to break the currently-live prod code, in which case it\n' +
      '  should skip stg on purpose) — see CLAUDE.md\'s "Deployment process".',
  );
  process.exit(1);
}

console.log(`\n✓ ${DATABASE} schema is current — safe to deploy stg.`);

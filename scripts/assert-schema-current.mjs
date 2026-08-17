#!/usr/bin/env node
// Guards `stg`, which shares the PRODUCTION database (see the plan:
// "Guarding the shared production database"). The invariant: stg must never
// run code that expects a schema production doesn't already have. This
// checks that invariant directly, against the real remote database, rather
// than a proxy for it like "did this PR touch migrations/".
//
// Run as the stg deploy command, BEFORE `wrangler deploy --env stg`, so an
// unapplied migration fails the build instead of shipping.

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
      '  stg shares the production database and never applies migrations itself.\n' +
      '  Apply this migration via a `main` (prod) or `uat` deploy first — see the\n' +
      '  "Guarding the shared production database" section of the project plan.',
  );
  process.exit(1);
}

console.log(`\n✓ ${DATABASE} schema is current — safe to deploy stg.`);

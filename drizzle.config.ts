import { defineConfig } from 'drizzle-kit';

// Used only for `drizzle-kit generate` (turning future schema.ts changes into
// new migration files to review and merge into migrations/ by hand) and for
// drizzle-kit's `studio` command against a local D1 snapshot. Deploys never
// invoke drizzle-kit — `wrangler d1 migrations apply` is what actually runs
// the SQL in migrations/, straight from the plan's deploy commands.
export default defineConfig({
  dialect: 'sqlite',
  driver: 'd1-http',
  schema: './src/db/schema.ts',
  out: './migrations',
});

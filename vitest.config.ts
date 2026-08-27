import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Route tests run against a REAL D1 database inside workerd (via
// @cloudflare/vitest-pool-workers), not a mock — see the plan's
// "Verification" section. migrations/ is applied to that test database in
// test/apply-migrations.ts before each test file runs.
//
// Tests point at wrangler.jsonc's `uat` environment: it has its own D1
// database (isolated from prod) and, like every environment here, an
// `assets` block, which is why `pretest` (package.json) makes sure
// web/dist exists before vitest starts.
export default defineConfig(async () => {
  const migrationsPath = path.join(__dirname, 'migrations');
  const migrations = await readD1Migrations(migrationsPath);

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc', environment: 'uat' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // A fixed, throwaway AES-256 key so the credential-storage
            // tests exercise real encryption rather than a stub. Fine to
            // hardcode precisely because it protects nothing: the test D1
            // is created and destroyed per run. The real environments get
            // theirs from `wrangler secret put CREDENTIALS_KEY`.
            CREDENTIALS_KEY: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
      // `tsc -b`'s composite build output (see tsconfig.*.json) lands in
      // .tsbuild/ and would otherwise get picked up as duplicate test files.
      exclude: ['**/node_modules/**', '**/.tsbuild/**'],
    },
  };
});

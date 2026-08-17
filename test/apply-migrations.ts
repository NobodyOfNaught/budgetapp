import { applyD1Migrations, env } from 'cloudflare:test';

// Runs once per test file (setupFiles) against the in-memory D1 instance
// each test worker gets, so route tests exercise the exact SQL in
// migrations/, not a hand-maintained fixture schema.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

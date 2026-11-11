#!/usr/bin/env node
// Calls the budget API as the owner, through the bearer token (migrations/0012).
//
//   NODE_USE_ENV_PROXY=1 node scripts/budget-api.mjs --env prod GET /accounts
//   NODE_USE_ENV_PROXY=1 node scripts/budget-api.mjs --env prod PATCH /accounts/ID '{"importStartDate":"2026-08-19"}'
//
// Paths are relative to /api/v1/budgets/<the one budget's id>, which is
// looked up for you. Like scripts/import-statement.mjs this holds NO token:
// the session proxy injects it (see CLAUDE.md). Output is the JSON body.
const HOSTS = { uat: 'https://budget-uat.naught.ca', stg: 'https://budget-stg.naught.ca', prod: 'https://budget.naught.ca' };
const argv = process.argv.slice(2);
const envIdx = argv.indexOf('--env');
const origin = HOSTS[argv[envIdx + 1]];
const rest = argv.filter((_, i) => i !== envIdx && i !== envIdx + 1);
const [method, path, body] = rest;
if (envIdx < 0 || !origin || !method || !path) {
  console.error('usage: budget-api.mjs --env uat|stg|prod METHOD /path [json-body]');
  process.exit(2);
}

async function call(m, p, b) {
  const headers = { Origin: origin, ...(b ? { 'Content-Type': 'application/json' } : {}) };
  if (process.env.BUDGETAPP_TOKEN) headers.Authorization = `Bearer ${process.env.BUDGETAPP_TOKEN}`;
  const res = await fetch(`${origin}/api/v1${p}`, { method: m, headers, body: b });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    console.error(`${m} ${p} -> ${res.status} ${JSON.stringify(json)}`);
    process.exit(1);
  }
  return json;
}

const { budgets } = await call('GET', '/budgets');
if (budgets.length !== 1) throw new Error(`expected exactly one budget, found ${budgets.length}`);
console.log(JSON.stringify(await call(method.toUpperCase(), `/budgets/${budgets[0].id}${path}`, body), null, 2));

#!/usr/bin/env node
// Imports statement files through the token-authenticated import API
// (migrations/0012, src/auth/middleware.ts's API_TOKEN_ROUTES).
//
//   NODE_USE_ENV_PROXY=1 node scripts/import-statement.mjs \
//     --env uat|prod --account "Vancity Visa" --provider ofx FILE [FILE...]
//
// This script holds NO token and reads none. In a Claude Code cloud session
// the token is saved as a network credential for the site's host, and the
// session's HTTPS proxy injects `Authorization: Bearer …` on the way out —
// so the token never appears in a command line, a file, or a chat. Hence
// NODE_USE_ENV_PROXY=1: Node's built-in fetch ignores HTTPS_PROXY without it,
// and a request that bypasses the proxy arrives with no token (401).
//
// Elsewhere, set BUDGETAPP_TOKEN and it is sent directly instead.
//
// Every import lands UNAPPROVED in the review queue and is undoable as one
// batch from the UI. The response's balance check is printed, so a file
// that doesn't reconcile is visible immediately.
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const HOSTS = { uat: 'https://budget-uat.naught.ca', stg: 'https://budget-stg.naught.ca', prod: 'https://budget.naught.ca' };

function parseArgs(argv) {
  const out = { files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--env') out.env = argv[++i];
    else if (a === '--account') out.account = argv[++i];
    else if (a === '--provider') out.provider = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else out.files.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const origin = HOSTS[args.env];
if (!origin || !args.account || !args.provider || args.files.length === 0) {
  console.error('usage: import-statement.mjs --env uat|stg|prod --account NAME --provider PROVIDER [--dry-run] FILE...');
  process.exit(2);
}

async function api(path, init = {}) {
  const headers = { 'Content-Type': 'application/json', Origin: origin, ...init.headers };
  if (process.env.BUDGETAPP_TOKEN) headers.Authorization = `Bearer ${process.env.BUDGETAPP_TOKEN}`;
  const res = await fetch(`${origin}/api/v1${path}`, { ...init, headers });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const hint = res.status === 401 ? ' (no valid token — is the credential saved for this host, and NODE_USE_ENV_PROXY=1 set?)' : '';
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${JSON.stringify(body)}${hint}`);
  }
  return body;
}

const { budgets } = await api('/budgets');
if (budgets.length !== 1) throw new Error(`expected exactly one budget, found ${budgets.length}`);
const budgetId = budgets[0].id;

const { accounts } = await api(`/budgets/${budgetId}/accounts`);
const account = accounts.find((a) => a.name.toLowerCase() === args.account.toLowerCase());
if (!account) {
  throw new Error(`no account named "${args.account}". Accounts: ${accounts.map((a) => a.name).join(', ')}`);
}
console.log(`${args.env}: ${account.name} (newest row ${account.lastTransactionDate ?? 'none'}, ` +
  `start date ${account.importStartDate ?? 'none'})`);

for (const file of args.files) {
  const text = await readFile(file, 'utf8');
  if (args.dryRun) {
    console.log(`  [dry run] would import ${basename(file)} (${text.length} bytes) as ${args.provider}`);
    continue;
  }
  const r = await api(`/budgets/${budgetId}/imports`, {
    method: 'POST',
    body: JSON.stringify({ accountId: account.id, provider: args.provider, filename: basename(file), csv: text }),
  });
  console.log(`  ${basename(file)}: imported ${r.imported}, skipped ${r.skipped.length}` +
    (r.beforeCutoff ? ` (${r.beforeCutoff} before the ${r.cutoffDate} floor)` : ''));
  const rec = r.reconciliation;
  if (rec) {
    const f = (m) => (m / 100).toFixed(2);
    console.log(rec.differenceMinor === 0
      ? `    balances: OK, ${f(rec.accountBalanceMinor)} ${rec.currencyCode} matches the statement`
      : `    balances: OFF by ${f(rec.differenceMinor)} ${rec.currencyCode} — app ${f(rec.accountBalanceMinor)}, statement ${f(rec.statementBalanceMinor)} as of ${rec.asOfDate}`);
  }
}

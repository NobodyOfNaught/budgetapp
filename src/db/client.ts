import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

/**
 * Drizzle handle for the control-plane tables (users, sessions, budgets,
 * budget_members) — anything not scoped to a single budget's data. Budget-
 * scoped tables (accounts, transactions, ...) get their own accessor when
 * they land in a later PR, since that's the seam that makes future
 * per-budget sharding possible without touching call sites — see
 * docs/plan.md, "Sharding: the answer to 'can we split the database later?'".
 */
export function getDb(env: Env) {
  return drizzle(env.DB, { schema });
}

export type Db = ReturnType<typeof getDb>;

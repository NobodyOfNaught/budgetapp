import type { Session } from '../auth/session';
import type { User } from '../auth/users';

/** Shared Hono generics: bindings from wrangler.jsonc + what auth middleware sets. */
export type AppEnv = {
  Bindings: Env & {
    // Only bound in wrangler.jsonc's env.uat today, not the top-level/prod
    // or env.stg blocks — see docs/plan.md's PR 11 notes. `wrangler types`
    // can't express "present on one named environment" in the ambient
    // global `Env` it generates (that always mirrors the top-level
    // config), so these are hand-added here as optional rather than
    // regenerated — which is also the more honest type, since a Worker
    // deployed from any other block genuinely won't have them at runtime.
    EMAIL?: SendEmail;
    EMAIL_FROM?: string;
  };
  Variables: {
    user: User;
    session: Session;
    budgetRole?: 'owner' | 'editor' | 'viewer';
  };
};

import type { Session } from '../auth/session';
import type { User } from '../auth/users';

/** Shared Hono generics: bindings from wrangler.jsonc + what auth middleware sets. */
export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: User;
    session: Session;
    budgetRole?: 'owner' | 'editor' | 'viewer';
  };
};

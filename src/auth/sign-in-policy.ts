import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { users } from '../db/schema';

/**
 * Who may sign in at all.
 *
 * This is a single-person site: one owner, one budget. Until now anyone
 * who could receive email could request a magic link and be handed a fresh
 * budget on the spot (src/auth/users.ts's auto-create), which is right for
 * a product with sign-ups and wrong for a private ledger of one person's
 * finances.
 *
 * The production policy is "existing users only": a magic link is issued
 * only to an address that already has a row in `users`, and no new user is
 * ever created. It needs no configuration — no allowlist secret that one
 * environment could be missing or have different from another — and it
 * fails closed by construction: an address the database has never seen
 * gets nothing. The owner's row already exists in every environment that
 * matters (prod received it in the UAT data copy).
 *
 * It is a parameter of createApp() rather than something configuration can
 * switch off, because the test suite needs the opposite — every test signs
 * in a fresh user so its data is isolated — and an "allow anyone" setting
 * that lived in config would be one mistake away from reopening sign-ups.
 * Code-only, so only a test can construct the open policy.
 */
export type SignInPolicy = (db: Db, emailNormalized: string) => Promise<boolean>;

export const existingUsersOnly: SignInPolicy = async (db, emailNormalized) => {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.emailNormalized, emailNormalized))
    .limit(1);
  return !!row;
};

/** Tests only — see the note above on why this is not reachable from config. */
export const anyoneMaySignIn: SignInPolicy = async () => true;

import { and, count, eq, gt } from 'drizzle-orm';
import type { Db } from '../db/client';
import { authTokens } from '../db/schema';

const EMAIL_COOLDOWN_WINDOW_MS = 15 * 60 * 1000;
const EMAIL_COOLDOWN_MAX_REQUESTS = 5;

/**
 * Cloudflare's native Rate Limiting binding only offers 10s/60s windows
 * (see wrangler.jsonc), which is a reasonable blunt "stop a script hammering
 * this endpoint" check keyed on IP, but too short a window to stop someone
 * spamming a real person's inbox. That's this function instead: it asks D1
 * directly "how many magic-link requests has this EMAIL triggered
 * recently", independent of who's asking. Two layers, two different jobs.
 */
export async function isEmailOverLimit(db: Db, emailNormalized: string): Promise<boolean> {
  const since = Date.now() - EMAIL_COOLDOWN_WINDOW_MS;
  const [row] = await db
    .select({ n: count() })
    .from(authTokens)
    .where(and(eq(authTokens.emailNormalized, emailNormalized), gt(authTokens.createdAt, since)));
  return (row?.n ?? 0) >= EMAIL_COOLDOWN_MAX_REQUESTS;
}

/** IP-keyed check against the AUTH_RATE_LIMITER binding. */
export async function isIpOverLimit(env: Env, ip: string): Promise<boolean> {
  const { success } = await env.AUTH_RATE_LIMITER.limit({ key: ip });
  return !success;
}

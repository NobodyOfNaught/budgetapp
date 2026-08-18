import type { MiddlewareHandler } from 'hono';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Defense-in-depth CSRF check for the same-origin API. The session cookie's
 * `SameSite=Lax` already blocks cross-site form posts and most fetch/XHR
 * cross-site requests from carrying it; this closes the remaining gap
 * (e.g. top-level GET navigations, which Lax still allows) by requiring
 * state-changing requests to carry a matching `Origin` header. Since this
 * Worker serves both the API and the SPA from one origin, "matching" just
 * means "equals this request's own scheme+host".
 */
export const sameOriginOnly: MiddlewareHandler = async (c, next) => {
  if (!SAFE_METHODS.has(c.req.method)) {
    const origin = c.req.header('Origin');
    const expected = new URL(c.req.url).origin;
    if (!origin || origin !== expected) {
      return c.json({ error: 'cross_origin_request_denied' }, 403);
    }
  }
  await next();
};

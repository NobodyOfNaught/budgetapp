import { Hono } from 'hono';
import { sameOriginOnly } from './lib/csrf';
import { ConsoleEmailSender, type EmailSender } from './lib/email';
import { createAuthRoutes } from './routes/auth';
import { budgetsRoute } from './routes/budgets';
import { health } from './routes/health';
import type { AppEnv } from './types/hono';

/**
 * Builds the app with its dependencies (currently just the email sender)
 * injected rather than hardcoded, so tests can swap in a capturing
 * implementation and observe a magic-link token — which is otherwise never
 * persisted anywhere in the clear, only hashed. See src/routes/auth.ts.
 */
export function createApp(emailSender: EmailSender = new ConsoleEmailSender()): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('/api/*', sameOriginOnly);

  app.route('/api/v1/health', health);
  app.route('/api/v1/auth', createAuthRoutes(emailSender));
  app.route('/api/v1/budgets', budgetsRoute);

  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  return app;
}

const app = createApp();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return app.fetch(request, env, ctx);
    }
    // Everything else falls through to Workers Static Assets, which serves
    // web/dist and, per not_found_handling: "single-page-application" in
    // wrangler.jsonc, returns index.html for any unmatched path so client
    // routing works.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

import { Hono } from 'hono';
import { health } from './routes/health';

const app = new Hono<{ Bindings: Env }>();

app.route('/api/v1/health', health);

app.notFound((c) => c.json({ error: 'not_found' }, 404));

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

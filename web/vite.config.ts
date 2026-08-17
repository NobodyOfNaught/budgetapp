import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `root` must be an absolute path here: Vite resolves a relative `root`
// against the CURRENT WORKING DIRECTORY, not against this config file's own
// location, and `npm run build` invokes this via `--config web/vite.config.ts`
// from the repo root — so a relative '.' would resolve to the repo root, not
// web/. index.html lives at web/index.html; the build output lands in
// web/dist, matching wrangler.jsonc's `assets.directory`.
const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    // `npm run dev:web` runs the Vite dev server for React HMR; API calls
    // are proxied to `wrangler dev` (npm run dev) running the Worker on
    // 8787. Run both in separate terminals during frontend work. For
    // exercising the real Worker end-to-end (including the health check
    // hitting D1), use `npm run dev` alone against the built web/dist.
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
});

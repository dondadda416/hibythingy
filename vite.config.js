// ── Vite build config ────────────────────────────────────────────────────────
// `npm run build` produces dist/hiby-hub.html — minified, single-file. Server
// (server.js) prefers dist/hiby-hub.html if present, falls back to the source
// hiby-hub.html otherwise. Result: zero-config in dev, smaller bundle in prod.

import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Treat the project root as the Vite root so `hiby-hub.html` is the entry.
  root: __dirname,
  // Don't try to crawl /node_modules for dev imports — we have none on the
  // frontend; everything is inlined.
  publicDir: false,
  // ── Dev server (`npm run dev`) ───────────────────────────────────────────
  // Vite serves hiby-hub.html with HMR on port 5173. The backend stays on
  // 3847; we proxy /api/* + /api/events (SSE) over so the frontend can keep
  // using same-origin fetches. Boot the backend separately with `npm start`
  // before running `npm run dev`.
  server: {
    port: 5173,
    open: '/hiby-hub.html',
    proxy: {
      '/api': {
        target: 'http://localhost:3847',
        changeOrigin: true,
        ws: false,
        // SSE (text/event-stream) and long-poll endpoints must NOT be buffered.
        configure(proxy) {
          proxy.on('proxyRes', (proxyRes, req) => {
            if (req.url && req.url.startsWith('/api/events')) {
              proxyRes.headers['cache-control'] = 'no-cache, no-transform';
            }
          });
        },
      },
    },
  },
  build: {
    outDir: path.join(__dirname, 'dist'),
    emptyOutDir: true,
    // esbuild is Vite's default minifier — bundled with Vite, no extra dep,
    // ~10x faster than terser. Output is slightly larger but the difference
    // is irrelevant for a single-file SPA.
    minify: 'esbuild',
    target: 'es2020',
    sourcemap: false,
    rollupOptions: {
      input: path.join(__dirname, 'hiby-hub.html'),
      // Single-file output — no chunks, no separate assets. The whole app is
      // inlined into one HTML so the existing serve-static-file flow keeps
      // working.
      output: {
        inlineDynamicImports: true,
      },
    },
  },
  plugins: [viteSingleFile({ removeViteModuleLoader: true })],
});

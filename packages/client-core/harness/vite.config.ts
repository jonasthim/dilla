import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The headless page of the core-worker suite, built into ../harness-dist and served by
// dilla-testhost -web-root on 8453, same-origin with the instance and under its CSP (L-HTTP-10).
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/',
  build: {
    outDir: fileURLToPath(new URL('../harness-dist', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
  worker: { format: 'es' },
});

import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// The Playwright media harness (e2e/playwright.media.config.ts starts it on 5179). 127.0.0.1 is a
// potentially trustworthy origin, so isSecureContext is true and the encoded-transform APIs exist.
export default defineConfig({
  root: resolve(here, 'harness'),
  server: { host: '127.0.0.1', port: 5179, strictPort: true },
  worker: { format: 'es' },
  build: { target: 'es2022' },
});

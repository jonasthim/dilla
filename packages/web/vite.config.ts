import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The developer loop only: a dev server on 5180 proxied to a dilla-testhost on 8443/8444
// (`go run ./cmd/dilla-testhost`). No gate runs it. The page must look same-origin to dillad,
// which has no CORS and checks the gateway Origin (F4), so the proxy rewrites Host and Origin.
const DEV_TARGET = 'http://127.0.0.1:8443';
const toHost = { target: DEV_TARGET, changeOrigin: true, headers: { origin: DEV_TARGET } };

export default defineConfig({
  base: '/',
  plugins: [react()],
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true, sourcemap: false, assetsInlineLimit: 0 },
  worker: { format: 'es' },
  server: {
    host: '127.0.0.1', port: 5180, strictPort: true,
    proxy: { '/v1': toHost, '/i/': toHost, '/gateway': { ...toHost, ws: true } },
  },
});

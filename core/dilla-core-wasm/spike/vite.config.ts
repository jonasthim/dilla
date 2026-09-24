import { defineConfig } from 'vite';

export default defineConfig({
  server: { host: '127.0.0.1', port: 5178, strictPort: true },
  preview: { host: '127.0.0.1', port: 5178, strictPort: true },
  // No `optimizeDeps.exclude` entry for ./pkg: that option takes bare module specifiers, and the
  // wasm-pack glue is imported by relative path, which Vite never pre-bundles anyway. An entry there
  // would be inert and would document a mechanism that does not apply.
  build: { target: 'es2022' },
});

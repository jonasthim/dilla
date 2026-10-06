import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Unit tests only: jsdom, no worker, no wasm. The real core runs in browsers (tasks 18 and 25).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.mjs'],
    css: false,
  },
});

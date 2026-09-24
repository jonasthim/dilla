import { defineConfig, devices } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

export default defineConfig({
  testDir: resolve(here, 'tests'),
  // The leadership test measures a real retry budget; parallelism and retries would corrupt it.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 120_000,
  reporter: [['list']],
  use: {
    // 127.0.0.1 is a potentially-trustworthy origin, so isSecureContext is true and OPFS is allowed.
    baseURL: 'http://127.0.0.1:5178',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chromium' } },
  ],
  webServer: {
    command: 'npm run dev -w @dilla/core-wasm-spike -- --port 5178 --strictPort --host 127.0.0.1',
    cwd: repoRoot,
    url: 'http://127.0.0.1:5178',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});

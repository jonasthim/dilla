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
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        // The same pref Mozilla's own dom/fs/test/mochitest-private.toml uses. Without it a
        // Playwright Firefox context is a fresh profile, privateBrowsingId 0, and reports "opfs" —
        // the test would pass for the wrong reason (gap-15 AC-1).
        launchOptions: { firefoxUserPrefs: { 'browser.privatebrowsing.autostart': true } },
      },
    },
    // A default WebKit context is already ephemeral; Playwright documents OPFS as unsupported
    // there, which is exactly the case under test (gap-15 AC-2).
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    // web-1 task 3: a normal (non-private) Firefox profile, opened by the spec itself through
    // launchPersistentContext at /tmp/dw/firefox-persistent-<worker>. It runs only the specs that need
    // a persistent OPFS store; persistence-matrix.spec.ts asserts private-browsing behaviour and must
    // not run here.
    {
      name: 'firefox-persistent',
      testMatch: /(mls-store|core-handle)\.spec\.ts$/,
      use: { ...devices['Desktop Firefox'] },
    },
  ],
  webServer: {
    command: 'npm run dev -w @dilla/core-wasm-spike -- --port 5178 --strictPort --host 127.0.0.1',
    cwd: repoRoot,
    url: 'http://127.0.0.1:5178',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});

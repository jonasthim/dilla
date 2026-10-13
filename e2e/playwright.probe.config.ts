import { defineConfig, devices } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIREFOX_MEDIA_PREFS } from './media/support/fixtures.ts';

const here = dirname(fileURLToPath(import.meta.url));

// PROBE-E2E (task 2, L-PROBE-1): the network probe's own check on loopback. globalSetup starts a dilla-testhost with an
// in-process LiveKit (8485/8486, 7892/7894) and the probe page (Vite, 5191), which also proxies the test host the way
// it proxies a real instance in the session. A local gate, not a CI leg.
export default defineConfig({
  globalSetup: resolve(here, 'probe', 'global-setup.ts'),
  testDir: resolve(here, 'probe'),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 240_000,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:5191', trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium-probe', use: { ...devices['Desktop Chrome'], channel: 'chromium' } },
    { name: 'firefox-probe', use: { ...devices['Desktop Firefox'], launchOptions: { firefoxUserPrefs: FIREFOX_MEDIA_PREFS } } },
  ],
});

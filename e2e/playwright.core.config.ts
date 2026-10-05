import { defineConfig, devices } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HostConfig } from './web/support/host.ts';

const here = dirname(fileURLToPath(import.meta.url));
// Task 17: no web root, so the test host serves the committed placeholder. Task 18 sets
// 'packages/client-core/harness-dist'.
const dillaHost: HostConfig = { port: 8453, control: 8454, webRoot: null };

// The client-core integration suite: the headless harness page against dilla-testhost on 8453/8454
// (production ACL) with a native web-driver peer. Every project runs on a persistent profile
// (e2e/web/support/persistent.ts), because the store lives in OPFS and IndexedDB.
export default defineConfig({
  testDir: resolve(here, 'web'),
  testMatch: /(^|\/)(support|core-worker)\.spec\.ts$/,
  globalSetup: resolve(here, 'web', 'support', 'host.ts'),
  metadata: { dillaHost },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 180_000,
  expect: { timeout: process.env.CI === 'true' ? 90_000 : 30_000 },
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:8453', trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium-core', use: { ...devices['Desktop Chrome'], channel: 'chromium' } },
    { name: 'firefox-core', use: { ...devices['Desktop Firefox'] } },
  ],
});

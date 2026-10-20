import { defineConfig, devices } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HostConfig } from './web/support/host.ts';

const here = dirname(fileURLToPath(import.meta.url));
// The web app suite (task 25): packages/web/dist served by dilla-testhost on 8463/8464.
const dillaHost: HostConfig = { port: 8463, control: 8464, webRoot: 'packages/web/dist' };

export default defineConfig({
  testDir: resolve(here, 'web'),
  // A project's own testIgnore replaces this one, so a project that ignores more repeats these names.
  testIgnore: /(^|\/)(support|core-worker|spike-joinall)\.spec\.ts$/,
  globalSetup: resolve(here, 'web', 'support', 'host.ts'),
  metadata: { dillaHost },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 180_000,
  expect: { timeout: process.env.CI === 'true' ? 90_000 : 30_000 },
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:8463', trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium-web', use: { ...devices['Desktop Chrome'], channel: 'chromium' } },
    // channel-list.spec starts an SFU and grants the `microphone` permission to a fake-microphone context; both are
    // Chromium-only (Firefox rejects "Unknown permission: microphone"), so Firefox does not load it.
    { name: 'firefox-web', testIgnore: /(^|\/)(support|core-worker|spike-joinall|channel-list)\.spec\.ts$/, use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit-web', testMatch: /(^|\/)(signup|reload|phone|signin-order|private-window)\.spec\.ts$/, use: { ...devices['Desktop Safari'] } },
  ],
});

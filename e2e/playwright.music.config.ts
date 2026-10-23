import { defineConfig, devices } from '@playwright/test';
import { chromiumMediaArgs, writeFixtures } from './media/support/fixtures.ts';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import type { HostConfig } from './web/support/host.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = writeFixtures(join(tmpdir(), 'dilla-music-fixtures'));
const dillaHost: HostConfig = {
  port: 8521, control: 8522, webRoot: 'packages/web/dist', botRuntime: true, advanceClockWithWall: true,
  sfu: { port: 8524, udpPort: 8526, departureTimeout: 90 },
};

export default defineConfig({
  testDir: resolve(here, 'music'),
  globalSetup: resolve(here, 'web', 'support', 'host.ts'),
  metadata: { dillaHost },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 360_000,
  expect: { timeout: process.env.CI === 'true' ? 90_000 : 30_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8521', trace: 'retain-on-failure', actionTimeout: process.env.CI === 'true' ? 90_000 : 30_000,
  },
  projects: [{
    name: 'chromium-music',
    use: {
      ...devices['Desktop Chrome'], channel: 'chromium',
      permissions: ['camera', 'microphone', 'notifications'],
      launchOptions: { args: chromiumMediaArgs(fixtures) },
    },
  }],
});

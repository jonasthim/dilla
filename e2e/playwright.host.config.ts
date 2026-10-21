import { defineConfig } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// UP5: the test host's own harness (web/support/host.ts): argument shapes, the sidecar SFU and API restarting on their own, the
// web-root swap. No browser and no global host: each spec starts and stops the processes it needs.
export default defineConfig({
  testDir: resolve(here, 'host'),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 180_000,
  reporter: [['list']],
  projects: [{ name: 'host' }],
});

import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIREFOX_MEDIA_PREFS, chromiumMediaArgs, writeFixtures } from './media/support/fixtures.ts';
import type { HostConfig } from './web/support/host.ts';

const here = dirname(fileURLToPath(import.meta.url));
// VOICE-E2E (web-3 task 10, L-E2E-31): packages/web/dist served by dilla-testhost on 8481/8482, with its in-process
// LiveKit on 7884 (signalling, reached through the host's /rtc proxy) and 7886 (ICE/UDP). Two browsers of one engine
// talk, ring and play through it, beside a native peer that can poison a call group.
const dillaHost: HostConfig = { port: 8481, control: 8482, webRoot: 'packages/web/dist', sfu: { port: 7884, udpPort: 7886 } };
// Written at config load, before any browser launches: the Chromium switches name the files (a 1 kHz tone, so the
// microphone is never silent and voice activity always sends).
const fixtures = writeFixtures(join(tmpdir(), 'dilla-media-fixtures'));

export default defineConfig({
  testDir: resolve(here, 'voice'),
  globalSetup: resolve(here, 'web', 'support', 'host.ts'),
  metadata: { dillaHost },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 240_000,
  expect: { timeout: process.env.CI === 'true' ? 90_000 : 30_000 },
  reporter: [['list']],
  // An action waits as long as one state may (WAIT), so a missing control fails the test with time left for `finally`.
  use: { baseURL: 'http://127.0.0.1:8481', trace: 'retain-on-failure', actionTimeout: process.env.CI === 'true' ? 90_000 : 30_000 },
  projects: [
    {
      name: 'chromium-voice',
      use: {
        ...devices['Desktop Chrome'], channel: 'chromium',
        // Clipboard write: Privacy's `copy` (the safety-number comparison of blocked.spec's RV-3 case).
        permissions: ['camera', 'microphone', 'notifications', 'clipboard-read', 'clipboard-write'],
        launchOptions: { args: chromiumMediaArgs(fixtures) },
      },
    },
    {
      name: 'firefox-voice',
      // Firefox takes prefs, never `permissions` ("Unknown permission: camera"); 1 grants desktop notifications.
      use: {
        ...devices['Desktop Firefox'],
        launchOptions: { firefoxUserPrefs: { ...FIREFOX_MEDIA_PREFS, 'permissions.default.desktop-notification': 1 } },
      },
    },
  ],
});

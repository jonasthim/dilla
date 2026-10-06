import { defineConfig } from '@playwright/test';
import web from './playwright.web.config';

// `npm run demo:web -w @dilla/e2e` (task 25; plan head ruling 41): the web config's global setup and host
// (the built client on 127.0.0.1:8463/8464, so the demo and the web suite never run together) and one
// native peer, for a person to walk the slice by hand. No project and no fixture asks for a browser.
// The web config never runs demo.ts: its testIgnore leaves Playwright's default testMatch, which matches
// *.spec.* and *.test.* files only; the core config's testMatch names its two specs.
export default defineConfig({
  testDir: web.testDir,
  testMatch: /(^|\/)demo\.ts$/,
  globalSetup: web.globalSetup,
  metadata: web.metadata,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 0,
  reporter: [['list']],
});

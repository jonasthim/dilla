// The second browser of the enrolment e2e (task 21 of web-2a): a persistent context of its own, at
// /tmp/dw/<project>-<worker>-b, watched by the same CSP/console guard as the first, and always closed.
// The profile directory and the launch are task 14's (second-harness.ts, plan head ruling 25).
import { rmSync } from 'node:fs';
import type { BrowserContext, Page } from '@playwright/test';
import { test as appTest } from './app';
import { launchSecond, secondProfileDir } from './second-harness';

export interface SecondBrowser { context: BrowserContext; page: Page; dir: string; }

export const test = appTest.extend<{ second: { open(): Promise<SecondBrowser> } }>({
  second: async ({ playwright, browserName, launchOptions, headless, channel, viewport, baseURL, guard }, use, testInfo) => {
    const dir = secondProfileDir(testInfo.project.name, testInfo.workerIndex);
    rmSync(dir, { recursive: true, force: true });
    // A holder, not a `let`: the closure assigns it, and a narrowed `let` would read as always null below.
    const held: { browser: SecondBrowser | null } = { browser: null };
    try {
      await use({
        open: async () => {
          if (held.browser !== null) throw new Error('the second browser is already open: one per test');
          const context = await launchSecond(playwright, browserName, { launchOptions, headless, channel, viewport, baseURL }, dir);
          held.browser = { context, page: context.pages()[0] ?? (await context.newPage()), dir };
          await guard.attach(context);
          return held.browser;
        },
      });
    } finally {
      if (held.browser !== null) {
        await guard.collectWorkers();
        await held.browser.context.close();
      }
      rmSync(dir, { recursive: true, force: true });
    }
  },
});
export { expect } from '@playwright/test';

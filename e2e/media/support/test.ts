// The `test` every media spec imports. The specs open their pages with browser.newContext() or
// browser.newPage() on the worker-scoped browser, and Playwright closes only the contexts its own
// `context` and `page` fixtures made: a context a test opens itself lives on, still joined to its
// LiveKit room and still encoding, decoding and transforming, until the worker's browser closes.
// In one chromium-media worker the calls of every earlier spec kept running (18 contexts by
// real-sfu-guards, the three-context call among them) and a 4-vCPU runner ran every later spec
// 4-15 times slower; only a failure, which restarts the worker, cleared them. This auto fixture
// closes every context of the worker's browser when a test ends, whatever its outcome.
import { test as base } from '@playwright/test';

export { expect } from '@playwright/test';

export const test = base.extend<{ closeContexts: void }>({
  closeContexts: [async ({ browser }, use) => {
    await use();
    await Promise.all(browser.contexts().map((c) => c.close()));
  }, { auto: true }],
});

import { expect, test as base, type Page } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';

const WAIT = process.env.CI === 'true' ? 90_000 : 30_000;
type Reply = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

const test = base.extend<{ storePage: Page }>({
  storePage: async ({ playwright, browserName, channel, headless, baseURL, page }, use, info) => {
    if (info.project.name !== 'firefox-persistent') {
      await use(page);
      return;
    }
    const dir = `/tmp/dw/${info.project.name}-${info.workerIndex}`;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync('/tmp/dw', { recursive: true });
    const context = await playwright[browserName].launchPersistentContext(dir, { baseURL, channel, headless });
    try {
      await use(context.pages()[0] ?? (await context.newPage()));
    } finally {
      await context.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
});

async function openSpike(page: Page, instance: string): Promise<void> {
  await page.goto(`/?core=1&instance=${instance}`);
  await page.waitForFunction(() => typeof (globalThis as any).__dilla?.core === 'function', null, { timeout: WAIT });
}

async function command(page: Page, op: string): Promise<Record<string, unknown>> {
  const result = await page.evaluate((name) => (globalThis as any).__dilla.core(name) as Promise<Reply>, op);
  expect(result, `${op}: ${JSON.stringify(result)}`).toMatchObject({ ok: true });
  return (result as { ok: true; value: Record<string, unknown> }).value;
}

test('an encrypted v3 OPFS store reopens at v4 and searches with FTS5 absent', async ({ storePage: page }, info) => {
  test.skip(process.env.DILLA_CORE_TEST_HOOKS !== '1', 'test-only wasm build required');
  test.skip(!['chromium', 'firefox-persistent'].includes(info.project.name), 'persistent OPFS required');
  test.setTimeout(process.env.CI === 'true' ? 300_000 : 120_000);
  await openSpike(page, `v3-no-fts-${Date.now().toString(36)}`);
  expect((await command(page, 'open')).abi).toBe(7);
  await command(page, 'signup');
  await command(page, 'group');
  expect(await command(page, 'seed-v3')).toMatchObject({ schema: 3, closed: true });
  expect(await command(page, 'open')).toMatchObject({ abi: 7, phase: 2 });
  const result = await command(page, 'search-fallback');
  expect(result).toMatchObject({ schema: 4, searchFts5: 0, hits: 1 });
  expect(String(result.snippet)).toContain('hello from the facade');
  await page.reload();
  await page.waitForFunction(() => typeof (globalThis as any).__dilla?.core === 'function', null, { timeout: WAIT });
  await command(page, 'open');
  expect(await command(page, 'search-fallback')).toMatchObject({ schema: 4, searchFts5: 0, hits: 1 });
});

test('a normal encrypted OPFS store indexes and searches text', async ({ storePage: page }, info) => {
  test.skip(process.env.DILLA_CORE_TEST_HOOKS !== '1', 'capability probe requires test-only wasm');
  test.skip(!['chromium', 'firefox-persistent'].includes(info.project.name), 'persistent OPFS required');
  test.setTimeout(process.env.CI === 'true' ? 300_000 : 120_000);
  await openSpike(page, `v4-search-${Date.now().toString(36)}`);
  await command(page, 'open');
  await command(page, 'signup');
  await command(page, 'group');
  const result = await command(page, 'search-fallback');
  expect(result).toMatchObject({ schema: 4, hits: 1 });
  expect([0, 1]).toContain(result.searchFts5);
  expect(String(result.snippet)).toContain('hello from the facade');
  console.log(`${info.project.name} normal OPFS search_fts5=${result.searchFts5}`);
});

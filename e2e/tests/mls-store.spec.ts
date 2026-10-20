import { expect, test as base, type Page } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';

// web-1 task 3 (B1.1, G1 U1). MLS state written through the store's one shared connection must
// survive the exported pause()/resume() and a reload in a fresh worker, and a connection clone held
// across pause() must make it refuse with E_STORE_BUSY instead of pausing under an open handle.

const RUNS_ON = ['chromium', 'firefox-persistent'];
const WAIT = process.env.CI === 'true' ? 90_000 : 30_000;

type MlsOp = 'create' | 'load' | 'hold' | 'release' | 'pause' | 'resume' | 'torn' | 'check';
type MlsReply = { ok: true; value: string } | { ok: false; error: string };
interface GroupState {
  epoch: number;
  authenticator: string;
}

// Both projects run on a persistent context whose profile directory the fixture owns, so a reload
// meets the same OPFS store and nothing leaks between runs.
const test = base.extend<{ storePage: Page }>({
  storePage: async ({ playwright, browserName, channel, headless, baseURL }, use, testInfo) => {
    const dir = `/tmp/dw/${testInfo.project.name}-${testInfo.workerIndex}`;
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

test.beforeEach(({}, testInfo) => {
  test.skip(!RUNS_ON.includes(testInfo.project.name), 'needs a persistent OPFS store (chromium, firefox-persistent)');
  test.setTimeout(process.env.CI === 'true' ? 300_000 : 120_000);
});

function instance(name: string): string {
  return `mls-${name}-${Date.now().toString(36)}`;
}

async function bootStore(page: Page, id: string): Promise<void> {
  await page.goto(`/?instance=${id}`);
  await expect(page.getByTestId('mode')).toHaveText('opfs', { timeout: WAIT });
  await expect(page.getByTestId('role')).toHaveText('leader', { timeout: WAIT });
  // `append` is enabled only once the worker reports the store open (ruling J).
  await expect(page.getByTestId('append')).toBeEnabled({ timeout: WAIT });
}

async function mls(page: Page, op: MlsOp): Promise<MlsReply> {
  return page.evaluate(
    (o) => (globalThis as unknown as { __dilla: { mls(op: string): Promise<MlsReply> } }).__dilla.mls(o),
    op,
  );
}

function groupState(reply: MlsReply): GroupState {
  expect(reply, JSON.stringify(reply)).toMatchObject({ ok: true });
  const state = JSON.parse((reply as { value: string }).value) as GroupState;
  expect(state.authenticator).toMatch(/^[0-9a-f]{64}$/);
  return state;
}

test('MLS state written through the shared handle survives the exported pause and resume', async ({ storePage: page }) => {
  await bootStore(page, instance('pause'));

  const created = groupState(await mls(page, 'create'));
  expect(created.epoch).toBe(1);
  expect(groupState(await mls(page, 'load'))).toEqual(created);

  expect(await mls(page, 'pause')).toEqual({ ok: true, value: 'paused' });
  // While paused there is no connection to share.
  expect(await mls(page, 'load')).toEqual({ ok: false, error: 'E_STORE_PROBE: E_STORE_PAUSED: the store is paused' });

  expect(await mls(page, 'resume')).toEqual({ ok: true, value: 'resumed' });
  const after = await mls(page, 'load');
  expect(after, 'the group must load from the reopened, re-keyed connection').toMatchObject({ ok: true });
  expect(groupState(after)).toEqual(created);

  // The exported exec path works on the reopened connection too: the boot marker is row 1.
  await page.getByTestId('append').click();
  await expect(page.getByTestId('rows')).toHaveText('2', { timeout: WAIT });
});

test('a held connection clone makes pause refuse with E_STORE_BUSY and leaves the store usable', async ({ storePage: page }) => {
  await bootStore(page, instance('busy'));
  const created = groupState(await mls(page, 'create'));

  expect(await mls(page, 'hold')).toEqual({ ok: true, value: '{"held":1}' });
  expect(await mls(page, 'hold')).toEqual({ ok: false, error: 'E_STORE_PROBE: a handle is already held' });
  expect(await mls(page, 'pause')).toEqual({ ok: false, error: 'E_STORE_BUSY: 1 handles are still open' });
  // The refused pause changed nothing: the store still answers.
  expect(groupState(await mls(page, 'load'))).toEqual(created);

  expect(await mls(page, 'release')).toEqual({ ok: true, value: '{"held":0}' });
  expect(await mls(page, 'pause')).toEqual({ ok: true, value: 'paused' });
  expect(await mls(page, 'resume')).toEqual({ ok: true, value: 'resumed' });
  expect(groupState(await mls(page, 'load'))).toEqual(created);
});

test('MLS state survives a reload into a fresh worker', async ({ storePage: page }) => {
  const id = instance('reload');
  await bootStore(page, id);
  const created = groupState(await mls(page, 'create'));
  expect(created.epoch).toBe(1);

  await page.reload();
  await expect(page.getByTestId('append')).toBeEnabled({ timeout: WAIT });
  // A reload starts a new document and a new dedicated worker; the store must be read from OPFS.
  const order = await page.evaluate(() => (globalThis as unknown as { __dilla: { order: string[] } }).__dilla.order);
  expect(order.slice(0, 2)).toEqual(['probe', 'install']);
  expect(groupState(await mls(page, 'load'))).toEqual(created);
});

test('an unknown op is refused by the worker without touching the store', async ({ storePage: page }) => {
  await bootStore(page, instance('unknown'));
  const reply = await page.evaluate(
    () => (globalThis as unknown as { __dilla: { mls(op: string): Promise<MlsReply> } }).__dilla.mls('drop-tables'),
  );
  expect(reply).toEqual({ ok: false, error: 'E_SPIKE_OP: unknown op drop-tables' });
  await expect(page.getByTestId('rows')).toHaveText('1', { timeout: WAIT });
});

// opfs-report. A page unload in the middle of a write leaves the rollback journal next to a database
// file in which some committed pages are already overwritten. The next open must play that journal
// back: the store opens, passes the integrity check, and holds the committed rows unchanged. Before
// the fix the pool VFS answered every RESERVED-lock check with "held by another connection", so
// SQLite never treated the journal as hot and read the half-written pages ("database disk image is
// malformed").
test('a write interrupted by a reload rolls back on the next open', async ({ storePage: page }) => {
  await bootStore(page, instance('torn'));
  const torn = await mls(page, 'torn');
  expect(torn, JSON.stringify(torn)).toMatchObject({ ok: true });
  // Inside the open transaction every row is already rewritten.
  expect(JSON.parse((torn as { value: string }).value)).toEqual({ rows: 300, committed: 0, problems: 0 });

  // The worker dies with the transaction open; the journal and the spilled pages stay in OPFS.
  await page.reload();
  // 'open' once the store is back; otherwise the banner's error (the failure message keeps the last one).
  await expect.poll(async () => (await page.getByTestId('append').isEnabled())
    ? 'open' : (await page.getByTestId('banner').textContent()) || 'waiting', { timeout: WAIT }).toBe('open');
  const check = await mls(page, 'check');
  expect(check, JSON.stringify(check)).toMatchObject({ ok: true });
  expect(JSON.parse((check as { value: string }).value)).toEqual({ rows: 300, committed: 300, problems: 0 });
});

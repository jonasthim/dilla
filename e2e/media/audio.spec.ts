import { randomBytes } from 'node:crypto';
import type { Browser, Page } from '@playwright/test';
import { expect, test } from './support/test';
import { debugToken } from './support/lk';
import type { DillaHarness, EpochWire } from '../../packages/media/harness/main';

const CONTROL = 'http://127.0.0.1:8444';
const HARNESS = 'http://127.0.0.1:5179/';
const BASE_KEY = '0a'.repeat(16); // the facts' fixed test base key; this spec runs no MLS

type W = { harness: DillaHarness };
type JoinArg = Parameters<DillaHarness['dillaJoin']>[0];

test.skip(({ browserName }) => browserName !== 'chromium', 'the audio surface is asserted on Chromium (task 19)');

const hex16 = () => randomBytes(16).toString('hex');
/** KID = (leaf << 8) | (epoch & 0xff), unpadded lowercase hex: the key of `DillaMediaStats.decrypted`. */
const kid = (leaf: number, epoch: bigint) => ((BigInt(leaf) << 8n) | (epoch & 0xffn)).toString(16);

async function open(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(HARNESS);
  return page;
}

const join = (page: Page, o: JoinArg) => page.evaluate((arg) => (globalThis as unknown as W).harness.dillaJoin(arg), o);
const stats = (page: Page) => page.evaluate(() => (globalThis as unknown as W).harness.dillaStats());
const probe = (page: Page) => page.evaluate(() => (globalThis as unknown as W).harness.rnnoiseProbe());

async function decrypted(page: Page, k: string): Promise<number> {
  return (await stats(page)).decrypted[k] ?? 0;
}

async function rising(page: Page, k: string, windowMs: number): Promise<void> {
  const before = await decrypted(page, k);
  await page.waitForTimeout(windowMs);
  expect(await decrypted(page, k), `decrypted[${k}] must rise over ${windowMs} ms`).toBeGreaterThan(before);
}

test('setProcessor and a mic restart keep the receiver decrypting (SP-10)', async ({ browser }) => {
  const room = `audio-${Date.now()}`;
  const [a, b] = [hex16(), hex16()];
  const groupId = hex16();
  const epoch = (selfLeaf: number): EpochWire => ({
    groupId,
    epoch: '1',
    baseKey: BASE_KEY,
    selfLeaf,
    minEpoch: '1',
    roster: [{ leaf: 0, deviceId: a }, { leaf: 1, deviceId: b }],
  });
  const ta = await debugToken(CONTROL, room, a, true);
  const tb = await debugToken(CONTROL, room, b, false);
  const [pa, pb] = [await open(browser), await open(browser)];
  await join(pa, { livekitUrl: ta.url, token: ta.token, iceServers: [], epoch: epoch(0) });
  await join(pb, { livekitUrl: tb.url, token: tb.token, iceServers: [], epoch: epoch(1) });
  await pa.evaluate(() => (globalThis as unknown as W).harness.dillaPublishMic());

  const aKid = kid(0, 1n);
  await expect.poll(() => decrypted(pb, aKid), { timeout: 15_000 }).toBeGreaterThan(0);

  const first = await pa.evaluate(() => (globalThis as unknown as W).harness.dillaSetProcessor());
  expect(first.senderIsProcessed).toBe(true);
  await rising(pb, aKid, 2_000);

  const second = await pa.evaluate(() => (globalThis as unknown as W).harness.dillaRestartMic());
  expect(second.processedTrackId).toBe(first.processedTrackId);
  expect(second.senderIsProcessed).toBe(true);
  await rising(pb, aKid, 2_000);

  const s = await stats(pb);
  expect((await stats(pa)).encrypted[aKid]?.[0]).toBeGreaterThan(0);
  expect(s.decrypted[aKid]).toBeGreaterThan(0);
  expect(s.dropped.aeadFail).toBe(0);
});

test('the worklet compiles without atob and reports constructor timing (SP-35)', async ({ browser }) => {
  const p = await probe(await open(browser));
  expect(p.atob).toBe('undefined');
  expect(p.compiled).toBe(true);
  expect(p.error).toBeNull();
  expect(Number.isFinite(p.ctorMs)).toBe(true);
  console.log('SP35_CONSTRUCTOR', JSON.stringify({ engine: 'chromium', ctorMs: p.ctorMs,
    renderThreadLoadQuanta: 'unmeasured' }));
});

for (const [policy, compiles] of [
  ["script-src 'self'", false],
  ["script-src 'self' 'wasm-unsafe-eval'", true],
] as const) {
  test(`the worklet's wasm compile under "${policy}" ${compiles ? 'succeeds' : 'fails'} (SP-35)`, async ({ browser }) => {
    const page = await (await browser.newContext()).newPage();
    await page.route(HARNESS, async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': policy } });
    });
    await page.goto(HARNESS);
    const p = await probe(page);
    expect(p.compiled).toBe(compiles);
    if (!compiles) expect(p.error).toContain('CompileError');
  });
}

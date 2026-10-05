// SP-05 (task 2): does a VP8 frame with 1 clear byte (delta) / 10 clear bytes (key), an SFrame-
// shaped header, a randomised body and a 16-byte tag stand-in survive LiveKit v1.13.7 between
// Chromium 153 and Firefox 155 in both directions, and does 0 clear bytes fail? Spike code: it runs
// under the spike-chromium project only and never in CI (plan MD-17).
import { devices, expect, firefox, test, type Browser, type Page } from '@playwright/test';
import { FIREFOX_MEDIA_PREFS } from '../media/support/fixtures.ts';
import { CONTROL } from '../media/support/testhost.ts';
import { debugToken, deviceIdentity, sfuInfo, type HarnessWindow, type StubMode } from '../media/support/lk.ts';

test.skip(({ browserName }) => browserName !== 'chromium', 'one run drives both engines from spike-chromium');

const ONE_TEN: StubMode = { kind: 'xor', keyPrefix: 10, deltaPrefix: 1, sframeLayout: true };
const ZERO: StubMode = { kind: 'xor', keyPrefix: 0, deltaPrefix: 0, sframeLayout: true };
const WINDOW_MS = 10_000;

let ff: Browser | undefined;
test.afterAll(async () => { await ff?.close(); });

async function firefoxPage(): Promise<Page> {
  ff ??= await firefox.launch({ channel: undefined, args: [], firefoxUserPrefs: FIREFOX_MEDIA_PREFS });
  return (await ff.newContext({ ...devices['Desktop Firefox'], permissions: [] })).newPage();
}

async function join(page: Page, url: string, room: string, stub: StubMode, camera: boolean): Promise<void> {
  const { token } = await debugToken(CONTROL, room, deviceIdentity());
  await page.goto('/');
  await page.waitForFunction(() => 'harness' in window);
  await page.evaluate(async ([u, t, s, cam]) => {
    const h = (window as unknown as HarnessWindow).harness;
    await h.connect(u, t, { e2ee: 'stub', stub: s });
    if (cam) await h.publish({ camera: true, videoCodec: 'vp8' });
  }, [url, token, stub, camera] as const);
}

const stub = (p: Page) => p.evaluate(() => (window as unknown as HarnessWindow).harness.stubStats());

/** One direction: `from` publishes VP8, `to` subscribes, both run `mode`; returns what `to` saw. */
async function run(browser: Browser, publisher: 'chromium' | 'firefox', mode: StubMode) {
  const { url } = await sfuInfo(CONTROL);
  const room = `sp05-${publisher}-${mode.kind === 'xor' ? mode.deltaPrefix : 'x'}-${Date.now()}`;
  const chromiumPage = await (await browser.newContext({ permissions: ['camera', 'microphone'] })).newPage();
  const ffPage = await firefoxPage();
  const [pub, sub] = publisher === 'chromium' ? [chromiumPage, ffPage] : [ffPage, chromiumPage];
  await join(sub, url, room, mode, false);
  await join(pub, url, room, mode, true);
  await sub.waitForTimeout(WINDOW_MS);
  const result = {
    publisher, mode,
    subscriberRemote: publisher === 'firefox' ? await sub.evaluate(() => (window as unknown as HarnessWindow).harness.remoteStats()) : [],
    subscriberRender: publisher === 'chromium' ? await sub.evaluate(() => (window as unknown as HarnessWindow).harness.renderProbe(2_000)) : [],
    publisherStub: await stub(pub),
    subscriberStub: await stub(sub),
  };
  console.log(`SP-05 RESULT ${JSON.stringify(result)}`);
  await test.info().attach(`sp05-${publisher}-${JSON.stringify(mode)}`, { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  await chromiumPage.context().close();
  await ffPage.context().close();
  return result;
}

test('1 clear byte on delta and 10 on key decode Chromium → Firefox', async ({ browser }) => {
  const r = await run(browser, 'chromium', ONE_TEN);
  expect(r.publisherStub.encKey).toBeGreaterThan(0);
  expect(r.subscriberStub.decKey).toBeGreaterThan(0);
  expect(r.subscriberStub.decDelta).toBeGreaterThan(100);
  expect(r.subscriberStub.short).toBe(0);
  expect(r.subscriberRender.find((p) => p.kind === 'video')?.frames ?? 0).toBeGreaterThan(20);
});

test('1 clear byte on delta and 10 on key decode Firefox → Chromium', async ({ browser }) => {
  const r = await run(browser, 'firefox', ONE_TEN);
  const video = r.subscriberRemote.find((s) => s.kind === 'video');
  expect(video?.framesDecoded ?? 0).toBeGreaterThan(100);
  expect(video?.keyFramesDecoded ?? 0).toBeGreaterThan(0);
  // No key-frame-request storm: a healthy 10 s window asks for at most a handful.
  expect(video?.pliCount ?? 0).toBeLessThanOrEqual(5);
  expect(r.subscriberStub.short).toBe(0);
});

test('0 clear bytes is the negative control: nothing decodes in either direction', async ({ browser }) => {
  const toFirefox = await run(browser, 'chromium', ZERO);
  expect(toFirefox.subscriberRender.find((p) => p.kind === 'video')?.frames ?? 0).toBe(0);
  const toChromium = await run(browser, 'firefox', ZERO);
  expect(toChromium.subscriberRemote.find((s) => s.kind === 'video')?.framesDecoded ?? 0).toBe(0);
});

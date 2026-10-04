// SP-27: two Chromium contexts and one Firefox context publish mic and camera to the test SFU.
import { randomBytes } from 'node:crypto';
import { devices, expect, firefox, test, type Browser, type Page } from '@playwright/test';
import { CONTROL, HARNESS } from '../media/support/testhost.ts';
import { FIREFOX_MEDIA_PREFS } from '../media/support/fixtures.ts';
import { debugToken, sfuInfo, type HarnessWindow } from '../media/support/lk.ts';
import type { DillaHarness } from '../../packages/media/harness/main.ts';

type PairWindow = HarnessWindow & { harness: HarnessWindow['harness'] & DillaHarness };
const decoding = (stats: Awaited<ReturnType<HarnessWindow['harness']['remoteStats']>>) =>
  stats.filter((s) => s.kind === 'video' ? s.framesDecoded > 0 : s.packetsReceived > 0).length;

test.skip(({ browserName }) => browserName !== 'chromium', 'one run drives both engines');

test('2 Chromium + 1 Firefox decode each other through the test SFU; pairs printed (SP-27)', async ({ browser }, info) => {
  test.setTimeout(120_000);
  const ff: Browser = await firefox.launch({ channel: undefined, args: [], firefoxUserPrefs: FIREFOX_MEDIA_PREFS });
  const pages: Page[] = [];
  try {
    pages.push(await (await browser.newContext({ permissions: ['camera', 'microphone'] })).newPage());
    pages.push(await (await browser.newContext({ permissions: ['camera', 'microphone'] })).newPage());
    pages.push(await (await ff.newContext({ ...devices['Desktop Firefox'], permissions: [] })).newPage());
    const names = ['chromium-0', 'chromium-1', 'firefox-0'];
    const room = `sp27-${Date.now()}`;
    const { url } = await sfuInfo(CONTROL);
    let connectError: string | undefined;
    for (const [i, page] of pages.entries()) {
      await page.goto(`${HARNESS}/`);
      await page.waitForFunction(() => 'harness' in window);
      const { token } = await debugToken(CONTROL, room, randomBytes(16).toString('hex'));
      try {
        await page.evaluate(([u, t]) => (window as unknown as PairWindow).harness.connect(u, t, { e2ee: 'none' }), [url, token] as const);
        await page.evaluate(() => (window as unknown as PairWindow).harness.publish({ mic: true, camera: true }));
      } catch (err) {
        connectError = `${names[i]}: ${String(err)}`;
        console.log(`SP-27 connect error: ${connectError}`);
        break;
      }
    }
    const report: Record<string, { pairs: string[]; decoding: number }> = {};
    for (const [i, page] of pages.entries()) {
      if (i === 2 && connectError) break;
      const deadline = Date.now() + 30_000;
      let count = 0;
      while (Date.now() < deadline) {
        count = decoding(await page.evaluate(() => (window as unknown as PairWindow).harness.remoteStats()));
        if (count === (connectError ? 2 : 4)) break;
        await page.waitForTimeout(250);
      }
      const pairs = await page.evaluate(() => (window as unknown as PairWindow).harness.selectedPairs());
      report[names[i]] = { pairs, decoding: count };
      console.log(`SP-27 ${names[i]}: ${count}/4 decoding; ${pairs.join(' | ')}`);
    }
    await info.attach('sp27-pairs.json', { body: JSON.stringify({ report, connectError }, null, 2), contentType: 'application/json' });
    if (connectError) throw new Error(connectError);
    for (const name of names) expect(report[name].decoding, `${name} decodes all four remote tracks`).toBe(4);
  } finally {
    await ff.close();
  }
});

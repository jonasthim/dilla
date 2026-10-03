// The harness smoke: two Chromium contexts and one Firefox context connect straight to the test
// host's LiveKit with debug tokens (plan MD-13), publish the fake microphone and camera through the
// stub manager's pass-through transforms, and each sees every remote track decode. Every later
// browser test and spike stands on this.
import { devices, expect, firefox, test, type Browser, type Page } from '@playwright/test';
import { FIREFOX_MEDIA_PREFS } from './support/fixtures.ts';
import { CONTROL } from './support/testhost.ts';
import { debugToken, deviceIdentity, sfuInfo, waitForDecode, type HarnessWindow } from './support/lk.ts';

test.skip(({ browserName }) => browserName !== 'chromium', 'one run drives both engines from the chromium-media project');

let ff: Browser | undefined;
test.afterAll(async () => { await ff?.close(); });

async function join(page: Page, url: string, room: string): Promise<void> {
  const { token } = await debugToken(CONTROL, room, deviceIdentity());
  await page.goto('/');
  await page.waitForFunction(() => 'harness' in window);
  await page.evaluate(async ([u, t]) => {
    const h = (window as unknown as HarnessWindow).harness;
    await h.connect(u, t, { e2ee: 'stub', stub: { kind: 'pass' } });
    await h.publish({ mic: true, camera: true });
  }, [url, token] as const);
}

test('two Chromium contexts and one Firefox context decode each other through the in-process SFU', async ({ browser }) => {
  const { url } = await sfuInfo(CONTROL);
  const room = `harness-${Date.now()}`;
  const chromiumPages = [
    await (await browser.newContext({ permissions: ['camera', 'microphone'] })).newPage(),
    await (await browser.newContext({ permissions: ['camera', 'microphone'] })).newPage(),
  ];
  // The chromium-media project's defaults (channel, Chrome user agent, camera permissions) reach
  // every launch and context in this worker, so the Firefox side overrides each of them: Firefox
  // refuses 'camera' ('Unknown permission'), and livekit-client picks its paths by user agent.
  ff = await firefox.launch({ channel: undefined, args: [], firefoxUserPrefs: FIREFOX_MEDIA_PREFS });
  const firefoxPage = await (await ff.newContext({ ...devices['Desktop Firefox'], permissions: [] })).newPage();
  for (const p of [...chromiumPages, firefoxPage]) await join(p, url, room);

  for (const p of chromiumPages) {
    const stats = await waitForDecode(p, 10, 30_000);
    expect(stats.filter((s) => s.kind === 'video')).toHaveLength(2);
    expect(stats.filter((s) => s.kind === 'audio')).toHaveLength(2);
    const stub = await p.evaluate(() => (window as unknown as HarnessWindow).harness.stubStats());
    expect(stub.transforms).toBeGreaterThanOrEqual(6); // 2 senders + 4 receivers
    expect(stub.errors).toBe(0);
  }

  const probes = await firefoxPage.evaluate(() => (window as unknown as HarnessWindow).harness.renderProbe(3_000));
  expect(probes.filter((p) => p.kind === 'video')).toHaveLength(2);
  expect(probes.filter((p) => p.kind === 'audio')).toHaveLength(2);
  for (const p of probes) {
    if (p.kind === 'video') expect(p.frames, `video from ${p.participantIdentity}`).toBeGreaterThan(0);
    else expect(p.rms, `audio from ${p.participantIdentity}`).toBeGreaterThan(0.01);
  }
});

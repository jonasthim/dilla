import { chromium, expect, test, type Page } from '@playwright/test';
import { DS_URL, MediaDriver, epochWire, testkitEnv, type CallToken, type MediaKey } from './support/driver';
import type { DillaHarness, DillaHarness21 } from '../../packages/media/harness/main';

type W = { harness: DillaHarness & DillaHarness21 };
const HARNESS = 'http://127.0.0.1:5179/';

test.skip(({ browserName }) => browserName !== 'firefox', 'the smoke runs on firefox-media and launches its Chromium peer itself');

async function enter(driver: MediaDriver, page: Page, actor: string, vdec: string): Promise<string> {
  const { deviceId } = await driver.request<{ deviceId: string }>('device', { actor });
  const key = await driver.request<MediaKey>('media_key', { actor });
  const token = await driver.request<CallToken>('call_token', { actor, vdec });
  await page.evaluate((o) => (globalThis as unknown as W).harness.dillaJoin(o), {
    livekitUrl: token.livekitUrl, token: token.token, iceServers: token.iceServers, epoch: epochWire(key, key.epoch), caps: token.caps,
  });
  await page.evaluate(() => (globalThis as unknown as W).harness.dillaPublishMic());
  await driver.request('share', { actor, callId: token.callId });
  await page.evaluate(() => (globalThis as unknown as W).harness.dillaWaitPermission('screen_share', 10_000));
  // No getDisplayMedia: Firefox headless never resolves it (DEV-63); a canvas track is the ScreenShare.
  await page.evaluate(() => (globalThis as unknown as W).harness.dillaPublish({ deviceCamera: true, canvasScreen: true }));
  return deviceId;
}

test('Firefox joins a Chromium call with voice, camera and a canvas screen share (DEV-63)', async ({ browser }) => {
  test.setTimeout(180_000);
  const cr = await chromium.launch({
    channel: 'chromium',
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const driver = await MediaDriver.start(DS_URL, testkitEnv());
  try {
    await driver.request('setup', { actors: ['alice', 'bob'] });
    await driver.request('open_call', { actor: 'alice' });
    await driver.request('join', { actor: 'bob' });
    await driver.request('sync', { actor: 'alice' });
    const crPage = await (await cr.newContext({ permissions: ['camera', 'microphone'] })).newPage();
    const ffPage = await (await browser.newContext()).newPage();
    await crPage.goto(HARNESS);
    await ffPage.goto(HARNESS);
    const aliceDev = await enter(driver, crPage, 'alice', 'vp8,h264');
    const bobDev = await enter(driver, ffPage, 'bob', 'vp8');
    // Assertions through rendered output only: Firefox resets inbound-rtp when a transform attaches.
    for (const [page, peer] of [[crPage, bobDev], [ffPage, aliceDev]] as const) {
      await expect
        .poll(async () => {
          const probes = (await page.evaluate(() => (globalThis as unknown as W).harness.dillaRenderProbe(2_000))).filter((p) => p.participantIdentity === peer);
          const video = probes.filter((p) => p.kind === 'video' && p.frames > 0).length;
          const audio = probes.filter((p) => p.kind === 'audio' && p.rms > 0.01).length;
          return `${video} video, ${audio} audio`;
        }, { timeout: 30_000 })
        .toBe('2 video, 1 audio');
    }
  } finally {
    await driver.close();
    await cr.close();
  }
});

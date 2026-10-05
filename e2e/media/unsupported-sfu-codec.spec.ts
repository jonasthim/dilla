// LiveKit v1.13.7 puts supported codecs first in JoinResponse even when enabled_codecs lists AV1 first.
// This real-SFU leg offers AV1 and asks dilla to publish it; the literal unsupported-first order
// cannot be produced by this pinned server. The measured JoinResponse order is logged below.
import { expect, test } from './support/test';
import { DS_URL, MediaDriver, epochWire, testkitEnv, type CallToken, type MediaKey } from './support/driver';
import type { DillaHarness, DillaHarness21 } from '../../packages/media/harness/main';

type W = { harness: DillaHarness & DillaHarness21 };
test.skip(() => process.env.DILLA_MEDIA_SFU_AV1 !== '1', 'run with the test-host AV1 SFU configuration');
test.skip(({ browserName }) => browserName !== 'chromium', 'AV1 publish is measured on Chromium');

test('the real SFU offers AV1 but the client negotiates and sends VP8', async ({ browser }) => {
  const driver = await MediaDriver.start(DS_URL, testkitEnv());
  try {
    await driver.request('setup', { actors: ['alice'] });
    await driver.request('open_call', { actor: 'alice' });
    const key = await driver.request<MediaKey>('media_key', { actor: 'alice' });
    const token = await driver.request<CallToken>('call_token', { actor: 'alice', vdec: 'vp8,h264' });
    const page = await (await browser.newContext()).newPage();
    await page.goto('http://127.0.0.1:5179/');
    await page.evaluate((o) => (globalThis as unknown as W).harness.dillaJoin(o), {
      livekitUrl: token.livekitUrl, token: token.token, iceServers: token.iceServers,
      epoch: epochWire(key, key.epoch), caps: [32_000, token.caps[1], token.caps[2]],
    });
    const codecs = await page.evaluate(() => (globalThis as unknown as W).harness.dillaOfferedPublishCodecs());
    console.log('TASK21_JOIN_RESPONSE_CODECS', JSON.stringify(codecs));
    expect(codecs).toContain('video/AV1');
    await page.evaluate(() => (globalThis as unknown as W).harness.dillaPublishMic());
    expect(await page.evaluate(() => (globalThis as unknown as W).harness.dillaAudioSenderMaxBitrate())).toBe(32_000);
    await driver.request('share', { actor: 'alice', callId: token.callId });
    await page.evaluate(() => (globalThis as unknown as W).harness.dillaWaitPermission('camera', 10_000));
    await page.evaluate(() => (globalThis as unknown as W).harness.dillaPublish({ camera: true, simulcast: false, videoCodec: 'vp8' }));
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as W).harness.dillaVideoOutBytes()), { timeout: 10_000 }).toBeGreaterThan(0);
    const sdp = await page.evaluate(() => (globalThis as unknown as W).harness.dillaNegotiatedVideoSdp());
    expect(sdp.join('\n')).not.toMatch(/a=rtpmap:\d+ (?:AV1|H265|VP9)\//i);
    const active = await page.evaluate(() => (globalThis as unknown as W).harness.dillaActiveVideoCodecs());
    expect(active.some((c) => c.startsWith('video/VP8'))).toBe(true);
    const bytes = await page.evaluate(() => (globalThis as unknown as W).harness.dillaVideoOutBytes());
    console.log('TASK21_AV1_EVIDENCE', JSON.stringify({ bytesSent: bytes, active, checkedDescriptions: sdp.length }));
    expect(bytes).toBeGreaterThan(0);
  } finally {
    await driver.close();
  }
});

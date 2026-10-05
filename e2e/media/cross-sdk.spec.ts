import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { DS_URL, MediaDriver, epochWire, kidHex, runMediabot, testkitEnv, type CallToken, type MediaKey } from './support/driver';
import type { DillaHarness, DillaHarness21 } from '../../packages/media/harness/main';

type W = { harness: DillaHarness & DillaHarness21 };
const HARNESS = 'http://127.0.0.1:5179/';
const media = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'internal', 'media', 'testdata');

test.skip(({ browserName }) => browserName !== 'chromium', 'the cross-SDK leg runs on chromium-media');

test('the Go peer and Chromium decrypt each other (SP-15 cross-SDK)', async ({ browser }) => {
  test.setTimeout(180_000);
  const driver = await MediaDriver.start(DS_URL, testkitEnv());
  try {
    await driver.request('setup', { actors: ['alice', 'erin'] });
    await driver.request('open_call', { actor: 'alice' });
    await driver.request('join', { actor: 'erin' });
    await driver.request('sync', { actor: 'alice' });
    const page = await (await browser.newContext()).newPage();
    await page.goto(HARNESS);
    const { deviceId: aliceDev } = await driver.request<{ deviceId: string }>('device', { actor: 'alice' });
    const { deviceId: erinDev } = await driver.request<{ deviceId: string }>('device', { actor: 'erin' });
    const aKey = await driver.request<MediaKey>('media_key', { actor: 'alice' });
    const aTok = await driver.request<CallToken>('call_token', { actor: 'alice', vdec: 'vp8,h264' });
    await page.evaluate((o) => (globalThis as unknown as W).harness.dillaJoin(o), {
      livekitUrl: aTok.livekitUrl, token: aTok.token, iceServers: aTok.iceServers, epoch: epochWire(aKey, aKey.epoch), caps: aTok.caps,
    });
    await page.evaluate(() => (globalThis as unknown as W).harness.dillaPublishMic());
    await driver.request('share', { actor: 'alice', callId: aTok.callId });
    await page.evaluate(() => (globalThis as unknown as W).harness.dillaWaitPermission('camera', 10_000));
    await page.evaluate(() => (globalThis as unknown as W).harness.dillaPublish({ camera: true, simulcast: false }));

    const eKey = await driver.request<MediaKey>('media_key', { actor: 'erin' });
    const eTok = await driver.request<CallToken>('call_token', { actor: 'erin', vdec: 'vp8,h264' });
    const bot = runMediabot([
      '-url', eTok.livekitUrl, '-token', eTok.token, '-base-key-file', '-', '-leaf', String(eKey.selfLeaf),
      '-epoch', eKey.epoch, '-roster', eKey.roster.map((r) => `${r.leaf}:${r.deviceId}`).join(','),
      '-publish', 'opus,vp8,h264', '-subscribe', '-expect-device', aliceDev, '-duration', '25s', '-media', media,
    ], 90_000, eKey.baseKey);
    // The bot is a participant once alice's room shows it; then it takes the lease for its video.
    await expect.poll(async () => (await page.evaluate(() => (globalThis as unknown as W).harness.dillaParticipantSeen()))[erinDev] !== undefined, { timeout: 20_000 }).toBe(true);
    await driver.request('share', { actor: 'erin', callId: eTok.callId });

    await expect.poll(async () => (await page.evaluate(() => (globalThis as unknown as W).harness.dillaStats())).decrypted[kidHex(eKey.selfLeaf, eKey.epoch)] ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
    let observed: unknown;
    await expect
      .poll(async () => {
        const s = (await page.evaluate(() => (globalThis as unknown as W).harness.dillaRemoteStats())).filter((x) => x.participantIdentity === erinDev);
        const dilla = await page.evaluate(() => (globalThis as unknown as W).harness.dillaStats());
        observed = { remote: s, dilla };
        return [
          s.some((x) => x.kind === 'audio' && x.totalSamplesReceived > 0 && (dilla.decryptedByTrack[x.trackId] ?? 0) > 0),
          s.some((x) => x.source === 'camera' && x.framesDecoded > 0 && (dilla.decryptedByTrack[x.trackId] ?? 0) > 0),
          s.some((x) => x.source === 'screen_share' && x.framesDecoded > 0),
        ];
      }, { timeout: 30_000 })
      .toEqual([true, true, true])
      .catch((err) => { console.log('CROSS_SDK_OBSERVED', JSON.stringify(observed)); throw err; });

    const report = await bot;
    expect(Object.keys(report.published).sort()).toEqual(['h264', 'opus', 'vp8']);
    expect(report.decrypted).toBeGreaterThan(0);
    expect(report.decrypted_by_kind.microphone).toBeGreaterThan(0);
    expect(report.decrypted_by_kind.camera).toBeGreaterThan(0);
    expect(Object.entries(report.dropped).filter(([code, n]) => code !== 'sif' && n > 0)).toEqual([]);
  } finally {
    await driver.close();
  }
});

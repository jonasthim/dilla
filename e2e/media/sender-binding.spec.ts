import { expect, test } from '@playwright/test';
import { DS_URL, MediaDriver, epochWire, testkitEnv, type CallToken, type MediaKey } from './support/driver';
import type { DillaHarness, DillaHarness21 } from '../../packages/media/harness/main';

type W = { harness: DillaHarness & DillaHarness21 };
const HARNESS = 'http://127.0.0.1:5179/';

test.skip(({ browserName }) => browserName !== 'chromium', 'sender binding uses Chromium inbound stats');

test('valid ciphertext under another member’s track identity is never rendered', async ({ browser }) => {
  test.setTimeout(90_000);
  const driver = await MediaDriver.start(DS_URL, testkitEnv());
  try {
    await driver.request('setup', { actors: ['alice', 'erin'] });
    await driver.request('open_call', { actor: 'alice' });
    await driver.request('join', { actor: 'erin' });
    await driver.request('sync', { actor: 'alice' });
    const key = await driver.request<MediaKey>('media_key', { actor: 'alice' });
    const aliceToken = await driver.request<CallToken>('call_token', { actor: 'alice', vdec: 'vp8' });
    const erinToken = await driver.request<CallToken>('call_token', { actor: 'erin', vdec: 'vp8' });
    const erinDevice = (await driver.request<{ deviceId: string }>('device', { actor: 'erin' })).deviceId;
    const [alice, forged] = await Promise.all([browser.newPage(), browser.newPage()]);
    await Promise.all([alice.goto(HARNESS), forged.goto(HARNESS)]);
    for (const [page, token] of [[alice, aliceToken], [forged, erinToken]] as const) {
      await page.evaluate((arg) => (globalThis as unknown as W).harness.dillaJoin(arg), {
        livekitUrl: token.livekitUrl, token: token.token, iceServers: token.iceServers,
        epoch: epochWire(key, key.epoch), caps: token.caps,
      });
    }
    // Erin's SFU identity is valid, but the forged sender has Alice's leaf and frame key.
    await forged.evaluate(() => (globalThis as unknown as W).harness.dillaPublishMic());
    await expect.poll(async () => (await alice.evaluate(() => (globalThis as unknown as W).harness.dillaStats())).dropped.senderMismatch,
      { timeout: 15_000 }).toBeGreaterThan(0);
    const tracks = (await alice.evaluate(() => (globalThis as unknown as W).harness.dillaRemoteStats()))
      .filter((track) => track.participantIdentity === erinDevice && track.kind === 'audio');
    expect(tracks.length).toBeGreaterThan(0);
    expect(tracks.every((track) => track.totalSamplesReceived === 0)).toBe(true);
  } finally {
    await driver.close();
  }
});

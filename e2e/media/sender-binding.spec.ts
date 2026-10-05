import { expect, test } from './support/test';
import { DS_URL, MediaDriver, epochWire, testkitEnv, type CallToken, type MediaKey } from './support/driver';
import type { DillaHarness, DillaHarness21 } from '../../packages/media/harness/main';

type W = { harness: DillaHarness & DillaHarness21 };
const HARNESS = 'http://127.0.0.1:5179/';

test.skip(({ browserName }) => browserName !== 'chromium', 'sender binding uses Chromium inbound stats');

test('valid ciphertext under another member’s track identity is never rendered', async ({ browser }) => {
  test.setTimeout(90_000);
  const driver = await MediaDriver.start(DS_URL, testkitEnv());
  try {
    await driver.request('setup', { actors: ['alice', 'bob', 'erin'] });
    await driver.request('open_call', { actor: 'alice' });
    await driver.request('join', { actor: 'bob' });
    await driver.request('join', { actor: 'erin' });
    await driver.request('sync', { actor: 'alice' });
    await driver.request('sync', { actor: 'bob' });
    const aliceKey = await driver.request<MediaKey>('media_key', { actor: 'alice' });
    const bobKey = await driver.request<MediaKey>('media_key', { actor: 'bob' });
    const aliceToken = await driver.request<CallToken>('call_token', { actor: 'alice', vdec: 'vp8' });
    const erinToken = await driver.request<CallToken>('call_token', { actor: 'erin', vdec: 'vp8' });
    const erinDevice = (await driver.request<{ deviceId: string }>('device', { actor: 'erin' })).deviceId;
    const [alice, forged] = await Promise.all([browser.newPage(), browser.newPage()]);
    await Promise.all([alice.goto(HARNESS), forged.goto(HARNESS)]);
    for (const [page, token, key] of [[alice, aliceToken, aliceKey], [forged, erinToken, bobKey]] as const) {
      await page.evaluate((arg) => (globalThis as unknown as W).harness.dillaJoin(arg), {
        livekitUrl: token.livekitUrl, token: token.token, iceServers: token.iceServers,
        epoch: epochWire(key, key.epoch), caps: token.caps,
      });
    }
    // Erin's SFU identity is valid, but the forged sender has Bob's leaf and frame key.
    await forged.evaluate(() => (globalThis as unknown as W).harness.dillaPublishMic());
    await expect.poll(async () => (await alice.evaluate(() => (globalThis as unknown as W).harness.dillaRemoteStats()))
      .some((track) => track.participantIdentity === erinDevice && track.kind === 'audio' && track.packetsReceived > 0),
    { timeout: 15_000 }).toBe(true);
    // Absence over this window catches a receiver that skips binding and decrypts Bob on Erin's track.
    await alice.waitForTimeout(2_500);
    const tracks = (await alice.evaluate(() => (globalThis as unknown as W).harness.dillaRemoteStats()))
      .filter((track) => track.participantIdentity === erinDevice && track.kind === 'audio');
    expect(tracks.length).toBeGreaterThan(0);
    expect(tracks.every((track) => track.totalSamplesReceived === 0)).toBe(true);
    expect((await alice.evaluate(() => (globalThis as unknown as W).harness.dillaStats())).dropped.senderMismatch).toBeGreaterThan(0);
  } finally {
    await driver.close();
  }
});

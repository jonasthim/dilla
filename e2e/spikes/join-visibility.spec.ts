import { expect, test } from '@playwright/test';
import { DS_URL, MediaDriver, epochWire, kidHex, testkitEnv, type CallToken, type MediaKey } from '../media/support/driver';
import type { DillaHarness, DillaHarness21 } from '../../packages/media/harness/main';

type W = { harness: DillaHarness & DillaHarness21 };
const HARNESS = 'http://127.0.0.1:5179/';
const JOINS = 20;

test('SP-12 join visibility and joiner KID across twenty independent calls', async ({ browser }) => {
  test.setTimeout(600_000);
  const visibility: number[] = [];
  const kidAfterPublish: number[] = [];
  for (let i = 0; i < JOINS; i++) {
    const driver = await MediaDriver.start(DS_URL, testkitEnv(), (Date.now() + i) % 0xff_ffff);
    const aliceContext = await browser.newContext();
    const daveContext = await browser.newContext();
    try {
      await driver.request('setup', { actors: ['alice', 'dave'] });
      await driver.request('open_call', { actor: 'alice' });
      const alice = await aliceContext.newPage();
      await alice.goto(HARNESS);
      const aliceKey = await driver.request<MediaKey>('media_key', { actor: 'alice' });
      const aliceToken = await driver.request<CallToken>('call_token', { actor: 'alice', vdec: 'vp8' });
      await alice.evaluate((o) => (globalThis as unknown as W).harness.dillaJoin(o), {
        livekitUrl: aliceToken.livekitUrl, token: aliceToken.token, iceServers: aliceToken.iceServers,
        epoch: epochWire(aliceKey, aliceKey.epoch), caps: aliceToken.caps,
      });
      const joinStart = Date.now();
      await driver.request('join', { actor: 'dave' });
      await driver.request('sync', { actor: 'alice' });
      const nextKey = await driver.request<MediaKey>('media_key', { actor: 'alice' });
      await alice.evaluate((o) => (globalThis as unknown as W).harness.dillaInstall(o), epochWire(nextKey, aliceKey.epoch));
      const daveKey = await driver.request<MediaKey>('media_key', { actor: 'dave' });
      const daveToken = await driver.request<CallToken>('call_token', { actor: 'dave', vdec: 'vp8' });
      const device = (await driver.request<{ deviceId: string }>('device', { actor: 'dave' })).deviceId;
      const dave = await daveContext.newPage();
      await dave.goto(HARNESS);
      await dave.evaluate((o) => (globalThis as unknown as W).harness.dillaJoin(o), {
        livekitUrl: daveToken.livekitUrl, token: daveToken.token, iceServers: daveToken.iceServers,
        epoch: epochWire(daveKey, daveKey.epoch), caps: daveToken.caps,
      });
      await expect.poll(async () => (await alice.evaluate(() => (globalThis as unknown as W).harness.dillaParticipantSeen()))[device] ?? 0,
        { timeout: 10_000 }).toBeGreaterThan(0);
      const seenAt = (await alice.evaluate(() => (globalThis as unknown as W).harness.dillaParticipantSeen()))[device];
      visibility.push(seenAt - joinStart);
      const publishStart = Date.now();
      await dave.evaluate(() => (globalThis as unknown as W).harness.dillaPublishMic());
      const kid = kidHex(daveKey.selfLeaf, daveKey.epoch);
      await expect.poll(async () => (await alice.evaluate(() => (globalThis as unknown as W).harness.dillaStats())).decrypted[kid] ?? 0,
        { timeout: 10_000 }).toBeGreaterThan(0);
      kidAfterPublish.push(Date.now() - publishStart);
      console.log('SP12_JOIN', JSON.stringify({ engine: 'chromium', sample: i + 1,
        visibilityMs: visibility[i], kidAfterPublishMs: kidAfterPublish[i] }));
    } finally {
      await daveContext.close();
      await aliceContext.close();
      await driver.close();
    }
  }
  const percentile = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * p) - 1];
  const summary = { engine: 'chromium', n: JOINS,
    visibility: { p50: percentile(visibility, .50), p95: percentile(visibility, .95), p99: percentile(visibility, .99) },
    kidAfterPublish: { p50: percentile(kidAfterPublish, .50), p95: percentile(kidAfterPublish, .95), p99: percentile(kidAfterPublish, .99) },
  };
  console.log('SP12_SUMMARY', JSON.stringify(summary));
  await test.info().attach('sp12-twenty-joins.json', { body: JSON.stringify({ ...summary, visibility, kidAfterPublish }, null, 2), contentType: 'application/json' });
});

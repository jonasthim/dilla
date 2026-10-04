import { randomBytes } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { debugToken } from './support/lk';
import { frameAccountingErrors } from './support/frame-accounting';
import { CONTROL_URL, DS_URL, MediaDriver, epochWire, kidHex, roomOfToken, testkitEnv, type CallToken, type MediaKey } from './support/driver';
import type { DillaHarness, DillaHarness21 } from '../../packages/media/harness/main';

type W = {
  harness: DillaHarness &
    DillaHarness21 & {
      connect(url: string, token: string, opts: { e2ee: 'none' | 'stub'; stub?: { kind: 'xor'; keyPrefix: number; deltaPrefix: number; sframeLayout: boolean } }): Promise<void>;
      publish(what: { mic?: boolean; camera?: boolean }): Promise<void>;
    };
};
const HARNESS = 'http://127.0.0.1:5179/';
/** SP-13 measured browser upper bounds: mic mute 64, mic close 14, VP8 close 8. */
const SIF_CEILING = 86;

async function open(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(HARNESS);
  return page;
}

async function member(driver: MediaDriver, page: Page, actor: string, browserName: string): Promise<{ key: MediaKey; token: CallToken }> {
  const key = await driver.request<MediaKey>('media_key', { actor });
  const token = await driver.request<CallToken>('call_token', { actor, vdec: browserName === 'firefox' ? 'vp8' : 'vp8,h264' });
  await page.evaluate((o) => (globalThis as unknown as W).harness.dillaJoin(o), {
    livekitUrl: token.livekitUrl, token: token.token, iceServers: token.iceServers, epoch: epochWire(key, key.epoch), caps: token.caps,
  });
  await page.evaluate(() => (globalThis as unknown as W).harness.dillaPublishMic());
  await driver.request('share', { actor, callId: token.callId });
  await page.evaluate(() => (globalThis as unknown as W).harness.dillaWaitPermission('camera', 10_000));
  await page.evaluate((cam) => (globalThis as unknown as W).harness.dillaPublish(cam === 'device' ? { deviceCamera: true } : { camera: true, simulcast: false }), browserName === 'firefox' ? 'device' : 'canvas');
  return { key, token };
}

test('a canary connected straight to the SFU is decoded by nobody (MD-13, SP-13, DEV-63)', async ({ browser, browserName }) => {
  test.setTimeout(180_000);
  const driver = await MediaDriver.start(DS_URL, testkitEnv());
  try {
    await driver.request('setup', { actors: ['alice', 'bob'] });
    await driver.request('open_call', { actor: 'alice' });
    await driver.request('join', { actor: 'bob' });
    await driver.request('sync', { actor: 'alice' });
    const pa = await open(browser);
    const a = await member(driver, pa, 'alice', browserName);
    const room = roomOfToken(a.token.token);

    // Two canaries, neither in the MLS group: one publishes NONE, one garbage ciphertext under the GCM
    // flag with an SFrame-shaped header (the stub's keystream randomises from the first ciphertext byte).
    const canaries = [randomBytes(16).toString('hex'), randomBytes(16).toString('hex')];
    const modes = [{ e2ee: 'none' as const }, { e2ee: 'stub' as const, stub: { kind: 'xor' as const, keyPrefix: 10, deltaPrefix: 1, sframeLayout: true } }];
    for (const [i, id] of canaries.entries()) {
      const t = await debugToken(CONTROL_URL, room, id, false);
      const cp = await open(browser);
      await cp.evaluate(([url, token, opts]) => (globalThis as unknown as W).harness.connect(url, token, opts), [t.url, t.token, modes[i]] as const);
      await cp.evaluate(() => (globalThis as unknown as W).harness.publish({ mic: true, camera: true }));
    }
    // Firefox leg: bob joins while the canaries are already published (the initial-connect deferral case).
    const pb = await open(browser);
    const b = await member(driver, pb, 'bob', browserName);
    const memberKids = new Set([kidHex(a.key.selfLeaf, b.key.epoch), kidHex(b.key.selfLeaf, b.key.epoch), kidHex(a.key.selfLeaf, a.key.epoch)]);

    for (let tick = 0; tick < 20; tick++) {
      for (const page of [pa, pb]) {
        if (browserName === 'chromium') {
          for (const s of await page.evaluate(() => (globalThis as unknown as W).harness.dillaRemoteStats())) {
            if (!canaries.includes(s.participantIdentity)) continue;
            expect(s.framesDecoded, `canary video decoded on a member`).toBe(0);
            expect(s.totalSamplesReceived, `canary audio played on a member`).toBe(0);
          }
        } else {
          for (const r of await page.evaluate(() => (globalThis as unknown as W).harness.dillaRenderProbe(250))) {
            if (!canaries.includes(r.participantIdentity)) continue;
            expect(r.frames, 'canary video rendered on a member').toBe(0);
            expect(r.rms, 'canary audio audible on a member').toBeLessThan(0.01);
          }
        }
      }
      await pa.waitForTimeout(250);
    }
    for (const page of [pa, pb]) {
      const s = await page.evaluate(() => (globalThis as unknown as W).harness.dillaStats());
      const dropped = Object.entries(s.dropped).filter(([reason]) => reason !== 'sif').reduce((n, [, v]) => n + v, 0);
      expect(dropped, 'the worker dropped the canary frames').toBeGreaterThan(0);
      for (const kid of Object.keys(s.decrypted)) expect(memberKids.has(kid), `decrypted an unexpected KID ${kid}`).toBe(true);
      expect(s.dropped.sif).toBeLessThanOrEqual(SIF_CEILING);
      if (browserName === 'chromium') {
        const senderKids = { [a.key.roster.find((r) => r.leaf === a.key.selfLeaf)!.deviceId]: [kidHex(a.key.selfLeaf, a.key.epoch)],
          [b.key.roster.find((r) => r.leaf === b.key.selfLeaf)!.deviceId]: [kidHex(b.key.selfLeaf, b.key.epoch)] };
        const rosterTracks = (await page.evaluate(() => (globalThis as unknown as W).harness.dillaRemoteStats()))
          .filter((track) => Object.hasOwn(senderKids, track.participantIdentity));
        // Canary tracks have the stronger zero-decoded/zero-samples checks above. Their RTP packet
        // count includes packets the worker rejects before a decoder, so it is not a decrypt count.
        expect(frameAccountingErrors(rosterTracks, s, senderKids)).toEqual([]);
      }
    }
  } finally {
    await driver.close();
  }
});

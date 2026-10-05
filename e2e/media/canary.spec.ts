import { randomBytes } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { debugToken } from './support/lk';
import { CONTROL_URL, DS_URL, MediaDriver, epochWire, kidHex, testkitEnv, type CallToken, type MediaKey } from './support/driver';
import type { DillaHarness, DillaHarness21 } from '../../packages/media/harness/main';
import { frameAccountingErrors } from './support/frame-accounting';

type W = {
  harness: DillaHarness &
    DillaHarness21 & {
      connect(url: string, token: string, opts: { e2ee: 'none' | 'stub'; stub?: { kind: 'xor'; keyPrefix: number; deltaPrefix: number; sframeLayout: boolean; clearBody?: boolean } }): Promise<void>;
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

async function member(driver: MediaDriver, page: Page, actor: string, browserName: string, room: string): Promise<{ key: MediaKey; token: CallToken }> {
  const key = await driver.request<MediaKey>('media_key', { actor });
  const issued = await driver.request<CallToken>('call_token', { actor, vdec: browserName === 'firefox' ? 'vp8' : 'vp8,h264' });
  const identity = key.roster.find((r) => r.leaf === key.selfLeaf)!.deviceId;
  const debug = await debugToken(CONTROL_URL, room, identity, true);
  const token = { ...issued, livekitUrl: debug.url, token: debug.token };
  await page.evaluate((o) => (globalThis as unknown as W).harness.dillaJoin(o), {
    livekitUrl: token.livekitUrl, token: token.token, iceServers: token.iceServers, epoch: epochWire(key, key.epoch), caps: token.caps,
  });
  await page.evaluate(() => (globalThis as unknown as W).harness.dillaPublishMic());
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
    // A debug room is exempt from dillad's non-leaf sweep. It models an SFU that keeps
    // injecting non-member tracks throughout the asserted exposure window.
    const room = `canary-${randomBytes(8).toString('hex')}`;
    const pa = await open(browser);
    const a = await member(driver, pa, 'alice', browserName, room);

    // Two canaries, neither in the MLS group: one publishes NONE, one puts playable media in an
    // unauthenticated SFrame-shaped envelope under GCM. Expiry must never expose that body.
    const canaries = [randomBytes(16).toString('hex'), randomBytes(16).toString('hex')];
    const modes = [{ e2ee: 'none' as const }, { e2ee: 'stub' as const, stub: { kind: 'xor' as const, keyPrefix: 10, deltaPrefix: 1, sframeLayout: true, clearBody: true } }];
    for (const [i, id] of canaries.entries()) {
      const t = await debugToken(CONTROL_URL, room, id, false);
      const cp = await open(browser);
      await cp.evaluate(([url, token, opts]) => (globalThis as unknown as W).harness.connect(url, token, opts), [t.url, t.token, modes[i]] as const);
      await cp.evaluate(() => (globalThis as unknown as W).harness.publish({ mic: true, camera: true }));
    }
    // Bob connects after the canaries already publish: initial subscription must also fail closed.
    const pb = await open(browser);
    const b = await member(driver, pb, 'bob', browserName, room);
    const memberKids = new Set([kidHex(a.key.selfLeaf, b.key.epoch), kidHex(b.key.selfLeaf, b.key.epoch), kidHex(a.key.selfLeaf, a.key.epoch)]);

    // First establish that both canaries and both sources reached both members.
    for (const page of [pa, pb]) {
      await expect.poll(async () => {
        const tracks = await page.evaluate(() => (globalThis as unknown as W).harness.dillaRemoteStats());
        return canaries.every((id) => ['audio', 'video'].every((kind) =>
          tracks.some((t) => t.participantIdentity === id && t.kind === kind && t.packetsReceived > 0)));
      }, { timeout: 10_000 }).toBe(true);
    }
    // Twenty 250 ms ticks keep zero-render under observation for at least five seconds after
    // presence on both pages, past the worker's two-second unknown-KID hold.
    for (let tick = 0; tick < 20; tick++) {
      for (const page of [pa, pb]) {
        const present = (await page.evaluate(() => (globalThis as unknown as W).harness.dillaRemoteStats()))
          .filter((s) => canaries.includes(s.participantIdentity));
        for (const id of canaries) {
          expect(present.some((s) => s.participantIdentity === id && s.kind === 'audio' && s.packetsReceived > 0), `${id} audio present for the asserted window`).toBe(true);
          expect(present.some((s) => s.participantIdentity === id && s.kind === 'video' && s.packetsReceived > 0), `${id} video present for the asserted window`).toBe(true);
        }
        if (browserName === 'chromium') {
          for (const s of present) {
            expect(s.framesDecoded, `canary video decoded on a member`).toBe(0);
            expect(s.totalSamplesReceived, `canary audio played on a member`).toBe(0);
          }
        } else {
          const rendered = (await page.evaluate(() => (globalThis as unknown as W).harness.dillaRenderProbe(250)))
            .filter((r) => canaries.includes(r.participantIdentity));
          for (const id of canaries) for (const kind of ['audio', 'video'])
            expect(rendered.some((r) => r.participantIdentity === id && r.kind === kind), `${id} ${kind} attached for rendering probe`).toBe(true);
          for (const r of rendered) {
            if (!canaries.includes(r.participantIdentity)) continue;
            expect(r.frames, 'canary video rendered on a member').toBe(0);
            expect(r.rms, 'canary audio audible on a member').toBeLessThan(0.01);
          }
        }
      }
      await pa.waitForTimeout(250);
    }
    for (const page of [pa, pb]) {
      const allTracks = await page.evaluate(() => (globalThis as unknown as W).harness.dillaRemoteStats());
      const s = await page.evaluate(() => (globalThis as unknown as W).harness.dillaStats());
      const senderKids = { [a.key.roster.find((r) => r.leaf === a.key.selfLeaf)!.deviceId]: [kidHex(a.key.selfLeaf, a.key.epoch)],
        [b.key.roster.find((r) => r.leaf === b.key.selfLeaf)!.deviceId]: [kidHex(b.key.selfLeaf, b.key.epoch)] };
      expect(frameAccountingErrors(allTracks.filter((t) => !canaries.includes(t.participantIdentity)), s, senderKids), 'member media is accounted by the worker').toEqual([]);
      const canaryTracks = allTracks
        .filter((track) => canaries.includes(track.participantIdentity));
      for (const track of canaryTracks) {
        await expect.poll(async () => (await page.evaluate(() => (globalThis as unknown as W).harness.dillaStats()))
          .droppedByTrack[track.trackId] ?? 0, { message: `refused ${track.participantIdentity}/${track.kind}` })
          .toBeGreaterThan(0);
      }
      // Check again after the refusal polls: expiry must not release a held frame into the decoder.
      if (browserName === 'chromium') {
        const after = (await page.evaluate(() => (globalThis as unknown as W).harness.dillaRemoteStats()))
          .filter((track) => canaries.includes(track.participantIdentity));
        for (const track of after) {
          expect(track.framesDecoded, 'canary video decoded after hold expiry').toBe(0);
          expect(track.totalSamplesReceived, 'canary audio played after hold expiry').toBe(0);
        }
      } else {
        const after = (await page.evaluate(() => (globalThis as unknown as W).harness.dillaRenderProbe(250)))
          .filter((track) => canaries.includes(track.participantIdentity));
        for (const track of after) {
          expect(track.frames, 'canary video rendered after hold expiry').toBe(0);
          expect(track.rms, 'canary audio audible after hold expiry').toBeLessThan(0.01);
        }
      }
      const dropped = Object.entries(s.dropped).filter(([reason]) => reason !== 'sif').reduce((n, [, v]) => n + v, 0);
      expect(dropped, 'the worker dropped the canary frames').toBeGreaterThan(0);
      for (const kid of Object.keys(s.decrypted)) expect(memberKids.has(kid), `decrypted an unexpected KID ${kid}`).toBe(true);
      expect(s.dropped.sif).toBeLessThanOrEqual(SIF_CEILING);
    }
  } finally {
    await driver.close();
  }
});

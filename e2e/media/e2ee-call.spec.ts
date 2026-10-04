import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { DS_URL, MediaDriver, epochWire, kidHex, testkitEnv, type CallToken, type MediaKey } from './support/driver';
import { activate } from './support/lk';
import type { DillaHarness, DillaHarness21 } from '../../packages/media/harness/main';

type W = { harness: DillaHarness & DillaHarness21 };
const HARNESS = 'http://127.0.0.1:5179/';

test.skip(({ browserName }) => browserName !== 'chromium', 'the three-context call runs on chromium-media (task 21)');

interface Member {
  actor: string;
  page: Page;
  device: string;
  key: MediaKey;
  token: CallToken;
  minEpoch: string;
}

async function open(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(HARNESS);
  return page;
}

async function enter(driver: MediaDriver, page: Page, actor: string): Promise<Member> {
  const { deviceId } = await driver.request<{ deviceId: string }>('device', { actor });
  const key = await driver.request<MediaKey>('media_key', { actor });
  const token = await driver.request<CallToken>('call_token', { actor, vdec: 'vp8,h264' });
  await page.evaluate((o) => (globalThis as unknown as W).harness.dillaJoin(o), {
    livekitUrl: token.livekitUrl,
    token: token.token,
    iceServers: token.iceServers,
    epoch: epochWire(key, key.epoch),
    caps: token.caps,
  });
  return { actor, page, device: deviceId, key, token, minEpoch: key.epoch };
}

/** Mic first; camera (and screen) once the lease is pushed (DEV-02: wait for the permission, c.7). */
async function publish(driver: MediaDriver, m: Member, what: Parameters<DillaHarness21['dillaPublish']>[0]): Promise<void> {
  await m.page.evaluate(() => (globalThis as unknown as W).harness.dillaPublishMic());
  await driver.request('share', { actor: m.actor, callId: m.token.callId });
  await m.page.evaluate(() => (globalThis as unknown as W).harness.dillaWaitPermission('camera', 10_000));
  await m.page.evaluate((w) => (globalThis as unknown as W).harness.dillaPublish(w), what);
}

/** The member syncs its MLS client and its page installs the epoch it now holds; returns when. */
async function install(driver: MediaDriver, m: Member): Promise<number> {
  await driver.request('sync', { actor: m.actor });
  m.key = await driver.request<MediaKey>('media_key', { actor: m.actor });
  await m.page.evaluate((k) => (globalThis as unknown as W).harness.dillaInstall(k), epochWire(m.key, m.minEpoch));
  return Date.now();
}

const stats = (p: Page) => p.evaluate(() => (globalThis as unknown as W).harness.dillaStats());
const remote = (p: Page) => p.evaluate(() => (globalThis as unknown as W).harness.dillaRemoteStats());
const count = async (p: Page, kid: string) => (await stats(p)).decrypted[kid] ?? 0;
const kidOf = (m: Member, epoch: bigint) => kidHex(m.key.selfLeaf, epoch);
const pairs = (ms: Member[]) => ms.flatMap((rx) => ms.filter((tx) => tx !== rx).map((tx) => [rx, tx] as const));

async function record(info: TestInfo, name: string, body: unknown): Promise<void> {
  await info.attach(name, { body: JSON.stringify(body, null, 2), contentType: 'application/json' });
  console.log(`TASK21_MEASUREMENT ${name} ${JSON.stringify(body)}`);
}

test('three contexts decrypt per KID; a join and a leave move every receiver to the new KID', async ({ browser }, info) => {
  test.setTimeout(300_000);
  const driver = await MediaDriver.start(DS_URL, testkitEnv());
  try {
    await driver.request('setup', { actors: ['alice', 'bob', 'carol', 'dave'] });
    await driver.request('open_call', { actor: 'alice' });
    await driver.request('join', { actor: 'bob' });
    await driver.request('join', { actor: 'carol' });
    for (const actor of ['alice', 'bob']) await driver.request('sync', { actor });
    const alice = await enter(driver, await open(browser), 'alice');
    const bob = await enter(driver, await open(browser), 'bob');
    const carol = await enter(driver, await open(browser), 'carol');
    const e = BigInt(alice.key.epoch);
    expect([bob.key.epoch, carol.key.epoch]).toEqual([alice.key.epoch, alice.key.epoch]);

    // SP-24: the page's peer connection carries exactly the dilla list ([] on the test host: TURN off).
    expect(alice.token.iceServers).toEqual([]);
    const ice = await alice.page.evaluate(() => (globalThis as unknown as W).harness.dillaIceServers());
    for (const list of ice) expect(list).toEqual([]);
    expect(JSON.stringify(ice)).not.toMatch(/twilio\.com|google\.com/);

    for (const m of [alice, bob, carol]) await publish(driver, m, { camera: true, simulcast: m !== bob, videoCodec: m === bob ? 'h264' : 'vp8' });
    await alice.page.evaluate(() => (globalThis as unknown as W).harness.dillaWaitPermission('screen_share', 10_000));
    await activate(alice.page); // getDisplayMedia needs transient activation; page.evaluate grants none (fact 24)
    await alice.page.evaluate(() => (globalThis as unknown as W).harness.dillaPublish({ screen: true }));

    // Every receiver decrypts every sender, per KID (DEV-16).
    for (const [rx, tx] of pairs([alice, bob, carol])) {
      await expect.poll(() => count(rx.page, kidOf(tx, e)), { timeout: 20_000, message: `${rx.actor} decrypts ${tx.actor}` }).toBeGreaterThan(0);
    }
    // The fake getDisplayMedia share decrypts and renders on bob.
    await expect
      .poll(async () => (await remote(bob.page)).some((s) => s.participantIdentity === alice.device && s.source === 'screen_share' && s.framesDecoded > 0), { timeout: 20_000 })
      .toBe(true);

    // SP-31 browser half: no RED, AV1, H.265 or sprop-parameter-sets; H.264 only at packetization-mode 1.
    const sdp = (await alice.page.evaluate(() => (globalThis as unknown as W).harness.dillaRemoteSdp())).join('\n');
    expect(sdp).not.toMatch(/a=rtpmap:\d+ red\//i);
    expect(sdp).not.toMatch(/a=rtpmap:\d+ (AV1|H265)\//i);
    expect(sdp).not.toContain('sprop-parameter-sets');
    const h264Fmtp = sdp.match(/a=fmtp:\d+ [^\r\n]*profile-level-id[^\r\n]*/g) ?? [];
    // LiveKit offers mode 0 as well as mode 1. The active sender codec is checked below;
    // an unused mode-0 offer does not imply a mode-0 publication.
    expect(h264Fmtp.some((fmtp) => fmtp.includes('packetization-mode=1'))).toBe(true);
    const answer = (await bob.page.evaluate(() => (globalThis as unknown as W).harness.dillaLocalSdp())).join('\n');
    console.log('TASK21_CODEC', JSON.stringify({ offer: h264Fmtp, answer: answer.match(/a=fmtp:\d+ [^\r\n]*profile-level-id[^\r\n]*/g) ?? [] }));
    await expect.poll(async () => (await bob.page.evaluate(() => (globalThis as unknown as W).harness.dillaActiveVideoCodecs())).filter((codec) => codec.toLowerCase().includes('h264')).length, { timeout: 10_000 }).toBeGreaterThan(0);
    const activeVideo = await bob.page.evaluate(() => (globalThis as unknown as W).harness.dillaActiveVideoCodecs());
    console.log('TASK21_ACTIVE_CODEC', JSON.stringify(activeVideo));
    for (const codec of activeVideo.filter((value) => value.toLowerCase().includes('h264'))) expect(codec).toContain('packetization-mode=1');

    // SP-06 simulcast half: three rids sent; no receiver sees a replayed (KID, slot, layer, seq).
    await expect.poll(async () => (await alice.page.evaluate(() => (globalThis as unknown as W).harness.dillaSenderRids())).length, { timeout: 15_000 }).toBe(3);
    for (const m of [bob, carol]) expect((await stats(m.page)).dropped.replay).toBe(0);

    // ---- dave joins: epoch e+1 ----
    await expect.poll(async () => (await remote(alice.page)).some((s) => s.participantIdentity === bob.device && s.kind === 'audio'), { timeout: 10_000 }).toBe(true);
    await expect.poll(async () => (await remote(alice.page)).some((s) => s.participantIdentity === bob.device && s.source === 'camera'), { timeout: 10_000 }).toBe(true);
    const audioBefore = (await remote(alice.page)).find((s) => s.participantIdentity === bob.device && s.kind === 'audio')!;
    const videoBefore = (await remote(alice.page)).find((s) => s.participantIdentity === bob.device && s.source === 'camera')!;
    await driver.request('join', { actor: 'dave' });
    const tMerge: Record<string, number> = {};
    for (const m of [alice, bob, carol]) tMerge[m.actor] = await install(driver, m);
    const e1 = e + 1n;
    for (const m of [alice, bob, carol]) expect(BigInt(m.key.epoch)).toBe(e1);
    for (const m of [alice, bob, carol]) expect((await stats(m.page)).currentEpoch).toBe(e1.toString());

    // Within 2 s of the installs every existing sender's new KID decrypts everywhere; the old KID
    // gains at most one in-flight frame per track (audio + camera) after its sender rekeyed.
    const oldBob = await count(alice.page, kidOf(bob, e));
    for (const [rx, tx] of pairs([alice, bob, carol])) {
      await expect.poll(() => count(rx.page, kidOf(tx, e1)), { timeout: 2_000, message: `${rx.actor} moves to ${tx.actor}'s e+1 KID` }).toBeGreaterThan(0);
    }
    await alice.page.waitForTimeout(2_000);
    expect((await count(alice.page, kidOf(bob, e))) - oldBob).toBeLessThanOrEqual(2);

    const dave = await enter(driver, await open(browser), 'dave');
    const tDaveIn = Date.now();
    const tDavePublishStart = Date.now();
    await publish(driver, dave, { camera: true, simulcast: true });
    let tFrame = 0;
    await expect
      .poll(async () => {
        const n = await count(alice.page, kidOf(dave, e1));
        if (n > 0 && tFrame === 0) tFrame = Date.now();
        return n;
      }, { timeout: 2_000, message: "dave's KID decrypts on alice within 2 s of his publish" })
      .toBeGreaterThan(0);
    expect(tFrame - tDavePublishStart).toBeLessThanOrEqual(2_000);
    for (const rx of [bob, carol]) await expect.poll(() => count(rx.page, kidOf(dave, e1)), { timeout: 2_000 }).toBeGreaterThan(0);

    // Key-frame latency: the joiner's time to first frame; existing members never freeze (held frames).
    await expect.poll(async () => (await remote(dave.page)).filter((s) => s.kind === 'video' && s.framesDecoded > 0).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
    const ttff = Date.now() - tDaveIn;
    const videoAfter = (await remote(alice.page)).find((s) => s.participantIdentity === bob.device && s.source === 'camera')!;
    expect(videoAfter.freezeCount - videoBefore.freezeCount).toBe(0);
    const audioAfter = (await remote(alice.page)).find((s) => s.participantIdentity === bob.device && s.kind === 'audio')!;
    const seen = await alice.page.evaluate(() => (globalThis as unknown as W).harness.dillaParticipantSeen());

    await record(info, 'sp12-join-visibility.json', {
      t_pc_minus_t_merge_ms: seen[dave.device] - tMerge.alice,
      t_frame_minus_t_merge_ms: tFrame - tMerge.alice,
      joiner_kid_decrypt_after_publish_start_ms: tFrame - tDavePublishStart,
    });
    await record(info, 'sp07-audio-across-commit.json', {
      hold_ms: 2000,
      concealedSamples: audioAfter.concealedSamples - audioBefore.concealedSamples,
      jitterBufferDelay: audioAfter.jitterBufferDelay - audioBefore.jitterBufferDelay,
    });
    await record(info, 'keyframe-latency.json', { joiner_time_to_first_frame_ms: ttff, existing_member_freezes: 0 });

    // ---- carol is removed: epoch e+2 ----
    await driver.request('leave', { actor: 'carol' });
    await driver.request('commit', { actor: 'alice' });
    for (const m of [alice, bob, dave]) await install(driver, m);
    const e2 = e1 + 1n;
    for (const m of [alice, bob, dave]) expect(BigInt(m.key.epoch)).toBe(e2);
    for (const [rx, tx] of pairs([alice, bob, dave])) {
      await expect.poll(() => count(rx.page, kidOf(tx, e2)), { timeout: 2_000 }).toBeGreaterThan(0);
    }
    // The evictor cut carol's SFU session at the commit (DEV-44): her e+1 KID stops, and stays
    // stopped past the 10 s retention of e+1; her leaf never has a KID in e+2.
    await alice.page.waitForTimeout(3_000);
    const carolAt3s = await count(alice.page, kidOf(carol, e1));
    await alice.page.waitForTimeout(9_000);
    expect(await count(alice.page, kidOf(carol, e1))).toBe(carolAt3s);
    for (const m of [alice, bob, dave]) expect((await stats(m.page)).decrypted[kidOf(carol, e2)]).toBeUndefined();
    for (const m of [alice, bob, dave]) expect((await stats(m.page)).passedThrough).toBe(0);
  } finally {
    await driver.close();
  }
});

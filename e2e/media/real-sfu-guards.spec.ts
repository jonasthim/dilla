import { expect, test } from './support/test';
import { randomBytes } from 'node:crypto';
import { DS_URL, CONTROL_URL, MediaDriver, epochWire, kidHex, testkitEnv, type CallToken, type MediaKey } from './support/driver';
import { debugToken } from './support/lk';
import type { DillaHarness, DillaHarness21 } from '../../packages/media/harness/main';

type W = { harness: DillaHarness & DillaHarness21 };
const HARNESS = 'http://127.0.0.1:5179/';

test('audio stops at a failed worker and a dead sender refuses replaceTrack through the real SFU', async ({ browser }) => {
  test.setTimeout(90_000);
  const driver = await MediaDriver.start(DS_URL, testkitEnv());
  try {
    await driver.request('setup', { actors: ['alice', 'bob'] });
    await driver.request('open_call', { actor: 'alice' });
    await driver.request('join', { actor: 'bob' });
    await driver.request('sync', { actor: 'alice' });
    const pages = await Promise.all([browser.newContext(), browser.newContext()]);
    const [alice, bob] = await Promise.all(pages.map(async (ctx) => { const p = await ctx.newPage(); await p.goto(HARNESS); return p; }));
    const aKey = await driver.request<MediaKey>('media_key', { actor: 'alice' });
    const bKey = await driver.request<MediaKey>('media_key', { actor: 'bob' });
    const aTok = await driver.request<CallToken>('call_token', { actor: 'alice', vdec: 'vp8' });
    const bTok = await driver.request<CallToken>('call_token', { actor: 'bob', vdec: 'vp8' });
    for (const [page, key, token] of [[alice, aKey, aTok], [bob, bKey, bTok]] as const) {
      await page.evaluate((o) => (globalThis as unknown as W).harness.dillaJoin(o), {
        livekitUrl: token.livekitUrl, token: token.token, iceServers: token.iceServers,
        epoch: epochWire(key, key.epoch), caps: token.caps,
      });
    }
    const h264Fmtp = (await alice.evaluate(async () => {
      const h = (globalThis as unknown as W).harness;
      return (await Promise.all([h.dillaRemoteSdp(), h.dillaLocalSdp()])).flat().join('\n').match(/a=fmtp:\d+ [^\r\n]*profile-level-id[^\r\n]*/g) ?? [];
    }));
    console.log('TASK21_GUARD_CODEC', JSON.stringify(h264Fmtp));
    for (const fmtp of h264Fmtp) {
      expect(fmtp).toContain('packetization-mode=1');
      expect(fmtp).toContain('profile-level-id=42e01f');
    }
    await alice.evaluate(() => (globalThis as unknown as W).harness.dillaPublishMic());
    await driver.request('share', { actor: 'alice', callId: aTok.callId });
    await alice.evaluate(() => (globalThis as unknown as W).harness.dillaWaitPermission('camera', 10_000));
    const kid = kidHex(aKey.selfLeaf, aKey.epoch);
    const count = () => bob.evaluate((k) => (globalThis as unknown as W).harness.dillaStats().then((s) => s.decrypted[k] ?? 0), kid);
    await expect.poll(count, { timeout: 10_000 }).toBeGreaterThan(0);
    const before = await alice.evaluate(() => (globalThis as unknown as W).harness.dillaAudioOutBytes());
    expect(before).toBeGreaterThan(0);
    await alice.evaluate(() => (globalThis as unknown as W).harness.dillaFailWorker());
    await alice.waitForTimeout(500);
    const after = await alice.evaluate(() => (globalThis as unknown as W).harness.dillaAudioOutBytes());
    const atStop = await count();
    await alice.waitForTimeout(1_000);
    expect(await alice.evaluate(() => (globalThis as unknown as W).harness.dillaAudioOutBytes())).toBe(after);
    expect((await count()) - atStop).toBeLessThanOrEqual(1);
    const guard = await alice.evaluate(() => (globalThis as unknown as W).harness.dillaDeadSenderReplaceProbe());
    expect(guard).toEqual({ replacementEnded: true, senderTrackNull: true });
  } finally {
    await driver.close();
  }
});

test('a recorded pre-connect microphone is refused through the real SFU', async ({ browser }) => {
  test.setTimeout(90_000);
  const driver = await MediaDriver.start(DS_URL, testkitEnv());
  try {
    await driver.request('setup', { actors: ['alice', 'bob'] });
    await driver.request('open_call', { actor: 'alice' });
    await driver.request('join', { actor: 'bob' });
    await driver.request('sync', { actor: 'alice' });
    const page = await (await browser.newContext()).newPage();
    await page.goto(HARNESS);
    const key = await driver.request<MediaKey>('media_key', { actor: 'alice' });
    const issued = await driver.request<CallToken>('call_token', { actor: 'alice', vdec: 'vp8' });
    // A debug room, as in the canary: dillad's room sweep removes a participant that is no leaf of the
    // call group, and the agent is none. In the call's own room the test raced that sweep (it lost
    // every time when run alone, right after the test host started).
    const room = `preconnect-${randomBytes(8).toString('hex')}`;
    const identity = key.roster.find((r) => r.leaf === key.selfLeaf)!.deviceId;
    const member = await debugToken(CONTROL_URL, room, identity, true);
    const token = { ...issued, livekitUrl: member.url, token: member.token };
    await page.evaluate((o) => (globalThis as unknown as W).harness.dillaJoin(o), {
      livekitUrl: token.livekitUrl, token: token.token, iceServers: token.iceServers,
      epoch: epochWire(key, key.epoch), caps: token.caps,
    });
    const agentIdentity = randomBytes(16).toString('hex');
    const agentToken = await debugToken(CONTROL_URL, room, agentIdentity, false);
    const agentPage = await (await browser.newContext()).newPage();
    await agentPage.goto(HARNESS);
    await agentPage.evaluate(([url, t]) => (globalThis as unknown as { harness: { connect: (u: string, t: string, o: { e2ee: 'none' }) => Promise<void> } }).harness.connect(url, t, { e2ee: 'none' }), [agentToken.url, agentToken.token] as const);
    await agentPage.evaluate(() => (globalThis as unknown as W).harness.agentByteStreamProbe('lk.agent.pre-connect-audio-buffer'));
    await expect.poll(async () => (await page.evaluate(() => (globalThis as unknown as W).harness.dillaParticipantSeen()))[agentIdentity] !== undefined, { timeout: 10_000 }).toBe(true);
    const preconnect = await page.evaluate((identity) => (globalThis as unknown as W).harness.dillaPreconnectProbe(identity), agentIdentity);
    expect(preconnect).toEqual({ echoed: true, streamOpens: 0, hadRecording: true });
    expect(await agentPage.evaluate(() => (globalThis as unknown as W).harness.agentByteStreamCount())).toBe(0);
  } finally {
    await driver.close();
  }
});

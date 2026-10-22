// UP9 (calls survive an upgrade): the acceptance e2e. The SFU is a separate process (`dillad media`, the UP5 sidecar) that
// also serves TURN (UP8), the API is the test host in sidecar mode wired as `dillad serve` is (cuts forwarded over media.sock,
// api.sock in the shared state directory), and three browsers are in one voice channel, carol forced through the relay
// (iceTransportPolicy 'relay'). The API is restarted under them four ways, in this order:
//   B1  a compatible release, same build: the API alone. Nobody notices: same LiveKit session, no removal, no frame gap
//       over 1 s, no new epoch, carol still relayed.
//   B2  a compatible release, new build: every page reloads at once and comes back; each one's own audio is out at most 5 s
//       (pagehide to its microphone published again, and to the others' inbound frames from it). An update reload may
//       rejoin by an external join rather than resume (Jonas): that is logged, not asserted against.
//   A2  everyone dropped at once, nobody left to commit: the API restarts and stays unreachable to the clients (its public
//       listener held) while their LiveKit sessions give up and leave the room, and while it runs its real room sweep, which
//       proposes the absence Remove of all three. Then it answers: the first device back resumes (its own Remove withdrawn,
//       one kind-3 row per resumer) within 5 s of starting its join, the others may be removed by its commit and rejoin
//       externally; every device is back within 30 s of the API answering (when a page starts its join is its recovery
//       backoff or its gateway's reconnect, both capped at 30 s, R-UP8), nobody sees E_REMOVE_PENDING, no new call group,
//       and a call_rotate lands after all three are back. No leftAway, with the AFK timeout at 60 s and the page clocks
//       10 min ahead.
//   A   a full restart, no input: the API stops, the SFU restarts, the API starts with a new build; all three connected in
//       the channel and hearing each other within 90 s of the API answering.
// compat (UP4's CI job): with DILLA_SFU_BIN set to the previous release's dillad, only B1 runs. A web3.11 SFU serves no TURN,
// so the API serves the relay and its restart drops carol's: she is exempt from B1's uninterrupted checks and must be heard
// again within 90 s.
// Measured timings are logged as `UP9 timings …` lines.
import { resolve } from 'node:path';
import type { Browser, Page } from '@playwright/test';
import { FIREFOX_MEDIA_PREFS } from '../media/support/fixtures';
import { OUTAGE_LINES, tagLeaveReasons } from './support/outage-lines';
import { REPO_ROOT, buildDillad, removeHostData, startMediaHost, startTestHost, swapWebRoot, type HostConfig, type MediaHost, type StartedHost } from '../web/support/host';
import { expect, mediaWorkers, test, type Person } from './support/peer-browser';
import { watchContexts } from './support/leaks';
import {
  frameTimes, groupRows, history, installUpgradeRecorder, movePageClock, recordRequests, relayUse, resetGaps, sampleFrames, sfuParticipants,
  shortenRotation, type UpgradeRecord,
} from './support/upgrade';
import { VoicePeer, WAIT, callSlice, connected, heardCount, joinVoice, onboard, self } from './support/voice';

// Ports no other spec binds: the API (public, control), the SFU (signalling, ICE/UDP), its webhook receiver, its TURN relay.
const PORT = 8561, CONTROL = 8562, SFU_PORT = 7924, SFU_UDP = 7926, WEBHOOK = 8567, TURN_PORT = 8568;
// A room's departure timeout (the API's CreateRoom names it). Production's is 20 s; A2 needs the emptied room to outlive the
// clients' drop plus the restarted API's two sweeps, which the sweep only sees while the room exists.
const DEPARTURE_S = 120;
const BASE = `http://127.0.0.1:${String(PORT)}`;
const DB = `/tmp/dw/host-${String(PORT)}/dilla.db`;
const DIST = 'packages/web/dist';
const NAMES = ['alice', 'bob', 'carol'] as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const COMPAT = process.env.DILLA_SFU_BIN !== undefined;

test.use({ baseURL: BASE });
watchContexts(test);
// The tree's dillad is the SFU unless DILLA_SFU_BIN names another (UP4's compat run, the previous release).
test.beforeAll(() => { if (process.env.DILLA_SFU_BIN === undefined) buildDillad(); });


interface Peer { name: typeof NAMES[number]; person: Person; device: string; requests: UpgradeRecord['requests'] }

async function postControl(control: string, path: string, body?: unknown): Promise<void> {
  const res = await fetch(`${control}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(res.status, `POST ${path}: ${await res.text()}`).toBe(204);
}

/** The page's own pagehide time, kept in sessionStorage across its reload (performance time, never the moved Date.now). */
function rememberPagehide(): void {
  addEventListener('pagehide', () => { try { sessionStorage.setItem('up9.pagehide', String(performance.timeOrigin + performance.now())); } catch { /* none */ } });
}
async function pagehideAt(page: Page): Promise<number> {
  return page.evaluate(() => Number(sessionStorage.getItem('up9.pagehide') ?? 'NaN'));
}
/** The new page's `dilla.resume.published` mark (UP7: its microphone published again), wall-clock ms; NaN without one. */
async function publishedAt(page: Page): Promise<number> {
  return page.evaluate(() => {
    const m = performance.getEntriesByName('dilla.resume.published')[0];
    return m === undefined ? Number.NaN : performance.timeOrigin + m.startTime;
  });
}

test('calls survive an upgrade: API-only restarts, an update reload, everyone dropped at once, a full restart', async ({ peerBrowser, playwright, browserName }) => {
  test.setTimeout(25 * 60_000);
  const env = { host: process.env.DILLA_TEST_HOST, control: process.env.DILLA_TESTKIT_CONTROL, invite: process.env.DILLA_TESTKIT_INVITE };
  const timings: Record<string, unknown> = { project: test.info().project.name, compat: COMPAT };
  const media: MediaHost = await startMediaHost({ port: SFU_PORT, udpPort: SFU_UDP, webhookURL: `http://127.0.0.1:${String(WEBHOOK)}`, turnPort: TURN_PORT });
  removeHostData(PORT);
  const cfg = (webRoot: string, holdPublic = false): HostConfig => ({
    port: PORT, control: CONTROL, webRoot, keepData: true, stateDir: media.dataDir, holdPublic,
    sfu: { port: SFU_PORT, udpPort: SFU_UDP, departureTimeout: DEPARTURE_S }, sidecar: media.sidecar,
  });
  // The build the pages run: B2 moves them to a swapped copy, A back to the original. A restart on the same build is no update.
  let root = DIST;
  let host: StartedHost = await startTestHost(cfg(root));
  const useHost = (h: StartedHost) => {
    process.env.DILLA_TEST_HOST = h.url;
    process.env.DILLA_TESTKIT_CONTROL = h.control;
    process.env.DILLA_TESTKIT_INVITE = h.invite;
  };
  useHost(host);
  const guard = peerBrowser.guard;
  /** Lines from index `from` on that match OUTAGE_LINES are dropped (counted); any other stays and fails the test. */
  const tolerate = (from: number, what: string) => {
    const rest = guard.consoleErrors.splice(from);
    const kept = rest.filter((l) => !OUTAGE_LINES.some((r) => r.test(l)));
    guard.consoleErrors.push(...kept);
    timings[`${what}.leaveReasons`] = rest.flatMap((l) => /\[leave reason (\S+)\]$/.exec(l)?.[1] ?? []);
    timings[`${what}.outageLines`] = rest.length - kept.length;
  };
  const peers: Peer[] = [];
  let peer: VoicePeer | null = null;
  // Everything here is on 127.0.0.1: the SFU offers loopback only (mediaToml with TURN) and the relay is on loopback. Firefox
  // pairs nothing on loopback unless asked (media.peerconnection.ice.loopback), so in Firefox the three people are contexts of
  // one Firefox launched with the project's prefs plus that one.
  let ownBrowser: Browser | undefined;
  try {
    if (browserName === 'firefox') {
      ownBrowser = await playwright.firefox.launch({ firefoxUserPrefs: { ...FIREFOX_MEDIA_PREFS, 'permissions.default.desktop-notification': 1,
        'media.peerconnection.ice.loopback': true } });
    }
    peer = peerBrowser.track(await VoicePeer.start());
    await peer.setup();
    for (const name of NAMES) {
      const person = await peerBrowser.open(name, ownBrowser === undefined ? undefined : { browser: ownBrowser });
      await person.context.addInitScript(installUpgradeRecorder, name === 'carol');
      await person.context.addInitScript(rememberPagehide);
      await person.context.addInitScript(tagLeaveReasons);
      const requests: UpgradeRecord['requests'] = [];
      recordRequests(person.context, requests);
      sampleFrames(person.page);
      await onboard(person, peer, name);
      peers.push({ name, person, device: (await self(person.page)).device, requests });
    }
    await peer.seat(3);
    const voice = peer.setupDone.voice_channel_id;
    if (voice === null) throw new Error('the peer set up no voice channel');
    const pages = peers.map((p) => p.person.page);
    const others = (p: Peer) => peers.filter((q) => q !== p);
    /** What each page hears, its call phase and epoch and its session phase: logged when `allHear` fails. */
    const hearing = async () => Object.fromEntries(await Promise.all(peers.map(async (p) => {
      const heard = Object.fromEntries(await Promise.all(others(p).map(async (q) => [q.name, await heardCount(p.person.page, q.device).catch(() => 'no worker')])));
      const call = await callSlice(p.person.page).catch(() => undefined);
      const dockPhase = (await history(p.person.page).catch(() => null))?.dock.at(-1)?.phase ?? null;
      // The media worker's own view: its epoch and keys, and the frames it refused by reason (a key or binding failure shows here).
      const worker = mediaWorkers(p.person.page).at(-1);
      const mediaStats = worker === undefined ? null : await worker.evaluate(() => {
        const st = (globalThis as unknown as { __dillaMediaStats?: { currentEpoch: string; knownKids: string[]; dropped: Record<string, number>; verifiedByTrack: Record<string, number> } }).__dillaMediaStats;
        return st === undefined ? null : { epoch: st.currentEpoch, kids: st.knownKids, dropped: st.dropped, tracks: Object.values(st.verifiedByTrack) };
      }).catch(() => null);
      return [p.name, { heard, phase: call?.phase, epoch: call?.epoch, roster: call?.roster.length, dock: dockPhase, media: mediaStats }] as const;
    })));
    /** Every page hears both others: each other device's verified frames rise. */
    const allHear = async (timeout = WAIT) => {
      try {
        for (const p of peers) {
          for (const q of others(p)) {
            const from = await heardCount(p.person.page, q.device).catch(() => 0);
            await expect.poll(() => heardCount(p.person.page, q.device).catch(() => -1), { timeout, message: `${p.name} hears ${q.name}` }).toBeGreaterThan(from);
          }
        }
      } catch (e) {
        timings.hearingAtFailure = await hearing().catch((err: unknown) => String(err));
        timings.sfuAtFailure = await (async () => {
          const rows = groupRows(DB, voice);
          return { epoch: rows.epoch, outstanding: rows.outstanding, participants: await sfuParticipants(SFU_PORT, media.sidecar.secretFile, rows.room) };
        })().catch((err: unknown) => String(err));
        throw e;
      }
    };
    /** UP6c: the frames each page's current media worker refused as `replay` (a (KID, CTR) it had already accepted), and
     *  whether that worker is the one it had before (`since`): a resumer that sealed from seq 0 again under the held
     *  epoch's KID shows here at a listener whose worker lived through it. */
    const replays = async () => Promise.all(pages.map(async (page) => {
      const worker = mediaWorkers(page).at(-1);
      if (worker === undefined) return { worker: null, replay: null };
      const replay = await worker.evaluate(() => (globalThis as unknown as { __dillaMediaStats?: { dropped: Record<string, number> } })
        .__dillaMediaStats?.dropped.replay ?? null).catch(() => null);
      return { worker, replay };
    }));
    const carol = peers[2].person.page;
    const carolRelayed = async (what: string) => {
      await expect.poll(async () => { const u = await relayUse(carol); return u.relayed > 0 && u.direct === 0; },
        { timeout: WAIT, message: `carol's media runs through the TURN relay only (${what})` }).toBe(true);
    };

    await test.step('setup: three in the channel, all heard, carol relayed, the AFK timeout at 60 s', async () => {
      for (const p of peers) await joinVoice(p.person.page, peer!.communityName, peer!.voiceName);
      for (const page of pages) await connected(page);
      await allHear();
      await carolRelayed('setup');
      await postControl(host.control, '/debug/afk/timeout', { community: peer!.setupDone.community_id, seconds: 60 });
    });

    await test.step('B1: the API alone restarts on the same build; nobody notices', async () => {
      const before = groupRows(DB, voice);
      const sids = await sfuParticipants(SFU_PORT, media.sidecar.secretFile, before.room);
      const epochs = await Promise.all(pages.map(async (page) => (await callSlice(page))?.epoch));
      const marks = await Promise.all(pages.map(async (page) => (await history(page)).calls.length));
      for (const page of pages) await resetGaps(page);
      const lines = guard.consoleErrors.length;
      const stopAt = Date.now();
      await host.stop();
      host = await startTestHost(cfg(root));
      useHost(host);
      const answerAt = Date.now();
      // Every page's instance is back (its gateway online after the answer), then 5 s more of frames.
      for (const page of pages) {
        await expect.poll(async () => (await history(page)).conn.some((c) => c.status === 'online' && c.at >= answerAt - 1000),
          { timeout: WAIT, message: 'the gateway is online again' }).toBe(true);
      }
      await sleep(5000);
      // compat: carol's relay went with the API; she is back and heard within 90 s, and the checks below leave her out.
      const exempt = (p: Peer) => COMPAT && p.name === 'carol';
      if (COMPAT) await allHear(90_000);
      for (const page of pages) await connected(page);
      const gaps: Record<string, Record<string, number>> = {};
      for (const p of peers) {
        const t = await frameTimes(p.person.page);
        expect(t, `${p.name}'s media worker answers`).not.toBeNull();
        gaps[p.name] = {};
        for (const q of others(p)) {
          gaps[p.name][q.name] = t!.maxGap[q.device] ?? Number.NaN;
          if (exempt(p) || exempt(q)) continue;
          expect(t!.maxGap[q.device], `${p.name} hears ${q.name} with no gap over 1 s`).toBeLessThanOrEqual(1000);
        }
      }
      timings.B1 = { apiDownMs: answerAt - stopAt, maxGapMs: gaps };
      for (const [i, page] of pages.entries()) {
        if (exempt(peers[i])) continue;
        const calls = (await history(page)).calls.slice(marks[i]);
        expect(calls.map((c) => c.phase), `${peers[i].name}: the phase never reaches removed`).not.toContain('removed');
        if (!COMPAT) expect((await callSlice(page))?.epoch, `${peers[i].name}: no new MLS epoch`).toBe(epochs[i]);
      }
      if (!COMPAT) expect(groupRows(DB, voice).epoch, 'no new MLS epoch at the instance').toBe(before.epoch);
      const kept = (list: { identity: string; sid: string }[] | null) => (list ?? [])
        .filter((x) => !COMPAT || !x.identity.startsWith(peers[2].device)).sort((a, b) => a.identity.localeCompare(b.identity));
      const sidsAfter = await sfuParticipants(SFU_PORT, media.sidecar.secretFile, before.room);
      expect(kept(sidsAfter), 'every LiveKit participant sid is unchanged').toEqual(kept(sids));
      expect(kept(sids).length, 'the sids compared').toBe(COMPAT ? 2 : 3);
      await carolRelayed('B1');
      tolerate(lines, 'B1');
    });

    if (COMPAT) return;

    await test.step('B2: the API restarts with a new build; every page reloads and is back within 5 s of its pagehide', async () => {
      const swapped = swapWebRoot(resolve(REPO_ROOT, DIST), `/tmp/dw/web-up9-${String(PORT)}`);
      const lines = guard.consoleErrors.length;
      const reqFrom = peers.map((p) => p.requests.length);
      const loads = pages.map((page) => page.waitForEvent('load', { timeout: 90_000 }));
      await host.stop();
      root = swapped;
      host = await startTestHost(cfg(root));
      useHost(host);
      await Promise.all(loads);
      for (const page of pages) await connected(page);
      const hide = await Promise.all(pages.map((page) => pagehideAt(page)));
      const published = await Promise.all(pages.map((page) => publishedAt(page)));
      const own: Record<string, number> = {};
      for (const [i, p] of peers.entries()) {
        expect(Number.isFinite(hide[i]) && Number.isFinite(published[i]), `${p.name}: pagehide and published are both marked`).toBe(true);
        own[p.name] = Math.round(published[i] - hide[i]);
        expect(own[p.name], `${p.name}: microphone published again within 5 s of its pagehide`).toBeLessThanOrEqual(5000);
      }
      // The others' inbound frames from each resuming: the first rise of its frames after its pagehide, at each listener.
      const heardBack: Record<string, Record<string, number>> = {};
      for (const [i, p] of peers.entries()) {
        heardBack[p.name] = {};
        for (const q of others(p)) {
          let at = Number.NaN;
          await expect.poll(async () => {
            const t = await frameTimes(q.person.page);
            at = (t?.resumes[p.device] ?? []).find((x) => x > hide[i]) ?? Number.NaN;
            return Number.isFinite(at);
          }, { timeout: WAIT, message: `${q.name} hears ${p.name} again` }).toBe(true);
          heardBack[p.name][q.name] = Math.round(at - hide[i]);
          expect(heardBack[p.name][q.name], `${q.name} hears ${p.name} again within 5 s of ${p.name}'s pagehide`).toBeLessThanOrEqual(5000);
        }
      }
      const joins = await Promise.all(pages.map(async (page) => (await history(page)).joins.at(-1)?.resumed ?? null));
      const external = peers.map((p, i) => p.requests.slice(reqFrom[i]).filter((r) => r.method === 'POST' && /^\/v1\/groups\/[0-9a-f]{32}\/resync$/.test(r.path)).length);
      const startsB2 = peers.map((p, i) => p.requests.slice(reqFrom[i]).filter((r) => r.method === 'POST' && r.path === `/v1/channels/${voice}/calls` && r.status >= 200 && r.status < 300).length);
      for (const [i, p] of peers.entries()) {
        expect(p.requests.slice(reqFrom[i]).filter((r) => r.method === 'POST' && r.path === '/v1/groups'), `${p.name}: no new call group`).toEqual([]);
        // UP7b fix round 1 (I3): exactly one call start per page for its one resume.
        expect(startsB2[i], `${p.name}: back through exactly one start`).toBe(1);
      }
      // UP6c: each resume commits a fresh epoch (an own-leaf Update) before it publishes.
      const commitsB2 = peers.map((p, i) => p.requests.slice(reqFrom[i]).filter((r) => r.method === 'POST' && /\/commit$/.test(r.path)).map((r) => r.status));
      timings.B2 = { publishedMs: own, heardBackMs: heardBack, resumed: Object.fromEntries(peers.map((p, i) => [p.name, joins[i]])),
        externalJoins: Object.fromEntries(peers.map((p, i) => [p.name, external[i]])),
        commits: Object.fromEntries(peers.map((p, i) => [p.name, commitsB2[i]])) };
      await allHear();
      timings['B2.replay'] = Object.fromEntries((await replays()).map((r, i) => [peers[i].name, r.replay]));
      await carolRelayed('B2');
      tolerate(lines, 'B2');
    });

    await test.step('A2: everyone dropped at once, nobody left to commit; the sweep removes all three; they come back', async () => {
      const lines = guard.consoleErrors.length;
      const before = groupRows(DB, voice);
      const callsFrom = await Promise.all(pages.map(async (page) => (await history(page)).calls.length));
      const joinsFrom = await Promise.all(pages.map(async (page) => (await history(page)).joins.length));
      const reqFrom = peers.map((p) => p.requests.length);
      const replayFrom = await replays();
      const stopAt = Date.now();
      await host.stop();
      // The clients cannot reach the instance: their LiveKit sessions give up (the reconnect policy's 90 s), the pages hold
      // the call, and the SFU lets them go. Nobody stays in the room to commit anything.
      await expect.poll(async () => (await sfuParticipants(SFU_PORT, media.sidecar.secretFile, before.room))?.length ?? -1,
        { timeout: 240_000, intervals: [2000], message: 'all three leave the SFU room, which stays (departure timeout)' }).toBe(0);
      const droppedAt = Date.now();
      // The API restarts and runs while the clients still cannot reach it.
      host = await startTestHost(cfg(root, true));
      useHost(host);
      // Its real room sweep, twice, the instance clock past the sweep period between: the first sees the three out of the
      // room, the second proposes their absence Removes (api.Calls.flushLeafRemovals; withdrawable).
      await postControl(host.control, '/debug/sfu/sweep');
      await postControl(host.control, '/debug/clock', { seconds: 31 });
      await postControl(host.control, '/debug/sfu/sweep');
      const swept = groupRows(DB, voice);
      expect(swept.removes.filter((r) => !r.withdrawn && !r.void).map((r) => r.device).sort(), 'the sweep proposed the Remove of all three')
        .toEqual(peers.map((p) => p.device).sort());
      expect(swept.epoch, 'nobody committed them').toBe(before.epoch);
      const kind3Before = swept.withdrawnRows;
      // The page clocks jump 10 min ahead while the call is lost; the AFK timeout is 60 s. And the hourly rotation is armed
      // 20 s after each join from here on, so that a call_rotate after all three are back is seen.
      for (const page of pages) { await movePageClock(page, 600_000); await shortenRotation(page, 20_000); }
      const openAt = Date.now();
      await host.open();
      const answerAt = Date.now();
      // Every page back in the call: its LiveKit session connected again after the answer (the call phase is `in`).
      const back: number[] = [];
      const online: number[] = [];
      await Promise.all(pages.map(async (page, i) => {
        try {
          await expect.poll(async () => (await history(page)).dock.some((d) => d.phase === 'connected' && d.at >= openAt),
            { timeout: 90_000, intervals: [250], message: `${peers[i].name}'s session is connected again` }).toBe(true);
        } catch (e) {
          const h = await history(page).catch(() => null);
          timings[`A2.${peers[i].name}.stuck`] = {
            calls: h?.calls.slice(callsFrom[i]).map((c) => [Math.round(c.at - openAt), c.phase, c.code, c.error, c.rejoining]),
            dock: h?.dock.slice(-6).map((d) => [Math.round(d.at - openAt), d.phase]), joins: h?.joins.map((j) => [Math.round(j.at - openAt), j.resumed]),
            requests: peers[i].requests.filter((r) => r.at >= openAt - 1000 && !/device-list|messages|handshakes|presence|roles|overwrites|permissions|members|gifs/.test(r.path))
              .slice(0, 40).map((r) => [Math.round(r.at - openAt), r.method, r.path.replace(/[0-9a-f]{32}/g, '…'), r.status]),
          };
          throw e;
        }
        await connected(page);
        const h = await history(page);
        back[i] = h.dock.find((d) => d.phase === 'connected' && d.at >= openAt)?.at ?? Number.NaN;
        online[i] = h.conn.find((c) => c.status === 'online' && c.at >= openAt)?.at ?? Number.NaN;
        // The page's call phases since the drop, ms from the answer (the hold reads `removed` with E_DISCONNECTED).
        timings[`A2.${peers[i].name}.phases`] = h.calls.slice(callsFrom[i]).map((c) => [Math.round(c.at - answerAt), c.phase]);
      }));
      const allBackAt = Math.max(...back);
      const order = back.map((t, i) => [t, i] as const).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
      // When each gateway was online again (null: not yet when the page was back, the recovery's own backoff came first).
      const gatewayBack = peers.map((_, i) => (Number.isFinite(online[i]) ? Math.round(online[i] - answerAt) : null));
      const sinceAnswer = peers.map((_, i) => Math.round(back[i] - answerAt));
      // The first one back resumes within 5 s: from its join (phase joining) to its session connected, with no wait on a
      // standing Remove (the original bug: a join that waited REJOIN_WAIT_MS on E_REMOVE_PENDING and gave up). When it
      // starts that join after the instance answers is its gateway's probe (UP7b, about 2 s) and the page's immediate
      // attempt once online (R-UP8): the first is bounded by 5 s from the answer below, every device by 30 s.
      const first = order[0];
      const joiningAt = (await history(pages[first])).calls.slice(callsFrom[first]).find((c) => c.phase === 'joining')?.at ?? Number.NaN;
      const resumeMs = Math.round(back[first] - joiningAt);
      timings['A2.firstResumeMs'] = resumeMs;
      expect(resumeMs, `the first back (${peers[first].name}) resumes within 5 s of starting its join`).toBeLessThanOrEqual(5000);
      // UP7b (R-UP8): the gateway probes an unreachable instance about every 2 s and reconnects on its first answer, and the
      // page's recovery attempts at once when the gateway is online: the first device is back within 5 s of the answer.
      timings['A2.firstBackSinceAnswerMs'] = sinceAnswer[first];
      expect(sinceAnswer[first], `the first back (${peers[first].name}) is back within 5 s of the API answering`).toBeLessThanOrEqual(5000);
      for (const i of order) expect(sinceAnswer[i], `${peers[i].name} is back within 30 s of the instance answering`).toBeLessThanOrEqual(30_000);
      expect(Math.max(...sinceAnswer), 'all three are back within 90 s of the API answering').toBeLessThanOrEqual(90_000);
      await allHear();
      // Nobody waited on a standing Remove; the call group stayed (no new group); the resumers each withdrew their own.
      const joined = await Promise.all(pages.map(async (page, i) => (await history(page)).joins.slice(joinsFrom[i])));
      const resumers = joined.filter((j) => j.some((x) => x.resumed)).length;
      for (const [i, p] of peers.entries()) {
        const calls = (await history(pages[i])).calls.slice(callsFrom[i]);
        expect(calls.filter((c) => c.code === 'E_REMOVE_PENDING' || c.error === 'E_REMOVE_PENDING' || c.rejoining), `${p.name}: no E_REMOVE_PENDING`).toEqual([]);
        expect(p.requests.slice(reqFrom[i]).filter((r) => r.method === 'POST' && r.path === '/v1/groups'), `${p.name}: no new call group`).toEqual([]);
        // UP7b fix round 1 (I3): exactly one call start per page for its one resume; a double start fails here.
        expect(p.requests.slice(reqFrom[i]).filter((r) => r.method === 'POST' && r.path === `/v1/channels/${voice}/calls` && r.status >= 200 && r.status < 300).length,
          `${p.name}: back through exactly one start`).toBe(1);
        expect(p.requests.slice(reqFrom[i]).filter((r) => r.method === 'PUT' && /\/afk\/away$/.test(r.path)), `${p.name}: no leftAway`).toEqual([]);
      }
      const settled = groupRows(DB, voice);
      expect(resumers, 'at least the first device back resumed').toBeGreaterThan(0);
      expect(settled.withdrawnRows - kind3Before, 'one kind-3 (withdrawn) row per resumer').toBe(resumers);
      expect(settled.group, 'the same call group').toBe(before.group);
      // A call_rotate after all three are back: a commit from one of them lands, every page keys the new epoch, all still heard.
      const epochAtBack = settled.epoch;
      expect(settled.outstanding, 'nothing outstanding blocks a commit once all three are back').toBe(0);
      await expect.poll(() => groupRows(DB, voice).epoch, { timeout: 90_000, message: 'a call_rotate lands after all three are back' }).toBeGreaterThan(epochAtBack);
      const rotated = peers.flatMap((p) => p.requests.filter((r) => r.at >= allBackAt && r.method === 'POST' && /\/commit$/.test(r.path) && r.status >= 200 && r.status < 300).map(() => p.name));
      expect(rotated.length, 'the rotation is a commit of one of the three').toBeGreaterThan(0);
      const epochNow = groupRows(DB, voice).epoch;
      for (const page of pages) await expect.poll(async () => Number((await callSlice(page))?.epoch ?? -1), { timeout: WAIT }).toBeGreaterThanOrEqual(epochNow);
      await allHear();
      // UP6c (protocol/05 N1): no listener refused a frame as a replay since the drop. The resumer sealed in a fresh epoch
      // of its own commit, never from seq 0 again under the held epoch's KID. A worker that lived through the drop is
      // read as a difference from its count before it.
      const replayAfter = await replays();
      const replayA2 = Object.fromEntries(replayAfter.map((r, i) => {
        const same = r.worker !== null && r.worker === replayFrom[i].worker;
        return [peers[i].name, { replay: r.replay === null ? null : r.replay - (same ? replayFrom[i].replay ?? 0 : 0), sameWorker: same }];
      }));
      timings['A2.replay'] = replayA2;
      for (const p of peers) expect(replayA2[p.name].replay, `${p.name}: no frame refused as a replay since the drop`).toBe(0);
      const resumeCommits = peers.map((p, i) => p.requests.slice(reqFrom[i]).filter((r) => r.method === 'POST' && /\/commit$/.test(r.path) && r.at < allBackAt).map((r) => r.status));
      timings['A2.resumeCommits'] = Object.fromEntries(peers.map((p, i) => [p.name, resumeCommits[i]]));
      // The first back's group requests in order (ms from the answer): which of its commits is the engine's elected one
      // (after a GET proposals) and which the resume's own (after its start).
      timings['A2.firstBackTrace'] = peers[first].requests.slice(reqFrom[first])
        .filter((r) => r.at <= allBackAt && (/\/v1\/groups\/[0-9a-f]{32}\/(commit|proposals)$/.test(r.path) || r.path === `/v1/channels/${voice}/calls`))
        .map((r) => [Math.round(r.at - answerAt), r.method, r.path.replace(/[0-9a-f]{32}/g, '…'), r.status]);
      await carolRelayed('A2');
      timings.A2 = {
        apiDownToClientsMs: answerAt - stopAt, droppedAfterMs: droppedAt - stopAt, openMs: answerAt - openAt,
        order: order.map((i) => peers[i].name),
        gatewayOnlineSinceAnswerMs: Object.fromEntries(peers.map((p, i) => [p.name, gatewayBack[i]])),
        backSinceAnswerMs: Object.fromEntries(peers.map((p, i) => [p.name, sinceAnswer[i]])),
        resumed: Object.fromEntries(peers.map((p, i) => [p.name, joined[i].map((j) => j.resumed)])),
        kind3: settled.withdrawnRows - kind3Before, rotatedBy: rotated,
        starts: Object.fromEntries(peers.map((p, i) => [p.name, p.requests.slice(reqFrom[i]).filter((r) => r.method === 'POST' && r.path === `/v1/channels/${voice}/calls`).map((r) => r.status)])),
      };
      tolerate(lines, 'A2');
    });

    await test.step('A: the API stops, the SFU restarts, the API starts with a new build; all back within 90 s', async () => {
      const lines = guard.consoleErrors.length;
      const reqFromA = peers.map((p) => p.requests.length);
      // When each page's reload (the new build) loaded: its starts before are the old page's, after it the new page's.
      const loadAt: number[] = peers.map(() => Number.NaN);
      const loads = pages.map((page, i) => page.waitForEvent('load', { timeout: 120_000 }).then(() => { loadAt[i] = Date.now(); }));
      await host.stop();
      await media.restartMedia();
      root = DIST;
      host = await startTestHost(cfg(root));
      useHost(host);
      const answerAt = Date.now();
      await Promise.all(loads);
      for (const page of pages) await connected(page);
      await allHear(90_000);
      const allAt = Date.now();
      expect(allAt - answerAt, 'all three connected and heard within 90 s of the API answering').toBeLessThanOrEqual(90_000);
      await carolRelayed('A');
      // UP7b fix round 2 (N1): the call starts per page here too, where the tolerated leave lines appear. Case A has two
      // page lives: the old page sees its room lost and the API back, and may start once (its recovery) before the new
      // build's update reload holds that call; the reloaded page then starts exactly once. A double start in either life
      // fails here. The step's own console lines are tolerated first, so a failure here names the starts, not the lines.
      tolerate(lines, 'A');
      const startsA = peers.map((p, i) => p.requests.slice(reqFromA[i]).filter((r) => r.method === 'POST' && r.path === `/v1/channels/${voice}/calls`)
        .map((r) => ({ life: r.at < loadAt[i] ? 'old' : 'new', status: r.status })));
      timings.A = { allBackAndHeardMs: allAt - answerAt,
        starts: Object.fromEntries(peers.map((p, i) => [p.name, startsA[i].map((x) => `${x.life}:${String(x.status)}`)])) };
      for (const [i, p] of peers.entries()) {
        const ok = (life: string) => startsA[i].filter((x) => x.life === life && x.status >= 200 && x.status < 300).length;
        expect(ok('new'), `${p.name}: the reloaded page is back through exactly one start`).toBe(1);
        expect(ok('old'), `${p.name}: the old page started at most once before its reload`).toBeLessThanOrEqual(1);
      }
    });
  } finally {
    // eslint-disable-next-line no-console -- the measured timings are the point of this spec (UP9 report)
    console.log(`UP9 timings ${JSON.stringify(timings)}`);
    for (const p of [...peers].reverse()) await peerBrowser.close(p.person);
    await ownBrowser?.close();
    await peer?.close();
    await host.stop();
    await media.stop();
    removeHostData(PORT);
    for (const [k, v] of [['DILLA_TEST_HOST', env.host], ['DILLA_TESTKIT_CONTROL', env.control], ['DILLA_TESTKIT_INVITE', env.invite]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

// AW5 (AFK means disconnected): the shell's side of the AFK channel. Nobody joins a call there any more (R-AW1). Choosing
// AFK leaves the current call through the normal leave and then marks the person away (R-AW3); the sweep's cut says
// `afk.moved` and starts nothing (R-AW6); a restore or a recovery never rejoins a community the person is away in (R-AW7).
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { AFKState, ChannelSummary } from '@dilla/client-core';
import type { PageCallOptions } from '../../call/session.ts';
import { t } from '../../strings/index.ts';
import { A, CHANNELS, FakeClient, FakeSession, GENV, callState } from '../../test/fake-client.ts';
import { account, ME } from '../../test/fixtures.ts';
import { AFK_READ_WAIT_MS, REMOVED_HOLD_MS, RESTORE_WAIT_MS, useCall, VoiceDepsContext, type UseCallOptions, type VoiceDeps, type VoiceModule } from './useCall.tsx';

const AFK_CH = 'af'.repeat(16);
const B = 'b7'.repeat(16);
const B_GEN = 'b8'.repeat(16);
const B_AFK = 'bf'.repeat(16);
const DM_ID = '9d'.repeat(16);
const AFK_SET: ReadonlySet<string> = new Set([AFK_CH, B_AFK]);
const MOVED = t('afk.moved', { channel: 'AFK' });
const voice = (id: string, communityId: string, name: string, position = 1): ChannelSummary => ({
  id, communityId, kind: 1, mode: 0, name, topic: '', parentId: null, position, slowmode: 0, announcement: false, group: 'unsupported' });
const afkOf = (channelId: string | null, over: Partial<AFKState> = {}): AFKState => ({ channelId, timeoutSeconds: 300, pending: false, seq: 1, away: [], ...over });
const nowSec = () => Math.floor(Date.now() / 1000);

/** As the real session: a leave stops the microphone's track. */
class Session extends FakeSession {
  readonly mic = { readyState: 'live' as 'live' | 'ended' };
  constructor(log: string[], bridge: FakeClient) {
    super(log, bridge);
    const leave = this.leave.getMockImplementation();
    this.leave.mockImplementation((reason) => { this.mic.readyState = 'ended'; return leave!(reason); });
  }
}

/** A removal's notice waits up to REMOVED_HOLD_MS for the read that says the sweep cut it. */
const HELD = { timeout: REMOVED_HOLD_MS + 1_500 };
const flush = async () => { await act(async () => { for (let i = 0; i < 10; i++) await new Promise<void>((r) => setTimeout(r, 0)); }); };
const wait = async (ms: number) => { await act(async () => { await new Promise<void>((r) => setTimeout(r, ms)); }); };

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/** The slices of a loaded shell: the servers, their channels and their afk: snapshots. */
function loadSlices(client: FakeClient): void {
  client.set('communities', [{ id: A, name: 'Midgard', owner: 'ee'.repeat(16) }, { id: B, name: 'Asgard', owner: 'ee'.repeat(16) }]);
  client.set('dms', []);
  client.set(`channels:${A}`, [...CHANNELS, voice(AFK_CH, A, 'AFK', 1 << 30)]);
  client.set(`channels:${B}`, [voice(B_GEN, B, 'hall'), voice(B_AFK, B, 'AFK', 1 << 30)]);
  client.set(`afk:${A}`, afkOf(AFK_CH));
  client.set(`afk:${B}`, afkOf(B_AFK));
}

/** `lagging`: nothing of the servers is loaded yet, as right after an update reload. */
function harness(o: { lagging?: boolean; recoverEnded?: (id: string) => boolean } = {}) {
  const client = new FakeClient();
  client.set('account', account());
  client.set('settings', {});
  if (o.lagging !== true) loadSlices(client);
  client.set('call', callState());
  /** The rows focus went back to after a leave (onLeft). */
  const lefts: string[] = [];
  const log: string[] = [];
  const sessions: Session[] = [];
  const started: { channelId: string; opts: PageCallOptions }[] = [];
  /** UP7: what the worker's callJoin answers about a held group (a resume's gate reads it). */
  const answer = { resumed: true, expired: false };
  /** UP7: the next starts fail with these, in order (a 503 with retry_after_ms, an unreachable instance). */
  const failures: Error[] = [];
  const module: VoiceModule = {
    isVoiceSupported: () => ({ ok: true as const, path: 'insertable-streams' as const }),
    localDecodeList: () => 'vp8',
    browserDeps: (bridge) => ({ bridge } as unknown as ReturnType<VoiceModule['browserDeps']>),
    startPageCall: vi.fn<VoiceModule['startPageCall']>(async (_deps, target, opts) => {
      started.push({ channelId: target.channelId, opts });
      await Promise.resolve();
      const failure = failures.shift();
      if (failure !== undefined) throw failure;
      // As the real session: a resume's gate runs after callJoin answered and before the connect; a refusal leaves.
      if (opts.resume !== undefined) {
        try {
          await opts.resume.gate({ ...answer });
        } catch (e) {
          await client.call({ m: 'callLeave', reason: 'user' });
          throw e;
        }
      }
      const s = new Session(log, client);
      s.channelId = target.channelId;
      sessions.push(s);
      // As the worker: phase 'in' is published before callJoin answers (L-TS-56 step 1).
      client.set('call', callState({ phase: 'in', channelId: target.channelId, callId: target.channelId }));
      return s;
    }),
    bindPushToTalk: () => () => undefined,
    volumesFromSettings: () => ({}), streamVolumesFromSettings: () => ({}),
  };
  const deps: VoiceDeps = {
    load: () => Promise.resolve(module),
    createCallContext: () => null,
    createSounds: () => ({ play: () => undefined, startRing: () => undefined, stopRing: () => undefined, dispose: () => undefined }),
  };
  const wrapper = ({ children }: { children: ReactNode }) => createElement(VoiceDepsContext.Provider, { value: deps }, children);
  const said: string[] = [];
  const view = renderHook((p: { afk: NonNullable<UseCallOptions['afk']> }) => {
    const v = useCall({
      client, call: client.get('call'), settings: client.get('settings') ?? {},
      whereOf: (id) => (id === AFK_CH || id === B_AFK ? 'AFK' : 'general'), onLeft: (id) => { lefts.push(id); }, stageShown: () => false,
      afk: p.afk, ...(o.recoverEnded !== undefined ? { recoverEnded: o.recoverEnded } : {}),
    });
    if (said.at(-1) !== v.announcement) said.push(v.announcement);
    return v;
  }, { wrapper, initialProps: { afk: { channels: AFK_SET } } });
  /** Joins `id` by the person's press and waits until its session is attached. */
  const joined = async (id: string) => {
    const n = sessions.length;
    act(() => view.result.current.join(id));
    await waitFor(() => expect(sessions).toHaveLength(n + 1));
    await waitFor(() => expect(view.result.current.session).toBe(sessions[n]));
    return sessions[n];
  };
  /** A worker push of community `cid`'s afk: slice. */
  const setAfk = (cid: string, over: Partial<AFKState>) => {
    act(() => { client.set(`afk:${cid}`, { ...(client.get(`afk:${cid}`) ?? afkOf(null)), ...over }); });
  };
  const awayMe = (cid: string, since = nowSec()) => setAfk(cid, { away: [{ userId: ME.id, since }] });
  /** The worker's call slice says removed; the hook reads it on its next render, as the shell's re-render brings it. */
  const cut = () => {
    act(() => { client.set('call', callState({ phase: 'removed', channelId: GENV, callId: GENV })); });
    act(() => view.rerender({ afk: { channels: AFK_SET } }));
  };
  return { client, log, sessions, started, module, view, said, joined, setAfk, awayMe, cut, lefts, answer, failures,
    get v() { return view.result.current; } };
}

describe('AW5: the AFK channel never hosts a call (R-AW1)', () => {
  it('a press on the AFK channel starts no call and asks for no microphone; it marks the person away', async () => {
    const h = harness();
    act(() => h.v.join(AFK_CH));
    await waitFor(() => expect(h.client.callsOf('afkAway')).toEqual([{ m: 'afkAway', communityId: A }]));
    await flush();
    expect(h.started).toEqual([]);
    expect(h.v.channelId).toBeNull();
    expect(h.v.session).toBeNull();
    expect(h.client.callsOf('callLeave')).toEqual([]);
  });

  it('clicking AFK in a call: the leave is posted before afkAway, the microphone track has ended and the dock is gone', async () => {
    const h = harness();
    const general = await h.joined(GENV);
    expect(general.mic.readyState).toBe('live');
    act(() => h.v.join(AFK_CH));
    await waitFor(() => expect(h.client.callsOf('afkAway')).toHaveLength(1));
    const order = h.client.calls.map((c) => c.m).filter((m) => m === 'callLeave' || m === 'afkAway');
    expect(order).toEqual(['callLeave', 'afkAway']);
    expect(general.leave).toHaveBeenCalledWith('user');
    expect(general.mic.readyState).toBe('ended');
    expect(h.v.channelId).toBeNull();
    expect(h.v.session).toBeNull();
    expect(h.started.map((s) => s.channelId)).toEqual([GENV]);
  });

  it('afkAway waits for a leave that is slow to answer', async () => {
    const h = harness();
    const general = await h.joined(GENV);
    let release: () => void = () => undefined;
    general.leaveGate = new Promise<void>((r) => { release = r; });
    act(() => h.v.join(AFK_CH));
    await flush();
    expect(h.client.callsOf('afkAway')).toEqual([]);
    release();
    await waitFor(() => expect(h.client.callsOf('afkAway')).toHaveLength(1));
    expect(h.client.calls.map((c) => c.m).filter((m) => m === 'callLeave' || m === 'afkAway')).toEqual(['callLeave', 'afkAway']);
  });

  it('a click while already away does nothing', async () => {
    const h = harness();
    h.awayMe(A);
    act(() => h.v.join(AFK_CH));
    await flush();
    expect(h.client.callsOf('afkAway')).toEqual([]);
    expect(h.started).toEqual([]);
    // Control: away in another community is not away here.
    act(() => h.v.join(B_AFK));
    await waitFor(() => expect(h.client.callsOf('afkAway')).toEqual([{ m: 'afkAway', communityId: B }]));
  });

  it('the AFK channel known only from the afk: slice is still never joined', async () => {
    const h = harness();
    act(() => h.view.rerender({ afk: { channels: new Set<string>() } }));
    act(() => h.v.join(B_AFK));
    await waitFor(() => expect(h.client.callsOf('afkAway')).toEqual([{ m: 'afkAway', communityId: B }]));
    expect(h.started).toEqual([]);
  });

  it('joining another channel while away is a normal join with the microphone', async () => {
    const h = harness();
    h.awayMe(A);
    await h.joined(GENV);
    expect(h.started.map((s) => s.channelId)).toEqual([GENV]);
    expect(h.client.callsOf('afkAway')).toEqual([]);
  });
});

describe('AW5: the sweep’s cut says afk.moved and starts nothing (R-AW6)', () => {
  it('after the sweep’s cut: no rejoin, no recovery, afk.moved is said and the dock is gone', async () => {
    const h = harness();
    const general = await h.joined(GENV);
    h.setAfk(A, { pending: true, seq: 2 });
    h.cut();
    await waitFor(() => expect(general.leave).toHaveBeenCalledWith('removed'));
    await waitFor(() => expect(h.v.lasting).toBe(MOVED));
    expect(h.v.notice).toEqual({ channelId: GENV, key: 'afk.moved', text: MOVED });
    expect(h.v.channelId).toBeNull();
    expect(h.v.session).toBeNull();
    // Past the recovery's first retry: nothing joins, nothing recovers.
    await wait(1_500);
    expect(h.started.map((s) => s.channelId)).toEqual([GENV]);
    expect(h.v.recoveryChannelId).toBeNull();
    expect(h.said).not.toContain(t('voice.removed'));
    expect(h.v.lasting).toBe(MOVED);
  });

  it('the room’s own removal with pending set says afk.moved too', async () => {
    const h = harness();
    const general = await h.joined(GENV);
    h.setAfk(A, { pending: true, seq: 2 });
    act(() => general.update({ phase: 'ended', error: 'E_REMOVED' }));
    expect(h.v.session).toBeNull();
    await waitFor(() => expect(h.v.notice).toEqual({ channelId: GENV, key: 'afk.moved', text: MOVED }));
    await wait(1_200);
    expect(h.started).toHaveLength(1);
    expect(h.v.recoveryChannelId).toBeNull();
  });

  it('pending that lands within the hold after the cut says only afk.moved', async () => {
    const h = harness();
    await h.joined(GENV);
    h.cut();
    await flush();
    expect(h.v.notice).toBeNull();
    expect(h.v.lasting).toBe('');
    h.setAfk(A, { pending: true, seq: 2 });
    await waitFor(() => expect(h.v.lasting).toBe(MOVED));
    await wait(REMOVED_HOLD_MS + 300);
    expect(h.v.notice).toEqual({ channelId: GENV, key: 'afk.moved', text: MOVED });
    expect(h.v.lasting).toBe(MOVED);
    expect(h.started).toHaveLength(1);
  });

  it('a cut with no pending read says removed once the hold ends (control)', async () => {
    const h = harness();
    await h.joined(GENV);
    h.cut();
    await waitFor(() => expect(h.v.notice).toEqual({ channelId: GENV, key: 'voice.removed' }), HELD);
    expect(h.v.lasting).toBe(t('voice.removed'));
  });

  it('a pending read the call started under is stale: a later removal says removed', async () => {
    const h = harness();
    // An earlier sweep's read still says pending (the server cleared it at this admission, the slice was not re-read).
    h.setAfk(A, { pending: true, seq: 2 });
    await h.joined(GENV);
    h.cut();
    await waitFor(() => expect(h.v.notice).toEqual({ channelId: GENV, key: 'voice.removed' }), HELD);
    // Control: a new read that says pending (a new seq) during the call is the sweep's.
    const g = harness();
    g.setAfk(A, { pending: true, seq: 2 });
    await g.joined(GENV);
    g.setAfk(A, { pending: true, seq: 3 });
    g.cut();
    await waitFor(() => expect(g.v.notice).toEqual({ channelId: GENV, key: 'afk.moved', text: MOVED }));
  });

  /** As the instance answers a fresh read after a cut: this device's pending reason, in every community (device-scoped). */
  const reasonOnRead = (h: ReturnType<typeof harness>, reason: 1 | 2, delayMs = 0) => {
    const base = h.client.handler;
    let reads = 0;
    h.client.handler = (c) => {
      if (c.m !== 'afkRead') return base(c);
      reads += 1;
      return new Promise((resolve) => setTimeout(() => {
        act(() => {
          for (const [cid, afkId] of [[A, AFK_CH], [B, B_AFK]] as const) {
            h.client.set(`afk:${cid}`, { ...(h.client.get(`afk:${cid}`) ?? afkOf(afkId)), pending: true, pendingReason: reason, seq: 50 + reads });
          }
        });
        resolve(null);
      }, delayMs));
    };
    return { get reads() { return reads; } };
  };

  it('M2, round 3: a second tab chooses AFK; the cut’s read says reason 2, so this tab says afk.elsewhere, never removed', async () => {
    const h = harness();
    await h.joined(GENV);
    const reads = reasonOnRead(h, 2, 300);
    h.cut();
    await flush();
    expect(h.v.notice).toBeNull();
    await waitFor(() => expect(h.v.notice).toEqual({ channelId: GENV, key: 'afk.elsewhere' }));
    expect(reads.reads).toBeGreaterThan(0);
    expect(h.v.lasting).toBe(t('afk.elsewhere'));
    await wait(REMOVED_HOLD_MS + 300);
    expect(h.said).not.toContain(t('voice.removed'));
    expect(h.started).toHaveLength(1);
    expect(h.v.recoveryChannelId).toBeNull();
  });

  it('round 3 (B2-M3): a cut in community Y after AFK was chosen in X says afk.elsewhere, with no recovery', async () => {
    const h = harness();
    await h.joined(B_GEN);
    // AFK was chosen in A: only A lists the person away; B's read gives the device-scoped reason 2.
    h.awayMe(A);
    reasonOnRead(h, 2);
    act(() => h.sessions[0].update({ phase: 'ended', error: 'E_REMOVED' }));
    await waitFor(() => expect(h.v.notice).toEqual({ channelId: B_GEN, key: 'afk.elsewhere' }));
    expect(h.v.recoveryChannelId).toBeNull();
    await wait(1_200);
    expect(h.started).toHaveLength(1);
  });

  it('round 3 (B2-M3): a DM call cut by AFK chosen elsewhere says afk.elsewhere, read through a listed community', async () => {
    const h = harness();
    act(() => { h.client.set('dms', [{ id: DM_ID, kind: 3, members: [ME.id], name: 'bob', group: 'active' }]); });
    await h.joined(DM_ID);
    reasonOnRead(h, 2);
    act(() => h.sessions[0].update({ phase: 'ended', error: 'E_REMOVED' }));
    await waitFor(() => expect(h.v.notice).toEqual({ channelId: DM_ID, key: 'afk.elsewhere' }));
    expect(h.client.callsOf('afkRead')[0]).toMatchObject({ communityId: A });
    expect(h.v.recoveryChannelId).toBeNull();
  });

  it('round 3 (B2-M2): a DM call lost while AFK was chosen elsewhere is not recovered', async () => {
    const h = harness();
    act(() => { h.client.set('dms', [{ id: DM_ID, kind: 3, members: [ME.id], name: 'bob', group: 'active' }]); });
    await h.joined(DM_ID);
    reasonOnRead(h, 2);
    act(() => h.sessions[0].update({ phase: 'ended', error: 'E_DISCONNECTED' }));
    expect(h.v.recoveryChannelId).toBe(DM_ID);
    await waitFor(() => expect(h.v.recoveryChannelId).toBeNull(), { timeout: 3_000 });
    expect(h.v.notice).toEqual({ channelId: DM_ID, key: 'afk.elsewhere' });
    expect(h.started).toHaveLength(1);
  });

  it('round 3b: the moved line names the AFK channel of the cut call’s own community, not the first listed one', async () => {
    const h = harness();
    // Two communities, both reporting this device's pending (device-scoped); B's AFK channel has its own name.
    act(() => { h.client.set(`channels:${B}`, [voice(B_GEN, B, 'hall'), voice(B_AFK, B, 'Lounge', 1 << 30)]); });
    await h.joined(B_GEN);
    reasonOnRead(h, 1);
    act(() => h.sessions[0].update({ phase: 'ended', error: 'E_REMOVED' }));
    await waitFor(() => expect(h.v.notice).toEqual({ channelId: B_GEN, key: 'afk.moved', text: t('afk.moved', { channel: 'Lounge' }) }));
  });

  it('round 3b: a DM call’s moved line names the community whose away roster lists this user, as a fallback', async () => {
    const h = harness();
    act(() => { h.client.set(`channels:${B}`, [voice(B_GEN, B, 'hall'), voice(B_AFK, B, 'Lounge', 1 << 30)]); });
    act(() => { h.client.set('dms', [{ id: DM_ID, kind: 3, members: [ME.id], name: 'bob', group: 'active' }]); });
    await h.joined(DM_ID);
    h.awayMe(B);
    reasonOnRead(h, 1);
    act(() => h.sessions[0].update({ phase: 'ended', error: 'E_REMOVED' }));
    await waitFor(() => expect(h.v.notice).toEqual({ channelId: DM_ID, key: 'afk.moved', text: t('afk.moved', { channel: 'Lounge' }) }));
  });

  it('round 3: the sweep’s reason 1 says afk.moved, also when its away mark lands first', async () => {
    const h = harness();
    await h.joined(GENV);
    reasonOnRead(h, 1, 300);
    h.cut();
    h.awayMe(A);
    await waitFor(() => expect(h.v.notice).toEqual({ channelId: GENV, key: 'afk.moved', text: MOVED }));
    expect(h.said).not.toContain(t('afk.elsewhere'));
    expect(h.v.lasting).toBe(MOVED);
  });

  it('round 3 (B2-n1): an away mark with no reason and a failed read is not guessed: it says removed', async () => {
    const h = harness();
    await h.joined(GENV);
    const base = h.client.handler;
    h.client.handler = (c) => (c.m === 'afkRead' ? Promise.reject(Object.assign(new Error('E_UNAVAILABLE'), { code: 'E_UNAVAILABLE' })) : base(c));
    h.cut();
    h.awayMe(A);
    await waitFor(() => expect(h.v.notice).toEqual({ channelId: GENV, key: 'voice.removed' }), HELD);
    expect(h.said).not.toContain(t('afk.elsewhere'));
  });

  it('a pending reason the call started under is stale: a later removal says removed', async () => {
    const r = harness();
    r.setAfk(A, { pending: true, pendingReason: 2, seq: 4 });
    await r.joined(GENV);
    r.cut();
    await waitFor(() => expect(r.v.notice).toEqual({ channelId: GENV, key: 'voice.removed' }), HELD);
  });

  it('pending in another community does not make a cut the sweep’s', async () => {
    const h = harness();
    await h.joined(GENV);
    h.setAfk(B, { pending: true, seq: 2 });
    h.cut();
    await waitFor(() => expect(h.v.notice).toEqual({ channelId: GENV, key: 'voice.removed' }), HELD);
  });
});

describe('AW5: a restore or a recovery never rejoins where the person is away (R-AW7)', () => {
  it('recovery after sleep while away: no rejoin', async () => {
    const h = harness();
    const general = await h.joined(GENV);
    act(() => general.update({ phase: 'ended', error: 'E_DISCONNECTED' }));
    expect(h.v.recoveryChannelId).toBe(GENV);
    // While asleep the sweep cut this device and marked the person away, after the call started.
    h.awayMe(A, nowSec() + 5);
    await wait(1_500);
    expect(h.started).toHaveLength(1);
    expect(h.v.recoveryChannelId).toBeNull();
  });

  it('recovery with pending set for its community: no rejoin', async () => {
    const h = harness();
    const general = await h.joined(GENV);
    act(() => general.update({ phase: 'ended', error: 'E_DISCONNECTED' }));
    h.setAfk(A, { pending: true, seq: 2 });
    await wait(1_500);
    expect(h.started).toHaveLength(1);
    expect(h.v.recoveryChannelId).toBeNull();
  });

  it('recovery with the same away row the call started under still rejoins (control, M1)', async () => {
    const h = harness();
    // A row the slice still held at attach (its op 55 clear is late): the server's own since, unchanged, is not newer.
    h.awayMe(A, nowSec() - 3_600);
    const general = await h.joined(GENV);
    act(() => general.update({ phase: 'ended', error: 'E_DISCONNECTED' }));
    await waitFor(() => expect(h.started).toHaveLength(2), { timeout: 3_000 });
    expect(h.started[1].channelId).toBe(GENV);
  });

  it('fix round 1 (M1): an away row that appeared after attach blocks the recovery whatever the clocks say', async () => {
    const h = harness();
    const general = await h.joined(GENV);
    act(() => general.update({ phase: 'ended', error: 'E_DISCONNECTED' }));
    // The server's clock runs an hour behind this device's: its since is "before" the attach by the client clock.
    h.awayMe(A, nowSec() - 3_600);
    await wait(1_500);
    expect(h.started).toHaveLength(1);
    expect(h.v.recoveryChannelId).toBeNull();
    // Round 3: an away row is a guard, not a reason; with no pending reason the notice says the call was lost.
    expect(h.v.notice).toEqual({ channelId: GENV, key: 'voice.disconnected' });
  });

  it('reload while away: the restore starts no call', async () => {
    const h = harness();
    h.awayMe(A);
    act(() => h.v.restore(GENV, false, false));
    await wait(1_800);
    expect(h.started).toEqual([]);
    expect(h.v.channelId).toBeNull();
    expect(h.v.recoveryChannelId).toBeNull();
    // Control: a restore in another community joins.
    act(() => h.v.restore(B_GEN, false, false));
    await waitFor(() => expect(h.started.map((s) => s.channelId)).toEqual([B_GEN]), { timeout: 3_000 });
  });

  it('a restore of the AFK channel (a web3.9 call) starts nothing and marks nothing', async () => {
    const h = harness();
    act(() => h.v.restore(AFK_CH, false, false));
    // Final review N2: a known AFK channel arms no recovery, so no rejoining banner flashes before the first retry.
    expect(h.v.recoveryChannelId).toBeNull();
    await wait(1_800);
    expect(h.started).toEqual([]);
    expect(h.client.callsOf('afkAway')).toEqual([]);
    expect(h.v.recoveryChannelId).toBeNull();
  });
});


describe('AW5 fix round 1: fail closed, cancel and sequence', () => {
  it('I1: swept while asleep, the wake recovery waits for a fresh afk: read and, with pending, joins nothing and asks for no microphone', async () => {
    const h = harness();
    const general = await h.joined(GENV);
    // Asleep: the worker went offline (the slice is null); on waking LiveKit reports the dead connection.
    act(() => { h.client.set(`afk:${A}`, null); });
    let reads = 0;
    const base = h.client.handler;
    h.client.handler = (c) => {
      if (c.m !== 'afkRead') return base(c);
      reads += 1;
      // The fresh read lands 1.5 s later and says the sweep cut this device.
      return new Promise((resolve) => setTimeout(() => {
        act(() => { h.client.set(`afk:${A}`, afkOf(AFK_CH, { pending: true, seq: 9 })); });
        resolve(null);
      }, 1_500));
    };
    act(() => general.update({ phase: 'ended', error: 'E_DISCONNECTED' }));
    expect(h.v.recoveryChannelId).toBe(GENV);
    await wait(4_000);
    expect(reads).toBeGreaterThan(0);
    expect(h.started).toHaveLength(1);
    expect(h.v.recoveryChannelId).toBeNull();
    expect(h.v.notice).toEqual({ channelId: GENV, key: 'afk.moved', text: MOVED });
  }, 10_000);

  it('fix round 2 (B-I1): a failed afk: read skips that attempt only; the recovery keeps its backoff and rejoins once a read answers clear', async () => {
    const h = harness();
    const general = await h.joined(GENV);
    act(() => { h.client.set(`afk:${A}`, null); });
    let reads = 0;
    const base = h.client.handler;
    h.client.handler = (c) => {
      if (c.m !== 'afkRead') return base(c);
      reads += 1;
      if (reads <= 2) return Promise.reject(Object.assign(new Error('E_UNAVAILABLE'), { code: 'E_UNAVAILABLE' }));
      act(() => { h.client.set(`afk:${A}`, afkOf(AFK_CH, { seq: 9 })); });
      return Promise.resolve(null);
    };
    act(() => general.update({ phase: 'ended', error: 'E_DISCONNECTED' }));
    // Retries at 1 s and 2 s fail their read: no join, the recovery stands (the dock says reconnecting).
    await wait(3_300);
    expect(reads).toBe(2);
    expect(h.started).toHaveLength(1);
    expect(h.v.recoveryChannelId).toBe(GENV);
    expect(h.v.notice).toBeNull();
    // The third (at 4 s more) reads clear and rejoins.
    await waitFor(() => expect(h.started.map((s) => s.channelId)).toEqual([GENV, GENV]), { timeout: 6_000 });
    expect(reads).toBe(3);
  }, 15_000);

  it('fix round 2 (B-I1): a read that fails and then answers away ends the recovery with no join', async () => {
    const h = harness();
    const general = await h.joined(GENV);
    let reads = 0;
    const base = h.client.handler;
    h.client.handler = (c) => {
      if (c.m !== 'afkRead') return base(c);
      reads += 1;
      if (reads === 1) return Promise.reject(Object.assign(new Error('E_UNAVAILABLE'), { code: 'E_UNAVAILABLE' }));
      act(() => { h.client.set(`afk:${A}`, afkOf(AFK_CH, { seq: 9, away: [{ userId: ME.id, since: nowSec() }] })); });
      return Promise.resolve(null);
    };
    act(() => general.update({ phase: 'ended', error: 'E_DISCONNECTED' }));
    await waitFor(() => expect(h.v.recoveryChannelId).toBeNull(), { timeout: 6_000 });
    expect(reads).toBe(2);
    expect(h.started).toHaveLength(1);
    await wait(2_500);
    expect(h.started).toHaveLength(1);
  }, 15_000);

  it('fix round 2 (B-M2): an upgrade restore waits past the 5 s read budget for slow slices, then joins', async () => {
    const h = harness({ lagging: true });
    act(() => h.v.restore(GENV, false, false));
    await wait(AFK_READ_WAIT_MS + 1_500);
    expect(h.started).toEqual([]);
    expect(h.v.notice).toBeNull();
    act(() => { loadSlices(h.client); });
    await waitFor(() => expect(h.started.map((s) => s.channelId)).toEqual([GENV]), { timeout: 4_000 });
    expect(RESTORE_WAIT_MS).toBe(120_000);
  }, 20_000);


  it('I1: a web3.9 call in AFK restored after the upgrade, before the slices land, opens no microphone and says no failure', async () => {
    const h = harness({ lagging: true });
    act(() => h.v.restore(AFK_CH, false, false));
    await wait(300);
    act(() => { loadSlices(h.client); });
    await wait(1_200);
    expect(h.started).toEqual([]);
    expect(h.v.notice).toBeNull();
    expect(h.v.lasting).toBe('');
    expect(h.client.callsOf('afkAway')).toEqual([]);
    // Control: an ordinary channel restored the same way joins once the slices land.
    const g = harness({ lagging: true });
    act(() => g.v.restore(GENV, false, false));
    await wait(300);
    expect(g.started).toEqual([]);
    act(() => { loadSlices(g.client); });
    await waitFor(() => expect(g.started.map((s) => s.channelId)).toEqual([GENV]));
  });

  it('I2: choosing AFK cancels a pending recovery', async () => {
    const h = harness();
    const general = await h.joined(GENV);
    act(() => general.update({ phase: 'ended', error: 'E_DISCONNECTED' }));
    expect(h.v.recoveryChannelId).toBe(GENV);
    act(() => h.v.join(AFK_CH));
    await waitFor(() => expect(h.client.callsOf('afkAway')).toHaveLength(1));
    expect(h.v.recoveryChannelId).toBeNull();
    await wait(3_500);
    expect(h.started).toHaveLength(1);
  }, 10_000);

  it('I3: AFK and then another channel before the leave answers: the away mark is dropped and the newer call stands', async () => {
    const h = harness();
    const general = await h.joined(GENV);
    let release: () => void = () => undefined;
    general.leaveGate = new Promise<void>((r) => { release = r; });
    act(() => h.v.join(AFK_CH));
    act(() => h.v.join(B_GEN));
    release();
    await waitFor(() => expect(h.v.session).toBe(h.sessions[1]));
    await wait(300);
    expect(h.client.callsOf('afkAway')).toEqual([]);
    expect(h.started.map((s) => s.channelId)).toEqual([GENV, B_GEN]);
    expect(h.v.channelId).toBe(B_GEN);
  });

  it('I3: a join pressed while the away mark is in flight waits for it, so its admission follows the mark', async () => {
    const h = harness();
    let answer: () => void = () => undefined;
    const base = h.client.handler;
    h.client.handler = (c) => (c.m === 'afkAway' ? new Promise((r) => { answer = () => r(null); }) : base(c));
    act(() => h.v.join(AFK_CH));
    await waitFor(() => expect(h.client.callsOf('afkAway')).toHaveLength(1));
    act(() => h.v.join(GENV));
    await wait(200);
    expect(h.started).toEqual([]);
    answer();
    await waitFor(() => expect(h.started.map((s) => s.channelId)).toEqual([GENV]));
  });

  it('N2: a double click on AFK sends one away mark', async () => {
    const h = harness();
    act(() => h.v.join(AFK_CH));
    act(() => h.v.join(AFK_CH));
    await waitFor(() => expect(h.client.callsOf('afkAway')).toHaveLength(1));
    await wait(200);
    expect(h.client.callsOf('afkAway')).toHaveLength(1);
  });

  it('fix round 2 (B-n1): a click while the first away mark is in flight sends no second mark once that one made the person away', async () => {
    const h = harness();
    const base = h.client.handler;
    h.client.handler = (c) => (c.m === 'afkAway' ? new Promise((r) => setTimeout(() => {
      // Its op 55 lands with the answer.
      act(() => { h.client.set(`afk:${A}`, { ...afkOf(AFK_CH), away: [{ userId: ME.id, since: nowSec() }] }); });
      r(null);
    }, 200)) : base(c));
    act(() => h.v.join(AFK_CH));
    await waitFor(() => expect(h.client.callsOf('afkAway')).toHaveLength(1));
    act(() => h.v.join(AFK_CH));
    await wait(600);
    expect(h.client.callsOf('afkAway')).toHaveLength(1);
  });

  it('M3: a refused away mark says it could not go AFK, and nothing joins', async () => {
    const h = harness();
    await h.joined(GENV);
    const base = h.client.handler;
    h.client.handler = (c) => (c.m === 'afkAway' ? Promise.reject(Object.assign(new Error('E_INTERNAL'), { code: 'E_INTERNAL' })) : base(c));
    act(() => h.v.join(AFK_CH));
    await waitFor(() => expect(h.v.notice).toEqual({ channelId: AFK_CH, key: 'afk.failed' }));
    expect(h.v.lasting).toBe(t('afk.failed'));
    await wait(1_200);
    expect(h.started).toHaveLength(1);
    expect(h.v.channelId).toBeNull();
  });

  it('M6: choosing AFK keeps focus where it is (no return to the left call’s row)', async () => {
    const h = harness();
    await h.joined(GENV);
    act(() => h.v.join(AFK_CH));
    await waitFor(() => expect(h.client.callsOf('afkAway')).toHaveLength(1));
    expect(h.lefts).toEqual([]);
    // Control: the person's own leave returns focus.
    await h.joined(GENV);
    act(() => h.v.leave());
    await waitFor(() => expect(h.lefts).toEqual([GENV]));
  });
});

describe('AW5 fix round 3: gone channels, the restore banner, the upgrade window', () => {
  it('B2-M1: a recovery whose channel is gone ends with voice.disconnected', async () => {
    const h = harness();
    const general = await h.joined(GENV);
    act(() => general.update({ phase: 'ended', error: 'E_DISCONNECTED' }));
    // The channel was deleted while the call was lost: every list is loaded and none holds it.
    act(() => { h.client.set(`channels:${A}`, CHANNELS.filter((c) => c.id !== GENV)); });
    await waitFor(() => expect(h.v.recoveryChannelId).toBeNull(), { timeout: 3_000 });
    expect(h.v.notice).toEqual({ channelId: GENV, key: 'voice.disconnected' });
    expect(h.started).toHaveLength(1);
  });

  it('B2-M1: a recovery whose community is no longer listed (afkRead E_BAD_INPUT) ends with voice.disconnected', async () => {
    const h = harness();
    const general = await h.joined(GENV);
    const base = h.client.handler;
    h.client.handler = (c) => (c.m === 'afkRead' ? Promise.reject(Object.assign(new Error('E_BAD_INPUT'), { code: 'E_BAD_INPUT' })) : base(c));
    act(() => general.update({ phase: 'ended', error: 'E_DISCONNECTED' }));
    await waitFor(() => expect(h.v.recoveryChannelId).toBeNull(), { timeout: 3_000 });
    expect(h.v.notice).toEqual({ channelId: GENV, key: 'voice.disconnected' });
    expect(h.started).toHaveLength(1);
  });

  it('B2-M4: a waiting restore shows the rejoining state at once, and Leave ends it before it joins', async () => {
    const h = harness({ lagging: true });
    act(() => h.v.restore(GENV, false, false));
    expect(h.v.recoveryChannelId).toBe(GENV);
    await wait(500);
    act(() => h.v.leave());
    expect(h.v.recoveryChannelId).toBeNull();
    act(() => { loadSlices(h.client); });
    await wait(2_500);
    expect(h.started).toEqual([]);
  });

  it('B2-n2: an upgrade recovery that outlives its window ends with voice.disconnected', async () => {
    let open = true;
    const h = harness({ recoverEnded: () => open });
    const general = await h.joined(GENV);
    // The read keeps failing while the instance restarts, so no attempt joins.
    const base = h.client.handler;
    h.client.handler = (c) => (c.m === 'afkRead' ? Promise.reject(Object.assign(new Error('E_UNAVAILABLE'), { code: 'E_UNAVAILABLE' })) : base(c));
    act(() => { h.client.set('call', callState({ phase: 'removed', channelId: GENV, callId: GENV, error: { code: 'E_CALL_ENDED', detail: '' } } as never)); });
    act(() => general.update({ phase: 'ended', error: 'E_CALL_ENDED' }));
    expect(h.v.recoveryChannelId).toBe(GENV);
    await wait(1_300);
    expect(h.v.recoveryChannelId).toBe(GENV);
    open = false;
    await waitFor(() => expect(h.v.recoveryChannelId).toBeNull(), { timeout: 4_000 });
    expect(h.v.notice).toEqual({ channelId: GENV, key: 'voice.disconnected' });
    expect(h.started).toHaveLength(1);
  }, 10_000);
});

describe('#37: a share without sound, and the stream mute', () => {
  const BOB_USER = 'e1'.repeat(16);
  it('a share that goes out without sound is noticed; sound again or stopping the share clears the notice', async () => {
    const h = harness();
    await h.joined(GENV);
    expect(h.v.notice).toBeNull();
    act(() => h.sessions[0].update({ sharing: true, shareAudio: 'none' }));
    await waitFor(() => expect(h.v.notice).toEqual({ channelId: GENV, key: 'voice.shareAudio.none.tabOnly' }));
    act(() => h.sessions[0].update({ shareAudio: 'tab' }));
    await waitFor(() => expect(h.v.notice).toBeNull());
    act(() => h.sessions[0].update({ shareAudio: 'none' }));
    await waitFor(() => expect(h.v.notice?.key).toBe('voice.shareAudio.none.tabOnly'));
    act(() => h.sessions[0].update({ sharing: false, shareAudio: null }));
    await waitFor(() => expect(h.v.notice).toBeNull());
  });

  it.each([
    ['Firefox', 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0', 'voice.shareAudio.none.unsupported'],
    ['Chrome on Linux', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', 'voice.shareAudio.none.tabOnly'],
    ['Chrome on Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', 'voice.shareAudio.none.tabOrSystem'],
  ] as const)('the notice for a silent share on %s uses %s', async (_name, ua, key) => {
    const spy = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);
    try {
      const h = harness();
      await h.joined(GENV);
      act(() => h.sessions[0].update({ sharing: true, shareAudio: 'none' }));
      await waitFor(() => expect(h.v.notice).toEqual({ channelId: GENV, key }));
    } finally { spy.mockRestore(); }
  });

  it('FX2: a silent share lists the sound sources; a failed pick says so, and the next good pick clears it', async () => {
    const h = harness();
    await h.joined(GENV);
    h.sessions[0].sharePool = { labeled: true, sources: [{ id: 'd1', label: 'Monitor of x', monitor: true }] };
    act(() => h.sessions[0].update({ sharing: true, shareAudio: 'none' }));
    await waitFor(() => expect(h.v.sharePool?.sources.map(d => d.id)).toEqual(['d1']));
    h.sessions[0].setShareSource.mockRejectedValueOnce(new Error('E_UNAVAILABLE'));
    act(() => h.v.setShareSource('d1'));
    await waitFor(() => expect(h.v.notice).toEqual({ channelId: GENV, key: 'voice.shareAudio.pickFailed' }));
    act(() => h.v.setShareSource('d1'));
    await waitFor(() => expect(h.v.notice?.key).not.toBe('voice.shareAudio.pickFailed'));
  });

  it('a share with sound raises no notice', async () => {
    const h = harness();
    await h.joined(GENV);
    act(() => h.sessions[0].update({ sharing: true, shareAudio: 'tab' }));
    expect(h.v.notice).toBeNull();
  });

  it('the stream mute writes the stream volume key at 0 and the last volume back; the voice key is never written', async () => {
    const h = harness();
    await h.joined(GENV);
    act(() => h.v.toggleStreamMute(BOB_USER, 70));
    expect(h.sessions[0].setVolume).toHaveBeenCalledWith(BOB_USER, 0, 'stream');
    act(() => h.v.toggleStreamMute(BOB_USER, 0));
    expect(h.sessions[0].setVolume).toHaveBeenLastCalledWith(BOB_USER, 70, 'stream');
    const writes = h.client.callsOf('setSetting').map((c) => [c.key, c.value]);
    expect(writes).toEqual([[`voice.streamVolume.${BOB_USER}`, '0'], [`voice.streamVolume.${BOB_USER}`, '70']]);
  });
});

/**
 * The late-rejoin block runs on fake timers (flake fix, PR #67): setTimeout, setInterval, Date and performance are the
 * test's, so every liveness tick, retry and read happens at an exact time and nothing depends on how fast the machine is.
 * A suspend is a jump of the clocks with no timer run in it; awake time is `advance`, which runs every tick in it.
 */
const perfOffset = { ms: 0 };
function fakeClocks(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  perfOffset.ms = 0;
  const fakePerf = performance.now.bind(performance);
  vi.spyOn(performance, 'now').mockImplementation(() => fakePerf() + perfOffset.ms);
}
/** The device is gone for `ms` (a closed lid, a sleep): the wall clock jumps and no timer runs; `perf` false keeps
 *  performance.now still, as in browsers whose monotonic clock pauses during a suspend. */
function goneFor(ms: number, o: { perf?: boolean } = {}): void {
  vi.setSystemTime(Date.now() + ms);
  if (o.perf !== false) perfOffset.ms += ms;
}
/** Awake time: both clocks move and every timer due in it runs (a liveness tick each second). */
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
/** Advances in 50 ms steps until `done`, at most `max` ms of fake time. */
const until = async (done: () => boolean, max = 5_000) => {
  for (let t = 0; t < max && !done(); t += 50) await advance(50);
  expect(done()).toBe(true);
};

describe('late rejoin (Jonas 2026-10-21): a device gone longer than its server’s AFK timeout does not rejoin by itself', () => {
  /** A harness on fake clocks, joined to `id` by the person's press, one liveness tick in. */
  const fakeJoined = async (over: Partial<AFKState> | null = null) => {
    fakeClocks();
    const h = harness();
    if (over !== null) h.setAfk(A, over);
    act(() => h.v.join(GENV));
    await until(() => h.sessions.length === 1 && h.v.session === h.sessions[0]);
    await advance(1_000);
    return { h, general: h.sessions[0] };
  };

  it('gone 10 s (a Wi-Fi blip, a quick sleep): the recovery rejoins as before', async () => {
    const { h, general } = await fakeJoined();
    goneFor(10_000);
    act(() => general.update({ phase: 'ended', error: 'E_DISCONNECTED' }));
    await until(() => h.started.length === 2);
    expect(h.started[1].channelId).toBe(GENV);
    expect(h.v.notice).toBeNull();
  });

  it('gone 301 s with a 300 s timeout: no rejoin; the stage says voice.leftWhileAway and its join rejoins normally', async () => {
    const { h, general } = await fakeJoined();
    goneFor(301_000);
    act(() => general.update({ phase: 'ended', error: 'E_DISCONNECTED' }));
    await until(() => h.v.recoveryChannelId === null);
    expect(h.v.notice).toEqual({ channelId: GENV, key: 'voice.leftWhileAway' });
    expect(h.v.lasting).toBe(t('voice.leftWhileAway'));
    await advance(5_000);
    expect(h.started).toHaveLength(1);
    // The person's own join is an ordinary join.
    act(() => h.v.join(GENV));
    await until(() => h.started.length === 2 && h.v.session === h.sessions[1]);
    expect(h.started[1].channelId).toBe(GENV);
  });

  it('the larger clock counts: a monotonic clock that paused in the sleep does not hide a 6-minute absence', async () => {
    const { h, general } = await fakeJoined();
    goneFor(360_000, { perf: false });
    act(() => general.update({ phase: 'ended', error: 'E_DISCONNECTED' }));
    await until(() => h.v.recoveryChannelId === null);
    expect(h.v.notice).toEqual({ channelId: GENV, key: 'voice.leftWhileAway' });
    expect(h.started).toHaveLength(1);
  });

  it('gone 10 min on a server with AFK disabled (no AFK channel): the recovery rejoins as before', async () => {
    const { h, general } = await fakeJoined({ channelId: null });
    goneFor(600_000);
    act(() => general.update({ phase: 'ended', error: 'E_DISCONNECTED' }));
    await until(() => h.started.length === 2);
    expect(h.v.notice).toBeNull();
  });

  it('a pending reason still wins: gone 301 s and swept says afk.moved, not leftWhileAway', async () => {
    const { h, general } = await fakeJoined();
    goneFor(301_000);
    act(() => general.update({ phase: 'ended', error: 'E_DISCONNECTED' }));
    h.setAfk(A, { pending: true, pendingReason: 1, seq: 7 });
    await until(() => h.v.recoveryChannelId === null);
    expect(h.v.notice).toEqual({ channelId: GENV, key: 'afk.moved', text: MOVED });
    expect(h.started).toHaveLength(1);
  });

  it('fix round 1 (I1): woken after 10 min, a tick sees the gap and the reconnect takes over 60 s: still no rejoin', async () => {
    const { h, general } = await fakeJoined();
    goneFor(600_000);
    await advance(1_000);
    // LiveKit noticed the dead link after the wake and keeps retrying while the Wi-Fi is slow to come back.
    act(() => general.update({ phase: 'reconnecting' }));
    await advance(63_000);
    act(() => general.update({ phase: 'ended', error: 'E_DISCONNECTED' }));
    await until(() => h.v.recoveryChannelId === null);
    expect(h.v.notice).toEqual({ channelId: GENV, key: 'voice.leftWhileAway' });
    await advance(5_000);
    expect(h.started).toHaveLength(1);
  });

  it('fix round 1 (I1): a suspend the call reconnected through is over: a short drop after it rejoins by itself', async () => {
    const { h, general } = await fakeJoined();
    goneFor(600_000);
    await advance(1_000);
    act(() => general.update({ phase: 'reconnecting' }));
    act(() => general.update({ phase: 'connected' }));
    await advance(1_000);
    act(() => general.update({ phase: 'ended', error: 'E_DISCONNECTED' }));
    await until(() => h.started.length === 2);
    expect(h.v.notice).toBeNull();
  });

  it('fix round 2: stalls of a background tab (10 s gaps under 60 s apart, connected all along) never add up: a short drop rejoins', async () => {
    // A 1-minute timeout, so seven stalls added together (70 s) would pass it.
    const { h, general } = await fakeJoined({ timeoutSeconds: 60 });
    for (let i = 0; i < 7; i++) {
      // A stall: the clock moves on with no timer run (a throttled page), then the next tick runs. The second stall is the
      // longest (12 s, the others 10 s), so it is the gap kept, and at the drop its start is over 60 s back while its end
      // is not old enough to have settled: its length must count, not its age. (The CI flake: timer jitter made an early
      // stall the longest, and the absence was read from its start, about 66 s back, against the 60 s timeout.)
      goneFor(i === 1 ? 12_000 : 10_000);
      await advance(1_000);
    }
    act(() => general.update({ phase: 'ended', error: 'E_DISCONNECTED' }));
    expect(h.v.recoveryChannelId).toBe(GENV);
    await until(() => h.started.length === 2);
    expect(h.started[1].channelId).toBe(GENV);
    expect(h.v.notice).toBeNull();
  });

  it('fix round 1 (I1): a suspend the connection stayed up through settles after 60 s: a later drop rejoins by itself', async () => {
    const { h, general } = await fakeJoined();
    goneFor(600_000);
    await advance(1_000);
    await advance(63_000);
    act(() => general.update({ phase: 'ended', error: 'E_DISCONNECTED' }));
    await until(() => h.started.length === 2);
    expect(h.v.notice).toBeNull();
  });

  it('the upgrade restore keeps its own 120 s window: a long-gone clock does not end it', async () => {
    fakeClocks();
    const h = harness();
    goneFor(600_000);
    act(() => h.v.restore(GENV, false, false));
    await until(() => h.started.length === 1);
    expect(h.v.notice).toBeNull();
  });
});

describe('UP7: calls survive an upgrade (Q1 = B, R-UP6 to R-UP9)', () => {
  const unavailable = (ms: number) => Object.assign(new Error('E_UNAVAILABLE'), { code: 'E_UNAVAILABLE', status: 503, retryAfterMs: ms });
  const forbidden = () => Object.assign(new Error('E_FORBIDDEN'), { code: 'E_FORBIDDEN', status: 403, retryAfterMs: null });
  const unreachable = () => Object.assign(new Error('E_NETWORK'), { code: 'E_NETWORK', status: 0, retryAfterMs: null });
  type H = ReturnType<typeof harness>;
  const offline = (h: H) => { act(() => { h.client.set('connection', { status: 'offline', generation: null }); }); };
  const online = (h: H) => { act(() => { h.client.set('connection', { status: 'online', generation: null }); }); };
  /** A just-reloaded page's held restore, saved `agoMs` before now with an absence since `goneMs` before now. */
  const heldNow = (agoMs = 0, goneMs = agoMs) => ({ at: Date.now() - agoMs, gone: Date.now() - goneMs });

  it('the update path: holdForReload holds the live call (callHold), posts no callLeave, and nothing rejoins', async () => {
    const h = harness();
    const general = await h.joined(GENV);
    await act(async () => { await h.v.holdForReload(); });
    expect(general.leave).toHaveBeenCalledWith('hold');
    expect(h.client.callsOf('callHold')).toEqual([{ m: 'callHold', channelId: GENV }]);
    expect(h.client.callsOf('callLeave')).toEqual([]);
    expect(h.v.session).toBeNull();
    await wait(1_500);
    expect(h.started).toHaveLength(1);
  });

  it('the update path while recovering: the held group is persisted (callHold) and no attempt joins', async () => {
    const h = harness();
    const general = await h.joined(GENV);
    act(() => general.update({ phase: 'ended', error: 'E_DISCONNECTED' }));
    expect(h.v.recoveryChannelId).toBe(GENV);
    await act(async () => { await h.v.holdForReload(); });
    expect(h.client.callsOf('callHold')).toEqual([{ m: 'callHold', channelId: GENV }]);
    await wait(2_500);
    expect(h.started).toHaveLength(1);
    expect(h.client.callsOf('callRelease')).toEqual([]);
  });

  it('an update reload mid-call resumes the held group at once, its AFK read in parallel, with no fresh join or leave', async () => {
    fakeClocks();
    const h = harness();
    act(() => h.v.restore(GENV, false, false, heldNow()));
    // The AFK read is out before the start's callJoin has answered: they run side by side.
    expect(h.client.callsOf('afkRead')).toHaveLength(1);
    // No recovery tick (1 s) is waited for.
    await until(() => h.started.length === 1, 300);
    expect(h.started[0].opts.resume).toBeDefined();
    await until(() => h.v.session !== null, 1_000);
    expect(h.v.recoveryChannelId).toBeNull();
    expect(h.v.notice).toBeNull();
    await advance(3_000);
    expect(h.started).toHaveLength(1);
    expect(h.client.callsOf('callLeave')).toEqual([]);
    expect(h.client.callsOf('callRelease')).toEqual([]);
  });

  it('the parallel AFK read still cancels before the connect: away since, the resume leaves (its one self-Remove)', async () => {
    const h = harness();
    h.awayMe(A);
    act(() => h.v.restore(GENV, false, false, heldNow()));
    await waitFor(() => expect(h.v.recoveryChannelId).toBeNull(), { timeout: 3_000 });
    expect(h.sessions).toEqual([]);
    expect(h.client.callsOf('callLeave')).toEqual([{ m: 'callLeave', reason: 'user' }]);
    expect(h.v.notice).toEqual({ channelId: GENV, key: 'voice.disconnected' });
    await wait(1_500);
    expect(h.started).toHaveLength(1);
  });

  it('late rejoin never fires on an update reload: the wall clock moved 10 min ahead before pagehide (AFK timeout 60 s, unexpired hold)', async () => {
    fakeClocks();
    const old = harness();
    old.setAfk(A, { timeoutSeconds: 60 });
    act(() => old.v.join(GENV));
    await until(() => old.v.session !== null);
    await advance(1_000);
    // The clock moves before pagehide: the old page's liveness sees it as a 10-minute gap, and saves that absence.
    goneFor(600_000);
    const gone = old.v.absentSince();
    const at = Date.now();
    expect(at - gone).toBeGreaterThanOrEqual(600_000);
    await act(async () => { await old.v.holdForReload(); });
    expect(old.client.callsOf('callHold')).toEqual([{ m: 'callHold', channelId: GENV }]);
    old.view.unmount();

    const h = harness();
    h.setAfk(A, { timeoutSeconds: 60 });
    h.answer.expired = false;
    act(() => h.v.restore(GENV, false, false, { at, gone }));
    await until(() => h.v.session !== null);
    expect(h.v.notice).toBeNull();
    expect(h.v.lasting).toBe('');
    expect(h.client.callsOf('callLeave')).toEqual([]);
  });

  it('late rejoin still fires for an expired hold: an absence over the AFK timeout ends leftAway, with no rejoin', async () => {
    fakeClocks();
    const h = harness();
    h.setAfk(A, { timeoutSeconds: 60 });
    h.answer.expired = true;
    act(() => h.v.restore(GENV, false, false, heldNow(200_000)));
    await until(() => h.v.recoveryChannelId === null);
    expect(h.v.notice).toEqual({ channelId: GENV, key: 'voice.leftWhileAway' });
    expect(h.v.session).toBeNull();
    // The gate refused after the resume's callJoin: the session left it (the one self-Remove).
    expect(h.client.callsOf('callLeave')).toEqual([{ m: 'callLeave', reason: 'user' }]);
    await advance(5_000);
    expect(h.started).toHaveLength(1);
  });

  it('a hold the worker no longer had (a fresh join) counts as expired only past HOLD_MS', async () => {
    fakeClocks();
    const h = harness();
    h.setAfk(A, { timeoutSeconds: 60 });
    h.answer.resumed = false;
    h.answer.expired = false;
    // Saved 90 s ago with the absence then: not expired by the page's own count, so no leftAway.
    act(() => h.v.restore(GENV, false, false, heldNow(90_000)));
    await until(() => h.v.session !== null);
    expect(h.v.notice).toBeNull();
  });

  it('E_UNAVAILABLE (503) is transient: the next attempt waits retry_after_ms, and the recovery goes on', async () => {
    fakeClocks();
    const h = harness();
    h.failures.push(unavailable(5_000));
    act(() => h.v.restore(GENV, false, false));
    await until(() => h.started.length === 1, 2_000);
    // A restore asks every second, but not before the instance's own wait.
    await advance(3_500);
    expect(h.started).toHaveLength(1);
    expect(h.v.recoveryChannelId).toBe(GENV);
    await until(() => h.started.length === 2, 3_000);
    await until(() => h.v.session !== null);
    expect(h.v.recoveryChannelId).toBeNull();
  });

  it('a held resume refused 503 waits retry_after_ms and resumes through the gate again; E_FORBIDDEN stays permanent', async () => {
    fakeClocks();
    const h = harness();
    h.failures.push(unavailable(3_000));
    act(() => h.v.restore(GENV, false, false, heldNow()));
    await until(() => h.started.length === 1, 300);
    await advance(2_000);
    expect(h.started).toHaveLength(1);
    await until(() => h.started.length === 2, 3_000);
    expect(h.started[1].opts.resume).toBeDefined();
    await until(() => h.v.session !== null);

    const g = harness();
    g.failures.push(forbidden());
    act(() => g.v.restore(GENV, false, false, heldNow()));
    await until(() => g.v.recoveryChannelId === null, 1_000);
    await advance(5_000);
    expect(g.started).toHaveLength(1);
  });

  it('the restore keeps trying past 120 s of instance downtime, backing off 1, 2, 4 … 30 s, and tries at once when it answers', async () => {
    fakeClocks();
    const h = harness();
    offline(h);
    for (let i = 0; i < 100; i++) h.failures.push(unreachable());
    act(() => h.v.restore(GENV, false, false, heldNow()));
    await advance(200_000);
    expect(h.v.recoveryChannelId).toBe(GENV);
    // The fast attempt, then 1, 2, 4, 8, 16, 30, 30, 30, 30, 30 s apart: never every second.
    expect(h.started.length).toBeGreaterThanOrEqual(8);
    expect(h.started.length).toBeLessThanOrEqual(13);
    const before = h.started.length;
    h.failures.length = 0;
    online(h);
    await advance(100);
    expect(h.started).toHaveLength(before + 1);
    await until(() => h.v.session !== null, 1_000);
  });

  it('the restore window counts instance time: it does not run while the instance is down, and ends 120 s of answers later', async () => {
    fakeClocks();
    const h = harness();
    // Every AFK read fails, so no attempt joins (B-I1): only the window can end the restore.
    const base = h.client.handler;
    h.client.handler = (c) => (c.m === 'afkRead' ? Promise.reject(Object.assign(new Error('E_NETWORK'), { code: 'E_NETWORK' })) : base(c));
    offline(h);
    act(() => h.v.restore(GENV, false, false));
    await advance(150_000);
    expect(h.v.recoveryChannelId).toBe(GENV);
    online(h);
    await advance(100_000);
    expect(h.v.recoveryChannelId).toBe(GENV);
    await advance(25_000);
    expect(h.v.recoveryChannelId).toBeNull();
    expect(h.v.notice).toEqual({ channelId: GENV, key: 'voice.disconnected' });
    // Giving up lets the held group go.
    expect(h.client.callsOf('callRelease')).toEqual([{ m: 'callRelease' }]);
  });

  it('R-UP9: a lost room inside an instance outage does not count toward the late-rejoin absence', async () => {
    fakeClocks();
    const h = harness();
    h.setAfk(A, { timeoutSeconds: 60 });
    act(() => h.v.join(GENV));
    await until(() => h.v.session !== null);
    await advance(1_000);
    const general = h.sessions[0];
    // The API restarts: the gateway goes, LiveKit keeps resuming for a while, then gives up.
    offline(h);
    await advance(30_000);
    act(() => general.update({ phase: 'ended', error: 'E_DISCONNECTED' }));
    // The instance stays down 100 s more: every AFK read fails, so nothing joins and nothing ends.
    const base = h.client.handler;
    let down = true;
    h.client.handler = (c) => (c.m === 'afkRead' && down ? Promise.reject(Object.assign(new Error('E_NETWORK'), { code: 'E_NETWORK' })) : base(c));
    await advance(100_000);
    expect(h.started).toHaveLength(1);
    expect(h.v.recoveryChannelId).toBe(GENV);
    down = false;
    online(h);
    await until(() => h.started.length === 2, 3_000);
    expect(h.v.notice).toBeNull();
  });

  it('R-UP9: a suspend still counts from its start, whatever the instance did after the wake', async () => {
    fakeClocks();
    const h = harness();
    h.setAfk(A, { timeoutSeconds: 60 });
    act(() => h.v.join(GENV));
    await until(() => h.v.session !== null);
    await advance(1_000);
    const general = h.sessions[0];
    goneFor(600_000);
    await advance(1_000);
    offline(h);
    await advance(1_000);
    act(() => general.update({ phase: 'ended', error: 'E_DISCONNECTED' }));
    online(h);
    await until(() => h.v.recoveryChannelId === null);
    expect(h.v.notice).toEqual({ channelId: GENV, key: 'voice.leftWhileAway' });
    expect(h.started).toHaveLength(1);
  });

  it('the person leaving a pending recovery posts callRelease', async () => {
    const g = harness();
    const general = await g.joined(GENV);
    act(() => general.update({ phase: 'ended', error: 'E_DISCONNECTED' }));
    act(() => g.v.leave());
    expect(g.client.callsOf('callRelease')).toEqual([{ m: 'callRelease' }]);
    expect(g.v.recoveryChannelId).toBeNull();
  });

  it('giving up the recovery (its channel gone) posts callRelease', async () => {
    const h = harness();
    const general = await h.joined(GENV);
    act(() => general.update({ phase: 'ended', error: 'E_DISCONNECTED' }));
    act(() => { h.client.set(`channels:${A}`, CHANNELS.filter((c) => c.id !== GENV)); });
    await waitFor(() => expect(h.v.recoveryChannelId).toBeNull(), { timeout: 3_000 });
    expect(h.client.callsOf('callRelease')).toEqual([{ m: 'callRelease' }]);
  });
});

describe('UP7 fix round 1', () => {
  type H = ReturnType<typeof harness>;
  const failReads = (h: H) => {
    const base = h.client.handler;
    let failing = true;
    h.client.handler = (c) => (c.m === 'afkRead' && failing ? Promise.reject(Object.assign(new Error('E_NETWORK'), { code: 'E_NETWORK' })) : base(c));
    return { stop: () => { failing = false; } };
  };

  for (const by of ['the worker', 'the page clock'] as const) {
    it(`an expired hold (by ${by}) with failing AFK reads makes at most one join attempt before a definite read`, async () => {
      fakeClocks();
      const h = harness();
      if (by === 'the worker') { h.answer.expired = true; } else { h.answer.resumed = false; h.answer.expired = false; }
      const reads = failReads(h);
      const at = by === 'the worker' ? Date.now() : Date.now() - 200_000;
      act(() => h.v.restore(GENV, false, false, { at, gone: Date.now() }));
      await advance(20_000);
      // The resume's gate refused once (its one self-Remove); later attempts read first and join nothing on an unknown read.
      expect(h.started.length).toBeLessThanOrEqual(1);
      expect(h.client.callsOf('callLeave').length).toBeLessThanOrEqual(1);
      expect(h.v.recoveryChannelId).toBe(GENV);
      // A definite clear read joins, through the ordinary path (no gate).
      reads.stop();
      await until(() => h.v.session !== null, 3_000);
      expect(h.started.at(-1)?.opts.resume).toBeUndefined();
    });
  }

  it("R-UP9: the device's own network loss is no instance outage: offline longer than the AFK timeout ends leftAway", async () => {
    fakeClocks();
    const h = harness();
    h.setAfk(A, { timeoutSeconds: 60 });
    act(() => h.v.join(GENV));
    await until(() => h.v.session !== null);
    await advance(1_000);
    const general = h.sessions[0];
    // The device loses its network (awake): the browser says offline, and the worker's connection goes with it.
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    act(() => { h.client.set('connection', { status: 'offline', generation: null }); });
    await advance(30_000);
    act(() => general.update({ phase: 'ended', error: 'E_DISCONNECTED' }));
    await advance(100_000);
    expect(h.started).toHaveLength(1);
    onLine.mockReturnValue(true);
    act(() => { h.client.set('connection', { status: 'online', generation: null }); });
    await until(() => h.v.recoveryChannelId === null);
    expect(h.v.notice).toEqual({ channelId: GENV, key: 'voice.leftWhileAway' });
    expect(h.started).toHaveLength(1);
  });
});

describe('UP7b: the instance answering again', () => {
  it('after a 10-minute outage, the held restore attempts within 100 ms of the instance answering, whatever its backoff', async () => {
    fakeClocks();
    const h = harness();
    act(() => { h.client.set('connection', { status: 'offline', generation: null }); });
    for (let i = 0; i < 400; i++) h.failures.push(Object.assign(new Error('E_NETWORK'), { code: 'E_NETWORK', status: 0, retryAfterMs: null }));
    act(() => h.v.restore(GENV, false, false, { at: Date.now(), gone: Date.now() }));
    await advance(600_000);
    // Backed off to 30 s apart: the next attempt of its own would be up to 30 s away.
    await advance(1_000);
    const before = h.started.length;
    h.failures.length = 0;
    act(() => { h.client.set('connection', { status: 'online', generation: null }); });
    await advance(100);
    expect(h.started).toHaveLength(before + 1);
    await until(() => h.v.session !== null, 1_000);
    expect(h.v.notice).toBeNull();
  });
});

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
import { REMOVED_HOLD_MS, useCall, VoiceDepsContext, type UseCallOptions, type VoiceDeps, type VoiceModule } from './useCall.tsx';

const AFK_CH = 'af'.repeat(16);
const B = 'b7'.repeat(16);
const B_GEN = 'b8'.repeat(16);
const B_AFK = 'bf'.repeat(16);
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

function harness() {
  const client = new FakeClient();
  client.set('account', account());
  client.set('settings', {});
  client.set('communities', [{ id: A, name: 'Midgard', owner: 'ee'.repeat(16) }, { id: B, name: 'Asgard', owner: 'ee'.repeat(16) }]);
  client.set('dms', []);
  client.set(`channels:${A}`, [...CHANNELS, voice(AFK_CH, A, 'AFK', 1 << 30)]);
  client.set(`channels:${B}`, [voice(B_GEN, B, 'hall'), voice(B_AFK, B, 'AFK', 1 << 30)]);
  client.set(`afk:${A}`, afkOf(AFK_CH));
  client.set(`afk:${B}`, afkOf(B_AFK));
  client.set('call', callState());
  const log: string[] = [];
  const sessions: Session[] = [];
  const started: { channelId: string; opts: PageCallOptions }[] = [];
  const module: VoiceModule = {
    isVoiceSupported: () => ({ ok: true as const, path: 'insertable-streams' as const }),
    localDecodeList: () => 'vp8',
    browserDeps: (bridge) => ({ bridge } as unknown as ReturnType<VoiceModule['browserDeps']>),
    startPageCall: vi.fn<VoiceModule['startPageCall']>(async (_deps, target, opts) => {
      started.push({ channelId: target.channelId, opts });
      await Promise.resolve();
      const s = new Session(log, client);
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
      whereOf: (id) => (id === AFK_CH || id === B_AFK ? 'AFK' : 'general'), onLeft: () => undefined, stageShown: () => false,
      afk: p.afk,
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
  return { client, log, sessions, started, module, view, said, joined, setAfk, awayMe, cut,
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
    expect(h.started[0].opts.listenOnly ?? false).toBe(false);
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

  it('recovery while away only from before the call started still rejoins (control)', async () => {
    const h = harness();
    const general = await h.joined(GENV);
    act(() => general.update({ phase: 'ended', error: 'E_DISCONNECTED' }));
    h.awayMe(A, nowSec() - 3_600);
    await waitFor(() => expect(h.started).toHaveLength(2), { timeout: 3_000 });
    expect(h.started[1].channelId).toBe(GENV);
  });

  it('reload while away: the restore starts no call', async () => {
    const h = harness();
    h.awayMe(A);
    act(() => h.v.restore(GENV, false, false));
    await wait(1_200);
    expect(h.started).toEqual([]);
    expect(h.v.channelId).toBeNull();
    expect(h.v.recoveryChannelId).toBeNull();
    // Control: a restore in another community joins.
    act(() => h.v.restore(B_GEN, false, false));
    await waitFor(() => expect(h.started.map((s) => s.channelId)).toEqual([B_GEN]));
  });

  it('a restore of the AFK channel (a web3.9 call) starts nothing and marks nothing', async () => {
    const h = harness();
    act(() => h.v.restore(AFK_CH, false, false));
    await wait(1_200);
    expect(h.started).toEqual([]);
    expect(h.client.callsOf('afkAway')).toEqual([]);
    expect(h.v.recoveryChannelId).toBeNull();
  });
});


describe('#37: a share without sound, and the stream mute', () => {
  const BOB_USER = 'e1'.repeat(16);
  it('a share that goes out without sound is noticed; sound again or stopping the share clears the notice', async () => {
    const h = harness();
    await h.joined(GENV);
    expect(h.v.notice).toBeNull();
    act(() => h.sessions[0].update({ sharing: true, shareAudio: 'none' }));
    await waitFor(() => expect(h.v.notice).toEqual({ channelId: GENV, key: 'voice.shareAudio.none' }));
    act(() => h.sessions[0].update({ shareAudio: 'tab' }));
    await waitFor(() => expect(h.v.notice).toBeNull());
    act(() => h.sessions[0].update({ shareAudio: 'none' }));
    await waitFor(() => expect(h.v.notice?.key).toBe('voice.shareAudio.none'));
    act(() => h.sessions[0].update({ sharing: false, shareAudio: null }));
    await waitFor(() => expect(h.v.notice).toBeNull());
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

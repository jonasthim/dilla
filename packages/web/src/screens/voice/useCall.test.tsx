// web3.9 VOICE-AFK: the shell's side of the AFK move. A pending move (the server's sweep moved this device, R33) joins the
// community's AFK channel once, listen-only, says so once, and never retries; a failed join leaves the dock's line.
// Fix round 1: every join into an AFK channel is listen-only even while the slices lag (I-2), a failed move survives the
// community re-reads (I-3), it is said where it is heard (I-1), and a stale `pending` neither silences a cut nor leaves a
// newer call (m-1).
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { SETTINGS, type AFKState, type ChannelSummary } from '@dilla/client-core';
import type { PageCallOptions } from '../../call/session.ts';
import { t } from '../../strings/index.ts';
import { A, CHANNELS, FakeClient, FakeSession, GENV, callState } from '../../test/fake-client.ts';
import {
  AFK_MIN_IDLE_MS, AFK_STATUS_WAIT_MS, REMOVED_HOLD_MS, useCall, VoiceDepsContext, type UseCallOptions, type VoiceDeps, type VoiceModule,
} from './useCall.tsx';

const AFK_CH = 'af'.repeat(16);
const B = 'b7'.repeat(16);
const B_GEN = 'b8'.repeat(16);
const B_AFK = 'bf'.repeat(16);
const AFK_SET: ReadonlySet<string> = new Set([AFK_CH, B_AFK]);
const NONE: ReadonlySet<string> = new Set();
type Pending = NonNullable<UseCallOptions['afk']>['pending'];
const move = (over: Partial<NonNullable<Pending>> = {}): NonNullable<Pending> => ({ communityId: A, channelId: AFK_CH, name: 'AFK', seq: 1, ...over });
const moveB = () => move({ communityId: B, channelId: B_AFK, name: 'AFK', seq: 2 });
const MOVED = t('afk.moved', { channel: 'AFK' });
const voice = (id: string, communityId: string, name: string, position = 1): ChannelSummary => ({
  id, communityId, kind: 1, mode: 0, name, topic: '', parentId: null, position, slowmode: 0, announcement: false, group: 'unsupported' });
const afkOf = (channelId: string | null): AFKState => ({ channelId, timeoutSeconds: 300, pending: false });

/** As the real session: a listen-only call stays muted whatever is pressed (setMuted is a no-op). */
class Session extends FakeSession {
  override setMuted(on: boolean): void {
    if (this.state.listenOnly) { this.log.push(`muted:noop:${String(on)}`); return; }
    super.setMuted(on);
  }
}

/** A removal's notice waits up to REMOVED_HOLD_MS for a possible AFK move. */
const HELD = { timeout: REMOVED_HOLD_MS + 1_500 };
const flush = async () => { await act(async () => { for (let i = 0; i < 10; i++) await new Promise<void>((r) => setTimeout(r, 0)); }); };

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/** The page clock moves on by `ms` (Date.now only; timers keep real time). */
const clock = { skew: 0 };
function skewClock(): void {
  clock.skew = 0;
  const real = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => real() + clock.skew);
}

function harness(o: { fails?: (channelId: string) => boolean; afk?: UseCallOptions['afk']; lagging?: boolean } = {}) {
  skewClock();
  const client = new FakeClient();
  client.set('settings', {});
  client.set('communities', [{ id: A, name: 'Midgard', owner: 'ee'.repeat(16) }, { id: B, name: 'Asgard', owner: 'ee'.repeat(16) }]);
  client.set('dms', []);
  client.set(`channels:${A}`, [...CHANNELS, voice(AFK_CH, A, 'AFK', 1 << 30)]);
  client.set(`channels:${B}`, [voice(B_GEN, B, 'hall'), voice(B_AFK, B, 'AFK', 1 << 30)]);
  // `lagging`: the afk: slices are still being read (null), as after an update reload.
  if (o.lagging !== true) { client.set(`afk:${A}`, afkOf(AFK_CH)); client.set(`afk:${B}`, afkOf(B_AFK)); }
  client.set('call', callState());
  const log: string[] = [];
  const sessions: Session[] = [];
  const started: { channelId: string; opts: PageCallOptions }[] = [];
  let loadGate: Promise<void> = Promise.resolve();
  const holdLoad = (): (() => void) => {
    let release: () => void = () => undefined;
    loadGate = new Promise<void>((resolve) => { release = resolve; });
    return release;
  };
  const module: VoiceModule = {
    isVoiceSupported: () => ({ ok: true as const, path: 'insertable-streams' as const }),
    localDecodeList: () => 'vp8',
    browserDeps: (bridge) => ({ bridge } as unknown as ReturnType<VoiceModule['browserDeps']>),
    // A start stands for the session's: an ordinary one asks for the microphone, a listen-only one never does.
    startPageCall: vi.fn<VoiceModule['startPageCall']>(async (_deps, target, opts) => {
      started.push({ channelId: target.channelId, opts });
      await Promise.resolve();
      if (o.fails?.(target.channelId) === true) throw Object.assign(new Error('E_FORBIDDEN'), { code: 'E_FORBIDDEN' });
      const s = new Session(log, client);
      const listen = opts.listenOnly === true;
      s.state = { ...s.state, listenOnly: listen, mic: listen ? 'listen' : 'ok',
        muted: listen || opts.self === 'muted' || opts.self === 'deafened', deafened: opts.self === 'deafened' };
      sessions.push(s);
      // As the worker: phase 'in' is published before callJoin answers (L-TS-56 step 1).
      client.set('call', callState({ phase: 'in', channelId: target.channelId, callId: target.channelId }));
      return s;
    }),
    bindPushToTalk: () => () => undefined,
    volumesFromSettings: () => ({}), streamVolumesFromSettings: () => ({}),
  };
  const deps: VoiceDeps = {
    load: () => loadGate.then(() => module),
    createCallContext: () => null,
    createSounds: () => ({ play: () => undefined, startRing: () => undefined, stopRing: () => undefined, dispose: () => undefined }),
  };
  const wrapper = ({ children }: { children: ReactNode }) => createElement(VoiceDepsContext.Provider, { value: deps }, children);
  /** Every announcement the hook rendered, in order. */
  const said: string[] = [];
  const view = renderHook((p: { afk?: UseCallOptions['afk'] }) => {
    const v = useCall({
      client, call: client.get('call'), settings: client.get('settings') ?? {},
      whereOf: (id) => (id === AFK_CH || id === B_AFK ? 'AFK' : 'general'), onLeft: () => undefined, stageShown: () => false,
      ...(p.afk !== undefined ? { afk: p.afk } : {}),
    });
    if (said.at(-1) !== v.announcement) said.push(v.announcement);
    return v;
  }, { wrapper, initialProps: { afk: o.afk ?? { channels: AFK_SET, pending: null } } });
  const setAfk = (afk: NonNullable<UseCallOptions['afk']>) => { act(() => view.rerender({ afk })); };
  /** Joins `id` by the person's press and waits until its session is attached. */
  const joined = async (id: string) => {
    const n = sessions.length;
    act(() => view.result.current.join(id));
    await waitFor(() => expect(sessions).toHaveLength(n + 1));
    await waitFor(() => expect(view.result.current.session).toBe(sessions[n]));
    return sessions[n];
  };
  return { client, log, sessions, started, module, view, said, setAfk, holdLoad, joined,
    get v() { return view.result.current; } };
}

describe('web3.9 VOICE-AFK: a pending move joins the AFK call, listen-only, once', () => {
  it('a pending move joins once and never loops', async () => {
    const h = harness();
    h.setAfk({ channels: AFK_SET, pending: move() });
    await waitFor(() => expect(h.sessions).toHaveLength(1));
    expect(h.started).toHaveLength(1);
    expect(h.started[0].channelId).toBe(AFK_CH);
    expect(h.started[0].opts.listenOnly).toBe(true);
    expect(h.v.channelId).toBe(AFK_CH);
    // The same move again (a new object, the same key): nothing.
    h.setAfk({ channels: AFK_SET, pending: move() });
    h.setAfk({ channels: AFK_SET, pending: { ...move() } });
    await flush();
    expect(h.started).toHaveLength(1);
    // A new key joins again (another community's AFK channel), once the person is out of the call it would leave.
    act(() => h.v.leave());
    await flush();
    h.setAfk({ channels: AFK_SET, pending: moveB() });
    await waitFor(() => expect(h.sessions).toHaveLength(2));
    expect(h.started.map((s) => s.channelId)).toEqual([AFK_CH, B_AFK]);
    // Left, the same move still does nothing: the key clears only when pending turns null; then it joins again.
    act(() => h.v.leave());
    await flush();
    h.setAfk({ channels: AFK_SET, pending: moveB() });
    await flush();
    expect(h.started).toHaveLength(2);
    h.setAfk({ channels: AFK_SET, pending: null });
    await flush();
    expect(h.started).toHaveLength(2);
    h.setAfk({ channels: AFK_SET, pending: moveB() });
    await waitFor(() => expect(h.sessions).toHaveLength(3));
    expect(h.started.map((s) => s.channelId)).toEqual([AFK_CH, B_AFK, B_AFK]);
  });

  it('a failed AFK join shows the line and stops', async () => {
    const h = harness({ fails: (id) => id === AFK_CH });
    expect(h.v.afkFailed).toBeNull();
    h.setAfk({ channels: AFK_SET, pending: move() });
    await waitFor(() => expect(h.v.afkFailed).toEqual({ channelId: AFK_CH, name: 'AFK' }));
    expect(h.started).toHaveLength(1);
    expect(h.v.channelId).toBeNull();
    // Fix round 1 (I-1): with no dock, the move and why it failed go to the region that outlives the dock.
    expect(h.v.lasting).toBe(`${MOVED}. ${t('voice.failed')}`);
    // No retry: not by the same move again, not by time, not through the recovery loop.
    h.setAfk({ channels: AFK_SET, pending: move() });
    await act(async () => { await new Promise<void>((r) => setTimeout(r, 1_200)); });
    expect(h.started).toHaveLength(1);
    expect(h.v.recoveryChannelId).toBeNull();
    expect(h.v.afkFailed).toEqual({ channelId: AFK_CH, name: 'AFK' });
    // The person's leave clears the line.
    act(() => h.v.leave());
    expect(h.v.afkFailed).toBeNull();
  });

  it('a failed AFK join line is cleared by the next join', async () => {
    const h = harness({ fails: (id) => id === AFK_CH });
    h.setAfk({ channels: AFK_SET, pending: move() });
    await waitFor(() => expect(h.v.afkFailed).not.toBeNull());
    act(() => h.v.join(GENV));
    expect(h.v.afkFailed).toBeNull();
    await waitFor(() => expect(h.sessions).toHaveLength(1));
    expect(h.v.afkFailed).toBeNull();
  });

  it('a failed move followed by three community re-reads is one join attempt (fix round 1, I-3)', async () => {
    const h = harness({ fails: (id) => id === AFK_CH });
    h.setAfk({ channels: AFK_SET, pending: move() });
    await waitFor(() => expect(h.v.afkFailed).not.toBeNull());
    // Each re-read (op 54, a reconnect) lands a new read (a new seq) that says pending=1 again within the TTL; a
    // reconnect also passes through null (an offline status clears the slice).
    for (let i = 0; i < 3; i++) {
      h.setAfk({ channels: AFK_SET, pending: null });
      await flush();
      h.setAfk({ channels: AFK_SET, pending: move({ seq: 2 + i }) });
      await flush();
      h.setAfk({ channels: AFK_SET, pending: move({ seq: 20 + i }) });
      await flush();
    }
    expect(h.started).toHaveLength(1);
    expect(h.v.afkFailed).toEqual({ channelId: AFK_CH, name: 'AFK' });
    // N-4: a leave is not the person's own join. The hold stays, the line goes, and a later read joins nothing.
    act(() => h.v.leave());
    expect(h.v.afkFailed).toBeNull();
    h.setAfk({ channels: AFK_SET, pending: move({ seq: 30 }) });
    await flush();
    expect(h.started).toHaveLength(1);
  });

  it('fail, leave, then a new-seq pending starts nothing; the person’s own join ends the hold (N-4)', async () => {
    let fail = true;
    const h = harness({ fails: (id) => id === AFK_CH && fail });
    h.setAfk({ channels: AFK_SET, pending: move() });
    await waitFor(() => expect(h.v.afkFailed).not.toBeNull());
    act(() => h.v.leave());
    fail = false;
    h.setAfk({ channels: AFK_SET, pending: move({ seq: 5 }) });
    await flush();
    expect(h.started).toHaveLength(1);
    // Control: the person's own join clears the hold, so the next sweep's read moves them.
    await h.joined(GENV);
    clock.skew = AFK_MIN_IDLE_MS + 1_000;
    h.setAfk({ channels: AFK_SET, pending: move({ seq: 6 }) });
    await waitFor(() => expect(h.started.map((s) => s.channelId)).toEqual([AFK_CH, GENV, AFK_CH]));
  });

  it('the person’s own join also ends a failed move’s hold (fix round 1, I-3)', async () => {
    let fail = true;
    const h = harness({ fails: (id) => id === AFK_CH && fail });
    h.setAfk({ channels: AFK_SET, pending: move() });
    await waitFor(() => expect(h.v.afkFailed).not.toBeNull());
    fail = false;
    await h.joined(GENV);
    // Later the sweep moves this call; its read is a new move now.
    clock.skew = AFK_MIN_IDLE_MS + 1_000;
    h.setAfk({ channels: AFK_SET, pending: move({ seq: 2 }) });
    await waitFor(() => expect(h.started.map((s) => s.channelId)).toEqual([AFK_CH, GENV, AFK_CH]));
  });

  it('joining the AFK channel by click is listen-only', async () => {
    const h = harness();
    await h.joined(AFK_CH);
    expect(h.started[0].opts.listenOnly).toBe(true);
    // Control: an ordinary channel is not.
    act(() => h.v.leave());
    await flush();
    await h.joined(GENV);
    expect(h.started[1].opts.listenOnly ?? false).toBe(false);
  });

  it('a click into the AFK channel is listen-only from the afk: slice alone (fix round 1, I-2)', async () => {
    const h = harness({ afk: { channels: NONE, pending: null } });
    await h.joined(B_AFK);
    expect(h.started[0].opts.listenOnly).toBe(true);
  });

  it('a restore into AFK while the slice lags asks for no microphone, and joins listen-only once it arrives (fix round 1, I-2)', async () => {
    const h = harness({ lagging: true, afk: { channels: NONE, pending: null } });
    act(() => h.v.restore(AFK_CH, false, false));
    await flush();
    // Held: no start, so nothing asked for the microphone.
    expect(h.started).toHaveLength(0);
    act(() => { h.client.set(`afk:${A}`, afkOf(AFK_CH)); });
    await waitFor(() => expect(h.started).toHaveLength(1));
    expect(h.started[0].channelId).toBe(AFK_CH);
    expect(h.started[0].opts.listenOnly).toBe(true);
  });

  it('a restore into an ordinary channel waits for the same slice and then asks for the microphone (control)', async () => {
    const h = harness({ lagging: true, afk: { channels: NONE, pending: null } });
    act(() => h.v.restore(GENV, false, false));
    await flush();
    expect(h.started).toHaveLength(0);
    act(() => { h.client.set(`afk:${A}`, afkOf(AFK_CH)); });
    await waitFor(() => expect(h.started).toHaveLength(1));
    expect(h.started[0].opts.listenOnly ?? false).toBe(false);
  });

  it('a join whose AFK status never loads fails closed: no microphone, and the failure is shown (fix round 1, I-2)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = harness({ lagging: true, afk: { channels: NONE, pending: null } });
    act(() => h.v.restore(AFK_CH, false, false));
    await act(() => vi.advanceTimersByTimeAsync(AFK_STATUS_WAIT_MS + 100));
    expect(h.started).toHaveLength(0);
    expect(h.v.notice).toEqual({ channelId: AFK_CH, key: 'voice.failed' });
    expect(h.v.lasting).toBe(t('voice.failed'));
    expect(h.v.channelId).toBeNull();
  });

  it('the fail-closed join keeps the previous call (fix round 2, m-5)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = harness();
    const general = await h.joined(GENV);
    // Community B's afk: read failed and nothing has landed since.
    act(() => { h.client.set(`afk:${B}`, null); });
    act(() => h.v.join(B_GEN));
    await act(() => vi.advanceTimersByTimeAsync(AFK_STATUS_WAIT_MS + 100));
    expect(h.started).toHaveLength(1);
    expect(general.leave).not.toHaveBeenCalled();
    expect(h.v.session).toBe(general);
    expect(h.v.channelId).toBe(GENV);
    expect(h.v.notice).toEqual({ channelId: B_GEN, key: 'voice.failed' });
    expect(h.v.joining).toBe(false);
  });

  it('a click that waits shows the dock joining, and proceeds once a retried read lands (fix round 2, R-AFK3 c)', async () => {
    const h = harness({ afk: { channels: NONE, pending: null } });
    // A failed read left community B's snapshot null; the worker's retry lands it later.
    act(() => { h.client.set(`afk:${B}`, null); });
    act(() => h.v.join(B_AFK));
    await flush();
    expect(h.started).toHaveLength(0);
    expect(h.v.channelId).toBe(B_AFK);
    expect(h.v.joining).toBe(true);
    expect(h.v.session).toBeNull();
    act(() => { h.client.set(`afk:${B}`, afkOf(B_AFK)); });
    await waitFor(() => expect(h.sessions).toHaveLength(1));
    expect(h.started[0].opts.listenOnly).toBe(true);
    expect(h.v.joining).toBe(false);
    // And an ordinary channel of that community, after the same kind of wait, joins normally.
    act(() => h.v.leave());
    await flush();
    act(() => { h.client.set(`afk:${B}`, null); });
    act(() => h.v.join(B_GEN));
    await flush();
    expect(h.started).toHaveLength(1);
    expect(h.v.joining).toBe(true);
    act(() => { h.client.set(`afk:${B}`, afkOf(B_AFK)); });
    await waitFor(() => expect(h.sessions).toHaveLength(2));
    expect(h.started[1].opts.listenOnly ?? false).toBe(false);
  });

  it('with a snapshot present a join starts at once (fix round 2, R-AFK3 a)', async () => {
    const h = harness();
    act(() => h.v.join(B_GEN));
    await flush();
    expect(h.started).toHaveLength(1);
    expect(h.started[0].opts.listenOnly ?? false).toBe(false);
  });

  it('a lost AFK call recovers listen-only while the slices lag (fix round 1, I-2)', async () => {
    const h = harness({ lagging: true, afk: { channels: NONE, pending: null } });
    h.setAfk({ channels: NONE, pending: move() });
    await waitFor(() => expect(h.sessions).toHaveLength(1));
    await waitFor(() => expect(h.v.session).toBe(h.sessions[0]));
    expect(h.started[0].opts.listenOnly).toBe(true);
    // The room is lost; the recovery joins the same channel by itself, with nothing in the slices naming it AFK.
    act(() => h.sessions[0].update({ phase: 'ended', error: 'E_DISCONNECTED' }));
    await waitFor(() => expect(h.started).toHaveLength(2), { timeout: 3_000 });
    expect(h.started[1].channelId).toBe(AFK_CH);
    expect(h.started[1].opts.listenOnly).toBe(true);
  });

  it('leaving the AFK call keeps voice.self', async () => {
    const h = harness();
    const selfWrites = () => h.client.callsOf('setSetting').filter((c) => c.key === SETTINGS.voiceSelf);
    await h.joined(AFK_CH);
    act(() => h.v.toggleDeafen());
    act(() => h.v.toggleDeafen());
    act(() => h.v.toggleMute());
    act(() => h.v.selfMute());
    act(() => h.v.selfDeafen());
    expect(selfWrites()).toEqual([]);
    act(() => h.v.leave());
    await flush();
    expect(selfWrites()).toEqual([]);
    // Control: an ordinary call's mute is kept for the next call, as before.
    await h.joined(GENV);
    act(() => h.v.toggleMute());
    expect(selfWrites()).toEqual([{ m: 'setSetting', key: SETTINGS.voiceSelf, value: 'muted' }]);
  });

  it('a mute press in AFK says everyone is muted there (fix round 1, m-2)', async () => {
    const h = harness();
    await h.joined(AFK_CH);
    act(() => h.v.toggleMute());
    await waitFor(() => expect(h.v.announcement).toBe(t('afk.stage.muted', { channel: 'AFK' })));
    expect(h.sessions[0].state.muted).toBe(true);
  });

  it('the cut before a move is silent', async () => {
    const h = harness();
    const first = await h.joined(GENV);
    // The call has run past the shortest AFK timeout, so it is the one the sweep cuts.
    clock.skew = AFK_MIN_IDLE_MS + 1_000;
    // The move is known while the cut arrives; its join waits on the call module.
    const release = h.holdLoad();
    h.setAfk({ channels: AFK_SET, pending: move() });
    act(() => { h.client.set('call', callState({ phase: 'removed', channelId: GENV, callId: GENV })); });
    h.setAfk({ channels: AFK_SET, pending: move() });
    await waitFor(() => expect(first.leave).toHaveBeenCalledWith('removed'));
    expect(h.v.notice).toBeNull();
    expect(h.v.lasting).toBe('');
    release();
    await waitFor(() => expect(h.sessions).toHaveLength(2));
    expect(h.v.channelId).toBe(AFK_CH);
    expect(h.v.notice).toBeNull();
  });

  it('a cut with no move pending still says why (control)', async () => {
    const h = harness();
    await h.joined(GENV);
    act(() => { h.client.set('call', callState({ phase: 'removed', channelId: GENV, callId: GENV })); });
    h.setAfk({ channels: AFK_SET, pending: null });
    await waitFor(() => expect(h.v.notice).toEqual({ channelId: GENV, key: 'voice.removed' }), HELD);
    expect(h.v.lasting).toBe(t('voice.removed'));
  });

  it('a cut in another community than the move’s still says why (control)', async () => {
    const h = harness();
    await h.joined(GENV);
    clock.skew = AFK_MIN_IDLE_MS + 1_000;
    h.holdLoad();
    h.setAfk({ channels: AFK_SET, pending: moveB() });
    act(() => { h.client.set('call', callState({ phase: 'removed', channelId: GENV, callId: GENV })); });
    h.setAfk({ channels: AFK_SET, pending: moveB() });
    await waitFor(() => expect(h.v.notice).toEqual({ channelId: GENV, key: 'voice.removed' }), HELD);
  });

  it('the room’s own removal before a move is silent too', async () => {
    const h = harness();
    await h.joined(GENV);
    clock.skew = AFK_MIN_IDLE_MS + 1_000;
    h.holdLoad();
    h.setAfk({ channels: AFK_SET, pending: move() });
    act(() => h.sessions[0].update({ phase: 'ended', error: 'E_REMOVED' }));
    expect(h.v.session).toBeNull();
    expect(h.v.notice).toBeNull();
    expect(h.v.lasting).toBe('');
  });

  it('a removal followed by pending announces only afk.moved (WEB-AFK)', async () => {
    const h = harness();
    await h.joined(GENV);
    clock.skew = AFK_MIN_IDLE_MS + 1_000;
    // The cut lands before the afk: read that says pending: nothing is shown or said yet.
    act(() => { h.client.set('call', callState({ phase: 'removed', channelId: GENV, callId: GENV })); });
    h.setAfk({ channels: AFK_SET, pending: null });
    await flush();
    expect(h.v.notice).toBeNull();
    expect(h.v.lasting).toBe('');
    // The read lands: the move joins, and only it is said.
    h.setAfk({ channels: AFK_SET, pending: move() });
    await waitFor(() => expect(h.v.channelId).toBe(AFK_CH));
    await act(async () => { await new Promise<void>((r) => setTimeout(r, REMOVED_HOLD_MS + 500)); });
    expect(h.v.notice).toBeNull();
    expect(h.v.lasting).toBe('');
    expect(h.said).not.toContain(t('voice.removed'));
    expect(h.said.filter((x) => x === MOVED)).toHaveLength(1);
  });

  it('a removal that no move follows is said once the hold ends (WEB-AFK control)', async () => {
    const h = harness();
    await h.joined(GENV);
    act(() => { h.client.set('call', callState({ phase: 'removed', channelId: GENV, callId: GENV })); });
    h.setAfk({ channels: AFK_SET, pending: null });
    await flush();
    expect(h.v.notice).toBeNull();
    await waitFor(() => expect(h.v.notice).toEqual({ channelId: GENV, key: 'voice.removed' }), HELD);
  });

  it('a stale pending after the move silences no later cut (fix round 1, m-1)', async () => {
    const h = harness();
    h.setAfk({ channels: AFK_SET, pending: move() });
    await waitFor(() => expect(h.sessions).toHaveLength(1));
    // The move's join is done; the client still reads pending (the server cleared it at admission, no notice yet).
    act(() => h.v.leave());
    await flush();
    await h.joined(GENV);
    h.setAfk({ channels: AFK_SET, pending: move() });
    act(() => { h.client.set('call', callState({ phase: 'removed', channelId: GENV, callId: GENV })); });
    h.setAfk({ channels: AFK_SET, pending: move() });
    await waitFor(() => expect(h.v.notice).toEqual({ channelId: GENV, key: 'voice.removed' }), HELD);
    expect(h.v.lasting).toBe(t('voice.removed'));
    expect(h.started).toHaveLength(2);
  });

  it('a stale pending never leaves a newer call (fix round 1, m-1)', async () => {
    const h = harness();
    // A call in another community: the move is not for it.
    const hall = await h.joined(B_GEN);
    clock.skew = AFK_MIN_IDLE_MS + 1_000;
    h.setAfk({ channels: AFK_SET, pending: move() });
    await flush();
    expect(h.started).toHaveLength(1);
    expect(h.v.session).toBe(hall);
    expect(hall.leave).not.toHaveBeenCalled();
    // A call in the move's community that started after the cut (younger than the shortest timeout): not undone.
    const g = harness();
    const general = await g.joined(GENV);
    g.setAfk({ channels: AFK_SET, pending: move() });
    await flush();
    expect(g.started).toHaveLength(1);
    expect(g.v.session).toBe(general);
    expect(general.leave).not.toHaveBeenCalled();
  });

  it('a second sweep in the same community moves again, exactly once (fix round 3, R-AFK4 / N-2)', async () => {
    const h = harness();
    // Move 1.
    h.setAfk({ channels: AFK_SET, pending: move({ seq: 1 }) });
    await waitFor(() => expect(h.v.session).toBe(h.sessions[0]));
    // The person joins General in that community; the client's snapshot still says pending (no notify at admission).
    const general = await h.joined(GENV);
    h.setAfk({ channels: AFK_SET, pending: move({ seq: 1 }) });
    // They idle past the timeout; sweep 2 cuts them, and its re-read lands pending=1 again: true to true, no null.
    clock.skew = AFK_MIN_IDLE_MS + 1_000;
    act(() => { h.client.set('call', callState({ phase: 'removed', channelId: GENV, callId: GENV })); });
    h.setAfk({ channels: AFK_SET, pending: move({ seq: 1 }) });
    await waitFor(() => expect(general.leave).toHaveBeenCalledWith('removed'));
    h.setAfk({ channels: AFK_SET, pending: move({ seq: 2 }) });
    await waitFor(() => expect(h.started.map((s) => s.channelId)).toEqual([AFK_CH, GENV, AFK_CH]));
    expect(h.started[2].opts.listenOnly).toBe(true);
    // The same read again: no third move.
    h.setAfk({ channels: AFK_SET, pending: { ...move({ seq: 2 }) } });
    await flush();
    expect(h.started).toHaveLength(3);
  });

  it('two re-reads that say pending with no cut in between do not move twice (fix round 3, R-AFK4)', async () => {
    const h = harness();
    h.setAfk({ channels: AFK_SET, pending: move({ seq: 1 }) });
    await waitFor(() => expect(h.v.session).toBe(h.sessions[0]));
    clock.skew = AFK_MIN_IDLE_MS + 1_000;
    // Already in the AFK call: each new read is a no-op.
    h.setAfk({ channels: AFK_SET, pending: move({ seq: 2 }) });
    await flush();
    h.setAfk({ channels: AFK_SET, pending: move({ seq: 3 }) });
    await flush();
    expect(h.started).toHaveLength(1);
    expect(h.sessions[0].leave).not.toHaveBeenCalled();
    expect(h.v.session).toBe(h.sessions[0]);
  });

  it('the move is announced once', async () => {
    const h = harness();
    // The join takes a while (the call module loads), so anything said before it ends is heard on its own.
    const release = h.holdLoad();
    h.setAfk({ channels: AFK_SET, pending: move() });
    await flush();
    release();
    await waitFor(() => expect(h.sessions).toHaveLength(1));
    await waitFor(() => expect(h.v.announcement).toBe(MOVED));
    h.setAfk({ channels: AFK_SET, pending: move() });
    h.setAfk({ channels: AFK_SET, pending: { ...move() } });
    await act(async () => { await new Promise<void>((r) => setTimeout(r, 300)); });
    expect(h.said.filter((s) => s === MOVED)).toHaveLength(1);
    expect(h.v.announcement).toBe(MOVED);
  });
});

describe('web3.9 VOICE-AFK fix round 1 (I-1): a failed move is heard in the document', () => {
  it('the failed move’s line reaches the live region that outlives the dock', async () => {
    skewClock();
    const client = new FakeClient();
    client.set('settings', {});
    client.set('communities', [{ id: A, name: 'Midgard', owner: 'ee'.repeat(16) }]);
    client.set('dms', []);
    client.set(`channels:${A}`, [...CHANNELS, voice(AFK_CH, A, 'AFK', 1 << 30)]);
    client.set(`afk:${A}`, afkOf(AFK_CH));
    client.set('call', callState());
    const module: VoiceModule = {
      isVoiceSupported: () => ({ ok: true as const, path: 'insertable-streams' as const }),
      localDecodeList: () => 'vp8',
      browserDeps: (bridge) => ({ bridge } as unknown as ReturnType<VoiceModule['browserDeps']>),
      startPageCall: vi.fn<VoiceModule['startPageCall']>(() => Promise.reject(Object.assign(new Error('E_CALL_FULL'), { code: 'E_CALL_FULL' }))),
      bindPushToTalk: () => () => undefined,
      volumesFromSettings: () => ({}), streamVolumesFromSettings: () => ({}),
    };
    const deps: VoiceDeps = { load: () => Promise.resolve(module), createCallContext: () => null,
      createSounds: () => ({ play: () => undefined, startRing: () => undefined, stopRing: () => undefined, dispose: () => undefined }) };
    // The shell's two regions as Shell renders them: the dock's (only with a call) and the one that outlives it.
    function Probe({ afk }: { afk: NonNullable<UseCallOptions['afk']> }) {
      const v = useCall({ client, call: client.get('call'), settings: {}, whereOf: () => 'AFK', onLeft: () => undefined,
        stageShown: () => false, afk });
      return createElement('div', null,
        v.channelId !== null ? createElement('div', { className: 'd-voice-dock' }, createElement('p', { role: 'status' }, v.announcement)) : null,
        createElement('p', { className: 'd-sr-only dw-voice-lasting', role: 'status' }, v.lasting));
    }
    const tree = (afk: NonNullable<UseCallOptions['afk']>) => createElement(VoiceDepsContext.Provider, { value: deps }, createElement(Probe, { afk }));
    const view = render(tree({ channels: AFK_SET, pending: null }));
    view.rerender(tree({ channels: AFK_SET, pending: move() }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(`${MOVED}. ${t('voice.full')}`));
    expect(document.querySelector('.d-voice-dock')).toBeNull();
    expect(document.querySelector('.dw-voice-lasting')).toHaveTextContent(MOVED);
  });
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

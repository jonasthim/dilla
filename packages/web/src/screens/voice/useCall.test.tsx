// web3.9 VOICE-AFK: the shell's side of the AFK move. A pending move (the server's sweep moved this device, R33) joins the
// community's AFK channel once, listen-only, says so once, and never retries; a failed join leaves the dock's line.
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { SETTINGS } from '@dilla/client-core';
import type { PageCallOptions } from '../../call/session.ts';
import { t } from '../../strings/index.ts';
import { A, CHANNELS, FakeClient, FakeSession, GENV, callState } from '../../test/fake-client.ts';
import { useCall, VoiceDepsContext, type UseCallOptions, type VoiceDeps, type VoiceModule } from './useCall.tsx';

const AFK_CH = 'af'.repeat(16);
const B = 'b7'.repeat(16);
const B_AFK = 'bf'.repeat(16);
const AFK_SET: ReadonlySet<string> = new Set([AFK_CH, B_AFK]);
type Pending = NonNullable<UseCallOptions['afk']>['pending'];
const move = (over: Partial<NonNullable<Pending>> = {}): NonNullable<Pending> => ({ communityId: A, channelId: AFK_CH, name: 'AFK', ...over });
const MOVED = t('afk.moved', { channel: 'AFK' });

/** As the real session: a listen-only call stays muted whatever is pressed (setMuted is a no-op). */
class Session extends FakeSession {
  override setMuted(on: boolean): void {
    if (this.state.listenOnly) { this.log.push(`muted:noop:${String(on)}`); return; }
    super.setMuted(on);
  }
}

const flush = async () => { await act(async () => { for (let i = 0; i < 10; i++) await new Promise<void>((r) => setTimeout(r, 0)); }); };

afterEach(() => { vi.useRealTimers(); });

function harness(o: { fails?: (channelId: string) => boolean; afk?: UseCallOptions['afk'] } = {}) {
  const client = new FakeClient();
  client.set('settings', {});
  client.set(`channels:${A}`, [...CHANNELS,
    { id: AFK_CH, communityId: A, kind: 1, mode: 0, name: 'AFK', topic: '', parentId: null, position: 1 << 30, slowmode: 0, announcement: false, group: 'unsupported' }]);
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
    volumesFromSettings: () => ({}),
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
      whereOf: (id) => (id === AFK_CH ? 'AFK' : 'general'), onLeft: () => undefined, stageShown: () => false,
      ...(p.afk !== undefined ? { afk: p.afk } : {}),
    });
    if (said.at(-1) !== v.announcement) said.push(v.announcement);
    return v;
  }, { wrapper, initialProps: { afk: o.afk ?? { channels: AFK_SET, pending: null } } });
  const setAfk = (afk: NonNullable<UseCallOptions['afk']>) => { act(() => view.rerender({ afk })); };
  return { client, log, sessions, started, module, view, said, setAfk, holdLoad,
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
    // A new key joins again (another community's AFK channel).
    h.setAfk({ channels: AFK_SET, pending: move({ communityId: B, channelId: B_AFK, name: 'AFK' }) });
    await waitFor(() => expect(h.sessions).toHaveLength(2));
    expect(h.started.map((s) => s.channelId)).toEqual([AFK_CH, B_AFK]);
    // Left, the same move still does nothing: the key clears only when pending turns null; then it joins again.
    act(() => h.v.leave());
    await flush();
    h.setAfk({ channels: AFK_SET, pending: move({ communityId: B, channelId: B_AFK, name: 'AFK' }) });
    await flush();
    expect(h.started).toHaveLength(2);
    h.setAfk({ channels: AFK_SET, pending: null });
    await flush();
    expect(h.started).toHaveLength(2);
    h.setAfk({ channels: AFK_SET, pending: move({ communityId: B, channelId: B_AFK, name: 'AFK' }) });
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

  it('joining the AFK channel by click is listen-only', async () => {
    const h = harness();
    act(() => h.v.join(AFK_CH));
    await waitFor(() => expect(h.sessions).toHaveLength(1));
    expect(h.started[0].opts.listenOnly).toBe(true);
    // Control: an ordinary channel is not.
    act(() => h.v.leave());
    await flush();
    act(() => h.v.join(GENV));
    await waitFor(() => expect(h.sessions).toHaveLength(2));
    expect(h.started[1].opts.listenOnly ?? false).toBe(false);
  });

  it('leaving the AFK call keeps voice.self', async () => {
    const h = harness();
    const selfWrites = () => h.client.callsOf('setSetting').filter((c) => c.key === SETTINGS.voiceSelf);
    act(() => h.v.join(AFK_CH));
    await waitFor(() => expect(h.sessions).toHaveLength(1));
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
    act(() => h.v.join(GENV));
    await waitFor(() => expect(h.sessions).toHaveLength(2));
    act(() => h.v.toggleMute());
    expect(selfWrites()).toEqual([{ m: 'setSetting', key: SETTINGS.voiceSelf, value: 'muted' }]);
  });

  it('the cut before a move is silent', async () => {
    const h = harness();
    act(() => h.v.join(GENV));
    await waitFor(() => expect(h.sessions).toHaveLength(1));
    const first = h.sessions[0];
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
    act(() => h.v.join(GENV));
    await waitFor(() => expect(h.sessions).toHaveLength(1));
    act(() => { h.client.set('call', callState({ phase: 'removed', channelId: GENV, callId: GENV })); });
    h.setAfk({ channels: AFK_SET, pending: null });
    await waitFor(() => expect(h.v.notice).toEqual({ channelId: GENV, key: 'voice.removed' }));
    expect(h.v.lasting).toBe(t('voice.removed'));
  });

  it('a cut in another community than the move’s still says why (control)', async () => {
    const h = harness();
    act(() => h.v.join(GENV));
    await waitFor(() => expect(h.sessions).toHaveLength(1));
    h.holdLoad();
    h.setAfk({ channels: AFK_SET, pending: move({ communityId: B, channelId: B_AFK }) });
    act(() => { h.client.set('call', callState({ phase: 'removed', channelId: GENV, callId: GENV })); });
    h.setAfk({ channels: AFK_SET, pending: move({ communityId: B, channelId: B_AFK }) });
    await waitFor(() => expect(h.v.notice).toEqual({ channelId: GENV, key: 'voice.removed' }));
  });

  it('the room’s own removal before a move is silent too', async () => {
    const h = harness();
    act(() => h.v.join(GENV));
    await waitFor(() => expect(h.sessions).toHaveLength(1));
    h.holdLoad();
    h.setAfk({ channels: AFK_SET, pending: move() });
    act(() => h.sessions[0].update({ phase: 'ended', error: 'E_REMOVED' }));
    expect(h.v.session).toBeNull();
    expect(h.v.notice).toBeNull();
    expect(h.v.lasting).toBe('');
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

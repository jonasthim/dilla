// The shell's side of a call (web-3 task 9, flow 06): it starts and ends the page call session (L-WEB-50) through the
// lazy call module (L-WEB-51), drives the session from the worker's `call` slice and binds the voice shortcuts and push to
// talk. The session is the only holder of media and keys; this hook keeps none of either.
//
// The call slice drives the session (task-8b rulings): phase 'paused' (RV-3) calls setPaused(true) and the way back to
// 'in' calls setPaused(false); 'blocked' or 'removed' calls leave() and never setPaused(false), so a block can never
// unpause media on its way out.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { CallState, CoreClient } from '@dilla/client-core';
import { SETTINGS } from '@dilla/client-core';
import { isPushToTalkKey } from '@dilla/ui';
import { loadCallModule, type CallModule } from '../../call/load.ts';
import type { PageCall, PageCallState } from '../../call/session.ts';
import { createSounds, type Sounds } from '../../call/sounds.ts';
import { errorOf } from '../../core/errors.ts';
import { t, type StringKey } from '../../strings/index.ts';
import { joinFailureKey } from '../shell-model.ts';

/** What the shell needs of the lazy call module. */
export type VoiceModule = Pick<CallModule, 'startPageCall' | 'isVoiceSupported' | 'localDecodeList' | 'bindPushToTalk' | 'browserDeps'
  | 'volumesFromSettings'>;

/** The shell's voice dependencies: the call module (loaded on the first join) and the sounds. Tests give doubles. */
export interface VoiceDeps {
  load(): Promise<VoiceModule>;
  createSounds(): Sounds;
}

let audio: AudioContext | null = null;
/** One AudioContext for the sounds, made on first use; null where the browser has none. */
function soundContext(): AudioContext | null {
  if (audio !== null) return audio;
  const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  if (Ctor === undefined) return null;
  try { audio = new Ctor(); } catch { return null; }
  return audio;
}

export const VoiceDepsContext = createContext<VoiceDeps>({ load: loadCallModule, createSounds: () => createSounds(soundContext) });

/** A transient notice of a start or a control (micDenied and the like are read from the session's state instead). */
export interface CallNotice { channelId: string; key: StringKey }

export interface CallView {
  /** The channel or DM this device is in, or is joining. */
  channelId: string | null;
  joining: boolean;
  session: PageCall | null;
  state: PageCallState | null;
  /** The dock's polite announcement (join, mute, deafen, the input mode, the end of a pause, the outgoing ring). */
  announcement: string;
  /**
   * What is said after the dock is gone (task-9 rulings, review I6): "You left {where}.", and a block or a removal while
   * the stage is not on screen. The shell renders it in a status region that outlives the dock.
   */
  lasting: string;
  announce: (text: string) => void;
  /** True until the current pause banner took focus once, wherever it shows (review m4). */
  pauseFocusPending: boolean;
  markPauseFocused: () => void;
  notice: CallNotice | null;
  /** The channel whose call this device left because of a block while in it (voice.blocked rather than blockedJoin). */
  blockedMidCall: string | null;
  /** True once per attached join: the stage that shows it moves focus to its first control and takes the flag. */
  takeStageFocus: () => boolean;
  unsupported: boolean;
  join: (channelId: string) => void;
  leave: () => void;
  closeUnsupported: () => void;
  toggleMute: () => void;
  toggleDeafen: () => void;
  toggleCamera: () => void;
  toggleShare: () => void;
  setVolume: (userId: string, volume: number) => void;
}

export interface UseCallOptions {
  client: CoreClient;
  call: CallState | undefined;
  settings: Readonly<Record<string, string>>;
  /** The channel's or DM's name for {where}. */
  whereOf(channelId: string): string;
  /** Called once a leave the person asked for finished: focus goes back to where the call came from. */
  onLeft(channelId: string): void;
  /** Whether the call's stage is on screen (its notices then speak for themselves). */
  stageShown(channelId: string): boolean;
}

const CODE_M = 'KeyM';
const CODE_D = 'KeyD';

export function useCall(o: UseCallOptions): CallView {
  const deps = useContext(VoiceDepsContext);
  const { client } = o;
  const [session, setSession] = useState<PageCall | null>(null);
  const [state, setState] = useState<PageCallState | null>(null);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [lasting, setLasting] = useState('');
  const [pauseFocusPending, setPauseFocusPending] = useState(false);
  const [notice, setNotice] = useState<CallNotice | null>(null);
  const [blockedMidCall, setBlockedMidCall] = useState<string | null>(null);
  const stageFocus = useRef(false);
  const [unsupported, setUnsupported] = useState(false);
  const sessionRef = useRef<PageCall | null>(null);
  const channelRef = useRef<string | null>(null);
  const unsubscribe = useRef<(() => void) | null>(null);
  const starting = useRef(false);
  const mounted = useRef(true);
  const paused = useRef(false);
  const module = useRef<VoiceModule | null>(null);
  // The join button the unsupported dialog was opened from: focus returns there when it closes (flow 06).
  const opener = useRef<HTMLElement | null>(null);
  const live = useRef(o);
  live.current = o;

  const announce = useCallback((text: string) => setAnnouncement(text), []);

  /** Forgets the session (its leave is the caller's); nothing of it is used after this. */
  const detach = useCallback(() => {
    unsubscribe.current?.();
    unsubscribe.current = null;
    sessionRef.current = null;
    channelRef.current = null;
    paused.current = false;
    setSession(null);
    setState(null);
    setChannelId(null);
  }, []);

  const attach = useCallback((next: PageCall, id: string) => {
    sessionRef.current = next;
    channelRef.current = id;
    setSession(next);
    setState(next.state);
    setChannelId(id);
    unsubscribe.current = next.subscribe(() => {
      if (sessionRef.current !== next) return;
      setState(next.state);
      // The room ended on its own (the session already left): nothing to drive any more.
      if (next.state.phase === 'ended') detach();
    });
    stageFocus.current = true;
    announce(t('voice.announce.joined', { where: live.current.whereOf(id) }));
  }, [announce, detach]);

  const join = useCallback((id: string) => {
    if (starting.current || channelRef.current === id) return;
    starting.current = true;
    const from = document.activeElement;
    void (async () => {
      try {
        const mod = await deps.load();
        module.current = mod;
        if (!mod.isVoiceSupported().ok) {
          opener.current = from instanceof HTMLElement && from !== document.body ? from : null;
          setUnsupported(true);
          return;
        }
        // One call at a time: the current one is left first, and the next starts only once that leave is done.
        const previous = sessionRef.current;
        if (previous !== null) {
          detach();
          await previous.leave('switch');
        }
        setNotice(null);
        setBlockedMidCall(null);
        channelRef.current = id;
        setChannelId(id);
        setJoining(true);
        const settings = client.get('settings') ?? {};
        const next = await mod.startPageCall(mod.browserDeps(client), { channelId: id, vdec: mod.localDecodeList() }, {
          instanceId: client.get('account')?.instance?.id ?? '',
          input: settings[SETTINGS.voiceInput] ?? '',
          output: settings[SETTINGS.voiceOutput] ?? '',
          mode: settings[SETTINGS.voiceMode] === 'ptt' ? 'ptt' : 'vad',
          noise: settings[SETTINGS.voiceNoise] === 'off' ? 'off' : 'on',
          volumes: mod.volumesFromSettings(settings),
        });
        // The shell unmounted while the start was pending: nobody drives this call, so it ends at once.
        if (!mounted.current) { void next.leave('user'); return; }
        attach(next, id);
      } catch (e) {
        if (sessionRef.current === null) { channelRef.current = null; setChannelId(null); }
        const key = joinFailureKey(errorOf(e).code);
        if (key !== null) setNotice({ channelId: id, key });
      } finally {
        starting.current = false;
        setJoining(false);
      }
    })();
  }, [deps, client, attach, detach]);

  const leave = useCallback(() => {
    const current = sessionRef.current;
    const id = channelRef.current;
    if (current === null || id === null) return;
    detach();
    void current.leave('user').finally(() => {
      setLasting(t('voice.announce.left', { where: live.current.whereOf(id) }));
      live.current.onLeft(id);
    });
  }, [detach]);

  const toggleMute = useCallback(() => {
    const s = sessionRef.current;
    if (s === null) return;
    const on = !s.state.muted;
    s.setMuted(on);
    announce(t(on ? 'voice.announce.muted' : 'voice.announce.unmuted'));
  }, [announce]);
  const toggleDeafen = useCallback(() => {
    const s = sessionRef.current;
    if (s === null) return;
    const on = !s.state.deafened;
    s.setDeafened(on);
    announce(t(on ? 'voice.announce.deafened' : 'voice.announce.undeafened'));
  }, [announce]);
  const shareRefused = useCallback((e: unknown) => {
    const id = channelRef.current;
    const code = errorOf(e).code;
    if (id !== null && code === 'E_CALL_SHARERS_FULL') setNotice({ channelId: id, key: 'voice.sharersFull' });
  }, []);
  const toggleCamera = useCallback(() => {
    const s = sessionRef.current;
    if (s !== null) s.setCamera(!s.state.camera).catch(shareRefused);
  }, [shareRefused]);
  const toggleShare = useCallback(() => {
    const s = sessionRef.current;
    if (s !== null) s.setSharing(!s.state.sharing).catch(shareRefused);
  }, [shareRefused]);
  const setVolume = useCallback((userId: string, volume: number) => {
    sessionRef.current?.setVolume(userId, volume);
    client.call({ m: 'setSetting', key: SETTINGS.voiceVolume(userId), value: String(volume) }).catch(() => undefined);
  }, [client]);

  const closeUnsupported = useCallback(() => {
    setUnsupported(false);
    const target = opener.current;
    opener.current = null;
    queueMicrotask(() => { if (target?.isConnected === true) target.focus(); });
  }, []);

  // The worker's call slice drives the session (RV-3 and the block rule above), on every slice change and again when a
  // session attaches, reading the newest slice the client holds rather than one a render captured (security-scanner
  // leads, fail-open state drift; defensive: React already renders the newest slice, so no test tells the two reads
  // apart, review m6). The call id of a call is its channel's id (protocol/09 § Voice), so the channel decides
  // whether a slice is this session's. The worker publishes phase 'in' before callJoin answers (L-TS-56 step 1), so an
  // attached session must always match a slice that says 'in' or 'paused' for its channel. Fail closed:
  // - 'paused' pauses it (once); only 'in' for this channel unpauses it, and no cleanup ever does;
  // - 'blocked' or 'removed' leaves with that reason;
  // - anything else (idle, failed, joining, leaving, or another channel: the worker is not in this call) tears it down;
  // - a setPaused or leave that throws or rejects tears the session down; nothing of it escapes.
  const teardown = useCallback((s: PageCall, reason: 'blocked' | 'removed') => {
    const id = channelRef.current;
    if (sessionRef.current === s) {
      // Focus inside the dock would fall to the page with it: it goes to the voice row the call came from (review I6).
      const inDock = document.activeElement?.closest('.dw-voice-dock') != null;
      detach();
      if (inDock && id !== null) live.current.onLeft(id);
    }
    try {
      s.leave(reason).catch(() => undefined);
    } catch {
      // The session's leave closes its key relay first; nothing more can be done from here.
    }
  }, [detach]);
  const safely = useCallback((s: PageCall, run: () => Promise<void>) => {
    try {
      run().catch(() => teardown(s, 'removed'));
    } catch {
      teardown(s, 'removed');
    }
  }, [teardown]);
  const slice = o.call;
  // f10app m2: the rejoin's wait for this device's earlier Remove (up to 30 s, the dock says "connecting") is said once in
  // the dock's status region, so a screen reader user knows why nothing happens yet.
  const rejoining = slice?.phase === 'joining' && slice.rejoining && slice.channelId === channelId && channelId !== null;
  useEffect(() => {
    if (rejoining && channelId !== null) announce(t('voice.announce.rejoining', { where: live.current.whereOf(channelId) }));
  }, [rejoining, channelId, announce]);
  useEffect(() => {
    const s = sessionRef.current;
    const id = channelRef.current;
    if (s === null || id === null) return;
    const now = client.get('call') ?? slice;
    const phase = now?.channelId === id ? now.phase : null;
    if (phase === 'paused') {
      if (!paused.current) {
        paused.current = true;
        setPauseFocusPending(true);
        safely(s, () => s.setPaused(true));
      }
    } else if (phase === 'in') {
      if (paused.current) {
        paused.current = false;
        setPauseFocusPending(false);
        safely(s, () => s.setPaused(false));
        announce(t('voice.resumed'));
      }
    } else if (phase === 'blocked' || phase === 'removed') {
      if (phase === 'blocked') setBlockedMidCall(id);
      else setNotice({ channelId: id, key: 'voice.removed' });
      // Off the stage, nothing else would say why the call ended (review I6).
      if (!live.current.stageShown(id)) setLasting(t(phase === 'blocked' ? 'voice.blocked' : 'voice.removed'));
      setPauseFocusPending(false);
      teardown(s, phase);
    } else {
      teardown(s, 'removed');
    }
  }, [slice, session, client, announce, safely, teardown]);

  // Control/⌘+Shift+M and Control/⌘+Shift+D while in voice (decision 1); no single-key shortcut, and none during an IME
  // composition. Either modifier works on every platform, as the Control/⌘+K entry does.
  useEffect(() => {
    if (session === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey) return;
      const code = e.code !== '' ? e.code : `Key${e.key.toUpperCase()}`;
      if (code === CODE_M) { e.preventDefault(); toggleMute(); }
      else if (code === CODE_D) { e.preventDefault(); toggleDeafen(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session, toggleMute, toggleDeafen]);

  // The input mode follows Settings → Voice during a call (review I2): the session switches first (push to talk closes the
  // microphone at once), the dock says which mode is in force, and the key binds only to the mode the session applied.
  const wanted = o.settings[SETTINGS.voiceMode] === 'ptt' ? 'ptt' : 'vad';
  useEffect(() => {
    if (session === null || session.state.mode === wanted) return;
    session.setMode(wanted);
    announce(t(wanted === 'ptt' ? 'settings.voice.ptt' : 'settings.voice.vad'));
  }, [session, wanted, announce]);
  // Push to talk (decision 2): only in ptt mode with a key that is one non-text key on its own; a stored key that is
  // not (an older rule saved KeyV) binds nothing, and Settings shows it as unset.
  const applied = state?.mode;
  const pttKey = o.settings[SETTINGS.voicePttKey];
  useEffect(() => {
    const mod = module.current;
    if (session === null || mod === null || applied !== 'ptt' || pttKey === undefined || !isPushToTalkKey(pttKey)) return;
    return mod.bindPushToTalk({ code: pttKey, onChange: down => session.pushToTalk(down) });
  }, [session, applied, pttKey]);

  // Leaving the shell (sign-out, a lost account) ends the call as the person's own leave.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const s = sessionRef.current;
      unsubscribe.current?.();
      if (s !== null) void s.leave('user');
    };
  }, []);

  return {
    channelId, joining, session, state, announcement, lasting, announce, notice, blockedMidCall, unsupported,
    pauseFocusPending, markPauseFocused: () => setPauseFocusPending(false),
    takeStageFocus: () => { const want = stageFocus.current; stageFocus.current = false; return want; },
    join, leave, closeUnsupported, toggleMute, toggleDeafen, toggleCamera, toggleShare, setVolume,
  };
}

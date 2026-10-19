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
  /** web3.3 fix round 2 (Minor 1): the call’s AudioContext, made synchronously in the join’s press so the browser lets it
   *  run (browsers start an AudioContext made outside a user gesture suspended, as after the module load and a switch’s
   *  leave). A new AudioContext by
   *  default; null where the browser has none. */
  createCallContext?(): AudioContext | null;
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

function callContext(): AudioContext | null {
  const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  if (Ctor === undefined) return null;
  try { return new Ctor(); } catch { return null; }
}
/** Closes a call context this hook made but never handed to a session (the session closes the ones it was given). */
function closeContext(ctx: AudioContext | null | undefined): void {
  if (ctx == null) return;
  try { void Promise.resolve(ctx.close()).catch(() => undefined); } catch { /* already closed */ }
}

export const VoiceDepsContext = createContext<VoiceDeps>({ load: loadCallModule, createSounds: () => createSounds(soundContext),
  createCallContext: callContext });

/** A transient notice of a start or a control (micDenied and the like are read from the session's state instead). `text`,
 *  when set, is the notice's words already filled (the outgoing ring's last line, product walk I6). */
export interface CallNotice { channelId: string; key: StringKey; text?: string }

/** A ring lasts 30 s (R5). */
export const RING_MS = 30_000;
/** Product walk I6: a DM call nobody answered ends this long after its outgoing ring ended (the grace covers an answer
 *  that is still connecting). */
export const UNANSWERED_LEAVE_MS = 5_000;

/**
 * The outgoing ring's line (R3, R7): `ringing {names}` while it rings, `{names} not rung: …` for the participants the
 * instance did not ring (product walk I6), `{name} declined.` per decline, `No answer.` once every ring ended (30 s, or
 * nobody left ringing or waiting) with nobody else in the call; null when there is nothing to say.
 */
export function outgoingText(outgoing: CallState['outgoing'], othersInCall: boolean, expired: boolean): string | null {
  if (outgoing === null) return null;
  const parts: string[] = [];
  if (outgoing.ringing.length > 0 && !expired) parts.push(t('call.outgoing.ringing', { names: outgoing.ringing.join(', ') }));
  if (outgoing.notRung.length > 0 && !othersInCall) parts.push(t('call.outgoing.notRung', { names: outgoing.notRung.join(', ') }));
  for (const name of outgoing.declined) parts.push(t('call.outgoing.declined', { name }));
  if (unanswered(outgoing, othersInCall, expired) && outgoing.declined.length === 0) parts.push(t('call.outgoing.noAnswer'));
  return parts.length > 0 ? parts.join(' ') : null;
}

/** Every ring of the outgoing call has ended (30 s, or nobody left ringing or waiting to be rung) with nobody else in it. */
function unanswered(outgoing: NonNullable<CallState['outgoing']>, othersInCall: boolean, expired: boolean): boolean {
  return !othersInCall && (expired || (outgoing.ringing.length === 0 && outgoing.notRung.length === 0));
}

export interface CallView {
  /** The channel or DM this device is in, or is joining. */
  channelId: string | null;
  /** A voice room lost during a service restart, retained until its automatic join succeeds or the person leaves. */
  recoveryChannelId: string | null;
  recoveryCamera: boolean;
  recoverySharing: boolean;
  recentlyEnded: { channelId: string; camera: boolean; sharing: boolean; at: number } | null;
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
  /** The outgoing ring of the DM call this device opened has run its 30 s (product walk I6). */
  ringExpired: boolean;
  join: (channelId: string) => void;
  restore: (channelId: string, camera: boolean, sharing: boolean) => void;
  /** `after`: the notice the stage or strip shows once left (product walk I6: the unanswered ring's last line). */
  leave: (after?: CallNotice) => void;
  closeUnsupported: () => void;
  toggleMute: () => void;
  toggleDeafen: () => void;
  /**
   * The user panel's mute and deafen (web3.8, R25). In a call they are `toggleMute`/`toggleDeafen`; outside one they write the
   * device-local `voice.self` setting, which the next join starts in.
   */
  selfMute: () => void;
  selfDeafen: () => void;
  /** The own state the user panel shows: the session's in a call, else the `voice.self` setting (deafened counts as muted). */
  selfMuted: boolean;
  selfDeafened: boolean;
  toggleCamera: () => void;
  toggleShare: () => void;
  setVolume: (userId: string, volume: number) => void;
  /** web3.3: the "turn on audio" press while the browser holds call audio back (state.audioBlocked). */
  startAudio: () => void;
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
  /** A community voice room closed during a known app upgrade may be opened again. */
  recoverEnded?(channelId: string): boolean;
  /** The desktop shell shows the user panel, so Control/⌘+Shift+M and D also work outside a call (web3.8, pre-flight C-10). */
  selfShortcuts?: boolean;
  /** The shell's own polite announcer: outside a call there is no dock status region to say a mute or deafen. */
  announce?(text: string): void;
}

/** The mute and deafen shortcut letters (WB a11y m1: matched on the letter the key types, so AZERTY's M is M). */
const KEY_M = 'm';
const KEY_D = 'd';
/** A session that ended on its own: the notice that says why (WB client I3; flow 06 § States). */
const END_NOTICE: Record<string, StringKey> = { E_CALL_ENDED: 'voice.ended', E_REMOVED: 'voice.removed' };

export function useCall(o: UseCallOptions): CallView {
  const deps = useContext(VoiceDepsContext);
  const { client } = o;
  const [session, setSession] = useState<PageCall | null>(null);
  const [state, setState] = useState<PageCallState | null>(null);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [recoveryChannelId, setRecoveryChannelId] = useState<string | null>(null);
  const [recoveryCamera, setRecoveryCamera] = useState(false);
  const [recoverySharing, setRecoverySharing] = useState(false);
  const [recentlyEnded, setRecentlyEnded] = useState<CallView['recentlyEnded']>(null);
  const recoveryRef = useRef<string | null>(null);
  const recoveryCameraRef = useRef(false);
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
  /** WB client I1: the start in progress can be cancelled (a leave during it, or a join of another channel). */
  const startAbort = useRef<AbortController | null>(null);
  /** WB client I1: a join (or a ring's answer) of another channel asked for while a start ran: it starts once that one
   *  has been cancelled. */
  /** The join that waits for a cancelled start to end, with the call context made in its own press. */
  const queuedJoin = useRef<{ id: string; ctx: AudioContext | null } | null>(null);
  /** WB client m1: the leave in flight; a join waits for it, so leave-then-join is not refused as a call in progress. */
  const leaving = useRef<Promise<unknown> | null>(null);
  const mounted = useRef(true);
  const paused = useRef(false);
  /** The current hold (WB security I1) already dropped the session's media keys. */
  const keysDropped = useRef(false);
  const module = useRef<VoiceModule | null>(null);
  /** web3.4 V1: the output device the session is asked to play to: the one it started with, then each one Settings moved
   *  it to. `outputPlaying` is the last one the session took (fix round 1): a refusal falls back to it. */
  const outputInForce = useRef('');
  const outputPlaying = useRef('');
  // The join button the unsupported dialog was opened from: focus returns there when it closes (flow 06).
  const opener = useRef<HTMLElement | null>(null);
  const live = useRef(o);
  live.current = o;

  // WB a11y I3: the same text again (a second "You joined harbour.") is said again: the region is emptied first and the
  // text set a moment later, since setting identical text changes nothing a screen reader hears.
  const announceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Product walk I6: someone else was in this call at some point (it was answered); it then never ends by itself. */
  const answered = useRef(false);
  const announce = useCallback((text: string) => {
    if (announceTimer.current !== null) { clearTimeout(announceTimer.current); announceTimer.current = null; }
    setAnnouncement(prev => {
      if (prev !== text || text === '') return text;
      announceTimer.current = setTimeout(() => { announceTimer.current = null; setAnnouncement(text); }, 100);
      return '';
    });
  }, []);

  /** Forgets the session (its leave is the caller's); nothing of it is used after this. */
  const detach = useCallback(() => {
    unsubscribe.current?.();
    unsubscribe.current = null;
    sessionRef.current = null;
    channelRef.current = null;
    paused.current = false;
    keysDropped.current = false;
    setSession(null);
    setState(null);
    setChannelId(null);
    // WB a11y I3: the dock's region goes with the dock; a later dock starts empty, so its first announcement is heard.
    setAnnouncement('');
  }, []);

  const attach = useCallback((next: PageCall, id: string) => {
    answered.current = false;
    sessionRef.current = next;
    channelRef.current = id;
    setSession(next);
    setState(next.state);
    setChannelId(id);
    // web3.3 review M1: the browser holding call audio back is said once, in the dock’s status region, on each change
    // from playing to held back (a call that starts held back says it with the join).
    let audioBlocked = next.state.audioBlocked;
    let cameraBeforeLoss = next.state.camera;
    let sharingBeforeLoss = next.state.sharing;
    // Fix round 2 (Nit 3): a hold that arrives in the same tick as the join’s announcement joins it, never replaces it.
    const joined = t('voice.announce.joined', { where: live.current.whereOf(id) });
    let joinTick = true;
    setTimeout(() => { joinTick = false; }, 0);
    unsubscribe.current = next.subscribe(() => {
      if (sessionRef.current !== next) return;
      setState(next.state);
      if (next.state.phase !== 'ended') {
        cameraBeforeLoss = next.state.camera;
        sharingBeforeLoss = next.state.sharing;
      }
      if (next.state.audioBlocked && !audioBlocked) announce(joinTick ? `${joined} ${t('voice.audioBlocked')}` : t('voice.audioBlocked'));
      audioBlocked = next.state.audioBlocked;
      // The room ended on its own (the session already left; a person's own leave detaches first, so it never gets
      // here). WB client I3: say why, in the stage's notice and, off the stage, where it outlives the dock.
      if (next.state.phase === 'ended') {
        const key = END_NOTICE[next.state.error ?? ''] ?? 'voice.disconnected';
        const recoverEnded = next.state.error === 'E_CALL_ENDED' && live.current.recoverEnded?.(id) === true;
        if (next.state.error === 'E_CALL_ENDED') {
          setRecentlyEnded({ channelId: id, camera: cameraBeforeLoss, sharing: sharingBeforeLoss, at: Date.now() });
        }
        if (next.state.error === 'E_DISCONNECTED' || recoverEnded) {
          recoveryRef.current = id;
          setRecoveryChannelId(id);
          recoveryCameraRef.current = cameraBeforeLoss;
          setRecoveryCamera(cameraBeforeLoss);
          setRecoverySharing(sharingBeforeLoss);
        }
        detach();
        if (next.state.error !== 'E_DISCONNECTED' && !recoverEnded) {
          setNotice({ channelId: id, key });
          if (!live.current.stageShown(id)) setLasting(t(key));
        }
      }
    });
    announce(audioBlocked ? `${joined} ${t('voice.audioBlocked')}` : joined);
    if (recoveryRef.current === id && recoveryCameraRef.current) {
      void next.setCamera(true).catch(() => undefined);
    }
  }, [announce, detach]);

  /** `made`: the call context a queued join's own press made (it waited for the cancelled start to end). */
  const join = useCallback((id: string, made?: AudioContext | null) => {
    if (recoveryRef.current !== null && recoveryRef.current !== id) {
      recoveryRef.current = null;
      setRecoveryChannelId(null);
      recoveryCameraRef.current = false;
      setRecoveryCamera(false);
      setRecoverySharing(false);
    }
    setRecentlyEnded(null);
    if (channelRef.current === id && (starting.current || sessionRef.current !== null)) { closeContext(made); return; }
    // web3.3 fix round 2 (Minor 1): the call’s AudioContext is made here, synchronously in the press, before any await
    // (the leave in flight, the module load, a switch’s leave); the session it is handed to closes it on every way out,
    // and every path below that never hands it over (unsupported, cancelled, superseded, a failed load) closes it here.
    const ctx = made !== undefined ? made : (deps.createCallContext?.() ?? null);
    if (starting.current) {
      // WB client I1: another channel (a ring's answer) while a start runs: that start is cancelled and this one follows.
      closeContext(queuedJoin.current?.ctx);
      queuedJoin.current = { id, ctx };
      startAbort.current?.abort();
      return;
    }
    let handed = false;
    starting.current = true;
    const from = document.activeElement;
    const abort = new AbortController();
    startAbort.current = abort;
    void (async () => {
      try {
        // WB client m1: a leave still in flight (the worker refuses a join while it runs) is waited for first.
        await leaving.current?.catch(() => undefined);
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
        if (abort.signal.aborted) return;
        setNotice(null);
        setBlockedMidCall(null);
        // WB a11y I3: what was said for the last call is not said for this one; a second identical text is heard again.
        setLasting('');
        setAnnouncement('');
        // Flow 06 § Focus rules: the join moves focus to the stage's first control as soon as it shows (WB a11y I1).
        stageFocus.current = true;
        channelRef.current = id;
        setChannelId(id);
        setJoining(true);
        const settings = client.get('settings') ?? {};
        // The start's arguments are built before the context counts as handed: a throw while building them closes it below.
        const callDeps = mod.browserDeps(client);
        const target = { channelId: id, vdec: mod.localDecodeList() };
        outputInForce.current = settings[SETTINGS.voiceOutput] ?? '';
        outputPlaying.current = outputInForce.current;
        const opts: Parameters<VoiceModule['startPageCall']>[2] = {
          instanceId: client.get('account')?.instance?.id ?? '',
          input: settings[SETTINGS.voiceInput] ?? '',
          output: outputInForce.current,
          mode: settings[SETTINGS.voiceMode] === 'ptt' ? 'ptt' : 'vad',
          noise: settings[SETTINGS.voiceNoise] === 'off' ? 'off' : settings[SETTINGS.voiceNoise] === 'automatic' ? 'automatic' : settings[SETTINGS.voiceNoise] === 'lightweight' ? 'lightweight' : 'on',
          volumes: mod.volumesFromSettings(settings),
          signal: abort.signal,
          // Product walk M5: the mute or deafen this browser kept (never a live microphone after a reload of a muted call).
          self: settings[SETTINGS.voiceSelf] === 'deafened' ? 'deafened' : settings[SETTINGS.voiceSelf] === 'muted' ? 'muted' : null,
          ...(ctx !== null ? { audioContext: ctx } : {}),
        };
        handed = true;
        const next = await mod.startPageCall(callDeps, target, opts);
        // The shell unmounted while the start was pending: nobody drives this call, so it ends at once.
        if (!mounted.current) { void next.leave('user'); return; }
        attach(next, id);
        setRecentlyEnded(null);
        if (recoveryRef.current === id) {
          recoveryRef.current = null;
          setRecoveryChannelId(null);
          recoveryCameraRef.current = false;
          setRecoveryCamera(false);
        }
      } catch (e) {
        if (sessionRef.current === null) { channelRef.current = null; setChannelId(null); }
        // A start the person cancelled says nothing (WB client I1). The worker's side of it (its join cancelled, its
        // self-Remove sent) is awaited by the next join through a leave of its own, which answers once that is done.
        if (abort.signal.aborted) leaving.current = client.call({ m: 'callLeave', reason: 'user' }).catch(() => undefined);
        const code = errorOf(e).code;
        // A disconnected room may come back after a network or media restart. A refusal that
        // cannot improve by waiting ends the automatic attempt and leaves its reason visible.
        if (recoveryRef.current === id && ['E_FORBIDDEN', 'E_REMOVED', 'E_CALL_FULL', 'E_CALL_IN_OTHER_TAB',
          'E_CREDENTIAL', 'E_DEVICE_UNLISTED', 'E_TIER_MISMATCH', 'E_BINDING'].includes(code)) {
          recoveryRef.current = null;
          setRecoveryChannelId(null);
          recoveryCameraRef.current = false;
          setRecoveryCamera(false);
          setRecoverySharing(false);
        }
        const key = abort.signal.aborted ? null : joinFailureKey(code);
        if (key !== null) setNotice({ channelId: id, key });
      } finally {
        if (!handed) closeContext(ctx);
        if (startAbort.current === abort) startAbort.current = null;
        starting.current = false;
        setJoining(false);
        const next = queuedJoin.current;
        queuedJoin.current = null;
        if (next !== null && mounted.current) joinRef.current(next.id, next.ctx);
        else closeContext(next?.ctx);
      }
    })();
  }, [deps, client, attach, detach]);
  const joinRef = useRef(join);
  joinRef.current = join;
  /** The shell’s join: a channel only (a second argument from a caller never stands for a call context). */
  const joinOnly = useCallback((id: string) => join(id), [join]);
  const restore = useCallback((id: string, camera: boolean, sharing: boolean) => {
    recoveryRef.current = id;
    recoveryCameraRef.current = camera;
    setRecoveryChannelId(id);
    setRecoveryCamera(camera);
    setRecoverySharing(sharing);
    join(id);
  }, [join]);

  const leave = useCallback((after?: CallNotice) => {
    recoveryRef.current = null;
    setRecoveryChannelId(null);
    recoveryCameraRef.current = false;
    setRecoveryCamera(false);
    setRecoverySharing(false);
    setRecentlyEnded(null);
    const current = sessionRef.current;
    const id = channelRef.current;
    if (current === null && starting.current) {
      // WB client I1: a leave while the start runs cancels it (the microphone prompt and the rejoin wait included); the
      // shell returns to where it was, and nothing is said of a failure.
      closeContext(queuedJoin.current?.ctx);
      queuedJoin.current = null;
      startAbort.current?.abort();
      channelRef.current = null;
      setChannelId(null);
      return;
    }
    if (current === null || id === null) return;
    detach();
    if (after !== undefined) setNotice(after);
    const done = current.leave('user').finally(() => {
      if (leaving.current === done) leaving.current = null;
      setLasting(t('voice.announce.left', { where: live.current.whereOf(id) }));
      live.current.onLeft(id);
    });
    leaving.current = done;
  }, [detach]);

  /** Product walk M5: the own mute and deafen are kept per browser (a device-local setting), for the next call. */
  const keepSelf = useCallback((s: PageCall) => {
    const value = s.state.deafened ? 'deafened' : s.state.muted ? 'muted' : null;
    client.call({ m: 'setSetting', key: SETTINGS.voiceSelf, value }).catch(() => undefined);
  }, [client]);
  const toggleMute = useCallback(() => {
    const s = sessionRef.current;
    if (s === null) return;
    const on = !s.state.muted;
    s.setMuted(on);
    keepSelf(s);
    announce(t(on ? 'voice.announce.muted' : 'voice.announce.unmuted'));
  }, [announce, keepSelf]);
  const toggleDeafen = useCallback(() => {
    const s = sessionRef.current;
    if (s === null) return;
    const on = !s.state.deafened;
    s.setDeafened(on);
    keepSelf(s);
    announce(t(on ? 'voice.announce.deafened' : 'voice.announce.undeafened'));
  }, [announce, keepSelf]);
  /** R25: outside a call the own mute and deafen are the device-local `voice.self` setting, which the next join starts in.
   *  `written` is the last value sent and not yet answered, so two quick presses read one source (the second sees the first)
   *  and never the stale slice. A refused write drops it, and the panel (which reads the stored slice) never claimed it. */
  const written = useRef<{ seq: number; value: string | null } | null>(null);
  const writeSeq = useRef(0);
  const writeSelf = useCallback((pick: (current: string | undefined) => 'muted' | 'deafened' | null) => {
    const current = written.current !== null ? written.current.value ?? undefined : (client.get('settings') ?? {})[SETTINGS.voiceSelf];
    const value = pick(current);
    const mine = { seq: ++writeSeq.current, value };
    written.current = mine;
    const done = () => { if (written.current === mine) written.current = null; };
    const key = value === 'deafened' ? 'voice.announce.deafened' : current === 'deafened' && value === 'muted' ? 'voice.announce.undeafened'
      : value === 'muted' ? 'voice.announce.muted' : 'voice.announce.unmuted';
    client.call({ m: 'setSetting', key: SETTINGS.voiceSelf, value }).then(() => { done(); live.current.announce?.(t(key)); }, done);
  }, [client]);
  const selfMute = useCallback(() => {
    if (sessionRef.current !== null) { toggleMute(); return; }
    // null -> muted -> null; from deafened, unmuting also undeafens (setMuted(false) in the session).
    writeSelf(current => (current === 'muted' || current === 'deafened' ? null : 'muted'));
  }, [toggleMute, writeSelf]);
  const selfDeafen = useCallback(() => {
    if (sessionRef.current !== null) { toggleDeafen(); return; }
    // null or muted -> deafened; from deafened back to muted, never to an open microphone.
    writeSelf(current => (current === 'deafened' ? 'muted' : 'deafened'));
  }, [toggleDeafen, writeSelf]);
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
  const startAudio = useCallback(() => {
    // The press is the user activation the browser asks for; a refusal leaves the line on offer (the session never throws).
    sessionRef.current?.startAudio().catch(() => undefined);
  }, []);

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
      const done = s.leave(reason).catch(() => undefined).finally(() => { if (leaving.current === done) leaving.current = null; });
      leaving.current = done;
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
  /** Fix round 3 (m5): the channel whose call this device was just removed from; the worker's re-read may then say the
   *  channel is gone (E_NOT_FOUND), and off the stage the region that outlives the dock says so too. */
  const removedFrom = useRef<string | null>(null);
  const goneFrom = slice?.phase === 'removed' && slice.error?.code === 'E_NOT_FOUND' ? slice.channelId : null;
  useEffect(() => {
    if (goneFrom === null || goneFrom !== removedFrom.current) return;
    removedFrom.current = null;
    if (!live.current.stageShown(goneFrom)) setLasting(t('voice.removedNotMember'));
  }, [goneFrom]);
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
      // WB security I1: a pause that is not a changed identity is the hold after a refused rekey. The page's keys are an
      // epoch a removed leaf may still hold, so they go at once (once per hold); the next epoch's key ends it.
      if (now?.error?.code !== 'E_UMK_CHANGED' && !keysDropped.current) {
        keysDropped.current = true;
        let upTo: bigint | undefined;
        try { upTo = now?.epoch == null ? undefined : BigInt(now.epoch); } catch { upTo = undefined; }
        safely(s, () => { s.dropKeys(upTo); return Promise.resolve(); });
      }
    } else if (phase === 'in') {
      keysDropped.current = false;
      if (paused.current) {
        paused.current = false;
        setPauseFocusPending(false);
        safely(s, () => s.setPaused(false));
        announce(t('voice.resumed'));
      }
    } else if (phase === 'blocked' || phase === 'removed') {
      const recoverEnded = phase === 'removed' && now?.error?.code === 'E_CALL_ENDED' && live.current.recoverEnded?.(id) === true;
      if (phase === 'removed' && now?.error?.code === 'E_CALL_ENDED') {
        setRecentlyEnded({ channelId: id, camera: s.state.camera, sharing: s.state.sharing, at: Date.now() });
      }
      if (phase === 'removed' && (now?.error?.code === 'E_DISCONNECTED' || recoverEnded)) {
        recoveryRef.current = id;
        setRecoveryChannelId(id);
        recoveryCameraRef.current = s.state.camera;
        setRecoveryCamera(s.state.camera);
        setRecoverySharing(s.state.sharing);
        setPauseFocusPending(false);
        teardown(s, phase);
        return;
      }
      if (phase === 'blocked') setBlockedMidCall(id);
      else { setNotice({ channelId: id, key: 'voice.removed' }); removedFrom.current = id; }
      // Off the stage, nothing else would say why the call ended (review I6).
      if (!live.current.stageShown(id)) setLasting(t(phase === 'blocked' ? 'voice.blocked' : 'voice.removed'));
      setPauseFocusPending(false);
      teardown(s, phase);
    } else {
      teardown(s, 'removed');
    }
  }, [slice, session, client, announce, safely, teardown]);
  useEffect(() => {
    if (recoveryChannelId === null) return;
    let delay = 1_000;
    let timer: ReturnType<typeof setTimeout>;
    const retry = () => {
      if (recoveryRef.current !== recoveryChannelId) return;
      const phase = client.get('call')?.phase;
      const removedCode = client.get('call')?.error?.code;
      if (phase === 'blocked' || (phase === 'removed' && removedCode !== 'E_DISCONNECTED'
        && !(removedCode === 'E_CALL_ENDED' && live.current.recoverEnded?.(recoveryChannelId)))) {
        recoveryRef.current = null;
        setRecoveryChannelId(null);
        return;
      }
      if (navigator.onLine && sessionRef.current === null && !starting.current) joinRef.current(recoveryChannelId);
      delay = Math.min(delay * 2, 30_000);
      timer = setTimeout(retry, delay);
    };
    timer = setTimeout(retry, delay);
    return () => clearTimeout(timer);
  }, [recoveryChannelId, client]);

  // Product walk I6: the outgoing ring of a DM call this device opened. It lasts 30 s from the call's start, whoever was
  // rung; once every ring ended with nobody else ever in the call, the caller leaves by itself after a short grace, and the
  // strip keeps the ring's last line. A call someone answered never ends by itself.
  const outgoing = slice !== undefined && channelId !== null && slice.channelId === channelId
    && (slice.phase === 'in' || slice.phase === 'paused') ? slice.outgoing : null;
  const hasOutgoing = outgoing !== null;
  const [ringExpired, setRingExpired] = useState(false);
  useEffect(() => {
    setRingExpired(false);
    if (!hasOutgoing) return;
    const timer = setTimeout(() => setRingExpired(true), RING_MS);
    return () => clearTimeout(timer);
  }, [hasOutgoing, channelId]);
  const othersNow = (state?.tiles.length ?? 0) > 0;
  if (othersNow) answered.current = true;
  const ended = outgoing !== null && !answered.current && unanswered(outgoing, othersNow, ringExpired);
  const endText = ended ? outgoingText(outgoing, false, ringExpired) : null;
  const leaveRef = useRef<(after?: CallNotice) => void>(() => undefined);
  useEffect(() => {
    if (endText === null || channelId === null) return;
    const id = channelId;
    const timer = setTimeout(() => {
      if (!answered.current) leaveRef.current({ channelId: id, key: 'call.outgoing.noAnswer', text: endText });
    }, UNANSWERED_LEAVE_MS);
    return () => clearTimeout(timer);
  }, [endText, channelId]);

  // Control/⌘+Shift+M and Control/⌘+Shift+D while in voice, and on the desktop shell outside a call too (decision 1; the user panel advertises them); no single-key shortcut, and none during an IME
  // composition. Either modifier works on every platform, as the Control/⌘+K entry does.
  // Fail closed: a mute or deafen pressed while the join was starting is in `voice.self` but not in the session it started
  // with (it read the setting before). When the session attaches, the more private of the two wins; never the other way.
  useEffect(() => {
    if (session === null) return;
    const kept = (written.current !== null ? written.current.value ?? undefined : (client.get('settings') ?? {})[SETTINGS.voiceSelf]);
    if (kept === 'deafened' && !session.state.deafened) session.setDeafened(true);
    else if ((kept === 'muted' || kept === 'deafened') && !session.state.muted) session.setMuted(true);
  }, [session, client]);
  const selfShortcuts = o.selfShortcuts === true;
  useEffect(() => {
    if (session === null && !selfShortcuts) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey) return;
      // WB a11y m1: the letter the key types (AZERTY's M is code Semicolon; Dvorak's physical M types another letter), as
      // Control/⌘+K matches e.key; the physical key only when the key types no letter at all.
      const letter = /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() : e.code === 'KeyM' ? KEY_M : e.code === 'KeyD' ? KEY_D : '';
      if (letter === KEY_M) { e.preventDefault(); selfMute(); }
      else if (letter === KEY_D) { e.preventDefault(); selfDeafen(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session, selfShortcuts, selfMute, selfDeafen]);
  const kept = o.settings[SETTINGS.voiceSelf];
  const selfMuted = state !== null && session !== null ? state.muted : kept === 'muted' || kept === 'deafened';
  const selfDeafened = state !== null && session !== null ? state.deafened : kept === 'deafened';

  // The input mode follows Settings → Voice during a call (review I2): the session switches first (push to talk closes the
  // microphone at once), the dock says which mode is in force, and the key binds only to the mode the session applied.
  const wanted = o.settings[SETTINGS.voiceMode] === 'ptt' ? 'ptt' : 'vad';
  useEffect(() => {
    if (session === null || session.state.mode === wanted) return;
    session.setMode(wanted);
    announce(t(wanted === 'ptt' ? 'settings.voice.ptt' : 'settings.voice.vad'));
  }, [session, wanted, announce]);
  // Product walk M1: noise suppression follows Settings → Voice during the call too.
  const wantedNoise = o.settings[SETTINGS.voiceNoise] === 'off' ? 'off' : o.settings[SETTINGS.voiceNoise] === 'automatic' ? 'automatic' : o.settings[SETTINGS.voiceNoise] === 'lightweight' ? 'lightweight' : 'on';
  useEffect(() => {
    if (session === null || session.state.noise === wantedNoise) return;
    session.setNoise(wantedNoise).catch(() => undefined);
  }, [session, wantedNoise]);
  // web3.4 V1: the output device follows Settings → Voice during the call too. A device the browser refuses is said
  // once; the sound goes on where it played before. Fix round 1: a refusal of a device the person has since moved away
  // from is not said, and a refusal puts the device that still plays back in force, so choosing the refused one again
  // tries it again.
  const wantedOutput = o.settings[SETTINGS.voiceOutput] ?? '';
  useEffect(() => {
    if (session === null || outputInForce.current === wantedOutput) return;
    outputInForce.current = wantedOutput;
    const id = wantedOutput;
    session.setOutput(id).then(() => {
      if (sessionRef.current === session) outputPlaying.current = id;
    }, () => {
      if (sessionRef.current !== session || (live.current.settings[SETTINGS.voiceOutput] ?? '') !== id) return;
      outputInForce.current = outputPlaying.current;
      announce(t('voice.outputFailed'));
    });
  }, [session, wantedOutput, announce]);
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
      recoveryRef.current = null;
      mounted.current = false;
      const s = sessionRef.current;
      unsubscribe.current?.();
      startAbort.current?.abort();
      if (announceTimer.current !== null) clearTimeout(announceTimer.current);
      if (s !== null) void s.leave('user');
    };
  }, []);

  leaveRef.current = leave;
  return {
    channelId, recoveryChannelId, recoveryCamera, recoverySharing, recentlyEnded, joining, session, state, announcement, lasting, announce,
    notice, blockedMidCall, unsupported, ringExpired,
    pauseFocusPending, markPauseFocused: () => setPauseFocusPending(false),
    takeStageFocus: () => { const want = stageFocus.current; stageFocus.current = false; return want; },
    join: joinOnly, restore, leave, closeUnsupported, toggleMute, toggleDeafen, selfMute, selfDeafen, selfMuted, selfDeafened, toggleCamera, toggleShare, setVolume, startAudio,
  };
}

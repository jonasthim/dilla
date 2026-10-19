// The shell's voice surfaces (web-3 task 9, flow 06): the voice view of a voice channel route, the DM call strip and
// its stage, the voice rows' nested people in the channel list (ChannelList renders them) and the dock. Everything here is presentational over useCall's CallView and the
// worker's `call` and `voice` slices; nothing here holds media or keys.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { CallState, MemberSummary, SendBlocksState, TrustSummary, VoiceCall } from '@dilla/client-core';
import { SETTINGS } from '@dilla/client-core';
import {
  AudioMeter, Button, CallControls, CallStage, isPushToTalkKey, VoiceDock,
  type CallStageNotice, type CallTileProps, type VoiceDockProps,
} from '@dilla/ui';
import { en, t } from '../../strings/index.ts';
import { micNoticeKey, participantView, userName, voiceStateLabels } from '../shell-model.ts';
import { outgoingText, type CallView } from './useCall.tsx';
import { usePhoneLayout } from '../../layout.ts';
import { voiceShortcutText } from './shortcuts.ts';

/** What the voice surfaces read besides the CallView. */
export interface VoiceContext {
  call: CallView;
  slice: CallState | undefined;
  voice: Readonly<Record<string, VoiceCall>> | undefined;
  members: readonly MemberSummary[];
  trust: readonly TrustSummary[] | undefined;
  /** The worker's sendBlocks slice (undefined until published): tells a call-group-only block from a channel block. */
  sendBlocks: SendBlocksState | undefined;
  settings: Readonly<Record<string, string>>;
  self: { id: string; username: string } | null;
  ownDevice: string | null;
  onCompare(userId: string): void;
  /** Opens Settings → Voice (product walk M7: the dock's push to talk with no key set leads there). */
  onVoiceSettings(): void;
  onJoinVoice?(channelId: string): void;
}

const VOLUME = /^(0|[1-9]0|1[0-9]0|200)$/;
function volumeOf(settings: Readonly<Record<string, string>>, userId: string): number {
  const v = settings[SETTINGS.voiceVolume(userId)];
  return v !== undefined && VOLUME.test(v) ? Number(v) : 100;
}

function tileLabels(name: string): CallTileProps['labels'] {
  return { state: voiceStateLabels(), volume: t('voice.volume', { name }), volumeValue: en['voice.volumeValue'] };
}

/** The tiles of the call this device is in: the session's tiles (others) and the own one first. */
function callTiles(v: VoiceContext, channelId: string): CallTileProps[] {
  const { call } = v;
  const state = call.state;
  const room = v.voice?.[channelId];
  // Product walk I3: the own tile is a self-view of what this device sends (the camera mirrored); M4: it is speaking when
  // the SFU hears this device, as the others' tiles are; M13: no tile carries the client tag (the page knows only its own).
  const camera = state?.localCamera ?? null;
  const screen = state?.localScreen ?? null;
  const own = v.self === null ? [] : [{
    view: {
      deviceId: v.ownDevice ?? 'own', userId: v.self.id, name: userName(v.self.id, v.members, v.trust), state: 'ok' as const,
      speaking: state?.speaking ?? false, muted: state?.muted ?? false, deafened: state?.deafened ?? false, video: state?.camera ?? false,
      screen: state?.sharing ?? false, web: false, bot: false,
    },
    own: true, volume: 100, media: screen ?? camera, inset: screen !== null ? camera : null,
    mirror: camera === null ? null : screen !== null ? 'inset' as const : 'media' as const,
    labels: tileLabels(v.self.username), onVolume: () => undefined,
  }];
  const others = (state?.tiles ?? []).map(tile => {
    const p = room?.participants.find(r => r.deviceId === tile.deviceId);
    const name = p?.name ?? userName(tile.userId, v.members, v.trust);
    const view = p !== undefined ? participantView(p, tile.state, tile.speaking)
      : { deviceId: tile.deviceId, userId: tile.userId, name, state: tile.state, speaking: tile.speaking, muted: false, deafened: false,
        video: tile.video !== null, screen: tile.screen !== null, web: false, bot: false };
    // Product walk I2: the screen is the tile and the camera its inset when both are on.
    return { view, own: false, volume: volumeOf(v.settings, tile.userId), media: tile.screen ?? tile.video,
      inset: tile.screen !== null ? tile.video : null, labels: tileLabels(name),
      onVolume: (n: number) => call.setVolume(tile.userId, n) };
  });
  return [...own, ...others];
}

/** The people of a live call this device is not in, as tiles without media. */
function roomTiles(v: VoiceContext, channelId: string): CallTileProps[] {
  return (v.voice?.[channelId]?.participants ?? []).map(p => ({
    view: participantView(p), own: p.own, volume: volumeOf(v.settings, p.userId), media: null, labels: tileLabels(p.name),
    onVolume: (n: number) => v.call.setVolume(p.userId, n),
  }));
}

/**
 * The stage notice for a channel (flow 06 § States): the RV-3 pause banner, a block, then a transient notice, then the
 * microphone's listen-only outcome. Only 'paused' and 'blocked' hide media (CallStageNotice.kind).
 */
export function stageNotice(v: VoiceContext, channelId: string): CallStageNotice | null {
  const slice = v.slice;
  if (slice !== undefined && slice.channelId === channelId) {
    const name = slice.changedUser !== null ? userName(slice.changedUser, v.members, v.trust) : null;
    if (slice.phase === 'paused' && slice.error?.code !== 'E_UMK_CHANGED') {
      // WB security I1: the hold after a refused rekey (a device of the call not checked yet); nothing to compare.
      return { kind: 'paused', text: t('voice.held'), focusOnce: false, action: null };
    }
    if (slice.phase === 'paused') {
      const changed = slice.changedUser;
      return { kind: 'paused', text: t('voice.paused', { name: name ?? '' }), focusOnce: v.call.pauseFocusPending,
        action: changed !== null ? { label: t('voice.pausedAction'), onAction: () => v.onCompare(changed) } : null };
    }
    if (slice.phase === 'blocked') {
      // Product walk M10: a block that offers the join again (joinHeld false) never says joining is paused.
      const held = joinHeld(v, channelId);
      const changed = slice.error?.code === 'E_UMK_CHANGED' && name !== null ? slice.changedUser : null;
      const midCall = v.call.blockedMidCall === channelId;
      const text = midCall ? t(held ? 'voice.blocked' : 'voice.blockedLeft')
        : changed !== null && name !== null ? t('voice.blockedChanged', { name }) : t(held ? 'voice.blockedJoin' : 'voice.blockedRetry');
      // Product walk M9: a join refused for a named changed identity offers the comparison, as the pause does.
      const action = !midCall && changed !== null ? { label: t('voice.pausedAction'), onAction: () => v.onCompare(changed) } : null;
      return { kind: 'blocked', text, action, focusOnce: true };
    }
    if (slice.phase === 'failed' && v.call.channelId !== channelId) return { kind: 'info', text: t('voice.failed'), action: null, focusOnce: false };
    // Product walk I8: removed, and the channel is gone for this device (the membership is): the removal says so.
    if (removedFromServer(v, channelId)) return { kind: 'info', text: t('voice.removedNotMember'), action: null, focusOnce: false };
  }
  if (v.call.notice?.channelId === channelId) return { kind: 'info', text: v.call.notice.text ?? t(v.call.notice.key), action: null, focusOnce: false };
  const mic = v.call.channelId === channelId && v.call.state !== null ? micNoticeKey(v.call.state.mic) : null;
  return mic !== null ? { kind: 'info', text: t(mic), action: null, focusOnce: false } : null;
}

/**
 * True while a block holds joining back for this channel (flow 06: "no join button until the cause is gone"). A block by
 * a changed contact clears once that contact is no longer changed (verified); an unnamed one once no contact is. A block that came only from the call group
 * (the channel's own sendBlocks entry is clear, no changed identity) offers the join again (integration ruling
 * 2026-10-13: the left group cannot show it cleared, call_join_check refuses a staged join before anything is posted, and
 * RV-2 closes a poisoned idle group). Any other block, and any block while sendBlocks is not known yet, holds until the
 * worker's call slice leaves 'blocked' (review m9).
 */
function joinHeld(v: VoiceContext, channelId: string): boolean {
  // Product walk I8: no join of a channel this device may no longer see.
  if (removedFromServer(v, channelId)) return true;
  const s = v.slice;
  if (s?.channelId !== channelId || s.phase !== 'blocked') return false;
  const changed = (r: TrustSummary) => r.changedUmk !== null || r.blocked === 'E_UMK_CHANGED';
  if (s.error?.code === 'E_UMK_CHANGED' && s.changedUser !== null) {
    const row = v.trust?.find(r => r.userId === s.changedUser);
    return row !== undefined && changed(row);
  }
  if (s.error?.code === 'E_UMK_CHANGED') {
    // Unnamed (web-3 task 10, concern 3): the cause is gone once no contact is changed any more and the channel's own
    // send block (a DM's text group) is clear; a trust state or sendBlocks not known yet holds (fail closed). The join
    // itself runs the core's gate again, so offering it never lets a changed tree through.
    if (v.trust === undefined || v.sendBlocks === undefined) return true;
    return v.trust.some(changed) || v.sendBlocks[channelId] !== undefined;
  }
  const callGroupOnly = s.error?.code !== 'E_UMK_CHANGED' && s.changedUser === null
    && v.sendBlocks !== undefined && v.sendBlocks[channelId] === undefined;
  return !callGroupOnly;
}

/** Product walk I8: the call of this channel ended as removed, and the worker's read of the channel answered 404. */
export function removedFromServer(v: Pick<VoiceContext, 'slice'>, channelId: string): boolean {
  return v.slice?.channelId === channelId && v.slice.phase === 'removed' && v.slice.error?.code === 'E_NOT_FOUND';
}

/**
 * Moves focus to the stage's first control once per join (flow 06 § Focus rules: join and answer): as soon as the
 * controls show (WB a11y I1: at join start, while they are still aria-disabled, so focus never falls to the page).
 */
function useStageFocus(ref: RefObject<HTMLDivElement | null>, call: CallView, joined: boolean) {
  // No dependency list: a join may start in any render after the stage mounted.
  useLayoutEffect(() => {
    if (!joined) return;
    const first = ref.current?.querySelector<HTMLButtonElement>('[role="toolbar"] button');
    if (first !== null && first !== undefined && call.takeStageFocus()) first.focus();
  });
}

/**
 * WB a11y I1: keeps focus inside a voice surface when the surface swaps under it (a join starts, a join fails, the call
 * is removed or ends, the connection is lost). When the focused control went away with the swap (focus fell to the
 * page) and focus was inside one of `roots` before, `pick()` names where it goes now.
 */
function useFocusRescue(roots: readonly RefObject<HTMLElement | null>[], mode: string, pick: () => HTMLElement | null | undefined) {
  const inside = useRef(false);
  const live = useRef({ roots, pick });
  live.current = { roots, pick };
  useEffect(() => {
    const onIn = (e: FocusEvent) => {
      const target = e.target;
      inside.current = target instanceof Node && live.current.roots.some(r => r.current?.contains(target) === true);
    };
    document.addEventListener('focusin', onIn);
    return () => document.removeEventListener('focusin', onIn);
  }, []);
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (!inside.current || (active !== null && active !== document.body && active.isConnected)) return;
    live.current.pick()?.focus();
  }, [mode]);
}

/** Where focus goes in a stage that swapped under it: its first control in a call, else the notice (or its action),
 *  else the join button. */
function stageTarget(root: HTMLElement | null, joined: boolean): HTMLElement | null {
  if (root === null) return null;
  if (joined) return root.querySelector<HTMLElement>('[role="toolbar"] button');
  return root.querySelector<HTMLElement>('.d-call-stage__notice-action, .d-call-stage__notice[tabindex]')
    ?? root.querySelector<HTMLElement>('.dw-voice-join');
}

/** The mute and deafen shortcuts as the tooltips write them; the platform cannot change during a session. */
const VOICE_SHORTCUT_TEXT = voiceShortcutText();

/** Why an inert camera or share is inert, the same for the stage and the dock (founder, 2026-10-15). */
const VOICE_WHY = () => ({ paused: t('voice.why.paused'), joining: t('voice.why.joining'), noShare: t('voice.why.noShare') });

/** Whether this browser can capture a screen; the stage and the dock offer share screen only then. */
function canCapture(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}

function Controls({ v, paused, dm }: { v: VoiceContext; paused: boolean; dm: boolean }) {
  const s = v.call.state;
  const canShare = canCapture();
  const phone = usePhoneLayout();
  const hideShare = phone && !canShare;
  // WB a11y I4: the toggles keep one label; WB a11y m6: *call* names a DM call only, so a voice channel's toolbar has
  // its own name (the dock's is voice.dock.region).
  return (
    <CallControls muted={s?.muted ?? false} deafened={s?.deafened ?? false} camera={s?.camera ?? false} sharing={s?.sharing ?? false}
      canCamera={!paused} canShare={!paused && canShare} hideShare={hideShare} busy={v.call.session === null} paused={paused} shortcuts={VOICE_SHORTCUT_TEXT} keyshortcuts={phone}
      labels={{ region: t(dm ? 'voice.controls.region' : 'voice.controls.voice'), mute: t('voice.mute'), deafen: t('voice.deafen'),
        camera: t('voice.cameraOn'), share: t('voice.shareOn'), leave: t('voice.leave'), why: VOICE_WHY() }}
      onMute={v.call.toggleMute} onDeafen={v.call.toggleDeafen} onCamera={v.call.toggleCamera} onShare={v.call.toggleShare}
      onLeave={v.call.leave} />
  );
}

const STAGE_LABELS = () => ({ code: t('voice.code'), codeHelp: t('voice.codeHelp'), empty: t('voice.empty'), tiles: t('voice.tiles') });

/**
 * The stage of a voice channel or a DM call, whether this device is in its call, joining it or not (WB a11y I1, I2):
 * one element and one CallStage instance throughout, so its notice region is never remounted with its text (that
 * would not be announced) and focus can be kept inside it when the controls swap for the join button or back.
 */
function Stage({ v, channelId, title, outgoing, dm }: { v: VoiceContext; channelId: string; title: string; outgoing: { text: string } | null; dm: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const joined = v.call.channelId === channelId;
  useStageFocus(ref, v.call, joined);
  useFocusRescue([ref], joined ? 'joined' : 'idle', () => stageTarget(ref.current, joined));
  const notice = stageNotice(v, channelId);
  const mine = v.slice?.channelId === channelId;
  const paused = joined && mine && v.slice?.phase === 'paused';
  const code = joined && mine && v.slice?.phase === 'in' ? v.slice.code : null;
  // CallStage focused the pause action in its own effect (children run first): the pause has had its one focus move.
  const { pauseFocusPending, markPauseFocused } = v.call;
  useEffect(() => { if (paused && pauseFocusPending) markPauseFocused(); }, [paused, pauseFocusPending, markPauseFocused]);
  const held = !joined && joinHeld(v, channelId);
  const docState = !joined && notice?.kind === 'blocked' ? 'voice-blocked' : 'voice-stage';
  return (
    <div ref={ref} className="dw-voice-stage" data-doc-state={docState}
      data-call-phase={mine ? v.slice?.phase : joined ? 'joining' : 'idle'}>
      <CallStage title={title} tiles={joined ? callTiles(v, channelId) : roomTiles(v, channelId)} code={code} notice={notice}
        outgoing={joined ? outgoing : null}
        controls={joined ? <Controls v={v} paused={paused} dm={dm} />
          : held ? null : <Button variant="accent" className="dw-voice-join" onClick={() => v.onJoinVoice ? v.onJoinVoice(channelId) : v.call.join(channelId)}>{t('voice.join')}</Button>}
        labels={STAGE_LABELS()} />
    </div>
  );
}

/** The voice view of a voice channel route (`/c/<community>/<voice channel>`). */
export function VoiceView({ v, channelId, name }: { v: VoiceContext; channelId: string; name: string }): React.JSX.Element {
  return <Stage v={v} channelId={channelId} title={t('voice.open', { name })} outgoing={null} dm={false} />;
}

/**
 * The DM strip's notice: a `role="status"` that is always rendered (empty without a notice), so a notice that appears
 * is announced (WB a11y I2); focus moves to it once per text when asked.
 */
function StripNotice({ notice, refObj }: { notice: CallStageNotice | null; refObj: RefObject<HTMLParagraphElement | null> }) {
  const focused = useRef<string | null>(null);
  const text = notice?.text ?? null;
  const focusOnce = notice?.focusOnce ?? false;
  useEffect(() => {
    if (text === null) { focused.current = null; return; }
    if (!focusOnce || focused.current === text) return;
    focused.current = text;
    refObj.current?.focus();
  }, [text, focusOnce, refObj]);
  return (
    <p ref={refObj} className="dw-call-strip__notice" role="status" tabIndex={notice === null ? undefined : -1}
      data-kind={notice?.kind} data-empty={notice === null ? 'true' : undefined}>{text}</p>
  );
}

/**
 * The DM call strip under the conversation header (flow 06 "DM call"): `call.start` with no live call, `call.join` with
 * one, the outgoing ring's text while this device's call rings the others; while in the DM's call, its stage sits above
 * the log. A call block never reaches the composer: the strip says it, the composer stays as the text group's gate has it.
 */
export function DmCall({ v, channelId, name }: { v: VoiceContext; channelId: string; name: string }): React.JSX.Element {
  const outgoing = v.slice?.channelId === channelId ? v.slice.outgoing : null;
  // A ring lasts 30 s (R5, useCall's clock): once that long has passed with nobody answering, the strip says so.
  const inThisCall = v.call.channelId === channelId;
  const others = (v.voice?.[channelId]?.participants ?? []).some(p => p.userId !== v.self?.id) || (v.call.state?.tiles.length ?? 0) > 0;
  const text = inThisCall ? outgoingText(outgoing, others, v.call.ringExpired) : null;
  // The outgoing ring is spoken through the dock's status region, once per change (flow 06 § States, review I3).
  const { announce } = v.call;
  useEffect(() => { if (text !== null) announce(text); }, [text, announce]);
  // On a phone the stage fills the pane and `messages` swaps it for the log and composer (flow 06 § 360×740, review I7);
  // the toggle shows only there (app.css).
  const [view, setView] = useState<'stage' | 'messages'>('stage');
  const stripRef = useRef<HTMLDivElement>(null);
  const callRef = useRef<HTMLDivElement>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const live = (v.voice?.[channelId]?.participants.length ?? 0) > 0;
  const notice = inThisCall ? null : stageNotice(v, channelId);
  const held = joinHeld(v, channelId);
  // WB a11y I1: a failed call, a removal or an end swaps the stage for the strip under focus; focus goes to the notice
  // that says why, else the call button (the stage's own focus rule covers the join).
  useFocusRescue([stripRef, callRef], inThisCall ? 'joined' : 'idle', () => (inThisCall ? null
    : notice !== null ? noticeRef.current : stripRef.current?.querySelector<HTMLElement>('.dw-call-strip__start')));
  // The strip is always the first element, in a call too (empty and collapsed there), so its status region is never
  // mounted with its text (WB a11y I2).
  return (
    <>
      <div ref={stripRef} className="dw-call-strip" data-doc-state={notice?.kind === 'blocked' ? 'voice-blocked' : undefined}
        data-call-phase={inThisCall ? undefined : v.slice?.channelId === channelId ? v.slice.phase : 'idle'}
        data-empty={inThisCall && notice === null ? 'true' : undefined}>
        <StripNotice notice={notice} refObj={noticeRef} />
        {notice?.action != null ? <Button className="dw-call-strip__action" onClick={() => notice.action?.onAction()}>{notice.action.label}</Button> : null}
        {inThisCall || held ? null : (
          <Button className="dw-call-strip__start" onClick={() => v.onJoinVoice ? v.onJoinVoice(channelId) : v.call.join(channelId)}>{t(live ? 'call.join' : 'call.start')}</Button>
        )}
      </div>
      {inThisCall ? (
        <div ref={callRef} className="dw-dm-call" data-view={view}>
          <div className="dw-dm-call__bar">
            <Button size="md" pressed={view === 'messages'} onClick={() => setView(view === 'messages' ? 'stage' : 'messages')}>{t('voice.messages')}</Button>
          </div>
          <Stage v={v} channelId={channelId} title={name} outgoing={text === null ? null : { text }} dm />
        </div>
      ) : null}
    </>
  );
}


/** Product walk M3: the devices of this device's call that are speaking now, its own included. */
export function speakingDevices(state: CallView['state'], ownDevice: string | null): ReadonlySet<string> {
  const out = new Set<string>();
  for (const tile of state?.tiles ?? []) if (tile.speaking) out.add(tile.deviceId);
  if (state?.speaking === true && ownDevice !== null) out.add(ownDevice);
  return out;
}

export function rowLabels() {
  return { open: en['voice.open'], count: en['voice.count'], canHear: t('voice.bot.canHear'), state: voiceStateLabels() };
}

/** web3.4 V2: how many of the remote audio tracks this device is sent it plays ("hearing 1 of 2": one held back, as for a
 *  person whose volume is 0). Shown only while any is expected, and never while deafened or paused; a diagnostic line, so
 *  no status region of its own. The counts are on the element for support and the e2e suite: a small line under the
 *  meter, after the mode line. */
function HearingLine({ audio, silent }: { audio: { attached: number; expected: number } | undefined; silent: boolean }) {
  // Fix round 1: deafened or paused nothing plays, whatever is attached, so no line says it is heard.
  if (audio === undefined || audio.expected <= 0 || silent) return null;
  return (
    <p className="dw-voice-dock__hearing" data-audio-attached={audio.attached} data-audio-expected={audio.expected}>
      {t('voice.diag.tracks', { attached: audio.attached, expected: audio.expected })}
    </p>
  );
}

/** Product walk M7: push to talk in the dock names its key on a line of its own, or says no key is set, with a way to
 *  Settings → Voice. A stored key push to talk does not bind (an older rule's) counts as none, as Settings shows it. */
function PttLine({ v }: { v: VoiceContext }) {
  const key = v.settings[SETTINGS.voicePttKey];
  if (key !== undefined && isPushToTalkKey(key)) return <p className="dw-voice-dock__mode">{t('voice.dock.ptt', { key })}</p>;
  return (
    <p className="dw-voice-dock__mode">
      <span>{t('voice.dock.pttNoKey')}</span>
      <Button size="sm" variant="ghost" onClick={() => v.onVoiceSettings()}>{t('voice.dock.pttSetKey')}</Button>
    </p>
  );
}

/** The call's phase as the dock and the phone's call bar show it: paused on a held group, else connecting, reconnecting or connected. */
export function callPhase(v: Pick<VoiceContext, 'call' | 'slice'>): VoiceDockProps['phase'] {
  const { call } = v;
  const id = call.channelId;
  const paused = id !== null && v.slice?.channelId === id && v.slice.phase === 'paused';
  return paused ? 'paused' : call.session === null || call.state?.phase === 'connecting' ? 'connecting'
    : call.state?.phase === 'reconnecting' ? 'reconnecting' : 'connected';
}

/**
 * The dock above the user panel while this device is in voice (flow 06): where, the input meter, then mute, deafen,
 * camera, share screen and leave (the stage's controls, under the stage's rules: camera and share are aria-disabled
 * while paused, while joining, and share without screen capture), and the one polite status region. While the call is paused and its stage is not on screen, the pause banner and its
 * action stand above the dock.
 */
export function Dock({ v, where, stageShown }: { v: VoiceContext; where: string; stageShown: boolean }): React.JSX.Element | null {
  const { call } = v;
  const bannerRef = useRef<HTMLDivElement>(null);
  const id = call.channelId;
  const paused = id !== null && v.slice?.channelId === id && v.slice.phase === 'paused';
  const banner = paused && !stageShown ? stageNotice(v, id) : null;
  const bannerText = banner?.text ?? null;
  const { pauseFocusPending, markPauseFocused } = call;
  useEffect(() => {
    if (bannerText === null || !pauseFocusPending) return;
    bannerRef.current?.querySelector('button')?.focus();
    markPauseFocused();
  }, [bannerText, pauseFocusPending, markPauseFocused]);
  if (id === null) return null;
  const phase = callPhase(v);
  return (
    <div className="dw-voice-dock" data-doc-state="voice-dock">
      {banner !== null ? (
        <div ref={bannerRef} className="dw-voice-dock__paused" role="status">
          <p id="dw-voice-dock-paused">{banner.text}</p>
          {banner.action !== null ? (
            <Button aria-describedby="dw-voice-dock-paused" onClick={() => banner.action?.onAction()}>{banner.action.label}</Button>
          ) : null}
        </div>
      ) : null}
      {/* web3.3: the browser holds call audio back (its autoplay rule); one press starts it, right above the controls.
          Review M1: no status region of its own; useCall says the hint once through the dock’s announcement. */}
      {call.state?.audioBlocked === true ? (
        <div className="dw-voice-dock__audio">
          <p id="dw-voice-dock-audio">{t('voice.audioBlocked')}</p>
          <Button aria-describedby="dw-voice-dock-audio" onClick={call.startAudio}>{t('voice.audioStart')}</Button>
        </div>
      ) : null}
      <VoiceDock phase={phase} where={where} muted={call.state?.muted ?? false} deafened={call.state?.deafened ?? false}
        camera={call.state?.camera ?? false} sharing={call.state?.sharing ?? false} canCamera={!paused}
        canShare={!paused && canCapture()} busy={call.session === null} paused={paused} shortcuts={VOICE_SHORTCUT_TEXT}
        announcement={call.announcement}
        labels={{ region: t('voice.dock.region'), connecting: t('voice.dock.connecting'), connected: en['voice.dock.connected'],
          reconnecting: t('voice.dock.reconnecting'), paused: en['voice.dock.paused'], mute: t('voice.mute'),
          deafen: t('voice.deafen'), leave: t('voice.leave'), camera: t('voice.cameraOn'), share: t('voice.shareOn'), why: VOICE_WHY() }}
        meter={<>
          <AudioMeter level={call.state?.level ?? 0} label={t('settings.voice.level')} />
          {call.state?.mode === 'ptt' ? <PttLine v={v} /> : null}
          <HearingLine audio={call.state?.audio} silent={call.state?.deafened === true || call.state?.paused === true} />
        </>}
        onMute={call.toggleMute} onDeafen={call.toggleDeafen} onCamera={call.toggleCamera} onShare={call.toggleShare}
        onLeave={call.leave} />
    </div>
  );
}

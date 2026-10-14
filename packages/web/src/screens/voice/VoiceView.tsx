// The shell's voice surfaces (web-3 task 9, flow 06): the voice view of a voice channel route, the DM call strip and
// its stage, the sidebar's voice section and the dock. Everything here is presentational over useCall's CallView and the
// worker's `call` and `voice` slices; nothing here holds media or keys.
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { CallState, MemberSummary, SendBlocksState, TrustSummary, VoiceCall } from '@dilla/client-core';
import { SETTINGS } from '@dilla/client-core';
import {
  ActiveVoice, AudioMeter, Button, CallControls, CallStage, VoiceChannelRow, VoiceDock,
  type CallStageNotice, type CallTileProps, type VoiceDockProps,
} from '@dilla/ui';
import { en, t } from '../../strings/index.ts';
import { micNoticeKey, participantView, userName, voiceStateLabels } from '../shell-model.ts';
import type { CallView } from './useCall.tsx';

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
}

const VOLUME = /^(0|[1-9]0|1[0-9]0|200)$/;
function volumeOf(settings: Readonly<Record<string, string>>, userId: string): number {
  const v = settings[SETTINGS.voiceVolume(userId)];
  return v !== undefined && VOLUME.test(v) ? Number(v) : 100;
}

/** The own tile reads as speaking from this level of the 12-step input meter up, while the microphone is on. */
const SPEAKING_LEVEL = 3;

function tileLabels(name: string): CallTileProps['labels'] {
  return { state: voiceStateLabels(), volume: t('voice.volume', { name }), volumeValue: en['voice.volumeValue'] };
}

/** The tiles of the call this device is in: the session's tiles (others) and the own one first. */
function callTiles(v: VoiceContext, channelId: string): CallTileProps[] {
  const { call } = v;
  const state = call.state;
  const room = v.voice?.[channelId];
  const own = v.self === null ? [] : [{
    view: {
      deviceId: v.ownDevice ?? 'own', userId: v.self.id, name: userName(v.self.id, v.members, v.trust), state: 'ok' as const,
      speaking: state !== null && !state.muted && !state.deafened && state.level >= SPEAKING_LEVEL, muted: state?.muted ?? false, deafened: state?.deafened ?? false, video: state?.camera ?? false,
      screen: state?.sharing ?? false, web: true, bot: false,
    },
    own: true, volume: 100, media: null, labels: tileLabels(v.self.username), onVolume: () => undefined,
  }];
  const others = (state?.tiles ?? []).map(tile => {
    const p = room?.participants.find(r => r.deviceId === tile.deviceId);
    const name = p?.name ?? userName(tile.userId, v.members, v.trust);
    const view = p !== undefined ? participantView(p, tile.state, tile.speaking)
      : { deviceId: tile.deviceId, userId: tile.userId, name, state: tile.state, speaking: tile.speaking, muted: false, deafened: false,
        video: tile.video !== null, screen: tile.screen !== null, web: false, bot: false };
    return { view, own: false, volume: volumeOf(v.settings, tile.userId), media: tile.video ?? tile.screen, labels: tileLabels(name),
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
      const text = v.call.blockedMidCall === channelId ? t('voice.blocked')
        : slice.error?.code === 'E_UMK_CHANGED' && name !== null ? t('voice.blockedChanged', { name }) : t('voice.blockedJoin');
      return { kind: 'blocked', text, action: null, focusOnce: true };
    }
    if (slice.phase === 'failed' && v.call.channelId !== channelId) return { kind: 'info', text: t('voice.failed'), action: null, focusOnce: false };
  }
  if (v.call.notice?.channelId === channelId) return { kind: 'info', text: t(v.call.notice.key), action: null, focusOnce: false };
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

function Controls({ v, paused, dm }: { v: VoiceContext; paused: boolean; dm: boolean }) {
  const s = v.call.state;
  const canShare = typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  // WB a11y I4: the toggles keep one label; WB a11y m6: *call* names a DM call only, so a voice channel's toolbar has
  // its own name (the dock's is voice.dock.region).
  return (
    <CallControls muted={s?.muted ?? false} deafened={s?.deafened ?? false} camera={s?.camera ?? false} sharing={s?.sharing ?? false}
      canCamera={!paused} canShare={!paused && canShare} busy={v.call.session === null}
      labels={{ region: t(dm ? 'voice.controls.region' : 'voice.controls.voice'), mute: t('voice.mute'), deafen: t('voice.deafen'),
        camera: t('voice.cameraOn'), share: t('voice.shareOn'), leave: t('voice.leave') }}
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
          : held ? null : <Button variant="accent" className="dw-voice-join" onClick={() => v.call.join(channelId)}>{t('voice.join')}</Button>}
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
  // A ring lasts 30 s (R5): once that long has passed with nobody answering, the strip says so.
  const [expired, setExpired] = useState(false);
  const ringing = outgoing !== null && outgoing.ringing.length > 0;
  useEffect(() => {
    setExpired(false);
    if (!ringing) return;
    const timer = setTimeout(() => setExpired(true), RING_MS);
    return () => clearTimeout(timer);
  }, [ringing]);
  const inThisCall = v.call.channelId === channelId;
  const others = (v.voice?.[channelId]?.participants ?? []).some(p => p.userId !== v.self?.id);
  const text = inThisCall ? outgoingText(outgoing, others, expired) : null;
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
        {inThisCall || held ? null : (
          <Button className="dw-call-strip__start" onClick={() => v.call.join(channelId)}>{t(live ? 'call.join' : 'call.start')}</Button>
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

const RING_MS = 30_000;

/**
 * The outgoing ring's line (R3, R7): `ringing {names}` while it rings, `{name} declined.` per decline, `No answer.` once
 * every ring ended (30 s, or nobody left ringing) with nobody else in the call; null when there is nothing to say.
 */
export function outgoingText(outgoing: CallState['outgoing'], othersInCall: boolean, expired: boolean): string | null {
  if (outgoing === null) return null;
  const parts: string[] = [];
  if (outgoing.ringing.length > 0 && !expired) parts.push(t('call.outgoing.ringing', { names: outgoing.ringing.join(', ') }));
  for (const name of outgoing.declined) parts.push(t('call.outgoing.declined', { name }));
  if (!othersInCall && (expired || outgoing.ringing.length === 0) && outgoing.declined.length === 0) parts.push(t('call.outgoing.noAnswer'));
  return parts.length > 0 ? parts.join(' ') : null;
}

/** One stop for the rows: the stop row and its join button are tab stops, every other row and join is not. */
function place(rows: readonly HTMLButtonElement[], stop: number): void {
  rows.forEach((row, i) => {
    row.tabIndex = i === stop ? 0 : -1;
    const join = row.parentElement?.querySelector<HTMLButtonElement>('.dw-voice-section__join');
    if (join) join.tabIndex = row.tabIndex;
  });
}

/** One voice row of the sidebar with its people, and `voice.join` on focus or hover (flow 06 § States, idle). */
interface VoiceRowItem { id: string; name: string; readable: boolean; current: boolean; joined: boolean; room: VoiceCall | undefined }

/**
 * The sidebar's voice channels under the `voice.heading.channels` heading: one roving tab stop over the rows, the people
 * of each live voice under its row, and a `join voice` button that shows while the row is hovered or focused. The stop
 * row's join is the next tab stop after it (task-9 ruling: keyboard reachable); arrows move both together.
 */
export function VoiceSection({ rows, onOpen, onJoin }: { rows: readonly VoiceRowItem[]; onOpen: (id: string) => void; onJoin: (id: string) => void }) {
  const list = useRef<HTMLUListElement>(null);
  const items = () => Array.from(list.current?.querySelectorAll<HTMLButtonElement>(':scope > li > .d-voice-row') ?? []);
  // Roving focus over the rows (one tab stop, arrows move it), as the channel list's: native listeners on the list.
  useLayoutEffect(() => {
    const ul = list.current;
    if (ul === null) return;
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const all = items();
      const target: EventTarget | null = e.target;
      const from = target instanceof HTMLButtonElement ? all.indexOf(target) : -1;
      if (from < 0) return;
      const to = e.key === 'ArrowDown' ? Math.min(from + 1, all.length - 1) : e.key === 'ArrowUp' ? Math.max(from - 1, 0)
        : e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : null;
      if (to === null) return;
      e.preventDefault();
      place(all, to);
      all[to].focus();
    };
    const onFocus = (e: FocusEvent) => {
      const target: EventTarget | null = e.target;
      const all = items();
      const i = target instanceof HTMLButtonElement ? all.indexOf(target) : -1;
      if (i >= 0) place(all, i);
    };
    ul.addEventListener('keydown', onKeyDown);
    ul.addEventListener('focusin', onFocus);
    return () => { ul.removeEventListener('keydown', onKeyDown); ul.removeEventListener('focusin', onFocus); };
  }, [rows.length]);
  useLayoutEffect(() => {
    const all = items();
    if (all.length === 0) return;
    const stop = all.findIndex(b => b.tabIndex === 0);
    const current = all.findIndex(b => b.getAttribute('aria-current') === 'page');
    const keep = stop >= 0 && all.filter(b => b.tabIndex === 0).length === 1 ? stop : current >= 0 ? current : 0;
    place(all, keep);
  });
  if (rows.length === 0) return null;
  const labels = rowLabels();
  return (
    <section className="dw-voice-section" aria-labelledby="dw-voice-heading">
      <h2 id="dw-voice-heading" className="dw-voice-section__heading d-label">{t('voice.heading.channels')}</h2>
      {/* role="list": Safari drops a list's semantics under list-style: none. */}
      {/* eslint-disable-next-line jsx-a11y/no-redundant-roles */}
      <ul role="list" ref={list} className="dw-voice-section__list">
        {rows.map(r => <VoiceSectionItem key={r.id} r={r} labels={labels} onOpen={onOpen} onJoin={onJoin} />)}
      </ul>
    </section>
  );
}

/** One row of the voice section with its join button, which has its own place in the row's line (WB a11y m4: it never
 *  covers the row's count or focus ring) and is described by the channel's name, so a list of buttons tells them apart. */
function VoiceSectionItem({ r, labels, onOpen, onJoin }: { r: VoiceRowItem; labels: ReturnType<typeof rowLabels>; onOpen: (id: string) => void; onJoin: (id: string) => void }) {
  const nameId = useId();
  return (
    <li className="dw-voice-section__item" data-joined={r.joined ? 'true' : undefined}>
      <VoiceChannelRow name={r.name} current={r.current} joined={r.joined} readable={r.readable}
        participants={(r.room?.participants ?? []).map(p => participantView(p))} labels={labels} onOpen={() => onOpen(r.id)} />
      {r.joined ? null : (
        <>
          <span id={nameId} hidden>{r.name}</span>
          <button type="button" className="d-btn dw-voice-section__join" data-variant="ghost" data-size="sm" tabIndex={-1}
            aria-describedby={nameId} onClick={() => onJoin(r.id)}><span className="d-btn__label">{t('voice.join')}</span></button>
        </>
      )}
    </li>
  );
}

function rowLabels() {
  return { open: en['voice.open'], count: en['voice.count'], canHear: t('voice.bot.canHear'), state: voiceStateLabels() };
}

/** `active voice`: the community's live voice channels above the channel rows. */
export function ActiveVoiceList({ rows, onOpen }: { rows: readonly VoiceRowItem[]; onOpen: (id: string) => void }): ReactNode {
  const live = rows.filter(r => (r.room?.participants.length ?? 0) > 0);
  return (
    <ActiveVoice channels={live.map(r => ({ id: r.id, name: r.name, current: r.current, joined: r.joined,
      participants: (r.room?.participants ?? []).map(p => participantView(p)) }))}
      labels={{ heading: t('voice.heading.active'), ...rowLabels() }} onOpen={onOpen} />
  );
}

/**
 * The dock above the user panel while this device is in voice (flow 06): where, the input meter, mute, deafen and leave,
 * and the one polite status region. While the call is paused and its stage is not on screen, the pause banner and its
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
  const phase: VoiceDockProps['phase'] = paused ? 'paused' : call.session === null || call.state?.phase === 'connecting' ? 'connecting'
    : call.state?.phase === 'reconnecting' ? 'reconnecting' : 'connected';
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
      <VoiceDock phase={phase} where={where} muted={call.state?.muted ?? false} deafened={call.state?.deafened ?? false}
        announcement={call.announcement}
        labels={{ region: t('voice.dock.region'), connecting: t('voice.dock.connecting'), connected: en['voice.dock.connected'],
          reconnecting: t('voice.dock.reconnecting'), paused: en['voice.dock.paused'], mute: t('voice.mute'),
          deafen: t('voice.deafen'), leave: t('voice.leave') }}
        meter={<>
          <AudioMeter level={call.state?.level ?? 0} label={t('settings.voice.level')} />
          {call.state?.mode === 'ptt' ? <p className="dw-voice-dock__mode">{t('settings.voice.ptt')}</p> : null}
        </>}
        onMute={call.toggleMute} onDeafen={call.toggleDeafen} onLeave={call.leave} />
    </div>
  );
}

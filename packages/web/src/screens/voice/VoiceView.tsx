// The shell's voice surfaces (web-3 task 9, flow 06): the voice view of a voice channel route, the DM call strip and
// its stage, the sidebar's voice section and the dock. Everything here is presentational over useCall's CallView and the
// worker's `call` and `voice` slices; nothing here holds media or keys.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { CallState, MemberSummary, TrustSummary, VoiceCall } from '@dilla/client-core';
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
      speaking: false, muted: state?.muted ?? false, deafened: state?.deafened ?? false, video: state?.camera ?? false,
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
    if (slice.phase === 'paused') {
      const changed = slice.changedUser;
      return { kind: 'paused', text: t('voice.paused', { name: name ?? '' }), focusOnce: true,
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

/** True while the slice says joining is paused for this channel by a contact whose identity is still changed. */
function joinHeld(v: VoiceContext, channelId: string): boolean {
  const s = v.slice;
  if (s?.channelId !== channelId || s.phase !== 'blocked' || s.changedUser === null) return false;
  const row = v.trust?.find(r => r.userId === s.changedUser);
  return row !== undefined && (row.changedUmk !== null || row.blocked === 'E_UMK_CHANGED');
}

/** Moves focus to the stage's first control once per join (flow 06 § Focus rules: join and answer). */
function useStageFocus(ref: React.RefObject<HTMLDivElement | null>, call: CallView) {
  // No dependency list: the join attaches in any render after the stage mounted.
  useLayoutEffect(() => {
    if (call.session === null) return;
    const first = ref.current?.querySelector<HTMLButtonElement>('[role="toolbar"] button');
    if (first !== null && first !== undefined && call.takeStageFocus()) first.focus();
  });
}

function Controls({ v, paused }: { v: VoiceContext; paused: boolean }) {
  const s = v.call.state;
  const canShare = typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  return (
    <CallControls muted={s?.muted ?? false} deafened={s?.deafened ?? false} camera={s?.camera ?? false} sharing={s?.sharing ?? false}
      canCamera={!paused} canShare={!paused && canShare} busy={v.call.session === null}
      labels={{ region: t('voice.controls.region'), mute: t('voice.mute'), unmute: t('voice.unmute'), deafen: t('voice.deafen'),
        undeafen: t('voice.undeafen'), cameraOn: t('voice.cameraOn'), cameraOff: t('voice.cameraOff'), shareOn: t('voice.shareOn'),
        shareOff: t('voice.shareOff'), leave: t('voice.leave') }}
      onMute={v.call.toggleMute} onDeafen={v.call.toggleDeafen} onCamera={v.call.toggleCamera} onShare={v.call.toggleShare}
      onLeave={v.call.leave} />
  );
}

const STAGE_LABELS = () => ({ code: t('voice.code'), codeHelp: t('voice.codeHelp'), empty: t('voice.empty'), tiles: t('voice.tiles') });

/** The stage of the call this device is in (or is joining) for `channelId`. */
function InCallStage({ v, channelId, title, outgoing }: { v: VoiceContext; channelId: string; title: string; outgoing: { text: string } | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useStageFocus(ref, v.call);
  const notice = stageNotice(v, channelId);
  const paused = v.slice?.channelId === channelId && v.slice.phase === 'paused';
  const code = v.slice?.channelId === channelId && v.slice.phase === 'in' ? v.slice.code : null;
  return (
    <div ref={ref} className="dw-voice-stage" data-doc-state="voice-stage" data-call-phase={v.slice?.channelId === channelId ? v.slice.phase : 'joining'}>
      <CallStage title={title} tiles={callTiles(v, channelId)} code={code} notice={notice} outgoing={outgoing}
        controls={<Controls v={v} paused={paused} />} labels={STAGE_LABELS()} />
    </div>
  );
}

/** The voice view of a voice channel route (`/c/<community>/<voice channel>`). */
export function VoiceView({ v, channelId, name }: { v: VoiceContext; channelId: string; name: string }): React.JSX.Element {
  const title = t('voice.open', { name });
  if (v.call.channelId === channelId) return <InCallStage v={v} channelId={channelId} title={title} outgoing={null} />;
  const notice = stageNotice(v, channelId);
  const held = joinHeld(v, channelId);
  const blocked = notice?.kind === 'blocked';
  return (
    <div className="dw-voice-stage" data-doc-state={blocked ? 'voice-blocked' : 'voice-stage'}
      data-call-phase={v.slice?.channelId === channelId ? v.slice.phase : 'idle'}>
      <CallStage title={title} tiles={roomTiles(v, channelId)} code={null} notice={notice} outgoing={null}
        controls={held ? null : <Button variant="accent" className="dw-voice-join" onClick={() => v.call.join(channelId)}>{t('voice.join')}</Button>}
        labels={STAGE_LABELS()} />
    </div>
  );
}

/** A notice outside a stage (the DM strip): role=status, focus moves to it once per text when asked. */
function StripNotice({ notice }: { notice: CallStageNotice }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const focused = useRef<string | null>(null);
  useEffect(() => {
    if (!notice.focusOnce || focused.current === notice.text) return;
    focused.current = notice.text;
    ref.current?.focus();
  }, [notice.text, notice.focusOnce]);
  return <p ref={ref} className="dw-call-strip__notice" role="status" tabIndex={-1} data-kind={notice.kind}>{notice.text}</p>;
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
  if (v.call.channelId === channelId) {
    const others = (v.voice?.[channelId]?.participants ?? []).some(p => p.userId !== v.self?.id);
    const text = outgoingText(outgoing, others, expired);
    return <div className="dw-dm-call"><InCallStage v={v} channelId={channelId} title={name} outgoing={text === null ? null : { text }} /></div>;
  }
  const live = (v.voice?.[channelId]?.participants.length ?? 0) > 0;
  const notice = stageNotice(v, channelId);
  const held = joinHeld(v, channelId);
  return (
    <div className="dw-call-strip" data-doc-state={notice?.kind === 'blocked' ? 'voice-blocked' : undefined}
      data-call-phase={v.slice?.channelId === channelId ? v.slice.phase : 'idle'}>
      {notice !== null ? <StripNotice notice={notice} /> : null}
      {held ? null : (
        <Button className="dw-call-strip__start" onClick={() => v.call.join(channelId)}>{t(live ? 'call.join' : 'call.start')}</Button>
      )}
    </div>
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

/** One voice row of the sidebar with its people, and `voice.join` on focus or hover (flow 06 § States, idle). */
interface VoiceRowItem { id: string; name: string; readable: boolean; current: boolean; joined: boolean; room: VoiceCall | undefined }

/**
 * The sidebar's voice channels under the `voice.heading.channels` heading: one roving tab stop over the rows, the people
 * of each live voice under its row, and a `join voice` button that shows while the row is hovered or focused. The
 * button is not a tab stop of its own: from the keyboard, the row opens the voice view, whose first control is join.
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
      all.forEach((b, i) => { b.tabIndex = i === to ? 0 : -1; });
      all[to].focus();
    };
    const onFocus = (e: FocusEvent) => {
      const target: EventTarget | null = e.target;
      const all = items();
      const i = target instanceof HTMLButtonElement ? all.indexOf(target) : -1;
      if (i >= 0) all.forEach((b, j) => { b.tabIndex = j === i ? 0 : -1; });
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
    all.forEach((b, i) => { b.tabIndex = i === keep ? 0 : -1; });
  });
  if (rows.length === 0) return null;
  const labels = rowLabels();
  return (
    <section className="dw-voice-section" aria-labelledby="dw-voice-heading">
      <h2 id="dw-voice-heading" className="dw-voice-section__heading d-label">{t('voice.heading.channels')}</h2>
      {/* role="list": Safari drops a list's semantics under list-style: none. */}
      {/* eslint-disable-next-line jsx-a11y/no-redundant-roles */}
      <ul role="list" ref={list} className="dw-voice-section__list">
        {rows.map(r => (
          <li key={r.id} className="dw-voice-section__item" data-joined={r.joined ? 'true' : undefined}>
            <VoiceChannelRow name={r.name} current={r.current} joined={r.joined} readable={r.readable}
              participants={(r.room?.participants ?? []).map(p => participantView(p))} labels={labels} onOpen={() => onOpen(r.id)} />
            {r.joined ? null : (
              <button type="button" className="d-btn dw-voice-section__join" data-variant="ghost" data-size="sm" tabIndex={-1}
                aria-label={t('voice.join')} onClick={() => onJoin(r.id)}><span className="d-btn__label">{t('voice.join')}</span></button>
            )}
          </li>
        ))}
      </ul>
    </section>
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
  const focused = useRef<string | null>(null);
  const id = call.channelId;
  const paused = id !== null && v.slice?.channelId === id && v.slice.phase === 'paused';
  const banner = paused && !stageShown ? stageNotice(v, id) : null;
  const bannerText = banner?.text ?? null;
  useEffect(() => {
    if (bannerText === null) { focused.current = null; return; }
    if (focused.current === bannerText) return;
    focused.current = bannerText;
    bannerRef.current?.querySelector('button')?.focus();
  }, [bannerText]);
  if (id === null) return null;
  const phase: VoiceDockProps['phase'] = paused ? 'paused' : call.session === null || call.state?.phase === 'connecting' ? 'connecting'
    : call.state?.phase === 'reconnecting' ? 'reconnecting' : 'connected';
  return (
    <div className="dw-voice-dock" data-doc-state="voice-dock">
      {banner !== null ? (
        <div ref={bannerRef} className="dw-voice-dock__paused">
          <p>{banner.text}</p>
          {banner.action !== null ? <Button size="sm" onClick={() => banner.action?.onAction()}>{banner.action.label}</Button> : null}
        </div>
      ) : null}
      <VoiceDock phase={phase} where={where} muted={call.state?.muted ?? false} deafened={call.state?.deafened ?? false}
        announcement={call.announcement}
        labels={{ region: t('voice.dock.region'), connecting: t('voice.dock.connecting'), connected: en['voice.dock.connected'],
          reconnecting: t('voice.dock.reconnecting'), paused: en['voice.dock.paused'], mute: t('voice.mute'), unmute: t('voice.unmute'),
          deafen: t('voice.deafen'), undeafen: t('voice.undeafen'), leave: t('voice.leave') }}
        meter={<AudioMeter level={call.state?.level ?? 0} label={t('settings.voice.level')} />}
        onMute={call.toggleMute} onDeafen={call.toggleDeafen} onLeave={call.leave} />
    </div>
  );
}

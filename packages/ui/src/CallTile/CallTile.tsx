import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import './CallTile.css';
import { Icon } from '../Icon/Icon.tsx';
import { StateDot } from '../StateDot/StateDot.tsx';
import { Avatar } from '../Avatar/Avatar.tsx';
import { Tag } from '../Tag/Tag.tsx';

/** How far a participant's stream got (L-UI-60); shared with the page call session's tiles (L-WEB-50). */
export type VoiceTileState = 'connecting' | 'not-heard' | 'ok' | 'unverified';

/** The words of the participant states (L-UI-60), filled from L-COPY-05's `voice.state.*` and `web`/`bot`. */
export interface VoiceStateLabels {
  speaking: string; muted: string; deafened: string; notHeard: string; unverified: string; connecting: string;
  video: string; screen: string; web: string; bot: string;
  /** A remote screen tile that carries no sound (#37, `voice.state.noSound`). */
  noSound: string;
}

/** One device in voice, as the sidebar rows and the stage tiles show it (L-UI-60). */
export interface VoiceParticipantView {
  deviceId: string; userId: string; name: string; state: VoiceTileState;
  speaking: boolean; muted: boolean; deafened: boolean; video: boolean; screen: boolean; web: boolean; bot: boolean;
  /** AW6: listed under the AFK channel with no voice connection (the away roster); a sidebar row says `away`. */
  away?: boolean;
}

export interface CallTileProps {
  view: VoiceParticipantView;
  /** This device's own tile: no volume of its own. */
  own: boolean;
  /** 0..200, the per-person volume in percent. */
  volume: number;
  /** The stream of this tile's source (a camera or a screen; one tile per source), or null. Never attached while the
   *  stream is unverified. */
  media: MediaStream | null;
  /** The own camera's self-view is mirrored, as a mirror shows a face (product walk I3). A screen is never mirrored. */
  mirror?: boolean;
  /** The tile's key in the stage (R27): `${deviceId}:${source}`; defaults to `view.deviceId`. */
  id?: string;
  /** What the tile shows: a person's camera (default), a shared screen, or an avatar without media. */
  source?: 'camera' | 'screen' | 'avatar';
  /** The tile's name, e.g. 'ada' or the filled `stage.screen`; defaults to `view.name`. It names the focus button. */
  title?: string;
  /** #37: a `screen` tile whose share carries no sound shows the glyph-only `no sound` state in its caption. It is about the
   *  stream, never about the viewer's own choice: a muted stream (see `stream`) does not show it. */
  silent?: boolean;
  /**
   * #37 T5: the stream's own volume and mute, on a remote `screen` tile that carries sound. The range is the stream volume
   * (0..200, as the person's voice range); the toggle is the stream at volume 0 (`aria-pressed` when it is 0), so there
   * is one value behind both. `labels.volume` is the filled `voice.streamVolume`, `labels.mute` the fixed `voice.streamMute`
   * (the label never swaps; the WAI-ARIA toggle pattern).
   */
  stream?: { volume: number; labels: { volume: string; mute: string }; onVolume(volume: number): void; onMute(): void };
  /** The name of the full-screen button. Without it the tile renders no full-screen button. */
  fullscreenLabel?: string;
  /** Injected by `CallStage`: this tile is the focused one. */
  focused?: boolean;
  /** Injected by `CallStage`: toggles this tile's focus. Without it the tile has no focus button. */
  onFocusTile?(): void;
  /** Injected by `CallStage` on the focused tile: back to the grid (the prototype's Grid button, `gridLabel` its text). */
  onGrid?(): void;
  gridLabel?: string;
  /**
   * `volume` is the filled `voice.volume` ('volume for {name}'); `volumeValue` is `voice.volumeValue` ('{n} %'), the
   * spoken value of the range, with `{n}` filled here.
   */
  labels: { state: VoiceStateLabels; volume: string; volumeValue: string };
  onVolume(volume: number): void;
}

/**
 * One participant state. A glyph-only state (muted, deafened, camera, screen, speaking: R29) has no visible word: its
 * `text` is the accessible name and the tooltip. A stream state keeps its glyph and its word (trust and diagnosis).
 */
export interface VoiceStateWord { key: string; glyph: ReactNode; text: string; glyphOnly: boolean }

/**
 * The states of a participant, in reading order: muted, deafened, camera, screen, speaking (glyph-only), then the
 * stream state when it is not ok (glyph plus word). `web` and `bot` are tags, not states, and are left to the caller.
 */
export function voiceStateWords(view: VoiceParticipantView, labels: VoiceStateLabels): VoiceStateWord[] {
  const out: VoiceStateWord[] = [];
  if (view.muted) out.push({ key: 'muted', glyph: <Icon name="mic-off" size={14} />, text: labels.muted, glyphOnly: true });
  if (view.deafened) out.push({ key: 'deafened', glyph: <Icon name="headphone-off" size={14} />, text: labels.deafened, glyphOnly: true });
  if (view.video) out.push({ key: 'video', glyph: <Icon name="video" size={14} />, text: labels.video, glyphOnly: true });
  if (view.screen) out.push({ key: 'screen', glyph: <Icon name="monitor-up" size={14} />, text: labels.screen, glyphOnly: true });
  if (view.speaking) out.push({ key: 'speaking', glyph: <StateDot tone="ok" />, text: labels.speaking, glyphOnly: true });
  if (view.state === 'connecting') out.push({ key: 'connecting', glyph: <StateDot tone="pending" />, text: labels.connecting, glyphOnly: false });
  if (view.state === 'not-heard' && !silentByChoice(view)) out.push({ key: 'not-heard', glyph: '?', text: labels.notHeard, glyphOnly: false });
  if (view.state === 'unverified') out.push({ key: 'unverified', glyph: '!', text: labels.unverified, glyphOnly: false });
  return out;
}

/**
 * web3.8 FX I2: a person who says they are muted or deafened (their own voice_state) and sends no camera or screen is
 * not expected to send a frame, so a stream nobody has heard yet is shown as the muted glyph alone, not "not heard yet".
 * The stream state itself stays `not-heard` (nothing was verified, and no media is shown before it is); a person who says
 * they send (unmuted, or a camera or screen) and is not heard keeps the word, and an `unverified` device keeps its own.
 */
function silentByChoice(view: VoiceParticipantView): boolean {
  return (view.muted || view.deafened) && !view.video && !view.screen;
}

/**
 * The states as inline spans, for a row or a caption (`prefix` is `d-voice-row` or `d-call-tile`). A glyph-only state
 * is a `role="img"` named and titled by its word, with no text node; a stream state is a decorative glyph and its word.
 */
export function VoiceStates({ words, prefix }: { words: readonly VoiceStateWord[]; prefix: string }): ReactNode {
  return words.map(w => w.glyphOnly ? (
    <span key={w.key} className={`${prefix}__state`} data-state={w.key} role="img" aria-label={w.text} title={w.text}>{w.glyph}</span>
  ) : (
    <span key={w.key} className={`${prefix}__state`} data-state={w.key}>
      <span className={`${prefix}__glyph-state`} aria-hidden="true">{w.glyph}</span>{w.text}
    </span>
  ));
}

/** A live call video: muted (the call's sound is played through WebAudio, never by an element), inline. */
function StreamVideo({ stream, className, mirror }: { stream: MediaStream; className: string; mirror: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    return () => { el.srcObject = null; };
  }, [stream]);
  return <video ref={ref} className={className} data-mirror={mirror ? 'true' : undefined} autoPlay muted playsInline aria-hidden="true" />;
}

/**
 * One tile on the call stage, as its own `<li class="d-call-stage__tile">` (pre-flight C-23).
 *
 * On the stage (`onFocusTile` given; Signal §5.6, the prototype's tiles): a 16:9 tile with the face (a 64px avatar, 34px in
 * the filmstrip, 120px focused), the video, or a shared screen's striped placeholder until its picture arrives. The caption
 * sits over the bottom left: the LIVE tag on a screen, the mute glyph, the name and a three-bar live meter while speaking.
 * Speaking is the tile's 2px --ok edge and the avatar's 5px ring with scale(1.06), with the word kept for assistive
 * technology. Camera and screen are not glyphs here (the tile shows them); a stream state keeps its glyph and word.
 * A focused tile shows Grid (back to the grid) and full screen over its top right (`gridLabel`, `onGrid`, injected by
 * `CallStage`); a grid tile has neither (double-click still toggles full screen on a tile with media). A person's tile has
 * a native range for their volume, 0 to 200 in steps of 10, shown on hover and focus only (D3) with a quiet chip in the
 * caption while it is not 100; the own tile and a `screen` tile have neither.
 *
 * The media and caption sit in a focus `<button aria-pressed>`, and the tools and the range are its siblings, never inside
 * it (R28). Focus only flips `data-focused`: nothing is re-parented (R27). Without `onFocusTile` (the DM call box) the
 * tile is the compact card: the media, then the caption under it.
 */
export function CallTile({ view, own, volume, media, mirror = false, labels, onVolume, id, source = 'camera', title,
  fullscreenLabel, focused = false, onFocusTile, onGrid, gridLabel, silent = false, stream }: CallTileProps) {
  const ticks = useId();
  const streamTicks = useId();
  const popTicks = useId();
  const statesId = useId();
  const moreId = useId();
  const liRef = useRef<HTMLLIElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const sync = () => { setFullscreen(document.fullscreenElement === liRef.current); };
    document.addEventListener('fullscreenchange', sync);
    return () => { document.removeEventListener('fullscreenchange', sync); };
  }, []);
  const name = title ?? view.name;
  const isScreen = source === 'screen';
  const stage = onFocusTile !== undefined;
  const showMedia = media !== null && view.state !== 'unverified' && source !== 'avatar';
  // R25: speaking is the ring, not a dot; the word stays for assistive technology (sr-only below).
  const noSound: VoiceStateWord[] = isScreen && silent
    ? [{ key: 'no-sound', glyph: <Icon name="volume-off" size={12} />, text: labels.state.noSound, glyphOnly: true }] : [];
  // Signal: the stage caption carries the mute glyph (muted or deafened, as the prototype) and stream states, never the camera
  // or screen glyph: the tile itself is the camera or the screen.
  const words = isScreen ? noSound : voiceStateWords(view, labels.state).filter(w => w.key !== 'speaking' && (!stage || (w.key !== 'video' && w.key !== 'screen')));
  const speaking = !isScreen && view.speaking;
  const volumeText = labels.volumeValue.replaceAll('{n}', String(volume));
  // Full screen: a stage tile offers it while focused (the prototype's corner button), a tile with media also by double-click.
  const canFullscreen = fullscreenLabel !== undefined && document.fullscreenEnabled === true;
  const toggleFullscreen = () => {
    const li = liRef.current;
    if (!li) return;
    if (document.fullscreenElement === li) void document.exitFullscreen().catch(() => {});
    else void li.requestFullscreen().catch(() => {});
  };
  const face = showMedia ? (
    <div className="d-call-tile__media">
      <StreamVideo stream={media} className="d-call-tile__video" mirror={mirror} />
    </div>
  ) : stage && isScreen ? (
    <div className="d-call-tile__placeholder" aria-hidden="true"><Icon name="monitor-up" size={13} /><span>{labels.state.screen}</span></div>
  ) : stage ? (
    <div className="d-call-tile__avatar">
      <span className="d-call-tile__avatar-ring" data-speaking={speaking ? 'true' : 'false'} data-shape={view.bot ? 'bot' : undefined}>
        <Avatar name={view.name} size="lg" shape={view.bot ? 'bot' : 'circle'} />
      </span>
    </div>
  ) : null;
  const body = (
    <>
      {face}
      <span className="d-call-tile__caption">
        {stage && isScreen ? <span className="d-call-tile__live" aria-hidden="true"><Tag kind="live" /></span> : null}
        <span id={statesId} className="d-call-tile__states">
          {stage ? <VoiceStates words={words.filter(w => w.glyphOnly)} prefix="d-call-tile" /> : null}
        </span>
        <span className="d-call-tile__name">{name}</span>
        {stage && !isScreen ? <span className="d-call-tile__meter" data-on={speaking ? 'true' : 'false'} aria-hidden="true"><i /><i /><i /></span> : null}
        <span id={moreId} className="d-call-tile__more">
          <VoiceStates words={stage ? words.filter(w => !w.glyphOnly) : words} prefix="d-call-tile" />
          {speaking ? <span className="d-sr-only">{labels.state.speaking}</span> : null}
          {!isScreen && view.web ? <span className="d-call-tile__tag">{labels.state.web}</span> : null}
          {!stage && !isScreen && view.bot ? <span className="d-call-tile__tag">{labels.state.bot}</span> : null}
          {!own && !isScreen && volume !== 100 ? <span className="d-call-tile__chip" aria-hidden="true">{volumeText}</span> : null}
        </span>
      </span>
    </>
  );
  return (
    <li ref={liRef} className="d-call-stage__tile" data-source={source} data-focused={focused ? 'true' : 'false'} data-tile-id={id}
      data-stage={stage ? 'true' : undefined}>
      <div className="d-call-tile" data-source={source} data-voice-state={view.state} data-speaking={view.speaking ? 'true' : 'false'}
        data-own={own ? 'true' : undefined} data-media={showMedia ? 'true' : undefined} data-stage={stage ? 'true' : undefined}
        data-bot={view.bot ? 'true' : undefined}>
        {stage ? (
          <button type="button" className="d-call-tile__focus" aria-pressed={focused} aria-label={name} aria-describedby={`${statesId} ${moreId}`}
            onClick={onFocusTile} onDoubleClick={canFullscreen && showMedia ? toggleFullscreen : undefined}>{body}</button>
        ) : body}
        {stage && focused && (onGrid !== undefined || canFullscreen) ? (
          <span className="d-call-tile__tools">
            {onGrid !== undefined && gridLabel !== undefined ? (
              <button type="button" className="d-call-tile__tool d-call-tile__grid" aria-label={gridLabel} onClick={onGrid}>
                <Icon name="layout-grid" size={13} /><span className="d-call-tile__tool-label" aria-hidden="true">{gridLabel}</span>
              </button>
            ) : null}
            {canFullscreen ? (
              <button type="button" className="d-call-tile__tool d-call-tile__fullscreen" aria-pressed={fullscreen} aria-label={fullscreenLabel}
                onClick={toggleFullscreen}><Icon name={fullscreen ? 'minimize' : 'maximize'} size={14} /></button>
            ) : null}
          </span>
        ) : null}
        {own || isScreen ? null : (
          <VolumeRange label={labels.volume} valueText={volumeText} volume={volume} ticks={ticks} onVolume={onVolume} />
        )}
        {isScreen && !own && stream !== undefined ? (
          <StreamControls stream={stream} valueText={labels.volumeValue.replaceAll('{n}', String(stream.volume))} ticks={streamTicks} popTicks={popTicks} />
        ) : null}
      </div>
    </li>
  );
}

/** The native range of a volume (0..200 in steps of 10) with its value beside it and 100 % marked (product walk M6). */
function VolumeRange({ label, valueText, volume, ticks, onVolume }: {
  label: string; valueText: string; volume: number; ticks: string; onVolume(volume: number): void;
}) {
  return (
    <label className="d-call-tile__volume">
      <span className="d-call-tile__volume-label">{label}</span>
      <span className="d-call-tile__volume-row">
        <input type="range" min={0} max={200} step={10} value={volume} list={ticks}
          aria-valuetext={valueText} style={{ '--d-volume': `${volume / 2}%` } as React.CSSProperties}
          onChange={e => onVolume(Number(e.target.value))} />
        <span className="d-call-tile__volume-value" aria-hidden="true">{valueText}</span>
      </span>
      <datalist id={ticks}><option value="100" /></datalist>
    </label>
  );
}

/**
 * The stream's controls. Desktop: the range and the mute (shown on hover and focus). Phone (CSS swaps them, 44 px): the mute
 * and a volume button showing the value; the button opens a small popover with the range, anchored to the tile. The popover
 * is a keyboard-operable group: focus moves to its range, Escape or a press outside closes it (focus returns to the button),
 * and so does tabbing out of it. It sits in the tile's bottom row, over the buttons, so it spans the tile and never covers the caption.
 */
function StreamControls({ stream, valueText, ticks, popTicks }: {
  stream: NonNullable<CallTileProps['stream']>; valueText: string; ticks: string; popTicks: string;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const popId = useId();
  useEffect(() => {
    if (!open) return;
    box.current?.querySelector('input')?.focus();
    const away = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!box.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => { document.removeEventListener('pointerdown', away); };
  }, [open]);
  // The buttons are hidden while the popover covers them, so focus goes back to the button once it shows again.
  const refocus = useRef(false);
  useEffect(() => { if (!open && refocus.current) { refocus.current = false; button.current?.focus(); } }, [open]);
  const close = () => { refocus.current = true; setOpen(false); };
  return (
    <div className="d-call-tile__stream" data-open={open ? 'true' : undefined} onKeyDown={e => { if (e.key === 'Escape' && open) { e.stopPropagation(); close(); } }}>
      <VolumeRange label={stream.labels.volume} valueText={valueText} volume={stream.volume} ticks={ticks} onVolume={stream.onVolume} />
      <button type="button" className="d-call-tile__mute" aria-pressed={stream.volume === 0} aria-label={stream.labels.mute}
        onClick={stream.onMute}><Icon name={stream.volume === 0 ? 'volume-x' : 'volume-2'} size={16} /></button>
      <button ref={button} type="button" className="d-call-tile__streamvol" aria-label={stream.labels.volume} aria-haspopup="true"
        aria-expanded={open} aria-controls={open ? popId : undefined} onClick={() => { setOpen(o => !o); }}>{valueText}</button>
      {open ? (
        <div ref={box} id={popId} role="group" aria-label={stream.labels.volume} className="d-call-tile__popover"
          onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null) && e.relatedTarget !== button.current) setOpen(false); }}>
          <VolumeRange label={stream.labels.volume} valueText={valueText} volume={stream.volume} ticks={popTicks} onVolume={stream.onVolume} />
        </div>
      ) : null}
    </div>
  );
}

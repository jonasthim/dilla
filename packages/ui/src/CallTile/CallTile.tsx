import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import './CallTile.css';
import { Icon } from '../Icon/Icon.tsx';
import { StateDot } from '../StateDot/StateDot.tsx';
import { Avatar } from '../Avatar/Avatar.tsx';

/** How far a participant's stream got (L-UI-60); shared with the page call session's tiles (L-WEB-50). */
export type VoiceTileState = 'connecting' | 'not-heard' | 'ok' | 'unverified';

/** The words of the participant states (L-UI-60), filled from L-COPY-05's `voice.state.*` and `web`/`bot`. */
export interface VoiceStateLabels {
  speaking: string; muted: string; deafened: string; notHeard: string; unverified: string; connecting: string;
  video: string; screen: string; web: string; bot: string;
}

/** One device in voice, as the sidebar rows and the stage tiles show it (L-UI-60). */
export interface VoiceParticipantView {
  deviceId: string; userId: string; name: string; state: VoiceTileState;
  speaking: boolean; muted: boolean; deafened: boolean; video: boolean; screen: boolean; web: boolean; bot: boolean;
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
  /** The name of the full-screen button. Without it the tile renders no full-screen button. */
  fullscreenLabel?: string;
  /** Injected by `CallStage`: this tile is the focused one. */
  focused?: boolean;
  /** Injected by `CallStage`: toggles this tile's focus. Without it the tile has no focus button. */
  onFocusTile?(): void;
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
  if (view.state === 'not-heard') out.push({ key: 'not-heard', glyph: '?', text: labels.notHeard, glyphOnly: false });
  if (view.state === 'unverified') out.push({ key: 'unverified', glyph: '!', text: labels.unverified, glyphOnly: false });
  return out;
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
 * One tile on the call stage, as its own `<li class="d-call-stage__tile">` (pre-flight C-23). Speaking is the accent
 * outline plus the dot (the outline pulses only when motion is allowed); every other state is a glyph, a stream state
 * keeps its word. A camera or screen stream is shown only for a verified stream: an `unverified` tile never renders a
 * media element (L-UI-61…69), and a tile without media shows the `Avatar`. A person's tile has a native range for their
 * volume, 0 to 200 in steps of 10; the own tile and a `screen` tile have none, and a `screen` tile shows only its title.
 *
 * With `onFocusTile` the media and caption sit in a focus `<button aria-pressed>`, and the full-screen button and the
 * range are its siblings, never inside it (R28). Focus only flips `data-focused`: nothing is re-parented (R27).
 */
export function CallTile({ view, own, volume, media, mirror = false, labels, onVolume, id, source = 'camera', title,
  fullscreenLabel, focused = false, onFocusTile }: CallTileProps) {
  const ticks = useId();
  const statesId = useId();
  const liRef = useRef<HTMLLIElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const sync = () => { setFullscreen(document.fullscreenElement === liRef.current); };
    document.addEventListener('fullscreenchange', sync);
    return () => { document.removeEventListener('fullscreenchange', sync); };
  }, []);
  const name = title ?? view.name;
  const isScreen = source === 'screen';
  const showMedia = media !== null && view.state !== 'unverified' && source !== 'avatar';
  const words = isScreen ? [] : voiceStateWords(view, labels.state);
  const canFullscreen = fullscreenLabel !== undefined && document.fullscreenEnabled === true;
  const toggleFullscreen = () => {
    const li = liRef.current;
    if (!li) return;
    if (document.fullscreenElement === li) void document.exitFullscreen().catch(() => {});
    else void li.requestFullscreen().catch(() => {});
  };
  const body = (
    <>
      {showMedia ? (
        <div className="d-call-tile__media">
          <StreamVideo stream={media} className="d-call-tile__video" mirror={mirror} />
        </div>
      ) : onFocusTile ? <div className="d-call-tile__avatar"><Avatar name={name} size="lg" /></div> : null}
      <span className="d-call-tile__caption">
        <span className="d-call-tile__name">{name}</span>
        <span id={statesId} className="d-call-tile__states">
          <VoiceStates words={words} prefix="d-call-tile" />
          {!isScreen && view.web ? <span className="d-call-tile__tag">{labels.state.web}</span> : null}
          {!isScreen && view.bot ? <span className="d-call-tile__tag">{labels.state.bot}</span> : null}
        </span>
      </span>
    </>
  );
  return (
    <li ref={liRef} className="d-call-stage__tile" data-source={source} data-focused={focused ? 'true' : 'false'} data-tile-id={id}
      data-stage={onFocusTile ? 'true' : undefined}>
      <div className="d-call-tile" data-source={source} data-voice-state={view.state} data-speaking={view.speaking ? 'true' : 'false'}
        data-own={own ? 'true' : undefined} data-media={showMedia ? 'true' : undefined} data-stage={onFocusTile ? 'true' : undefined}>
        {onFocusTile ? (
          <button type="button" className="d-call-tile__focus" aria-pressed={focused} aria-label={name} aria-describedby={statesId}
            onClick={onFocusTile} onDoubleClick={canFullscreen ? toggleFullscreen : undefined}>{body}</button>
        ) : body}
        {canFullscreen ? (
          <button type="button" className="d-call-tile__fullscreen" aria-pressed={fullscreen} aria-label={fullscreenLabel}
            onClick={toggleFullscreen}><Icon name={fullscreen ? 'minimize' : 'maximize'} size={16} /></button>
        ) : null}
        {own || isScreen ? null : (
          <label className="d-call-tile__volume">
            <span className="d-call-tile__volume-label">{labels.volume}</span>
            {/* Product walk M6: the value shows beside the range, and 100 % (the middle of 0 to 200) is marked. */}
            <span className="d-call-tile__volume-row">
              <input type="range" min={0} max={200} step={10} value={volume} list={ticks}
                aria-valuetext={labels.volumeValue.replaceAll('{n}', String(volume))} style={{ '--d-volume': `${volume / 2}%` } as React.CSSProperties}
                onChange={e => onVolume(Number(e.target.value))} />
              <span className="d-call-tile__volume-value" aria-hidden="true">{labels.volumeValue.replaceAll('{n}', String(volume))}</span>
            </span>
            <datalist id={ticks}><option value="100" /></datalist>
          </label>
        )}
      </div>
    </li>
  );
}

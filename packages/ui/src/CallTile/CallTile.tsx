import { useEffect, useId, useRef, type ReactNode } from 'react';
import './CallTile.css';
import { Icon } from '../Icon/Icon.tsx';
import { StateDot } from '../StateDot/StateDot.tsx';

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
  /** The camera or screen stream to show, or null. Never attached while the stream is unverified. With both on, the
   *  screen (product walk I2: it is usually why someone shares). */
  media: MediaStream | null;
  /** The camera while `media` is the screen: a small inset over it (product walk I2); null or absent otherwise. */
  inset?: MediaStream | null;
  /** The own camera's self-view is mirrored, as a mirror shows a face (product walk I3): which element is it. */
  mirror?: 'media' | 'inset' | null;
  /**
   * `volume` is the filled `voice.volume` ('volume for {name}'); `volumeValue` is `voice.volumeValue` ('{n} %'), the
   * spoken value of the range, with `{n}` filled here.
   */
  labels: { state: VoiceStateLabels; volume: string; volumeValue: string };
  onVolume(volume: number): void;
}

/** One state word with its glyph: the glyph is decorative, the word carries the state (never colour alone). */
export interface VoiceStateWord { key: string; glyph: ReactNode; text: string }

/**
 * The words of a participant's state, in reading order: the stream state when it is not ok, then speaking, muted,
 * deafened, camera and screen. `web` and `bot` are tags, not states, and are left to the caller.
 */
export function voiceStateWords(view: VoiceParticipantView, labels: VoiceStateLabels): VoiceStateWord[] {
  const out: VoiceStateWord[] = [];
  if (view.state === 'connecting') out.push({ key: 'connecting', glyph: <StateDot tone="pending" />, text: labels.connecting });
  if (view.state === 'not-heard') out.push({ key: 'not-heard', glyph: '?', text: labels.notHeard });
  if (view.state === 'unverified') out.push({ key: 'unverified', glyph: '!', text: labels.unverified });
  if (view.speaking) out.push({ key: 'speaking', glyph: <StateDot tone="ok" />, text: labels.speaking });
  if (view.muted) out.push({ key: 'muted', glyph: '⊘', text: labels.muted });
  if (view.deafened) out.push({ key: 'deafened', glyph: '⊗', text: labels.deafened });
  if (view.video) out.push({ key: 'video', glyph: <Icon name="video" size={14} />, text: labels.video });
  if (view.screen) out.push({ key: 'screen', glyph: <Icon name="monitor-up" size={14} />, text: labels.screen });
  return out;
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
 * One participant on the call stage. Speaking is the accent outline plus the word (the outline pulses only when
 * motion is allowed); every other state is a glyph plus a word. A camera or screen stream is shown only for a
 * verified stream: an `unverified` tile never renders a media element (L-UI-61…69). Another person's tile has a
 * native range for their volume, 0 to 200 in steps of 10; the own tile has none.
 */
export function CallTile({ view, own, volume, media, inset = null, mirror = null, labels, onVolume }: CallTileProps) {
  const ticks = useId();
  const showMedia = media !== null && view.state !== 'unverified';
  const showInset = showMedia && inset !== null;
  const words = voiceStateWords(view, labels.state);
  return (
    <div className="d-call-tile" data-voice-state={view.state} data-speaking={view.speaking ? 'true' : 'false'}
      data-own={own ? 'true' : undefined} data-media={showMedia ? 'true' : undefined}>
      {showMedia ? (
        <div className="d-call-tile__media">
          <StreamVideo stream={media} className="d-call-tile__video" mirror={mirror === 'media'} />
          {showInset ? <StreamVideo stream={inset} className="d-call-tile__inset" mirror={mirror === 'inset'} /> : null}
        </div>
      ) : null}
      <span className="d-call-tile__name">{view.name}</span>
      <span className="d-call-tile__states">
        {words.map(w => (
          <span key={w.key} className="d-call-tile__state" data-state={w.key}>
            <span className="d-call-tile__glyph" aria-hidden="true">{w.glyph}</span>{w.text}
          </span>
        ))}
        {view.web ? <span className="d-call-tile__tag">{labels.state.web}</span> : null}
        {view.bot ? <span className="d-call-tile__tag">{labels.state.bot}</span> : null}
      </span>
      {own ? null : (
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
  );
}

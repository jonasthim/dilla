import { useEffect, useRef } from 'react';
import './CallTile.css';

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
  /** The camera or screen stream to show, or null. Never attached while the stream is unverified. */
  media: MediaStream | null;
  /** `volume` is the filled `voice.volume` ('volume for {name}'). */
  labels: { state: VoiceStateLabels; volume: string };
  onVolume(volume: number): void;
}

/** One state word with its glyph: the glyph is decorative, the word carries the state (never colour alone). */
export interface VoiceStateWord { key: string; glyph: string; text: string }

/**
 * The words of a participant's state, in reading order: the stream state when it is not ok, then speaking, muted,
 * deafened, camera and screen. `web` and `bot` are tags, not states, and are left to the caller.
 */
export function voiceStateWords(view: VoiceParticipantView, labels: VoiceStateLabels): VoiceStateWord[] {
  const out: VoiceStateWord[] = [];
  if (view.state === 'connecting') out.push({ key: 'connecting', glyph: '◌', text: labels.connecting });
  if (view.state === 'not-heard') out.push({ key: 'not-heard', glyph: '?', text: labels.notHeard });
  if (view.state === 'unverified') out.push({ key: 'unverified', glyph: '!', text: labels.unverified });
  if (view.speaking) out.push({ key: 'speaking', glyph: '●', text: labels.speaking });
  if (view.muted) out.push({ key: 'muted', glyph: '⊘', text: labels.muted });
  if (view.deafened) out.push({ key: 'deafened', glyph: '⊗', text: labels.deafened });
  if (view.video) out.push({ key: 'video', glyph: '▣', text: labels.video });
  if (view.screen) out.push({ key: 'screen', glyph: '▭', text: labels.screen });
  return out;
}

/** A live call video: muted (the call's sound is played through WebAudio, never by an element), inline. */
function StreamVideo({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    return () => { el.srcObject = null; };
  }, [stream]);
  return <video ref={ref} className="d-call-tile__video" autoPlay muted playsInline aria-hidden="true" />;
}

/**
 * One participant on the call stage. Speaking is the accent outline plus the word (the outline pulses only when
 * motion is allowed); every other state is a glyph plus a word. A camera or screen stream is shown only for a
 * verified stream: an `unverified` tile never renders a media element (L-UI-61…69). Another person's tile has a
 * native range for their volume, 0 to 200 in steps of 10; the own tile has none.
 */
export function CallTile({ view, own, volume, media, labels, onVolume }: CallTileProps) {
  const showMedia = media !== null && view.state !== 'unverified';
  const words = voiceStateWords(view, labels.state);
  return (
    <div className="d-call-tile" data-voice-state={view.state} data-speaking={view.speaking ? 'true' : 'false'}
      data-own={own ? 'true' : undefined} data-media={showMedia ? 'true' : undefined}>
      {showMedia ? <StreamVideo stream={media} /> : null}
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
          <input type="range" min={0} max={200} step={10} value={volume} aria-valuetext={`${String(volume)} %`}
            onChange={e => onVolume(Number(e.target.value))} />
        </label>
      )}
    </div>
  );
}

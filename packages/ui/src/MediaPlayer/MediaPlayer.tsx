import { useEffect, useRef } from 'react';
import { Button } from '../Button/Button.tsx';
import './MediaPlayer.css';

export interface MediaPlayerProps {
  kind: 'audio' | 'video';
  /** A page-minted `blob:` URL while ready; null before. */
  src: string | null;
  /** The file's shown name: the media element's accessible name and `{name}` in `labels.play`. */
  name: string;
  state: 'idle' | 'loading' | 'ready' | 'error';
  /** `play` is `media.play` ('play {name}'); `{name}` is filled here. `save` is `media.save`, the visible text. */
  labels: { play: string; loading: string; error: string; save: string };
  onPlay(): void;
  onSave(): void;
  /** The media element fired `error`: the parent renders state 'error'. */
  onError(): void;
  /** False when the row holding the player is not the log's active row: its buttons leave the tab order. */
  tabbable?: boolean;
  /** The accessible name of the error state's save ('save {name}'); its visible text stays `labels.save`. */
  saveName?: string;
}

/**
 * An inline attachment player (L-UI-71). `idle` is one play button; `loading` is the state text; `ready` is the
 * browser's own `<audio controls>` or `<video controls playsinline>`, named for the file, with `preload="metadata"`
 * and never `autoplay` or `loop`: playback starts only on the person's play; `error` (also reached through the
 * element's `error` event) is the error text, announced through the player's status region, and a save button.
 * There are no posters and no captions (R9). A video is at most 480 × 270 CSS px, and the card's width when narrower.
 *
 * Focus stays in the player across its states (flow 06: play, then the native player): when focus was inside it
 * (the play button) as the state changes, it moves to the loading text, then the media element, or to save on an
 * error. A player that did not hold focus never takes it.
 */
export function MediaPlayer({ kind, src, name, state, labels, onPlay, onSave, onError, tabbable = true, saveName }: MediaPlayerProps) {
  const tabIndex = tabbable ? 0 : -1;
  const rootRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLElement | null>(null);
  // True while focus is inside the player. A focused node that unmounts fires no focusout, so the flag survives
  // the state change that removed it, which is when focus has to be put back.
  const focusInside = useRef(false);
  // Set by the play button: the person asked to play here, so the player keeps their focus until it is ready.
  const wantFocus = useRef(false);
  const lastState = useRef(state);

  useEffect(() => {
    if (lastState.current === state) return;
    lastState.current = state;
    if (!focusInside.current && !wantFocus.current) return;
    if (state === 'ready' || state === 'error' || state === 'idle') wantFocus.current = false;
    const active = document.activeElement;
    const root = rootRef.current;
    if (active !== null && active !== document.body && !(root?.contains(active) ?? false)) { focusInside.current = false; return; }
    targetRef.current?.focus();
  }, [state]);

  const setTarget = (el: HTMLElement | null) => { targetRef.current = el; };
  let body = null;
  if (state === 'idle') {
    body = (
      <Button variant="default" className="d-media-player__play" tabIndex={tabIndex} onClick={() => { wantFocus.current = true; onPlay(); }}>
        <span className="d-media-player__glyph" aria-hidden="true">▶</span>{labels.play.replaceAll('{name}', name)}
      </Button>
    );
  } else if (state === 'loading') {
    body = <p ref={setTarget} className="d-media-player__loading" aria-busy="true" tabIndex={-1}>{labels.loading}</p>;
  } else if (state === 'ready') {
    body = kind === 'video' ? (
      <video ref={setTarget} className="d-media-player__video" src={src ?? undefined} controls playsInline preload="metadata" aria-label={name}
        tabIndex={tabbable ? undefined : -1} onError={() => onError()} />
    ) : (
      <audio ref={setTarget} className="d-media-player__audio" src={src ?? undefined} controls preload="metadata" aria-label={name}
        tabIndex={tabbable ? undefined : -1} onError={() => onError()} />
    );
  } else {
    body = (
      <button ref={setTarget} type="button" className="d-btn d-media-player__save" data-variant="default" data-size="md" tabIndex={tabIndex}
        aria-label={saveName} onClick={() => onSave()}><span className="d-btn__label">{labels.save}</span></button>
    );
  }
  return (
    <div ref={rootRef} className="d-media-player" data-kind={kind} data-media-state={state}
      onFocus={() => { focusInside.current = true; }}
      onBlur={e => { if (!(rootRef.current?.contains(e.relatedTarget) ?? false)) focusInside.current = false; }}>
      <p className="d-media-player__error" role="status">
        {state === 'error' ? <><span className="d-media-player__error-glyph" aria-hidden="true">✕</span>{labels.error}</> : null}
      </p>
      <div className="d-media-player__frame">{body}</div>
    </div>
  );
}

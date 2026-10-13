import { Button } from '../Button/Button.tsx';
import './MediaPlayer.css';

export interface MediaPlayerProps {
  kind: 'audio' | 'video';
  /** A page-minted `blob:` URL while ready; null before. */
  src: string | null;
  /** The file's shown name: the media element's accessible name and `{name}` in `labels.play`. */
  name: string;
  state: 'idle' | 'loading' | 'ready' | 'error';
  /** `play` is `media.play` ('play {name}'); `{name}` is filled here. */
  labels: { play: string; loading: string; error: string; save: string };
  onPlay(): void;
  onSave(): void;
  /** The media element fired `error`: the parent renders state 'error'. */
  onError(): void;
  /** False when the row holding the player is not the log's active row: its buttons leave the tab order. */
  tabbable?: boolean;
}

/**
 * An inline attachment player (L-UI-71). `idle` is one play button; `loading` is the state text; `ready` is the
 * browser's own `<audio controls>` or `<video controls playsinline>`, named for the file, with `preload="metadata"`
 * and never `autoplay` or `loop`: playback starts only on the person's play; `error` (also reached through the
 * element's `error` event) is the error text, announced through the player's status region, and a save button.
 * There are no posters and no captions (R9). A video is at most 480 × 270 CSS px, and the card's width when narrower.
 */
export function MediaPlayer({ kind, src, name, state, labels, onPlay, onSave, onError, tabbable = true }: MediaPlayerProps) {
  const tabIndex = tabbable ? 0 : -1;
  let body = null;
  if (state === 'idle') {
    body = (
      <Button variant="default" className="d-media-player__play" tabIndex={tabIndex} onClick={() => onPlay()}>
        <span className="d-media-player__glyph" aria-hidden="true">▶</span>{labels.play.replaceAll('{name}', name)}
      </Button>
    );
  } else if (state === 'loading') {
    body = <p className="d-media-player__loading" aria-busy="true">{labels.loading}</p>;
  } else if (state === 'ready') {
    body = kind === 'video' ? (
      <video className="d-media-player__video" src={src ?? undefined} controls playsInline preload="metadata" aria-label={name}
        tabIndex={tabbable ? undefined : -1} onError={() => onError()} />
    ) : (
      <audio className="d-media-player__audio" src={src ?? undefined} controls preload="metadata" aria-label={name}
        tabIndex={tabbable ? undefined : -1} onError={() => onError()} />
    );
  } else {
    body = (
      <Button variant="default" className="d-media-player__save" tabIndex={tabIndex} onClick={() => onSave()}>{labels.save}</Button>
    );
  }
  return (
    <div className="d-media-player" data-kind={kind} data-media-state={state}>
      <p className="d-media-player__error" role="status">
        {state === 'error' ? <><span className="d-media-player__error-glyph" aria-hidden="true">✕</span>{labels.error}</> : null}
      </p>
      <div className="d-media-player__frame">{body}</div>
    </div>
  );
}

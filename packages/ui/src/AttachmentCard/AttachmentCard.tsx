import type { CSSProperties } from 'react';
import { Button } from '../Button/Button.tsx';
import { MediaPlayer, type MediaPlayerProps } from '../MediaPlayer/MediaPlayer.tsx';
import './AttachmentCard.css';
import { Icon } from '../Icon/Icon.tsx';

export interface AttachmentCardProps {
  /** AttachmentSummary.kind (L-TS-58). 'audio' and 'video' render a MediaPlayer when `player` is given. */
  kind: 'image' | 'audio' | 'video' | 'file';
  name: string;
  size: string;
  thumbUrl: string | null;
  w: number | null;
  h: number | null;
  openLabel: string;
  onOpen?(): void;
  saveLabel: string;
  /** Without it a file card has no save button (an unsent card). */
  onSave?(): void;
  state: 'idle' | 'loading' | 'failed' | 'too-large';
  stateText?: string;
  tabbable: boolean;
  /** The inline player of an audio or video card (L-UI-71); without it, or when too large, the card is a file card. */
  player?: Pick<MediaPlayerProps, 'src' | 'state' | 'labels' | 'onPlay' | 'onError'>;
}

/** The longest side of an image card, in CSS px. */
const CARD_MAX_PX = 320;

/**
 * The card's box: its width in rem (the image scaled so its longer side is at most 320 px, never up) and its
 * aspect ratio, as custom properties the CSS reads. Unknown or non-positive sizes give a 20rem box of 4 / 3.
 */
function cardBox(w: number | null, h: number | null): CSSProperties {
  if (w === null || h === null || !(w > 0) || !(h > 0)) {
    return { '--d-card-w': '20rem', '--d-card-ratio': '4 / 3' } as CSSProperties;
  }
  const px = w * Math.min(1, CARD_MAX_PX / Math.max(w, h));
  const rem = Math.round(px * 1000 / 16) / 1000;
  return { '--d-card-w': `${String(rem)}rem`, '--d-card-ratio': `${String(w)} / ${String(h)}` } as CSSProperties;
}

/**
 * One attachment of a message. An image card is one button (named `openLabel`) holding the thumbnail, whose alt
 * text is the file's shown name, or a neutral box of the image's proportions while there is none (never a broken
 * image). A file card shows a glyph, the name and the size, and a save button only when `onSave` is given. A card
 * too large for a browser has no button. `stateText` follows the card (opening, could not open, too large).
 * An audio or video card with a `player` shows the name and size, the inline MediaPlayer and the save button, which
 * shows `media.save` and is named `saveLabel` (flow 06, label in name); in the player's error state the player's
 * own save, with the same text and name, stands in for the card's.
 */
export function AttachmentCard({
  kind, name, size, thumbUrl, w, h, openLabel, onOpen, saveLabel, onSave, state, stateText, tabbable, player,
}: AttachmentCardProps) {
  const tabIndex = tabbable ? 0 : -1;
  const tooLarge = state === 'too-large';
  const box = <span className="d-attachment-card__box" aria-hidden="true" />;
  let content;
  if (kind === 'image' && tooLarge) {
    // Too large to open here: the neutral box, the name and the size, and no button.
    content = (
      <>
        <div className="d-attachment-card__frame" style={cardBox(w, h)}>{box}</div>
        <p className="d-attachment-card__meta">
          <span className="d-attachment-card__name">{name}</span>
          <span className="d-attachment-card__size">{size}</span>
        </p>
      </>
    );
  } else if (kind === 'image') {
    content = (
      <button type="button" className="d-attachment-card__open" aria-label={openLabel} tabIndex={tabIndex}
        aria-busy={state === 'loading' || undefined} style={cardBox(w, h)} onClick={() => onOpen?.()}>
        {thumbUrl !== null ? <img className="d-attachment-card__thumb" alt={name} src={thumbUrl} data-thumb="ready" /> : box}
      </button>
    );
  } else if ((kind === 'audio' || kind === 'video') && player !== undefined && !tooLarge) {
    content = (
      <div className="d-attachment-card__media">
        <p className="d-attachment-card__meta">
          <span className="d-attachment-card__name">{name}</span>
          <span className="d-attachment-card__size">{size}</span>
        </p>
        <MediaPlayer kind={kind} src={player.src} name={name} state={player.state} labels={player.labels} tabbable={tabbable}
          saveName={saveLabel} onPlay={player.onPlay} onError={player.onError} onSave={() => onSave?.()} />
        {player.state !== 'error' && onSave ? (
          <Button variant="default" size="md" className="d-attachment-card__save d-attachment-card__media-save" aria-label={saveLabel}
            tabIndex={tabIndex} onClick={() => onSave()}>{player.labels.save}</Button>
        ) : null}
      </div>
    );
  } else {
    content = (
      <div className="d-attachment-card__file">
        <span className="d-attachment-card__glyph" aria-hidden="true"><Icon name="file" size={20} /></span>
        <span className="d-attachment-card__name">{name}</span>
        <span className="d-attachment-card__size">{size}</span>
        {!tooLarge && onSave ? (
          <Button variant="default" size="md" className="d-attachment-card__save" aria-label={saveLabel} tabIndex={tabIndex}
            onClick={() => onSave()}>{saveLabel}</Button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="d-attachment-card" data-kind={kind} data-state={state}>
      {content}
      {stateText !== undefined ? <p className="d-attachment-card__state">{stateText}</p> : null}
    </div>
  );
}

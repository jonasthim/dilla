import { Icon } from '../Icon/Icon.tsx';
import './AttachmentTray.css';

export interface AttachmentTrayProps {
  label: string;
  items: readonly {
    id: string; name: string; size: string; phase: string; failed: boolean;
    /** The machine phase, rendered as `data-phase`; `phase` is the text shown while the file is not ready. */
    step: 'reading' | 'preparing' | 'uploading' | 'ready' | 'failed';
    /** Said under a failed entry, only when given (read by a screen reader and shown as the card's tooltip). */
    hint?: string;
    /** An image or a GIF with a preview: the 112px preview card (README §6.8); otherwise the 200px file card. */
    preview?: { url: string; gif?: boolean };
    removeLabel: string; onRemove(): void;
  }[];
}

/**
 * The files waiting to be sent, above the composer's box (README §6.8): a row of 84px cards, 112px previews or 200px file
 * cards, each with its name, its size (or its phase while it is not ready, a polite live region), a 3px progress line (the
 * accent while it works, ok when ready, danger when it failed) and remove ×. Its text is the caller's and never says how a
 * file is protected. Nothing renders while the tray is empty.
 */
export function AttachmentTray({ label, items }: AttachmentTrayProps) {
  if (items.length === 0) return null;
  return (
    <ul className="d-attachment-tray" aria-label={label}>
      {items.map(item => (
        <li key={item.id} className="d-attachment-tray__item" data-phase={item.step} data-failed={item.failed ? 'true' : undefined}
          data-kind={item.preview === undefined ? 'file' : item.preview.gif === true ? 'gif' : 'image'} title={item.hint}>
          {item.preview !== undefined ? (
            <span className="d-attachment-tray__preview" style={{ backgroundImage: `url("${item.preview.url}")` }}>
              {item.preview.gif === true ? <span className="d-attachment-tray__gif" aria-hidden="true">GIF</span> : null}
            </span>
          ) : null}
          <span className="d-attachment-tray__file">
            {item.preview === undefined ? <span className="d-attachment-tray__glyph" aria-hidden="true"><Icon name="file" size={14} /></span> : null}
            <span className="d-attachment-tray__text">
              <span className="d-attachment-tray__name">{item.name}</span>
              <span className="d-attachment-tray__meta">
                {/* The size once the file is ready, the phase until then (the prototype's meta line); the phase stays heard. */}
                <span className="d-attachment-tray__size" hidden={item.step !== 'ready'}>{item.size}</span>
                <span className={item.step === 'ready' ? 'd-attachment-tray__phase d-sr-only' : 'd-attachment-tray__phase'} aria-live="polite">{item.phase}</span>
              </span>
            </span>
          </span>
          {item.hint !== undefined ? <span className="d-attachment-tray__hint d-sr-only">{item.hint}</span> : null}
          <span className="d-attachment-tray__bar" aria-hidden="true"><span /></span>
          <button type="button" className="d-attachment-tray__remove" aria-label={item.removeLabel} title={item.removeLabel} onClick={() => item.onRemove()}>
            <Icon name="x" size={11} />
          </button>
        </li>
      ))}
    </ul>
  );
}

import './AttachmentTray.css';

export interface AttachmentTrayProps {
  label: string;
  items: readonly {
    id: string; name: string; size: string; phase: string; failed: boolean;
    /** The machine phase, rendered as `data-phase`; `phase` is the text shown. */
    step: 'reading' | 'preparing' | 'uploading' | 'ready' | 'failed';
    /** Shown under a failed entry, only when given. */
    hint?: string;
    removeLabel: string; onRemove(): void;
  }[];
}

/**
 * The files waiting to be sent, above the composer: each with its name, size and phase (a polite live region),
 * the hint under a failed entry, and a remove button. Its text is the caller's and never says how a file is
 * protected. Nothing renders while the tray is empty.
 */
export function AttachmentTray({ label, items }: AttachmentTrayProps) {
  if (items.length === 0) return null;
  return (
    <ul className="d-attachment-tray" aria-label={label}>
      {items.map(item => (
        <li key={item.id} className="d-attachment-tray__item" data-phase={item.step} data-failed={item.failed ? 'true' : undefined}>
          <span className="d-attachment-tray__name">{item.name}</span>
          <span className="d-attachment-tray__size">{item.size}</span>
          <span className="d-attachment-tray__phase" aria-live="polite">{item.phase}</span>
          {item.hint !== undefined ? <p className="d-attachment-tray__hint">{item.hint}</p> : null}
          <button type="button" className="d-attachment-tray__remove" aria-label={item.removeLabel} onClick={() => item.onRemove()}>
            <span aria-hidden="true">×</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

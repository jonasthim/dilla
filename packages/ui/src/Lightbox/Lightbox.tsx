import { useEffect, useRef, type KeyboardEvent } from 'react';
import { Button } from '../Button/Button.tsx';
import './Lightbox.css';

export interface LightboxProps {
  open: boolean;
  label: string;
  src: string | null;
  alt: string;
  closeLabel: string;
  onClose(): void;
  saveLabel: string;
  onSave(): void;
  previous?: { label: string; onPrevious(): void };
  next?: { label: string; onNext(): void };
}

/**
 * One image over the whole viewport: a native modal <dialog> named by its label, kept mounted and opened and closed
 * from an effect (Dialog's pattern, so close() hands focus back to the card that opened it), with content only while
 * open. On open the close button takes focus, so the dialog itself never draws a ring. Escape closes; ArrowLeft and
 * ArrowRight go to the previous and next image when there are any. Without a source a neutral box stands in.
 */
export function Lightbox({ open, label, src, alt, closeLabel, onClose, saveLabel, onSave, previous, next }: LightboxProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current; if (!el) return;
    if (open && !el.open) {
      el.showModal();
      el.querySelector<HTMLButtonElement>('.d-lightbox__close')?.focus();
    }
    if (!open && el.open) el.close();
  }, [open]);
  // Close on unmount too, so a lightbox torn down while open still hands focus back.
  useEffect(() => {
    const el = ref.current;
    return () => { if (el?.open) el.close(); };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDialogElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    // A modified arrow is the browser's or the assistive technology's.
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key === 'ArrowLeft' && previous) { e.preventDefault(); previous.onPrevious(); return; }
    if (e.key === 'ArrowRight' && next) { e.preventDefault(); next.onNext(); }
  };

  return (
    <dialog ref={ref} className="d-lightbox" aria-label={label} aria-modal="true" onKeyDown={onKeyDown}
      onCancel={e => { e.preventDefault(); onClose(); }}>
      {open ? (
        <div className="d-lightbox__panel">
          <div className="d-lightbox__stage">
            {src !== null ? <img className="d-lightbox__image" alt={alt} src={src} /> : <span className="d-lightbox__box" aria-hidden="true" />}
          </div>
          <div className="d-lightbox__bar">
            <p className="d-lightbox__label">{label}</p>
            <div className="d-lightbox__nav">
              {previous ? <Button variant="ghost" onClick={() => previous.onPrevious()}>{previous.label}</Button> : null}
              {next ? <Button variant="ghost" onClick={() => next.onNext()}>{next.label}</Button> : null}
            </div>
            <div className="d-lightbox__actions">
              <Button variant="default" onClick={() => onSave()}>{saveLabel}</Button>
              <Button className="d-lightbox__close" variant="ghost" onClick={() => onClose()}>{closeLabel}</Button>
            </div>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Button } from '../Button/Button.tsx';
import './Dialog.css';

export type DialogProps = { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode };

export function Dialog({ open, title, onClose, children, footer }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  // The <dialog> element stays mounted for the component's lifetime and is
  // opened and closed from this effect. Only close() makes the browser
  // return focus to whatever opened the dialog; unmounting the element
  // instead leaves focus on the document body.
  useEffect(() => {
    const el = ref.current; if (!el) return;
    if (open && !el.open) { el.showModal(); el.focus(); }
    if (!open && el.open) el.close();
  }, [open]);
  // Close on unmount too, so a dialog torn down while open still hands
  // focus back.
  useEffect(() => {
    const el = ref.current;
    return () => { if (el?.open) el.close(); };
  }, []);
  return (
    <dialog ref={ref} className="d-dialog" aria-labelledby={titleId} aria-modal="true" tabIndex={-1}
      onCancel={e => { e.preventDefault(); onClose(); }}
      onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } }}
      onClick={e => { if (e.target === ref.current) onClose(); }}>
      {/* Contents exist only while open: a closed dialog leaks no hidden text. */}
      {open ? (
        <div className="d-dialog__panel" onClick={e => e.stopPropagation()}>
          <h2 id={titleId} className="d-dialog__title">{title}</h2>
          <div className="d-dialog__body">{children}</div>
          <div className="d-dialog__footer">
            <Button variant="ghost" keyHint="esc" onClick={onClose}>Close</Button>
            {footer}
          </div>
        </div>
      ) : null}
    </dialog>
  );
}

import { useEffect, useRef, type ReactNode } from 'react';
import { Button } from '../Button/Button.tsx';
import './Dialog.css';

export type DialogProps = { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode };

export function Dialog({ open, title, onClose, children, footer }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    if (open && !el.open) { el.showModal(); el.focus(); }
    if (!open && el.open) el.close();
  }, [open]);
  if (!open) return null;
  return (
    <dialog ref={ref} className="d-dialog" aria-labelledby="d-dialog-title" aria-modal="true" tabIndex={-1}
      onCancel={e => { e.preventDefault(); onClose(); }}
      onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } }}
      onClick={e => { if (e.target === ref.current) onClose(); }}>
      <div className="d-dialog__panel" onClick={e => e.stopPropagation()}>
        <h2 id="d-dialog-title" className="d-dialog__title">{title}</h2>
        <div className="d-dialog__body">{children}</div>
        <div className="d-dialog__footer">
          <Button variant="ghost" keyHint="esc" onClick={onClose}>Close</Button>
          {footer}
        </div>
      </div>
    </dialog>
  );
}

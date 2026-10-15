import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { Button } from '../Button/Button.tsx';
import './Dialog.css';

export type DialogProps = { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; closeLabel?: string;
  /** The id of the element inside that describes the dialog (a confirmation's body). */
  describedBy?: string;
  /**
   * Where focus starts when nothing inside is marked `data-autofocus` (an enabled marked element always wins): the
   * dialog itself (the default) or its close button.
   */
  initialFocus?: 'dialog' | 'close';
  /**
   * Where focus goes on close when the opener is gone and no element carries its `data-focus-key` any more (a deleted
   * row). Resolved at close time.
   */
  returnFocus?: () => HTMLElement | null | undefined };

/**
 * Where focus goes back to when a dialog closes, resolved at close time: the opener while it is still in the document;
 * else the element that now carries the opener's `data-focus-key` (a row re-mounted elsewhere while the dialog was
 * open); else `fallback`. Null when none of them exists: the caller then leaves focus alone.
 */
export function focusReturnTarget(opener: HTMLElement | null, fallback?: () => HTMLElement | null | undefined): HTMLElement | null {
  if (opener !== null && opener.isConnected) return opener;
  const key = opener?.dataset.focusKey;
  if (key !== undefined) {
    const same = Array.from(document.querySelectorAll<HTMLElement>('[data-focus-key]')).find(e => e.dataset.focusKey === key);
    if (same !== undefined) return same;
  }
  return fallback?.() ?? null;
}

const AUTOFOCUS = '[data-autofocus]:not(:disabled)';

export function Dialog({ open, title, onClose, children, footer, closeLabel, describedBy, initialFocus = 'dialog', returnFocus }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  // What had focus when the dialog opened, and the latest fallback (read at close time, so never stale).
  const opener = useRef<HTMLElement | null>(null);
  const fallback = useRef(returnFocus);
  fallback.current = returnFocus;
  // Focus goes back only when it was in the dialog (or was dropped on the body by the dialog leaving the document);
  // a flow that already moved focus elsewhere keeps it there.
  const giveBack = (el: HTMLDialogElement) => {
    const active = document.activeElement;
    const inside = active === null || active === document.body || el.contains(active);
    if (el.open) el.close();
    if (!inside) return;
    const target = focusReturnTarget(opener.current, fallback.current);
    opener.current = null;
    target?.focus();
  };
  // The <dialog> element is opened and closed from this effect. The browser's own focus return on close() covers only
  // an opener still in the document and a dialog that stays mounted, so the return target is resolved here instead.
  // This effect runs after the children's, so a marked element inside wins over the dialog itself.
  // The opener is read in a layout effect, before any child's effect can move focus into the still-closed dialog.
  useLayoutEffect(() => {
    const el = ref.current; if (!el || !open || el.open) return;
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement && active !== document.body && !el.contains(active) ? active : null;
  }, [open]);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    if (open && !el.open) {
      el.showModal();
      const marked = el.querySelector<HTMLElement>(AUTOFOCUS);
      (marked ?? (initialFocus === 'close' ? el.querySelector<HTMLElement>('.d-dialog__footer button') : null) ?? el).focus();
    }
    if (!open && el.open) giveBack(el);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  // A dialog torn down while open (a flow mounted only while it shows) hands focus back too: by then the element has
  // left the document and the browser has put focus on the body.
  useEffect(() => {
    const el = ref.current;
    return () => { if (el?.open) giveBack(el); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <dialog ref={ref} className="d-dialog" aria-labelledby={titleId} aria-describedby={open ? describedBy : undefined} aria-modal="true" tabIndex={-1}
      onCancel={e => { e.preventDefault(); onClose(); }}
      onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } }}
      onClick={e => { if (e.target === ref.current) onClose(); }}>
      {/* Contents exist only while open: a closed dialog leaks no hidden text. */}
      {open ? (
        <div className="d-dialog__panel" onClick={e => e.stopPropagation()}>
          <h2 id={titleId} className="d-dialog__title">{title}</h2>
          <div className="d-dialog__body">{children}</div>
          <div className="d-dialog__footer">
            <Button variant="ghost" keyHint="esc" onClick={onClose}>{closeLabel ?? 'Close'}</Button>
            {footer}
          </div>
        </div>
      ) : null}
    </dialog>
  );
}

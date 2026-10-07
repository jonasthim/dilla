import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Button } from '../Button/Button.tsx';
import './SettingsFrame.css';

export interface SettingsFrameProps {
  open: boolean;
  title: string;
  closeLabel: string;
  onClose(): void;
  nav: ReactNode;
  children: ReactNode;
}

/**
 * The Settings modal of the Mesh brief: 960×640 with a 220px navigation column, on a native
 * <dialog> so the browser traps focus while it is open and returns it to whatever opened it when it
 * closes. Its <h1> takes focus on every open. Escape, the native cancel and a click on the backdrop
 * call `onClose`; an Escape or a cancel that belongs to a dialog nested inside the frame (remove,
 * sign out, forget) is left to that dialog and never closes the frame (pre-flight ruling 1.2).
 */
export function SettingsFrame({ open, title, closeLabel, onClose, nav, children }: SettingsFrameProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  // The <dialog> stays mounted and is opened and closed here: only close() makes the browser
  // return focus to the opener; unmounting it instead leaves focus on the document body.
  useEffect(() => {
    const el = ref.current; if (!el) return;
    if (open && !el.open) { el.showModal(); titleRef.current?.focus(); }
    if (!open && el.open) el.close();
  }, [open]);
  // A frame torn down while open still hands focus back.
  useEffect(() => {
    const el = ref.current;
    return () => { if (el?.open) el.close(); };
  }, []);
  // True when the event started in this frame and not inside a dialog nested in it.
  const ownEvent = (target: EventTarget) => target instanceof Element && target.closest('dialog') === ref.current;
  return (
    <dialog ref={ref} className="d-settings-frame" aria-labelledby={titleId} aria-modal="true"
      onCancel={e => { if (!ownEvent(e.target)) return; e.preventDefault(); onClose(); }}
      onKeyDown={e => { if (e.key === 'Escape' && ownEvent(e.target)) { e.preventDefault(); onClose(); } }}
      onClick={e => { if (e.target === ref.current) onClose(); }}>
      {/* Contents exist only while open: a closed frame leaks no hidden text. */}
      {open ? (
        <div className="d-settings-frame__panel" onClick={e => e.stopPropagation()}>
          <div className="d-settings-frame__side">
            <h1 ref={titleRef} id={titleId} tabIndex={-1} className="d-settings-frame__title">{title}</h1>
            {nav}
          </div>
          <div className="d-settings-frame__pane">
            <div className="d-settings-frame__bar"><Button variant="ghost" keyHint="esc" onClick={onClose}>{closeLabel}</Button></div>
            <div className="d-settings-frame__body">{children}</div>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Button } from '../Button/Button.tsx';
import { Dialog } from '../Dialog/Dialog.tsx';
import './ConfirmDialog.css';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  busyLabel: string;
  cancelLabel: string;
  tone?: 'danger' | 'accent';
  busy: boolean;
  error: string | null;
  /** Counts the refusals the caller has shown. A new count with the same text is a new alert, so it is announced again. */
  attempt?: number;
  /** False keeps the confirm button disabled (a typed name that does not match yet). Defaults to true. */
  canConfirm?: boolean;
  /** Extra fields under the body (a reason, the typed name). */
  children?: ReactNode;
  onConfirm(): void;
  onClose(): void;
}

/**
 * A confirmation over `Dialog`. Focus goes to the first field in `children`, otherwise to Cancel, never to the
 * destructive button. The confirm button is disabled while `!canConfirm` or busy. A refusal is a `role=alert` under the
 * fields, announced again when `attempt` changes.
 */
export function ConfirmDialog({
  open, title, body, confirmLabel, busyLabel, cancelLabel, tone = 'danger', busy, error, attempt = 0, canConfirm = true,
  children, onConfirm, onClose,
}: ConfirmDialogProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  // After Dialog's own open effect (a child's effects run first): a field or Cancel holds focus, not the dialog.
  const cancelButton = () => bodyRef.current?.closest('dialog')?.querySelector<HTMLElement>('.d-dialog__footer button');
  useEffect(() => {
    if (!open) return;
    const field = bodyRef.current?.querySelector<HTMLElement>(
      'input:not([type="hidden"]):not([disabled]):not([readonly]), select:not([disabled]), textarea:not([disabled]):not([readonly])');
    (field ?? cancelButton())?.focus();
  }, [open]);
  // The confirm button was disabled while busy, so focus may have been lost; a refusal puts it on Cancel (never on the
  // destructive button), next to the alert.
  // The error may arrive in the render after busy ended, so a finished run stays "pending" until an error uses it up.
  const wasBusy = useRef(false);
  const pending = useRef(false);
  useEffect(() => {
    if (!open || busy) pending.current = false;
    else if (wasBusy.current) pending.current = true;
    wasBusy.current = busy;
    if (open && pending.current && error !== null) {
      pending.current = false;
      cancelButton()?.focus();
    }
  }, [busy, open, error]);
  const bodyId = `${useId()}-body`;
  return (
    <Dialog open={open} title={title} closeLabel={cancelLabel} onClose={onClose} describedBy={bodyId}
      footer={<Button variant={tone} type="button" disabled={!canConfirm || busy} onClick={onConfirm}>{busy ? busyLabel : confirmLabel}</Button>}>
      <div ref={bodyRef} className="d-confirm-dialog">
        <p id={bodyId} className="d-confirm-dialog__body">{body}</p>
        {children}
        {error !== null ? <p key={attempt} className="d-confirm-dialog__error" role="alert">{error}</p> : null}
      </div>
    </Dialog>
  );
}

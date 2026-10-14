import { useEffect, useId, type FormEvent } from 'react';
import { Banner } from '../Banner/Banner.tsx';
import { Button } from '../Button/Button.tsx';
import { Dialog } from '../Dialog/Dialog.tsx';
import { TextField } from '../TextField/TextField.tsx';
import './CreateServer.css';

export interface CreateServerProps {
  open: boolean;
  /** The name field's value; the caller owns it. */
  name: string;
  onName(name: string): void;
  /** The field's error: an alert and part of the field's description. */
  error: string | null;
  /** A create is in flight: the submit says so and does nothing more. */
  busy: boolean;
  /** The server exists but its starter channels were not added: this notice replaces the field, the submit retries. */
  partial: string | null;
  labels: { title: string; body: string; name: string; hint: string; submit: string; busy: string; close: string; retry: string };
  onSubmit(): void;
  onRetry(): void;
  onClose(): void;
}

/**
 * "Start a server" (flow 07): one field, the server's name, in one form whose submit is the footer's accent button and
 * Enter in the field. Focus starts in the field. A refused create is the field's error; a server that exists without its
 * starter channels says so in a warn banner and offers a retry instead of the field (never a silent rollback).
 */
export function CreateServer({ open, name, onName, error, busy, partial, labels, onSubmit, onRetry, onClose }: CreateServerProps) {
  const base = useId();
  const fieldId = `${base}-name`;
  const formId = `${base}-form`;
  // Runs after Dialog's own open effect (a child's effects run first), so the field, not the dialog, holds focus.
  useEffect(() => {
    if (open && partial === null) document.getElementById(fieldId)?.focus();
  }, [open, partial, fieldId]);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    if (partial !== null) onRetry();
    else onSubmit();
  };
  const action = busy ? labels.busy : partial !== null ? labels.retry : labels.submit;
  return (
    <Dialog open={open} title={labels.title} closeLabel={labels.close} onClose={onClose}
      footer={<Button variant="accent" type="submit" form={formId} aria-disabled={busy || undefined}>{action}</Button>}>
      <form id={formId} className="d-create-server" noValidate onSubmit={submit}>
        {partial !== null ? <Banner tone="warn">{partial}</Banner> : (
          <>
            <p className="d-create-server__body">{labels.body}</p>
            <TextField id={fieldId} label={labels.name} value={name} onChange={onName} hint={labels.hint} error={error ?? undefined}
              required autoComplete="off" spellCheck={false} />
          </>
        )}
      </form>
    </Dialog>
  );
}

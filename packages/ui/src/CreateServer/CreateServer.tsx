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
  /** The server exists but a starter channel was not added: this notice replaces the field, the submit retries (and the
   *  notice stays while the retry runs). */
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
  const submitId = `${base}-submit`;
  const showsNotice = partial !== null;
  // Runs after Dialog's own open effect (a child's effects run first), so the field, not the dialog, holds focus. When the
  // notice replaces the field, focus moves to its retry instead of falling to the page with the field.
  useEffect(() => {
    if (open) document.getElementById(showsNotice ? submitId : fieldId)?.focus();
  }, [open, showsNotice, fieldId, submitId]);
  // A refusal (before or after sending) puts focus back in the field that holds it, also when the submit button was pressed.
  useEffect(() => {
    if (open && error !== null) document.getElementById(fieldId)?.focus();
  }, [open, error, fieldId]);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    if (showsNotice) onRetry();
    else onSubmit();
  };
  const action = busy ? labels.busy : showsNotice ? labels.retry : labels.submit;
  return (
    <Dialog open={open} title={labels.title} closeLabel={labels.close} onClose={onClose}
      footer={<Button id={submitId} variant="accent" type="submit" form={formId} aria-disabled={busy || undefined}>{action}</Button>}>
      <form id={formId} className="d-create-server" noValidate onSubmit={submit}>
        {showsNotice ? <Banner tone="warn">{partial}</Banner> : (
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

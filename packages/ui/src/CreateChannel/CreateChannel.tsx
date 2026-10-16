import { useEffect, useId, type FormEvent, type ReactNode } from 'react';
import { Button } from '../Button/Button.tsx';
import { Dialog } from '../Dialog/Dialog.tsx';
import { Segmented } from '../Segmented/Segmented.tsx';
import { TextField } from '../TextField/TextField.tsx';
import './CreateChannel.css';

export type NewChannelKind = 'text' | 'voice' | 'announcement';

export interface CreateChannelProps {
  open: boolean;
  kind: NewChannelKind;
  onKind(kind: NewChannelKind): void;
  name: string;
  onName(name: string): void;
  /** The field's hint: the caller says how the name will show (`#ship-talk`) and its bound. */
  hint: string;
  error: string | null;
  busy: boolean;
  /** Counts the refusals and failures the caller has shown. A new count with the same text is a new alert, so it is
   *  announced again and puts focus back where it belongs (review M3). */
  attempt?: number;
  /** `announcement` adds the third kind; without it the group shows text and voice only. */
  labels: { title: string; kind: string; text: string; voice: string; announcement?: string; name: string; submit: string; busy: string; close: string };
  onSubmit(): void;
  onClose(): void;
  /** Extra fields, rendered inside the form after the name field. */
  children?: ReactNode;
}

/**
 * "New channel" (flow 07): the kind as a radio group (text, voice or announcement, selection following the arrows) and the name, in one
 * form submitted by Enter or the footer's accent button. Focus starts in the name field; the kind group is one Shift+Tab
 * away. A refusal is the field's error.
 */
export function CreateChannel({ open, kind, onKind, name, onName, hint, error, busy, attempt = 0, labels, onSubmit, onClose, children }: CreateChannelProps) {
  const base = useId();
  const fieldId = `${base}-name`;
  const formId = `${base}-form`;
  // After Dialog's own open effect (a child's effects run first): the field, not the dialog, holds focus.
  useEffect(() => {
    if (open) document.getElementById(fieldId)?.focus();
  }, [open, fieldId]);
  // A refusal (before or after sending) puts focus back in the field that holds it, also when the submit button was pressed.
  useEffect(() => {
    if (open && error !== null) document.getElementById(fieldId)?.focus();
  }, [open, error, attempt, fieldId]);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!busy) onSubmit();
  };
  return (
    <Dialog open={open} title={labels.title} closeLabel={labels.close} onClose={onClose}
      footer={<Button variant="accent" type="submit" form={formId} aria-disabled={busy || undefined}>{busy ? labels.busy : labels.submit}</Button>}>
      <form id={formId} className="d-create-channel" noValidate onSubmit={submit}>
        <div className="d-create-channel__kind">
          {/* The group carries the same text as its own (visually hidden) label. */}
          <span className="d-create-channel__label" aria-hidden="true">{labels.kind}</span>
          <Segmented id={`${base}-kind`} label={labels.kind} value={kind} onChange={v => onKind(v === 'voice' || v === 'announcement' ? v : 'text')}
            options={[{ value: 'text', label: labels.text }, { value: 'voice', label: labels.voice },
              ...(labels.announcement === undefined ? [] : [{ value: 'announcement', label: labels.announcement }])]} />
        </div>
        <TextField key={attempt} id={fieldId} label={labels.name} value={name} onChange={onName} hint={hint} error={error ?? undefined}
          required autoComplete="off" spellCheck={false} />
        {children}
        {/* Focus stays in the field on Enter, so the busy submit's new name alone is not heard (review M1). */}
        <p className="d-sr-only" role="status">{busy ? labels.busy : ''}</p>
      </form>
    </Dialog>
  );
}

import { useEffect, useId, type FormEvent } from 'react';
import { Button } from '../Button/Button.tsx';
import { Dialog } from '../Dialog/Dialog.tsx';
import { Segmented } from '../Segmented/Segmented.tsx';
import { TextField } from '../TextField/TextField.tsx';
import './CreateChannel.css';

export type NewChannelKind = 'text' | 'voice';

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
  labels: { title: string; kind: string; text: string; voice: string; name: string; submit: string; busy: string; close: string };
  onSubmit(): void;
  onClose(): void;
}

/**
 * "New channel" (flow 07): the kind as a radio group (text or voice, selection following the arrows) and the name, in one
 * form submitted by Enter or the footer's accent button. Focus starts in the name field; the kind group is one Shift+Tab
 * away. A refusal is the field's error.
 */
export function CreateChannel({ open, kind, onKind, name, onName, hint, error, busy, labels, onSubmit, onClose }: CreateChannelProps) {
  const base = useId();
  const fieldId = `${base}-name`;
  const formId = `${base}-form`;
  // After Dialog's own open effect (a child's effects run first): the field, not the dialog, holds focus.
  useEffect(() => {
    if (open) document.getElementById(fieldId)?.focus();
  }, [open, fieldId]);
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
          <Segmented id={`${base}-kind`} label={labels.kind} value={kind} onChange={v => onKind(v === 'voice' ? 'voice' : 'text')}
            options={[{ value: 'text', label: labels.text }, { value: 'voice', label: labels.voice }]} />
        </div>
        <TextField id={fieldId} label={labels.name} value={name} onChange={onName} hint={hint} error={error ?? undefined}
          required autoComplete="off" spellCheck={false} />
      </form>
    </Dialog>
  );
}

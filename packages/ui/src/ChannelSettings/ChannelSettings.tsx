import { useEffect, useId, type FormEvent } from 'react';
import { Button } from '../Button/Button.tsx';
import { Dialog } from '../Dialog/Dialog.tsx';
import { Select } from '../Select/Select.tsx';
import { TextField } from '../TextField/TextField.tsx';
import './ChannelSettings.css';

export interface ChannelSettingsProps {
  open: boolean;
  kind: 'text' | 'voice' | 'category';
  name: string;
  onName(v: string): void;
  topic: string;
  onTopic(v: string): void;
  parent: string;
  parents: readonly { value: string; label: string }[];
  onParent(v: string): void;
  error: string | null;
  busy: boolean;
  /** Counts the refusals and failures the caller has shown; a new count with the same text is announced again. */
  attempt?: number;
  labels: { title: string; name: string; nameHint: string; topic: string; topicHint: string; category: string; submit: string; busy: string; close: string };
  onSubmit(): void;
  onClose(): void;
}

/**
 * Edit a channel or a category: the name, for a text channel the topic, and for a channel (not a category) the category
 * it sits in. One form, submitted by Enter or the footer's accent button. Focus starts in the name field, and a refusal
 * is the name field's error and puts focus back there.
 */
export function ChannelSettings({
  open, kind, name, onName, topic, onTopic, parent, parents, onParent, error, busy, attempt = 0, labels, onSubmit, onClose,
}: ChannelSettingsProps) {
  const base = useId();
  const fieldId = `${base}-name`;
  const formId = `${base}-form`;
  // After Dialog's own open effect (a child's effects run first): the field, not the dialog, holds focus.
  useEffect(() => {
    if (open) document.getElementById(fieldId)?.focus();
  }, [open, fieldId]);
  // A refusal puts focus back in the field that holds it, also when the submit button was pressed.
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
      <form id={formId} className="d-channel-settings" noValidate onSubmit={submit}>
        <TextField key={attempt} id={fieldId} label={labels.name} value={name} onChange={onName} hint={labels.nameHint}
          error={error ?? undefined} required autoComplete="off" spellCheck={false} />
        {kind === 'text' ? (
          <TextField id={`${base}-topic`} label={labels.topic} value={topic} onChange={onTopic} hint={labels.topicHint} autoComplete="off" />
        ) : null}
        {kind !== 'category' ? <Select label={labels.category} value={parent} options={parents} onChange={onParent} /> : null}
        {/* The form has several fields, so Enter submits through a default submit button inside it. The footer's button
            is the visible one (outside the form, tied by `form`). */}
        <button type="submit" hidden tabIndex={-1} aria-hidden="true" />
        <p className="d-sr-only" role="status">{busy ? labels.busy : ''}</p>
      </form>
    </Dialog>
  );
}

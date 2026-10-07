import { useId, useLayoutEffect, useRef, type ChangeEvent, type KeyboardEvent } from 'react';
import { Button } from '../Button/Button.tsx';
import './MessageEditor.css';

export interface MessageEditorProps {
  label: string;
  value: string;
  onChange(v: string): void;
  onSave(v: string): void;
  onCancel(): void;
  hint: string;
  saveLabel: string;
  cancelLabel: string;
  maxLength: number;
  measure?(v: string): number;
  counterLabel(remaining: number): string;
}

const ENCODER = new TextEncoder();

/**
 * The inline editor that replaces a row's body: a named textarea described by its hint, focused on mount with the
 * caret at the end. Enter saves, Shift+Enter breaks the line, and neither acts while an IME composes or on a held
 * key's repeats; Escape cancels and bubbles, so the row takes focus. A blank text or one over the budget (`measure`,
 * UTF-8 bytes by default) is not saved, and save stays focusable with `aria-disabled`. The counter appears near the
 * budget as the composer's does.
 */
export function MessageEditor({
  label, value, onChange, onSave, onCancel, hint, saveLabel, cancelLabel, maxLength, measure, counterLabel,
}: MessageEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();
  const counterId = useId();
  const used = measure ? measure(value) : ENCODER.encode(value).length;
  const remaining = maxLength - used;
  const overBudget = remaining < 0;
  const showCounter = remaining <= Math.floor(maxLength / 10);
  const refused = value.trim() === '' || overBudget;

  // On mount only: focus with the caret at the end of the text being edited.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.selectionStart = el.value.length;
    el.selectionEnd = el.value.length;
  }, []);

  const save = () => {
    if (refused) return;
    onSave(value);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key !== 'Enter' || e.shiftKey) return;
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    if (e.repeat) return;
    save();
  };

  return (
    <div className="d-message-editor">
      <textarea ref={ref} className="d-message-editor__input" rows={1} value={value} aria-label={label}
        aria-describedby={showCounter ? `${hintId} ${counterId}` : hintId}
        onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.currentTarget.value)} onKeyDown={onKeyDown} />
      <div className="d-message-editor__foot">
        <p id={hintId} className="d-message-editor__hint">{hint}</p>
        {showCounter ? (
          <p id={counterId} className="d-message-editor__counter" data-over={overBudget ? 'true' : undefined}>{counterLabel(remaining)}</p>
        ) : null}
        <div className="d-message-editor__buttons">
          <Button variant="ghost" onClick={onCancel}>{cancelLabel}</Button>
          <Button variant="accent" aria-disabled={refused ? true : undefined} onClick={save}>{saveLabel}</Button>
        </div>
      </div>
    </div>
  );
}

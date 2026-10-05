import { useId, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react';
import { Button } from '../Button/Button.tsx';
import './Composer.css';

export interface ComposerProps {
  label: string;
  placeholder: string;
  /** The budget in UTF-8 bytes, the unit of the core's body limit (L-CORE-09). */
  maxLength: number;
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
  disabledReason?: string;
  onSend(text: string): void;
  sendLabel: string;
  counterLabel(remaining: number): string;
}

const ENCODER = new TextEncoder();

/**
 * The message composer, controlled (pre-flight ruling (a), L-UI-13): the owner
 * holds the text and the component never clears it on send, so a refused
 * message is not lost. Enter sends, Shift+Enter breaks the line, and neither
 * fires while an IME is composing. The budget is counted in UTF-8 bytes; the
 * textarea carries no native maxLength (that counts UTF-16 units and would cut
 * a paste silently). Blocked, the textarea stays focusable (readOnly with
 * aria-disabled) so its reason is heard; only the send button is disabled.
 */
export function Composer({
  label, placeholder, maxLength, value, onChange, disabled, disabledReason, onSend, sendLabel, counterLabel,
}: ComposerProps) {
  const inputId = useId();
  const reasonId = useId();
  const counterId = useId();
  const used = ENCODER.encode(value).length;
  const remaining = maxLength - used;
  const overBudget = remaining < 0;
  const showCounter = remaining <= Math.floor(maxLength / 10);
  const showReason = disabled === true && !!disabledReason;
  const described = [showReason ? reasonId : null, showCounter ? counterId : null].filter((x): x is string => x !== null);
  const describedBy = described.length > 0 ? described.join(' ') : undefined;

  const submit = () => {
    if (disabled) return;
    if (value.trim() === '') return;
    // Over the budget the text stays in the field; the counter already says by how much.
    if (overBudget) return;
    onSend(value);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter') return;
    if (e.shiftKey) return; // the browser inserts the line break
    if (e.nativeEvent.isComposing || e.keyCode === 229) return; // the IME owns this Enter
    e.preventDefault();
    submit();
  };

  const onInput = (e: ChangeEvent<HTMLTextAreaElement>) => {
    if (!disabled) onChange(e.currentTarget.value);
  };

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    submit();
  };

  return (
    <form className="d-composer" data-disabled={disabled ? 'true' : undefined} noValidate onSubmit={onSubmit}>
      <label className="d-composer__label d-label" htmlFor={inputId}>{label}</label>
      <div className="d-composer__box">
        <textarea id={inputId} className="d-composer__input" rows={1} value={value} placeholder={placeholder}
          readOnly={disabled} aria-disabled={disabled ? true : undefined} aria-describedby={describedBy}
          onChange={onInput} onKeyDown={onKeyDown} />
        <Button type="submit" variant="accent" disabled={disabled === true || overBudget}>{sendLabel}</Button>
      </div>
      {showReason ? <p id={reasonId} className="d-composer__reason">{disabledReason}</p> : null}
      {showCounter ? <p id={counterId} className="d-composer__counter">{counterLabel(remaining)}</p> : null}
    </form>
  );
}

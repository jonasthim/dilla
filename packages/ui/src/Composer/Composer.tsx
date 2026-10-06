import { useId, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react';
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
 * The label split into its label part and its target, the `#channel` (or `@person`) that follows the
 * first space: the target is a value and keeps its case, so the label treatment never reaches it.
 */
function labelParts(label: string): { lead: string; target: string | null } {
  const m = /^(.*?\s)([#@].*)$/s.exec(label);
  return m === null ? { lead: label, target: null } : { lead: m[1], target: m[2] };
}

/**
 * The message composer, controlled (pre-flight ruling (a), L-UI-13): the owner
 * holds the text and the component never clears it on send, so a refused
 * message is not lost. Enter sends, Shift+Enter breaks the line, and neither
 * fires while an IME is composing. The budget is counted in UTF-8 bytes; the
 * textarea carries no native maxLength (that counts UTF-16 units and would cut
 * a paste silently). Blocked, the textarea stays focusable (readOnly with
 * aria-disabled) so its reason is heard; only the send button is disabled.
 * Over the budget the counter takes the danger tone, a polite status says so,
 * and send stays focusable (aria-disabled) with the counter as its reason.
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
  const { lead, target } = labelParts(label);
  // Over the budget (and not blocked) send stays focusable, so the counter is heard as its reason.
  const sendRefused = disabled !== true && overBudget;

  // The counter is a status message: the polite status speaks it when it appears and when the text crosses the
  // budget, never on every keystroke (WCAG 4.1.3). State adjusted during render, React's pattern for derived state.
  const phase = !showCounter ? 'none' : overBudget ? 'over' : 'near';
  const [status, setStatus] = useState<{ phase: typeof phase; text: string }>({ phase: 'none', text: '' });
  if (status.phase !== phase) setStatus({ phase, text: phase === 'none' ? '' : counterLabel(remaining) });

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
    // A held Enter auto-repeats: its repeats neither send again nor break the line.
    if (e.repeat) return;
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
      <label className="d-composer__label d-label" htmlFor={inputId}>
        {lead}{target === null ? null : <span className="d-composer__target">{target}</span>}
      </label>
      <div className="d-composer__box">
        <textarea id={inputId} className="d-composer__input" rows={1} value={value} placeholder={placeholder}
          readOnly={disabled} aria-disabled={disabled ? true : undefined} aria-describedby={describedBy}
          onChange={onInput} onKeyDown={onKeyDown} />
        <Button type="submit" variant="accent" disabled={disabled === true}
          aria-disabled={sendRefused ? true : undefined} aria-describedby={sendRefused ? counterId : undefined}>{sendLabel}</Button>
      </div>
      {showReason ? <p id={reasonId} className="d-composer__reason">{disabledReason}</p> : null}
      {showCounter ? (
        <p id={counterId} className="d-composer__counter" data-over={overBudget ? 'true' : undefined}>{counterLabel(remaining)}</p>
      ) : null}
      {/* The counter's polite status: heard, never seen (the visible counter says the same). */}
      <p className="d-composer__status d-sr-only" role="status">{status.text}</p>
    </form>
  );
}

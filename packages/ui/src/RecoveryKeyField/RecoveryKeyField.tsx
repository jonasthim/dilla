import './RecoveryKeyField.css';

export interface RecoveryKeyFieldProps {
  id: string;
  label: string;
  value: string;
  onChange(value: string): void;
  hint?: string;
  error?: string;
  disabled?: boolean;
}

/**
 * Where a person types or pastes the recovery key. Paste is allowed and nothing is cut off (F2,
 * WCAG 3.3.8): no length limit, no name, nothing offers to remember it. The value is shown and
 * reported exactly as typed; the core normalises it. The hint and the error describe the field in
 * that order and the error is announced. `disabled` is the native attribute, on the field only,
 * while a submit runs: the pressed button keeps focus and stays `aria-disabled` (pre-flight 2.16).
 */
export function RecoveryKeyField({ id, label, value, onChange, hint, error, disabled }: RecoveryKeyFieldProps) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="d-recovery-key-field" data-invalid={error ? 'true' : undefined}>
      <label className="d-recovery-key-field__label" htmlFor={id}>{label}</label>
      <input id={id} className="d-recovery-key-field__input" type="text" value={value} onChange={e => onChange(e.currentTarget.value)}
        autoComplete="off" autoCapitalize="characters" spellCheck={false} inputMode="text"
        aria-describedby={describedBy} aria-invalid={error ? true : undefined} disabled={disabled} />
      {hint ? <p id={hintId} className="d-recovery-key-field__hint">{hint}</p> : null}
      {error ? <p id={errorId} className="d-recovery-key-field__error" role="alert">{error}</p> : null}
    </div>
  );
}

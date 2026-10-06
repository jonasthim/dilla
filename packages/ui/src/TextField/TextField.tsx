import './TextField.css';

export interface TextFieldProps {
  id: string;
  label: string;
  value: string;
  onChange(value: string): void;
  type?: 'text' | 'password';
  hint?: string;
  error?: string;
  required?: boolean;
  disabled?: boolean;
  autoComplete?: string;
  inputMode?: 'text' | 'numeric';
  maxLength?: number;
  spellCheck?: boolean;
}

/**
 * A labelled single-line field. The hint and the error are the input's
 * description, in that order; an error marks the field invalid and is
 * announced as an alert. Paste, copy and cut are never intercepted (WCAG 3.3.8).
 */
export function TextField({
  id, label, value, onChange, type, hint, error, required, disabled, autoComplete, inputMode, maxLength, spellCheck,
}: TextFieldProps) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const described = [hint ? hintId : null, error ? errorId : null].filter((x): x is string => x !== null);
  const describedBy = described.length > 0 ? described.join(' ') : undefined;
  return (
    <div className="d-text-field" data-invalid={error ? 'true' : undefined}>
      <label className="d-text-field__label" htmlFor={id}>{label}</label>
      <input id={id} className="d-text-field__input" type={type ?? 'text'} value={value}
        onChange={e => onChange(e.currentTarget.value)} aria-describedby={describedBy}
        aria-invalid={error ? true : undefined} required={required} disabled={disabled}
        autoComplete={autoComplete} inputMode={inputMode} maxLength={maxLength} spellCheck={spellCheck} />
      {hint ? <p id={hintId} className="d-text-field__hint">{hint}</p> : null}
      {error ? <p id={errorId} className="d-text-field__error" role="alert">{error}</p> : null}
    </div>
  );
}

import { useId } from 'react';
import './Select.css';

export interface SelectProps {
  label: string;
  hint?: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange(v: string): void;
  disabled?: boolean;
}

/** A native `<select>` styled like TextField: the label above, the hint as its description. */
export function Select({ label, hint, value, options, onChange, disabled }: SelectProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="d-select">
      <label className="d-select__label" htmlFor={id}>{label}</label>
      <select id={id} className="d-select__input" value={value} disabled={disabled} aria-describedby={hint ? hintId : undefined}
        onChange={e => onChange(e.currentTarget.value)}>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {hint ? <p id={hintId} className="d-select__hint">{hint}</p> : null}
    </div>
  );
}

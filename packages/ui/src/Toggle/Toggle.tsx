import './Toggle.css';

export interface ToggleProps {
  id: string;
  label: string;
  checked: boolean;
  onChange(checked: boolean): void;
  hint?: string;
  disabled?: boolean;
  showLabel?: boolean;
}

/**
 * A switch for one setting. The row around it shows the visible label and the switch is named by
 * the same text through `aria-label`; with `showLabel` the switch shows its own label before the
 * knob and is named by that visible text. A disabled switch stays focusable (`aria-disabled`) and
 * ignores activation. Space and Enter reach the click handler through the native button.
 */
export function Toggle({ id, label, checked, onChange, hint, disabled, showLabel = false }: ToggleProps) {
  return (
    <span className="d-toggle">
      {showLabel ? <span id={`${id}-label`} className="d-toggle__label">{label}</span> : null}
      <button id={id} type="button" role="switch" className="d-toggle__switch" aria-checked={checked}
        aria-label={showLabel ? undefined : label} aria-labelledby={showLabel ? `${id}-label` : undefined}
        aria-describedby={hint ? `${id}-hint` : undefined} aria-disabled={disabled ? true : undefined}
        onClick={() => { if (!disabled) onChange(!checked); }}>
        <span className="d-toggle__track" aria-hidden="true"><span className="d-toggle__knob" /></span>
      </button>
      {hint ? <span id={`${id}-hint`} className="d-toggle__hint">{hint}</span> : null}
    </span>
  );
}

import type { ReactNode } from 'react';
import './SettingsRow.css';

export interface SettingsRowProps {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}

/**
 * One labelled row of Settings: the label and hint on the left, the control on the right. The row
 * is a group named by its visible label and described by its hint; the control wraps under the
 * label when the row is narrower than both.
 */
export function SettingsRow({ id, label, hint, children }: SettingsRowProps) {
  return (
    <div className="d-settings-row" role="group" aria-labelledby={`${id}-label`} aria-describedby={hint ? `${id}-hint` : undefined}>
      <div className="d-settings-row__text">
        <span id={`${id}-label`} className="d-settings-row__label">{label}</span>
        {hint ? <p id={`${id}-hint`} className="d-settings-row__hint">{hint}</p> : null}
      </div>
      <div className="d-settings-row__control">{children}</div>
    </div>
  );
}

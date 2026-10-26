import type { ReactNode } from 'react';
import './SettingsRow.css';

export interface SettingsRowProps {
  id: string;
  label: string;
  hint?: string;
  /** Renders the label as a heading of this level, so assistive technology can navigate a section by its rows. */
  headingLevel?: 3 | 4;
  /** Complex forms sit below their introduction instead of inside the compact control column. */
  layout?: 'inline' | 'stacked';
  children: ReactNode;
}

/**
 * One labelled row of Settings: the label and hint on the left, the control on the right. The row
 * is a group named by its visible label and described by its hint. Fullscreen rows use balanced columns
 * that stack when space is constrained. Complex forms can always stack below their introduction.
 */
export function SettingsRow({ id, label, hint, headingLevel, layout = 'inline', children }: SettingsRowProps) {
  const Label = headingLevel === undefined ? 'span' : (`h${headingLevel}` as const);
  return (
    <div className={`d-settings-row${layout === 'stacked' ? ' d-settings-row--stacked' : ''}`} data-row role="group" aria-labelledby={`${id}-label`} aria-describedby={hint ? `${id}-hint` : undefined}>
      <div className="d-settings-row__text">
        <Label id={`${id}-label`} className="d-settings-row__label">{label}</Label>
        {hint ? <p id={`${id}-hint`} className="d-settings-row__hint">{hint}</p> : null}
      </div>
      <div className="d-settings-row__control">{children}</div>
    </div>
  );
}

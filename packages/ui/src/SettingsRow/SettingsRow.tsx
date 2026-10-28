import type { ReactNode } from 'react';
import { Icon, type IconName } from '../Icon/Icon.tsx';
import './SettingsRow.css';

export interface SettingsRowProps {
  id: string;
  label: string;
  hint?: string;
  /** The row's 32px icon tile (README §5.9): an accent glyph on --surface-tile. */
  icon?: IconName;
  /** A small uppercase tag after the label (the prototype's BETA, THIS BROWSER). */
  tag?: string;
  /** Renders the label as a heading of this level, so assistive technology can navigate a section by its rows. */
  headingLevel?: 3 | 4;
  /** Complex forms sit below their introduction instead of inside the compact control column. */
  layout?: 'inline' | 'stacked';
  children: ReactNode;
}

/**
 * One labelled row of Settings (README §5.9): an optional icon tile, the label and hint, and the control on the right.
 * The row is a group named by its visible label and described by its hint. Consecutive rows draw one 10px-radius group
 * with hairlines between them; the row wraps on narrow widths. Complex forms can always stack below their introduction.
 */
export function SettingsRow({ id, label, hint, icon, tag, headingLevel, layout = 'inline', children }: SettingsRowProps) {
  const Label = headingLevel === undefined ? 'span' : (`h${headingLevel}` as const);
  return (
    <div className={`d-settings-row${layout === 'stacked' ? ' d-settings-row--stacked' : ''}`} data-row role="group" aria-labelledby={`${id}-label`} aria-describedby={hint ? `${id}-hint` : undefined}>
      {icon ? <span className="d-settings-row__icon" aria-hidden="true"><Icon name={icon} size={15} /></span> : null}
      <div className="d-settings-row__text">
        <Label id={`${id}-label`} className="d-settings-row__label">{label}{tag ? <span className="d-settings-row__tag">{tag}</span> : null}</Label>
        {hint ? <p id={`${id}-hint`} className="d-settings-row__hint">{hint}</p> : null}
      </div>
      <div className="d-settings-row__control">{children}</div>
    </div>
  );
}

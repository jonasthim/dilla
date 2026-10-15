import { useId } from 'react';
import { Button } from '../Button/Button.tsx';
import './FactorRow.css';

export interface FactorRowProps {
  title: string;
  detail: string;
  action?(): void;
  actionLabel?: string;
  actionAriaLabel?: string;
  /** When set, the action is unavailable: it stays focusable, is announced as disabled, and does nothing. */
  disabledReason?: string;
}

/**
 * One sign-in factor in Settings → Sign-in, after DeviceRow. An unavailable action is aria-disabled rather
 * than disabled, so keyboard and screen-reader users can reach it and hear the visible reason.
 */
export function FactorRow({ title, detail, action, actionLabel, actionAriaLabel, disabledReason }: FactorRowProps) {
  const reasonId = useId();
  const blocked = Boolean(action && disabledReason);
  return (
    <li className="d-factor-row">
      <div className="d-factor-row__main">
        <span className="d-factor-row__title">{title}</span>
        <span className="d-factor-row__detail">{detail}</span>
        {blocked ? <span id={reasonId} className="d-factor-row__reason">{disabledReason}</span> : null}
      </div>
      {action && actionLabel ? (
        <Button aria-label={actionAriaLabel} aria-disabled={blocked ? 'true' : undefined}
          aria-describedby={blocked ? reasonId : undefined} onClick={blocked ? undefined : action}>{actionLabel}</Button>
      ) : null}
    </li>
  );
}

import type { ReactNode } from 'react';
import { Button } from '../Button/Button.tsx';
import { Icon } from '../Icon/Icon.tsx';
import './PhoneHeader.css';

export interface PhoneHeaderProps {
  title: ReactNode;
  backLabel?: string;
  onBack?(): void;
  actions?: ReactNode;
}

/**
 * The phone's top bar over a pane: a back control (when `onBack` is given), the title in a level-two heading cut to one
 * line, and the caller's actions at the end. Every control is at least 44 × 44 CSS px. It pads its top by the device's
 * safe area, so it clears a notch.
 */
export function PhoneHeader({ title, backLabel, onBack, actions }: PhoneHeaderProps) {
  return (
    <header className="d-phone-header">
      {onBack !== undefined ? (
        <Button variant="ghost" className="d-phone-header__back" aria-label={backLabel} onClick={onBack}><Icon name="chevron-left" size={22} /></Button>
      ) : null}
      <h2 className="d-phone-header__title">{title}</h2>
      {actions !== undefined ? <div className="d-phone-header__actions">{actions}</div> : null}
    </header>
  );
}

import { useId } from 'react';
import { Button } from '../Button/Button.tsx';
import './DeviceRow.css';

export interface DeviceRowProps {
  name: string;
  tier: 'web' | 'native';
  tierLabel: string;
  own?: boolean;
  ownLabel?: string;
  state?: string;
  lastSeen?: string;
  action?: { label: string; onAction(): void; danger?: boolean };
}

/**
 * One device of the account in Settings → Devices. The tier tag is where the browser's lower-trust
 * fact is shown, and nowhere in the chrome (F9). The action, when given, is described by the
 * device's name, so "remove" is heard with the device it removes. Every text arrives as a prop.
 */
export function DeviceRow({ name, tier, tierLabel, own, ownLabel, state, lastSeen, action }: DeviceRowProps) {
  const nameId = useId();
  return (
    <li className="d-device-row" data-tier={tier} data-own={own ? 'true' : undefined}>
      <div className="d-device-row__main">
        <div className="d-device-row__head">
          <span id={nameId} className="d-device-row__name">{name}</span>
          <span className="d-device-row__tag" data-kind="tier">{tierLabel}</span>
          {own && ownLabel ? <span className="d-device-row__tag" data-kind="own">{ownLabel}</span> : null}
        </div>
        {state || lastSeen ? (
          <div className="d-device-row__meta">
            {state ? <span className="d-device-row__state">{state}</span> : null}
            {state && lastSeen ? <span aria-hidden="true"> · </span> : null}
            {lastSeen ? <span className="d-device-row__seen">{lastSeen}</span> : null}
          </div>
        ) : null}
      </div>
      {action ? <Button variant={action.danger ? 'danger' : 'default'} aria-describedby={nameId} onClick={action.onAction}>{action.label}</Button> : null}
    </li>
  );
}

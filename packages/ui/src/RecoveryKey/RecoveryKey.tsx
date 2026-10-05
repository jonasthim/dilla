import { useId } from 'react';
import { Button } from '../Button/Button.tsx';
import './RecoveryKey.css';

export interface RecoveryKeyProps {
  groups: readonly string[];
  label: string;
  acknowledgeLabel: string;
  acknowledged: boolean;
  onAcknowledge(value: boolean): void;
  printLabel: string;
  onPrint(): void;
}

/**
 * The recovery key as selectable text: one list item per group, numbered by a
 * CSS counter that is neither copied nor read. There is no copy control of any
 * kind (protocol/03 "Recovery"), and no handler interferes with selecting or
 * copying the text; the person may print it or write it down.
 */
export function RecoveryKey({ groups, label, acknowledgeLabel, acknowledged, onAcknowledge, printLabel, onPrint }: RecoveryKeyProps) {
  const labelId = useId();
  const ackId = useId();
  return (
    <div className="d-recovery-key">
      <p id={labelId} className="d-recovery-key__label d-label">{label}</p>
      <ol role="list" className="d-recovery-key__grid" aria-labelledby={labelId}>
        {groups.map((g, i) => <li key={i} className="d-recovery-key__group">{g}</li>)}
      </ol>
      <div className="d-recovery-key__actions">
        <div className="d-recovery-key__ack">
          <input id={ackId} type="checkbox" className="d-recovery-key__box" checked={acknowledged}
            onChange={e => onAcknowledge(e.currentTarget.checked)} />
          <label htmlFor={ackId}>{acknowledgeLabel}</label>
        </div>
        <Button className="d-recovery-key__print" onClick={onPrint}>{printLabel}</Button>
      </div>
    </div>
  );
}

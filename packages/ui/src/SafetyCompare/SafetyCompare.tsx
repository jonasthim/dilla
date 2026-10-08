import { useEffect, useId, useRef, useState } from 'react';
import { Dialog } from '../Dialog/Dialog.tsx';
import './SafetyCompare.css';

export type SafetyCompareProps = {
  open: boolean;
  contactName: string;
  state: 'first-seen' | 'changed' | 'verified' | 'unlisted';
  approvedUmk: string | null;
  groups: readonly string[];
  canVerify: boolean;
  labels: { title: string; copy: string; verify: string; close: string; instructions: string; confirm: string; firstSeen: string; states?: Record<SafetyCompareProps['state'], string> };
  onCopy(): void;
  onVerify(expectedUmk: string): void;
  onClose(): void;
};

export function SafetyCompare({ open, contactName, state, approvedUmk, groups, canVerify, labels, onCopy, onVerify, onClose }: SafetyCompareProps) {
  const [confirmedFor, setConfirmedFor] = useState<string | null>(null);
  const instructionsId = useId();
  const instructionsRef = useRef<HTMLParagraphElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) {
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement && active.isConnected && active !== document.body && active !== document.documentElement ? active : null;
  }
  wasOpen.current = open;
  useEffect(() => {
    const dialog = instructionsRef.current?.closest('dialog');
    dialog?.setAttribute('aria-describedby', instructionsId);
    return () => { dialog?.removeAttribute('aria-describedby'); };
  }, [instructionsId, open]);
  useEffect(() => { if (!open) setConfirmedFor(null); }, [open]);
  const comparison = `${approvedUmk ?? ''}|${groups.join('|')}`;
  useEffect(() => { setConfirmedFor(null); }, [comparison]);
  const confirmed = confirmedFor === comparison;
  const validGroups = groups.length === 12 && groups.every(group => /^\d{5}$/.test(group));
  const permitted = canVerify && /^[0-9a-f]{64}$/.test(approvedUmk ?? '') && validGroups && confirmed;
  const close = () => {
    onClose();
    queueMicrotask(() => {
      const opener = openerRef.current;
      if (opener?.isConnected) opener.focus();
      else document.querySelector<HTMLElement>('[data-privacy-heading]')?.focus();
    });
  };
  return <Dialog open={open} title={labels.title} closeLabel={labels.close} onClose={close} footer={<button type="button" className="d-safety-compare__button" aria-disabled={!permitted} onClick={() => { if (permitted && approvedUmk) onVerify(approvedUmk); }}>{labels.verify}</button>}>
    <div className="d-safety-compare">
      <p className="d-safety-compare__identity">{contactName} · {labels.states?.[state] ?? state}</p>
      {state === 'first-seen' && <p>{labels.firstSeen.replace('{name}', contactName)}</p>}
      <p id={instructionsId} ref={instructionsRef}>{labels.instructions}</p>
      {approvedUmk && <code className="d-safety-compare__key">{approvedUmk}</code>}
      <div className="d-safety-compare__groups">{groups.map((group, index) => <code key={index}>{group}</code>)}</div>
      <button type="button" className="d-safety-compare__button" onClick={onCopy}>{labels.copy}</button>
      <label className="d-safety-compare__confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmedFor(event.target.checked ? comparison : null)} />{labels.confirm}</label>
    </div>
  </Dialog>;
}

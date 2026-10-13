import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../Button/Button.tsx';
import { Dialog } from '../Dialog/Dialog.tsx';
import './SafetyCompare.css';

export type SafetyCompareProps = {
  open: boolean;
  contactName: string;
  state: 'first-seen' | 'changed' | 'verified' | 'unlisted';
  approvedUmk: string | null;
  groups: readonly string[];
  canVerify: boolean;
  labels: {
    title: string; copy: string; verify: string; close: string; instructions: string; confirm: string; firstSeen: string;
    states?: Record<SafetyCompareProps['state'], string>;
    /** Shown in the blocks' place while the number is worked out. */
    loading?: string;
  };
  /** Why the number cannot be shown or the comparison could not be approved; Copy-table text, never a code. */
  error?: string | null;
  /** A `data-doc-state` for the guide's screenshot shooter, on the dialog's content. */
  docState?: string;
  onCopy(): void;
  onVerify(expectedUmk: string): void;
  onClose(): void;
};

export function SafetyCompare({ open, contactName, state, approvedUmk, groups, canVerify, labels, error = null, docState, onCopy, onVerify, onClose }: SafetyCompareProps) {
  const [confirmedFor, setConfirmedFor] = useState<string | null>(null);
  const instructionsId = useId();
  const instructionsRef = useRef<HTMLParagraphElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) {
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement && active.isConnected && active !== document.body && active !== document.documentElement ? active : null;
  }
  // W-11: every way the dialog closes (its Close, Escape, or the owner after an approval) returns focus here, after the
  // commit that closed it: the opener if it survived, else the Privacy heading (Flow 05 focus rules). A passive effect, so
  // it runs after the Dialog's own effect has closed the modal (nothing outside an open modal can take focus).
  const shown = useRef(false);
  useEffect(() => {
    if (open) { shown.current = true; return; }
    if (!shown.current) return;
    shown.current = false;
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener?.isConnected) opener.focus();
    else document.querySelector<HTMLElement>('[data-privacy-heading]')?.focus();
  }, [open]);
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
  return <Dialog open={open} title={labels.title} closeLabel={labels.close} onClose={onClose}
    footer={<Button variant="accent" aria-disabled={!permitted} onClick={() => { if (permitted && approvedUmk) onVerify(approvedUmk); }}>{labels.verify}</Button>}>
    <div className="d-safety-compare" data-doc-state={docState}>
      <p className="d-safety-compare__identity">{contactName} · {labels.states?.[state] ?? state}</p>
      {state === 'first-seen' && <p>{labels.firstSeen.replace('{name}', contactName)}</p>}
      <p id={instructionsId} ref={instructionsRef}>{labels.instructions}</p>
      {approvedUmk && <code className="d-safety-compare__key" data-public-umk>{approvedUmk}</code>}
      {groups.length > 0
        ? <div className="d-safety-compare__groups" role="group" aria-label={labels.title}>{groups.map((group, index) => <code key={index} data-safety-group>{group}</code>)}</div>
        : error === null && labels.loading ? <p className="d-safety-compare__loading" role="status">{labels.loading}</p> : null}
      {error !== null ? <p className="d-safety-compare__error" role="alert">{error}</p> : null}
      <div className="d-safety-compare__actions">
        <Button onClick={onCopy}>{labels.copy}</Button>
        <label className="d-safety-compare__confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmedFor(event.target.checked ? comparison : null)} />{labels.confirm}</label>
      </div>
    </div>
  </Dialog>;
}

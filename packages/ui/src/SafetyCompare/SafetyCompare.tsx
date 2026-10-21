import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../Button/Button.tsx';
import { Dialog } from '../Dialog/Dialog.tsx';
import { QrCode } from '../QrCode/QrCode.tsx';
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
    /** The disclosure the exact public key waits behind (product walk M11); the 12 blocks are the comparison. */
    details?: string;
    /** The toggle that shows or hides the QR code, and the QR's text alternative. The blocks stay the screen-reader path. */
    showQr?: string; hideQr?: string; qrLabel?: string;
  };
  /** The contact's user id; with it (and 12 valid blocks) the dialog can show the number as `dilla-sn:1:<id>:<blocks joined by "-">`. Public key material only. */
  qrUserId?: string;
  /** Why the number cannot be shown or the comparison could not be approved; Copy-table text, never a code. */
  error?: string | null;
  /** A `data-doc-state` for the guide's screenshot shooter, on the dialog's content. */
  docState?: string;
  onCopy(): void;
  onVerify(expectedUmk: string): void;
  onClose(): void;
};

export function SafetyCompare({ open, contactName, state, approvedUmk, groups, canVerify, labels, qrUserId, error = null, docState, onCopy, onVerify, onClose }: SafetyCompareProps) {
  const [confirmedFor, setConfirmedFor] = useState<string | null>(null);
  const [qrShown, setQrShown] = useState(false);
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
  useEffect(() => { if (!open) { setConfirmedFor(null); setQrShown(false); } }, [open]);
  const comparison = `${approvedUmk ?? ''}|${groups.join('|')}`;
  useEffect(() => { setConfirmedFor(null); }, [comparison]);
  const confirmed = confirmedFor === comparison;
  const validGroups = groups.length === 12 && groups.every(group => /^\d{5}$/.test(group));
  const qrValue = qrUserId && validGroups && labels.showQr && labels.hideQr && labels.qrLabel ? `dilla-sn:1:${qrUserId}:${groups.join('-')}` : null;
  const permitted = canVerify && /^[0-9a-f]{64}$/.test(approvedUmk ?? '') && validGroups && confirmed;
  return <Dialog open={open} title={labels.title} closeLabel={labels.close} onClose={onClose}
    footer={<Button variant="accent" aria-disabled={!permitted} onClick={() => { if (permitted && approvedUmk) onVerify(approvedUmk); }}>{labels.verify}</Button>}>
    <div className="d-safety-compare" data-doc-state={docState}>
      <p className="d-safety-compare__identity">{contactName} · {labels.states?.[state] ?? state}</p>
      {state === 'first-seen' && <p>{labels.firstSeen.replace('{name}', contactName)}</p>}
      <p id={instructionsId} ref={instructionsRef}>{labels.instructions}</p>
      {approvedUmk && (
        <details className="d-safety-compare__details">
          <summary className="d-safety-compare__summary">{labels.details ?? labels.title}</summary>
          <code className="d-safety-compare__key" data-public-umk>{approvedUmk}</code>
        </details>
      )}
      {groups.length > 0
        ? <div className="d-safety-compare__groups" role="group" aria-label={labels.title}>{groups.map((group, index) => <code key={index} data-safety-group>{group}</code>)}</div>
        : error === null && labels.loading ? <p className="d-safety-compare__loading" role="status">{labels.loading}</p> : null}
      {qrValue !== null && qrShown ? <div className="d-safety-compare__qr"><QrCode value={qrValue} label={labels.qrLabel ?? ''} size={176} /></div> : null}
      {error !== null ? <p className="d-safety-compare__error" role="alert">{error}</p> : null}
      <div className="d-safety-compare__actions">
        <Button onClick={onCopy}>{labels.copy}</Button>
        {qrValue !== null ? <Button aria-pressed={qrShown} onClick={() => setQrShown(shown => !shown)}>{qrShown ? labels.hideQr : labels.showQr}</Button> : null}
        <label className="d-safety-compare__confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmedFor(event.target.checked ? comparison : null)} />{labels.confirm}</label>
      </div>
    </div>
  </Dialog>;
}

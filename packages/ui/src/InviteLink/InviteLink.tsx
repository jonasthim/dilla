import { useId } from 'react';
import { Banner } from '../Banner/Banner.tsx';
import { Button } from '../Button/Button.tsx';
import { Dialog } from '../Dialog/Dialog.tsx';
import './InviteLink.css';

export interface InviteLinkProps {
  open: boolean;
  /** creating: the instance is minting the link; ready: `url` holds it; failed: `error` says why. */
  state: 'creating' | 'ready' | 'failed';
  url: string;
  /** What the clipboard did, in the dialog's status region ('' when there is nothing to say). */
  status: string;
  /** How many people and how long the link works, and for which server: the field's description. */
  limits: string;
  error: string | null;
  /** Counts the attempts: a new count with the same refusal is a new alert, announced again (review M3). */
  attempt?: number;
  labels: { title: string; creating: string; link: string; copy: string; close: string; retry: string };
  onCopy(): void;
  onRetry(): void;
  onClose(): void;
}

/**
 * The invite dialog (flow 07): the link the shell just copied, in a read-only field that selects all of it on focus (for a
 * clipboard the browser blocked), with a copy button and its limits. The status region stands from the dialog's first
 * render, so "Invite link copied." is announced when it is set.
 */
export function InviteLink({ open, state, url, status, limits, error, attempt = 0, labels, onCopy, onRetry, onClose }: InviteLinkProps) {
  const base = useId();
  const fieldId = `${base}-link`;
  const limitsId = `${base}-limits`;
  return (
    <Dialog open={open} title={labels.title} closeLabel={labels.close} onClose={onClose}
      footer={state === 'failed' ? <Button variant="accent" onClick={onRetry}>{labels.retry}</Button> : undefined}>
      <div className="d-invite-link">
        {state === 'creating' ? <p className="d-invite-link__creating">{labels.creating}</p> : null}
        {state === 'failed' && error !== null ? <Banner key={attempt} tone="danger">{error}</Banner> : null}
        {state === 'ready' ? (
          <>
            <label className="d-invite-link__label" htmlFor={fieldId}>{labels.link}</label>
            <div className="d-invite-link__row">
              <input id={fieldId} className="d-invite-link__field" type="text" readOnly value={url} aria-describedby={limitsId}
                spellCheck={false} onFocus={e => e.currentTarget.select()} />
              <Button variant="accent" onClick={onCopy}>{labels.copy}</Button>
            </div>
            <p id={limitsId} className="d-invite-link__limits">{limits}</p>
          </>
        ) : null}
        <p className="d-invite-link__status" role="status">{status}</p>
      </div>
    </Dialog>
  );
}

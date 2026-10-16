import { StateDot } from '../StateDot/StateDot.tsx';
import './LinkBanner.css';

export interface LinkBannerProps {
  status: 'offline' | 'connecting' | 'online';
  /** The two lines, already filled with the server's name. */
  labels: { offline: string; connecting: string };
}

/**
 * The phone's connection line: the first row of the shell while the link to the server is down or coming up, in place
 * of the desktop status bar. While online the polite status region stays, empty and collapsed, so that its text, when
 * it arrives, is announced (a region added with its text is often not).
 */
export function LinkBanner({ status, labels }: LinkBannerProps) {
  return (
    <div className="d-link-banner" role="status" data-status={status}>
      {status === 'online' ? null : (
        <>
          <StateDot tone={status === 'offline' ? 'danger' : 'pending'} />
          <span className="d-link-banner__text">{status === 'offline' ? labels.offline : labels.connecting}</span>
        </>
      )}
    </div>
  );
}

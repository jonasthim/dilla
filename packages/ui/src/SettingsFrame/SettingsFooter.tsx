import type { ReactNode } from 'react';
import './SettingsFooter.css';

/**
 * The content of a SettingsFrame `footer` (R17): a status or error line on the left (a polite live region that stays mounted so a
 * new message is announced) and the section's actions on the right, with the accent action last. One per section.
 */
export function SettingsFooter({ status, children }: { status?: ReactNode; children: ReactNode }) {
  return (
    <div className="d-settings-footer">
      <div className="d-settings-footer__status" role="status" aria-live="polite">{status}</div>
      <div className="d-settings-footer__actions">{children}</div>
    </div>
  );
}

import { useState } from 'react';
import { Button, Icon } from '@dilla/ui';
import { useCore } from '../../core/context.tsx';
import { t } from '../../strings/index.ts';
import { KeyDialog } from './KeyDialog.tsx';

const LOG_OUT = 'log-out';

/**
 * The danger button that signs this browser out (devices.signOut) and its recovery-key dialog, shared by Settings →
 * Devices and the phone's You tab. The worker wipes the store and publishes `cleared`, which the App answers with a
 * reload; nothing here navigates. `icon` puts the log-out icon before the label (H6, the phone's You tab). The dialog hands focus back to the button when it closes.
 */
export function SignOutAction({ icon = false }: { icon?: boolean } = {}): React.JSX.Element {
  const client = useCore();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)}>{icon ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.75rem' }}><Icon name={LOG_OUT} size={20} />{t('devices.signOut')}</span> : t('devices.signOut')}</Button>
      <KeyDialog open={open} id="devices-signout" title={t('devices.signOutTitle')} body={t('devices.signOutBody')}
        confirmLabel={t('devices.confirmSignOut')} onClose={() => setOpen(false)}
        onConfirm={key => client.call({ m: 'signOutRevoke', recoveryKey: key })} />
    </>
  );
}

// The way out of a set-up that cannot be finished (no authenticator app, no passkey-capable device): clear this browser.
// It sends forgetBrowser and nothing else. It never marks the factor as set and never reaches the shell; the worker wipes
// the store, the phase ends in `cleared` and App reloads. The set-up views have no Cancel, so this is their only exit.
import { useState } from 'react';
import { Button, ConfirmDialog } from '@dilla/ui';
import { useCore } from '../../core/context.tsx';
import { t } from '../../strings/index.ts';
import { useRun } from '../admin/shared.ts';

export function ForgetBrowser(): React.JSX.Element {
  const client = useCore();
  const [open, setOpen] = useState(false);
  const action = useRun();
  const close = () => { setOpen(false); action.reset(); };
  // Contract 1: a refusal sets `error` in the same update that clears `busy` (useRun does), so focus lands on Cancel.
  const confirm = () => {
    void action.run(() => client.call({ m: 'forgetBrowser' }), e => t('factor.error.other', { code: e.code }));
  };
  return (
    <div className="dw-factor-exit">
      <Button variant="ghost" type="button" onClick={() => { setOpen(true); }}>{t('devices.forget')}</Button>
      <ConfirmDialog open={open} title={t('devices.forgetTitle')} body={t('devices.forgetBody')}
        confirmLabel={t('devices.confirmForget')} busyLabel={t('devices.working')} cancelLabel={t('signin.cancel')}
        busy={action.busy} error={action.error} attempt={action.attempt} onConfirm={confirm} onClose={close} />
    </div>
  );
}

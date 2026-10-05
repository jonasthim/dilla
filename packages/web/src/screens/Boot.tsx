import { useEffect, useState } from 'react';
import type { AccountState } from '@dilla/client-core';
import { Button, Dialog, Splash } from '@dilla/ui';
import { browser } from '../browser.ts';
import { useCore } from '../core/context.tsx';
import { errorOf, type UiError } from '../core/errors.ts';
import { useSlice } from '../core/use-slice.ts';
import { t } from '../strings/index.ts';

type Phase = 'loading' | 'unsupported' | 'other-tab' | 'store-lost' | 'resetting' | 'revoked' | 'error';

function bootPhase(account: AccountState | undefined, fatal: UiError | null, resetError: UiError | null, resetting: boolean): Phase {
  if (fatal || resetError) return 'error';
  if (resetting) return 'resetting';
  switch (account?.phase) {
    case 'unsupported': case 'other-tab': case 'store-lost': case 'revoked': case 'error': return account.phase;
    default: return 'loading';
  }
}

export function Boot(props: { fatal: UiError | null }): React.JSX.Element {
  const client = useCore();
  const account = useSlice('account');
  const [confirming, setConfirming] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<UiError | null>(null);
  useEffect(() => { if (account?.phase !== 'store-lost') setResetting(false); }, [account?.phase]);

  const phase = bootPhase(account, props.fatal, resetError, resetting);
  const reset = () => {
    setConfirming(false);
    setResetting(true);
    void client.call({ m: 'resetDevice' }).catch(e => { setResetting(false); setResetError(errorOf(e)); });
  };
  const splash = (() => {
    switch (phase) {
      case 'unsupported': return <Splash status={t('boot.unsupported.status')} detail={t('boot.unsupported.detail')} />;
      case 'other-tab': return <Splash status={t('boot.otherTab.status')} detail={t('boot.otherTab.detail')} />;
      case 'store-lost': return <Splash status={t('boot.storeLost.status')} detail={t('boot.storeLost.detail')}
        action={{ label: t('boot.storeLost.action'), onAction: () => setConfirming(true) }} />;
      case 'resetting': return <Splash status={t('boot.resetting.status')} />;
      case 'revoked': return <Splash status={t('boot.revoked.status')} detail={t('boot.revoked.detail')} />;
      case 'error': return <Splash status={t('boot.error.status')}
        detail={t('boot.error.detail', { code: (props.fatal ?? resetError ?? account?.error)?.code ?? 'E_UNKNOWN' })}
        action={{ label: t('boot.error.action'), onAction: () => browser.reload() }} />;
      default: return <Splash status={t('boot.loading.status')} />;
    }
  })();
  return <>
    {splash}
    {phase === 'store-lost' && <Dialog open={confirming} title={t('boot.storeLost.confirmTitle')}
      closeLabel={t('dialog.close')} onClose={() => setConfirming(false)}
      footer={<Button variant="danger" onClick={reset}>{t('boot.storeLost.confirmAction')}</Button>}>
      <p>{t('boot.storeLost.confirmBody')}</p>
    </Dialog>}
  </>;
}

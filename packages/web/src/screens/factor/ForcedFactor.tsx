// Flow 10 state 2: the screen App mounts for an account that owes a second factor (a legacy account, a sign-up left at the
// last step, an operator reset). It is FactorSetup and nothing else: no skip, no cancel and no route away. Boot's own
// forget-this-browser control stays where it is. The frame's step line is empty: the set-up is the one thing on the page.
import { useState } from 'react';
import { Banner } from '@dilla/ui';
import { useCore } from '../../core/context.tsx';
import { errorOf } from '../../core/errors.ts';
import { useSlice } from '../../core/use-slice.ts';
import { t } from '../../strings/index.ts';
import { useAnnouncer } from '../announcer.ts';
import { FactorSetup } from './FactorSetup.tsx';

export function ForcedFactor(): React.JSX.Element | null {
  const client = useCore();
  const account = useSlice('account');
  const { text, announce } = useAnnouncer();
  const [done, setDone] = useState<{ busy: boolean; code: string | null }>({ busy: false, code: null });
  if (account?.instance == null) return null;
  const finish = () => {
    if (done.busy) return;
    setDone({ busy: true, code: null });
    // Ready, or still owed (the instance re-reads the factors): the phase moves, so this screen leaves on its own.
    client.call({ m: 'factorSetupDone', invite: null })
      .then(() => { setDone({ busy: false, code: null }); })
      .catch((e: unknown) => { setDone({ busy: false, code: errorOf(e).code }); });
  };
  return (
    <>
      {done.code === null ? null : <Banner tone="danger">{t('factor.error.other', { code: done.code })}</Banner>}
      <FactorSetup origin="required" stepLabel="" instanceName={account.instance.name}
        username={account.user?.username ?? ''} announce={announce} onDone={finish} />
      <p className="d-sr-only" role="status" aria-live="polite" data-testid="forced-announcer">{text}</p>
    </>
  );
}

// Flow 10 state 2: the screen App mounts for an account that owes a second factor (a legacy account, a sign-up left at the
// last step, an operator reset). It is FactorSetup and nothing else: no skip and no cancel. The one way out is
// ForgetBrowser, which clears this browser and never reaches the shell. The frame's step line is empty: the set-up is the one thing on the page.
import { useState } from 'react';
import { Banner } from '@dilla/ui';
import { useCore } from '../../core/context.tsx';
import { errorOf } from '../../core/errors.ts';
import { useSlice } from '../../core/use-slice.ts';
import { t } from '../../strings/index.ts';
import { useAnnouncer } from '../announcer.ts';
import { doneProblem, type DoneProblem } from './doneRefusal.ts';
import { FactorSetup } from './FactorSetup.tsx';
import { ForgetBrowser } from './ForgetBrowser.tsx';

export function ForcedFactor(): React.JSX.Element | null {
  const client = useCore();
  const account = useSlice('account');
  const { text, announce } = useAnnouncer();
  const [done, setDone] = useState<{ busy: boolean; problem: DoneProblem | null }>({ busy: false, problem: null });
  if (account?.instance == null) return null;
  // Ready: the phase moves, so this screen leaves on its own. A refusal (still owed, 429, network) re-arms FactorSetup's
  // button, which retries.
  const finish = (): Promise<void> => {
    setDone({ busy: true, problem: null });
    return client.call({ m: 'factorSetupDone', invite: null }).then(
      () => { setDone({ busy: false, problem: null }); },
      (e: unknown) => { setDone({ busy: false, problem: doneProblem(errorOf(e)) }); throw e; });
  };
  return (
    <>
      {done.problem === null ? null : <Banner tone="danger">{t(done.problem.key, done.problem.vars)}</Banner>}
      <FactorSetup origin="required" stepLabel="" instanceName={account.instance.name}
        username={account.user?.username ?? ''} announce={announce} onDone={finish} />
      <ForgetBrowser />
      <p className="d-sr-only" role="status" aria-live="polite" data-testid="forced-announcer">{text}</p>
    </>
  );
}

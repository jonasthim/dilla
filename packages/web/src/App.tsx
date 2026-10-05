import { useEffect, useRef, useState } from 'react';
import type { BootPhase } from '@dilla/client-core';
import { browser } from './browser.ts';
import { useCore } from './core/context.tsx';
import { errorOf, type UiError } from './core/errors.ts';
import { useSlice } from './core/use-slice.ts';
import { joinErrorState, useRoute } from './router.ts';
import { Boot } from './screens/Boot.tsx';
import { Onboarding, type SignupResult } from './screens/Onboarding.tsx';
import { Shell } from './screens/Shell.tsx';

export type Screen = 'boot' | 'onboarding' | 'shell';

export function screenFor(phase: BootPhase | undefined): Screen {
  switch (phase) {
    case 'needs-signup': case 'signup-keys': case 'registering': return 'onboarding';
    case 'ready': return 'shell';
    default: return 'boot';
  }
}

export function App(props: { fatal: UiError | null }): React.JSX.Element {
  const client = useCore();
  const account = useSlice('account');
  const [startError, setStartError] = useState<UiError | null>(null);
  useEffect(() => { client.call({ m: 'start' }).catch(e => setStartError(errorOf(e))); }, [client]);
  const persisted = useRef(false);
  useEffect(() => {
    if (account?.phase === 'ready' && !persisted.current) {
      persisted.current = true;
      void browser.persistStorage().catch(() => false);
    }
  }, [account?.phase]);
  const [, navigate] = useRoute();
  const screen = screenFor(account?.phase);
  // Onboarding stays mounted after the phase turns ready, until its done step calls onFinish.
  const [onboarding, setOnboarding] = useState(false);
  useEffect(() => { if (screen === 'onboarding') setOnboarding(true); }, [screen]);
  const finish = (result: SignupResult) => {
    setOnboarding(false);
    if (result.communityId !== null) {
      navigate({ name: 'channel', communityId: result.communityId, channelId: null }, true);
    } else if (result.joinError !== null) {
      navigate({ name: 'welcome', invite: result.invite }, true);
      // Pre-flight ruling (e): the refused join rides on this history entry for the join dialog.
      history.replaceState(joinErrorState(result.joinError), '');
    } else {
      navigate({ name: 'root' }, true);
    }
  };
  const failed = props.fatal ?? startError;
  if (failed) return <Boot fatal={failed} />;
  if (screen === 'onboarding' || (onboarding && account?.phase === 'ready')) return <Onboarding onFinish={finish} />;
  switch (screen) {
    case 'boot': return <Boot fatal={null} />;
    case 'shell': return <Shell />;
  }
}

import { useEffect, useRef, useState } from 'react';
import type { BootPhase } from '@dilla/client-core';
import { browser } from './browser.ts';
import { useCore } from './core/context.tsx';
import { errorOf, type UiError } from './core/errors.ts';
import { useSlice } from './core/use-slice.ts';
import { Boot } from './screens/Boot.tsx';

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
  const failed = props.fatal ?? startError;
  if (failed) return <Boot fatal={failed} />;
  switch (screenFor(account?.phase)) {
    case 'boot': case 'onboarding': case 'shell': return <Boot fatal={null} />;
  }
}

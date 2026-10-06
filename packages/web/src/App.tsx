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
import { SignIn } from './screens/SignIn.tsx';

export type Screen = 'boot' | 'onboarding' | 'signin' | 'shell';

export function screenFor(phase: BootPhase | undefined): Screen {
  switch (phase) {
    case 'needs-signup': case 'signup-keys': case 'registering': return 'onboarding';
    case 'signin-login': case 'signin-totp': case 'signin-key': case 'enrolling': return 'signin';
    // The worker holds no store after a wipe: the Boot splash shows while the page reloads itself (L-TS-27).
    case 'cleared': return 'boot';
    case 'ready': return 'shell';
    default: return 'boot';
  }
}

function defaultReload(href: string): void {
  window.location.replace(href);
}

export function App(props: { fatal: UiError | null; reload?: (href: string) => void }): React.JSX.Element {
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
  // Head ruling 26: `cleared` accepts nothing but `start`, so a reload is the only way on; once per mount, so a
  // republished slice or StrictMode's double effect never reloads twice. After a list race the query carries the
  // message to the connect step.
  const reloaded = useRef(false);
  const reload = props.reload;
  const phase = account?.phase;
  const errorCode = account?.error?.code;
  useEffect(() => {
    if (phase !== 'cleared' || reloaded.current) return;
    reloaded.current = true;
    (reload ?? defaultReload)(errorCode === 'E_LIST_RACE' ? '/welcome?signin=race' : '/');
  }, [phase, errorCode, reload]);
  const [, navigate] = useRoute();
  const screen = screenFor(phase);
  // Onboarding stays mounted after the phase turns ready, until its done step calls onFinish; so does SignIn.
  const [onboarding, setOnboarding] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  useEffect(() => {
    if (screen === 'onboarding') { setOnboarding(true); setSigningIn(false); }
    if (screen === 'signin') { setSigningIn(true); setOnboarding(false); }
  }, [screen]);
  const finish = (result: SignupResult) => {
    setOnboarding(false);
    if (result.communityId !== null) {
      navigate({ name: 'channel', communityId: result.communityId, channelId: null }, true);
    } else if (result.joinError !== null) {
      navigate({ name: 'welcome', invite: result.invite, signin: null }, true);
      // Pre-flight ruling (e): the refused join rides on this history entry for the join dialog.
      history.replaceState(joinErrorState(result.joinError), '');
    } else {
      navigate({ name: 'root' }, true);
    }
  };
  const finishSignIn = () => {
    setSigningIn(false);
    navigate({ name: 'root' }, true);
  };
  const failed = props.fatal ?? startError;
  if (failed) return <Boot fatal={failed} />;
  if (screen === 'signin' || (signingIn && phase === 'ready')) return <SignIn onFinish={finishSignIn} />;
  if (screen === 'onboarding' || (onboarding && phase === 'ready')) return <Onboarding onFinish={finish} />;
  // The two lines above narrow `screen` to 'boot' | 'shell' ('cleared' is 'boot'), so this switch is total.
  switch (screen) {
    case 'boot': return <Boot fatal={null} />;
    case 'shell': return <Shell />;
  }
}

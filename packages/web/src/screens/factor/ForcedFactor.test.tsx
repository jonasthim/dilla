// web3.6 W2: the forced screen (flow 10 state 2) and the App routing that reaches it.
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Command, FactorsState } from '@dilla/client-core';
import { App } from '../../App.tsx';
import { CoreProvider } from '../../core/context.tsx';
import { FakeClient, refusal } from '../../test/fake-client.ts';
import { account } from '../../test/fixtures.ts';
import { expectNoAxeViolations } from '../../test/setup.ts';
import { en } from '../../strings/index.ts';

const SECRET = 'JBSWY3DPEHPK3PXP';
const CODES = ['AAAAABBBBBCCCCCDDDDDEEEEEF'];
const NO_FACTORS: FactorsState = { owed: true, totp: null, passkeys: [], backupCodesLeft: 0, hasPassword: true };

type Script = (c: Command, fake: FakeClient) => Promise<unknown>;
const happy: Script = (c, f) => {
  switch (c.m) {
    case 'factorTotpBegin': return Promise.resolve({ secret: SECRET, uri: `otpauth://totp/dilla.test:ada?secret=${SECRET}` });
    case 'factorTotpConfirm': return Promise.resolve({ backupCodes: CODES });
    case 'factorSetupDone': f.set('account', account({ phase: 'ready' })); return Promise.resolve({ communityId: null, joinError: null });
    default: return Promise.resolve(null);
  }
};

function setup(script: Script = happy, origin: 'required' | 'signup' | 'signin' = 'required') {
  window.history.replaceState(null, '', '/');
  const fake = new FakeClient();
  fake.set('account', account({ phase: 'factor-setup', factorSetup: { origin } }));
  fake.set('factors', NO_FACTORS);
  fake.handler = c => script(c, fake);
  const user = userEvent.setup();
  const view = render(<div className="d-root"><CoreProvider client={fake}><App fatal={null} /></CoreProvider></div>);
  return { fake, user, view };
}
const h1 = () => screen.getByRole('heading', { level: 1 });
const button = (name: string) => screen.getByRole('button', { name });

describe('the forced screen', () => {
  it('shows the choice with the required paragraph, no step line and no skip, cancel or back', async () => {
    const { view } = setup();
    expect(h1()).toHaveTextContent('Add a second factor');
    expect(screen.getByText(en['factor.choose.required'].replace('{instance}', 'dilla.test'))).toBeInTheDocument();
    expect(screen.queryByText(/^Step \d/)).toBeNull();
    expect(screen.queryByRole('button', { name: /skip|later|cancel|back|sign out|close/i })).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
    await expectNoAxeViolations(view.container);
  });

  it('goes through the app, the codes and the done step, announces it, and opens the shell', async () => {
    const { fake, user } = setup();
    await user.click(button('Continue'));
    await screen.findByRole('img', { name: /QR code/ });
    await user.type(screen.getByRole('textbox', { name: en['factor.totp.code'] }), '123456{Enter}');
    await user.click(await screen.findByRole('checkbox', { name: en['factor.codes.ack'] }));
    await user.click(button('Continue'));
    expect(h1()).toHaveTextContent('Second factor added');
    expect(screen.getByTestId('forced-announcer')).toHaveTextContent('Second factor added.');
    expect(screen.getByTestId('forced-announcer')).toHaveAttribute('aria-live', 'polite');
    await user.click(button('Open dilla'));
    expect(fake.callsOf('factorSetupDone')).toEqual([{ m: 'factorSetupDone', invite: null }]);
    await waitFor(() => { expect(screen.getByRole('navigation', { name: 'servers' })).toBeInTheDocument(); });
  });

  it('shows the refusal and stays when the instance still finds the factor owed', async () => {
    const script: Script = (c, f) => c.m === 'factorSetupDone' ? Promise.reject(refusal({ code: 'E_FACTOR_REQUIRED', status: 403 })) : happy(c, f);
    const { user } = setup(script);
    await user.click(button('Continue'));
    await screen.findByRole('img', { name: /QR code/ });
    await user.type(screen.getByRole('textbox', { name: en['factor.totp.code'] }), '123456{Enter}');
    await user.click(await screen.findByRole('checkbox', { name: en['factor.codes.ack'] }));
    await user.click(button('Continue'));
    await user.click(button('Open dilla'));
    expect(await screen.findByRole('alert')).toHaveTextContent('That did not work (E_FACTOR_REQUIRED). Try again.');
    expect(h1()).toHaveTextContent('Second factor added');
  });
});

describe('the origin picks the screen', () => {
  it('signup mounts onboarding at step 5 of 6', () => {
    setup(happy, 'signup');
    expect(h1()).toHaveTextContent('Add a second factor');
    expect(screen.getByText('Step 5 of 6')).toBeInTheDocument();
  });
  it('signin mounts the sign-in ceremony at step 3 of 4', () => {
    setup(happy, 'signin');
    expect(h1()).toHaveTextContent('Add a second factor');
    expect(screen.getByText('Step 3 of 4')).toBeInTheDocument();
  });
});

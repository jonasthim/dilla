// web3.6 W2: the second factor in the sign-in ceremony (flow 10, states 14 to 16; flow 03 step 3).
import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import type { AccountState, BootPhase, Command, FactorsState } from '@dilla/client-core';
import { CoreProvider } from '../core/context.tsx';
import { FakeClient, refusal } from '../test/fake-client.ts';
import { account, INSTANCE } from '../test/fixtures.ts';
import { expectNoAxeViolations } from '../test/setup.ts';
import { en } from '../strings/index.ts';
import { SignIn } from './SignIn.tsx';

const GROUPED = '7K2M-QX9D-H4TB-R8NW-C3VF-J6PZ-A1GE-Y5KS-M0QT-B7XH-W2DN-F9RC-P4ZA';
const ME = { id: 'bb'.repeat(16), username: 'ada' };
const CEREMONY = 'cd'.repeat(16);
const BACKUP = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SECRET = 'JBSWY3DPEHPK3PXP';
const OPTIONS = JSON.stringify({ publicKey: { challenge: 'Zm9v', rpId: 'dilla.test', userVerification: 'preferred' } });
const NO_FACTORS: FactorsState = { owed: true, totp: null, passkeys: [], backupCodesLeft: 0, hasPassword: true };

const get = vi.fn<(o: { publicKey: { userVerification: string } }) => Promise<unknown>>();
function webauthn(on: boolean): void {
  if (on) {
    Object.defineProperty(window, 'PublicKeyCredential', { value: class {}, configurable: true });
    Object.defineProperty(navigator, 'credentials', { value: { get }, configurable: true });
  } else {
    Reflect.deleteProperty(window, 'PublicKeyCredential');
    Reflect.deleteProperty(navigator, 'credentials');
  }
}
Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
const assertion = () => ({ id: 'AQID', rawId: new Uint8Array([1, 2, 3]).buffer, type: 'public-key', authenticatorAttachment: 'platform',
  response: { clientDataJSON: new Uint8Array([4]).buffer, authenticatorData: new Uint8Array([5]).buffer, signature: new Uint8Array([6]).buffer, userHandle: null },
  getClientExtensionResults: () => ({}) });
afterEach(() => { webauthn(false); get.mockReset(); });

type Script = (c: Command, fake: FakeClient) => Promise<unknown>;
function move(fake: FakeClient, over: Partial<AccountState>): void {
  fake.set('account', { ...fake.get('account')!, ...over });
}
const readyMe = { phase: 'ready', user: ME, deviceId: 'dd'.repeat(16), signIn: null, factorSetup: null } as const;

function setup(phase: BootPhase, script: Script, over: Partial<AccountState> = {}, opts: { webauthn?: boolean } = {}) {
  const fake = new FakeClient();
  fake.set('account', account({
    phase, user: null, deviceId: null, instance: { ...INSTANCE, passwordSignup: true },
    signIn: { username: null, needsTotp: false, factor: null }, ...over,
  }));
  fake.handler = c => script(c, fake);
  webauthn(opts.webauthn ?? true);
  const onFinish = vi.fn();
  const user = userEvent.setup();
  const view = render(<div className="d-root"><CoreProvider client={fake}><SignIn onFinish={onFinish} /></CoreProvider></div>);
  return { fake, onFinish, user, view };
}
const h1 = () => screen.getByRole('heading', { level: 1 });
const button = (name: string) => screen.getByRole('button', { name });
const field = (name: string) => screen.getByRole('textbox', { name });
const password = () => screen.getByLabelText('Password');

async function holdKey(user: UserEvent): Promise<void> {
  await user.click(field('Recovery key'));
  await user.paste(GROUPED);
  await user.click(button('Continue'));
}
async function login(user: UserEvent): Promise<void> {
  await holdKey(user);
  await user.type(field('Username'), 'ada');
  await user.type(password(), 'correct horse');
  await user.click(button('Continue'));
}

/** A worker for an account with an app (needs 1) or a passkey only (needs 2); a passkey may or may not verify the person. */
const worker = (opts: { needs?: 0 | 1 | 2; passkeyNeeds?: 0 | 1 } = {}): Script => (c, fake) => {
  switch (c.m) {
    case 'signInLogin': {
      const needs = opts.needs ?? 1;
      if (needs === 1) move(fake, { phase: 'signin-totp', signIn: { username: 'ada', needsTotp: true, factor: 'totp' } });
      else if (needs === 2) move(fake, { phase: 'signin-passkey', signIn: { username: 'ada', needsTotp: false, factor: 'passkey' } });
      else move(fake, readyMe);
      return Promise.resolve({ needs });
    }
    case 'signInPasskeyBegin': return Promise.resolve({ ceremonyId: CEREMONY, options: OPTIONS });
    case 'signInPasskey': {
      const needs = opts.passkeyNeeds ?? 0;
      if (needs === 1) move(fake, { phase: 'signin-totp', signIn: { username: null, needsTotp: false, factor: 'passkey' } });
      else move(fake, readyMe);
      return Promise.resolve({ needs });
    }
    case 'signInTotp': case 'signInBackupCode': case 'signInKey':
      move(fake, readyMe);
      return Promise.resolve(null);
    case 'signInCancel':
      move(fake, { phase: 'needs-signup', signIn: null });
      return Promise.resolve(null);
    default: return Promise.resolve(null);
  }
};

describe('the code step (flow 10 state 16)', () => {
  it('offers a backup code and the lost-phone line, and no passkey note for an app account', async () => {
    const { user, view } = setup('signin-login', worker());
    await login(user);
    expect(h1()).toHaveTextContent('Your second factor');
    expect(screen.getByText('Step 3 of 4')).toBeInTheDocument();
    expect(button(en['factorSignin.useBackup'])).toHaveAttribute('type', 'button');
    expect(screen.getByText('Lost your phone? Use a backup code, or ask the operator of dilla.test to reset your second factor.')).toBeInTheDocument();
    expect(screen.queryByText(/did not check that it is you/)).toBeNull();
    expect(field('Code')).toHaveAttribute('autocomplete', 'one-time-code');
    expect(field('Code')).toHaveAttribute('inputmode', 'numeric');
    await expectNoAxeViolations(view.container);
  });

  it('says why a code is asked after a passkey that did not check the person', async () => {
    const { fake, user } = setup('signin-login', worker({ needs: 0, passkeyNeeds: 1 }));
    await holdKey(user);
    get.mockResolvedValue(assertion());
    await user.click(button(en['factorSignin.usePasskey']));
    await waitFor(() => { expect(h1()).toHaveTextContent('Your second factor'); });
    expect(screen.getByText('This passkey did not check that it is you, so dilla.test also asks for your code.')).toBeInTheDocument();
    // The key is kept for the code that follows.
    await user.type(field('Code'), '123456{Enter}');
    expect(fake.callsOf('signInTotp')).toEqual([{ m: 'signInTotp', code: '123456', recoveryKey: GROUPED }]);
  });

  it('signs in with a backup code: the form, the format check, the cleaned code, the codes left', async () => {
    const { fake, user, view } = setup('signin-login', worker());
    await login(user);
    fake.set('factors', { owed: false, totp: { confirmedAt: 1 }, passkeys: [], backupCodesLeft: 9, hasPassword: true });
    await user.click(button(en['factorSignin.useBackup']));
    expect(h1()).toHaveTextContent('Use a backup code');
    expect(screen.getByText('Step 3 of 4')).toBeInTheDocument();
    expect(document.activeElement).toBe(field('Backup code'));
    expect(screen.queryByRole('textbox', { name: 'Code' })).toBeNull();
    await expectNoAxeViolations(view.container);
    await user.type(field('Backup code'), 'abcd-1{Enter}');
    expect(field('Backup code')).toHaveAccessibleDescription(en['factorSignin.backup.format']);
    expect(fake.callsOf('signInBackupCode')).toEqual([]);
    await user.clear(field('Backup code'));
    await user.type(field('Backup code'), 'abcde fghij-klmno pqrst uvwxy z{Enter}');
    expect(fake.callsOf('signInBackupCode')).toEqual([{ m: 'signInBackupCode', code: BACKUP, recoveryKey: GROUPED }]);
    expect(h1()).toHaveTextContent('You’re in');
    expect(screen.getByText('You have 9 backup codes left. Make new ones in Settings, under sign-in.')).toBeInTheDocument();
  });

  it('says one code left in the singular, and says nothing after a code from the app', async () => {
    const one = setup('signin-login', worker());
    await login(one.user);
    one.fake.set('factors', { owed: false, totp: { confirmedAt: 1 }, passkeys: [], backupCodesLeft: 1, hasPassword: true });
    await one.user.click(button(en['factorSignin.useBackup']));
    await one.user.type(field('Backup code'), `${BACKUP}{Enter}`);
    expect(screen.getByText('You have 1 backup code left. Make new ones in Settings, under sign-in.')).toBeInTheDocument();
    one.view.unmount();
    const app = setup('signin-login', worker());
    await login(app.user);
    app.fake.set('factors', { owed: false, totp: { confirmedAt: 1 }, passkeys: [], backupCodesLeft: 9, hasPassword: true });
    await app.user.type(field('Code'), '123456{Enter}');
    expect(h1()).toHaveTextContent('You’re in');
    expect(screen.queryByText(/backup codes? left/)).toBeNull();
  });

  it('a refused backup code returns to the login with the password cleared and the key kept', async () => {
    const script: Script = (c, f) => {
      if (c.m === 'signInBackupCode') {
        move(f, { phase: 'signin-login', signIn: { username: 'ada', needsTotp: false, factor: null }, error: { code: 'E_UNAUTHENTICATED', detail: '', status: 401, retryAfterMs: null } });
        return Promise.reject(refusal({ code: 'E_UNAUTHENTICATED', status: 401 }));
      }
      return worker()(c, f);
    };
    const { fake, user } = setup('signin-login', script);
    await login(user);
    await user.click(button(en['factorSignin.useBackup']));
    await user.type(field('Backup code'), `${BACKUP}{Enter}`);
    await waitFor(() => { expect(h1()).toHaveTextContent('Sign in to dilla.test'); });
    expect(screen.getByRole('alert')).toHaveTextContent(en['factorSignin.backup.failed']);
    expect(password()).toHaveValue('');
    expect(document.activeElement).toBe(password());
    expect(screen.queryByRole('textbox', { name: 'Recovery key' })).toBeNull();
    // Signing in again sends the key that was kept.
    await user.type(password(), 'correct horse');
    await user.click(button('Continue'));
    expect(fake.callsOf('signInLogin').at(-1)).toMatchObject({ recoveryKey: GROUPED });
  });

  it('Back leaves the backup-code form for the code form', async () => {
    const { user } = setup('signin-login', worker());
    await login(user);
    await user.click(button(en['factorSignin.useBackup']));
    await user.click(button('Back'));
    expect(h1()).toHaveTextContent('Your second factor');
    expect(field('Code')).toBeInTheDocument();
  });
});

describe('the passkey (flow 10 states 14 and 15)', () => {
  it('is offered on the login only where passkeys can be used', async () => {
    const on = setup('signin-login', worker());
    await holdKey(on.user);
    expect(button(en['factorSignin.usePasskey'])).toHaveAttribute('type', 'button');
    on.view.unmount();
    const off = setup('signin-login', worker(), {}, { webauthn: false });
    await holdKey(off.user);
    expect(screen.queryByRole('button', { name: en['factorSignin.usePasskey'] })).toBeNull();
    off.view.unmount();
    const none = setup('signin-login', worker(), { instance: { ...INSTANCE, passwordSignup: true, passkeys: false } });
    await holdKey(none.user);
    expect(screen.queryByRole('button', { name: en['factorSignin.usePasskey'] })).toBeNull();
  });

  it('signs in with a passkey on its own: the instance options, user verification required, the key sent', async () => {
    const { fake, user } = setup('signin-login', worker({ needs: 0, passkeyNeeds: 0 }));
    await holdKey(user);
    get.mockResolvedValue(assertion());
    await user.click(button(en['factorSignin.usePasskey']));
    await waitFor(() => { expect(h1()).toHaveTextContent('You’re in'); });
    expect(fake.callsOf('signInPasskeyBegin')).toEqual([{ m: 'signInPasskeyBegin' }]);
    expect(get.mock.calls[0]?.[0].publicKey.userVerification).toBe('required');
    const sent = fake.callsOf('signInPasskey');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ m: 'signInPasskey', ceremonyId: CEREMONY, recoveryKey: GROUPED });
    expect(typeof (sent[0] as { response: string }).response).toBe('string');
    expect(fake.callsOf('signInLogin')).toEqual([]);
  });

  it('shows the passkey step for an account that owes only a passkey: no code field, no app wording', async () => {
    const { fake, user, view } = setup('signin-login', worker({ needs: 2 }));
    await login(user);
    expect(h1()).toHaveTextContent('Use your passkey');
    expect(screen.getByText('Step 3 of 4')).toBeInTheDocument();
    expect(screen.getByText(en['factorSignin.passkey.body'])).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Code' })).toBeNull();
    expect(screen.queryByText(/authenticator app/i)).toBeNull();
    expect(button(en['factorSignin.useBackup'])).toBeInTheDocument();
    await expectNoAxeViolations(view.container);
    get.mockResolvedValue(assertion());
    await user.click(button('Use passkey'));
    await waitFor(() => { expect(h1()).toHaveTextContent('You’re in'); });
    expect(fake.callsOf('signInPasskey')).toHaveLength(1);
  });

  it('a passkey-only account can use a backup code', async () => {
    const { fake, user } = setup('signin-login', worker({ needs: 2 }));
    await login(user);
    await user.click(button(en['factorSignin.useBackup']));
    expect(h1()).toHaveTextContent('Use a backup code');
    await user.type(field('Backup code'), `${BACKUP}{Enter}`);
    expect(fake.callsOf('signInBackupCode')).toEqual([{ m: 'signInBackupCode', code: BACKUP, recoveryKey: GROUPED }]);
  });

  const refusals: [string, () => void, string][] = [
    ['an unknown passkey, by its code', () => { get.mockResolvedValue(assertion()); }, 'E_PASSKEY_UNKNOWN'],
    ['any other refusal', () => { get.mockResolvedValue(assertion()); }, 'E_UNAUTHENTICATED'],
  ];
  it.each(refusals)('shows the right banner for %s', async (_name, arm, code) => {
    const script: Script = (c, f) => c.m === 'signInPasskey'
      ? Promise.reject(refusal({ code, status: 401, detail: code === 'E_UNAUTHENTICATED' ? 'unknown passkey' : 'x' }))
      : worker()(c, f);
    const { user } = setup('signin-login', script);
    await holdKey(user);
    arm();
    await user.click(button(en['factorSignin.usePasskey']));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(code === 'E_PASSKEY_UNKNOWN'
      ? 'dilla.test does not know this passkey. It may belong to another account or another server.'
      : en['factorSignin.passkey.failed']);
    expect(document.activeElement).toBe(button(en['factorSignin.usePasskey']));
  });

  it('a cancelled ceremony shows the failed text and returns focus to the button that started it', async () => {
    const { fake, user } = setup('signin-login', worker());
    await holdKey(user);
    get.mockRejectedValue(new DOMException('no', 'NotAllowedError'));
    await user.click(button(en['factorSignin.usePasskey']));
    expect(await screen.findByRole('alert')).toHaveTextContent(en['factorSignin.passkey.failed']);
    expect(document.activeElement).toBe(button(en['factorSignin.usePasskey']));
    expect(fake.callsOf('signInPasskey')).toEqual([]);
  });

  it('on the passkey step a cancelled ceremony keeps the step and focuses its button', async () => {
    const { user } = setup('signin-login', worker({ needs: 2 }));
    await login(user);
    get.mockRejectedValue(new DOMException('no', 'NotAllowedError'));
    await user.click(button('Use passkey'));
    expect(await screen.findByRole('alert')).toHaveTextContent(en['factorSignin.passkey.failed']);
    expect(h1()).toHaveTextContent('Use your passkey');
    expect(document.activeElement).toBe(button('Use passkey'));
  });
});

describe('set-up on a new browser (flow 10 state 1, origin signin)', () => {
  it('shows the set-up as step 3 of 4 with no cancel, then the done step as 4 of 4', async () => {
    const script: Script = (c, f) => {
      switch (c.m) {
        case 'factorTotpBegin': return Promise.resolve({ secret: SECRET, uri: `otpauth://totp/x?secret=${SECRET}` });
        case 'factorTotpConfirm': return Promise.resolve({ backupCodes: [BACKUP] });
        case 'factorSetupDone': move(f, readyMe); return Promise.resolve({ communityId: null, joinError: null });
        default: return Promise.resolve(null);
      }
    };
    const { fake, user } = setup('factor-setup', script, { factorSetup: { origin: 'signin' }, user: ME });
    fake.set('factors', NO_FACTORS);
    expect(h1()).toHaveTextContent('Add a second factor');
    expect(screen.getByText('Step 3 of 4')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /cancel|skip|later/i })).toBeNull();
    await user.click(button('Continue'));
    await screen.findByRole('img', { name: /QR code/ });
    await user.type(field(en['factor.totp.code']), '123456{Enter}');
    await user.click(await screen.findByRole('checkbox'));
    await user.click(button('Continue'));
    expect(fake.callsOf('factorSetupDone')).toEqual([{ m: 'factorSetupDone', invite: null }]);
    await waitFor(() => { expect(h1()).toHaveTextContent('You’re in'); });
    expect(screen.getByText('Step 4 of 4')).toBeInTheDocument();
  });

  it('shows the instance’s refusal when the factor is still owed', async () => {
    const script: Script = c => c.m === 'factorSetupDone'
      ? Promise.reject(refusal({ code: 'E_FACTOR_REQUIRED', status: 403 }))
      : Promise.resolve({ secret: SECRET, uri: 'otpauth://totp/x', backupCodes: [BACKUP] });
    const { user, fake } = setup('factor-setup', script, { factorSetup: { origin: 'signin' }, user: ME });
    fake.set('factors', NO_FACTORS);
    await user.click(button('Continue'));
    await screen.findByRole('img', { name: /QR code/ });
    await user.type(field(en['factor.totp.code']), '123456{Enter}');
    await user.click(await screen.findByRole('checkbox'));
    await user.click(button('Continue'));
    expect(await screen.findByRole('alert')).toHaveTextContent('That did not work (E_FACTOR_REQUIRED). Try again.');
    expect(h1()).toHaveTextContent('Your backup codes');
  });

  it('announces through the sign-in announcer region', async () => {
    const script: Script = () => Promise.resolve({ secret: SECRET, uri: `otpauth://totp/x?secret=${SECRET}` });
    const { fake, user } = setup('factor-setup', script, { factorSetup: { origin: 'signin' }, user: ME });
    fake.set('factors', NO_FACTORS);
    await user.click(button('Continue'));
    await screen.findByRole('img', { name: /QR code/ });
    await user.click(button('Copy'));
    await act(async () => { await Promise.resolve(); });
    await waitFor(() => { expect(screen.getByTestId('signin-announcer')).toHaveTextContent('Setup key copied.'); });
  });
});

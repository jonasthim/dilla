import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import type { AccountState, BootPhase, Command } from '@dilla/client-core';
import { CoreProvider } from '../core/context.tsx';
import { FakeClient, refusal } from '../test/fake-client.ts';
import { account, INSTANCE } from '../test/fixtures.ts';
import { expectNoAxeViolations } from '../test/setup.ts';
import { SignIn } from './SignIn.tsx';

const KEY = '7K2MQX9DH4TBR8NWC3VFJ6PZA1GEY5KSM0QTB7XHW2DNF9RCP4ZA';
const GROUPED = '7K2M-QX9D-H4TB-R8NW-C3VF-J6PZ-A1GE-Y5KS-M0QT-B7XH-W2DN-F9RC-P4ZA';
const ME = { id: 'bb'.repeat(16), username: 'ada' };
const LENGTH = 'A recovery key has 52 characters.';
type Script = (c: Command, fake: FakeClient) => Promise<unknown>;
const idle: Script = () => Promise.resolve(null);

function move(fake: FakeClient, over: Partial<AccountState>): void {
  const current = fake.get('account');
  if (current === undefined) throw new Error('no account slice');
  fake.set('account', { ...current, ...over });
}
function setup(phase: BootPhase, script: Script = idle, over: Partial<AccountState> = {}) {
  const fake = new FakeClient();
  fake.set('account', account({
    phase, user: null, deviceId: null, instance: { ...INSTANCE, passwordSignup: true },
    signIn: { username: null, needsTotp: false }, ...over,
  }));
  fake.handler = c => script(c, fake);
  const onFinish = vi.fn();
  const user = userEvent.setup();
  const view = render(<div className="d-root"><CoreProvider client={fake}><SignIn onFinish={onFinish} /></CoreProvider></div>);
  return { fake, onFinish, user, view };
}
const h1 = () => screen.getByRole('heading', { level: 1 });
const button = (name: string) => screen.getByRole('button', { name });
const field = (name: string) => screen.getByRole('textbox', { name });
const password = () => screen.getByLabelText('Password');

/** The worker of L-TS-23 as the page sees it: the login (carrying the key) → ready, or → the second factor → ready. */
const worker = (opts: { totp?: boolean } = {}): Script => (c, fake) => {
  switch (c.m) {
    case 'signInLogin':
      if (opts.totp) move(fake, { phase: 'signin-totp', signIn: { username: c.username, needsTotp: true } });
      else move(fake, { phase: 'ready', user: ME, deviceId: 'dd'.repeat(16), signIn: null });
      return Promise.resolve({ needsTotp: opts.totp === true });
    case 'signInTotp':
      move(fake, { phase: 'ready', user: ME, deviceId: 'dd'.repeat(16), signIn: null });
      return Promise.resolve(null);
    case 'signInKey':
      move(fake, { phase: 'ready', user: ME, deviceId: 'dd'.repeat(16), signIn: null });
      return Promise.resolve(null);
    case 'signInCancel':
      move(fake, { phase: 'needs-signup', signIn: null });
      return Promise.resolve(null);
    default:
      return Promise.resolve(null);
  }
};
/** Step 1: the key, held by the page until the login sends it. */
async function holdKey(user: UserEvent, text = GROUPED): Promise<void> {
  await user.click(field('Recovery key'));
  await user.paste(text);
  await user.click(button('Continue'));
}
/** Step 1 then step 2: the key, then the username and password. */
async function login(user: UserEvent): Promise<void> {
  await holdKey(user);
  await user.type(field('Username'), ' Ada ');
  await user.type(password(), 'correct horse');
  await user.click(button('Continue'));
}
async function pasteKey(user: UserEvent, text = GROUPED): Promise<void> {
  await user.click(field('Recovery key'));
  await user.paste(text);
}

describe('the ceremony', () => {
  // The coordinator's ruling on REGISTRATION-DEVICES-02's concern 3: the key first, held by the page; nothing reaches
  // the worker until the login, which carries the key, so the login's assertion is spent within seconds.
  it('goes from the recovery key to the login and done without a second factor, sending nothing before the login', async () => {
    const { fake, user, onFinish, view } = setup('signin-login', worker());
    expect(h1()).toHaveTextContent('Your recovery key');
    expect(document.activeElement).toBe(h1());
    expect(screen.getByText('Step 1 of 4')).toBeInTheDocument();
    expect(screen.getByText('Type or paste the recovery key you wrote down when the account was created. Spaces and hyphens do not matter.')).toBeInTheDocument();
    expect(button('Continue')).toHaveAttribute('type', 'submit');
    expect(button('Create a new account instead')).toHaveAttribute('type', 'button');
    await expectNoAxeViolations(view.container);
    await pasteKey(user);
    expect(field('Recovery key')).toHaveAccessibleDescription(expect.stringContaining('52 of 52 characters'));
    await user.click(button('Continue'));
    expect(fake.calls).toEqual([]);
    expect(h1()).toHaveTextContent('Sign in to dilla.test');
    expect(document.activeElement).toBe(h1());
    expect(screen.getByText('Step 2 of 4')).toBeInTheDocument();
    expect(screen.getByText('Use the username and password of your account on dilla.test.')).toBeInTheDocument();
    expect(button('Cancel')).toHaveAttribute('type', 'button');
    await expectNoAxeViolations(view.container);
    await user.type(field('Username'), ' Ada ');
    await user.type(password(), 'correct horse');
    await user.click(button('Continue'));
    expect(fake.callsOf('signInLogin')).toEqual([{ m: 'signInLogin', username: 'ada', password: 'correct horse', recoveryKey: GROUPED }]);
    expect(fake.callsOf('signInKey')).toEqual([]);
    expect(h1()).toHaveTextContent('You’re in');
    expect(document.activeElement).toBe(h1());
    expect(screen.getByText('Step 4 of 4')).toBeInTheDocument();
    expect(screen.getByText('This browser is now a device of ada on dilla.test. Messages sent before now are not shown here.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    await expectNoAxeViolations(view.container);
    expect(onFinish).not.toHaveBeenCalled();
    await user.click(button('Open dilla'));
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('counts the second-factor step when the account has one', async () => {
    const { fake, user, view } = setup('signin-login', worker({ totp: true }));
    await login(user);
    expect(h1()).toHaveTextContent('Your second factor');
    expect(screen.getByText('Step 3 of 4')).toBeInTheDocument();
    expect(screen.getByText('Enter the six-digit code from your authenticator app.')).toBeInTheDocument();
    expect(button('Cancel')).toHaveAttribute('type', 'button');
    await expectNoAxeViolations(view.container);
    await user.type(field('Code'), '123456{Enter}');
    expect(fake.callsOf('signInTotp')).toEqual([{ m: 'signInTotp', code: '123456', recoveryKey: GROUPED }]);
    expect(h1()).toHaveTextContent('You’re in');
    expect(screen.getByText('Step 4 of 4')).toBeInTheDocument();
  });

  it('an empty submit shows the required text and sends nothing', async () => {
    const { fake, user } = setup('signin-login', worker());
    await holdKey(user);
    await user.click(button('Continue'));
    expect(field('Username')).toHaveAccessibleDescription('Fill in this field.');
    expect(password()).toHaveAccessibleDescription('Fill in this field.');
    expect(document.activeElement).toBe(field('Username'));
    expect(field('Username')).toBeRequired();
    expect(password()).toBeRequired();
    await user.type(field('Username'), 'ada');
    expect(field('Username')).not.toHaveAccessibleDescription(expect.stringContaining('Fill in'));
    await user.click(button('Continue'));
    expect(field('Username')).not.toHaveAccessibleDescription(expect.stringContaining('Fill in'));
    expect(password()).toHaveAccessibleDescription('Fill in this field.');
    expect(document.activeElement).toBe(password());
    expect(fake.callsOf('signInLogin')).toEqual([]);
  });

  it('takes a pasted code its authenticator grouped, without the space (A11Y-DESIGN-06)', async () => {
    const { fake, user } = setup('signin-login', worker({ totp: true }));
    await login(user);
    await user.click(field('Code'));
    await user.paste('123 456');
    expect(field('Code')).toHaveValue('123 456');
    await user.keyboard('{Enter}');
    expect(fake.callsOf('signInTotp')).toEqual([{ m: 'signInTotp', code: '123456', recoveryKey: GROUPED }]);
  });

  it('a key refused by its form at the login returns to step 1 with the text kept and the field in error', async () => {
    const { fake, user } = setup('signin-login', (c, f) => {
      if (c.m !== 'signInLogin') return Promise.resolve(null);
      move(f, { phase: 'signin-login', error: { code: 'E_RECOVERY_KEY', detail: '', status: 0, retryAfterMs: null } });
      return Promise.reject(refusal({ code: 'E_RECOVERY_KEY' }));
    });
    const typo = GROUPED.replace('P4ZA', 'P4ZU');
    await holdKey(user, typo);
    await user.type(field('Username'), 'ada');
    await user.type(password(), 'correct horse');
    await user.click(button('Continue'));
    expect(fake.callsOf('signInLogin')).toEqual([{ m: 'signInLogin', username: 'ada', password: 'correct horse', recoveryKey: typo }]);
    expect(h1()).toHaveTextContent('Your recovery key');
    expect(field('Recovery key')).toHaveValue(typo);
    expect(field('Recovery key')).toHaveAccessibleDescription(expect.stringContaining('This is not the recovery key of this account. Check every character.'));
    expect(document.activeElement).toBe(field('Recovery key'));
  });

  it('keeps the status region in place on the key step, empty until the step works (A11Y-DESIGN-04)', () => {
    setup('signin-key');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('an empty code shows the required text and sends nothing', async () => {
    const { fake, user } = setup('signin-totp', worker({ totp: true }), { signIn: { username: 'ada', needsTotp: true } });
    await user.click(button('Continue'));
    expect(field('Code')).toHaveAccessibleDescription('Fill in this field.');
    expect(document.activeElement).toBe(field('Code'));
    expect(fake.callsOf('signInTotp')).toEqual([]);
  });

  it('blocks a second login while the first is in flight, keeping focus on the button', async () => {
    let calls = 0;
    const { user } = setup('signin-login', c => {
      if (c.m === 'signInLogin') calls += 1;
      return new Promise(() => {});
    });
    await login(user);
    expect(button('Checking…')).toHaveAttribute('aria-disabled', 'true');
    expect(document.activeElement).toBe(button('Checking…'));
    expect(button('Cancel')).toHaveAttribute('aria-disabled', 'true');
    await user.click(button('Checking…'));
    await user.click(button('Cancel'));
    expect(calls).toBe(1);
  });

  it('pastes a key in any grouping and case, and counts what the key will be', async () => {
    const { user } = setup('signin-key');
    await pasteKey(user, GROUPED.toLowerCase().replaceAll('-', ' '));
    expect(field('Recovery key')).toHaveValue(GROUPED.toLowerCase().replaceAll('-', ' '));
    expect(field('Recovery key')).toHaveAccessibleDescription(expect.stringContaining('52 of 52 characters'));
    await user.clear(field('Recovery key'));
    await user.type(field('Recovery key'), 'il1o0');
    expect(field('Recovery key')).toHaveAccessibleDescription(expect.stringContaining('5 of 52 characters'));
  });

  it('blocks Add this browser until the key has 52 characters, and says why', async () => {
    const { fake, user } = setup('signin-key', worker());
    await user.type(field('Recovery key'), KEY.slice(0, 51));
    expect(field('Recovery key')).toHaveAccessibleDescription(expect.stringContaining('51 of 52 characters'));
    expect(button('Add this browser')).toHaveAttribute('aria-disabled', 'true');
    expect(button('Add this browser')).toHaveAccessibleDescription(LENGTH);
    await user.keyboard('{Enter}');
    expect(fake.callsOf('signInKey')).toEqual([]);
    expect(document.activeElement).toBe(field('Recovery key'));
    expect(field('Recovery key')).toHaveAccessibleDescription(expect.stringContaining(LENGTH));
    await user.click(button('Add this browser'));
    expect(fake.callsOf('signInKey')).toEqual([]);
    await user.type(field('Recovery key'), KEY.slice(51));
    expect(button('Add this browser')).not.toHaveAttribute('aria-disabled');
    expect(screen.queryByText(LENGTH)).toBeNull();
    await user.click(button('Add this browser'));
    expect(fake.callsOf('signInKey')).toEqual([{ m: 'signInKey', recoveryKey: KEY }]);
  });

  it('shows the working state while this browser is added, with nothing to press', async () => {
    const { fake, user } = setup('signin-key', (c, f) => {
      if (c.m === 'signInKey') move(f, { phase: 'enrolling' });
      return new Promise(() => {});
    });
    await pasteKey(user);
    await user.click(button('Add this browser'));
    expect(h1()).toHaveTextContent('Your recovery key');
    expect(screen.getByRole('status')).toHaveTextContent('Adding this browser to your account…');
    expect(button('Add this browser')).toHaveAttribute('aria-disabled', 'true');
    expect(button('Cancel')).toHaveAttribute('aria-disabled', 'true');
    expect(document.activeElement).toBe(button('Add this browser'));
    await user.click(button('Add this browser'));
    await user.click(button('Cancel'));
    expect(fake.callsOf('signInKey')).toHaveLength(1);
    expect(fake.callsOf('signInCancel')).toEqual([]);
  });

  it('keeps its place after a reload', () => {
    setup('signin-key');
    expect(h1()).toHaveTextContent('Your recovery key');
    expect(field('Recovery key')).toHaveValue('');
  });

  it('shows the working state when it mounts in enrolling', () => {
    const { fake } = setup('enrolling');
    expect(screen.getByRole('status')).toHaveTextContent('Adding this browser to your account…');
    expect(fake.calls).toEqual([]);
  });

  it('cancels from every step', async () => {
    const first = setup('signin-login', worker());
    await first.user.click(button('Create a new account instead'));
    expect(first.fake.callsOf('signInCancel')).toEqual([{ m: 'signInCancel' }]);
    first.view.unmount();
    const second = setup('signin-key', worker());
    await second.user.click(button('Cancel'));
    expect(second.fake.callsOf('signInCancel')).toEqual([{ m: 'signInCancel' }]);
    expect(second.fake.callsOf('signInKey')).toEqual([]);
  });

  it('shows the loading splash without an instance', () => {
    setup('signin-login', idle, { instance: null });
    expect(screen.getByRole('status')).toHaveTextContent('Starting dilla');
  });
});

describe('refusals', () => {
  // E_ENROL_RATE is withdrawn (head ruling 38 as amended): registration answers no per-user 429. Every 429 of the
  // ceremony (the login route, the second-factor route, the registration meter) is E_RATE_LIMITED and shows the one
  // short-wait string signin.error.tooMany as flow 03 froze it (task 15).
  const LOGIN: [string, Parameters<typeof refusal>[0], string][] = [
    ['the device cap', { code: 'E_FORBIDDEN', status: 403 }, 'This account already has as many devices as dilla.test allows. Remove one in Settings on another device first.'],
    ['the registration meter', { code: 'E_RATE_LIMITED', status: 429, retryAfterMs: 1_000 }, 'Too many sign-in attempts. Try again in 1 s.'],
    ['a withdrawn code', { code: 'E_ENROL_RATE', status: 429, retryAfterMs: 1_740_001 }, 'Signing in did not work (E_ENROL_RATE). Try again.'],
    ['the login rate', { code: 'E_RATE_LIMITED', status: 429, retryAfterMs: 4_200 }, 'Too many sign-in attempts. Try again in 5 s.'],
    ['the login rate without a wait', { code: 'E_RATE_LIMITED', status: 429 }, 'Too many attempts from this network. Wait a few minutes, then try again.'],
    ['a dropped connection', { code: 'E_NETWORK' }, 'The connection dropped. Check it and try again.'],
    ['a server failure', { code: 'E_INTERNAL', status: 503 }, 'The connection dropped. Check it and try again.'],
    ['anything else', { code: 'E_SESSION_SCOPE' }, 'Signing in did not work (E_SESSION_SCOPE). Try again.'],
  ];
  it.each(LOGIN)('a refused login shows %s and stays', async (_, init, text) => {
    const { user } = setup('signin-login', c => (c.m === 'signInLogin' ? Promise.reject(refusal(init)) : Promise.resolve(null)));
    await login(user);
    expect(h1()).toHaveTextContent('Sign in to dilla.test');
    expect(screen.getByRole('alert')).toHaveTextContent(text);
    expect(button('Continue')).not.toHaveAttribute('aria-disabled');
    expect(document.activeElement).toBe(button('Continue'));
  });

  it('a wrong username or password is told on the password field', async () => {
    const { user } = setup('signin-login', c => (c.m === 'signInLogin'
      ? Promise.reject(refusal({ code: 'E_UNAUTHENTICATED', status: 401 })) : Promise.resolve(null)));
    await login(user);
    expect(password()).toHaveAccessibleDescription('That username and password did not work.');
    expect(document.activeElement).toBe(password());
    expect(field('Username')).toHaveValue(' Ada ');
    await user.type(password(), 'x');
    expect(password()).not.toHaveAccessibleDescription(expect.stringContaining('did not work'));
  });

  const TOTP: [string, Parameters<typeof refusal>[0]][] = [
    ['a refused code', { code: 'E_UNAUTHENTICATED', status: 401 }],
    ['a spent sign-in', { code: 'E_NO_ASSERTION' }],
  ];
  it.each(TOTP)('%s returns to the login step with the username kept and asks to sign in again', async (_, init) => {
    const { fake, user } = setup('signin-login', (c, f) => {
      if (c.m === 'signInLogin') {
        move(f, { phase: 'signin-totp', signIn: { username: 'ada', needsTotp: true } });
        return Promise.resolve({ needsTotp: true });
      }
      if (c.m !== 'signInTotp') return Promise.resolve(null);
      move(f, { phase: 'signin-login', signIn: { username: 'ada', needsTotp: true } });
      return Promise.reject(refusal(init));
    });
    await login(user);
    expect(screen.getByText('Step 3 of 4')).toBeInTheDocument();
    await user.type(field('Code'), '000000{Enter}');
    expect(fake.callsOf('signInTotp')).toEqual([{ m: 'signInTotp', code: '000000', recoveryKey: GROUPED }]);
    expect(h1()).toHaveTextContent('Sign in to dilla.test');
    expect(screen.getByText('Step 2 of 4')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('That code did not work. Sign in again with a fresh code.');
    expect(screen.queryByRole('textbox', { name: 'Code' })).toBeNull();
    expect(field('Username')).toHaveValue(' Ada ');
    expect(password()).toHaveValue('');
    expect(document.activeElement).toBe(password());
  });

  // REGISTRATION-DEVICES-02: the registration runs inside the login that carries the key; its refusals return the
  // phase to signin-login and show on the login step, the key still held.
  const AFTER_KEY: [string, Parameters<typeof refusal>[0], string][] = [
    ['the device cap', { code: 'E_FORBIDDEN', status: 403 }, 'This account already has as many devices as dilla.test allows. Remove one in Settings on another device first.'],
    ['the registration meter', { code: 'E_RATE_LIMITED', status: 429, retryAfterMs: 600 }, 'Too many sign-in attempts. Try again in 1 s.'],
    ['a replaced row', { code: 'E_SIGNIN_EVICTED' }, 'Someone else is signing in to this account. Change your password from a device you still have, or ask the operator.'],
  ];
  it.each(AFTER_KEY)('a registration refused after the login shows %s on the login step', async (_, init, text) => {
    const { user, view } = setup('signin-login', (c, f) => {
      if (c.m !== 'signInLogin') return Promise.resolve(null);
      move(f, { phase: 'enrolling' });
      move(f, { phase: 'signin-login', signIn: { username: 'ada', needsTotp: false } });
      return Promise.reject(refusal(init));
    });
    await login(user);
    expect(h1()).toHaveTextContent('Sign in to dilla.test');
    expect(screen.getByRole('alert')).toHaveTextContent(text);
    expect(field('Username')).toHaveValue(' Ada ');
    await expectNoAxeViolations(view.container);
  });

  it('an account with nothing to recover, found by the key step, offers only Cancel', async () => {
    const { user, fake, view } = setup('signin-key', (c, f) => {
      if (c.m !== 'signInKey') return Promise.resolve(null);
      move(f, { phase: 'enrolling' });
      move(f, { phase: 'signin-key', error: { code: 'E_NO_BACKUP', detail: '', status: 0, retryAfterMs: null } });
      return Promise.reject(refusal({ code: 'E_NO_BACKUP' }));
    });
    await pasteKey(user);
    await user.click(button('Add this browser'));
    expect(h1()).toHaveTextContent('Your recovery key');
    expect(screen.getByRole('alert')).toHaveTextContent('This account has no backup to recover from on dilla.test.');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual(['Cancel']);
    await expectNoAxeViolations(view.container);
    await user.click(button('Cancel'));
    expect(fake.callsOf('signInCancel')).toEqual([{ m: 'signInCancel' }]);
  });

  // Flow 03 (task 15, D5): E_NO_BACKUP from signInKey is a missing or unreadable backup state, its own string.
  it('a key refused for a missing backup state offers only Cancel', async () => {
    const { user, fake } = setup('signin-key', (c, f) => {
      if (c.m !== 'signInKey') return Promise.resolve(null);
      move(f, { phase: 'enrolling' });
      move(f, { phase: 'signin-key', error: { code: 'E_NO_BACKUP', detail: '', status: 0, retryAfterMs: null } });
      return Promise.reject(refusal({ code: 'E_NO_BACKUP' }));
    });
    await pasteKey(user);
    await user.click(button('Add this browser'));
    expect(h1()).toHaveTextContent('Your recovery key');
    // BACKUPS-RECOVERY-03: the copy names the action that repairs the backup.
    expect(screen.getByRole('alert')).toHaveTextContent('This account has no backup to recover from on dilla.test. Sign in on a device that still holds this account and open dilla there; it repairs the backup. Then try again.');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual(['Cancel']);
    await user.click(button('Cancel'));
    expect(fake.callsOf('signInCancel')).toEqual([{ m: 'signInCancel' }]);
  });

  it('a reload into an account with nothing to recover shows the same', () => {
    setup('signin-key', idle, { error: { code: 'E_NO_BACKUP', detail: '', status: 0, retryAfterMs: null } });
    expect(screen.getByRole('alert')).toHaveTextContent('This account has no recovery data on dilla.test.');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('reads no other code from the account slice', () => {
    setup('signin-key', idle, { error: { code: 'E_RECOVERY_KEY', detail: '', status: 0, retryAfterMs: null } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(field('Recovery key')).toBeInTheDocument();
  });

  it('a wrong key keeps the text, puts focus on the field, and the right key works after it', async () => {
    let attempt = 0;
    const { fake, user } = setup('signin-key', (c, f) => {
      if (c.m !== 'signInKey') return Promise.resolve(null);
      attempt += 1;
      if (attempt === 1) {
        move(f, { phase: 'enrolling' });
        move(f, { phase: 'signin-key' });
        return Promise.reject(refusal({ code: 'E_RECOVERY_KEY' }));
      }
      move(f, { phase: 'ready', user: ME, signIn: null });
      return Promise.resolve(null);
    });
    await pasteKey(user, GROUPED.replace('7K2M', '7K2N'));
    await user.click(button('Add this browser'));
    expect(field('Recovery key')).toHaveValue(GROUPED.replace('7K2M', '7K2N'));
    expect(field('Recovery key')).toHaveAccessibleDescription(expect.stringContaining('This is not the recovery key of this account. Check every character.'));
    expect(document.activeElement).toBe(field('Recovery key'));
    await user.clear(field('Recovery key'));
    await pasteKey(user);
    await user.click(button('Add this browser'));
    expect(fake.callsOf('signInKey')).toEqual([
      { m: 'signInKey', recoveryKey: GROUPED.replace('7K2M', '7K2N') }, { m: 'signInKey', recoveryKey: GROUPED },
    ]);
    expect(h1()).toHaveTextContent('You’re in');
  });

  it('a refused detail is never read', async () => {
    const { user } = setup('signin-key', c => (c.m === 'signInKey'
      ? Promise.reject(refusal({ code: 'E_TIER_MISMATCH', detail: 'E_RECOVERY_KEY wrong recovery key', status: 400 })) : Promise.resolve(null)));
    await pasteKey(user);
    await user.click(button('Add this browser'));
    expect(screen.getByRole('alert')).toHaveTextContent('Signing in did not work (E_TIER_MISMATCH). Try again.');
    expect(screen.queryByText(/not the recovery key/)).toBeNull();
  });
});

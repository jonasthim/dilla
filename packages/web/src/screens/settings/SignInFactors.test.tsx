// web3.6 W3: Settings → Sign-in (flow 10 state 5): the factor rows, the step-up dialog and the three actions behind it.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Command, FactorsState } from '@dilla/client-core';
import { CoreProvider } from '../../core/context.tsx';
import { FakeClient, refusal } from '../../test/fake-client.ts';
import { account } from '../../test/fixtures.ts';
import { expectNoAxeViolations } from '../../test/setup.ts';
import { en, formatDay } from '../../strings/index.ts';
import { liveRegions, watchRegion } from '../../test/live-regions.ts';
import { Settings } from '../Settings.tsx';
import { PasskeyError, getPasskey } from '../../webauthn.ts';

vi.mock('../../webauthn.ts', async (original) => ({ ...await original<typeof import('../../webauthn.ts')>(), getPasskey: vi.fn() }));

const PK = 'ab'.repeat(16);
const PK2 = 'cd'.repeat(16);
const BOTH: FactorsState = { owed: false, totp: { confirmedAt: 1_900_000_000 },
  passkeys: [{ id: PK, name: 'laptop', created: 1_900_000_100, lastUsed: 1_900_000_200 }, { id: PK2, name: 'phone', created: 1_900_000_300, lastUsed: null }],
  backupCodesLeft: 8, hasPassword: true };
const ONLY_TOTP: FactorsState = { owed: false, totp: { confirmedAt: 1_900_000_000 }, passkeys: [], backupCodesLeft: 1, hasPassword: true };
const ONLY_PASSKEY: FactorsState = { owed: false, totp: null, passkeys: [{ id: PK, name: 'laptop', created: 1_900_000_100, lastUsed: null }],
  backupCodesLeft: 0, hasPassword: true };
const SECRET = 'JBSWY3DPEHPK3PXP';
const CODES = ['AAAAABBBBBCCCCCDDDDDEEEEEF', 'GGGGGHHHHHIIIIIJJJJJKKKKKL'];

type Script = (c: Command, fake: FakeClient) => Promise<unknown>;
const happy: Script = (c, f) => {
  switch (c.m) {
    case 'stepUp': return Promise.resolve({ token: 'tok-1' });
    case 'stepUpPasskeyBegin': return Promise.resolve({ ceremonyId: '11'.repeat(16), options: '{}' });
    case 'regenerateBackupCodes': return Promise.resolve({ backupCodes: CODES });
    case 'removeFactor':
      f.set('factors', { ...BOTH, totp: c.kind === 'totp' ? null : BOTH.totp,
        passkeys: c.kind === 'passkey' ? BOTH.passkeys.filter(k => k.id !== c.credId) : BOTH.passkeys });
      return Promise.resolve(null);
    case 'factorTotpBegin': return Promise.resolve({ secret: SECRET, uri: `otpauth://totp/dilla.test:ada?secret=${SECRET}` });
    case 'factorTotpConfirm': return Promise.resolve({ backupCodes: CODES });
    default: return Promise.resolve(null);
  }
};

function setup(factors: FactorsState | undefined = BOTH, script: Script = happy) {
  window.history.replaceState(null, '', '/settings/signin');
  const fake = new FakeClient();
  fake.set('account', account());
  fake.set('devices', []);
  fake.set('settings', {});
  fake.set('communities', []);
  fake.set('dms', []);
  if (factors !== undefined) fake.set('factors', factors);
  fake.handler = c => script(c, fake);
  const user = userEvent.setup();
  const view = render(<div className="d-root"><CoreProvider client={fake}><Settings /></CoreProvider></div>);
  return { fake, user, view };
}
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const stepUp = () => screen.getByRole('dialog', { name: en['factorSettings.stepUp.title'] });
const removeTitle = (name: string) => en['factorSettings.removeTitle.passkey'].replace('{name}', name);
async function confirmPassword(user: ReturnType<typeof userEvent.setup>, password = 'hunter2') {
  await user.type(within(stepUp()).getByLabelText(en['factorSettings.stepUp.password']), `${password}{Enter}`);
}
const region = () => liveRegions(screen.getByRole('dialog', { name: 'Settings' }))[0];

describe('Settings → Sign-in rows', () => {
  it('lists the password, the app, each passkey and the backup codes, and refreshes the factors once', async () => {
    const { fake } = setup();
    expect(await screen.findByRole('heading', { level: 2, name: en['factorSettings.title'] })).toBeInTheDocument();
    expect(fake.callsOf('refreshFactors')).toHaveLength(1);
    expect(screen.getByText(en['factorSettings.body'].replace('{instance}', 'dilla.test'))).toBeInTheDocument();
    expect(screen.getByText(en['factorSettings.password.set'])).toBeInTheDocument();
    expect(screen.getByText(en['factorSettings.totp.on'].replace('{date}', formatDay(1_900_000_000)))).toBeInTheDocument();
    expect(screen.getByText(en['factorSettings.passkeys.used'].replace('{created}', formatDay(1_900_000_100)).replace('{used}', formatDay(1_900_000_200)))).toBeInTheDocument();
    expect(screen.getByText(en['factorSettings.passkeys.unused'].replace('{created}', formatDay(1_900_000_300)))).toBeInTheDocument();
    expect(screen.getByText(en['factorSettings.codes.other'].replace('{count}', '8'))).toBeInTheDocument();
    expect(screen.getByText(en['factorSettings.lost'].replace('{instance}', 'dilla.test'))).toBeInTheDocument();
    expect(button('remove the authenticator app')).toBeInTheDocument();
    expect(button('remove laptop')).toBeInTheDocument();
    expect(button(en['factorSettings.passkeys.add'])).toBeInTheDocument();
    expect(button(en['factorSettings.codes.make'])).toBeInTheDocument();
  });
  it('shows the empty states: no app, no passkeys, no password, one code', async () => {
    setup({ owed: false, totp: null, passkeys: [], backupCodesLeft: 1, hasPassword: false });
    expect(await screen.findByText(en['factorSettings.password.none'])).toBeInTheDocument();
    expect(screen.getByText(en['factorSettings.totp.off'])).toBeInTheDocument();
    expect(screen.getByText(en['factorSettings.passkeys.none'])).toBeInTheDocument();
    expect(screen.getByText(en['factorSettings.codes.one'])).toBeInTheDocument();
    expect(button(en['factorSettings.totp.add'])).toBeInTheDocument();
  });
  it('says there are no codes left', async () => {
    setup(ONLY_PASSKEY);
    expect(await screen.findByText(en['factorSettings.codes.none'])).toBeInTheDocument();
  });
  it('disables the remove on the only factor, with the reason, and does nothing on press', async () => {
    const { fake, user } = setup(ONLY_TOTP);
    const remove = await screen.findByRole('button', { name: 'remove the authenticator app' });
    expect(remove).toHaveAttribute('aria-disabled', 'true');
    expect(remove).toHaveAccessibleDescription(en['factorSettings.only']);
    await user.click(remove);
    expect(screen.queryByRole('dialog', { name: en['factorSettings.stepUp.title'] })).toBeNull();
    expect(fake.callsOf('stepUp')).toEqual([]);
  });
  it('disables the remove on a single passkey when it is the only factor, but not when an app is also set up', async () => {
    const first = setup(ONLY_PASSKEY);
    expect(await screen.findByRole('button', { name: 'remove laptop' })).toHaveAttribute('aria-disabled', 'true');
    first.view.unmount();
    setup({ ...ONLY_PASSKEY, totp: { confirmedAt: 1_900_000_000 } });
    expect(await screen.findByRole('button', { name: 'remove laptop' })).not.toHaveAttribute('aria-disabled');
  });
  it('shows the load failure with its code and a retry that reads again', async () => {
    let n = 0;
    const { fake, user } = setup(undefined, (c, f) => {
      if (c.m === 'refreshFactors') { n += 1; if (n === 1) return Promise.reject(refusal({ code: 'E_NETWORK' })); f.set('factors', BOTH); }
      return Promise.resolve(null);
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(en['factorSettings.error.load'].replace('{code}', 'E_NETWORK'));
    await user.click(button(en['factorSettings.retry']));
    expect(await screen.findByText(en['factorSettings.password.set'])).toBeInTheDocument();
    expect(fake.callsOf('refreshFactors')).toHaveLength(2);
  });
  it('has no axe violations', async () => {
    const { view } = setup();
    await screen.findByText(en['factorSettings.password.set']);
    await expectNoAxeViolations(view.container);
  });
});

describe('the step-up dialog', () => {
  it('asks for the password, sends it once and clears the field', async () => {
    const { fake, user } = setup(BOTH, (c, f) => c.m === 'stepUp' ? Promise.reject(refusal({ code: 'E_STEP_UP', status: 403 })) : happy(c, f));
    await user.click(await screen.findByRole('button', { name: en['factorSettings.codes.make'] }));
    expect(within(stepUp()).getByText(en['factorSettings.stepUp.body'])).toBeInTheDocument();
    expect(within(stepUp()).getByLabelText(en['factorSettings.stepUp.password'])).toHaveAttribute('type', 'password');
    await confirmPassword(user);
    expect(fake.callsOf('stepUp')).toEqual([{ m: 'stepUp', method: 'password', secret: 'hunter2' }]);
    expect(await within(stepUp()).findByRole('alert')).toHaveTextContent(en['factorSettings.stepUp.failed']);
    expect(within(stepUp()).getByLabelText(en['factorSettings.stepUp.password'])).toHaveValue('');
  });
  it('shows the rate limit with its seconds', async () => {
    const { user } = setup(BOTH, (c, f) => c.m === 'stepUp' ? Promise.reject(refusal({ code: 'E_RATE_LIMITED', status: 429, retryAfterMs: 42_000 })) : happy(c, f));
    await user.click(await screen.findByRole('button', { name: en['factorSettings.codes.make'] }));
    await confirmPassword(user);
    expect(await within(stepUp()).findByRole('alert')).toHaveTextContent(en['factor.error.tooMany'].replace('{seconds}', '42'));
  });
  it('closes on Escape and leaves Settings open, with focus back on the opener', async () => {
    const { user } = setup();
    const opener = await screen.findByRole('button', { name: en['factorSettings.codes.make'] });
    await user.click(opener);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: en['factorSettings.stepUp.title'] })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/settings/signin');
    expect(opener).toHaveFocus();
  });
  it('runs the passkey ceremony when the account has no password, and goes on with the token', async () => {
    vi.mocked(getPasskey).mockResolvedValueOnce('{"assertion":1}');
    const { fake, user } = setup({ ...BOTH, hasPassword: false }, (c, f) => c.m === 'stepUpPasskeyFinish' ? Promise.resolve({ token: 'tok-pk' }) : happy(c, f));
    await user.click(await screen.findByRole('button', { name: en['factorSettings.codes.make'] }));
    await user.click(within(stepUp()).getByRole('button', { name: en['factorSettings.stepUp.usePasskey'] }));
    const confirm = await screen.findByRole('dialog', { name: en['factorSettings.codes.makeTitle'] });
    expect(fake.callsOf('stepUpPasskeyFinish')).toEqual([{ m: 'stepUpPasskeyFinish', ceremonyId: '11'.repeat(16), response: '{"assertion":1}' }]);
    await user.click(within(confirm).getByRole('button', { name: en['factorSettings.codes.makeConfirm'] }));
    expect(fake.callsOf('regenerateBackupCodes')).toEqual([{ m: 'regenerateBackupCodes', stepup: 'tok-pk' }]);
  });
  it('keeps the passkey dialog open with a line when the ceremony is cancelled', async () => {
    vi.mocked(getPasskey).mockRejectedValueOnce(new PasskeyError('cancelled', 'no'));
    const { user } = setup({ ...BOTH, hasPassword: false });
    await user.click(await screen.findByRole('button', { name: en['factorSettings.codes.make'] }));
    await user.click(within(stepUp()).getByRole('button', { name: en['factorSettings.stepUp.usePasskey'] }));
    expect(await within(stepUp()).findByRole('alert')).toHaveTextContent(en['factorSettings.error.other'].replace('{code}', 'E_PASSKEY'));
  });
  it('offers a passkey, not a password, when the account has no password', async () => {
    const { fake, user } = setup({ ...BOTH, hasPassword: false });
    await user.click(await screen.findByRole('button', { name: en['factorSettings.codes.make'] }));
    expect(within(stepUp()).queryByLabelText(en['factorSettings.stepUp.password'])).toBeNull();
    expect(within(stepUp()).getByText(en['factorSettings.stepUp.passkeyBody'])).toBeInTheDocument();
    expect(within(stepUp()).getByRole('button', { name: en['factorSettings.stepUp.usePasskey'] })).toBeInTheDocument();
    expect(fake.callsOf('stepUp')).toEqual([]);
  });
});

describe('removing a factor', () => {
  it('steps up, removes the passkey with the token, announces it once and focuses the add-passkey button', async () => {
    const { fake, user } = setup();
    const watch = watchRegion(region());
    await user.click(await screen.findByRole('button', { name: 'remove laptop' }));
    await confirmPassword(user);
    const confirm = await screen.findByRole('dialog', { name: removeTitle('laptop') });
    expect(within(confirm).getByText(en['factorSettings.removeBody'])).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: en['factorSettings.removeConfirm'] }));
    await waitFor(() => expect(fake.callsOf('removeFactor')).toEqual([{ m: 'removeFactor', stepup: 'tok-1', kind: 'passkey', credId: PK }]));
    await waitFor(() => expect(watch.history).toEqual([en['factorSettings.removed.passkey'].replace('{name}', 'laptop')]));
    await waitFor(() => expect(button(en['factorSettings.passkeys.add'])).toHaveFocus());
    expect(screen.queryByText('laptop')).toBeNull();
    watch.stop();
  });
  it('removes the app and focuses its add button', async () => {
    const { fake, user } = setup();
    await user.click(await screen.findByRole('button', { name: 'remove the authenticator app' }));
    await confirmPassword(user);
    const confirm = await screen.findByRole('dialog', { name: en['factorSettings.removeTitle.totp'] });
    await user.click(within(confirm).getByRole('button', { name: en['factorSettings.removeConfirm'] }));
    await waitFor(() => expect(fake.callsOf('removeFactor')).toEqual([{ m: 'removeFactor', stepup: 'tok-1', kind: 'totp', credId: null }]));
    await waitFor(() => expect(button(en['factorSettings.totp.add'])).toHaveFocus());
  });
  it('cancel leaves the factor and returns focus to the row button', async () => {
    const { fake, user } = setup();
    await user.click(await screen.findByRole('button', { name: 'remove laptop' }));
    await confirmPassword(user);
    const confirm = await screen.findByRole('dialog', { name: removeTitle('laptop') });
    await user.click(within(confirm).getByRole('button', { name: en['factorSettings.cancel'] }));
    expect(fake.callsOf('removeFactor')).toEqual([]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'remove laptop' })).toHaveFocus());
  });
  it('asks to confirm again when the token expired, saying so', async () => {
    let calls = 0;
    const { fake, user } = setup(BOTH, (c, f) => {
      if (c.m === 'removeFactor') { calls += 1; if (calls === 1) return Promise.reject(refusal({ code: 'E_STEP_UP', status: 403 })); }
      return happy(c, f);
    });
    await user.click(await screen.findByRole('button', { name: 'remove laptop' }));
    await confirmPassword(user);
    await user.click(within(await screen.findByRole('dialog', { name: removeTitle('laptop') })).getByRole('button', { name: en['factorSettings.removeConfirm'] }));
    const again = await screen.findByRole('dialog', { name: en['factorSettings.stepUp.title'] });
    expect(within(again).getByText(en['factorSettings.stepUp.expired'])).toBeInTheDocument();
    await confirmPassword(user, 'hunter3');
    await user.click(within(await screen.findByRole('dialog', { name: removeTitle('laptop') })).getByRole('button', { name: en['factorSettings.removeConfirm'] }));
    await waitFor(() => expect(fake.callsOf('removeFactor')).toHaveLength(2));
    expect(fake.callsOf('stepUp').map(c => c.secret)).toEqual(['hunter2', 'hunter3']);
  });
  const refusals: [string, Parameters<typeof refusal>[0], string][] = [
    ['409', { code: 'E_CONFLICT', status: 409, detail: 'anything' }, en['factorSettings.error.only']],
    ['404', { code: 'E_NOT_FOUND', status: 404 }, en['factorSettings.error.changed']],
    ['403 E_FORBIDDEN', { code: 'E_FORBIDDEN', status: 403 }, en['factorSettings.error.changed']],
    ['other', { code: 'E_BOOM', status: 500 }, en['factorSettings.error.other'].replace('{code}', 'E_BOOM')],
  ];
  for (const [label, init, text] of refusals) {
    it(`maps ${label} by status and code`, async () => {
      const { fake, user } = setup(BOTH, (c, f) => c.m === 'removeFactor' ? Promise.reject(refusal(init)) : happy(c, f));
      await user.click(await screen.findByRole('button', { name: 'remove laptop' }));
      await confirmPassword(user);
      const confirm = await screen.findByRole('dialog', { name: removeTitle('laptop') });
      await user.click(within(confirm).getByRole('button', { name: en['factorSettings.removeConfirm'] }));
      expect(await within(confirm).findByRole('alert')).toHaveTextContent(text);
      // Contract 1: the refusal and the end of busy are one update, so focus is on Cancel, never on the destructive button.
      await waitFor(() => expect(within(confirm).getByRole('button', { name: en['factorSettings.cancel'] })).toHaveFocus());
      // A change made elsewhere (404, E_FORBIDDEN) re-reads the factors.
      if (text === en['factorSettings.error.changed']) await waitFor(() => expect(fake.callsOf('refreshFactors')).toHaveLength(2));
      else expect(fake.callsOf('refreshFactors')).toHaveLength(1);
    });
  }
});

describe('new backup codes', () => {
  it('makes them after a step-up, shows the list, announces once and returns focus to the make button', async () => {
    const { fake, user } = setup();
    const watch = watchRegion(region());
    await user.click(await screen.findByRole('button', { name: en['factorSettings.codes.make'] }));
    await confirmPassword(user);
    const confirm = await screen.findByRole('dialog', { name: en['factorSettings.codes.makeTitle'] });
    expect(within(confirm).getByText(en['factorSettings.codes.makeBody'])).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: en['factorSettings.codes.makeConfirm'] }));
    expect(fake.callsOf('regenerateBackupCodes')).toEqual([{ m: 'regenerateBackupCodes', stepup: 'tok-1' }]);
    const shown = await screen.findByRole('dialog', { name: en['factor.codes.title'] });
    expect(within(shown).getAllByRole('listitem').map(li => li.textContent?.replace(/\s/g, ''))).toEqual(CODES);
    await waitFor(() => expect(watch.history).toEqual([en['factorSettings.codesMade']]));
    await user.click(within(shown).getByRole('button', { name: en['dialog.close'] }));
    await waitFor(() => expect(button(en['factorSettings.codes.make'])).toHaveFocus());
    // The codes are gone from the page once the list is closed.
    expect(screen.queryByText(/AAAAA/)).toBeNull();
    watch.stop();
  });
  it('asks again when the token expired', async () => {
    const { user } = setup(BOTH, (c, f) => c.m === 'regenerateBackupCodes' ? Promise.reject(refusal({ code: 'E_STEP_UP', status: 403 })) : happy(c, f));
    await user.click(await screen.findByRole('button', { name: en['factorSettings.codes.make'] }));
    await confirmPassword(user);
    await user.click(within(await screen.findByRole('dialog', { name: en['factorSettings.codes.makeTitle'] })).getByRole('button', { name: en['factorSettings.codes.makeConfirm'] }));
    expect(within(await screen.findByRole('dialog', { name: en['factorSettings.stepUp.title'] })).getByText(en['factorSettings.stepUp.expired'])).toBeInTheDocument();
  });
});

describe('adding a factor', () => {
  it('adds the app with the token as stepup, shows the codes, and closes back to Settings', async () => {
    const { fake, user } = setup({ ...ONLY_PASSKEY });
    await user.click(await screen.findByRole('button', { name: en['factorSettings.totp.add'] }));
    await confirmPassword(user);
    await screen.findByRole('img', { name: /QR code/ });
    expect(fake.callsOf('factorTotpBegin')).toEqual([{ m: 'factorTotpBegin', stepup: 'tok-1' }]);
    await user.type(screen.getByRole('textbox', { name: en['factor.totp.code'] }), '123456{Enter}');
    const codes = await screen.findByRole('dialog', { name: en['factor.codes.title'] });
    expect(within(codes).getAllByRole('listitem')).toHaveLength(2);
    await user.click(within(codes).getByRole('checkbox', { name: en['factor.codes.ack'] }));
    await user.click(within(codes).getByRole('button', { name: en['factor.codes.next'] }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: en['factor.codes.title'] })).toBeNull());
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    expect(fake.callsOf('factorTotpConfirm')).toEqual([{ m: 'factorTotpConfirm', code: '123456' }]);
  });
  it('closes the add dialog on Escape and leaves Settings open, focus on the opener', async () => {
    const { user } = setup({ ...ONLY_PASSKEY });
    await user.click(await screen.findByRole('button', { name: en['factorSettings.totp.add'] }));
    await confirmPassword(user);
    await screen.findByRole('img', { name: /QR code/ });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('img', { name: /QR code/ })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    await waitFor(() => expect(button(en['factorSettings.totp.add'])).toHaveFocus());
  });
  it('asks again when the begin is refused for a spent token', async () => {
    const { user } = setup({ ...ONLY_PASSKEY }, (c, f) => c.m === 'factorTotpBegin' ? Promise.reject(refusal({ code: 'E_STEP_UP', status: 403 })) : happy(c, f));
    await user.click(await screen.findByRole('button', { name: en['factorSettings.totp.add'] }));
    await confirmPassword(user);
    expect(within(await screen.findByRole('dialog', { name: en['factorSettings.stepUp.title'] })).getByText(en['factorSettings.stepUp.expired'])).toBeInTheDocument();
  });
  it('opens the passkey step after the step-up, without a choice or a Back', async () => {
    const { fake, user } = setup({ ...ONLY_TOTP });
    await user.click(await screen.findByRole('button', { name: en['factorSettings.passkeys.add'] }));
    await confirmPassword(user);
    const dialog = await screen.findByRole('dialog', { name: en['factor.passkey.title'] });
    expect(within(dialog).getByRole('textbox', { name: en['factor.passkey.name'] })).toHaveValue('Passkey 1');
    expect(within(dialog).queryByRole('button', { name: en['factor.back'] })).toBeNull();
    expect(fake.callsOf('factorPasskeyBegin')).toEqual([]);
  });
});

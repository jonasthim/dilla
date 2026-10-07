import { describe, it, expect } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import type { Command, DeviceSummary } from '@dilla/client-core';
import { CoreProvider } from '../../core/context.tsx';
import { FakeClient, refusal } from '../../test/fake-client.ts';
import { account } from '../../test/fixtures.ts';
import { expectNoAxeViolations } from '../../test/setup.ts';
import { Devices, orderDevices } from './Devices.tsx';

const NOW = Math.floor(Date.now() / 1000);
const OWN = 'cc'.repeat(16);
const PHONE = 'd1'.repeat(16);
const FORGOTTEN = 'f3'.repeat(16);
const OLD = 'e2'.repeat(16);
const GROUPED = '7K2M-QX9D-H4TB-R8NW-C3VF-J6PZ-A1GE-Y5KS-M0QT-B7XH-W2DN-F9RC-P4ZA';
const dev = (id: string, over: Partial<DeviceSummary> = {}): DeviceSummary =>
  ({ id, tier: 1, signerTier: 1, lastSeen: NOW, revokedAt: null, listed: true, own: false, ...over });
const DEVICES: DeviceSummary[] = [
  dev(OLD, { lastSeen: NOW - 3 * 86_400, revokedAt: NOW - 3_600, listed: false }),
  dev(FORGOTTEN, { lastSeen: NOW - 120, listed: false }),
  dev(PHONE, { tier: 0, signerTier: 0, lastSeen: NOW - 60 }),
  dev(OWN, { own: true }),
];

// The devices argument is a rest element, not a default parameter: an explicit `undefined` (no slice yet) must not
// fall back to DEVICES, as a default parameter would.
function setup(handler: (c: Command) => Promise<unknown> = () => Promise.resolve(null), ...list: [] | [DeviceSummary[] | undefined]) {
  const devices = list.length === 0 ? DEVICES : list[0];
  window.history.replaceState({ settingsFrom: '/' }, '', '/settings/devices');
  const fake = new FakeClient();
  fake.set('account', account());
  if (devices !== undefined) fake.set('devices', devices);
  fake.handler = handler;
  const user = userEvent.setup();
  const view = render(<div className="d-root"><CoreProvider client={fake}><Devices /></CoreProvider></div>);
  return { fake, user, view };
}
const rows = () => within(screen.getByRole('list')).getAllByRole('listitem');
const rowOf = (id: string) => {
  const row = rows().find(r => within(r).queryByText(id.slice(0, 8)) !== null);
  if (row === undefined) throw new Error(`no row for ${id}`);
  return row;
};
async function typeKey(user: UserEvent, text = GROUPED) {
  await user.click(screen.getByRole('textbox', { name: 'Recovery key' }));
  await user.paste(text);
}

describe('the device list', () => {
  it('asks for a fresh list once and lists every device, this browser first', async () => {
    const { fake, view } = setup();
    expect(fake.callsOf('refreshDevices')).toEqual([{ m: 'refreshDevices' }]);
    expect(screen.getByRole('heading', { level: 2, name: 'Devices' })).toBeInTheDocument();
    expect(screen.getByText('Every browser and app signed in to your account. Removing a device needs your recovery key.')).toBeInTheDocument();
    expect(screen.getByText('3 devices')).toBeInTheDocument();
    expect(rows().map(r => within(r).getByText(/^[0-9a-f]{8}$/).textContent)).toEqual([OWN, PHONE, FORGOTTEN, OLD].map(id => id.slice(0, 8)));
    const own = rowOf(OWN);
    expect(within(own).getByText('this browser')).toBeInTheDocument();
    expect(within(own).getByText('browser')).toBeInTheDocument();
    expect(within(own).queryByRole('button')).toBeNull();
    expect(within(rowOf(PHONE)).getByText('app')).toBeInTheDocument();
    expect(within(rowOf(PHONE)).getByRole('button', { name: 'remove' })).toBeInTheDocument();
    expect(within(rowOf(FORGOTTEN)).getByText('not yet in the device list')).toBeInTheDocument();
    expect(within(rowOf(FORGOTTEN)).getByRole('button', { name: 'remove' })).toBeInTheDocument();
    expect(within(rowOf(OLD)).getByText('removed')).toBeInTheDocument();
    expect(within(rowOf(OLD)).queryByRole('button')).toBeNull();
    expect(within(rowOf(PHONE)).getByText(/^last seen /)).toBeInTheDocument();
    await expectNoAxeViolations(view.container);
  });
  it('orders by own, then last seen, then removed', () => {
    const tie = dev('aa'.repeat(16), { lastSeen: NOW - 60 });
    expect(orderDevices([...DEVICES, tie]).map(d => d.id)).toEqual([OWN, tie.id, PHONE, FORGOTTEN, OLD]);
  });
  it('shows an unknown count until the list arrives, and refreshes on request', async () => {
    const { fake, user } = setup(undefined, undefined);
    expect(screen.getByText('– devices')).toBeInTheDocument();
    act(() => fake.set('devices', DEVICES));
    expect(screen.getByText('3 devices')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'refresh' }));
    expect(fake.callsOf('refreshDevices')).toHaveLength(2);
  });
  // Flow 03 (task 15's copy freeze): the count line has a singular form, so one device never reads "1 devices".
  it('counts one device in words', () => {
    setup(undefined, [dev(OWN, { own: true }), dev(OLD, { revokedAt: NOW - 60 })]);
    expect(screen.getByText('one device')).toBeInTheDocument();
  });
  it('says when the list did not load', async () => {
    setup(c => (c.m === 'refreshDevices' ? Promise.reject(refusal({ code: 'E_NETWORK' })) : Promise.resolve(null)));
    expect(await screen.findByRole('alert')).toHaveTextContent('That did not work (E_NETWORK). Try again.');
  });
});

describe('removing a device', () => {
  it('needs the whole key, then sends it with the device', async () => {
    const { fake, user, view } = setup();
    await user.click(within(rowOf(PHONE)).getByRole('button', { name: 'remove' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove this device?' });
    expect(within(dialog).getByText('The device is signed out everywhere and leaves every conversation. Enter your recovery key to confirm.')).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Remove' });
    expect(confirm).toHaveAttribute('aria-disabled', 'true');
    expect(confirm).toHaveAccessibleDescription('A recovery key has 52 characters.');
    await user.click(confirm);
    expect(fake.callsOf('revokeDevice')).toEqual([]);
    expect(screen.getByRole('textbox', { name: 'Recovery key' })).toHaveFocus();
    await expectNoAxeViolations(view.container);
    await typeKey(user);
    expect(screen.getByRole('textbox', { name: 'Recovery key' })).toHaveAccessibleDescription(expect.stringContaining('52 of 52 characters'));
    expect(confirm).not.toHaveAttribute('aria-disabled');
    await user.click(confirm);
    expect(fake.callsOf('revokeDevice')).toEqual([{ m: 'revokeDevice', deviceId: PHONE, recoveryKey: GROUPED }]);
    expect(screen.queryByRole('dialog', { name: 'Remove this device?' })).toBeNull();
    await user.click(within(rowOf(PHONE)).getByRole('button', { name: 'remove' }));
    expect(screen.getByRole('textbox', { name: 'Recovery key' })).toHaveValue('');
  });
  it('a wrong key keeps the text and puts focus on the field', async () => {
    const { user } = setup(c => (c.m === 'revokeDevice' ? Promise.reject(refusal({ code: 'E_RECOVERY_KEY' })) : Promise.resolve(null)));
    await user.click(within(rowOf(PHONE)).getByRole('button', { name: 'remove' }));
    await typeKey(user);
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    const field = screen.getByRole('textbox', { name: 'Recovery key' });
    expect(field).toHaveValue(GROUPED);
    expect(field).toHaveAccessibleDescription(expect.stringContaining('This is not the recovery key of this account.'));
    expect(field).toHaveFocus();
    expect(screen.getByRole('dialog', { name: 'Remove this device?' })).toBeInTheDocument();
  });
  it('another refusal is shown in the dialog by its code', async () => {
    const { user } = setup(c => (c.m === 'revokeDevice'
      ? Promise.reject(refusal({ code: 'E_DEVICE_LIST_STALE', detail: 'E_RECOVERY_KEY', status: 409 })) : Promise.resolve(null)));
    await user.click(within(rowOf(PHONE)).getByRole('button', { name: 'remove' }));
    await typeKey(user);
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(within(screen.getByRole('dialog', { name: 'Remove this device?' })).getByRole('alert')).toHaveTextContent('That did not work (E_DEVICE_LIST_STALE). Try again.');
    expect(screen.queryByText(/not the recovery key/)).toBeNull();
  });
  it('sends one removal while in flight and cannot be closed meanwhile', async () => {
    const { fake, user } = setup(c => (c.m === 'revokeDevice' ? new Promise(() => {}) : Promise.resolve(null)));
    await user.click(within(rowOf(PHONE)).getByRole('button', { name: 'remove' }));
    await typeKey(user);
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByRole('button', { name: 'Working…' })).toHaveAttribute('aria-disabled', 'true');
    await user.click(screen.getByRole('button', { name: 'Working…' }));
    await user.keyboard('{Escape}');
    expect(fake.callsOf('revokeDevice')).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: 'Remove this device?' })).toBeInTheDocument();
  });
  it('drops the key when the dialog is closed', async () => {
    const { user } = setup();
    await user.click(within(rowOf(PHONE)).getByRole('button', { name: 'remove' }));
    await typeKey(user);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(within(rowOf(PHONE)).getByRole('button', { name: 'remove' }));
    expect(screen.getByRole('textbox', { name: 'Recovery key' })).toHaveValue('');
  });
  it('removes a device that is not in the list without the key', async () => {
    const { fake, user, view } = setup();
    await user.click(within(rowOf(FORGOTTEN)).getByRole('button', { name: 'remove' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove this device?' });
    expect(within(dialog).getByText('This device signed in with your password but is not in the device list, so it cannot read anything. Removing it needs no recovery key.')).toBeInTheDocument();
    expect(within(dialog).queryByText(/Enter your recovery key/)).toBeNull();
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    await expectNoAxeViolations(view.container);
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(fake.callsOf('revokeDevice')).toEqual([{ m: 'revokeDevice', deviceId: FORGOTTEN, recoveryKey: null }]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('shows a refused removal of an unlisted device in its dialog, sent once while in flight', async () => {
    let release: (e: unknown) => void = () => {};
    const { fake, user } = setup(c => (c.m === 'revokeDevice' ? new Promise((_, reject) => { release = reject; }) : Promise.resolve(null)));
    await user.click(within(rowOf(FORGOTTEN)).getByRole('button', { name: 'remove' }));
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByRole('button', { name: 'Working…' })).toHaveAttribute('aria-disabled', 'true');
    await user.click(screen.getByRole('button', { name: 'Working…' }));
    expect(fake.callsOf('revokeDevice')).toHaveLength(1);
    await act(async () => { release(refusal({ code: 'E_BAD_INPUT' })); await Promise.resolve(); });
    expect(within(screen.getByRole('dialog', { name: 'Remove this device?' })).getByRole('alert')).toHaveTextContent('That did not work (E_BAD_INPUT). Try again.');
  });
  // Pre-flight ruling 1.5: the button that opened the dialog is gone once the row reads removed, so focus goes to
  // the section heading, never to the page body.
  it.each([
    ['a listed device, with the key', PHONE, true],
    ['an unlisted device, without it', FORGOTTEN, false],
  ] as const)('moves focus to the section heading after removing %s', async (_, id, withKey) => {
    const { user } = setup();
    await user.click(within(rowOf(id)).getByRole('button', { name: 'remove' }));
    if (withKey) await typeKey(user);
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    const heading = screen.getByRole('heading', { level: 2, name: 'Devices' });
    expect(document.activeElement).toBe(heading);
    expect(heading).toHaveAttribute('tabindex', '-1');
  });
});

// BACKUPS-RECOVERY-04: the same alert where the recovery key is used.
describe('a recovery root this account did not seal', () => {
  const TEXT = 'The recovery data stored for this account on dilla.test is not this account’s. The recovery key will not work until the operator resets it.';
  it('heads the section with a danger banner while the account slice reports it', async () => {
    const { fake, view } = setup();
    expect(screen.queryByText(TEXT)).toBeNull();
    act(() => fake.set('account', account({ rootMismatch: true })));
    expect(screen.getByRole('alert')).toHaveTextContent(TEXT);
    await expectNoAxeViolations(view.container);
  });
});

describe('this browser', () => {
  it('signs out and removes itself with the key, and leaves the reload to the App', async () => {
    const { fake, user, view } = setup();
    await user.click(screen.getByRole('button', { name: 'sign out and remove this browser' }));
    const dialog = screen.getByRole('dialog', { name: 'Sign out and remove this browser?' });
    expect(within(dialog).getByText('This browser is removed from your account and its data here is cleared. You can sign in again later with your password and recovery key. Enter the key to confirm.')).toBeInTheDocument();
    await expectNoAxeViolations(view.container);
    await typeKey(user);
    await user.click(within(dialog).getByRole('button', { name: 'Sign out' }));
    expect(fake.callsOf('signOutRevoke')).toEqual([{ m: 'signOutRevoke', recoveryKey: GROUPED }]);
    expect(fake.callsOf('revokeDevice')).toEqual([]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(window.location.pathname).toBe('/settings/devices');
  });
  it('forgets this browser without the key, saying the device stays listed', async () => {
    const { fake, user, view } = setup();
    await user.click(screen.getByRole('button', { name: 'forget this browser' }));
    const dialog = screen.getByRole('dialog', { name: 'Forget this browser?' });
    expect(within(dialog).getByText('This clears dilla’s data from this browser and signs it out. The device stays in your account’s device list until you remove it from another device.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    await expectNoAxeViolations(view.container);
    await user.click(within(dialog).getByRole('button', { name: 'Forget' }));
    expect(fake.callsOf('forgetBrowser')).toEqual([{ m: 'forgetBrowser' }]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(window.location.pathname).toBe('/settings/devices');
  });
  it('shows a refused forget in its dialog', async () => {
    const { user } = setup(c => (c.m === 'forgetBrowser' ? Promise.reject(refusal({ code: 'E_STATE' })) : Promise.resolve(null)));
    await user.click(screen.getByRole('button', { name: 'forget this browser' }));
    await user.click(screen.getByRole('button', { name: 'Forget' }));
    expect(within(screen.getByRole('dialog', { name: 'Forget this browser?' })).getByRole('alert')).toHaveTextContent('That did not work (E_STATE). Try again.');
    expect(window.location.pathname).toBe('/settings/devices');
  });
});

import { describe, it, expect } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DeviceSummary } from '@dilla/client-core';
import { CoreProvider } from '../core/context.tsx';
import { FakeClient } from '../test/fake-client.ts';
import { account } from '../test/fixtures.ts';
import { expectNoAxeViolations } from '../test/setup.ts';
import { Settings } from './Settings.tsx';

const C = 'a1'.repeat(16);
const CH = 'c3'.repeat(16);

function setup(path: string, from: string | null) {
  window.history.replaceState(from === null ? null : { settingsFrom: from }, '', path);
  const fake = new FakeClient();
  fake.set('account', account());
  fake.set('devices', []);
  fake.set('settings', {});
  fake.set('communities', []);
  fake.set('dms', []);
  const user = userEvent.setup();
  const view = render(<div className="d-root"><CoreProvider client={fake}><Settings /></CoreProvider></div>);
  return { fake, user, view };
}
const nav = () => screen.getByRole('navigation', { name: 'settings sections' });

describe('Settings', () => {
  it('opens as a dialog on the section of the path, with its heading focused', async () => {
    const { fake, view } = setup('/settings/devices', `/c/${C}/${CH}`);
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(within(dialog).getByRole('heading', { level: 1, name: 'Settings' })).toHaveFocus();
    const items = within(nav()).getAllByRole('button');
    expect(items).toEqual(['devices', 'notifications', 'appearance'].map(name => within(nav()).getByRole('button', { name })));
    expect(within(nav()).getByRole('button', { name: 'devices' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { level: 2, name: 'Devices' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close settings' })).toBeInTheDocument();
    expect(fake.callsOf('refreshDevices')).toEqual([{ m: 'refreshDevices' }]);
    await expectNoAxeViolations(view.container);
  });
  it('switches sections in place, keeping where it came from', async () => {
    const { user, view } = setup('/settings/devices', `/c/${C}/${CH}`);
    const depth = window.history.length;
    await user.click(within(nav()).getByRole('button', { name: 'notifications' }));
    expect(window.location.pathname).toBe('/settings/notifications');
    expect(window.history.length).toBe(depth);
    expect(window.history.state).toEqual({ settingsFrom: `/c/${C}/${CH}` });
    expect(screen.getByRole('heading', { level: 2, name: 'Notifications' })).toBeInTheDocument();
    expect(within(nav()).getByRole('button', { name: 'notifications' })).toHaveAttribute('aria-current', 'page');
    await expectNoAxeViolations(view.container);
    await user.click(within(nav()).getByRole('button', { name: 'appearance' }));
    expect(screen.getByRole('heading', { level: 2, name: 'Appearance' })).toBeInTheDocument();
    await expectNoAxeViolations(view.container);
  });
  it('closes to where it came from on Escape, replacing its entry', async () => {
    const { user } = setup('/settings/notifications', `/c/${C}/${CH}`);
    const depth = window.history.length;
    await user.keyboard('{Escape}');
    expect(window.location.pathname).toBe(`/c/${C}/${CH}`);
    expect(window.history.length).toBe(depth);
    expect(window.history.state).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('closes to / from a deep link, by the close button', async () => {
    const { user } = setup('/settings', null);
    expect(screen.getByRole('heading', { level: 2, name: 'Devices' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close settings' }));
    expect(window.location.pathname).toBe('/');
  });
  it('renders nothing for another route', () => {
    setup(`/c/${C}/${CH}`, null);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  // Pre-flight ruling 1.2: Escape in a dialog nested in the frame closes only that dialog, and does nothing at all
  // while its command runs; Settings stays open on its route either way.
  it('leaves Settings open when Escape closes a dialog inside it, and while a removal runs', async () => {
    const PHONE = 'd1'.repeat(16);
    const devices: DeviceSummary[] = [
      { id: 'cc'.repeat(16), tier: 1, signerTier: 1, lastSeen: 1, revokedAt: null, listed: true, own: true },
      { id: PHONE, tier: 0, signerTier: 0, lastSeen: 1, revokedAt: null, listed: true, own: false },
    ];
    const { fake, user } = setup('/settings/devices', `/c/${C}/${CH}`);
    fake.handler = c => (c.m === 'revokeDevice' ? new Promise(() => {}) : Promise.resolve(null));
    act(() => fake.set('devices', devices));
    await user.click(screen.getByRole('button', { name: 'remove' }));
    expect(screen.getByRole('dialog', { name: 'Remove this device?' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Remove this device?' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/settings/devices');
    await user.click(screen.getByRole('button', { name: 'remove' }));
    await user.click(screen.getByRole('textbox', { name: 'Recovery key' }));
    await user.paste('7K2M-QX9D-H4TB-R8NW-C3VF-J6PZ-A1GE-Y5KS-M0QT-B7XH-W2DN-F9RC-P4ZA');
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByRole('button', { name: 'Working…' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(fake.callsOf('revokeDevice')).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: 'Remove this device?' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/settings/devices');
  });
});

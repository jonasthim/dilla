import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DeviceSummary } from '@dilla/client-core';
import { CoreProvider } from '../core/context.tsx';
import { FakeClient } from '../test/fake-client.ts';
import { account, ME } from '../test/fixtures.ts';
import { expectNoAxeViolations } from '../test/setup.ts';
import { t } from '../strings/index.ts';
import { NAV } from './Settings.tsx';
import { You } from './You.tsx';

const A = 'a1'.repeat(16);
const dev = (id: string, over: Partial<DeviceSummary> = {}): DeviceSummary =>
  ({ id, tier: 1, signerTier: 1, lastSeen: 1, revokedAt: null, listed: true, own: false, ...over });

function setup(onOpenSettings = vi.fn()) {
  const fake = new FakeClient();
  fake.set('account', account());
  fake.set('connection', { status: 'online', generation: '7' });
  fake.set('devices', [dev('cc'.repeat(16), { own: true }), dev('dd'.repeat(16)), dev('ee'.repeat(16), { revokedAt: 5 })]);
  fake.set('communities', [{ id: A, name: 'Midgard', owner: 'ee'.repeat(16) }]);
  fake.set(`members:${A}`, [{ userId: ME.id, username: 'ada', display: 'Ada L', kind: 0, roleIds: [] }]);
  const user = userEvent.setup();
  const view = render(<div className="d-root"><CoreProvider client={fake}><You onOpenSettings={onOpenSettings} /></CoreProvider></div>);
  return { fake, user, view, onOpenSettings };
}

describe('You', () => {
  it('offers the account status as a 44 row that opens its four choices (H6), not a native select', async () => {
    const { fake, user, view } = setup();
    expect(screen.queryByRole('combobox')).toBeNull();
    const row = screen.getByRole('button', { name: new RegExp(t('presence.label')) });
    expect(row).toHaveClass('dw-phone-row');
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(row).toHaveTextContent(t('presence.online'));
    expect(screen.queryByRole('button', { name: t('presence.dnd') })).toBeNull();
    await user.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    const group = screen.getByRole('group', { name: t('presence.label') });
    expect(within(group).getAllByRole('button').map(b => b.textContent)).toEqual(
      [t('presence.online'), t('presence.idle'), t('presence.dnd'), t('presence.invisible')]);
    expect(within(group).getByRole('button', { name: t('presence.online') })).toHaveAttribute('aria-pressed', 'true');
    await expectNoAxeViolations(view.container);
    await user.click(within(group).getByRole('button', { name: t('presence.dnd') }));
    expect(fake.callsOf('setPresenceChoice')).toEqual([{ m: 'setPresenceChoice', choice: 'dnd' }]);
    // The choice closes the list and focus goes back to the row.
    expect(screen.queryByRole('group', { name: t('presence.label') })).toBeNull();
    expect(row).toHaveFocus();
  });
  it('says so, in an alert, when the status could not be changed', async () => {
    const { fake, user } = setup();
    fake.handler = () => Promise.reject(new Error('no'));
    await user.click(screen.getByRole('button', { name: new RegExp(t('presence.label')) }));
    await user.click(screen.getByRole('button', { name: t('presence.idle') }));
    expect(await screen.findByRole('alert')).toHaveTextContent(t('presence.error'));
  });
  it('heads the page with a phone header and names the account', () => {
    setup();
    const heading = screen.getByRole('heading', { level: 2, name: t('you.title') });
    expect(heading.closest('header')).toHaveClass('d-phone-header');
    expect(screen.getByText('Ada L')).toBeInTheDocument();
    expect(screen.getByText('@ada')).toBeInTheDocument();
  });

  it('falls back to the username when no server knows a display name', () => {
    const { fake } = setup();
    act(() => fake.set(`members:${A}`, []));
    expect(screen.getAllByText('ada')).toHaveLength(1);
    expect(screen.getByText('@ada')).toBeInTheDocument();
  });

  it('asks for the device list once on mount', () => {
    const { fake } = setup();
    expect(fake.callsOf('refreshDevices')).toEqual([{ m: 'refreshDevices' }]);
  });

  it('shows the four facts Diagnostics shows, from the same slices', () => {
    setup();
    const region = screen.getByRole('region', { name: t('you.status') });
    const fact = (label: string) => within(region).getByText(label).closest('div') as HTMLElement;
    expect(fact(t('shell.status.node'))).toHaveTextContent('dilla.test');
    expect(fact(t('shell.status.link'))).toHaveTextContent('online');
    expect(fact(t('shell.status.gen'))).toHaveTextContent('7');
    expect(fact(t('shell.status.devices'))).toHaveTextContent('2');
  });

  it('lists one button per settings section, in the Settings order', async () => {
    const { user, onOpenSettings } = setup();
    const list = screen.getByRole('list', { name: t('you.settings') });
    const buttons = within(list).getAllByRole('button');
    expect(buttons.map(b => b.textContent)).toEqual(NAV.map(item => t(item.key)));
    await user.click(within(list).getByRole('button', { name: t('settings.nav.privacy') }));
    expect(onOpenSettings).toHaveBeenCalledWith('privacy');
    await user.click(within(list).getByRole('button', { name: t('factorSettings.nav') }));
    expect(onOpenSettings).toHaveBeenLastCalledWith('signin');
  });

  it('ends with the sign-out action and has no axe violations', async () => {
    const { view } = setup();
    expect(screen.getByRole('button', { name: t('devices.signOut') })).toBeInTheDocument();
    await expectNoAxeViolations(view.container);
  });
  // H6: every row has its own icon, and sign out has log-out.
  it('gives every settings row a distinct icon, and sign out its own', () => {
    setup();
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-settings-section]'));
    expect(rows).toHaveLength(NAV.length);
    const icons = rows.map(row => row.querySelector('svg')?.innerHTML ?? '');
    expect(icons.every(svg => svg !== '')).toBe(true);
    expect(new Set(icons).size).toBe(icons.length);
    expect(screen.getByRole('button', { name: t('devices.signOut') }).querySelector('svg')).not.toBeNull();
  });
});

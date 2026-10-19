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
  it('offers a keyboard accessible account status choice', async () => {
    const { fake, user, view } = setup();
    const picker = screen.getByRole('combobox', { name: 'Your status' });
    expect(picker).toHaveValue('online');
    await user.selectOptions(picker, 'dnd');
    expect(fake.callsOf('setPresenceChoice')).toEqual([{ m: 'setPresenceChoice', choice: 'dnd' }]);
    await expectNoAxeViolations(view.container);
  });
  it('heads the page and names the account', () => {
    setup();
    expect(screen.getByRole('heading', { level: 1, name: t('you.title') })).toBeInTheDocument();
    expect(screen.getByText('Ada L')).toBeInTheDocument();
    expect(screen.getByText('@ada')).toBeInTheDocument();
  });

  it('falls back to the username when no server knows a display name', () => {
    const { fake } = setup();
    act(() => fake.set(`members:${A}`, []));
    expect(screen.getAllByText('ada')).toHaveLength(1);
    expect(screen.getByText('@ada')).toBeInTheDocument();
  });

  it('shows the four facts the status bar shows, from the same slices', () => {
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
});

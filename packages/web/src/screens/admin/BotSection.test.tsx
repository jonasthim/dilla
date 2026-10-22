import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PhoneLayoutProvider } from '../../../../ui/src/internal/phoneLayout.ts';
import { CoreProvider } from '../../core/context.tsx';
import { FakeClient, refusal } from '../../test/fake-client.ts';
import { account, ME } from '../../test/fixtures.ts';
import { en } from '../../strings/index.ts';
import { ServerSettings } from './ServerSettings.tsx';

vi.mock('./spotify-link.ts', async importOriginal => ({ ...await importOriginal<typeof import('./spotify-link.ts')>(), authorizeSpotify: vi.fn() }));
import { authorizeSpotify, spotifySession } from './spotify-link.ts';

const SERVER = 'a1'.repeat(16);
type Installation = { id: string; communityId: string; state: 0 | 1 | 2 | 3 | 4 | 5; revision: string;
  userId: string | null; deviceId: string | null; capabilities: number; updatedAt: string };
const ROW: Installation = { id: 'b2'.repeat(16), communityId: SERVER, state: 0, revision: '1', userId: null,
  deviceId: null, capabilities: 0, updatedAt: '100' };
const ACCESS = { top: 100, owner: true, manageCommunity: true, manageChannels: true, kickMembers: true,
  banMembers: true, moderateMembers: true, createInvite: true, manageRoles: true, loaded: true, overwritesLoaded: true, everyoneId: 'ab'.repeat(16) };

function setup(initial: Installation | null = null, failGet = false, phone = false, manageRoles = true) {
  const fake = new FakeClient();
  fake.set('account', account());
  fake.set('factors', { owed: false, totp: null, passkeys: [], backupCodesLeft: 0, hasPassword: true });
  fake.set('communities', [{ id: SERVER, name: 'Midgard', owner: ME.id }]);
  fake.set(`permissions:${SERVER}`, { ...ACCESS, manageRoles });
  fake.set(`roles:${SERVER}`, [
    { id: '22'.repeat(16), name: 'Members', position: 1, members: 0, allow: 0, deny: 0, color: 0, hoist: false, mentionable: false },
  ]);
  fake.handler = async command => {
    if (command.m === 'getBotInstallation') return failGet ? Promise.reject(refusal({ code: 'E_NETWORK' })) : initial;
    if (command.m === 'getBotJoinRole') return initial === null ? null : { roleId: null, installationId: initial.id };
    if (command.m === 'stepUp') return { token: 'short-lived-step-up' };
    if (command.m === 'configureBotInstallation') return { ...ROW, state: 0, revision: '1' };
    if (command.m === 'disableBotInstallation') return { ...ROW, state: 4, revision: '2' };
    return command.m === 'getAFKSettings' ? { channelId: null, timeoutSeconds: 300 } : null;
  };
  const announce = vi.fn();
  const user = userEvent.setup();
  const view = render(<PhoneLayoutProvider value={phone}><div className="d-root"><CoreProvider client={fake}>
    <ServerSettings communityId={SERVER} tab="bot" onTab={vi.fn()} onClose={vi.fn()} announce={announce} />
  </CoreProvider></div></PhoneLayoutProvider>);
  return { fake, user, view, announce };
}

describe('the server bot settings', () => {
  it('requires step-up, stores only attempt context, and opens the Spotify authorization URL', async () => {
    spotifySession.clear();
    vi.mocked(authorizeSpotify).mockClear();
    const { fake, user } = setup({ ...ROW, state: 3, capabilities: 1 });
    fake.handler = command => {
      if (command.m === 'getBotInstallation') return Promise.resolve({ ...ROW, state: 3, capabilities: 1 });
      if (command.m === 'stepUp') return Promise.resolve({ token: 'short-lived-step-up' });
      if (command.m === 'beginBotSpotifyAttempt') return Promise.resolve({
        attemptId: 'dd'.repeat(16), authorizeUrl: 'https://accounts.spotify.com/authorize?state=csrf-only', expires: `${Math.floor(Date.now() / 1000) + 600}`,
      });
      return Promise.resolve(command.m === 'getAFKSettings' ? { channelId: null, timeoutSeconds: 300 } : null);
    };
    await screen.findByText(en['admin.bot.status.ready']);
    await user.click(screen.getByRole('button', { name: en['admin.bot.music.spotifyLink'] }));
    expect(screen.getByRole('dialog', { name: en['factorSettings.stepUp.title'] })).toBeInTheDocument();
    await user.type(screen.getByLabelText(en['factorSettings.stepUp.password']), 'local-password');
    await user.click(screen.getByRole('button', { name: en['factorSettings.stepUp.confirm'] }));
    await waitFor(() => expect(authorizeSpotify).toHaveBeenCalledWith('https://accounts.spotify.com/authorize?state=csrf-only'));
    const stored = spotifySession.getItem('dilla.spotifyAttempt');
    expect(stored).toContain(SERVER);
    expect(stored).toContain('dd'.repeat(16));
    expect(stored).toContain('csrf-only');
    expect(stored).not.toContain('oauth-code');
    expect(fake.callsOf('beginBotSpotifyAttempt')).toEqual([expect.objectContaining({ communityId: SERVER, stepUp: 'short-lived-step-up' })]);
    expect(screen.getByText(en['admin.bot.music.providerUnknown'])).toBeInTheDocument();
    expect(screen.getByText(en['admin.bot.music.youtubeHelp'])).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /spotify/i })).not.toBeInTheDocument();
    expect(fake.calls.map(call => call.m)).toEqual(['getBotInstallation', 'getBotJoinRole', 'refreshFactors', 'stepUp', 'beginBotSpotifyAttempt']);
  });

  it('saves one approved join-role setting with a request ID and explains future-join assignment', async () => {
    const initial = { ...ROW, state: 3 as const, revision: '3' };
    const { fake, user, announce } = setup(initial);
    fake.handler = command => {
      if (command.m === 'getBotInstallation') return Promise.resolve(initial);
      if (command.m === 'getBotJoinRole') return Promise.resolve({ roleId: null, installationId: initial.id });
      if (command.m === 'configureBotJoinRole') return Promise.resolve({ installationId: initial.id });
      return Promise.resolve(command.m === 'getAFKSettings' ? { channelId: null, timeoutSeconds: 300 } : null);
    };
    expect(await screen.findByText(en['admin.bot.joinRole.honest'])).toBeInTheDocument();
    const select = await screen.findByRole('combobox', { name: en['admin.bot.joinRole.label'] });
    await user.selectOptions(select, '22'.repeat(16));
    await user.click(screen.getByRole('button', { name: en['admin.bot.joinRole.save'] }));
    await waitFor(() => expect(fake.callsOf('configureBotJoinRole')).toHaveLength(1));
    expect(fake.callsOf('configureBotJoinRole')[0]).toMatchObject({ communityId: SERVER, roleId: '22'.repeat(16), installationId: initial.id });
    expect(fake.callsOf('configureBotJoinRole')[0].requestId).toMatch(/^[0-9a-f]{32}$/);
    expect(announce).toHaveBeenCalledWith(en['admin.bot.joinRole.saved']);
  });

  it('keeps installation controls available when join-role read is forbidden', async () => {
    const initial = { ...ROW, state: 3 as const, revision: '3' };
    const { fake, user } = setup(initial, false, false, false);
    fake.handler = command => {
      if (command.m === 'getBotInstallation') return Promise.resolve(initial);
      if (command.m === 'getBotJoinRole') return Promise.reject(refusal({ code: 'E_FORBIDDEN', status: 403 }));
      if (command.m === 'disableBotInstallation') return Promise.resolve({ ...initial, state: 4, revision: '4' });
      return Promise.resolve(command.m === 'getAFKSettings' ? { channelId: null, timeoutSeconds: 300 } : null);
    };
    await screen.findByText(en['admin.bot.status.ready']);
    await user.click(screen.getByRole('button', { name: en['admin.bot.disable'] }));
    await waitFor(() => expect(fake.callsOf('disableBotInstallation')).toHaveLength(1));
    expect(await screen.findByText(en['admin.bot.status.disabled'])).toBeInTheDocument();
  });

  it('keeps installation controls available after a rejected join-role save', async () => {
    const initial = { ...ROW, state: 3 as const, revision: '3' };
    const { fake, user } = setup(initial);
    fake.handler = command => {
      if (command.m === 'getBotInstallation') return Promise.resolve(initial);
      if (command.m === 'getBotJoinRole') return Promise.resolve({ roleId: null, installationId: initial.id });
      if (command.m === 'configureBotJoinRole') return Promise.reject(refusal({ code: 'E_FORBIDDEN', status: 403 }));
      if (command.m === 'disableBotInstallation') return Promise.resolve({ ...initial, state: 4, revision: '4' });
      return Promise.resolve(command.m === 'getAFKSettings' ? { channelId: null, timeoutSeconds: 300 } : null);
    };
    const select = await screen.findByRole('combobox', { name: en['admin.bot.joinRole.label'] });
    await user.selectOptions(select, '22'.repeat(16));
    await user.click(screen.getByRole('button', { name: en['admin.bot.joinRole.save'] }));
    expect(await screen.findByRole('alert')).toHaveTextContent(en['admin.bot.error.forbidden']);
    await user.click(screen.getByRole('button', { name: en['admin.bot.disable'] }));
    await waitFor(() => expect(fake.callsOf('disableBotInstallation')).toHaveLength(1));
  });

  it('shows staged status and asks for step-up before enabling through the worker', async () => {
    const { fake, user, announce } = setup();
    expect(await screen.findByText(en['admin.bot.none'])).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: en['admin.bot.enable'] }));
    expect(screen.getByRole('dialog', { name: en['factorSettings.stepUp.title'] })).toBeInTheDocument();
    await user.type(screen.getByLabelText(en['factorSettings.stepUp.password']), 'local-password');
    await user.click(screen.getByRole('button', { name: en['factorSettings.stepUp.confirm'] }));
    expect(await screen.findByText(en['admin.bot.status.pending'])).toBeInTheDocument();
    expect(screen.getByText(en['admin.bot.staged'])).toBeInTheDocument();
    expect(fake.callsOf('configureBotInstallation')).toEqual([expect.objectContaining({ m: 'configureBotInstallation',
      communityId: SERVER, expectedRevision: null, capabilities: 0, stepUp: 'short-lived-step-up' })]);
    expect(announce).toHaveBeenCalledWith(en['admin.bot.enabledNotice']);
  });

  it('submits explicitly selected capabilities and supports toggling them by keyboard', async () => {
    const { fake, user } = setup();
    await screen.findByText(en['admin.bot.none']);
    expect(screen.getByRole('checkbox', { name: en['admin.bot.capability.music'] })).not.toBeChecked();
    const music = screen.getByRole('checkbox', { name: en['admin.bot.capability.music'] });
    music.focus();
    await user.keyboard(' ');
    expect(music).toBeChecked();
    const announcements = screen.getByRole('checkbox', { name: en['admin.bot.capability.announcements'] });
    await user.click(announcements);
    await user.click(screen.getByRole('button', { name: en['admin.bot.enable'] }));
    await user.type(screen.getByLabelText(en['factorSettings.stepUp.password']), 'local-password');
    await user.click(screen.getByRole('button', { name: en['factorSettings.stepUp.confirm'] }));
    await waitFor(() => expect(fake.callsOf('configureBotInstallation')).toHaveLength(1));
    expect(fake.callsOf('configureBotInstallation')[0]).toMatchObject({ capabilities: 1 | 8 });
  });

  it('shows the permission ceiling and disables capabilities the current access summary cannot grant', async () => {
    const { user } = setup(null, false, false, false);
    await screen.findByText(en['admin.bot.none']);
    expect(screen.getByText(en['admin.bot.capabilities.permissionCeiling'])).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: en['admin.bot.capability.roles'] })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: en['admin.bot.capability.music'] })).toHaveAccessibleDescription(
      /Requires Connect and Speak/);
    await user.keyboard('{Tab}');
  });

  it('sends the currently read revision and explains when another admin changed the installation', async () => {
    const initial = { ...ROW, state: 4 as const, revision: '11', capabilities: 0 };
    const { fake, user } = setup(initial);
    fake.handler = command => {
      if (command.m === 'getBotInstallation') return Promise.resolve(initial);
      if (command.m === 'getBotJoinRole') return Promise.resolve({ roleId: null, installationId: initial.id });
      if (command.m === 'stepUp') return Promise.resolve({ token: 'short-lived-step-up' });
      if (command.m === 'configureBotInstallation') return Promise.reject(refusal({ code: 'E_CONFLICT', status: 409 }));
      return Promise.resolve(command.m === 'getAFKSettings' ? { channelId: null, timeoutSeconds: 300 } : null);
    };
    await screen.findByText(en['admin.bot.status.disabled']);
    await user.click(screen.getByRole('checkbox', { name: en['admin.bot.capability.music'] }));
    await user.click(screen.getByRole('button', { name: en['admin.bot.enable'] }));
    await user.type(screen.getByLabelText(en['factorSettings.stepUp.password']), 'local-password');
    await user.click(screen.getByRole('button', { name: en['factorSettings.stepUp.confirm'] }));
    expect(await screen.findByRole('alert')).toHaveTextContent(en['admin.bot.error.conflict']);
    expect(fake.callsOf('configureBotInstallation')[0]).toMatchObject({ expectedRevision: '11', capabilities: 1 });
  });

  it('preserves approved capabilities when re-enabling a disabled installation', async () => {
    const initial = { ...ROW, state: 4 as const, revision: '21', capabilities: 1 | 8 };
    const { fake, user } = setup(initial);
    fake.handler = command => {
      if (command.m === 'getBotInstallation') return Promise.resolve(initial);
      if (command.m === 'getBotJoinRole') return Promise.resolve({ roleId: null, installationId: initial.id });
      if (command.m === 'stepUp') return Promise.resolve({ token: 'short-lived-step-up' });
      if (command.m === 'configureBotInstallation') return Promise.resolve({ ...initial, state: 0, revision: '22' });
      return Promise.resolve(command.m === 'getAFKSettings' ? { channelId: null, timeoutSeconds: 300 } : null);
    };
    await screen.findByText(en['admin.bot.status.disabled']);
    expect(screen.getByRole('checkbox', { name: en['admin.bot.capability.music'] })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: en['admin.bot.capability.announcements'] })).toBeChecked();
    await user.click(screen.getByRole('button', { name: en['admin.bot.enable'] }));
    await user.type(screen.getByLabelText(en['factorSettings.stepUp.password']), 'local-password');
    await user.click(screen.getByRole('button', { name: en['factorSettings.stepUp.confirm'] }));
    await waitFor(() => expect(fake.callsOf('configureBotInstallation')).toHaveLength(1));
    expect(fake.callsOf('configureBotInstallation')[0]).toMatchObject({ expectedRevision: '21', capabilities: 1 | 8 });
  });

  it('allows editing capabilities on a ready installation using its current revision', async () => {
    const initial = { ...ROW, state: 3 as const, revision: '30', capabilities: 1 | 8 };
    const { fake, user } = setup(initial);
    fake.handler = command => {
      if (command.m === 'getBotInstallation') return Promise.resolve(initial);
      if (command.m === 'getBotJoinRole') return Promise.resolve({ roleId: null, installationId: initial.id });
      if (command.m === 'stepUp') return Promise.resolve({ token: 'short-lived-step-up' });
      if (command.m === 'configureBotInstallation') return Promise.resolve({ ...initial, revision: '31', capabilities: 9 | 16 });
      return Promise.resolve(command.m === 'getAFKSettings' ? { channelId: null, timeoutSeconds: 300 } : null);
    };
    await screen.findByText(en['admin.bot.status.ready']);
    await user.click(screen.getByRole('button', { name: en['admin.bot.capabilities.edit'] }));
    expect(screen.getByRole('checkbox', { name: en['admin.bot.capability.music'] })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: en['admin.bot.capability.announcements'] })).toBeChecked();
    await user.click(screen.getByRole('checkbox', { name: en['admin.bot.capability.warnings'] }));
    await user.click(screen.getByRole('button', { name: en['admin.bot.capabilities.save'] }));
    await user.type(screen.getByLabelText(en['factorSettings.stepUp.password']), 'local-password');
    await user.click(screen.getByRole('button', { name: en['factorSettings.stepUp.confirm'] }));
    await waitFor(() => expect(fake.callsOf('configureBotInstallation')).toHaveLength(1));
    expect(fake.callsOf('configureBotInstallation')[0]).toMatchObject({ expectedRevision: '30', capabilities: 1 | 8 | 16 });
  });

  it('does not save an edit against a stale ready installation revision', async () => {
    const initial = { ...ROW, state: 3 as const, revision: '40', capabilities: 1 };
    const { fake, user } = setup(initial);
    fake.handler = command => {
      if (command.m === 'getBotInstallation') return Promise.resolve(initial);
      if (command.m === 'getBotJoinRole') return Promise.resolve({ roleId: null, installationId: initial.id });
      if (command.m === 'stepUp') return Promise.resolve({ token: 'short-lived-step-up' });
      if (command.m === 'configureBotInstallation') return Promise.reject(refusal({ code: 'E_CONFLICT', status: 409 }));
      return Promise.resolve(command.m === 'getAFKSettings' ? { channelId: null, timeoutSeconds: 300 } : null);
    };
    await screen.findByText(en['admin.bot.status.ready']);
    await user.click(screen.getByRole('button', { name: en['admin.bot.capabilities.edit'] }));
    await user.click(screen.getByRole('checkbox', { name: en['admin.bot.capability.welcome'] }));
    await user.click(screen.getByRole('button', { name: en['admin.bot.capabilities.save'] }));
    await user.type(screen.getByLabelText(en['factorSettings.stepUp.password']), 'local-password');
    await user.click(screen.getByRole('button', { name: en['factorSettings.stepUp.confirm'] }));
    expect(await screen.findByRole('alert')).toHaveTextContent(en['admin.bot.error.conflict']);
    expect(fake.callsOf('configureBotInstallation')[0]).toMatchObject({ expectedRevision: '40', capabilities: 3 });
  });

  it.each([
    [0, 'admin.bot.status.pending'], [1, 'admin.bot.status.pending'], [2, 'admin.bot.status.joining'],
    [3, 'admin.bot.status.ready'], [4, 'admin.bot.status.disabled'], [5, 'admin.bot.status.failed'],
  ] as const)('labels installation state %i plainly', async (state, key) => {
    const { user } = setup({ ...ROW, state });
    expect(await screen.findByRole('status')).toHaveTextContent(en[key]);
    await user.keyboard('{Tab}');
    expect(document.activeElement).toBeInstanceOf(HTMLElement);
  });

  it('disables the bot using the current revision and announces the returned state', async () => {
    const { fake, user, announce } = setup({ ...ROW, state: 3, revision: '8', userId: '77'.repeat(16) });
    expect(await screen.findByText(en['admin.bot.status.ready'])).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: en['admin.bot.disable'] }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(en['admin.bot.status.disabled']));
    expect(fake.callsOf('disableBotInstallation')).toEqual([expect.objectContaining({ m: 'disableBotInstallation',
      communityId: SERVER, expectedRevision: '8' })]);
    expect(announce).toHaveBeenCalledWith(en['admin.bot.disabledNotice']);
  });

  it('shows an honest error after a forbidden read', async () => {
    const { fake, user } = setup({ ...ROW, state: 3 });
    fake.handler = command => command.m === 'disableBotInstallation'
      ? Promise.reject(refusal({ code: 'E_FORBIDDEN', status: 403 })) : Promise.resolve(null);
    await screen.findByText(en['admin.bot.status.ready']);
    await user.click(screen.getByRole('button', { name: en['admin.bot.disable'] }));
    expect(await screen.findByRole('alert')).toHaveTextContent(en['admin.bot.error.forbidden']);
    expect(screen.getByRole('status')).toHaveTextContent(en['admin.bot.status.ready']);
  });

  it('keeps the enable control reachable by keyboard', async () => {
    const { user } = setup();
    await screen.findByText(en['admin.bot.none']);
    const button = screen.getByRole('button', { name: en['admin.bot.enable'] });
    button.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('dialog', { name: en['factorSettings.stepUp.title'] })).toBeInTheDocument();
  });

  it('does not offer a new install when the current installation could not be read', async () => {
    const { fake } = setup(null, true);
    expect(await screen.findByRole('alert')).toHaveTextContent(en['admin.bot.error.other'].replace('{code}', 'E_NETWORK'));
    expect(screen.getByRole('button', { name: en['admin.bot.enable'] })).toHaveAttribute('aria-disabled', 'true');
    expect(fake.callsOf('configureBotInstallation')).toHaveLength(0);
  });

  it('keeps the bot install control in the phone settings frame', async () => {
    setup(null, false, true);
    await screen.findByText(en['admin.bot.none']);
    expect(document.querySelector('.d-settings-frame')).toHaveAttribute('data-layout', 'phone');
    expect(screen.getByRole('button', { name: en['admin.bot.enable'] })).toBeVisible();
  });

  it('ignores a late A read after an in-place switch to B and only disables B after B loads', async () => {
    let resolveA!: (value: Installation) => void;
    let resolveB!: (value: Installation) => void;
    const readA = new Promise<Installation>(resolve => { resolveA = resolve; });
    const readB = new Promise<Installation>(resolve => { resolveB = resolve; });
    const communityB = 'c3'.repeat(16);
    const rowA: Installation = { ...ROW, communityId: SERVER, state: 3, revision: '4', userId: '44'.repeat(16) };
    const rowB: Installation = { ...ROW, communityId: communityB, state: 3, revision: '9', userId: '99'.repeat(16) };
    const fake = new FakeClient();
    fake.set('account', account());
    fake.set('factors', { owed: false, totp: null, passkeys: [], backupCodesLeft: 0, hasPassword: true });
    fake.set('communities', [{ id: SERVER, name: 'A', owner: ME.id }, { id: communityB, name: 'B', owner: ME.id }]);
    fake.set(`permissions:${SERVER}`, ACCESS);
    fake.set(`permissions:${communityB}`, ACCESS);
    fake.handler = command => {
      if (command.m === 'getBotInstallation') return command.communityId === SERVER ? readA : readB;
      if (command.m === 'disableBotInstallation') return Promise.resolve({ ...rowB, state: 4, revision: '10' });
      return Promise.resolve(null);
    };
    const announce = vi.fn();
    const user = userEvent.setup();
    const view = render(<div className="d-root"><CoreProvider client={fake}>
      <ServerSettings communityId={SERVER} tab="bot" onTab={vi.fn()} onClose={vi.fn()} announce={announce} />
    </CoreProvider></div>);
    await waitFor(() => expect(fake.callsOf('getBotInstallation')).toHaveLength(1));
    view.rerender(<div className="d-root"><CoreProvider client={fake}>
      <ServerSettings communityId={communityB} tab="bot" onTab={vi.fn()} onClose={vi.fn()} announce={announce} />
    </CoreProvider></div>);
    await waitFor(() => expect(fake.callsOf('getBotInstallation')).toHaveLength(2));
    await act(async () => { resolveA(rowA); await readA; });
    const staleDisable = screen.queryByRole('button', { name: en['admin.bot.disable'] });
    if (staleDisable !== null) await user.click(staleDisable);
    expect(fake.callsOf('disableBotInstallation')).toHaveLength(0);
    expect(screen.queryByRole('status')).toBeNull();

    await act(async () => { resolveB(rowB); await readB; });
    expect(await screen.findByRole('status')).toHaveTextContent(en['admin.bot.status.ready']);
    await user.click(screen.getByRole('button', { name: en['admin.bot.disable'] }));
    await waitFor(() => expect(fake.callsOf('disableBotInstallation')).toHaveLength(1));
    expect(fake.callsOf('disableBotInstallation')[0]).toMatchObject({ communityId: communityB, expectedRevision: '9' });
    expect(screen.getByRole('status')).toHaveTextContent(en['admin.bot.status.disabled']);
  });
});

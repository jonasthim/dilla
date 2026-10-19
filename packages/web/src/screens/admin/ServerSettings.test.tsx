import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CommunityAccess, MemberSummary } from '@dilla/client-core';
import { CoreProvider } from '../../core/context.tsx';
import { FakeClient, refusal } from '../../test/fake-client.ts';
import { account, ME } from '../../test/fixtures.ts';
import { expectNoAxeViolations } from '../../test/setup.ts';
import { en } from '../../strings/index.ts';
import { ServerSettings, type AdminTab } from './ServerSettings.tsx';

const SERVER = 'a1'.repeat(16);
const BOB = '28'.repeat(16);
const CAROL = '3c'.repeat(16);
const NAME = 'Björn';
const NFD = 'Björn';

export const FULL: CommunityAccess = { top: 100, owner: true, manageCommunity: true, manageChannels: true, kickMembers: true,
  banMembers: true, createInvite: true, manageRoles: true, loaded: true, overwritesLoaded: true, everyoneId: 'ab'.repeat(16) };
const NONE: CommunityAccess = { ...FULL, top: 0, owner: false, manageCommunity: false, manageChannels: false, kickMembers: false,
  banMembers: false, createInvite: false, manageRoles: false };

function setup(access: CommunityAccess | undefined, over: { name?: string; tab?: AdminTab; members?: MemberSummary[] | null } = {}) {
  const fake = new FakeClient();
  fake.set('account', account());
  fake.set('communities', [{ id: SERVER, name: over.name ?? NAME, owner: access?.owner === true ? ME.id : BOB }]);
  if (access !== undefined) fake.set(`permissions:${SERVER}`, access);
  if (over.members !== null) {
    fake.set(`members:${SERVER}`, over.members ?? [
      { userId: ME.id, username: 'ada', display: '', kind: 0, roleIds: [] },
      { userId: BOB, username: 'bob', display: 'Bob B', kind: 0, roleIds: [] },
      { userId: CAROL, username: 'carol', display: '', kind: 0, roleIds: [] },
    ]);
  }
  const onClose = vi.fn();
  const onTab = vi.fn();
  const announce = vi.fn();
  const user = userEvent.setup();
  const view = render(<div className="d-root"><CoreProvider client={fake}>
    <ServerSettings communityId={SERVER} tab={over.tab ?? 'overview'} onTab={onTab} onClose={onClose} announce={announce} />
  </CoreProvider></div>);
  return { fake, user, view, onClose, onTab, announce };
}
/** The pane beside the tab list: "delete server" is both a tab and a button, so a query for the button looks only here. */
const pane = () => within(document.querySelector<HTMLElement>('.d-settings-frame__body')!);
const navNames = () => within(screen.getByRole('navigation', { name: en['admin.nav'] })).queryAllByRole('button').map(b => b.textContent);

describe('ServerSettings tabs', () => {
  it('shows every tab to an owner, with the delete tab last', () => {
    setup(FULL);
    expect(navNames()).toEqual(['overview', 'channels', 'roles', 'invites', 'bans', 'delete server']);
  });
  it('shows the roles tab only with manageRoles, after channels', () => {
    setup({ ...NONE, manageChannels: true, manageRoles: true });
    expect(navNames()).toEqual(['channels', 'roles', 'leave server']);
  });
  it('shows no roles tab without manageRoles', () => {
    setup({ ...NONE, manageChannels: true });
    expect(navNames()).not.toContain('roles');
  });
  it('mounts the roles panel for the roles tab', () => {
    setup(FULL, { tab: 'roles' });
    expect(screen.getByRole('heading', { name: en['roles.title'] })).toBeInTheDocument();
  });
  it('shows only the tabs a person has the permission for; the danger tab is always there', () => {
    setup({ ...NONE, manageChannels: true, banMembers: true });
    expect(navNames()).toEqual(['channels', 'bans', 'leave server']);
  });
  it('shows overview for manageCommunity and invites for createInvite', () => {
    setup({ ...NONE, manageCommunity: true, createInvite: true });
    expect(navNames()).toEqual(['overview', 'invites', 'leave server']);
  });
  it('shows no tab as forbidden while the permissions are loading', () => {
    setup({ ...NONE, loaded: false });
    expect(navNames()).toEqual([]);
    expect(screen.getByRole('dialog', { name: en['admin.title'] })).toBeInTheDocument();
  });
  it('opens the first permitted tab when the asked-for tab is not allowed', () => {
    setup(NONE, { tab: 'overview' });
    expect(screen.getByRole('heading', { name: 'leave server', level: 2 })).toBeInTheDocument();
  });
  it('asks to switch tabs through onTab', async () => {
    const { user, onTab } = setup(FULL);
    await user.click(screen.getByRole('button', { name: 'bans' }));
    expect(onTab).toHaveBeenCalledWith('bans');
  });
  it('closes through onClose', async () => {
    const { user, onClose } = setup(FULL);
    await user.click(screen.getByRole('button', { name: en['admin.cancel'] }));
    expect(onClose).toHaveBeenCalled();
  });
  it('has no axe violations', async () => {
    const { view } = setup(FULL);
    await expectNoAxeViolations(view.container);
  });
});

describe('the overview section', () => {
  const field = () => screen.getByRole('textbox', { name: en['admin.overview.name'] });
  const rename = async (user: ReturnType<typeof userEvent.setup>, to: string) => {
    await user.clear(field());
    if (to !== '') await user.type(field(), to);
    await user.click(screen.getByRole('button', { name: en['admin.overview.save'] }));
  };
  it('loads unfiltered AFK settings for a manager who cannot view the destination', async () => {
    const { fake, user } = setup({ ...NONE, manageCommunity: true });
    const hidden = 'fe'.repeat(16);
    fake.handler = command => Promise.resolve(command.m === 'getAFKSettings'
      ? { channelId: hidden, timeoutSeconds: 900 } : null);
    fake.publish(`afk:${SERVER}`, { channelId: null, timeoutSeconds: 900, occupants: [] });
    const destination = screen.getByRole('combobox', { name: en['admin.afk.channel'] });
    await waitFor(() => expect(destination).toHaveValue(hidden));
    expect(screen.getByRole('option', { name: en['admin.afk.restricted'] })).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: en['admin.afk.timeout'] }), '1800');
    await user.click(screen.getByRole('button', { name: en['admin.afk.save'] }));
    expect(fake.callsOf('setAFK')).toEqual([{ m: 'setAFK', communityId: SERVER, channelId: hidden, timeoutSeconds: 1800 }]);
  });
  it('renames the server with the trimmed name and announces it', async () => {
    const { fake, user, announce } = setup(FULL);
    await rename(user, '  Midgard ');
    await waitFor(() => expect(announce).toHaveBeenCalledWith(en['admin.overview.saved']));
    expect(fake.callsOf('renameCommunity')).toEqual([{ m: 'renameCommunity', communityId: SERVER, name: 'Midgard' }]);
  });
  it('says a conflicting change (409) with the conflict copy', async () => {
    const { fake, user } = setup(FULL);
    fake.handler = () => Promise.reject(refusal({ code: 'E_INVALID_REQUEST', status: 409 }));
    await rename(user, 'Midgard');
    expect(await screen.findByText(en['admin.overview.error.conflict'])).toBeInTheDocument();
  });
  it('says a refusal by its copy, and a blank name without asking the server', async () => {
    const { fake, user } = setup(FULL);
    fake.handler = () => Promise.reject(refusal({ code: 'E_FORBIDDEN', status: 403 }));
    await rename(user, 'Midgard');
    expect(await screen.findByText(en['admin.overview.error.forbidden'])).toBeInTheDocument();
    fake.calls.length = 0;
    await rename(user, '');
    expect(await screen.findByText(en['admin.overview.error.empty'])).toBeInTheDocument();
    expect(fake.calls).toEqual([]);
  });
  it('shows a code for any other failure', async () => {
    const { fake, user } = setup(FULL);
    fake.handler = () => Promise.reject(refusal({ code: 'E_NETWORK' }));
    await rename(user, 'Midgard');
    expect(await screen.findByText('Could not save (E_NETWORK). Try again.')).toBeInTheDocument();
  });
});

describe('the danger section', () => {
  const open = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
    await user.click(pane().getByRole('button', { name }));
    return screen.findByRole('dialog', { name: new RegExp(name === 'hand over server' ? 'Hand' : name === 'leave server' ? 'Leave' : 'Delete') });
  };
  it('tells the owner why they cannot leave, and offers delete and hand over', () => {
    setup(FULL, { tab: 'danger' });
    expect(screen.getByText(`You own ${NAME}, so you cannot leave it. Hand it to another member or delete it.`)).toBeInTheDocument();
    expect(pane().getByRole('button', { name: 'delete server' })).toBeInTheDocument();
    expect(pane().getByRole('button', { name: 'hand over server' })).toBeInTheDocument();
    expect(pane().queryByRole('button', { name: 'leave server' })).toBeNull();
  });
  it('lets a non-owner leave through a confirm, then closes', async () => {
    const { fake, user, onClose, announce } = setup(NONE, { tab: 'danger' });
    expect(screen.queryByText(/so you cannot leave it/)).toBeNull();
    const dialog = await open(user, 'leave server');
    await user.click(within(dialog).getByRole('button', { name: en['admin.leave.confirm'] }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(fake.callsOf('leaveCommunity')).toEqual([{ m: 'leaveCommunity', communityId: SERVER }]);
    expect(announce).toHaveBeenCalledWith(`You left ${NAME}.`);
  });
  it('keeps the leave confirm open with a coded refusal', async () => {
    const { fake, user, onClose } = setup(NONE, { tab: 'danger' });
    fake.handler = () => Promise.reject(refusal({ code: 'E_NETWORK' }));
    const dialog = await open(user, 'leave server');
    await user.click(within(dialog).getByRole('button', { name: en['admin.leave.confirm'] }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Could not leave (E_NETWORK). Try again.');
    expect(onClose).not.toHaveBeenCalled();
  });
  it('enables delete only when the typed name equals the server name under NFC (NFD "Bjorn" matches)', async () => {
    const { fake, user, onClose } = setup(FULL, { tab: 'danger' });
    const dialog = await open(user, 'delete server');
    const confirm = within(dialog).getByRole('button', { name: en['admin.delete.confirm'] });
    expect(confirm).toBeDisabled();
    const typed = within(dialog).getByRole('textbox', { name: en['admin.delete.confirmName'] });
    await user.type(typed, 'Bjorn');
    expect(confirm).toBeDisabled();
    expect(within(dialog).getByText(en['admin.delete.mismatch'])).toBeInTheDocument();
    await user.clear(typed);
    await user.type(typed, ` ${NFD} `);
    expect(NFD).not.toBe(NAME);
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(fake.callsOf('deleteCommunity')).toEqual([{ m: 'deleteCommunity', communityId: SERVER }]);
  });
  it('says a delete refusal by its copy and stays open', async () => {
    const { fake, user } = setup(FULL, { tab: 'danger' });
    fake.handler = () => Promise.reject(refusal({ code: 'E_FORBIDDEN', status: 403 }));
    const dialog = await open(user, 'delete server');
    await user.type(within(dialog).getByRole('textbox', { name: en['admin.delete.confirmName'] }), NAME);
    await user.click(within(dialog).getByRole('button', { name: en['admin.delete.confirm'] }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(en['admin.delete.error.forbidden']);
  });
  it('hands over to the chosen member (other members only), after the typed name', async () => {
    const { fake, user, announce } = setup(FULL, { tab: 'danger' });
    const dialog = await open(user, 'hand over server');
    const select = within(dialog).getByRole('combobox', { name: en['admin.transfer.member'] });
    expect(within(select).getAllByRole('option').map(o => o.textContent)).toEqual(['Bob B', 'carol']);
    await user.selectOptions(select, 'carol');
    const confirm = within(dialog).getByRole('button', { name: en['admin.transfer.confirm'] });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox', { name: en['admin.transfer.confirmName'] }), NFD);
    await user.click(confirm);
    await waitFor(() => expect(fake.callsOf('transferOwnership')).toEqual([{ m: 'transferOwnership', communityId: SERVER, userId: CAROL }]));
    await waitFor(() => expect(announce).toHaveBeenCalledWith(`carol now owns ${NAME}.`));
  });
  it('says a member who left (404) is gone', async () => {
    const { fake, user } = setup(FULL, { tab: 'danger' });
    fake.handler = () => Promise.reject(refusal({ code: 'E_NOT_FOUND', status: 404 }));
    const dialog = await open(user, 'hand over server');
    await user.type(within(dialog).getByRole('textbox', { name: en['admin.transfer.confirmName'] }), NAME);
    await user.click(within(dialog).getByRole('button', { name: en['admin.transfer.confirm'] }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(`That member is no longer in ${NAME}. Choose another.`);
    expect(fake.callsOf('transferOwnership')[0]?.userId).toBe(BOB);
  });
  it('says there is no one to hand over to', () => {
    const { fake } = setup(FULL, { tab: 'danger' });
    fake.publish(`members:${SERVER}`, [{ userId: ME.id, username: 'ada', display: '', kind: 0, roleIds: [] }]);
    expect(screen.getByText(en['admin.transfer.none'])).toBeInTheDocument();
    expect(pane().queryByRole('button', { name: 'hand over server' })).toBeNull();
  });
});

describe('fix round 1: loading, closing, minors', () => {
  it('says the settings are loading, with text, while the permissions are read', () => {
    setup({ ...NONE, loaded: false });
    expect(screen.getByText(en['admin.loading'])).toBeInTheDocument();
  });
  it('keeps no status region of its own: the announcer it was given says it', () => {
    setup(FULL);
    expect(document.querySelector('.d-settings-frame [role="status"]')).toBeNull();
  });
  it.each([
    ['leave', NONE, 'leave server', 'Leave', en['admin.leave.confirm'], `You left ${NAME}.`],
    ['delete', FULL, 'delete server', 'Delete', en['admin.delete.confirm'], `${NAME} was deleted.`],
  ] as const)('%s: a community dropped before the command resolves still announces and closes', async (_k, access, button, title, confirm, message) => {
    const { fake, user, onClose, announce } = setup(access, { tab: 'danger' });
    fake.handler = () => { fake.publish('communities', []); return Promise.resolve(null); };
    await user.click(pane().getByRole('button', { name: button }));
    const dialog = await screen.findByRole('dialog', { name: new RegExp(title) });
    const typed = within(dialog).queryByRole('textbox');
    if (typed !== null) await user.type(typed, NAME);
    await user.click(within(dialog).getByRole('button', { name: confirm }));
    await waitFor(() => expect(announce).toHaveBeenCalledWith(message));
    expect(onClose).toHaveBeenCalled();
    // The frame is closed through its own close path (which hands focus back), not torn down: the last known server stays.
    const frame = document.querySelector('dialog.d-settings-frame');
    expect(frame).not.toBeNull();
    expect(frame).not.toHaveAttribute('open');
  });
  it('does not say there is no one to hand over to before the members are read', () => {
    setup(FULL, { tab: 'danger', members: null });
    expect(screen.queryByText(en['admin.transfer.none'])).toBeNull();
  });
  it('leaves bots out of the hand over list: the server refuses them', async () => {
    const { user } = setup(FULL, { tab: 'danger', members: [
      { userId: ME.id, username: 'ada', display: '', kind: 0, roleIds: [] },
      { userId: BOB, username: 'robo', display: '', kind: 1, roleIds: [] },
      { userId: CAROL, username: 'carol', display: '', kind: 0, roleIds: [] },
    ] });
    await user.click(pane().getByRole('button', { name: 'hand over server' }));
    const dialog = await screen.findByRole('dialog', { name: /Hand/ });
    expect(within(within(dialog).getByRole('combobox')).getAllByRole('option').map(o => o.textContent)).toEqual(['carol']);
  });
  it('says there is no one when the only other member is a bot', () => {
    setup(FULL, { tab: 'danger', members: [
      { userId: ME.id, username: 'ada', display: '', kind: 0, roleIds: [] },
      { userId: BOB, username: 'robo', display: '', kind: 1, roleIds: [] },
    ] });
    expect(screen.getByText(en['admin.transfer.none'])).toBeInTheDocument();
  });
  it('does not overwrite a name being typed when the server is renamed elsewhere, but follows when not typing', async () => {
    const { fake, user } = setup(FULL);
    const field = screen.getByRole('textbox', { name: en['admin.overview.name'] });
    fake.publish('communities', [{ id: SERVER, name: 'Elsewhere', owner: ME.id }]);
    expect(field).toHaveValue('Elsewhere');
    await user.type(field, ' mine');
    fake.publish('communities', [{ id: SERVER, name: 'Again', owner: ME.id }]);
    expect(field).toHaveValue('Elsewhere mine');
  });
});

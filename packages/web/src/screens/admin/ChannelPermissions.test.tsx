import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PERM, type ChannelSummary, type CommunityAccess, type MemberSummary, type OverwriteSummary, type RoleSummary } from '@dilla/client-core';
import { CoreProvider } from '../../core/context.tsx';
import { FakeClient, refusal } from '../../test/fake-client.ts';
import { account, ME } from '../../test/fixtures.ts';
import { expectNoAxeViolations } from '../../test/setup.ts';
import { ChannelPermissions } from './ChannelPermissions.tsx';

const SERVER = 'a1'.repeat(16);
const CH = 'c1'.repeat(16);
const EVERYONE = 'e0'.repeat(16);
const PLAYERS = 'b2'.repeat(16);
const MODS = 'b1'.repeat(16);
const COUNCIL = 'b3'.repeat(16);
const BOB = '28'.repeat(16);
const OWNER = 'ee'.repeat(16);

const role = (id: string, name: string, position: number, allow = 0): RoleSummary =>
  ({ id, name, color: 0, position, hoist: false, mentionable: false, allow, deny: 0, members: 0 });
const BASE = PERM.viewChannel | PERM.sendMessages | PERM.attachFiles | PERM.addReactions | PERM.readHistory;
const ROLES = [role(EVERYONE, '@everyone', 0, BASE), role(PLAYERS, 'Players', 2), role(MODS, 'Moderators', 5, PERM.pinMessages | PERM.manageRoles),
  role(COUNCIL, 'Council', 9)];
const MEMBERS: MemberSummary[] = [
  { userId: ME.id, username: 'ada', display: '', kind: 0, roleIds: [MODS] },
  { userId: BOB, username: 'bob', display: 'Bob', kind: 0, roleIds: [PLAYERS] },
];
const ACCESS: CommunityAccess = { top: 5, owner: false, manageCommunity: false, manageChannels: true, kickMembers: false, banMembers: false,
  createInvite: false, manageRoles: true, loaded: true, everyoneId: EVERYONE, overwritesLoaded: true };
const CHANNEL: ChannelSummary = { id: CH, communityId: SERVER, kind: 0, mode: 0, name: 'lobby', topic: '', parentId: null, position: 0, group: 'active' };
const ow = (kind: 0 | 1, targetId: string, allow: number, deny: number): OverwriteSummary => ({ kind, targetId, allow, deny });

function setup(entries: OverwriteSummary[] = [], access: Partial<CommunityAccess> = {}) {
  const fake = new FakeClient();
  fake.set('account', account());
  fake.set('communities', [{ id: SERVER, name: 'Midgard', owner: OWNER }]);
  fake.set(`channels:${SERVER}`, [CHANNEL]);
  fake.set(`members:${SERVER}`, MEMBERS);
  fake.set(`roles:${SERVER}`, ROLES);
  fake.set(`permissions:${SERVER}`, { ...ACCESS, ...access });
  fake.set(`overwrites:${SERVER}`, entries.length === 0 ? {} : { [CH]: entries });
  const announce = vi.fn();
  const user = userEvent.setup();
  const view = render(<div className="d-root"><CoreProvider client={fake}>
    <ChannelPermissions channelId={CH} communityId={SERVER} announce={announce} />
  </CoreProvider></div>);
  return { fake, user, view, announce };
}
const toggle = () => screen.getByRole('switch', { name: 'private channel' });
const disclosure = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });

describe('the channel permissions section', () => {
  it('asks before making the channel private, and sends setChannelPrivate(true)', async () => {
    const { fake, user } = setup();
    fake.handler = c => {
      if (c.m === 'setChannelPrivate') fake.set(`overwrites:${SERVER}`, { [CH]: [ow(0, EVERYONE, 0, PERM.viewChannel)] });
      return Promise.resolve(null);
    };
    expect(toggle()).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle());
    const dialog = screen.getByRole('dialog', { name: 'Make #lobby private?' });
    expect(dialog).toHaveTextContent('People who are not given access leave the channel now.');
    await user.click(within(dialog).getByRole('button', { name: 'Make private' }));
    await waitFor(() => expect(fake.callsOf('setChannelPrivate')).toEqual([{ m: 'setChannelPrivate', channelId: CH, private: true }]));
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'true'));
  });
  it('asks before opening a private channel to everyone, and sends setChannelPrivate(false)', async () => {
    const { fake, user } = setup([ow(0, EVERYONE, 0, PERM.viewChannel)]);
    expect(toggle()).toHaveAttribute('aria-checked', 'true');
    await user.click(toggle());
    const dialog = screen.getByRole('dialog', { name: 'Open #lobby to everyone?' });
    expect(dialog).toHaveTextContent('Everyone in Midgard joins the channel.');
    await user.click(within(dialog).getByRole('button', { name: 'Open to everyone' }));
    await waitFor(() => expect(fake.callsOf('setChannelPrivate')).toEqual([{ m: 'setChannelPrivate', channelId: CH, private: false }]));
  });
  it('maps the would-lose refusal to its copy, keeps confirm enabled, and returns focus to the toggle on cancel', async () => {
    const { fake, user } = setup();
    fake.handler = () => Promise.reject(refusal({ code: 'E_BAD_INPUT' }));
    await user.click(toggle());
    await user.click(screen.getByRole('button', { name: 'Make private' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('That change would hide the channel from you.');
    expect(screen.getByRole('button', { name: 'Make private' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(toggle()).toHaveFocus());
  });
  it('maps 403 and 404 refusals of the toggle', async () => {
    const { fake, user } = setup();
    fake.handler = () => Promise.reject(refusal({ code: 'E_FORBIDDEN', status: 403 }));
    await user.click(toggle());
    await user.click(screen.getByRole('button', { name: 'Make private' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You cannot change this.');
    fake.handler = () => Promise.reject(refusal({ code: 'E_NOT_FOUND', status: 404 }));
    await user.click(screen.getByRole('button', { name: 'Make private' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('This channel no longer exists.'));
  });
  it('maps a 400 of the instance to the same copy', async () => {
    const { fake, user } = setup([ow(0, PLAYERS, 0, 0)]);
    fake.handler = () => Promise.reject(refusal({ code: 'E_INVALID_REQUEST', status: 400 }));
    await user.click(disclosure('Players'));
    await user.click(within(screen.getByRole('radiogroup', { name: 'send messages' })).getByRole('radio', { name: 'deny' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That change would hide the channel from you.');
  });
  it('shows the gate as unknown, with no private toggle, while the overwrites are not loaded', () => {
    setup([], { overwritesLoaded: false });
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Loading roles…');
    expect(screen.queryByText('No role or person has settings of their own here yet.')).toBeNull();
  });
  it('lists @everyone first, then roles highest first, then members', () => {
    setup([ow(1, BOB, 0, PERM.sendMessages), ow(0, PLAYERS, PERM.pinMessages, 0), ow(0, COUNCIL, 0, PERM.attachFiles), ow(0, EVERYONE, 0, PERM.viewChannel)]);
    const names = within(screen.getByRole('list', { name: 'Who has settings here' })).getAllByRole('button', { name: /^(@everyone|Council|Players|Bob)/ })
      .map(b => b.textContent);
    expect(names).toEqual(['@everyone', 'Council', 'Players', 'Bob member']);
  });
  it('says there are none with no entries', () => {
    setup();
    expect(screen.getByText('No role or person has settings of their own here yet.')).toBeInTheDocument();
  });
  it('shows only the channel bits in the tri grid, never the server-wide ones', async () => {
    const { user } = setup([ow(0, PLAYERS, 0, 0)]);
    await user.click(disclosure('Players'));
    expect(disclosure('Players')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('radiogroup', { name: 'view channels' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'send messages' })).toBeInTheDocument();
    for (const hidden of ['kick members', 'ban members', 'manage roles', 'manage server', 'administrator', 'view audit log', 'manage nicknames']) {
      expect(screen.queryByRole('radiogroup', { name: hidden })).toBeNull();
    }
  });
  it('sends setOverwrite with the changed bit and announces it', async () => {
    const { fake, user, announce } = setup([ow(0, PLAYERS, PERM.pinMessages, 0)]);
    await user.click(disclosure('Players'));
    expect(within(screen.getByRole('radiogroup', { name: 'pin messages' })).getByRole('radio', { name: 'allow' })).toHaveAttribute('aria-checked', 'true');
    await user.click(within(screen.getByRole('radiogroup', { name: 'send messages' })).getByRole('radio', { name: 'deny' }));
    await waitFor(() => expect(fake.callsOf('setOverwrite')).toEqual([
      { m: 'setOverwrite', channelId: CH, kind: 0, targetId: PLAYERS, allow: PERM.pinMessages, deny: PERM.sendMessages }]));
    await waitFor(() => expect(announce).toHaveBeenCalledWith('Permissions of #lobby saved.'));
  });
  it('removes an entry with setOverwrite 0/0, and has no remove for @everyone', async () => {
    const { fake, user } = setup([ow(0, EVERYONE, 0, PERM.viewChannel), ow(0, PLAYERS, PERM.pinMessages, 0)]);
    fake.handler = c => {
      if (c.m === 'setOverwrite') fake.set(`overwrites:${SERVER}`, { [CH]: [ow(0, EVERYONE, 0, PERM.viewChannel)] });
      return Promise.resolve(null);
    };
    expect(screen.getAllByRole('button', { name: /^remove the settings for/ })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'remove the settings for Players' }));
    await waitFor(() => expect(fake.callsOf('setOverwrite')).toEqual([{ m: 'setOverwrite', channelId: CH, kind: 0, targetId: PLAYERS, allow: 0, deny: 0 }]));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Players/ })).toBeNull());
  });
  it('disables the rows of a role at or above mine, and bits I lack, with the forbidden reason', async () => {
    const { user } = setup([ow(0, COUNCIL, 0, 0), ow(0, PLAYERS, 0, 0)]);
    await user.click(disclosure('Council'));
    const sendGroup = screen.getByRole('radiogroup', { name: 'send messages' });
    expect(sendGroup).toHaveAttribute('aria-disabled', 'true');
    expect(sendGroup).toHaveAccessibleDescription(expect.stringContaining('You cannot change this.'));
    await user.click(disclosure('Council'));
    await user.click(disclosure('Players'));
    expect(screen.getByRole('radiogroup', { name: 'send messages' })).not.toHaveAttribute('aria-disabled');
    // I do not hold manage messages here, so I cannot set it.
    expect(screen.getByRole('radiogroup', { name: 'manage messages' })).toHaveAttribute('aria-disabled', 'true');
  });
  it('offers the roles and people below me with no entry, and sends nothing until a value changes', async () => {
    const { fake, user } = setup([ow(0, PLAYERS, 0, 0)]);
    const select = screen.getByRole('combobox', { name: 'Role or person' });
    expect(within(select).getAllByRole('option').map(o => o.textContent)).toEqual(['@everyone', 'Bob']);
    await user.selectOptions(select, 'Bob');
    await user.click(screen.getByRole('button', { name: 'add a role or person' }));
    expect(disclosure('Bob')).toBeInTheDocument();
    expect(fake.callsOf('setOverwrite')).toEqual([]);
  });
  it('maps an unknown failure to its code', async () => {
    const { fake, user } = setup([ow(0, PLAYERS, 0, 0)]);
    fake.handler = () => Promise.reject(refusal({ code: 'E_NETWORK' }));
    await user.click(disclosure('Players'));
    await user.click(within(screen.getByRole('radiogroup', { name: 'send messages' })).getByRole('radio', { name: 'allow' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save the permissions (E_NETWORK). Try again.');
  });
  it('has no serious axe violations with an entry open', async () => {
    const { view, user } = setup([ow(0, EVERYONE, 0, PERM.viewChannel), ow(0, PLAYERS, PERM.pinMessages, 0)]);
    await user.click(disclosure('Players'));
    await expectNoAxeViolations(view.container);
  });
});

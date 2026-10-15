// W-Shell: the shell wires the channel bits, roles, lost access and the role flows (web3.5, flow 09).
import { afterEach, describe, it, expect } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PERM, type ChannelSummary, type CommunityAccess, type MemberSummary, type RoleSummary } from '@dilla/client-core';
import { CoreProvider } from '../core/context.tsx';
import { FakeClient } from '../test/fake-client.ts';
import { account, ME } from '../test/fixtures.ts';
import { Shell } from './Shell.tsx';

const A = 'a1'.repeat(16);
const GEN = 'c3'.repeat(16);
const LOBBY = 'd4'.repeat(16);
const OWNER = 'ee'.repeat(16);
const BOB = '28'.repeat(16);
const EVERYONE = 'ab'.repeat(16);
const GAME = '71'.repeat(16);
const ch = (id: string, name: string, position: number): ChannelSummary =>
  ({ id, communityId: A, kind: 0, mode: 0, name, topic: '', parentId: null, position, group: 'none' });
const role = (id: string, name: string, position: number, allow = 0): RoleSummary =>
  ({ id, name, color: 0, position, hoist: false, mentionable: true, allow, deny: 0, members: 0 });
const BASE = PERM.viewChannel | PERM.sendMessages | PERM.readHistory;
const ROLES = [role(EVERYONE, '@everyone', 0, BASE), role(GAME, 'Game Night', 3)];
const MEMBERS: MemberSummary[] = [
  { userId: ME.id, username: 'ada', display: 'Ada L', kind: 0, roleIds: [] },
  { userId: BOB, username: 'bob', display: 'Bob', kind: 0, roleIds: [] },
];
const access = (over: Partial<CommunityAccess> = {}): CommunityAccess => ({ top: 5, owner: false, manageCommunity: false, manageChannels: false,
  kickMembers: false, banMembers: false, createInvite: false, manageRoles: false, loaded: true, overwritesLoaded: true, everyoneId: EVERYONE, ...over });

function setup(opts: { acc?: Partial<CommunityAccess>; base?: number; overwrites?: Record<string, { kind: 0 | 1; targetId: string; allow: number; deny: number }[]> } = {}) {
  window.history.replaceState(null, '', `/c/${A}/${GEN}`);
  const fake = new FakeClient();
  fake.set('account', account());
  fake.set('connection', { status: 'online', generation: '7' });
  fake.set('communities', [{ id: A, name: 'Midgard', owner: OWNER }]);
  fake.set(`channels:${A}`, [ch(GEN, 'general', 0), ch(LOBBY, 'lobby', 1)]);
  fake.set(`members:${A}`, MEMBERS);
  fake.set(`roles:${A}`, opts.base === undefined ? ROLES : [role(EVERYONE, '@everyone', 0, opts.base), ROLES[1]]);
  fake.set(`overwrites:${A}`, opts.overwrites ?? {});
  fake.set(`permissions:${A}`, access(opts.acc));
  fake.set('removals', []);
  fake.set(`timeline:${GEN}`, { channelId: GEN, group: 'active', items: [], hasEarlier: false });
  fake.set(`timeline:${LOBBY}`, { channelId: LOBBY, group: 'active', items: [], hasEarlier: false });
  const user = userEvent.setup();
  render(<div className="d-root"><CoreProvider client={fake}><Shell /></CoreProvider></div>);
  return { fake, user };
}
const box = () => screen.getByRole('textbox', { name: 'message #general' });
const announcer = () => screen.getByTestId('shell-announcer');
const wide = () => {
  window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, onchange: null, dispatchEvent: () => false }));
};
afterEach(() => { Reflect.deleteProperty(window, 'matchMedia'); });

describe('the shell wires the channel bits', () => {
  it('offers no @everyone without the mentionEveryone bit', async () => {
    const { user } = setup();
    await user.type(box(), '@eve');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
  it('offers @everyone with the bit, and a role from the roles slice', async () => {
    const { user } = setup({ base: BASE | PERM.mentionEveryone });
    await user.type(box(), '@eve');
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(1);
    await user.clear(box());
    await user.type(box(), '@ga');
    expect(within(screen.getByRole('listbox')).getByRole('option')).toHaveTextContent('Game Night');
  });
});

describe('a channel I may not send in', () => {
  it('keeps the composer, the draft and the focus, and announces it once', async () => {
    const { fake, user } = setup();
    await user.type(box(), 'half a thought');
    expect(box()).toHaveFocus();
    act(() => { fake.publish(`overwrites:${A}`, { [GEN]: [{ kind: 0, targetId: EVERYONE, allow: 0, deny: PERM.sendMessages }] }); });
    expect(box()).toHaveValue('half a thought');
    expect(box()).toHaveFocus();
    expect(box()).toHaveAttribute('aria-disabled', 'true');
    expect(await screen.findByText('You cannot send messages in #general.', { selector: 'p[role="status"]' })).toBeInTheDocument();
    expect(announcer()).toHaveTextContent('You cannot send messages in #general.');
    act(() => { fake.publish(`channels:${A}`, [ch(GEN, 'general', 0), ch(LOBBY, 'lobby', 1)]); });
    expect(announcer()).toHaveTextContent('You cannot send messages in #general.');
  });
});

describe('the channel edit dialog', () => {
  it('speaks its saves through the shell announcer', async () => {
    const { fake, user } = setup({ acc: { manageChannels: true, manageRoles: true }, overwrites: { [GEN]: [{ kind: 0, targetId: GAME, allow: 0, deny: 0 }] } });
    fake.handler = () => Promise.resolve(null);
    await user.click(screen.getByRole('button', { name: 'edit channel' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit #general' });
    await user.click(within(dialog).getByRole('button', { name: /^Game Night/ }));
    await user.click(within(within(dialog).getByRole('radiogroup', { name: 'send messages' })).getByRole('radio', { name: 'deny' }));
    expect(await screen.findByText('Permissions of #general saved.', { selector: '[data-testid="shell-announcer"]' })).toBeInTheDocument();
  });
});

describe('the pins panel', () => {
  it('states the pin rule once the bits are known', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'pinned' }));
    expect(screen.getByText('A pin shows while the person who pinned it may pin in this channel.')).toBeInTheDocument();
  });
});

describe('lost access', () => {
  it('announces, moves to the first listed channel, keeps the draft and closes the channel dialog', async () => {
    const { fake, user } = setup({ acc: { manageChannels: true } });
    await user.type(box(), 'still here');
    await user.click(screen.getByRole('button', { name: 'edit channel' }));
    expect(screen.getByRole('dialog', { name: 'Edit #general' })).toBeInTheDocument();
    act(() => { fake.publish(`channels:${A}`, [ch(LOBBY, 'lobby', 1)]); });
    expect(await screen.findByText('You can no longer see #general.', { selector: '[data-testid="shell-announcer"]' })).toBeInTheDocument();
    expect(window.location.pathname).toBe(`/c/${A}/${LOBBY}`);
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => { fake.publish(`channels:${A}`, [ch(GEN, 'general', 0), ch(LOBBY, 'lobby', 1)]); });
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: /general/ }));
    expect(box()).toHaveValue('still here');
  });
  it('says nothing when the whole server leaves the list', () => {
    const { fake } = setup();
    act(() => { fake.publish('communities', []); });
    expect(announcer()).toHaveTextContent('');
  });
});

describe('the role flows', () => {
  it('opens the assign dialog from the member menu; closing returns focus to the menu trigger', async () => {
    wide();
    const { user } = setup({ acc: { manageRoles: true } });
    const trigger = screen.getByRole('button', { name: 'actions for Bob' });
    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: 'roles' }));
    const dialog = await screen.findByRole('dialog', { name: 'Roles of Bob' });
    await user.keyboard('{Escape}');
    expect(dialog).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'actions for Bob' })).toHaveFocus();
  });
  it('in the narrow drawer, closing the assign dialog returns to the menu trigger and closing the drawer returns to the toggle', async () => {
    window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined,
      addListener: () => undefined, removeListener: () => undefined, onchange: null, dispatchEvent: () => false }));
    const { user } = setup({ acc: { manageRoles: true } });
    await user.click(screen.getByRole('button', { name: /^members/ }));
    await user.click(screen.getByRole('button', { name: 'actions for Bob' }));
    await user.click(screen.getByRole('menuitem', { name: 'roles' }));
    await screen.findByRole('dialog', { name: 'Roles of Bob' });
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'actions for Bob' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'close members' }));
    expect(screen.getByRole('button', { name: /^members/ })).toHaveFocus();
  });
  it('the roles tab of server settings routes with manageRoles', async () => {
    const { user } = setup({ acc: { manageRoles: true } });
    await user.click(screen.getByRole('button', { name: 'server settings' }));
    const dialog = screen.getByRole('dialog', { name: /settings/i });
    await user.click(within(dialog).getByRole('button', { name: 'roles' }));
    expect(within(dialog).getByRole('button', { name: 'roles', current: 'page' })).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: 'Roles' })).toBeInTheDocument();
  });
});

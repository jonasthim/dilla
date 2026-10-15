import { afterEach, describe, it, expect } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChannelSummary, CommunityAccess, MemberSummary } from '@dilla/client-core';
import { CoreProvider } from '../core/context.tsx';
import { FakeClient } from '../test/fake-client.ts';
import { account, ME } from '../test/fixtures.ts';
import { Shell } from './Shell.tsx';

const A = 'a1'.repeat(16);
const B = 'b2'.repeat(16);
const GEN = 'c3'.repeat(16);
const OTHER = 'ee'.repeat(16);
const CHANNELS: ChannelSummary[] = [
  { id: GEN, communityId: A, kind: 0, mode: 0, name: 'general', topic: '', parentId: null, position: 0, group: 'none' },
];
const MEMBERS: MemberSummary[] = [{ userId: ME.id, username: 'ada', display: 'Ada L', kind: 0, roleIds: [] }];
const EVERYONE = 'ab'.repeat(16);
const access = (over: Partial<CommunityAccess> = {}): CommunityAccess => ({ top: 0, owner: false, manageCommunity: false, manageChannels: false,
  kickMembers: false, banMembers: false, createInvite: true, manageRoles: false, loaded: true, overwritesLoaded: true, everyoneId: EVERYONE, ...over });

const VOICE = 'e5'.repeat(16);
const GEN_B = 'd4'.repeat(16);

function setup(owner = OTHER, route = `/c/${A}/${GEN}`, channels = CHANNELS) {
  window.history.replaceState(null, '', route);
  const fake = new FakeClient();
  fake.set('account', account());
  fake.set('connection', { status: 'online', generation: '7' });
  fake.set('communities', [{ id: A, name: 'Midgard', owner }, { id: B, name: 'Valhalla', owner: OTHER }]);
  fake.set(`channels:${A}`, channels);
  fake.set(`channels:${B}`, [{ ...CHANNELS[0], id: GEN_B, communityId: B }]);
  fake.set(`members:${A}`, MEMBERS);
  fake.set('removals', []);
  const user = userEvent.setup();
  render(<div className="d-root"><CoreProvider client={fake}><Shell /></CoreProvider></div>);
  return { fake, user };
}

afterEach(() => { Reflect.deleteProperty(window, 'matchMedia'); });
const wide = () => {
  window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, onchange: null, dispatchEvent: () => false }));
};

describe('Shell, server admin and member list (flow 08)', () => {
  it('the members toggle opens and closes the member pane', async () => {
    const { user } = setup();
    const toggle = screen.getByRole('button', { name: /members/ });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('complementary')).toBeNull();
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('complementary', { name: 'members of Midgard' })).toBeInTheDocument();
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('new channel follows manageChannels once the slice is loaded, ownership before', () => {
    const { fake } = setup(ME.id);
    expect(screen.getByRole('button', { name: 'new channel' })).toBeInTheDocument();
    act(() => { fake.publish(`permissions:${A}`, access({ manageChannels: false, loaded: true })); });
    expect(screen.queryByRole('button', { name: 'new channel' })).toBeNull();
    act(() => { fake.publish(`permissions:${A}`, access({ manageChannels: true })); });
    expect(screen.getByRole('button', { name: 'new channel' })).toBeInTheDocument();
  });

  // Final fix B1/M2: "edit channel" left the sidebar; the channel header has it, for that channel.
  it('the sidebar has no edit channel; the header has it with manageChannels and it opens the edit dialog of that channel', async () => {
    const { fake, user } = setup(ME.id);
    act(() => { fake.publish(`permissions:${A}`, access({ manageChannels: true })); });
    const sidebar = document.querySelector('.dw-sidebar') as HTMLElement;
    expect(within(sidebar).queryByRole('button', { name: 'edit channel' })).toBeNull();
    const header = document.querySelector('.d-channel-header') as HTMLElement;
    await user.click(within(header).getByRole('button', { name: 'edit channel' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit #general' });
    expect(within(dialog).getByRole('textbox', { name: 'Channel name' })).toHaveValue('general');
    expect(screen.queryByRole('dialog', { name: /settings/i })).toBeNull();
  });

  it('without manageChannels the header has no edit channel', () => {
    const { fake } = setup();
    act(() => { fake.publish(`permissions:${A}`, access({ manageChannels: false })); });
    expect(screen.queryByRole('button', { name: 'edit channel' })).toBeNull();
  });

  // Final fix B2: the open-by-default pane belongs to the wide column; narrowing closes it unless the person used the toggle.
  it('starts open when wide; narrowing closes it with nothing inert; the toggle opens it again', async () => {
    const listeners: ((e: { matches: boolean }) => void)[] = [];
    window.matchMedia = ((query: string) => ({ matches: true, media: query, onchange: null, dispatchEvent: () => false,
      addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => { listeners.push(cb); },
      removeEventListener: (_: string, cb: (e: { matches: boolean }) => void) => { listeners.splice(listeners.indexOf(cb), 1); },
      addListener: () => undefined, removeListener: () => undefined })) as unknown as typeof window.matchMedia;
    const { user } = setup();
    expect(screen.getByRole('complementary', { name: 'members of Midgard' })).toBeInTheDocument();
    act(() => { for (const cb of [...listeners]) cb({ matches: false }); });
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(document.querySelector('[inert]')).toBeNull();
    const toggle = screen.getByRole('button', { name: /^members/ });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    expect(screen.getByRole('complementary', { name: 'members of Midgard' })).toBeInTheDocument();
  });

  it('a pane toggled off and on while wide still closes on narrowing: nothing inert', async () => {
    const listeners: ((e: { matches: boolean }) => void)[] = [];
    window.matchMedia = ((query: string) => ({ matches: true, media: query, onchange: null, dispatchEvent: () => false,
      addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => { listeners.push(cb); },
      removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined })) as unknown as typeof window.matchMedia;
    const { user } = setup();
    const toggle = screen.getByRole('button', { name: /^members/ });
    await user.click(toggle);
    await user.click(toggle);
    expect(screen.getByRole('complementary', { name: 'members of Midgard' })).toBeInTheDocument();
    act(() => { for (const cb of [...listeners]) cb({ matches: false }); });
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(document.querySelector('[inert]')).toBeNull();
  });

  it('a pane the person opened with the toggle stays open on narrowing', async () => {
    const listeners: ((e: { matches: boolean }) => void)[] = [];
    window.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null, dispatchEvent: () => false,
      addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => { listeners.push(cb); },
      removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined })) as unknown as typeof window.matchMedia;
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: /^members/ }));
    act(() => { for (const cb of [...listeners]) cb({ matches: false }); });
    expect(screen.getByRole('complementary', { name: 'members of Midgard' })).toBeInTheDocument();
  });

  // Final fix I2: the drawer's own close control.
  it('the drawer has a close members button that closes it', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: /^members/ }));
    const side = screen.getByRole('complementary', { name: 'members of Midgard' });
    await user.click(within(side).getByRole('button', { name: 'close members' }));
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  // Final fix M5: the aside names the list; the list inside is no second region of the same name.
  it('the member list inside the aside is not a second region named like it', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: /^members/ }));
    expect(screen.queryByRole('region', { name: 'members of Midgard' })).toBeNull();
  });

  it('shows server settings for every member and leave only for non-owners', () => {
    setup();
    expect(screen.getByRole('button', { name: 'server settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'leave server' })).toBeInTheDocument();
  });

  it('owners have no leave button', () => {
    setup(ME.id);
    expect(screen.queryByRole('button', { name: 'leave server' })).toBeNull();
  });

  it('opens server settings on the danger tab from leave', async () => {
    const { fake, user } = setup();
    act(() => { fake.publish(`permissions:${A}`, access()); });
    await user.click(screen.getByRole('button', { name: 'leave server' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { level: 2, name: 'leave server' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'leave server', current: 'page' })).toBeInTheDocument();
  });

  it('more options on the invite link opens server settings on the invites tab', async () => {
    const { fake, user } = setup();
    fake.handler = command => Promise.resolve(command.m === 'createInvite' ? { url: 'https://dilla.test/i/7KQ2', code: '7KQ2', expires: 1_900_000_000 } : null);
    act(() => { fake.publish(`permissions:${A}`, access()); });
    await user.click(screen.getByRole('button', { name: 'invite link' }));
    await user.click(await screen.findByRole('button', { name: 'more options' }));
    const dialog = await screen.findByRole('dialog', { name: /settings/i });
    expect(within(dialog).getByRole('button', { name: 'invites', current: 'page' })).toBeInTheDocument();
  });

  it('a removal from one server leaves the settings of another open', async () => {
    const { fake, user } = setup(OTHER, `/c/${B}/${GEN_B}`);
    act(() => { fake.publish(`permissions:${B}`, access()); });
    await user.click(screen.getByRole('button', { name: 'server settings' }));
    act(() => { fake.publish('removals', [{ id: 3, communityId: A, name: 'Midgard' }]); });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('a removal closes the new channel flow of that server', async () => {
    const { fake, user } = setup(ME.id);
    await user.click(screen.getByRole('button', { name: 'new channel' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    act(() => { fake.publish('removals', [{ id: 4, communityId: A, name: 'Midgard' }]); });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('dismissing the removal banner returns focus to the composer', async () => {
    const { fake, user } = setup();
    act(() => { fake.publish('removals', [{ id: 5, communityId: B, name: 'Valhalla' }]); });
    await user.click(screen.getByRole('button', { name: 'dismiss' }));
    expect(screen.getByRole('textbox', { name: 'message #general' })).toHaveFocus();
  });

  it('a voice channel has no members toggle and no pane', () => {
    wide();
    const voice: ChannelSummary = { ...CHANNELS[0], id: VOICE, kind: 1, name: 'lounge', group: 'unsupported' };
    setup(OTHER, `/c/${A}/${VOICE}`, [voice, ...CHANNELS]);
    expect(screen.queryByRole('button', { name: /^members/ })).toBeNull();
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('a server with no channel open shows no pane, since there is no toggle to close it', () => {
    wide();
    setup(OTHER, `/c/${A}`, []);
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('a removal shows the notice, leaves the server and closes its settings', async () => {
    const { fake, user } = setup();
    act(() => { fake.publish(`permissions:${A}`, access()); });
    await user.click(screen.getByRole('button', { name: 'server settings' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    act(() => {
      fake.publish('communities', [{ id: B, name: 'Valhalla', owner: OTHER }]);
      fake.publish('removals', [{ id: 1, communityId: A, name: 'Midgard' }]);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(window.location.pathname).toMatch(new RegExp(`^/c/${B}`));
    const notice = screen.getByText('You are no longer in Midgard.');
    await user.click(within(notice.parentElement as HTMLElement).getByRole('button', { name: 'dismiss' }));
    expect(screen.queryByText('You are no longer in Midgard.')).toBeNull();
  });

  it('a removal closes the invite and channel flows of that server even before the list changes', async () => {
    const { fake, user } = setup();
    await user.click(screen.getByRole('button', { name: 'invite link' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    act(() => { fake.publish('removals', [{ id: 7, communityId: A, name: 'Midgard' }]); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('You are no longer in Midgard.')).toBeInTheDocument();
  });

  it('a removal from the only server goes to the root', () => {
    window.history.replaceState(null, '', `/c/${A}/${GEN}`);
    const fake = new FakeClient();
    fake.set('account', account());
    fake.set('connection', { status: 'online', generation: '7' });
    fake.set('communities', [{ id: A, name: 'Midgard', owner: OTHER }]);
    fake.set(`channels:${A}`, CHANNELS);
    fake.set('removals', []);
    render(<div className="d-root"><CoreProvider client={fake}><Shell /></CoreProvider></div>);
    act(() => {
      fake.publish('communities', []);
      fake.publish('removals', [{ id: 1, communityId: A, name: 'Midgard' }]);
    });
    expect(window.location.pathname).toBe('/');
  });
});

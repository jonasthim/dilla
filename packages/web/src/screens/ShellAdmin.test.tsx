import { describe, it, expect } from 'vitest';
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
const access = (over: Partial<CommunityAccess> = {}): CommunityAccess => ({ top: 0, owner: false, manageCommunity: false, manageChannels: false,
  kickMembers: false, banMembers: false, createInvite: true, manageRoles: false, loaded: true, ...over });

function setup(owner = OTHER) {
  window.history.replaceState(null, '', `/c/${A}/${GEN}`);
  const fake = new FakeClient();
  fake.set('account', account());
  fake.set('connection', { status: 'online', generation: '7' });
  fake.set('communities', [{ id: A, name: 'Midgard', owner }, { id: B, name: 'Valhalla', owner: OTHER }]);
  fake.set(`channels:${A}`, CHANNELS);
  fake.set(`members:${A}`, MEMBERS);
  fake.set('removals', []);
  const user = userEvent.setup();
  render(<div className="d-root"><CoreProvider client={fake}><Shell /></CoreProvider></div>);
  return { fake, user };
}

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
    expect(screen.getByRole('button', { name: 'edit channel' })).toBeInTheDocument();
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
    expect(screen.getByRole('dialog')).toBeInTheDocument();
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
    expect(window.location.pathname).toBe(`/c/${B}`);
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

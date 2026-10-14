// Flow 07 (v0.1.0-web3.1) in the shell: a fresh instance is usable from here alone. The rail starts a server, the
// sidebar adds a channel and copies an invite link, the empty states say how to begin.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChannelSummary, Command, CommunitySummary, MemberSummary } from '@dilla/client-core';
import { CoreProvider } from '../core/context.tsx';
import { FakeClient } from '../test/fake-client.ts';
import { account, ME } from '../test/fixtures.ts';
import { expectNoAxeViolations } from '../test/setup.ts';
import { Shell } from './Shell.tsx';

const A = 'a1'.repeat(16);
const NEW = '5b'.repeat(16);
const GEN = 'c3'.repeat(16);
const VGEN = 'c4'.repeat(16);
const RAND = 'd4'.repeat(16);
const PEER = '28'.repeat(16);
const OTHER_OWNER = 'ee'.repeat(16);

const ch = (id: string, communityId: string, name: string, over: Partial<ChannelSummary> = {}): ChannelSummary =>
  ({ id, communityId, kind: 0, mode: 0, name, topic: '', parentId: null, position: 0, group: 'active', ...over });
const ME_MEMBER: MemberSummary = { userId: ME.id, username: 'ada', display: '', kind: 0, roleIds: [] };
const PEER_MEMBER: MemberSummary = { userId: PEER, username: 'bob', display: '', kind: 0, roleIds: [] };

/** A worker double that answers the create commands as the controller does: the slice first, then the answer. */
function worker(fake: FakeClient) {
  return (c: Command): Promise<unknown> => {
    if (c.m === 'createCommunity') {
      fake.set('communities', [...(fake.get('communities') ?? []), { id: NEW, name: c.name, owner: ME.id }]);
      return Promise.resolve({ communityId: NEW });
    }
    if (c.m === 'createChannel') {
      const id = c.kind === 'voice' ? VGEN : (fake.get(`channels:${c.communityId}`) ?? []).some(x => x.id === GEN) ? RAND : GEN;
      const list = fake.get(`channels:${c.communityId}`) ?? [];
      fake.set(`channels:${c.communityId}`, [...list, ch(id, c.communityId, c.name, { kind: c.kind === 'voice' ? 1 : 0, position: list.length, group: 'none' })]);
      return Promise.resolve({ channelId: id });
    }
    if (c.m === 'createInvite') return Promise.resolve({ url: 'https://dilla.test/i/7KQ2', code: '7KQ2', expires: 1_900_000_000 });
    if (c.m === 'selectCommunity' && fake.get(`members:${c.communityId}`) === undefined) fake.set(`members:${c.communityId}`, [ME_MEMBER]);
    return Promise.resolve(null);
  };
}

function setup(path: string, opts: { communities?: CommunitySummary[]; members?: MemberSummary[] } = {}) {
  window.history.replaceState(null, '', path);
  const fake = new FakeClient();
  fake.handler = worker(fake);
  fake.set('account', account());
  fake.set('connection', { status: 'online', generation: '7' });
  fake.set('communities', opts.communities ?? []);
  fake.set('dms', []);
  for (const c of opts.communities ?? []) {
    fake.set(`channels:${c.id}`, [ch(GEN, c.id, 'general')]);
    fake.set(`members:${c.id}`, opts.members ?? [ME_MEMBER, PEER_MEMBER]);
  }
  const user = userEvent.setup();
  const view = render(<div className="d-root"><CoreProvider client={fake}><Shell /></CoreProvider></div>);
  return { fake, user, view };
}
const path = () => window.location.pathname;
const rail = () => screen.getByRole('navigation', { name: 'servers' });

afterEach(() => { vi.useRealTimers(); });

describe('a fresh instance (flow 07)', () => {
  it('says how to start: start a server or join one, in the main pane', async () => {
    const { user, view } = setup('/');
    const region = screen.getByRole('region', { name: 'You are not in a server yet' });
    expect(region).toHaveTextContent('Start a server and invite your friends, or join one with an invite someone sent you.');
    expect(within(region).getAllByRole('button').map(b => b.textContent)).toEqual(['Start a server', 'Join a server']);
    await expectNoAxeViolations(view.container);
    await user.click(within(region).getByRole('button', { name: 'Start a server' }));
    expect(screen.getByRole('dialog', { name: 'Start a server' })).toBeInTheDocument();
  });

  it('ends the rail with join and new server, both captioned', () => {
    setup('/');
    const buttons = within(rail()).getAllByRole('button');
    expect(buttons.map(b => b.getAttribute('aria-label'))).toEqual(['join a server', 'new server', 'settings']);
    expect(within(buttons[0]).getByText('join')).toBeInTheDocument();
    expect(within(buttons[1]).getByText('new')).toBeInTheDocument();
  });

  it('starts a server from the rail: it is created with #general and a voice general, opened on #general, focus in its composer', async () => {
    const { fake, user } = setup('/');
    await user.click(within(rail()).getByRole('button', { name: 'new server' }));
    await user.type(screen.getByRole('textbox', { name: 'Server name' }), 'Midgard Crew{Enter}');
    await waitFor(() => expect(path()).toBe(`/c/${NEW}/${GEN}`));
    expect(fake.calls.filter(c => c.m.startsWith('create'))).toEqual([
      { m: 'createCommunity', name: 'Midgard Crew' },
      { m: 'createChannel', communityId: NEW, kind: 'text', name: 'general' },
      { m: 'createChannel', communityId: NEW, kind: 'voice', name: 'general' },
    ]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(rail()).getByRole('button', { name: 'Midgard Crew' })).toHaveAttribute('aria-current', 'page');
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'message #general' })).toHaveFocus());
  });

  it('with no server, the direct messages say why there is no one to message', async () => {
    const { user } = setup('/');
    const sidebar = screen.getByRole('navigation', { name: 'direct messages' });
    expect(within(sidebar).getByRole('tab', { name: 'direct messages' })).toHaveAttribute('aria-selected', 'true');
    await user.click(within(sidebar).getByRole('button', { name: 'message someone' }));
    const dialog = screen.getByRole('dialog', { name: 'Message someone' });
    expect(dialog).toHaveTextContent('There is no one to message yet: direct messages are with people you share a server with. Start a server and invite someone, or join one.');
    expect(within(dialog).queryByRole('list')).toBeNull();
  });
});

describe('a server’s actions (flow 07)', () => {
  it('the owner sees new channel and invite link beside the server name; another member only the invite link', () => {
    const { view } = setup(`/c/${A}/${GEN}`, { communities: [{ id: A, name: 'Midgard', owner: ME.id }] });
    const group = screen.getByRole('group', { name: 'server actions' });
    expect(within(group).getAllByRole('button').map(b => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['new channel', 'invite link']);
    view.unmount();
    setup(`/c/${A}/${GEN}`, { communities: [{ id: A, name: 'Midgard', owner: OTHER_OWNER }] });
    expect(within(screen.getByRole('group', { name: 'server actions' })).getAllByRole('button').map(b => b.textContent)).toEqual(['invite link']);
  });

  it('adds a channel and opens it', async () => {
    const { fake, user } = setup(`/c/${A}/${GEN}`, { communities: [{ id: A, name: 'Midgard', owner: ME.id }] });
    await user.click(screen.getByRole('button', { name: 'new channel' }));
    expect(screen.getByRole('dialog', { name: 'New channel in Midgard' })).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Channel name' }), 'Random{Enter}');
    await waitFor(() => expect(path()).toBe(`/c/${A}/${RAND}`));
    expect(fake.callsOf('createChannel')).toEqual([{ m: 'createChannel', communityId: A, kind: 'text', name: 'random' }]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('copies an invite link and says so; the link shows in the dialog', async () => {
    const { fake, user } = setup(`/c/${A}/${GEN}`, { communities: [{ id: A, name: 'Midgard', owner: OTHER_OWNER }] });
    await user.click(screen.getByRole('button', { name: 'invite link' }));
    const dialog = screen.getByRole('dialog', { name: 'Invite people to Midgard' });
    await waitFor(() => expect(within(dialog).getByRole('status')).toHaveTextContent('Invite link copied.'));
    expect(within(dialog).getByRole('textbox', { name: 'Invite link' })).toHaveValue('https://dilla.test/i/7KQ2');
    expect(fake.callsOf('createInvite')).toEqual([{ m: 'createInvite', communityId: A, maxUses: 10, ttlSeconds: 604_800 }]);
    await expect(navigator.clipboard.readText()).resolves.toBe('https://dilla.test/i/7KQ2');
  });

  it('a server with only you: the picker says to invite people first', async () => {
    const { user } = setup(`/c/${A}/${GEN}`, { communities: [{ id: A, name: 'Midgard', owner: ME.id }], members: [ME_MEMBER] });
    await user.click(screen.getByRole('tab', { name: 'direct messages' }));
    await user.click(screen.getByRole('button', { name: 'message someone' }));
    expect(screen.getByRole('dialog', { name: 'Message someone' }))
      .toHaveTextContent('No one else is in this server yet. Invite people first, then message them here.');
  });

  it('reads the server’s lists again when the window regains focus, at most once in 15 s', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_900_000_000_000);
    const { fake } = setup(`/c/${A}/${GEN}`, { communities: [{ id: A, name: 'Midgard', owner: OTHER_OWNER }] });
    const selects = () => fake.callsOf('selectCommunity').length;
    const before = selects();
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(selects()).toBe(before);   // the load at mount was just now
    vi.setSystemTime(1_900_000_016_000);
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(selects()).toBe(before + 1);
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(selects()).toBe(before + 1);
  });
});

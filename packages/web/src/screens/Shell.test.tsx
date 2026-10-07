import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChannelSummary, DeviceSummary, DmSummary, MemberSummary, TimelineItem, TimelineState } from '@dilla/client-core';
import { CoreProvider } from '../core/context.tsx';
import { FakeClient, refusal } from '../test/fake-client.ts';
import { account, ME, timelineItem } from '../test/fixtures.ts';
import { expectNoAxeViolations } from '../test/setup.ts';
import { formatTime } from '../strings/index.ts';
import { joinErrorState } from '../router.ts';
import { Shell } from './Shell.tsx';

const A = 'a1'.repeat(16);
const B = 'b2'.repeat(16);
const VOICE = 'e5'.repeat(16);
const GEN = 'c3'.repeat(16);
const CAT = '17'.repeat(16);
const RAND = 'd4'.repeat(16);
const READ = 'f6'.repeat(16);
const PEER = '28'.repeat(16);
const PEER_DEV = '29'.repeat(16);
const BOT = '39'.repeat(16);
const STRANGER = '4a'.repeat(16);
const NOW = Math.floor(Date.now() / 1000);

function ch(id: string, name: string, over: Partial<ChannelSummary> = {}): ChannelSummary {
  return { id, communityId: A, kind: 0, mode: 0, name, topic: '', parentId: null, position: 0, group: 'none', ...over };
}
const CHANNELS: ChannelSummary[] = [
  ch(VOICE, 'lounge', { kind: 1, position: 0, group: 'unsupported' }),
  ch(GEN, 'general', { position: 1, topic: 'say hi' }),
  ch(CAT, 'more', { kind: 2, position: 2, group: 'unsupported' }),
  ch(RAND, 'random', { parentId: CAT, position: 0 }),
  ch(READ, 'lobby', { parentId: CAT, position: 1, mode: 1, group: 'unsupported' }),
];
const MEMBERS: MemberSummary[] = [
  { userId: ME.id, username: 'ada', display: 'Ada L', kind: 0, roleIds: [] },
  { userId: PEER, username: 'bob', display: '', kind: 0, roleIds: [] },
  { userId: BOT, username: 'helper', display: 'Helper', kind: 1, roleIds: [] },
];
function item(over: Partial<TimelineItem> & { key: string }): TimelineItem {
  return timelineItem({ senderUser: PEER, senderDevice: PEER_DEV, ts: NOW, ...over });
}
function timeline(over: Partial<TimelineState> = {}): TimelineState {
  return { channelId: GEN, group: 'active', items: [], hasEarlier: false, ...over };
}
// `state` is the history entry's state (task 23 carries a refused join in it, pre-flight ruling (g)).
function setup(path: string, opts: { channels?: boolean; communities?: { id: string; name: string }[]; state?: unknown; before?(fake: FakeClient): void } = {}) {
  window.history.replaceState(opts.state ?? null, '', path);
  const fake = new FakeClient();
  fake.set('account', account());
  fake.set('connection', { status: 'online', generation: '7' });
  fake.set('communities', opts.communities ?? [{ id: A, name: 'Midgard' }, { id: B, name: 'Valhalla' }]);
  if (opts.channels !== false) fake.set(`channels:${A}`, CHANNELS);
  fake.set(`members:${A}`, MEMBERS);
  opts.before?.(fake);
  const user = userEvent.setup();
  const view = render(<div className="d-root"><CoreProvider client={fake}><Shell /></CoreProvider></div>);
  return { fake, user, view };
}
const path = () => window.location.pathname;
const composer = (name = 'general') => screen.getByRole('textbox', { name: `message #${name}` });
const sendButton = () => screen.getByRole('button', { name: 'send' });
// A blocked composer stays focusable: aria-disabled on the textarea, the native attribute on the button only (L-UI-13).
function expectBlocked(name = 'general') {
  expect(composer(name)).toHaveAttribute('aria-disabled', 'true');
  expect(sendButton()).toBeDisabled();
}
const opens = (fake: FakeClient) => fake.calls.filter(c => c.m === 'openChannel' || c.m === 'closeChannel');

describe('selection', () => {
  it('takes / to the first server and its first readable text channel', () => {
    const { fake } = setup('/', { channels: false });
    expect(path()).toBe(`/c/${A}`);
    expect(fake.callsOf('selectCommunity')).toEqual([{ m: 'selectCommunity', communityId: A }]);
    expect(fake.callsOf('openChannel')).toEqual([]);
    act(() => fake.set(`channels:${A}`, CHANNELS));
    expect(path()).toBe(`/c/${A}/${GEN}`);
    expect(fake.callsOf('openChannel')).toEqual([{ m: 'openChannel', channelId: GEN }]);
  });
  it('replaces a route to an unknown server', () => {
    setup(`/c/${'ff'.repeat(16)}`);
    expect(path()).toBe(`/c/${A}/${GEN}`);
  });
  it('replaces a route to an unknown channel', () => {
    setup(`/c/${A}/${'ee'.repeat(16)}`);
    expect(path()).toBe(`/c/${A}/${GEN}`);
  });
  it('lists channels in order without the category', () => {
    setup(`/c/${A}/${GEN}`);
    const list = screen.getByRole('navigation', { name: 'channels' });
    const text = list.textContent ?? '';
    expect(text).toContain('Midgard');
    expect(text).not.toContain('more');
    const at = (s: string) => text.indexOf(s);
    expect(at('lounge')).toBeLessThan(at('general'));
    expect(at('general')).toBeLessThan(at('random'));
    expect(at('random')).toBeLessThan(at('lobby'));
    expect(within(list).getByRole('img', { name: 'Readable by this server' })).toBeInTheDocument();
  });
  it('switches channels and servers, closing what it leaves', async () => {
    const { user, fake } = setup(`/c/${A}/${GEN}`);
    await user.click(within(screen.getByRole('navigation', { name: 'channels' })).getByRole('button', { name: /^random/ }));
    expect(path()).toBe(`/c/${A}/${RAND}`);
    expect(opens(fake)).toEqual([
      { m: 'openChannel', channelId: GEN }, { m: 'closeChannel', channelId: GEN }, { m: 'openChannel', channelId: RAND },
    ]);
    await user.click(within(screen.getByRole('navigation', { name: 'servers' })).getByRole('button', { name: 'Valhalla' }));
    expect(path()).toBe(`/c/${B}`);
    expect(fake.callsOf('selectCommunity')).toEqual([
      { m: 'selectCommunity', communityId: A }, { m: 'selectCommunity', communityId: B },
    ]);
    expect(opens(fake).at(-1)).toEqual({ m: 'closeChannel', channelId: RAND });
  });
  it('shows an unsupported channel without opening it', () => {
    const { fake } = setup(`/c/${A}/${VOICE}`);
    expect(screen.getByRole('heading', { name: 'This channel does not open here yet' })).toBeInTheDocument();
    expect(screen.getByText('Voice channels arrive in a later version of the web client.')).toBeInTheDocument();
    expect(screen.queryByRole('log')).toBeNull();
    expect(composer('lounge')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'send' })).toBeDisabled();
    expect(screen.getByText('this channel does not open here yet')).toBeInTheDocument();
    expect(fake.callsOf('openChannel')).toEqual([]);
  });
  it('marks a readable channel in its header', () => {
    setup(`/c/${A}/${READ}`);
    expect(screen.getByText('Channels this server can read arrive in a later version of the web client.')).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: 'Readable by this server' }).length).toBeGreaterThanOrEqual(2);
  });
  // Pre-flight ruling (c): a server whose channels did not load says so in the sidebar and can be retried.
  it('shows a server that did not load and tries again', async () => {
    let attempts = 0;
    const { fake, user } = setupWith(c => {
      if (c.m !== 'selectCommunity') return Promise.resolve(null);
      attempts += 1;
      return attempts === 1 ? Promise.reject(refusal({ code: 'E_NETWORK' })) : Promise.resolve(null);
    });
    const sidebar = await screen.findByRole('region', { name: 'Midgard' });
    expect(sidebar).toHaveTextContent('This server did not load (E_NETWORK).');
    expect(screen.queryByText('loading channels…')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'try again' }));
    expect(fake.callsOf('selectCommunity')).toEqual([
      { m: 'selectCommunity', communityId: A }, { m: 'selectCommunity', communityId: A },
    ]);
    expect(screen.queryByText('This server did not load (E_NETWORK).')).toBeNull();
    expect(screen.getByText('loading channels…')).toBeInTheDocument();
    act(() => fake.set(`channels:${A}`, CHANNELS));
    expect(path()).toBe(`/c/${A}/${GEN}`);
  });
});

// A shell whose calls are answered by `handler` from the first render on, on /c/A with no channels yet.
function setupWith(handler: FakeClient['handler']) {
  window.history.replaceState(null, '', `/c/${A}`);
  const fake = new FakeClient();
  fake.handler = handler;
  fake.set('account', account());
  fake.set('connection', { status: 'online', generation: '7' });
  fake.set('communities', [{ id: A, name: 'Midgard' }, { id: B, name: 'Valhalla' }]);
  fake.set(`members:${A}`, MEMBERS);
  const user = userEvent.setup();
  const view = render(<div className="d-root"><CoreProvider client={fake}><Shell /></CoreProvider></div>);
  return { fake, user, view };
}

describe('timeline', () => {
  it('shows names, tags and every row state, and never an unreadable body', async () => {
    const { fake, user, view } = setup(`/c/${A}/${GEN}`);
    act(() => fake.set(`timeline:${GEN}`, timeline({ items: [
      item({ key: 's1', body: 'hello from bob' }),
      item({ key: 's2', senderUser: BOT, bot: true, body: 'beep' }),
      item({ key: 's3', senderUser: ME.id, own: true, web: true, body: 'hi bob' }),
      item({ key: 's4', senderUser: STRANGER, body: 'who am i' }),
      item({ key: 's5', state: 'cannot-read', reason: 'E_SENDER_MISMATCH', senderUser: null, body: 'SECRET-PLAINTEXT' }),
      item({ key: 's6', state: 'deleted', body: 'GONE-TEXT' }),
      item({ key: `o${'ab'.repeat(16)}`, state: 'pending', senderUser: ME.id, own: true, web: true, body: 'on its way', msgId: 'ab'.repeat(16) }),
      item({ key: `o${'cd'.repeat(16)}`, state: 'failed', reason: 'E_TOO_LARGE', senderUser: ME.id, own: true, web: true, body: 'too big', msgId: 'cd'.repeat(16) }),
    ] })));
    const log = screen.getByRole('log', { name: 'messages in #general' });
    expect(log).toHaveAttribute('aria-live', 'polite');
    for (const text of ['hello from bob', 'beep', 'hi bob', 'who am i', 'on its way', 'too big']) expect(within(log).getByText(text)).toBeInTheDocument();
    // s1 and the deleted s6 (item()'s default sender is bob): a deleted row keeps its sender (L-CORE-08 rule 2) and
    // MessageRow always renders its author (task 21), so bob is named twice.
    expect(within(log).getAllByText('bob')).toHaveLength(2);
    expect(within(log).getByText('Helper')).toBeInTheDocument();
    expect(within(log).getAllByText('Ada L')).toHaveLength(3);
    expect(within(log).getByText('4a4a4a4a')).toBeInTheDocument();
    expect(within(log).getByText('device 29292929')).toBeInTheDocument();
    expect(within(log).getAllByText('web')).toHaveLength(3);
    expect(within(log).getAllByText('bot')).toHaveLength(1);
    expect(within(log).getAllByText(formatTime(NOW))).toHaveLength(8);
    expect(within(log).getByText('This message could not be read on this device.')).toBeInTheDocument();
    expect(within(log).getByText('E_SENDER_MISMATCH')).toBeInTheDocument();
    expect(screen.queryByText(/SECRET-PLAINTEXT/)).toBeNull();
    expect(within(log).getByText('message deleted')).toBeInTheDocument();
    expect(screen.queryByText(/GONE-TEXT/)).toBeNull();
    expect(within(log).getByText('sending…')).toBeInTheDocument();
    expect(within(log).getByText('not sent')).toBeInTheDocument();
    expect(within(log).getByText('E_TOO_LARGE')).toBeInTheDocument();
    await user.click(within(log).getByRole('button', { name: 'retry' }));
    await user.click(within(log).getByRole('button', { name: 'discard' }));
    expect(fake.callsOf('retrySend')).toEqual([{ m: 'retrySend', msgId: 'cd'.repeat(16) }]);
    expect(fake.callsOf('discardSend')).toEqual([{ m: 'discardSend', msgId: 'cd'.repeat(16) }]);
    await expectNoAxeViolations(view.container);
  });
  it('says when it is loading, when it is empty, and loads earlier messages', async () => {
    const { fake, user } = setup(`/c/${A}/${GEN}`);
    expect(screen.getByText('loading messages…')).toBeInTheDocument();
    act(() => fake.set(`timeline:${GEN}`, timeline()));
    expect(screen.getByText('nothing here yet. Messages sent before this browser joined are not shown.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'load earlier' })).toBeNull();
    act(() => fake.set(`timeline:${GEN}`, timeline({ hasEarlier: true, items: [item({ key: 's9', body: 'x' })] })));
    await user.click(screen.getByRole('button', { name: 'load earlier' }));
    expect(fake.callsOf('loadEarlier')).toEqual([{ m: 'loadEarlier', channelId: GEN }]);
  });
  // A11Y-DESIGN-01: a polite log announces rows added to it, but not the rows it mounts with. Each channel and its
  // first slice get a log of their own, so history is never read out as new messages.
  it('mounts a new log with its rows when the channel changes', async () => {
    const { fake, user } = setup(`/c/${A}/${GEN}`);
    act(() => fake.set(`timeline:${GEN}`, timeline({ items: [item({ key: 's1', body: 'in general' })] })));
    act(() => fake.set(`timeline:${RAND}`, timeline({ channelId: RAND, items: [item({ key: 'r1', body: 'in random' })] })));
    const before = screen.getByRole('log', { name: 'messages in #general' });
    await user.click(within(screen.getByRole('navigation', { name: 'channels' })).getByRole('button', { name: /^random/ }));
    const after = screen.getByRole('log', { name: 'messages in #random' });
    expect(after).not.toBe(before);
    expect(before.isConnected).toBe(false);
    expect(within(after).getByText('in random')).toBeInTheDocument();
    expect(after).not.toHaveAttribute('aria-busy');
  });
  it('starts at the newest row after switching timelines with overlapping row keys', async () => {
    const { fake, user } = setup(`/c/${A}/${GEN}`);
    act(() => fake.set(`timeline:${GEN}`, timeline({ items: [
      item({ key: 's1', msgId: '11'.repeat(16), seq: '1', body: 'general first' }),
      item({ key: 's2', msgId: '12'.repeat(16), seq: '2', body: 'general last' }),
    ] })));
    act(() => fake.set(`timeline:${RAND}`, timeline({ channelId: RAND, items: [
      item({ key: 's1', msgId: '21'.repeat(16), seq: '1', body: 'random first' }),
      item({ key: 's3', msgId: '23'.repeat(16), seq: '3', body: 'random last' }),
    ] })));
    act(() => screen.getByText('general first').closest<HTMLElement>('.d-message-row')?.focus());
    expect(screen.getByText('general first').closest('.d-message-row')).toHaveAttribute('data-active', 'true');
    await user.click(within(screen.getByRole('navigation', { name: 'channels' })).getByRole('button', { name: /^random/ }));
    expect(screen.getByText('random last').closest('.d-message-row')).toHaveAttribute('data-active', 'true');
    expect(screen.getByText('random first').closest('.d-message-row')).not.toHaveAttribute('data-active', 'true');
  });
  it('closes a row emoji picker before switching to a timeline with the same row key', async () => {
    const { fake, user } = setup(`/c/${A}/${GEN}`);
    act(() => fake.set(`timeline:${GEN}`, timeline({ items: [
      item({ key: 's1', msgId: '11'.repeat(16), seq: '1', body: 'general row' }),
    ] })));
    act(() => fake.set(`timeline:${RAND}`, timeline({ channelId: RAND, items: [
      item({ key: 's1', msgId: '21'.repeat(16), seq: '1', body: 'random row' }),
    ] })));
    const row = screen.getByText('general row').closest<HTMLElement>('.d-message-row')!;
    await user.click(within(row).getByRole('button', { name: 'react' }));
    expect(screen.getByRole('dialog', { name: 'pick a reaction' })).toBeInTheDocument();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(path()).toBe(`/c/${A}/${RAND}`);
    expect(screen.queryByRole('dialog', { name: 'pick a reaction' })).toBeNull();
    expect(screen.getByRole('log', { name: 'messages in #random' })).toHaveFocus();
    expect(fake.callsOf('react')).toEqual([]);
  });
  it('mounts a new log when the first slice arrives, and keeps focus in it', () => {
    const { fake } = setup(`/c/${A}/${GEN}`);
    const loading = screen.getByRole('log', { name: 'messages in #general' });
    expect(loading).toHaveAttribute('aria-busy', 'true');
    act(() => loading.focus());
    act(() => fake.set(`timeline:${GEN}`, timeline({ items: [item({ key: 's1', body: 'first' })] })));
    const ready = screen.getByRole('log', { name: 'messages in #general' });
    expect(ready).not.toBe(loading);
    expect(within(ready).getByText('first')).toBeInTheDocument();
    expect(ready).toHaveFocus();
    // Later slices of the same channel are added to the same log, and so are announced.
    act(() => fake.set(`timeline:${GEN}`, timeline({ items: [item({ key: 's1', body: 'first' }), item({ key: 's2', body: 'second' })] })));
    expect(screen.getByRole('log', { name: 'messages in #general' })).toBe(ready);
  });
  it('is busy before its first slice and while earlier messages load', async () => {
    const { fake, user } = setup(`/c/${A}/${GEN}`);
    const log = () => screen.getByRole('log', { name: 'messages in #general' });
    expect(log()).toHaveAttribute('aria-busy', 'true');
    act(() => fake.set(`timeline:${GEN}`, timeline({ hasEarlier: true, items: [item({ key: 's9', body: 'x' })] })));
    expect(log()).not.toHaveAttribute('aria-busy');
    let finish: (v: null) => void = () => {};
    fake.handler = c => (c.m === 'loadEarlier' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(null));
    await user.click(screen.getByRole('button', { name: 'load earlier' }));
    expect(log()).toHaveAttribute('aria-busy', 'true');
    await act(async () => { finish(null); await Promise.resolve(); });
    expect(log()).not.toHaveAttribute('aria-busy');
  });
});

describe('a channel that fails to open', () => {
  it('says so and can be retried', async () => {
    const { fake, user } = setup('/', { channels: false });
    let attempts = 0;
    fake.handler = c => {
      if (c.m !== 'openChannel') return Promise.resolve(null);
      attempts += 1;
      return attempts === 1 ? Promise.reject(refusal({ code: 'E_COMMIT_CONFLICT', status: 409 })) : Promise.resolve(null);
    };
    act(() => fake.set(`channels:${A}`, CHANNELS));
    expect(await screen.findByRole('heading', { name: 'This channel did not open' })).toBeInTheDocument();
    expect(screen.getByText('Something went wrong while opening it (E_COMMIT_CONFLICT).')).toBeInTheDocument();
    expect(screen.queryByRole('log')).toBeNull();
    expectBlocked();
    expect(screen.getByText('this channel did not open')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'try again' }));
    expect(fake.callsOf('openChannel')).toEqual([{ m: 'openChannel', channelId: GEN }, { m: 'openChannel', channelId: GEN }]);
    expect(screen.getByRole('log', { name: 'messages in #general' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'This channel did not open' })).toBeNull();
  });
});

describe('composer', () => {
  it.each([
    ['active', null],
    ['none', 'joining this channel…'],
    ['joining', 'joining this channel…'],
    ['resync', 'catching up with this channel…'],
    ['not-member', 'you cannot post in this channel and new messages will not arrive. Reload, or ask the host.'],
  ] as const)('in state %s', (group, reason) => {
    const { fake } = setup(`/c/${A}/${GEN}`);
    act(() => fake.set(`timeline:${GEN}`, timeline({ group })));
    if (reason === null) {
      expect(composer()).not.toHaveAttribute('aria-disabled');
    } else {
      expect(composer()).toHaveAttribute('aria-disabled', 'true');
      expect(screen.getByRole('button', { name: 'send' })).toBeDisabled();
      expect(screen.getByText(reason)).toBeInTheDocument();
      expect(composer()).toHaveAccessibleDescription(expect.stringContaining(reason));
    }
  });
  it('sends what was typed', async () => {
    const { fake, user } = setup(`/c/${A}/${GEN}`);
    fake.handler = c => Promise.resolve(c.m === 'send' ? { msgId: 'ab'.repeat(16) } : null);
    act(() => fake.set(`timeline:${GEN}`, timeline()));
    await user.type(composer(), 'hello{Enter}');
    expect(fake.callsOf('send')).toEqual([{ m: 'send', channelId: GEN, text: 'hello' }]);
  });
  // WEB-APP-01: while a send is in flight a second Enter, a click on send or a held Enter posts nothing more.
  it('sends once while a send is in flight', async () => {
    const { fake, user } = setup(`/c/${A}/${GEN}`);
    let finish: (v: unknown) => void = () => {};
    fake.handler = c => (c.m === 'send' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(null));
    act(() => fake.set(`timeline:${GEN}`, timeline()));
    await user.type(composer(), 'hello{Enter}{Enter}');
    await user.click(sendButton());
    expect(fake.callsOf('send')).toEqual([{ m: 'send', channelId: GEN, text: 'hello' }]);
    expect(composer()).toHaveValue('hello');
    await act(async () => { finish({ msgId: 'ab'.repeat(16) }); await Promise.resolve(); });
    expect(composer()).toHaveValue('');
    // The in-flight mark is cleared: the next message goes out.
    fake.handler = c => Promise.resolve(c.m === 'send' ? { msgId: 'cd'.repeat(16) } : null);
    await user.type(composer(), 'again{Enter}');
    expect(fake.callsOf('send')).toEqual([{ m: 'send', channelId: GEN, text: 'hello' }, { m: 'send', channelId: GEN, text: 'again' }]);
  });
  // A11Y-DESIGN-04: past the 4000-byte budget the counter says by how much, never a negative "left".
  it('says how far a message is over the budget and sends nothing', async () => {
    const { fake, user } = setup(`/c/${A}/${GEN}`);
    act(() => fake.set(`timeline:${GEN}`, timeline()));
    fireEvent.change(composer(), { target: { value: 'x'.repeat(3990) } });
    expect(screen.getByText('10 left', { selector: '.d-composer__counter' })).toBeInTheDocument();
    fireEvent.change(composer(), { target: { value: 'x'.repeat(4070) } });
    expect(screen.getByText('70 bytes over the limit', { selector: '.d-composer__counter' })).toBeInTheDocument();
    expect(screen.queryByText(/-\d+ left/)).toBeNull();
    expect(sendButton()).toHaveAttribute('aria-disabled', 'true');
    await user.click(sendButton());
    expect(fake.callsOf('send')).toEqual([]);
  });
  it('shows a failed command and lets it be dismissed', async () => {
    const { fake, user } = setup(`/c/${A}/${GEN}`);
    fake.handler = c => (c.m === 'send' ? Promise.reject(refusal({ code: 'E_NOT_READY', detail: 'the phase is loading' })) : Promise.resolve(null));
    act(() => fake.set(`timeline:${GEN}`, timeline()));
    await user.type(composer(), 'hello{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('That did not work (E_NOT_READY).');
    await user.click(screen.getByRole('button', { name: 'dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });
  // Pre-flight ruling (d): the shell holds the composer's text; a send that resolves clears it, a refused one keeps it.
  it('clears the text once a send resolves and keeps it when the send is refused', async () => {
    const { fake, user } = setup(`/c/${A}/${GEN}`);
    let refuse = false;
    fake.handler = c => {
      if (c.m !== 'send') return Promise.resolve(null);
      return refuse ? Promise.reject(refusal({ code: 'E_BAD_INPUT', detail: 'body' })) : Promise.resolve({ msgId: 'ab'.repeat(16) });
    };
    act(() => fake.set(`timeline:${GEN}`, timeline()));
    await user.type(composer(), 'hello{Enter}');
    expect(composer()).toHaveValue('');
    refuse = true;
    await user.type(composer(), 'keep me{Enter}');
    // Pre-flight ruling (f): the banner says what to do, and never shows the server's detail.
    expect(await screen.findByRole('alert')).toHaveTextContent('That did not work (E_BAD_INPUT). Try again, or reload the page.');
    expect(screen.getByRole('alert')).not.toHaveTextContent('body');
    expect(composer()).toHaveValue('keep me');
    expect(fake.callsOf('send')).toEqual([
      { m: 'send', channelId: GEN, text: 'hello' }, { m: 'send', channelId: GEN, text: 'keep me' },
    ]);
  });
});

// A11Y-DESIGN-05: a focused control that removes itself hands focus on, never to <body>.
describe('focus after a control removes itself', () => {
  const F1 = 'cd'.repeat(16);
  const F2 = 'ef'.repeat(16);
  const failed = (msgId: string, body: string) =>
    item({ key: `o${msgId}`, state: 'failed', reason: 'E_NETWORK', senderUser: ME.id, own: true, web: true, body, msgId });
  it('goes from a retried or discarded row to the next failed row, else to the log', async () => {
    const { fake, user } = setup(`/c/${A}/${GEN}`);
    act(() => fake.set(`timeline:${GEN}`, timeline({ items: [item({ key: 's1', body: 'x' }), failed(F1, 'one'), failed(F2, 'two')] })));
    const log = screen.getByRole('log');
    const [, retry2] = within(log).getAllByRole('button', { name: 'retry' });
    act(() => within(log).getAllByRole('button', { name: 'retry' })[0].focus());
    await user.keyboard('{Enter}');
    expect(fake.callsOf('retrySend')).toEqual([{ m: 'retrySend', msgId: F1 }]);
    expect(retry2).toHaveFocus();
    // The worker turns the first row pending: focus stays where it went.
    act(() => fake.set(`timeline:${GEN}`, timeline({ items: [
      item({ key: 's1', body: 'x' }), { ...failed(F1, 'one'), state: 'pending', reason: '' }, failed(F2, 'two'),
    ] })));
    expect(retry2).toHaveFocus();
    act(() => within(log).getByRole('button', { name: 'discard' }).focus());
    await user.keyboard('{Enter}');
    expect(fake.callsOf('discardSend')).toEqual([{ m: 'discardSend', msgId: F2 }]);
    expect(screen.getByRole('log')).toHaveFocus();
    act(() => fake.set(`timeline:${GEN}`, timeline({ items: [item({ key: 's1', body: 'x' }), { ...failed(F1, 'one'), state: 'pending', reason: '' }] })));
    expect(screen.getByRole('log')).toHaveFocus();
  });
  it('goes from a discarded row to the same action of the next failed row', async () => {
    const { fake, user } = setup(`/c/${A}/${GEN}`);
    act(() => fake.set(`timeline:${GEN}`, timeline({ items: [failed(F1, 'one'), failed(F2, 'two')] })));
    const [discard1, discard2] = within(screen.getByRole('log')).getAllByRole('button', { name: 'discard' });
    act(() => discard1.focus());
    await user.keyboard('{Enter}');
    expect(discard2).toHaveFocus();
    act(() => fake.set(`timeline:${GEN}`, timeline({ items: [failed(F2, 'two')] })));
    expect(discard2).toHaveFocus();
  });
  it('goes from the dismissed command error to the composer', async () => {
    const { fake, user } = setup(`/c/${A}/${GEN}`);
    fake.handler = c => (c.m === 'send' ? Promise.reject(refusal({ code: 'E_NOT_READY' })) : Promise.resolve(null));
    act(() => fake.set(`timeline:${GEN}`, timeline()));
    await user.type(composer(), 'hello{Enter}');
    await screen.findByRole('alert');
    act(() => screen.getByRole('button', { name: 'dismiss' }).focus());
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(composer()).toHaveFocus();
  });
  it('goes from the main pane’s try again to the log, and back to try again when it fails again', async () => {
    const { fake, user } = setup('/', { channels: false });
    let refuse = true;
    fake.handler = c => (c.m === 'openChannel' && refuse ? Promise.reject(refusal({ code: 'E_COMMIT_CONFLICT', status: 409 })) : Promise.resolve(null));
    act(() => fake.set(`channels:${A}`, CHANNELS));
    await screen.findByRole('heading', { name: 'This channel did not open' });
    act(() => screen.getByRole('button', { name: 'try again' }).focus());
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('button', { name: 'try again' })).toHaveFocus());
    expect(fake.callsOf('openChannel')).toHaveLength(2);
    refuse = false;
    await user.keyboard('{Enter}');
    expect(screen.getByRole('log', { name: 'messages in #general' })).toHaveFocus();
    act(() => fake.set(`timeline:${GEN}`, timeline({ items: [item({ key: 's1', body: 'x' })] })));
    expect(screen.getByRole('log', { name: 'messages in #general' })).toHaveFocus();
  });
  it('goes from the sidebar’s try again to the channel list, and back to try again when it fails again', async () => {
    let attempts = 0;
    const { fake, user } = setupWith(c => {
      if (c.m !== 'selectCommunity') return Promise.resolve(null);
      attempts += 1;
      return attempts <= 2 ? Promise.reject(refusal({ code: 'E_NETWORK' })) : Promise.resolve(null);
    });
    await screen.findByRole('region', { name: 'Midgard' });
    act(() => screen.getByRole('button', { name: 'try again' }).focus());
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('button', { name: 'try again' })).toHaveFocus());
    await user.keyboard('{Enter}');
    expect(fake.callsOf('selectCommunity')).toHaveLength(3);
    act(() => fake.set(`channels:${A}`, CHANNELS));
    expect(path()).toBe(`/c/${A}/${GEN}`);
    const general = within(screen.getByRole('navigation', { name: 'channels' })).getByRole('button', { name: /^general/ });
    expect(general).toHaveFocus();
    expect(general).toHaveAttribute('tabindex', '0');
  });
});

describe('servers and the join dialog', () => {
  it('invites a person without servers to join one', async () => {
    const { user, view } = setup('/', { communities: [] });
    expect(path()).toBe('/');
    expect(screen.getByRole('heading', { name: 'You are not in a server yet' })).toBeInTheDocument();
    await expectNoAxeViolations(view.container);
    await user.click(screen.getByRole('button', { name: 'Join a server' }));
    expect(screen.getByRole('dialog', { name: 'Join a server' })).toBeInTheDocument();
  });
  it('joins from the rail, closes the dialog and opens the server', async () => {
    const { fake, user } = setup(`/c/${A}/${GEN}`);
    fake.handler = c => Promise.resolve(c.m === 'joinCommunity' ? { communityId: B } : null);
    await user.click(screen.getByRole('button', { name: 'join a server' }));
    await user.type(screen.getByRole('textbox', { name: 'Invite' }), 'https://dilla.test/i/ABCD-EFGH');
    await user.click(screen.getByRole('button', { name: 'Join' }));
    expect(fake.callsOf('joinCommunity')).toEqual([{ m: 'joinCommunity', invite: 'ABCD-EFGH' }]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(path()).toBe(`/c/${B}`);
  });
  it('keeps a just-joined server selected until the server list catches up', async () => {
    const NEW = '5b'.repeat(16);
    const { fake, user } = setup(`/c/${A}/${GEN}`);
    fake.handler = c => Promise.resolve(c.m === 'joinCommunity' ? { communityId: NEW } : null);
    await user.click(screen.getByRole('button', { name: 'join a server' }));
    await user.type(screen.getByRole('textbox', { name: 'Invite' }), 'ABCD-EFGH');
    await user.click(screen.getByRole('button', { name: 'Join' }));
    expect(path()).toBe(`/c/${NEW}`);
    expect(fake.callsOf('selectCommunity').map(c => c.communityId)).toEqual([A]);
    act(() => fake.set('communities', [{ id: A, name: 'Midgard' }, { id: B, name: 'Valhalla' }, { id: NEW, name: 'Asgard' }]));
    expect(path()).toBe(`/c/${NEW}`);
    expect(fake.callsOf('selectCommunity').map(c => c.communityId)).toEqual([A, NEW]);
  });
  it('opens the join dialog prefilled when an invite link is followed while signed in', () => {
    // channels: false keeps the default-channel redirect out of this test: the route stops at the first server.
    setup('/welcome?invite=ABCD', { channels: false });
    expect(screen.getByRole('dialog', { name: 'Join a server' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Invite' })).toHaveValue('ABCD');
    expect(path()).toBe(`/c/${A}`);
    expect(window.location.search).toBe('');
  });
  it('opens the same dialog without a server and leaves the address at /', () => {
    setup('/welcome?invite=ABCD', { communities: [] });
    expect(screen.getByRole('dialog', { name: 'Join a server' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Invite' })).toHaveValue('ABCD');
    expect(path()).toBe('/');
    expect(window.location.search).toBe('');
  });
  // Pre-flight ruling (g): the join refused right after signup (task 23) rides on the history entry and is shown on open.
  it('shows the join refused at signup in the dialog it opens', () => {
    const joinError = { code: 'E_INVITE_INVALID', detail: '', status: 410, retryAfterMs: null };
    setup('/welcome?invite=ABCD', { communities: [], state: joinErrorState(joinError) });
    expect(screen.getByRole('textbox', { name: 'Invite' })).toHaveValue('ABCD');
    expect(screen.getByRole('textbox', { name: 'Invite' })).toHaveAccessibleDescription(expect.stringContaining('This invite is expired, used up or unknown.'));
    expect(path()).toBe('/');
    expect(window.history.state).toBeNull();
  });
});

// BACKUPS-RECOVERY-04: E_ROOT_MISMATCH is an alert, not a log line: it stands in the shell while the worker reports it.
describe('a recovery root this account did not seal', () => {
  const TEXT = 'The recovery data stored for this account on dilla.test is not this account’s. The recovery key will not work until the operator resets it.';
  it('shows a persistent danger banner while the account slice reports it, and none otherwise', async () => {
    const { fake, view } = setup(`/c/${A}/${GEN}`, { before: f => f.set('account', account({ rootMismatch: true })) });
    const alert = screen.getByText(TEXT).closest('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert).toHaveAttribute('data-tone', 'danger');
    expect(within(alert as HTMLElement).queryByRole('button')).toBeNull();
    await expectNoAxeViolations(view.container);
    act(() => fake.set('account', account({ rootMismatch: false })));
    expect(screen.queryByText(TEXT)).toBeNull();
  });
});

describe('connection', () => {
  it('shows the offline banner and the status bar facts', () => {
    const { fake } = setup(`/c/${A}/${GEN}`);
    const bar = screen.getByRole('region', { name: 'connection' });
    expect(bar).toHaveTextContent('dilla.test');
    expect(bar).toHaveTextContent('online');
    expect(bar).toHaveTextContent('7');
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => fake.set('connection', { status: 'connecting', generation: null }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(bar).toHaveTextContent('connecting');
    expect(bar).toHaveTextContent('–');
    act(() => fake.set('connection', { status: 'offline', generation: '7' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Connection lost. Reconnecting…');
    expect(bar).toHaveTextContent('offline');
    act(() => fake.set('connection', { status: 'online', generation: '8' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the newer-client banner, not the offline one, while the server refuses the client version', () => {
    const OFFLINE = 'Connection lost. Reconnecting…';
    const TOO_OLD = 'This server needs a newer client. Reload the page.';
    const { fake } = setup(`/c/${A}/${GEN}`);
    act(() => fake.set('connection', { status: 'offline', generation: '7', reason: 'version' }));
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent(TOO_OLD);
    expect(screen.queryByText(OFFLINE)).toBeNull();
    expect(screen.getByRole('region', { name: 'connection' })).toHaveTextContent('offline');
    act(() => fake.set('connection', { status: 'offline', generation: '7' }));
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent(OFFLINE);
    expect(screen.queryByText(TOO_OLD)).toBeNull();
  });
});

describe('keyboard', () => {
  it('moves between channels with Alt+Arrow, clamped at both ends', async () => {
    const { user } = setup(`/c/${A}/${GEN}`);
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(path()).toBe(`/c/${A}/${RAND}`);
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(path()).toBe(`/c/${A}/${READ}`);
    for (let i = 0; i < 4; i++) await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(path()).toBe(`/c/${A}/${VOICE}`);
    await user.keyboard('{ArrowDown}');
    expect(path()).toBe(`/c/${A}/${VOICE}`);
  });
  it('returns from the log to the composer on Escape', async () => {
    const { fake, user } = setup(`/c/${A}/${GEN}`);
    act(() => fake.set(`timeline:${GEN}`, timeline({ items: [item({ key: 's1', body: 'x' })] })));
    act(() => screen.getByRole('log').focus());
    expect(screen.getByRole('log')).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(composer()).toHaveFocus();
  });
  it('returns to a blocked composer too, so its reason is heard', async () => {
    const { fake, user } = setup(`/c/${A}/${GEN}`);
    act(() => fake.set(`timeline:${GEN}`, timeline({ group: 'not-member', items: [item({ key: 's1', body: 'x' })] })));
    act(() => screen.getByRole('log').focus());
    await user.keyboard('{Escape}');
    expect(composer()).toHaveFocus();
    expect(composer()).toHaveAttribute('aria-disabled', 'true');
  });
  it('tabs through skip link, rail, sidebar tabs, channels, the pins button, the active row and the composer in that order', async () => {
    const { fake, user } = setup(`/c/${A}/${GEN}`);
    act(() => fake.set(`timeline:${GEN}`, timeline({ items: [item({ key: 's1', body: 'x' })] })));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'skip to messages' }));
    await user.tab();
    expect(screen.getByRole('navigation', { name: 'servers' })).toContainElement(document.activeElement as HTMLElement);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'channels' }));
    await user.tab();
    expect(screen.getByRole('tabpanel', { name: 'channels' })).toContainElement(document.activeElement as HTMLElement);
    await user.tab();
    const header = document.querySelector<HTMLElement>('.d-channel-header');
    if (header === null) throw new Error('no header');
    expect(document.activeElement).toBe(within(header).getByRole('button', { name: 'pinned' }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('article'));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'attach files' }));
    await user.tab();
    expect(composer()).toHaveFocus();
  });
  // Requirement 11: closing the join dialog puts focus in the composer.
  it('moves focus to the composer when the join dialog closes', async () => {
    const { user } = setup(`/c/${A}/${GEN}`);
    await user.click(screen.getByRole('button', { name: 'join a server' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(composer()).toHaveFocus();
  });
});

const DM = '9a'.repeat(16);
const DMS: DmSummary[] = [{ id: DM, kind: 3, members: [ME.id, PEER], name: 'bob', group: 'active' }];
const withDms = (fake: FakeClient) => fake.set('dms', DMS);

describe('direct messages', () => {
  it('is one list: the server name, then the tabs, then the active tab’s rows', async () => {
    const { user, view } = setup(`/c/${A}/${GEN}`, { before: withDms });
    const sidebar = screen.getByRole('navigation', { name: 'channels' });
    const name = within(sidebar).getByRole('heading', { level: 1, name: 'Midgard' });
    const tabs = within(sidebar).getByRole('tablist', { name: 'sidebar' });
    const panel = within(sidebar).getByRole('tabpanel', { name: 'channels' });
    expect(name.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tabs.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole('tablist')).toHaveLength(1);
    expect(within(tabs).getByRole('tab', { name: 'channels' })).toHaveAttribute('aria-selected', 'true');
    expect(within(panel).getByRole('button', { name: 'general' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'message someone' })).toBeNull();
    await user.click(within(tabs).getByRole('tab', { name: 'direct messages' }));
    expect(path()).toBe(`/c/${A}/${GEN}`);
    const list = screen.getByRole('navigation', { name: 'direct messages' });
    expect(within(list).getByRole('heading', { level: 1, name: 'Midgard' })).toBeInTheDocument();
    expect(screen.getAllByRole('tablist')).toHaveLength(1);
    expect(within(screen.getByRole('tabpanel', { name: 'direct messages' })).getByRole('button', { name: 'message someone' })).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: 'bob' })).toHaveAttribute('data-kind', 'dm');
    await expectNoAxeViolations(view.container);
    await user.click(within(list).getByRole('button', { name: 'bob' }));
    expect(path()).toBe(`/dm/${DM}`);
  });
  // WORKER-WEB-02: DMs belong to no server, so they stay reachable when no server is listed.
  it('with no server, the sidebar opens on the DMs and the channels tab says there is no server', async () => {
    const { user, view } = setup('/', { communities: [], before: withDms });
    const sidebar = screen.getByRole('navigation', { name: 'direct messages' });
    expect(within(sidebar).getByRole('heading', { level: 1, name: 'dilla.test' })).toBeInTheDocument();
    expect(within(sidebar).getByRole('tab', { name: 'direct messages' })).toHaveAttribute('aria-selected', 'true');
    expect(within(sidebar).getByRole('button', { name: 'bob' })).toBeInTheDocument();
    await expectNoAxeViolations(view.container);
    await user.click(within(sidebar).getByRole('tab', { name: 'channels' }));
    const panel = screen.getByRole('tabpanel', { name: 'channels' });
    expect(within(panel).getByRole('heading', { name: 'You are not in a server yet' })).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Join a server' }));
    expect(screen.getByRole('dialog', { name: 'Join a server' })).toBeInTheDocument();
  });
  it('with no server, a DM route keeps the sidebar and the other DMs', () => {
    setup(`/dm/${DM}`, { communities: [], before: withDms });
    expect(screen.getByRole('tab', { name: 'direct messages' })).toHaveAttribute('aria-selected', 'true');
    expect(within(screen.getByRole('navigation', { name: 'direct messages' })).getByRole('button', { name: 'bob' }))
      .toHaveAttribute('aria-current', 'page');
  });
  // A11Y-DESIGN-02: a server that did not load is said inside the channels tab panel; the DMs tab stays a tab.
  it('a server that did not load keeps the tabs, and the DMs tab still lists the DMs', async () => {
    const { fake, user } = setupWith(c => (c.m === 'selectCommunity' ? Promise.reject(refusal({ code: 'E_NETWORK' })) : Promise.resolve(null)));
    act(() => fake.set('dms', DMS));
    const panel = await screen.findByRole('tabpanel', { name: 'channels' });
    await waitFor(() => expect(within(panel).getByRole('region', { name: 'Midgard' })).toHaveTextContent('This server did not load (E_NETWORK).'));
    await user.click(screen.getByRole('tab', { name: 'direct messages' }));
    expect(within(screen.getByRole('tabpanel', { name: 'direct messages' })).getByRole('button', { name: 'bob' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'channels' }));
    expect(screen.getByRole('button', { name: 'try again' })).toBeInTheDocument();
  });
  it('says when there are none', async () => {
    const { user } = setup(`/c/${A}/${GEN}`, { before: f => f.set('dms', []) });
    await user.click(screen.getByRole('tab', { name: 'direct messages' }));
    expect(screen.getByText('no direct messages yet')).toBeInTheDocument();
  });
  it('opens a DM with its own log and composer, sends into it and closes it when left', async () => {
    const { fake, user, view } = setup(`/dm/${DM}`, { before: withDms });
    expect(fake.callsOf('openChannel')).toEqual([{ m: 'openChannel', channelId: DM }]);
    expect(screen.getByRole('tab', { name: 'direct messages' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { level: 2, name: 'bob' })).toHaveTextContent('[ @ bob ]');
    act(() => fake.set(`timeline:${DM}`, timeline({ channelId: DM, items: [item({ key: 's1', body: 'hey' })] })));
    expect(screen.getByRole('log', { name: 'messages with bob' })).toHaveTextContent('hey');
    await expectNoAxeViolations(view.container);
    // shell.dm.composer is `message @{name}` (pre-flight row 1.10): the name is the composer's untransformed target.
    expect(document.querySelector('.d-composer__target')).toHaveTextContent('@bob');
    await user.type(screen.getByRole('textbox', { name: 'message @bob' }), 'hi bob{Enter}');
    expect(fake.callsOf('send')).toEqual([{ m: 'send', channelId: DM, text: 'hi bob' }]);
    await user.click(screen.getByRole('tab', { name: 'channels' }));
    await user.click(within(screen.getByRole('navigation', { name: 'channels' })).getByRole('button', { name: /^random/ }));
    expect(opens(fake)).toEqual([
      { m: 'openChannel', channelId: DM }, { m: 'closeChannel', channelId: DM }, { m: 'openChannel', channelId: RAND },
    ]);
  });
  it('leaves a DM it does not know for the first server', () => {
    setup(`/dm/${'7b'.repeat(16)}`, { before: withDms });
    expect(path()).toBe(`/c/${A}/${GEN}`);
  });
  it('starts a DM with a member of this server', async () => {
    const { fake, user, view } = setup(`/c/${A}/${GEN}`, { before: withDms });
    fake.handler = c => Promise.resolve(c.m === 'openDm' ? { channelId: DM } : null);
    await user.click(screen.getByRole('tab', { name: 'direct messages' }));
    await user.click(screen.getByRole('button', { name: 'message someone' }));
    const dialog = screen.getByRole('dialog', { name: 'Message someone' });
    expect(within(dialog).getByText('Pick a member of this server.')).toBeInTheDocument();
    expect(within(dialog).getByText('bob')).toBeInTheDocument();
    expect(within(dialog).queryByText('Ada L')).toBeNull();
    expect(within(dialog).queryByText('Helper')).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'message' })).toHaveAccessibleDescription('bob');
    await expectNoAxeViolations(view.container);
    await user.click(within(dialog).getByRole('button', { name: 'message' }));
    expect(fake.callsOf('openDm')).toEqual([{ m: 'openDm', userId: PEER }]);
    expect(path()).toBe(`/dm/${DM}`);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('shows a refused DM in its dialog', async () => {
    const { fake, user } = setup(`/c/${A}/${GEN}`, { before: withDms });
    fake.handler = c => (c.m === 'openDm' ? Promise.reject(refusal({ code: 'E_FORBIDDEN', status: 403 })) : Promise.resolve(null));
    await user.click(screen.getByRole('tab', { name: 'direct messages' }));
    await user.click(screen.getByRole('button', { name: 'message someone' }));
    await user.click(screen.getByRole('button', { name: 'message' }));
    expect(within(screen.getByRole('dialog', { name: 'Message someone' })).getByRole('alert'))
      .toHaveTextContent('That did not work (E_FORBIDDEN). Try again, or reload the page.');
    expect(path()).toBe(`/c/${A}/${GEN}`);
  });
});

describe('badges', () => {
  const HALL = 'b9'.repeat(16);
  const badged = (badges: Record<string, { unread: number; mentions: number }>, settings: Record<string, string> = {}) => (fake: FakeClient) => {
    fake.set(`channels:${B}`, [ch(HALL, 'hall', { communityId: B })]);
    fake.set('badges', badges);
    fake.set('settings', settings);
    withDms(fake);
  };
  it('badges rows, the rail and the tabs, and names them by their counts', async () => {
    const { view } = setup(`/c/${A}/${GEN}`, { before: badged({ [RAND]: { unread: 3, mentions: 0 }, [HALL]: { unread: 2, mentions: 1 }, [DM]: { unread: 1, mentions: 0 } }) });
    const list = screen.getByRole('navigation', { name: 'channels' });
    expect(within(list).getByRole('button', { name: 'random, unread 3, mentions 0' })).toHaveAttribute('data-unread', '3');
    expect(within(list).getByRole('button', { name: 'general' })).toHaveAttribute('data-unread', '0');
    const rail = screen.getByRole('navigation', { name: 'servers' });
    expect(within(rail).getByRole('button', { name: 'Midgard, unread 3, mentions 0' })).toBeInTheDocument();
    expect(within(rail).getByRole('button', { name: 'Valhalla, unread 2, mentions 1' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^channels/ })).toHaveAttribute('data-count', '3');
    expect(screen.getByRole('tab', { name: /^direct messages/ })).toHaveAttribute('data-count', '1');
    await expectNoAxeViolations(view.container);
  });
  it('hides a muted channel’s unread count and keeps its mentions', () => {
    setup(`/c/${A}/${GEN}`, { before: badged({ [RAND]: { unread: 3, mentions: 1 } }, { [`mute.channel.${RAND}`]: '1' }) });
    expect(within(screen.getByRole('navigation', { name: 'channels' })).getByRole('button', { name: 'random, muted, mentions 1' })).toHaveAttribute('data-unread', '0');
    expect(within(screen.getByRole('navigation', { name: 'servers' })).getByRole('button', { name: 'Midgard, unread 0, mentions 1' })).toBeInTheDocument();
  });
  it('follows the badge slice', () => {
    const { fake } = setup(`/c/${A}/${GEN}`, { before: badged({}) });
    expect(within(screen.getByRole('navigation', { name: 'channels' })).getByRole('button', { name: /^random$/ })).toBeInTheDocument();
    act(() => fake.set('badges', { [RAND]: { unread: 1, mentions: 0 } }));
    expect(within(screen.getByRole('navigation', { name: 'channels' })).getByRole('button', { name: 'random, unread 1, mentions 0' })).toBeInTheDocument();
  });
});

describe('reading', () => {
  let shown: DocumentVisibilityState = 'visible';
  beforeEach(() => {
    shown = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => shown });
  });
  afterEach(() => { delete (document as Partial<Record<'visibilityState', unknown>>).visibilityState; });

  it('marks the open channel read while it shows something unread, once per change', () => {
    const { fake } = setup(`/c/${A}/${GEN}`);
    act(() => fake.set(`timeline:${GEN}`, timeline({ items: [item({ key: 's1', body: 'a' })] })));
    expect(fake.callsOf('markRead')).toEqual([]);
    act(() => fake.set('badges', { [GEN]: { unread: 1, mentions: 0 } }));
    expect(fake.callsOf('markRead')).toEqual([{ m: 'markRead', channelId: GEN }]);
    act(() => fake.set('badges', { [GEN]: { unread: 1, mentions: 0 } }));
    expect(fake.callsOf('markRead')).toHaveLength(1);
    act(() => fake.set('badges', { [GEN]: { unread: 0, mentions: 0 } }));
    act(() => fake.set(`timeline:${GEN}`, timeline({ items: [item({ key: 's1', body: 'a' }), item({ key: 's2', body: 'b' })] })));
    act(() => fake.set('badges', { [GEN]: { unread: 1, mentions: 0 } }));
    expect(fake.callsOf('markRead')).toHaveLength(2);
  });
  it('waits while the page is hidden and marks when it is shown', () => {
    const { fake } = setup(`/c/${A}/${GEN}`);
    shown = 'hidden';
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    act(() => fake.set(`timeline:${GEN}`, timeline({ items: [item({ key: 's1', body: 'a' })] })));
    act(() => fake.set('badges', { [GEN]: { unread: 2, mentions: 1 } }));
    expect(fake.callsOf('markRead')).toEqual([]);
    shown = 'visible';
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(fake.callsOf('markRead')).toEqual([{ m: 'markRead', channelId: GEN }]);
  });
  // Added to the brief's tests (red proof (c)): the effect's dependency list already skips a republished badge with
  // the same counts, so only a change of another dependency (the page hidden and shown again) reaches the ref check.
  it('does not mark again when the page is shown again with nothing new', () => {
    const { fake } = setup(`/c/${A}/${GEN}`);
    act(() => fake.set(`timeline:${GEN}`, timeline({ items: [item({ key: 's1', body: 'a' })] })));
    act(() => fake.set('badges', { [GEN]: { unread: 1, mentions: 0 } }));
    expect(fake.callsOf('markRead')).toEqual([{ m: 'markRead', channelId: GEN }]);
    shown = 'hidden';
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    shown = 'visible';
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(fake.callsOf('markRead')).toHaveLength(1);
  });
  it('never marks a channel that is not open', () => {
    const { fake } = setup(`/c/${A}/${GEN}`);
    act(() => fake.set(`timeline:${GEN}`, timeline({ items: [item({ key: 's1', body: 'a' })] })));
    act(() => fake.set('badges', { [RAND]: { unread: 5, mentions: 1 } }));
    expect(fake.callsOf('markRead')).toEqual([]);
  });
  it('marks an open DM too', () => {
    const { fake } = setup(`/dm/${DM}`, { before: withDms });
    act(() => fake.set(`timeline:${DM}`, timeline({ channelId: DM, items: [item({ key: 's1', body: 'a' })] })));
    act(() => fake.set('badges', { [DM]: { unread: 1, mentions: 0 } }));
    expect(fake.callsOf('markRead')).toEqual([{ m: 'markRead', channelId: DM }]);
  });
});

describe('devices and settings', () => {
  const dev = (id: string, revokedAt: number | null): DeviceSummary =>
    ({ id, tier: 1, signerTier: 1, lastSeen: NOW, revokedAt, listed: true, own: id === 'cc'.repeat(16) });
  it('asks for the device list once and shows how many devices the account has', () => {
    const { fake } = setup(`/c/${A}/${GEN}`);
    expect(fake.callsOf('refreshDevices')).toEqual([{ m: 'refreshDevices' }]);
    const chunk = () => within(screen.getByRole('region', { name: 'connection' })).getByText('devices').closest('.d-chunk');
    expect(chunk()).toHaveTextContent('–');
    act(() => fake.set('devices', [dev('cc'.repeat(16), null), dev('d1'.repeat(16), null), dev('e2'.repeat(16), NOW)]));
    expect(chunk()).toHaveTextContent('2');
  });
  it('opens settings from the rail, remembering the channel', async () => {
    const { user } = setup(`/c/${A}/${GEN}`);
    await user.click(within(screen.getByRole('navigation', { name: 'servers' })).getByRole('button', { name: 'settings' }));
    expect(path()).toBe('/settings/devices');
    expect(window.history.state).toEqual({ settingsFrom: `/c/${A}/${GEN}` });
  });
  it('keeps the shell where it was while settings is open over it', () => {
    const { fake } = setup('/settings/notifications', { state: { settingsFrom: `/c/${A}/${RAND}` } });
    expect(path()).toBe('/settings/notifications');
    expect(fake.callsOf('selectCommunity')).toEqual([{ m: 'selectCommunity', communityId: A }]);
    expect(fake.callsOf('openChannel')).toEqual([{ m: 'openChannel', channelId: RAND }]);
  });
  it('goes nowhere under a deep link to settings', () => {
    setup('/settings/devices');
    expect(path()).toBe('/settings/devices');
  });
});

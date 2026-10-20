import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { ChannelList, type ChannelListProps } from './ChannelList.tsx';
import { SidebarTabs } from '../SidebarTabs/SidebarTabs.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

const CHANNELS = [
  { id: 'g', name: 'general', kind: 'text', readable: false },
  { id: 'l', name: 'lfg', kind: 'text', readable: true },
  { id: 't', name: 'loot', kind: 'text', readable: false },
  { id: 'v', name: 'longhouse', kind: 'voice', readable: false },
] as const;
const BADGED: ChannelListProps['channels'] = [
  { id: 'g', name: 'general', kind: 'text', readable: false, unread: 3 },
  { id: 't', name: 'loot', kind: 'text', readable: false, unread: 2, mentions: 2 },
  { id: 'r', name: 'random', kind: 'text', readable: false, unread: 5, muted: true },
  { id: 'l', name: 'lfg', kind: 'text', readable: false },
];
// L-COPY-02 shell.channels.rowLabel and shell.channels.rowLabelMuted, filled in as en.ts's t() will.
const rowLabel = (c: { name: string; unread: number; mentions: number; muted: boolean }) =>
  c.muted ? `${c.name}, muted, mentions ${c.mentions}` : `${c.name}, unread ${c.unread}, mentions ${c.mentions}`;
const tabs = <SidebarTabs label="sidebar" activeId="channels" onSelect={() => {}}
  tabs={[{ id: 'channels', label: 'channels' }, { id: 'dms', label: 'direct messages' }]} />;

function props(over: Partial<ChannelListProps> = {}): ChannelListProps {
  return { label: 'channels', title: 'Midgard Crew', channels: CHANNELS, activeId: 't', onSelect: vi.fn(), emptyLabel: 'No channels yet.', ...over };
}

describe('ChannelList', () => {
  it('marks a title that is not the server name as plain, so it is set in mono rather than the display serif', () => {
    const { rerender } = render(<ChannelList {...props()} />);
    expect(screen.getByRole('heading', { level: 1 })).not.toHaveAttribute('data-kind');
    rerender(<ChannelList {...props({ title: 'direct messages', titleKind: 'plain' })} />);
    expect(screen.getByRole('heading', { level: 1, name: 'direct messages' })).toHaveAttribute('data-kind', 'plain');
  });
  it('keeps a badge in the row name when the row is unread, mentioned or muted', () => {
    render(<ChannelList {...props({ rowLabel, channels: [
      { id: 'n', name: 'news', kind: 'announcement', readable: false, badge: 'slow mode', unread: 3 },
      { id: 'g', name: 'general', kind: 'text', readable: false, badge: 'slow mode', muted: true, mentions: 1 },
      { id: 'q', name: 'quiet', kind: 'text', readable: false, badge: 'slow mode' },
    ] })} />);
    expect(screen.getByRole('button', { name: 'news, slow mode, unread 3, mentions 0' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'general, slow mode, muted, mentions 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'quiet slow mode' })).toBeInTheDocument();
  });

  it('passes an announcement kind and a badge through to the row (R36)', () => {
    render(<ChannelList {...props({ channels: [
      { id: 'n', name: 'news', kind: 'announcement', readable: false, badge: 'slow mode' },
      { id: 'g', name: 'general', kind: 'text', readable: false },
    ] })} />);
    const row = screen.getByRole('button', { name: 'news slow mode' });
    expect(row).toHaveAttribute('data-kind', 'announcement');
    expect(row.querySelector('svg[data-icon="megaphone"]')).not.toBeNull();
    expect(screen.getByText('slow mode')).toHaveClass('d-chrow__badge');
    expect(screen.getByRole('button', { name: 'general' }).querySelector('.d-chrow__badge')).toBeNull();
  });

  // Controller ruling (e), task 21 pre-flight: the ChannelList title is the shell's <h1>.
  it('is a navigation landmark with the server name as its heading and one row per channel in order', () => {
    render(<ChannelList {...props()} />);
    const nav = screen.getByRole('navigation', { name: 'channels' });
    expect(nav).toHaveClass('d-channel-list');
    expect(within(nav).getByRole('heading', { level: 1, name: 'Midgard Crew' })).toBeInTheDocument();
    const rows = within(nav).getAllByRole('button');
    expect(rows.map(r => r.textContent?.replace(/[#♪]/g, '').trim())).toEqual(['general', 'lfg', 'loot', 'longhouse']);
    expect(screen.getByRole('button', { name: 'loot' })).toHaveAttribute('aria-current', 'page');
    expect(within(screen.getByRole('button', { name: /^lfg/ })).getByRole('img', { name: 'Readable by this server' })).toBeInTheDocument();
  });

  it('is a single tab stop on the active channel, moves with the arrows and selects with Enter', async () => {
    const user = userEvent.setup();
    const p = props();
    render(<><button type="button">before</button><ChannelList {...p} /><button type="button">after</button></>);
    await user.tab();
    await user.tab();
    expect(screen.getByRole('button', { name: 'loot' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'after' })).toHaveFocus();
    await user.tab({ shift: true });
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('button', { name: /^lfg/ })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('button', { name: 'longhouse' })).toHaveFocus();
    await user.keyboard('{Home}{Enter}');
    expect(p.onSelect).toHaveBeenCalledTimes(1);
    expect(p.onSelect).toHaveBeenLastCalledWith('g');
  });

  it('shows the empty label and no list without channels', () => {
    render(<ChannelList {...props({ channels: [], activeId: null })} />);
    expect(screen.getByText('No channels yet.')).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><ChannelList {...props()} /></div>);
    await expectNoAxeViolations(container);
  });

  it('passes the counts and the muted flag to the rows as data and pills', () => {
    render(<ChannelList {...props({ channels: BADGED, activeId: 'l' })} />);
    const general = screen.getByRole('button', { name: 'general 3 unread' });
    expect([general.getAttribute('data-unread'), general.getAttribute('data-mentions')]).toEqual(['3', '0']);
    const loot = screen.getByRole('button', { name: 'loot 2 mentions' });
    expect([loot.getAttribute('data-unread'), loot.getAttribute('data-mentions')]).toEqual(['2', '2']);
    const random = screen.getByRole('button', { name: 'random' });
    expect([random.getAttribute('data-unread'), random.getAttribute('data-muted')]).toEqual(['0', 'true']);
    expect(screen.getByRole('button', { name: 'lfg' })).toHaveAttribute('data-unread', '0');
  });

  it('names a row by rowLabel only when it has something to report', () => {
    const spy = vi.fn(rowLabel);
    render(<ChannelList {...props({ channels: BADGED, activeId: 'l', rowLabel: spy })} />);
    expect(screen.getByRole('button', { name: 'general, unread 3, mentions 0' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'loot, unread 2, mentions 2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'random, muted, mentions 0' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'lfg' })).not.toHaveAttribute('aria-label');
    expect(spy).toHaveBeenCalledWith({ name: 'general', unread: 3, mentions: 0, muted: false });
    expect(spy).toHaveBeenCalledWith({ name: 'random', unread: 5, mentions: 0, muted: true });
    expect(spy.mock.calls.map(c => c[0].name)).not.toContain('lfg');
  });

  it('caps the pill at 99+ while the name carries the full count', () => {
    render(<ChannelList {...props({ channels: [{ id: 'g', name: 'general', kind: 'text', readable: false, unread: 150 }], activeId: 'g' })} />);
    const row = screen.getByRole('button', { name: 'general 150 unread' });
    expect(within(row).getByText('99+')).toHaveAttribute('aria-hidden', 'true');
    expect(row).toHaveAttribute('data-unread', '150');
  });

  it('lists direct messages as dm rows', () => {
    render(<ChannelList {...props({ label: 'direct messages', activeId: 'd2', channels: [
      { id: 'd1', name: 'ada', kind: 'dm', readable: false, unread: 2 },
      { id: 'd2', name: 'björn', kind: 'dm', readable: false },
    ] })} />);
    const nav = screen.getByRole('navigation', { name: 'direct messages' });
    expect(within(nav).getAllByRole('button').map(r => r.getAttribute('data-kind'))).toEqual(['dm', 'dm']);
    expect(screen.getByRole('button', { name: 'björn' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'ada 2 unread' })).toBeInTheDocument();
  });

  it('holds the tabs between the heading and a tab panel named like the list', () => {
    render(<ChannelList {...props({ tabs })} />);
    const heading = screen.getByRole('heading', { level: 1, name: 'Midgard Crew' });
    const tablist = screen.getByRole('tablist', { name: 'sidebar' });
    const panel = screen.getByRole('tabpanel', { name: 'channels' });
    expect(heading.compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tablist.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(panel).getAllByRole('button')).toHaveLength(4);
  });

  it('renders the footer inside the tab panel after the list, and after the empty label', () => {
    const footer = <button type="button">message someone</button>;
    const { rerender } = render(<ChannelList {...props({ tabs, footer })} />);
    const panel = screen.getByRole('tabpanel', { name: 'channels' });
    const button = within(panel).getByRole('button', { name: 'message someone' });
    expect(button.parentElement).toHaveClass('d-channel-list__footer');
    expect(within(panel).getByRole('list').compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(panel).getByRole('list')).not.toContainElement(button);
    rerender(<ChannelList {...props({ tabs, footer, channels: [], activeId: null })} />);
    const empty = within(screen.getByRole('tabpanel', { name: 'channels' })).getByText('No channels yet.');
    const again = screen.getByRole('button', { name: 'message someone' });
    expect(empty.compareDocumentPosition(again) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // WORKER-WEB-02, A11Y-DESIGN-02: a server that did not load, or no server at all, is said inside the tab panel, so the
  // tabs stay and the other tab can still be chosen.
  it('puts content in place of the rows inside the tab panel, keeping the tabs', () => {
    render(<ChannelList {...props({ tabs, content: <section aria-label="Midgard"><p>did not load</p></section> })} />);
    expect(screen.getByRole('tablist', { name: 'sidebar' })).toBeInTheDocument();
    const panel = screen.getByRole('tabpanel', { name: 'channels' });
    expect(within(panel).getByRole('region', { name: 'Midgard' })).toHaveTextContent('did not load');
    expect(within(panel).queryByRole('list')).toBeNull();
    expect(screen.queryByText('No channels yet')).toBeNull();
  });

  it('has no tab panel without tabs and no footer without one', () => {
    const { container } = render(<ChannelList {...props()} />);
    expect(screen.queryByRole('tabpanel')).toBeNull();
    expect(container.querySelector('.d-channel-list__footer')).toBeNull();
  });

  // v0.1.0-web3.1, flow 07: the server's own actions (a new channel, an invite link) stand beside its heading, before the
  // tabs and outside the rows' roving group, each its own tab stop.
  it('puts the actions in a group named for the server, after the heading and before the tabs', async () => {
    const user = userEvent.setup();
    const onNew = vi.fn();
    const actions = <><button type="button" onClick={onNew}>new channel</button><button type="button">invite link</button></>;
    render(<ChannelList {...props({ tabs, actions, actionsLabel: 'Midgard Crew actions' })} />);
    const nav = screen.getByRole('navigation', { name: 'channels' });
    const toolbar = within(nav).getByRole('group', { name: 'Midgard Crew actions' });
    const heading = within(nav).getByRole('heading', { level: 1 });
    const tablist = within(nav).getByRole('tablist');
    expect(heading.compareDocumentPosition(toolbar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(toolbar.compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(toolbar).getAllByRole('button').map(b => b.textContent)).toEqual(['new channel', 'invite link']);
    await user.tab();
    expect(within(toolbar).getByRole('button', { name: 'new channel' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it('puts a headerAction in one row with the heading, after it', () => {
    render(<ChannelList {...props({ headerAction: <button type="button">server menu</button> })} />);
    const head = screen.getByRole('heading', { level: 1 }).parentElement as HTMLElement;
    expect(head).toHaveClass('d-channel-list__head');
    expect(head.lastElementChild).toBe(screen.getByRole('button', { name: 'server menu' }));
  });

  it('without a headerAction the heading has no wrapper', () => {
    render(<ChannelList {...props()} />);
    expect(screen.getByRole('heading', { level: 1 }).parentElement).toHaveClass('d-channel-list');
  });

  it('draws no action group without actions', () => {
    render(<ChannelList {...props({ tabs })} />);
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('has no serious axe violations with badges, a muted row and tabs', async () => {
    const { container } = render(<div className="d-root"><ChannelList {...props({ channels: BADGED, activeId: 'l', rowLabel, tabs, footer: <button type="button">message someone</button> })} /></div>);
    await expectNoAxeViolations(container);
  });
});

// web3.8 (U3, items 12 and 15): one list with the voice channels nested in place.
describe('ChannelList, one list with voice rooms in place', () => {
  const state = { speaking: 'speaking', muted: 'muted', deafened: 'deafened', notHeard: 'not heard yet', unverified: 'unverified stream', connecting: 'connecting', video: 'camera on', screen: 'sharing screen', web: 'web', bot: 'bot' };
  const person = (name: string, more: Record<string, unknown> = {}) => ({
    deviceId: `d-${name}`, userId: `u-${name}`, name, state: 'ok' as const, speaking: false, muted: false, deafened: false, video: false, screen: false, web: true, bot: false, ...more,
  });
  const mixed: ChannelListProps['channels'] = [
    { id: 'g', name: 'general', kind: 'text', readable: false, unread: 2 },
    { id: 'v1', name: 'harbour', kind: 'voice', readable: false, unread: 3, mentions: 1 },
    { id: 'n', name: 'news', kind: 'announcement', readable: false },
    { id: 'v2', name: 'workshop', kind: 'voice', readable: false },
    { id: 'l', name: 'lfg', kind: 'text', readable: false },
  ];
  const voice = (over: Partial<NonNullable<ChannelListProps['voice']>> = {}): NonNullable<ChannelListProps['voice']> => ({
    labels: { open: 'voice {name}', count: '{n} in voice', canHear: 'can hear', join: 'join voice', state }, iconJoin: true,
    rooms: { v1: { joined: false, participants: [person('ada', { speaking: true }), person('bo', { muted: true })] } },
    onJoin: vi.fn(), ...over,
  });

  it('keeps the input order in one list, voice rows interleaved with text and announcement rows', () => {
    const { container } = render(<ChannelList {...props({ channels: mixed, voice: voice(), activeId: 'g' })} />);
    expect(container.querySelectorAll('ul[role="list"].d-channel-list__list')).toHaveLength(1);
    const items = [...container.querySelectorAll('.d-channel-list__list > li')];
    const rows = items.map(li => li.querySelector(':scope > button')!);
    expect(rows.map(r => r.getAttribute('aria-label') ?? r.textContent)).toEqual([expect.stringContaining('general'), 'voice harbour',
      expect.stringContaining('news'), 'voice workshop', expect.stringContaining('lfg')]);
    expect(rows.map(r => r.classList.contains('d-voice-row'))).toEqual([false, true, false, true, false]);
  });

  it('the voice row has the volume-2 icon and no badge, even with unread: 3 (guard, green at start: the voice branch never passed one)', () => {
    render(<ChannelList {...props({ channels: mixed, voice: voice(), rowLabel })} />);
    const row = screen.getByRole('button', { name: 'voice harbour' });
    expect(row.querySelector('svg')).toHaveAttribute('data-icon', 'volume-2');
    expect(row.querySelector('.d-chrow__badge, .d-chrow__count, .d-chrow__mention')).toBeNull();
    expect(row.querySelector('.d-voice-row__name')?.textContent).toBe('harbour');
  });

  it('nests the participants under their own row', () => {
    const { container } = render(<ChannelList {...props({ channels: mixed, voice: voice() })} />);
    const li = screen.getByRole('button', { name: 'voice harbour' }).closest('li')!;
    expect([...li.querySelectorAll('.d-voice-row__person-name')].map(n => n.textContent)).toEqual(['ada', 'bo']);
    expect(container.querySelectorAll('.d-voice-row__person')).toHaveLength(2);
  });

  it('while a voice row is not joined, it has a join voice button whose tab index follows the stop', async () => {
    const onJoin = vi.fn();
    render(<ChannelList {...props({ channels: mixed, voice: voice({ onJoin }), activeId: 'v1' })} />);
    const joins = screen.getAllByRole('button', { name: 'join voice' });
    expect(joins).toHaveLength(2);
    const harbour = screen.getByRole('button', { name: 'voice harbour' });
    expect(harbour.tabIndex).toBe(0);
    expect(joins.map(j => j.tabIndex)).toEqual([0, -1]);
    expect(joins[0].closest('.d-slot')).not.toBeNull();
    await userEvent.keyboard('{Tab}{ArrowDown}{ArrowDown}');
    expect(screen.getByRole('button', { name: 'voice workshop' })).toHaveFocus();
    expect(screen.getAllByRole('button', { name: 'join voice' }).map(j => j.tabIndex)).toEqual([-1, 0]);
    await userEvent.click(screen.getAllByRole('button', { name: 'join voice' })[1]);
    expect(onJoin).toHaveBeenCalledWith('v2');
  });

  it('a joined or held room has no join button, and without onJoin there is none at all', () => {
    const { rerender } = render(<ChannelList {...props({ channels: mixed, voice: voice({ rooms: { v1: { joined: true, participants: [] }, v2: { joined: false, held: true, participants: [] } } }) })} />);
    expect(screen.queryByRole('button', { name: 'join voice' })).toBeNull();
    rerender(<ChannelList {...props({ channels: mixed, voice: voice({ onJoin: undefined }) })} />);
    expect(screen.queryByRole('button', { name: 'join voice' })).toBeNull();
  });

  it('no listAction means no list-header "+" row; a legacy caller that passes one still gets it (removed in WEB-LIST)', () => {
    const { container, rerender } = render(<ChannelList {...props({ channels: mixed, voice: voice(), tabs })} />);
    expect(container.querySelector('.d-channel-list__list-head')).toBeNull();
    rerender(<ChannelList {...props({ channels: mixed, voice: voice(), tabs, listAction: <button type="button">new channel</button> })} />);
    expect(screen.getByRole('button', { name: 'new channel' }).closest('.d-channel-list__list-head')).not.toBeNull();
  });
  it('without iconJoin the join is the legacy text button, described by the channel (removed in WEB-LIST)', () => {
    render(<ChannelList {...props({ channels: mixed, voice: voice({ iconJoin: undefined }), activeId: 'v1' })} />);
    const join = screen.getAllByRole('button', { name: 'join voice' })[0];
    expect(join).not.toHaveAttribute('aria-label');
    expect(join).toHaveAccessibleDescription('harbour');
    expect(join.closest('.d-slot')).toBeNull();
  });
});

// web3.9 (UI-2): categories, collapse and the "+" on a header.
describe('ChannelList, categories', () => {
  const channels: ChannelListProps['channels'] = [
    { id: 'top', name: 'welcome', kind: 'text', readable: false },
    { id: 'r1', name: 'plans', kind: 'text', readable: false, parentId: 'raids' },
    { id: 'r2', name: 'loot', kind: 'text', readable: false, parentId: 'raids' },
    { id: 'r3', name: 'bosses', kind: 'text', readable: false, parentId: 'raids', unread: 2 },
    { id: 'r4', name: 'war room', kind: 'voice', readable: false, parentId: 'raids', joined: true },
    { id: 'l1', name: 'general', kind: 'text', readable: false, parentId: 'lounge' },
    { id: 'l2', name: 'music', kind: 'text', readable: false, parentId: 'lounge' },
    { id: 'o', name: 'orphan', kind: 'text', readable: false, parentId: 'gone' },
  ];
  const categories = [{ id: 'raids', name: 'raids', collapsed: true }, { id: 'lounge', name: 'lounge', collapsed: false }];
  const names = () => [...document.querySelectorAll('.d-channel-list__list > li')].map(li => li.querySelector('.d-chrow__name, .d-channel-list__cat-label, .d-voice-row__name')?.textContent);
  const voice = { labels: { open: 'voice {name}', count: '{n} in voice', canHear: 'can hear', join: 'join voice',
    state: { speaking: 'speaking', muted: 'muted', deafened: 'deafened', notHeard: 'not heard yet', unverified: 'unverified stream', connecting: 'connecting', video: 'camera on', screen: 'sharing screen', web: 'web', bot: 'bot' } },
    rooms: {} };

  it('renders the top-level rows first, then each category header with its children, a collapsed one keeping only its active, unread and joined rows', () => {
    render(<ChannelList {...props({ channels, categories, voice, activeId: 'r2' })} />);
    expect(names()).toEqual(['welcome', 'orphan', 'raids', 'loot', 'bosses', 'war room', 'lounge', 'general', 'music']);
  });
  it('a collapsed category with nothing to keep shows its header alone, and an expanded one all its rows', () => {
    render(<ChannelList {...props({ channels: channels.filter(c => c.id !== 'r3' && c.id !== 'r4'), categories, activeId: 'top' })} />);
    expect(names()).toEqual(['welcome', 'orphan', 'raids', 'lounge', 'general', 'music']);
  });
  it('a mention keeps a row of a collapsed category too', () => {
    render(<ChannelList {...props({ channels: channels.map(c => c.id === 'r1' ? { ...c, mentions: 1 } : c), categories, activeId: 'top' })} />);
    expect(names()).toContain('plans');
    expect(names()).not.toContain('loot');
  });
  it('the header is a button with aria-expanded, and Enter on it calls onToggleCategory', async () => {
    const user = userEvent.setup();
    const onToggleCategory = vi.fn();
    render(<ChannelList {...props({ channels, categories, onToggleCategory, activeId: 'top' })} />);
    const raids = screen.getByRole('button', { name: 'raids' });
    const lounge = screen.getByRole('button', { name: 'lounge' });
    expect(raids).toHaveAttribute('aria-expanded', 'false');
    expect(lounge).toHaveAttribute('aria-expanded', 'true');
    raids.focus();
    await user.keyboard('{Enter}');
    expect(onToggleCategory).toHaveBeenCalledWith('raids');
    await user.click(lounge);
    expect(onToggleCategory).toHaveBeenLastCalledWith('lounge');
  });
  it('a header is a stop of the one roving group', async () => {
    const user = userEvent.setup();
    render(<ChannelList {...props({ channels, categories, activeId: 'top' })} />);
    expect(screen.getAllByRole('button').filter(b => b.tabIndex === 0)).toHaveLength(1);
    await user.keyboard('{Tab}{ArrowDown}{ArrowDown}');
    expect(screen.getByRole('button', { name: 'raids' })).toHaveFocus();
  });
  it('has no list-header "+" row, and the header "+" exists only with onAddInCategory, named by addInCategoryLabel', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ChannelList {...props({ channels, categories, activeId: 'top' })} />);
    expect(screen.queryByRole('button', { name: /add|new|\+/ })).toBeNull();
    const onAddInCategory = vi.fn();
    rerender(<ChannelList {...props({ channels, categories, activeId: 'top', onAddInCategory, addInCategoryLabel: n => `new channel in ${n}` })} />);
    expect(screen.getAllByRole('button', { name: /^new channel in/ })).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'new channel in lounge' }));
    expect(onAddInCategory).toHaveBeenCalledWith('lounge');
  });
  it('the header\'s "+" follows the stop row\'s tab index', async () => {
    const user = userEvent.setup();
    render(<ChannelList {...props({ channels, categories, activeId: 'top', onAddInCategory: () => {}, addInCategoryLabel: n => `new channel in ${n}` })} />);
    const plus = screen.getAllByRole('button', { name: /^new channel in/ });
    expect(plus.map(b => b.tabIndex)).toEqual([-1, -1]);
    await user.keyboard('{Tab}{ArrowDown}{ArrowDown}');
    expect(screen.getAllByRole('button', { name: /^new channel in/ }).map(b => b.tabIndex)).toEqual([0, -1]);
  });
  it('a list of only categories shows no empty label', () => {
    render(<ChannelList {...props({ channels: [], categories })} />);
    expect(screen.queryByText('No channels yet.')).toBeNull();
    expect(names()).toEqual(['raids', 'lounge']);
  });
  it('has no serious axe violations with categories', async () => {
    const { container } = render(<div className="d-root"><ChannelList {...props({ channels, categories, voice, activeId: 'r2', onAddInCategory: () => {}, addInCategoryLabel: n => `new channel in ${n}` })} /></div>);
    await expectNoAxeViolations(container);
  });
});

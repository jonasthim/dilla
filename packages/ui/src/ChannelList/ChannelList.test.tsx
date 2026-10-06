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
  // Controller ruling (e), task 21 pre-flight: the ChannelList title is the shell's <h1>.
  it('is a navigation landmark with the server name as its heading and one row per channel in order', () => {
    render(<ChannelList {...props()} />);
    const nav = screen.getByRole('navigation', { name: 'channels' });
    expect(nav).toHaveClass('d-channel-list');
    expect(within(nav).getByRole('heading', { level: 1, name: 'Midgard Crew' })).toBeInTheDocument();
    const rows = within(nav).getAllByRole('button');
    expect(rows.map(r => r.textContent?.replace(/[#♪◌]/g, '').trim())).toEqual(['general', 'lfg', 'loot', 'longhouse']);
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

  it('has no tab panel without tabs and no footer without one', () => {
    const { container } = render(<ChannelList {...props()} />);
    expect(screen.queryByRole('tabpanel')).toBeNull();
    expect(container.querySelector('.d-channel-list__footer')).toBeNull();
  });

  it('has no serious axe violations with badges, a muted row and tabs', async () => {
    const { container } = render(<div className="d-root"><ChannelList {...props({ channels: BADGED, activeId: 'l', rowLabel, tabs, footer: <button type="button">message someone</button> })} /></div>);
    await expectNoAxeViolations(container);
  });
});

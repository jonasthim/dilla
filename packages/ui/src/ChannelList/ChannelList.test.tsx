import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { ChannelList, type ChannelListProps } from './ChannelList.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

const CHANNELS = [
  { id: 'g', name: 'general', kind: 'text', readable: false },
  { id: 'l', name: 'lfg', kind: 'text', readable: true },
  { id: 't', name: 'loot', kind: 'text', readable: false },
  { id: 'v', name: 'longhouse', kind: 'voice', readable: false },
] as const;

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
});

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { CommunityRail, type CommunityRailProps } from './CommunityRail.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

const ITEMS = [
  { id: 'a1', name: 'Midgard Crew' },
  { id: 'b2', name: 'Night Owls' },
  { id: 'c3', name: 'raid planning' },
] as const;
const BADGED = [
  { id: 'a1', name: 'Midgard Crew' },
  { id: 'b2', name: 'Night Owls', unread: 4 },
  { id: 'c3', name: 'raid planning', unread: 1, mentions: 2 },
] as const;
// L-COPY-02 shell.rail.itemLabel, filled in as en.ts's t() will.
const itemLabel = (i: { name: string; unread: number; mentions: number }) => `${i.name}, unread ${i.unread}, mentions ${i.mentions}`;

function props(over: Partial<CommunityRailProps> = {}): CommunityRailProps {
  return { label: 'servers', items: ITEMS, activeId: 'b2', onSelect: vi.fn(), joinLabel: 'join a server', onJoin: vi.fn(), ...over };
}
function wrapped(p: CommunityRailProps) {
  return <><button type="button">before</button><CommunityRail {...p} /><button type="button">after</button></>;
}
const btn = (name: string) => screen.getByRole('button', { name });

describe('CommunityRail', () => {
  it('is a navigation landmark of buttons named after each server, the active one marked current', () => {
    render(wrapped(props()));
    const nav = screen.getByRole('navigation', { name: 'servers' });
    expect(nav).toHaveClass('d-community-rail');
    expect(within(nav).getAllByRole('button').map(b => b.getAttribute('aria-current'))).toEqual([null, 'page', null, null]);
    expect(btn('Night Owls')).toHaveAttribute('aria-current', 'page');
    expect(btn('join a server')).toBeInTheDocument();
  });

  it('shows initials but names each tile in full', () => {
    render(wrapped(props()));
    const initials = within(btn('Midgard Crew')).getByText('MC');
    expect(initials).toHaveAttribute('aria-hidden', 'true');
    expect(within(btn('raid planning')).getByText('RP')).toBeInTheDocument();
    expect(within(btn('Night Owls')).getByText('NO')).toBeInTheDocument();
  });

  it('is a single tab stop that lands on the active server', async () => {
    const user = userEvent.setup();
    render(wrapped(props()));
    await user.tab();
    expect(btn('before')).toHaveFocus();
    await user.tab();
    expect(btn('Night Owls')).toHaveFocus();
    await user.tab();
    expect(btn('after')).toHaveFocus();
    await user.tab({ shift: true });
    expect(btn('Night Owls')).toHaveFocus();
  });

  it('moves focus with the arrows, Home and End, without wrapping or selecting, and remembers the stop', async () => {
    const user = userEvent.setup();
    const p = props();
    render(wrapped(p));
    await user.tab();
    await user.tab();
    await user.keyboard('{ArrowDown}');
    expect(btn('raid planning')).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(btn('join a server')).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(btn('join a server')).toHaveFocus();
    await user.keyboard('{Home}');
    expect(btn('Midgard Crew')).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(btn('Midgard Crew')).toHaveFocus();
    await user.keyboard('{End}');
    expect(btn('join a server')).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(btn('raid planning')).toHaveFocus();
    await user.tab();
    expect(btn('after')).toHaveFocus();
    await user.tab({ shift: true });
    expect(btn('raid planning')).toHaveFocus();
    expect(p.onSelect).not.toHaveBeenCalled();
  });

  it('activates with Enter and Space', async () => {
    const user = userEvent.setup();
    const p = props();
    render(wrapped(p));
    await user.tab();
    await user.tab();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(p.onSelect).toHaveBeenLastCalledWith('c3');
    await user.keyboard('{Home} ');
    expect(p.onSelect).toHaveBeenLastCalledWith('a1');
    await user.keyboard('{End}{Enter}');
    expect(p.onJoin).toHaveBeenCalledTimes(1);
  });

  it('makes the first server the stop when none is active', async () => {
    const user = userEvent.setup();
    render(wrapped(props({ activeId: null })));
    await user.tab();
    await user.tab();
    expect(btn('Midgard Crew')).toHaveFocus();
  });

  it('leaves Alt+Arrow to the shell', async () => {
    const user = userEvent.setup();
    render(wrapped(props()));
    await user.tab();
    await user.tab();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(btn('Night Owls')).toHaveFocus();
  });

  it('resets the stop to the newly active server', async () => {
    const user = userEvent.setup();
    const p = props();
    const { rerender } = render(wrapped(p));
    await user.tab();
    await user.tab();
    await user.keyboard('{Home}');
    await user.tab();
    rerender(wrapped({ ...p, activeId: 'c3' }));
    await user.tab({ shift: true });
    expect(btn('raid planning')).toHaveFocus();
  });

  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><CommunityRail {...props()} /></div>);
    await expectNoAxeViolations(container);
  });

  it('badges a server with its counts as data and a pill', () => {
    render(wrapped(props({ items: BADGED })));
    const owls = btn('Night Owls 4 unread');
    expect([owls.getAttribute('data-unread'), owls.getAttribute('data-mentions')]).toEqual(['4', '0']);
    expect(within(owls).getByText('NO')).toHaveAttribute('aria-hidden', 'true');
    expect(btn('raid planning 2 mentions')).toHaveAttribute('data-mentions', '2');
    expect(btn('Midgard Crew')).toHaveAttribute('data-unread', '0');
  });

  it('names a badged server by itemLabel and leaves a quiet one to its name', () => {
    render(wrapped(props({ items: BADGED, itemLabel })));
    expect(btn('Night Owls, unread 4, mentions 0')).toBeInTheDocument();
    expect(btn('raid planning, unread 1, mentions 2')).toBeInTheDocument();
    expect(btn('Midgard Crew')).not.toHaveAttribute('aria-label');
  });

  it('puts the settings button last, inside the one tab stop', async () => {
    const user = userEvent.setup();
    const p = props({ settingsLabel: 'settings', onSettings: vi.fn() });
    render(wrapped(p));
    await user.tab();
    await user.tab();
    expect(btn('Night Owls')).toHaveFocus();
    await user.tab();
    expect(btn('after')).toHaveFocus();
    await user.tab({ shift: true });
    await user.keyboard('{End}');
    expect(btn('settings')).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(btn('join a server')).toHaveFocus();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(p.onSettings).toHaveBeenCalledTimes(1);
    const all = within(screen.getByRole('navigation', { name: 'servers' })).getAllByRole('button');
    expect(all[all.length - 1]).toBe(btn('settings'));
    expect(btn('settings').closest('ul')).toBe(btn('join a server').closest('ul'));
  });

  it('draws no settings button unless both its label and its handler are given', () => {
    render(wrapped(props({ settingsLabel: 'settings' })));
    expect(screen.queryByRole('button', { name: 'settings' })).toBeNull();
  });

  it('has no serious axe violations with badges and the settings button', async () => {
    const { container } = render(<div className="d-root"><CommunityRail {...props({ items: BADGED, itemLabel, settingsLabel: 'settings', onSettings: () => {} })} /></div>);
    await expectNoAxeViolations(container);
  });
});

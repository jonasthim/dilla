import { readFileSync } from 'node:fs';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemberList, type MemberListProps } from './MemberList.tsx';
import { Dialog } from '../Dialog/Dialog.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

const css = readFileSync(`${process.cwd()}/src/MemberList/MemberList.css`, 'utf8');
const kickBan = [{ id: 'kick', label: 'kick' }, { id: 'ban', label: 'ban', danger: true }];
function props(over: Partial<MemberListProps> = {}): MemberListProps {
  return {
    label: 'members', loading: false, loadingLabel: 'Loading members…', emptyLabel: 'No members yet.', onAction: vi.fn(),
    groups: [
      { id: 'mods', kind: 'role', title: 'moderators', color: 0xe74c3c, members: [
        { id: 'u1', name: 'Astrid', tags: ['owner'], actionsLabel: 'actions for Astrid', actions: kickBan },
      ] },
      { id: 'members', kind: 'online', title: 'online', members: [
        { id: 'u2', name: 'Bjorn', tags: [], actionsLabel: 'actions for Bjorn', actions: kickBan },
        { id: 'u3', name: 'You', tags: ['you'], actionsLabel: 'actions for You', actions: [] },
      ] },
    ],
    ...over,
  };
}

afterEach(() => { delete document.documentElement.dataset.theme; });

describe('MemberList', () => {
  it('has one section per group with an h3, and its rows in a list', () => {
    render(<MemberList {...props()} />);
    expect(screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(['moderators — 1', 'online — 2']);
    const lists = screen.getAllByRole('list');
    expect(lists).toHaveLength(2);
    expect(within(lists[0]!).getAllByRole('listitem')).toHaveLength(1);
    expect(within(lists[1]!).getAllByRole('listitem')).toHaveLength(2);
  });

  // Final fix M5: inside a landmark that already carries the name (the shell's aside), the list takes none of its own.
  it('with a label it is a region of that name; without one an unnamed container, not a region', () => {
    const { container, rerender } = render(<MemberList {...props()} />);
    expect(screen.getByRole('region', { name: 'members' })).toHaveClass('d-member-list');
    rerender(<MemberList {...props({ label: undefined })} />);
    expect(screen.queryByRole('region')).toBeNull();
    const root = container.querySelector('.d-member-list');
    expect(root?.tagName).toBe('DIV');
    expect(root).not.toHaveAttribute('aria-label');
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(2);
  });

  it('shows the name and the tags of each row', () => {
    render(<MemberList {...props()} />);
    const row = screen.getByText('Astrid').closest('li')!;
    expect(row).toHaveTextContent('owner');
    expect(row).toHaveAttribute('data-row');
  });

  it('a right-click opens the row’s menu at the pointer', () => {
    render(<MemberList {...props()} />);
    const row = screen.getByText('Bjorn').closest('li')!;
    fireEvent.contextMenu(row, { clientX: 33, clientY: 44, button: 2, detail: 1 });
    expect(screen.getByRole('menu', { name: 'actions for Bjorn' })).toHaveStyle({ position: 'fixed', left: '33px', top: '44px' });
  });

  it('a contextmenu event from the keyboard (button -1) opens the menu at the trigger, not at a pointer', () => {
    render(<MemberList {...props()} />);
    fireEvent.contextMenu(screen.getByText('Bjorn').closest('li')!, { clientX: 33, clientY: 44, button: -1, detail: 0 });
    expect(screen.getByRole('menu', { name: 'actions for Bjorn' })).not.toHaveStyle({ position: 'fixed' });
  });

  it('Chromium’s mouse right-click (button 2, detail 0) opens the menu at the pointer', () => {
    render(<MemberList {...props()} />);
    fireEvent.contextMenu(screen.getByText('Bjorn').closest('li')!, { clientX: 33, clientY: 44, button: 2, detail: 0 });
    expect(screen.getByRole('menu', { name: 'actions for Bjorn' })).toHaveStyle({ position: 'fixed', left: '33px', top: '44px' });
  });

  it('Shift+F10 and the ContextMenu key open the menu at the trigger', async () => {
    const user = userEvent.setup();
    render(<MemberList {...props()} />);
    screen.getByRole('button', { name: 'actions for Bjorn' }).focus();
    await user.keyboard('{Shift>}{F10}{/Shift}');
    const menu = screen.getByRole('menu', { name: 'actions for Bjorn' });
    expect(menu).not.toHaveStyle({ position: 'fixed' });
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'actions for Bjorn' })).toHaveFocus();
    await user.keyboard('{ContextMenu}');
    expect(screen.getByRole('menu', { name: 'actions for Bjorn' })).toBeInTheDocument();
  });

  it('the trigger opens the menu too, and a pick reports member and action', async () => {
    const user = userEvent.setup();
    const p = props();
    render(<MemberList {...p} />);
    await user.click(screen.getByRole('button', { name: 'actions for Astrid' }));
    await user.click(screen.getByRole('menuitem', { name: 'ban' }));
    expect(p.onAction).toHaveBeenCalledExactlyOnceWith('u1', 'ban');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('only one menu is open at a time', async () => {
    const user = userEvent.setup();
    render(<MemberList {...props()} />);
    await user.click(screen.getByRole('button', { name: 'actions for Astrid' }));
    await user.click(screen.getByRole('button', { name: 'actions for Bjorn' }));
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(screen.getByRole('menu', { name: 'actions for Bjorn' })).toBeInTheDocument();
  });

  it('a row with no actions has no trigger and no context menu', () => {
    render(<MemberList {...props()} />);
    expect(screen.queryByRole('button', { name: 'actions for You' })).toBeNull();
    // Not prevented (fireEvent returns true): the browser's own menu stays for a row that has none of ours.
    expect(fireEvent.contextMenu(screen.getByText('You').closest('li')!, { clientX: 1, clientY: 1, button: 2, detail: 1 })).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('while loading it says so in a status region and lists nothing', () => {
    render(<MemberList {...props({ loading: true })} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading members…');
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('with no members it shows the empty label', () => {
    const { rerender } = render(<MemberList {...props({ groups: [] })} />);
    expect(screen.getByText('No members yet.')).toBeInTheDocument();
    rerender(<MemberList {...props({ groups: [{ id: 'g', kind: 'role', title: 'members', members: [] }] })} />);
    expect(screen.getByText('No members yet.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 3 })).toBeNull();
  });

  it.each(['mesh', 'light', 'high-contrast'])('has no serious axe violations in %s, listed, loading and empty', async theme => {
    document.documentElement.dataset.theme = theme;
    for (const over of [{}, { loading: true }, { groups: [] }]) {
      const { container, unmount } = render(<div className="d-root"><MemberList {...props(over)} /></div>);
      await expectNoAxeViolations(container);
      unmount();
    }
  });
});

describe('MemberList sections and rows (R28, F1)', () => {
  const sectioned = () => props({
    groups: [
      { id: 'mods', kind: 'role', title: 'moderators', members: [{ id: 'u1', name: 'Astrid', tags: [], actionsLabel: 'a', actions: [], presence: 'online' }] },
      { id: 'on', kind: 'online', title: 'online', members: [
        { id: 'u2', name: 'Bjorn', tags: [], actionsLabel: 'a', actions: [], presence: 'online' },
        { id: 'u3', name: 'Cleo', tags: [], actionsLabel: 'a', actions: [], presence: 'idle' },
      ] },
      { id: 'off', kind: 'offline', title: 'offline', members: [{ id: 'u4', name: 'Dag', tags: [], actionsLabel: 'a', actions: [], presence: 'offline' }] },
    ],
  });

  it('has three section headers with counts, in groups order', () => {
    render(<MemberList {...sectioned()} />);
    expect(screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(['moderators — 1', 'online — 2', 'offline — 1']);
  });

  it('marks each section with its kind, and dims the offline rows with the muted opacity token (CSS pin)', () => {
    const { container } = render(<MemberList {...sectioned()} />);
    expect([...container.querySelectorAll('.d-member-list__group')].map(g => g.getAttribute('data-kind'))).toEqual(['role', 'online', 'offline']);
    expect(css).toMatch(/\.d-member-list__group\[data-kind="offline"\] \.d-member-list__text \{[^}]*opacity: var\(--opacity-muted\)/);
  });

  it('a row is two lines at var(--row-h-2) with a 32px avatar and presence corner; line 2 exists and is empty', () => {
    const { container } = render(<MemberList {...sectioned()} />);
    expect(css).toMatch(/\.d-member-list__row \{[^}]*min-height: var\(--row-h-2\)/);
    const row = screen.getByText('Bjorn').closest('li')!;
    const avatar = row.querySelector('.d-avatar')!;
    expect(avatar).toHaveAttribute('data-size', 'row');
    expect(avatar.querySelector('.d-avatar__presence')).toHaveAttribute('data-presence', 'online');
    const line2 = row.querySelector('.d-member-list__line2')!;
    expect(line2).not.toBeNull();
    expect(line2.textContent).toBe('');
    expect(row.querySelector('.d-member-list__line1')).toContainElement(screen.getByText('Bjorn'));
    expect(container.querySelectorAll('[data-row]')).toHaveLength(4);
  });

  it('a row without presence draws no corner', () => {
    render(<MemberList {...props()} />);
    expect(screen.getByText('Bjorn').closest('li')!.querySelector('.d-avatar__presence')).toBeNull();
  });

  it('the label is the 48 bar heading and names the region', () => {
    render(<MemberList {...sectioned()} />);
    expect(screen.getByRole('heading', { level: 2, name: 'members' })).toHaveClass('d-member-list__bar');
    expect(screen.getByRole('region', { name: 'members' })).toBeInTheDocument();
    expect(css).toMatch(/\.d-member-list__bar \{[^}]*height: var\(--bar-h\)/);
  });

  it('has no bar without a label', () => {
    const { container } = render(<MemberList {...sectioned()} label={undefined} />);
    expect(container.querySelector('.d-member-list__bar')).toBeNull();
  });
});

describe('MemberList role colour dot', () => {
  const withColors = () => props({
    groups: [{ id: 'g', kind: 'role', title: 'members', members: [
      { id: 'a', name: 'Astrid', tags: [], actionsLabel: 'actions for Astrid', actions: [], color: 0xe74c3c },
      { id: 'b', name: 'Bjorn', tags: [], actionsLabel: 'actions for Bjorn', actions: [], color: null },
      { id: 'c', name: 'Cleo', tags: [], actionsLabel: 'actions for Cleo', actions: [], color: 0 },
      { id: 'd', name: 'Dag', tags: [], actionsLabel: 'actions for Dag', actions: [] },
    ] }],
  });

  it('draws an aria-hidden dot in the colour after the name of a coloured member only (one name x per list)', () => {
    const { container } = render(<MemberList {...withColors()} />);
    const rows = screen.getAllByRole('listitem');
    const dot = rows[0]!.querySelector('.d-role-dot') as HTMLElement;
    expect(dot).not.toBeNull();
    expect(dot).toHaveAttribute('aria-hidden', 'true');
    expect(dot.style.getPropertyValue('--d-swatch')).toBe('#e74c3c');
    expect(rows[0]!.querySelector('.d-member-list__name')!.compareDocumentPosition(dot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelectorAll('.d-role-dot')).toHaveLength(1);
    expect(rows[0]!.querySelector('.d-member-list__name')!.textContent).toBe('Astrid');
  });

  it('has no serious axe violations with dots', async () => {
    const { container } = render(<div className="d-root"><MemberList {...withColors()} /></div>);
    await expectNoAxeViolations(container);
  });
});

describe('MemberList focus return', () => {
  it('a dialog opened from a row menu returns focus to that member\'s trigger after the row moved to another group', async () => {
    function Pane({ moved, open }: { moved: boolean; open: boolean }) {
      const base = props();
      const bjorn = base.groups[1]!.members[0]!;
      const groups = moved
        ? [{ ...base.groups[0]!, members: [...base.groups[0]!.members, bjorn] }, { ...base.groups[1]!, members: base.groups[1]!.members.slice(1) }]
        : base.groups;
      return <><MemberList {...props({ groups })} />{open ? <Dialog open title="roles for Bjorn" onClose={() => {}}><p>x</p></Dialog> : null}</>;
    }
    const { rerender } = render(<Pane moved={false} open={false} />);
    const before = screen.getByRole('button', { name: 'actions for Bjorn' });
    before.focus();
    rerender(<Pane moved={false} open />);
    rerender(<Pane moved open />);
    const after = screen.getByRole('button', { name: 'actions for Bjorn' });
    expect(after).not.toBe(before);
    rerender(<Pane moved open={false} />);
    expect(after).toHaveFocus();
  });
});

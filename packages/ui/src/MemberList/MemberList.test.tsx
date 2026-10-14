import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemberList, type MemberListProps } from './MemberList.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

const kickBan = [{ id: 'kick', label: 'kick' }, { id: 'ban', label: 'ban', danger: true }];
function props(over: Partial<MemberListProps> = {}): MemberListProps {
  return {
    label: 'members', loading: false, loadingLabel: 'Loading members…', emptyLabel: 'No members yet.', onAction: vi.fn(),
    groups: [
      { id: 'mods', title: 'moderators', members: [
        { id: 'u1', name: 'Astrid', tags: ['owner'], actionsLabel: 'actions for Astrid', actions: kickBan },
      ] },
      { id: 'members', title: 'members', members: [
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
    expect(screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(['moderators', 'members']);
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
    rerender(<MemberList {...props({ groups: [{ id: 'g', title: 'members', members: [] }] })} />);
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

describe('MemberList role colour dot', () => {
  const withColors = () => props({
    groups: [{ id: 'g', title: 'members', members: [
      { id: 'a', name: 'Astrid', tags: [], actionsLabel: 'actions for Astrid', actions: [], color: 0xe74c3c },
      { id: 'b', name: 'Bjorn', tags: [], actionsLabel: 'actions for Bjorn', actions: [], color: null },
      { id: 'c', name: 'Cleo', tags: [], actionsLabel: 'actions for Cleo', actions: [], color: 0 },
      { id: 'd', name: 'Dag', tags: [], actionsLabel: 'actions for Dag', actions: [] },
    ] }],
  });

  it('draws an aria-hidden dot in the colour before the name of a coloured member only', () => {
    const { container } = render(<MemberList {...withColors()} />);
    const rows = screen.getAllByRole('listitem');
    const dot = rows[0]!.querySelector('.d-member-list__dot') as HTMLElement;
    expect(dot).not.toBeNull();
    expect(dot).toHaveAttribute('aria-hidden', 'true');
    expect(dot.style.getPropertyValue('--d-swatch')).toBe('#e74c3c');
    expect(dot.compareDocumentPosition(rows[0]!.querySelector('.d-member-list__name')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelectorAll('.d-member-list__dot')).toHaveLength(1);
    expect(rows[0]!.textContent).toBe('Astrid');
  });

  it('has no serious axe violations with dots', async () => {
    const { container } = render(<div className="d-root"><MemberList {...withColors()} /></div>);
    await expectNoAxeViolations(container);
  });
});

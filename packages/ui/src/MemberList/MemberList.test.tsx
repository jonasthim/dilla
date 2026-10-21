import { readFileSync } from 'node:fs';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemberList, type MemberListProps } from './MemberList.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

const css = readFileSync(`${process.cwd()}/src/MemberList/MemberList.css`, 'utf8');
function props(over: Partial<MemberListProps> = {}): MemberListProps {
  return {
    label: 'members', loading: false, loadingLabel: 'Loading members…', emptyLabel: 'No members yet.', onOpen: vi.fn(),
    groups: [
      { id: 'mods', kind: 'role', title: 'moderators', color: 0xe74c3c, members: [
        { id: 'u1', name: 'Astrid', isOwner: true },
      ] },
      { id: 'members', kind: 'online', title: 'online', members: [
        { id: 'u2', name: 'Bjorn' },
        { id: 'u3', name: 'You' },
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

  it('shows the name of each row, with no tag in the row', () => {
    render(<MemberList {...props()} />);
    const row = screen.getByText('Astrid').closest('li')!;
    expect(row).toHaveTextContent('Astrid');
    expect(row.querySelector('.d-member-list__tag')).toBeNull();
    expect(row).toHaveAttribute('data-row');
  });

  it('draws no tag even for a member that still carries the deprecated tags', () => {
    render(<MemberList {...props({ groups: [{ id: 'g', kind: 'online', title: 'online', members: [{ id: 'a', name: 'Astrid', tags: ['owner', 'you'], actionsLabel: 'a', actions: [] }] }] })} />);
    expect(screen.getByRole('listitem').querySelector('.d-member-list__tag')).toBeNull();
    expect(screen.getByRole('listitem')).not.toHaveTextContent('you');
  });

  it('a row is one button that opens the card: a click reports the member and the button as the anchor', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<MemberList {...props({ onOpen })} />);
    const btn = screen.getByRole('button', { name: /Bjorn/ });
    await user.click(btn);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('u2', btn);
    expect(btn.closest('li')).toHaveAttribute('data-row');
    expect(screen.getAllByRole('button')).toHaveLength(3);
  });

  it('Enter on the focused row button opens the card', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<MemberList {...props({ onOpen })} />);
    screen.getByRole('button', { name: /Bjorn/ }).focus();
    await user.keyboard('{Enter}');
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('a right-click, Shift+F10 and the ContextMenu key open the card too, and the browser menu is suppressed', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<MemberList {...props({ onOpen })} />);
    const btn = screen.getByRole('button', { name: /Bjorn/ });
    expect(fireEvent.contextMenu(btn.closest('li')!, { clientX: 3, clientY: 4, button: 2, detail: 1 })).toBe(false);
    expect(onOpen).toHaveBeenLastCalledWith('u2', btn);
    btn.focus();
    await user.keyboard('{Shift>}{F10}{/Shift}');
    expect(onOpen).toHaveBeenCalledTimes(2);
    await user.keyboard('{ContextMenu}');
    expect(onOpen).toHaveBeenCalledTimes(3);
  });

  it('has no "…" action trigger and no menu, even for a member that still carries deprecated actions', () => {
    render(<MemberList {...props({ groups: [{ id: 'g', kind: 'online', title: 'online', members: [{ id: 'a', name: 'Astrid', tags: [], actionsLabel: 'actions for Astrid', actions: [{ id: 'kick', label: 'kick' }] }] }] })} />);
    expect(screen.queryByRole('button', { name: /actions for/ })).toBeNull();
    expect(document.body.textContent).not.toContain('⋯');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('the owner has a crown icon and the word owner for screen readers; no other row has one', () => {
    const { container } = render(<MemberList {...props()} />);
    const rows = screen.getAllByRole('listitem');
    expect(rows[0]!.querySelector('[data-icon="crown"]')).not.toBeNull();
    expect(within(rows[0]!).getByText('owner')).toHaveClass('d-sr-only');
    expect(screen.getByRole('button', { name: /Astrid/ })).toHaveAccessibleName(/owner/);
    expect(container.querySelectorAll('[data-icon="crown"]')).toHaveLength(1);
  });

  it('the owner word is the caller\'s ownerLabel', () => {
    render(<MemberList {...props({ ownerLabel: 'ägare' })} />);
    expect(screen.getByText('ägare')).toBeInTheDocument();
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
      { id: 'mods', kind: 'role', title: 'moderators', members: [{ id: 'u1', name: 'Astrid', presence: 'online' }] },
      { id: 'on', kind: 'online', title: 'online', members: [
        { id: 'u2', name: 'Bjorn', presence: 'online' },
        { id: 'u3', name: 'Cleo', presence: 'idle' },
      ] },
      { id: 'off', kind: 'offline', title: 'offline', members: [{ id: 'u4', name: 'Dag', presence: 'offline' }] },
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

  it('a row is at var(--row-h-2) with a 32px avatar and presence corner read as a word', () => {
    const { container } = render(<MemberList {...sectioned()} />);
    expect(css).toMatch(/\.d-member-list__open \{[^}]*min-height: var\(--row-h-2\)/);
    const row = screen.getByText('Bjorn').closest('li')!;
    const avatar = row.querySelector('.d-avatar')!;
    expect(avatar).toHaveAttribute('data-size', 'row');
    expect(avatar.querySelector('.d-avatar__presence')).toHaveAttribute('data-presence', 'online');
    expect(within(row).getByText('Online')).toHaveClass('d-sr-only');
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

describe('MemberList role colour on the name (P1)', () => {
  const withColors = () => props({
    groups: [{ id: 'g', kind: 'role', title: 'members', members: [
      { id: 'a', name: 'Astrid', color: 0xe74c3c },
      { id: 'b', name: 'Bjorn', color: null },
      { id: 'c', name: 'Cleo', color: 0 },
      { id: 'd', name: 'Dag' },
      { id: 'e', name: 'Eira', color: 0x101010 },
    ] }],
  });
  const pale = () => props({ groups: [{ id: 'g', kind: 'role', title: 'x', members: [{ id: 'a', name: 'Pale', color: 0xf1c40f }] }] });
  const nameOf = (n: string) => screen.getByText(n);

  it('colours the name itself, draws no dot, and leaves uncoloured names on the token colour', () => {
    document.documentElement.dataset.theme = 'mesh';
    const { container } = render(<MemberList {...withColors()} />);
    expect(nameOf('Astrid').style.color).toBe('rgb(231, 76, 60)');
    for (const n of ['Bjorn', 'Cleo', 'Dag']) expect(nameOf(n).style.color).toBe('');
    expect(container.querySelector('.d-role-dot')).toBeNull();
  });

  it('falls back to the text token when the role colour fails 4.5:1 (a near-black colour on mesh)', () => {
    document.documentElement.dataset.theme = 'mesh';
    render(<MemberList {...withColors()} />);
    expect(nameOf('Eira').style.color).toBe('');
  });

  it('judges per theme: a pale colour passes on mesh and falls back on the light theme', () => {
    document.documentElement.dataset.theme = 'mesh';
    const { unmount } = render(<MemberList {...pale()} />);
    expect(nameOf('Pale').style.color).not.toBe('');
    unmount();
    document.documentElement.dataset.theme = 'light';
    render(<MemberList {...pale()} />);
    expect(nameOf('Pale').style.color).toBe('');
  });

  it('follows a theme switch while mounted', async () => {
    document.documentElement.dataset.theme = 'mesh';
    render(<MemberList {...pale()} />);
    expect(nameOf('Pale').style.color).not.toBe('');
    document.documentElement.dataset.theme = 'light';
    await waitFor(() => expect(nameOf('Pale').style.color).toBe(''));
  });

  it('has no serious axe violations with coloured names', async () => {
    const { container } = render(<div className="d-root"><MemberList {...withColors()} /></div>);
    await expectNoAxeViolations(container);
  });
});

describe('MemberList fix round 1', () => {
  it('I1: an offline row dims its text to 0.8, so a role colour that only just passes opaque falls back there (0xe74c3c: online yes, offline no)', () => {
    document.documentElement.dataset.theme = 'mesh';
    const p = props({ groups: [
      { id: 'on', kind: 'online', title: 'online', members: [{ id: 'a', name: 'Astrid', color: 0xe74c3c }] },
      { id: 'off', kind: 'offline', title: 'offline', members: [{ id: 'b', name: 'Bjorn', color: 0xe74c3c }] },
    ] });
    render(<MemberList {...p} />);
    expect(screen.getByText('Astrid').style.color).not.toBe('');
    expect(screen.getByText('Bjorn').style.color).toBe('');
  });

  it('I1: an offline row keeps a colour that still passes after the dimming (0xf1c40f on mesh)', () => {
    document.documentElement.dataset.theme = 'mesh';
    const p = props({ groups: [{ id: 'off', kind: 'offline', title: 'offline', members: [{ id: 'b', name: 'Bjorn', color: 0xf1c40f }] }] });
    render(<MemberList {...p} />);
    expect(screen.getByText('Bjorn').style.color).not.toBe('');
  });

  it('I2: the row button draws its focus ring inside its box (CSS pin)', () => {
    expect(css).toMatch(/\.d-member-list \.d-member-list__open:focus-visible \{[^}]*outline-offset: -2px/);
  });

  it('M2: Shift+F10 opens once even when the browser also sends a contextmenu event after the key', () => {
    const onOpen = vi.fn();
    render(<MemberList {...props({ onOpen })} />);
    const btn = screen.getByRole('button', { name: /Bjorn/ });
    const li = btn.closest('li')!;
    const down = fireEvent.keyDown(btn, { key: 'F10', shiftKey: true });
    expect(down).toBe(false);
    fireEvent.contextMenu(li, { button: 0, detail: 0 });
    expect(onOpen).toHaveBeenCalledOnce();
    // a later, separate right-click still opens
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 5000);
    fireEvent.contextMenu(li, { button: 2, detail: 1 });
    vi.useRealTimers();
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('M3: the row button announces a dialog popup, and expanded only for the open member', () => {
    render(<MemberList {...props({ openId: 'u2' })} />);
    expect(screen.getByRole('button', { name: /Bjorn/ })).toHaveAttribute('aria-haspopup', 'dialog');
    expect(screen.getByRole('button', { name: /Bjorn/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: /Astrid/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('M1: a bot keeps a small bot tag after the name, from botLabel; no other tag', () => {
    const p = props({ botLabel: 'bott', groups: [{ id: 'g', kind: 'online', title: 'online', members: [{ id: 'a', name: 'Dag', isBot: true, tags: ['bot', 'you'] }, { id: 'b', name: 'Eva' }] }] });
    render(<MemberList {...p} />);
    const [a, b] = screen.getAllByRole('listitem');
    expect(within(a!).getByText('bott')).toHaveClass('d-member-list__bot');
    expect(a!.querySelector('.d-member-list__name')!.compareDocumentPosition(within(a!).getByText('bott')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(a).not.toHaveTextContent('you');
    expect(b!.querySelector('.d-member-list__bot')).toBeNull();
  });
});

describe('MemberList vertical alignment (P4)', () => {
  it('line 2 exists only when the member has a status; without one the name is the only line', () => {
    const p = props({ groups: [{ id: 'g', kind: 'online', title: 'online', members: [{ id: 'a', name: 'Astrid' }, { id: 'b', name: 'Bjorn', status: 'in a meeting' }] }] });
    render(<MemberList {...p} />);
    const [a, b] = screen.getAllByRole('listitem');
    expect(a!.querySelector('.d-member-list__line2')).toBeNull();
    expect(b!.querySelector('.d-member-list__line2')).toHaveTextContent('in a meeting');
  });

  it('CSS pin: the row button centres its content, and the tag rule is gone', () => {
    expect(css).toMatch(/\.d-member-list__open \{[^}]*align-items: center/);
    expect(css).not.toMatch(/d-member-list__tag/);
  });
});

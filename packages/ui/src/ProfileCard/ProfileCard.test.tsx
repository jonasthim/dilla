import { readFileSync } from 'node:fs';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProfileCard, type ProfileCardProps } from './ProfileCard.tsx';
import { PhoneLayoutProvider } from '../internal/phoneLayout.ts';
import { expectNoAxeViolations } from '../test/setup.ts';

const css = readFileSync(`${process.cwd()}/src/ProfileCard/ProfileCard.css`, 'utf8');
const actions = [{ id: 'message', label: 'message' }, { id: 'safety', label: 'compare safety numbers' }, { id: 'kick', label: 'kick' }, { id: 'ban', label: 'ban', danger: true }];
function props(over: Partial<ProfileCardProps> = {}): ProfileCardProps {
  return {
    name: 'Astrid', username: 'astrid', presence: 'online', isOwner: true, isYou: true,
    roles: [{ name: 'moderators', color: 0xe74c3c }, { name: 'members', color: null }],
    actions, onAction: vi.fn(), onClose: vi.fn(), ...over,
  };
}
function anchorButton(): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = 'Astrid';
  document.body.appendChild(b);
  return b;
}

afterEach(() => { delete document.documentElement.dataset.theme; document.body.innerHTML = ''; });

describe('ProfileCard content', () => {
  it('is a dialog named by the member, with the avatar, display name, @username and the presence word', () => {
    render(<ProfileCard {...props()} />);
    const card = screen.getByRole('dialog', { name: 'Astrid' });
    expect(within(card).getByRole('heading', { name: 'Astrid' })).toBeInTheDocument();
    expect(within(card).getByText('@astrid')).toBeInTheDocument();
    expect(within(card).getByText('Online')).toBeInTheDocument();
    expect(card.querySelector('.d-avatar')).toHaveAttribute('data-size', 'lg');
  });

  it('shows a custom status after the presence word when there is one', () => {
    render(<ProfileCard {...props({ status: 'in a meeting' })} />);
    expect(screen.getByText('in a meeting')).toBeInTheDocument();
  });

  it('shows owner and you when they apply, and neither when they do not', () => {
    const { rerender } = render(<ProfileCard {...props()} />);
    const card = screen.getByRole('dialog');
    expect(within(card).getByText('owner')).toBeInTheDocument();
    expect(card.querySelector('[data-icon="crown"]')).not.toBeNull();
    expect(within(card).getByText('you')).toBeInTheDocument();
    rerender(<ProfileCard {...props({ isOwner: false, isYou: false })} />);
    expect(screen.queryByText('owner')).toBeNull();
    expect(screen.queryByText('you')).toBeNull();
    expect(screen.getByRole('dialog').querySelector('[data-icon="crown"]')).toBeNull();
  });

  it('takes the owner, you and roles words from its props', () => {
    render(<ProfileCard {...props({ ownerLabel: 'ägare', youLabel: 'du', rolesLabel: 'roller' })} />);
    expect(screen.getByText('ägare')).toBeInTheDocument();
    expect(screen.getByText('du')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'roller' })).toBeInTheDocument();
  });

  it('lists the roles as chips in order, a coloured one with its swatch', () => {
    render(<ProfileCard {...props()} />);
    const chips = within(screen.getByRole('list', { name: 'roles' })).getAllByRole('listitem');
    expect(chips.map(c => c.textContent)).toEqual(['moderators', 'members']);
    const dot = chips[0]!.querySelector<HTMLElement>('.d-role-dot')!;
    expect(dot.style.getPropertyValue('--d-swatch')).toBe('#e74c3c');
    expect(chips[1]!.querySelector('.d-role-dot')).toBeNull();
  });

  it('draws no roles list without roles and no action group without actions', () => {
    render(<ProfileCard {...props({ roles: [], actions: [] })} />);
    expect(screen.queryByRole('list', { name: 'roles' })).toBeNull();
    expect(screen.getByRole('dialog').querySelector('.d-profile-card__actions')).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('draws one button per action, a danger one marked, and reports the id on a click', async () => {
    const user = userEvent.setup();
    const p = props();
    render(<ProfileCard {...p} />);
    const buttons = within(screen.getByRole('group', { name: 'Astrid' })).getAllByRole('button');
    expect(buttons.map(b => b.textContent)).toEqual(['message', 'compare safety numbers', 'kick', 'ban']);
    expect(buttons[3]).toHaveAttribute('data-danger', 'true');
    expect(buttons[2]).not.toHaveAttribute('data-danger');
    await user.click(buttons[3]!);
    expect(p.onAction).toHaveBeenCalledExactlyOnceWith('ban');
  });
});

describe('ProfileCard behaviour', () => {
  it('moves focus in on open: the first action, else the close button', () => {
    const { unmount } = render(<ProfileCard {...props()} />);
    expect(screen.getByRole('button', { name: 'message' })).toHaveFocus();
    unmount();
    render(<ProfileCard {...props({ actions: [] })} />);
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
  });

  it('Escape closes it, and the close button too', async () => {
    const user = userEvent.setup();
    const p = props();
    render(<ProfileCard {...p} />);
    await user.keyboard('{Escape}');
    expect(p.onClose).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(p.onClose).toHaveBeenCalledTimes(2);
  });

  it('gives focus back to the row it was opened from when it closes', () => {
    const anchor = anchorButton();
    anchor.focus();
    const { unmount } = render(<ProfileCard {...props({ anchor })} />);
    expect(anchor).not.toHaveFocus();
    unmount();
    expect(anchor).toHaveFocus();
  });

  it('gives focus back to the row that replaced the opener while the card was open (same focus key)', () => {
    const anchor = anchorButton();
    anchor.dataset.focusKey = 'member:u1';
    anchor.focus();
    const { unmount } = render(<ProfileCard {...props({ anchor })} />);
    const fresh = anchorButton();
    fresh.dataset.focusKey = 'member:u1';
    anchor.remove();
    unmount();
    expect(fresh).toHaveFocus();
  });

  it('keeps Tab and Shift+Tab inside the card', async () => {
    const user = userEvent.setup();
    render(<><button>before</button><ProfileCard {...props()} /><button>after</button></>);
    const first = screen.getByRole('button', { name: 'Close' });
    const last = screen.getByRole('button', { name: 'ban' });
    first.focus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
    await user.tab();
    expect(first).toHaveFocus();
  });

  it('a popover closes on a pointerdown outside, but not inside', () => {
    const p = props();
    render(<ProfileCard {...p} />);
    fireEvent.pointerDown(screen.getByText('@astrid'));
    expect(p.onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(p.onClose).toHaveBeenCalledOnce();
  });

  it('a pointerdown on its own anchor does not close it (the row decides)', () => {
    const anchor = anchorButton();
    const p = props({ anchor });
    render(<ProfileCard {...p} />);
    fireEvent.pointerDown(anchor);
    expect(p.onClose).not.toHaveBeenCalled();
  });
});

describe('ProfileCard placement', () => {
  const rect = (left: number, top: number, width = 200, height = 44) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) });

  it('is a popover by default, placed fixed beside the row: left of it when there is room', () => {
    const anchor = anchorButton();
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(rect(900, 100));
    render(<ProfileCard {...props({ anchor })} />);
    const card = screen.getByRole('dialog');
    expect(card).toHaveAttribute('data-layout', 'popover');
    expect(card).toHaveStyle({ position: 'fixed' });
    expect(parseFloat(card.style.left)).toBeLessThan(900);
    expect(card.style.top).toBe('100px');
  });

  it('goes right of the row when there is no room on its left', () => {
    const anchor = anchorButton();
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(rect(4, 100));
    render(<ProfileCard {...props({ anchor })} />);
    expect(parseFloat(screen.getByRole('dialog').style.left)).toBeGreaterThanOrEqual(204);
  });

  it('M4: re-places the popover on a window resize and on a scroll anywhere', () => {
    const anchor = anchorButton();
    const spy = vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(rect(900, 100));
    render(<ProfileCard {...props({ anchor })} />);
    const card = screen.getByRole('dialog');
    expect(card.style.top).toBe('100px');
    spy.mockReturnValue(rect(900, 300));
    fireEvent(window, new Event('resize'));
    expect(card.style.top).toBe('300px');
    spy.mockReturnValue(rect(900, 350));
    fireEvent.scroll(document.body);
    expect(card.style.top).toBe('350px');
  });

  it('is a sheet when asked to, or inside a phone shell: a modal dialog on a scrim, with no position of its own', () => {
    const { unmount } = render(<ProfileCard {...props({ layout: 'sheet' })} />);
    expect(screen.getByRole('dialog')).toHaveAttribute('data-layout', 'sheet');
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('dialog').style.left).toBe('');
    unmount();
    render(<PhoneLayoutProvider value><ProfileCard {...props()} /></PhoneLayoutProvider>);
    expect(screen.getByRole('dialog')).toHaveAttribute('data-layout', 'sheet');
  });

  it('a click on the sheet\'s scrim closes it; a click inside does not, and a sheet ignores pointerdown outside', () => {
    const p = props({ layout: 'sheet' });
    const { container } = render(<ProfileCard {...p} />);
    fireEvent.click(screen.getByText('@astrid'));
    expect(p.onClose).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector('.d-profile-card__scrim')!);
    expect(p.onClose).toHaveBeenCalledOnce();
  });

  it('CSS pins: the sheet sits at the bottom with 44px targets, the popover has a width and a shadow', () => {
    expect(css).toMatch(/\.d-profile-card\[data-layout="sheet"\] \{[^}]*bottom: 0/);
    expect(css).toMatch(/\.d-profile-card\[data-layout="sheet"\] \.d-profile-card__action \{[^}]*min-height: 2\.75rem/);
    expect(css).toMatch(/\.d-profile-card \{[^}]*box-shadow: var\(--shadow-2\)/);
  });
});

describe('ProfileCard accessibility', () => {
  it.each(['mesh', 'light', 'high-contrast'])('has no serious axe violations in %s, as popover and as sheet', async theme => {
    document.documentElement.dataset.theme = theme;
    for (const layout of ['popover', 'sheet'] as const) {
      const { container, unmount } = render(<div className="d-root"><ProfileCard {...props({ layout, status: 'in a meeting' })} /></div>);
      await expectNoAxeViolations(container);
      unmount();
    }
  });
});

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionMenu, type ActionMenuProps } from './ActionMenu.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

const items = [{ id: 'kick', label: 'kick' }, { id: 'ban', label: 'ban', danger: true }, { id: 'copy', label: 'copy id' }];

/** Holds `open` the way a caller does, and reports selections. */
function Harness({ onSelect, at, startOpen = false }: { onSelect?: (id: string) => void; at?: ActionMenuProps['at']; startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  return (
    <div>
      <button type="button">before</button>
      <ActionMenu label="actions for Astrid" items={items} open={open} onOpenChange={setOpen} onSelect={onSelect ?? (() => {})} at={at} />
      <button type="button">after</button>
    </div>
  );
}

const trigger = () => screen.getByRole('button', { name: 'actions for Astrid' });
const menuItems = () => screen.getAllByRole('menuitem');

afterEach(() => { delete document.documentElement.dataset.theme; vi.restoreAllMocks(); });

describe('ActionMenu', () => {
  it('is a menu button: closed it shows no menu and says so', () => {
    render(<Harness />);
    expect(trigger()).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it.each(['{Enter}', ' ', '{ArrowDown}'])('%j on the trigger opens the menu on the first item', async key => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();
    await user.keyboard(key);
    expect(screen.getByRole('menu', { name: 'actions for Astrid' })).toBeInTheDocument();
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(menuItems()[0]).toHaveFocus();
  });

  it('ArrowUp on the trigger opens the menu on the last item', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();
    await user.keyboard('{ArrowUp}');
    expect(menuItems()[2]).toHaveFocus();
  });

  it('arrows wrap; Home and End jump', async () => {
    const user = userEvent.setup();
    render(<Harness startOpen />);
    expect(menuItems()[0]).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(menuItems()[2]).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(menuItems()[0]).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(menuItems()[1]).toHaveFocus();
    await user.keyboard('{End}');
    expect(menuItems()[2]).toHaveFocus();
    await user.keyboard('{Home}');
    expect(menuItems()[0]).toHaveFocus();
  });

  it('Escape closes the menu and puts focus back on the trigger', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();
    await user.keyboard('{Enter}');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger()).toHaveFocus();
  });

  it('Tab closes the menu and moves on from the trigger', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();
    await user.keyboard('{Enter}');
    await user.tab();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: 'after' })).toHaveFocus();
  });

  it('a pointerdown outside closes the menu; one inside does not', async () => {
    const user = userEvent.setup();
    render(<Harness startOpen />);
    await user.pointer({ keys: '[MouseLeft>]', target: menuItems()[0]! });
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.pointer({ keys: '[MouseLeft>]', target: screen.getByRole('button', { name: 'before' }) });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('selecting an item calls onSelect with its id and closes the menu', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    await user.click(trigger());
    await user.click(screen.getByRole('menuitem', { name: 'ban' }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('ban');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger()).toHaveFocus();
  });

  it('Enter on a focused item selects it', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} startOpen />);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('ban');
  });

  it('marks danger items for --danger', () => {
    render(<Harness startOpen />);
    expect(screen.getByRole('menuitem', { name: 'ban' })).toHaveAttribute('data-danger', 'true');
    expect(screen.getByRole('menuitem', { name: 'kick' })).not.toHaveAttribute('data-danger');
  });

  it('`at` places the popup at the pointer; the popup is clamped inside the viewport', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(160);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(100);
    const { unmount } = render(<Harness startOpen at={{ x: 40, y: 50 }} />);
    expect(screen.getByRole('menu')).toHaveStyle({ position: 'fixed', left: '40px', top: '50px' });
    unmount();
    render(<Harness startOpen at={{ x: window.innerWidth - 10, y: window.innerHeight - 10 }} />);
    expect(screen.getByRole('menu')).toHaveStyle({ left: `${window.innerWidth - 160}px`, top: `${window.innerHeight - 100}px` });
  });

  it('opens on its first item when `at` is set', () => {
    render(<Harness startOpen at={{ x: 5, y: 5 }} />);
    expect(menuItems()[0]).toHaveFocus();
  });

  it.each(['mesh', 'light', 'high-contrast'])('has no serious axe violations in %s, closed and open', async theme => {
    document.documentElement.dataset.theme = theme;
    for (const startOpen of [false, true]) {
      const { container, unmount } = render(<div className="d-root"><Harness startOpen={startOpen} /></div>);
      await expectNoAxeViolations(container);
      unmount();
    }
  });
});

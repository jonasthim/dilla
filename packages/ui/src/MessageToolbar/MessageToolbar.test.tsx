import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { MessageToolbar, type MessageToolbarProps } from './MessageToolbar.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

function items(spy = vi.fn()): MessageToolbarProps['items'] {
  return [
    { id: 'react', label: 'react', onAction: () => spy('react') },
    { id: 'reply', label: 'reply', onAction: () => spy('reply') },
    { id: 'edit', label: 'edit', onAction: () => spy('edit') },
    { id: 'pin', label: 'pin', onAction: () => spy('pin') },
    { id: 'delete', label: 'delete', danger: true, onAction: () => spy('delete') },
  ];
}
const buttons = () => screen.getAllByRole('button');

describe('MessageToolbar', () => {
  it('is a toolbar named by its label, of buttons with visible labels in order', () => {
    const { container } = render(<MessageToolbar label="actions for this message" tabbable items={items()} />);
    const bar = screen.getByRole('toolbar', { name: 'actions for this message' });
    expect(bar).toHaveClass('d-message-toolbar');
    expect(bar).toHaveAttribute('aria-orientation', 'horizontal');
    expect(buttons().map((b) => b.textContent)).toEqual(['react', 'reply', 'edit', 'pin', 'delete']);
    expect(buttons().map((b) => b.getAttribute('data-action'))).toEqual(['react', 'reply', 'edit', 'pin', 'delete']);
    expect(buttons()[4]).toHaveAttribute('data-variant', 'danger');
    expect(buttons()[0]).toHaveAttribute('data-variant', 'ghost');
    expect(container.querySelectorAll('[data-size="sm"]')).toHaveLength(0);
  });

  it('is one tab stop when tabbable and none when not', () => {
    const { rerender } = render(<MessageToolbar label="actions for this message" tabbable items={items()} />);
    expect(buttons().map((b) => b.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    rerender(<MessageToolbar label="actions for this message" tabbable={false} items={items()} />);
    expect(buttons().map((b) => b.tabIndex)).toEqual([-1, -1, -1, -1, -1]);
  });

  it('moves focus with the arrows, wrapping, and with Home and End; the stop follows focus', () => {
    render(<MessageToolbar label="actions for this message" tabbable items={items()} />);
    const b = buttons();
    b[0]!.focus();
    fireEvent.keyDown(b[0]!, { key: 'ArrowRight' });
    expect(b[1]).toHaveFocus();
    fireEvent.keyDown(b[1]!, { key: 'End' });
    expect(b[4]).toHaveFocus();
    fireEvent.keyDown(b[4]!, { key: 'ArrowRight' });
    expect(b[0]).toHaveFocus();
    fireEvent.keyDown(b[0]!, { key: 'ArrowLeft' });
    expect(b[4]).toHaveFocus();
    fireEvent.keyDown(b[4]!, { key: 'Home' });
    expect(b[0]).toHaveFocus();
    fireEvent.keyDown(b[0]!, { key: 'ArrowRight', shiftKey: true });
    expect(b[0]).toHaveFocus();
    fireEvent.keyDown(b[0]!, { key: 'ArrowRight' });
    expect(buttons().map((x) => x.tabIndex)).toEqual([-1, 0, -1, -1, -1]);
  });

  it('calls each action once on click, Enter and Space', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<MessageToolbar label="actions for this message" tabbable items={items(spy)} />);
    await user.click(screen.getByRole('button', { name: 'reply' }));
    screen.getByRole('button', { name: 'pin' }).focus();
    await user.keyboard('{Enter}');
    screen.getByRole('button', { name: 'delete' }).focus();
    await user.keyboard(' ');
    expect(spy.mock.calls.map((c) => c[0])).toEqual(['reply', 'pin', 'delete']);
  });

  it('lets Escape bubble to the row', () => {
    const onKeyDown = vi.fn();
    render(<div onKeyDown={(e) => onKeyDown(e.key)}><MessageToolbar label="actions for this message" tabbable items={items()} /></div>);
    fireEvent.keyDown(buttons()[2]!, { key: 'Escape' });
    expect(onKeyDown).toHaveBeenCalledWith('Escape');
  });

  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><MessageToolbar label="actions for this message" tabbable items={items()} /></div>);
    await expectNoAxeViolations(container);
  });
});

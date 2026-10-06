import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { ComposedShell } from './AppShell.fixture.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

describe('AppShell', () => {
  it('follows the focus order of the keyboard map', async () => {
    const user = userEvent.setup();
    const { container } = render(<ComposedShell />);
    expect(container.firstElementChild).toHaveClass('d-app-shell');
    await user.tab();
    expect(screen.getByRole('link', { name: 'skip to messages' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Midgard Crew' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'general' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('log', { name: 'messages in #general' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('textbox', { name: 'message #general' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'send' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: /connection/ })).toHaveFocus();
  });

  it('moves focus to main from the skip link without changing the URL', async () => {
    const user = userEvent.setup();
    render(<ComposedShell />);
    const before = window.location.href;
    await user.tab();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('main')).toHaveFocus();
    expect(window.location.href).toBe(before);
  });

  it('holds the header, the log and the composer in main', () => {
    render(<ComposedShell />);
    const main = screen.getByRole('main');
    expect(within(main).getByRole('heading', { level: 2, name: 'general' })).toBeInTheDocument();
    expect(within(main).getByRole('log')).toBeInTheDocument();
    expect(within(main).getByRole('textbox', { name: 'message #general' })).toBeInTheDocument();
    expect(within(main).queryByRole('navigation')).toBeNull();
  });

  it('puts the banner above the rail in reading and focus order, only when given', async () => {
    const user = userEvent.setup();
    const { container, rerender } = render(<ComposedShell />);
    expect(container.querySelector('.d-app-shell__banner')).toBeNull();
    rerender(<ComposedShell banner />);
    const banner = container.querySelector('.d-app-shell__banner');
    const rail = container.querySelector('.d-app-shell__rail');
    expect(banner).not.toBeNull();
    expect(banner?.compareDocumentPosition(rail as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    await user.tab();
    await user.tab();
    expect(screen.getByRole('button', { name: 'retry now' })).toHaveFocus();
  });

  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><ComposedShell banner /></div>);
    await expectNoAxeViolations(container);
  });
});

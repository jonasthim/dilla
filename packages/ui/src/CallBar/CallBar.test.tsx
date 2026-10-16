import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { CallBar, type CallBarProps } from './CallBar.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

const labels = { open: 'open call in harbour', mute: 'mute', leave: 'leave call', region: 'call' };
const props = (over: Partial<CallBarProps> = {}): CallBarProps => ({
  phase: 'connected', where: 'harbour', muted: false, labels, onOpen: () => {}, onMute: () => {}, onLeave: () => {}, ...over,
});

describe('CallBar', () => {
  it('is a named group with three named buttons', () => {
    render(<CallBar {...props()} />);
    expect(screen.getByRole('group', { name: 'call' })).toHaveClass('d-call-bar');
    expect(screen.getByRole('button', { name: 'open call in harbour' })).toHaveTextContent('harbour');
    expect(screen.getByRole('button', { name: 'mute' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'leave call' })).toBeInTheDocument();
  });
  it('exposes the mute state', () => {
    const { rerender } = render(<CallBar {...props()} />);
    expect(screen.getByRole('button', { name: 'mute' })).toHaveAttribute('aria-pressed', 'false');
    rerender(<CallBar {...props({ muted: true })} />);
    expect(screen.getByRole('button', { name: 'mute' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'mute' }).querySelector('[data-icon="mic-off"]')).not.toBeNull();
  });
  it('calls the three callbacks', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn(); const onMute = vi.fn(); const onLeave = vi.fn();
    render(<CallBar {...props({ onOpen, onMute, onLeave })} />);
    await user.click(screen.getByRole('button', { name: 'open call in harbour' }));
    await user.click(screen.getByRole('button', { name: 'mute' }));
    await user.click(screen.getByRole('button', { name: 'leave call' }));
    expect([onOpen, onMute, onLeave].map(f => f.mock.calls.length)).toEqual([1, 1, 1]);
  });
  it.each([['connecting', 'pending'], ['reconnecting', 'pending'], ['connected', 'ok']] as const)('%s shows a %s dot', (phase, tone) => {
    const { container } = render(<CallBar {...props({ phase })} />);
    expect(container.querySelector('.d-state-dot')).toHaveAttribute('data-tone', tone);
  });
  it('shows the pause icon when paused', () => {
    const { container } = render(<CallBar {...props({ phase: 'paused' })} />);
    expect(container.querySelector('.d-state-dot')).toBeNull();
    expect(container.querySelector('[data-icon="pause"]')).not.toBeNull();
  });
  it('has no axe violations', async () => {
    const { container } = render(<div className="d-root"><CallBar {...props()} /></div>);
    await expectNoAxeViolations(container);
  });
});

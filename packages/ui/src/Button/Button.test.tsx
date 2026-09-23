import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Button } from './Button.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

describe('Button', () => {
  it('renders its label and calls onClick on click and on Enter', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save changes</Button>);
    const btn = screen.getByRole('button', { name: 'Save changes' });
    await userEvent.click(btn);
    btn.focus();
    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(2);
  });
  it('shows a key hint as a kbd element that is not part of the accessible name', () => {
    render(<Button keyHint="⌘↵">Save changes</Button>);
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
    expect(screen.getByText('⌘↵').tagName).toBe('KBD');
  });
  it('exposes pressed state', () => {
    render(<Button pressed>Mute</Button>);
    expect(screen.getByRole('button', { name: 'Mute' })).toHaveAttribute('aria-pressed', 'true');
  });
  it('signals pressed state without relying on colour alone', () => {
    const { rerender } = render(
      <Button pressed={false} pressedLabel="Unmute">Mute</Button>,
    );
    // Unpressed: label reads "Mute", decorative mark is the empty bracket.
    expect(screen.getByRole('button', { name: 'Mute' })).toHaveAttribute('aria-pressed', 'false');
    const mark = screen.getByText('[ ]');
    expect(mark).toHaveAttribute('aria-hidden', 'true');

    rerender(<Button pressed pressedLabel="Unmute">Mute</Button>);
    // Pressed: the accessible name and visible label both swap to
    // "Unmute", and the decorative mark switches to the filled bracket —
    // two non-colour cues on top of the colour change.
    expect(screen.getByRole('button', { name: 'Unmute' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('Mute')).not.toBeInTheDocument();
    expect(screen.getByText('[x]')).toHaveAttribute('aria-hidden', 'true');
  });
  it('still shows a non-colour mark when callers omit pressedLabel', () => {
    render(<Button pressed>Mute</Button>);
    expect(screen.getByRole('button', { name: 'Mute' })).toBeInTheDocument();
    expect(screen.getByText('[x]')).toHaveAttribute('aria-hidden', 'true');
  });
  it('renders no pressed mark for a plain (non-toggle) button', () => {
    render(<Button>Save changes</Button>);
    expect(screen.queryByText('[x]')).not.toBeInTheDocument();
    expect(screen.queryByText('[ ]')).not.toBeInTheDocument();
  });
  it('sets data-variant and data-size', () => {
    render(<Button variant="danger" size="sm">Leave</Button>);
    const btn = screen.getByRole('button', { name: 'Leave' });
    expect(btn).toHaveAttribute('data-variant', 'danger');
    expect(btn).toHaveAttribute('data-size', 'sm');
  });
  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><Button variant="accent" keyHint="M">Mute</Button></div>);
    await expectNoAxeViolations(container);
  });
  it('has no serious axe violations when pressed', async () => {
    const { container } = render(
      <div className="d-root">
        <Button variant="danger" pressed pressedLabel="Unmute" keyHint="M">Mute</Button>
      </div>,
    );
    await expectNoAxeViolations(container);
  });
});

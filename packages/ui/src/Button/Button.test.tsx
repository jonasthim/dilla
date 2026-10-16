import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Button } from './Button.tsx';
import { PhoneLayoutProvider } from '../internal/phoneLayout.ts';
import { expectNoAxeViolations } from '../test/setup.ts';

describe('Button', () => {
  it('drops the key hint on a phone layout, which has no keyboard, and keeps the label', () => {
    render(<PhoneLayoutProvider value><Button keyHint="esc">Close</Button></PhoneLayoutProvider>);
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(screen.queryByText('esc')).toBeNull();
  });
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
  // WB a11y I4 (ruling 2026-10-14): the WAI-ARIA toggle pattern. The label never changes; aria-pressed and the
  // aria-hidden bracket mark carry the state, on top of the pressed colour.
  it('signals pressed state without relying on colour alone, and keeps one label', () => {
    const { rerender } = render(<Button pressed={false}>Mute</Button>);
    expect(screen.getByRole('button', { name: 'Mute' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('[ ]')).toHaveAttribute('aria-hidden', 'true');
    rerender(<Button pressed>Mute</Button>);
    expect(screen.getByRole('button', { name: 'Mute' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('[x]')).toHaveAttribute('aria-hidden', 'true');
  });
  it('renders no pressed mark for a plain (non-toggle) button', () => {
    render(<Button>Save changes</Button>);
    expect(screen.queryByText('[x]')).not.toBeInTheDocument();
    expect(screen.queryByText('[ ]')).not.toBeInTheDocument();
  });
  // Voice toolbars (plan 2026-10-15): an icon toggle swaps its glyph instead, so it opts out of the mark.
  it('a toggle with mark={false} keeps aria-pressed but draws no [x] / [ ] mark', () => {
    const { rerender } = render(<Button pressed mark={false}>Mute</Button>);
    expect(screen.getByRole('button', { name: 'Mute' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('[x]')).not.toBeInTheDocument();
    rerender(<Button pressed={false} mark={false}>Mute</Button>);
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
        <Button variant="danger" pressed keyHint="M">Mute</Button>
      </div>,
    );
    await expectNoAxeViolations(container);
  });
});

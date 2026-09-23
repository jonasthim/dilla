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
});

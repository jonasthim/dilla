import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { PhoneHeader } from './PhoneHeader.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

describe('PhoneHeader', () => {
  it('names the back button and calls onBack', async () => {
    const onBack = vi.fn();
    render(<PhoneHeader title="# general" backLabel="back to channels" onBack={onBack} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'back to channels' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
  it('has a level-two heading', () => {
    render(<PhoneHeader title="general" />);
    expect(screen.getByRole('heading', { level: 2, name: 'general' })).toHaveClass('d-phone-header__title');
  });
  it('shows an image-named dot after the title only when given a dot label', () => {
    const { rerender } = render(<PhoneHeader title="general" />);
    expect(screen.queryByRole('img')).toBeNull();
    rerender(<PhoneHeader title="general" dotLabel="open the call in room" />);
    const dot = screen.getByRole('img', { name: 'open the call in room' });
    expect(dot).toHaveClass('d-phone-header__dot');
    expect(screen.getByRole('heading', { level: 2 }).nextElementSibling).toBe(dot);
  });
  it('has no back button without onBack', () => {
    render(<PhoneHeader title="general" backLabel="back" actions={<button type="button">more</button>} />);
    expect(screen.queryByRole('button', { name: 'back' })).toBeNull();
    expect(screen.getByRole('button', { name: 'more' })).toBeInTheDocument();
  });
  it('has no axe violations', async () => {
    const { container } = render(<div className="d-root"><PhoneHeader title="general" backLabel="back" onBack={() => {}} /></div>);
    await expectNoAxeViolations(container);
  });
});

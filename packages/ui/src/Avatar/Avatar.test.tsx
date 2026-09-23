import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Avatar } from './Avatar.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

describe('Avatar', () => {
  it('derives initials and announces presence in the name', () => {
    render(<Avatar name="jonas" presence="online" />);
    const img = screen.getByRole('img', { name: 'jonas, online' });
    expect(img).toHaveTextContent('JO');
  });
  it('uses given initials and omits presence text when unknown', () => {
    render(<Avatar name="Skald" initials="SK" />);
    expect(screen.getByRole('img', { name: 'Skald' })).toHaveTextContent('SK');
  });
  it('shows presence with a glyph, not only colour', () => {
    render(<Avatar name="lina" presence="idle" />);
    expect(screen.getByRole('img', { name: 'lina, idle' }).querySelector('[data-presence="idle"]')).not.toBeNull();
  });
  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><Avatar name="erik" presence="dnd" size="lg" /></div>);
    await expectNoAxeViolations(container);
  });
});

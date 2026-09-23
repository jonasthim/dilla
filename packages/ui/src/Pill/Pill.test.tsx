import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Pill } from './Pill.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

describe('Pill', () => {
  it('reads as the full count inside its row, and is not a live region', () => {
    render(<button type="button">loot<Pill kind="unread" count={4} /></button>);
    expect(screen.getByRole('button')).toHaveAccessibleName('loot 4 unread');
    // A pill is decoration on a row that already exists; announcing every
    // count change would talk over the user.
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('counts mentions in the singular and the plural', () => {
    render(
      <>
        <button type="button">general<Pill kind="mention" count={1} /></button>
        <button type="button">screenshots<Pill kind="mention" count={12} /></button>
      </>,
    );
    expect(screen.getByRole('button', { name: 'general 1 mention' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'screenshots 12 mentions' })).toBeInTheDocument();
  });
  it('caps the digits at 99+ but still reads the real count', () => {
    render(<button type="button">loot<Pill kind="unread" count={140} /></button>);
    expect(screen.getByText('99+')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('button')).toHaveAccessibleName('loot 140 unread');
  });
  it('renders nothing for zero', () => {
    const { container } = render(<Pill kind="unread" count={0} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><Pill kind="mention" count={1} /></div>);
    await expectNoAxeViolations(container);
  });
});

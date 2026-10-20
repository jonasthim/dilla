import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { useRovingFocus } from './roving.ts';

function List() {
  const r = useRovingFocus(0);
  return (
    <ul ref={r.ref} onKeyDown={r.onKeyDown} onFocus={r.onFocus}>
      <li><button type="button">one</button></li>
      <li aria-hidden="true" />
      <li><button type="button">two</button></li>
    </ul>
  );
}

describe('useRovingFocus', () => {
  it('keeps the plain stops: one tab stop, arrows move, an li without a button is skipped', async () => {
    render(<List />);
    expect(screen.getAllByRole('button').map(b => b.tabIndex)).toEqual([0, -1]);
    await userEvent.keyboard('{Tab}{ArrowDown}');
    expect(screen.getByRole('button', { name: 'two' })).toHaveFocus();
  });
});

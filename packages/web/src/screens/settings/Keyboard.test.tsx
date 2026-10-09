import { render, screen } from '@testing-library/react';
import { it, expect } from 'vitest';
import { Keyboard } from './Keyboard.tsx';

it('lists only bound modifier shortcuts', () => {
  render(<Keyboard />);
  expect(screen.getByText(/Ctrl|⌘/)).toBeInTheDocument();
  expect(screen.getByText(/Ctrl|⌘/).parentElement).toHaveTextContent('K');
  expect(screen.queryByText(/^K$/)).toBeNull();
});

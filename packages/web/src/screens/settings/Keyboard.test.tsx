import { render, screen } from '@testing-library/react';
import { it, expect } from 'vitest';
import { Keyboard } from './Keyboard.tsx';

it('lists only bound modifier shortcuts', () => {
  render(<Keyboard />);
  expect(screen.getByText(/Ctrl|⌘/)).toBeInTheDocument();
  expect(screen.getByText(/Ctrl|⌘/).parentElement).toHaveTextContent('K');
  expect(screen.queryByText(/^K$/)).toBeNull();
});

// M-14: one name for the key, as the guide's Keyboard table writes it; the heading is sentence case like the others.
it('names the modifier one way, under a sentence-case heading', () => {
  render(<Keyboard />);
  expect(screen.getByRole('heading', { name: 'Keyboard', level: 2 })).toBeInTheDocument();
  expect(screen.getByText('Control/⌘+K')).toBeInTheDocument();
  expect(screen.getByText('Control+/')).toBeInTheDocument();
  expect(document.body).not.toHaveTextContent('Ctrl');
});

import { render, screen } from '@testing-library/react';
import { it, expect } from 'vitest';
import { Keyboard } from './Keyboard.tsx';

it('lists only bound modifier shortcuts', () => {
  render(<Keyboard />);
  expect(screen.getByText('Control/⌘+K').parentElement).toHaveTextContent('search');
  expect(screen.queryByText(/^[A-Z]$/)).toBeNull();
});

// Flow 06 § Keyboard map: mute and deafen need Control/⌘ and Shift, each followed by its action (decision 1).
it('lists the two voice shortcuts with their actions', () => {
  render(<Keyboard />);
  expect(screen.getByText('Control/⌘+Shift+M').parentElement).toHaveTextContent('Control/⌘+Shift+M mute or unmute');
  expect(screen.getByText('Control/⌘+Shift+D').parentElement).toHaveTextContent('Control/⌘+Shift+D deafen or undeafen');
});

// M-14: one name for the key, as the guide's Keyboard table writes it; the heading is sentence case like the others.
it('names the modifier one way, under a sentence-case heading', () => {
  render(<Keyboard />);
  expect(screen.getByRole('heading', { name: 'Keyboard', level: 2 })).toBeInTheDocument();
  expect(screen.getByText('Control/⌘+K')).toBeInTheDocument();
  expect(screen.getByText('Control+/')).toBeInTheDocument();
  expect(document.body).not.toHaveTextContent('Ctrl');
});

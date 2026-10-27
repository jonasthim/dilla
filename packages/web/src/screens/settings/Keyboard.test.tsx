import { render, screen, within } from '@testing-library/react';
import { it, expect } from 'vitest';
import { Keyboard } from './Keyboard.tsx';

const rowOf = (chord: string) => screen.getByText(chord).closest('tr') as HTMLElement;

it('lists only bound modifier shortcuts', () => {
  render(<Keyboard />);
  expect(rowOf('Control/⌘+K')).toHaveTextContent('search');
  expect(screen.queryByText(/^[A-Z]$/)).toBeNull();
});

// Flow 06 § Keyboard map: mute and deafen need Control/⌘ and Shift, each followed by its action (decision 1).
it('lists the two voice shortcuts with their actions', () => {
  render(<Keyboard />);
  expect(rowOf('Control/⌘+Shift+M')).toHaveTextContent('mute or unmute');
  expect(rowOf('Control/⌘+Shift+D')).toHaveTextContent('deafen or undeafen');
});

// M-14: one name for the key, as the guide's Keyboard table writes it; the heading is sentence case like the others.
it('names the modifier one way, under a sentence-case heading', () => {
  render(<Keyboard />);
  expect(screen.getByRole('heading', { name: 'Keyboard', level: 2 })).toBeInTheDocument();
  expect(screen.getByText('Control/⌘+K')).toBeInTheDocument();
  expect(screen.getByText('Control+/')).toBeInTheDocument();
  expect(document.body).not.toHaveTextContent('Ctrl');
});

// I3: a table with a caption and the four shortcuts as its rows, the action as the row header.
// Ruling Z adds the DM call chord (Control/⌘+Shift+Enter).
it('is a table with a caption and five rows', () => {
  render(<Keyboard />);
  const table = screen.getByRole('table', { name: 'Keyboard' });
  expect(within(table).getAllByRole('row')).toHaveLength(5);
  expect(within(table).getAllByRole('rowheader').map(h => h.textContent)).toEqual(['search', 'this conversation', 'mute or unmute', 'deafen or undeafen', 'call the open direct message']);
});

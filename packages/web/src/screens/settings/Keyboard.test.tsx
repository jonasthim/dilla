import { render, screen, within } from '@testing-library/react';
import { it, expect } from 'vitest';
import { Keyboard } from './Keyboard.tsx';

// Task 10 (README §5.9): a chord is drawn one keycap per key, so a row is found by its keycaps joined with '+'.
const chordOf = (row: Element) => Array.from(row.querySelectorAll('kbd')).map(k => k.textContent).join('+');
const rowOf = (chord: string) => {
  const row = Array.from(document.querySelectorAll('tr')).find(r => chordOf(r) === chord);
  if (row === undefined) throw new Error(`no row with ${chord}`);
  return row as HTMLElement;
};

it('lists only bound modifier shortcuts', () => {
  render(<Keyboard />);
  expect(rowOf('Control/⌘+K')).toHaveTextContent('search');
  // No unmodified shortcut: every chord has a modifier key before its key.
  for (const row of Array.from(document.querySelectorAll('tbody tr'))) expect(row.querySelectorAll('kbd').length).toBeGreaterThan(1);
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
  expect(rowOf('Control/⌘+K')).toBeInTheDocument();
  expect(rowOf('Control+/')).toBeInTheDocument();
  expect(Array.from(rowOf('Control/⌘+Shift+M').querySelectorAll('kbd')).map(k => k.textContent)).toEqual(['Control/⌘', 'Shift', 'M']);
  expect(document.body).not.toHaveTextContent('Ctrl');
});

// I3: a table with a caption and the four shortcuts as its rows, the action as the row header.
// Ruling Z adds the DM call chord (Control/⌘+Shift+Enter).
// Task 9 fix round 2: Control+/ opens the same palette as Control+K, one row with both chords.
it('is a table with a caption and four rows', () => {
  render(<Keyboard />);
  const table = screen.getByRole('table', { name: 'Keyboard' });
  expect(within(table).getAllByRole('row')).toHaveLength(4);
  expect(within(table).getAllByRole('rowheader').map(h => h.textContent)).toEqual(['search', 'mute or unmute', 'deafen or undeafen', 'call the open direct message']);
});

import { render, screen } from '@testing-library/react';
import { it, expect, vi } from 'vitest';
import { Privacy } from './Privacy.tsx';

it('keeps changed contact visible and offers a named compare action', () => {
  const records = [{ userId: 'aa'.repeat(16), name: 'Ada', shared: true, umk: 'bb'.repeat(32), firstSeen: 1, verified: false, changedUmk: 'cc'.repeat(32) }];
  render(<Privacy records={records} onCompare={vi.fn()} />);
  expect(screen.getByRole('heading', { name: 'Privacy' })).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('Ada');
  expect(screen.getByRole('button', { name: 'Compare with Ada' })).toBeInTheDocument();
});

it('shows a changed identity without offering comparison when no group is shared', () => {
  const records = [{ userId: 'aa'.repeat(16), name: 'Ada', shared: false, umk: 'bb'.repeat(32), firstSeen: 1, verified: false, changedUmk: 'cc'.repeat(32) }];
  render(<Privacy records={records} onCompare={vi.fn()} />);
  expect(screen.getByRole('alert')).toHaveTextContent('Ada');
  expect(screen.getByText('Open a conversation with this person to compare numbers.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Compare with Ada' })).toBeNull();
});

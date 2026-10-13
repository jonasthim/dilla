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

// Ruling (c) of 2026-10-13: the worker derives `unlisted`; the verified state uses Flow 05's label and shows the compared key.
it('names an unlisted device and offers no comparison for it', () => {
  const records = [{ userId: 'aa'.repeat(16), name: 'Ada', shared: true, umk: 'bb'.repeat(32), firstSeen: 1, verified: false, changedUmk: null, unlisted: true as const }];
  render(<Privacy records={records} onCompare={vi.fn()} />);
  expect(screen.getByRole('status')).toHaveTextContent('This device is not on the contact’s list.');
  expect(screen.queryByRole('button', { name: 'Compare with Ada' })).toBeNull();
  expect(screen.queryByText('First seen here — not verified')).toBeNull();
});

it('shows a verified contact with the exact public key compared', () => {
  const records = [{ userId: 'aa'.repeat(16), name: 'Ada', shared: true, umk: 'bb'.repeat(32), firstSeen: 1, verified: true, changedUmk: null }];
  render(<Privacy records={records} onCompare={vi.fn()} />);
  expect(screen.getByText('verified')).toBeInTheDocument();
  expect(screen.getByText('bb'.repeat(32))).toBeInTheDocument();
  expect(screen.queryByText('First seen here — not verified')).toBeNull();
  expect(screen.getByRole('button', { name: 'Compare with Ada' })).toBeInTheDocument();
});

// Flow 05 "history pending": the worker marks a contact whose list read has not completed with `unlisted`, so even a
// verified contact shows the unlisted copy and no comparison until the newer list is read.
it('shows a history-pending contact as unlisted, without its verified key or a comparison', () => {
  const records = [{ userId: 'aa'.repeat(16), name: 'Ada', shared: true, umk: 'bb'.repeat(32), firstSeen: 1, verified: true, changedUmk: null, unlisted: true as const }];
  render(<Privacy records={records} onCompare={vi.fn()} />);
  expect(screen.getByRole('status')).toHaveTextContent('This device is not on the contact’s list.');
  expect(screen.queryByText('verified')).toBeNull();
  expect(screen.queryByText('bb'.repeat(32))).toBeNull();
  expect(screen.queryByRole('button', { name: 'Compare with Ada' })).toBeNull();
});

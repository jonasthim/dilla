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
  // M-04: no alert telling the person to compare beside a line saying they cannot; the state is plain text.
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText('Ada')).toBeInTheDocument();
  expect(screen.getByText('This contact’s identity changed. Compare the number before sending.')).toBeInTheDocument();
  expect(screen.getByText('Open a conversation with this person to compare numbers.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Compare with Ada' })).toBeNull();
});

// Ruling (c) of 2026-10-13: the worker derives `unlisted`; the verified state uses Flow 05's label and shows the compared key.
it('names an unlisted device and offers no comparison for it', () => {
  const records = [{ userId: 'aa'.repeat(16), name: 'Ada', shared: true, umk: 'bb'.repeat(32), firstSeen: 1, verified: false, changedUmk: null, unlisted: true as const }];
  render(<Privacy records={records} onCompare={vi.fn()} />);
  // M-04: static list text, not a live region.
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByText('This device is not on the contact’s list.')).toBeInTheDocument();
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
  // M-04: static list text, not a live region.
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByText('This device is not on the contact’s list.')).toBeInTheDocument();
  expect(screen.queryByText('verified')).toBeNull();
  expect(screen.queryByText('bb'.repeat(32))).toBeNull();
  expect(screen.queryByRole('button', { name: 'Compare with Ada' })).toBeNull();
});

// W-10: Compare is the design system's Button, like every other action in Settings.
it('draws Compare with the design system button', () => {
  const records = [{ userId: 'aa'.repeat(16), name: 'Ada', shared: true, umk: 'bb'.repeat(32), firstSeen: 1, verified: false, changedUmk: null }];
  render(<Privacy records={records} onCompare={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Compare with Ada' })).toHaveClass('d-btn');
});

// C1: blocked E_UMK_CHANGED with no changedUmk: changed, but no key to compare; the text says a Remove clears it.
it('shows a changed contact with no key to compare without Compare', () => {
  const records = [{ userId: 'aa'.repeat(16), name: 'Ada', shared: true, umk: 'bb'.repeat(32), firstSeen: 1, verified: false, changedUmk: null,
    blocked: 'E_UMK_CHANGED' as const }];
  render(<Privacy records={records} onCompare={vi.fn()} />);
  const alert = screen.getByRole('alert');
  expect(alert).toHaveTextContent('Ada');
  expect(alert).toHaveTextContent('Sending is paused where their changed device is a member until it’s removed.');
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByText('First seen here — not verified')).toBeNull();
});

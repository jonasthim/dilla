import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { it, expect, vi } from 'vitest';
import { Search } from './Search.tsx';

it('keeps focus and drops a stale hit before navigation', async () => {
  const user = userEvent.setup();
  const onQuery = vi.fn();
  const onPick = vi.fn();
  const onClose = vi.fn();
  const hit = { id: 'aa'.repeat(16) + ':1', channelId: 'aa'.repeat(16), communityId: null, seq: '1', snippet: 'lamp', location: 'general' };
  const view = render(<Search open query="lamp" scope="all" requestId={2} currentRequestId={2} hits={[hit]} onQuery={onQuery} onScope={vi.fn()} onPick={onPick} onClose={onClose} />);
  const input = screen.getByRole('textbox', { name: 'Search your messages' });
  input.focus();
  await user.keyboard('{ArrowDown}');
  expect(input).toHaveFocus();
  view.rerender(<Search open query="lamp" scope="all" requestId={1} currentRequestId={2} hits={[hit]} onQuery={onQuery} onScope={vi.fn()} onPick={onPick} onClose={onClose} />);
  expect(screen.queryByText('lamp')).toBeNull();
  expect(onPick).not.toHaveBeenCalled();
});

it('announces a missing row and focuses a surviving textbox', async () => {
  const user = userEvent.setup();
  const hit = { id: 'aa'.repeat(16) + ':1', channelId: 'aa'.repeat(16), communityId: null, seq: '1', snippet: 'gone', location: 'general' };
  render(<Search open query="gone" scope="all" requestId={1} currentRequestId={1} hits={[hit]} onQuery={vi.fn()} onScope={vi.fn()} onPick={() => Promise.resolve(false)} onClose={vi.fn()} />);
  await user.click(screen.getByRole('option', { name: /gone/ }));
  expect(screen.getByRole('status')).toHaveTextContent('That message is no longer available');
  expect(screen.getByRole('textbox', { name: 'Search your messages' })).toHaveFocus();
});

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
  const input = screen.getByRole('combobox', { name: 'Search your messages' });
  input.focus();
  await user.keyboard('{ArrowDown}');
  expect(input).toHaveFocus();
  view.rerender(<Search open query="lamp" scope="all" requestId={1} currentRequestId={2} hits={[hit]} onQuery={onQuery} onScope={vi.fn()} onPick={onPick} onClose={onClose} />);
  expect(screen.queryByText('lamp')).toBeNull();
  expect(onPick).not.toHaveBeenCalled();
});

it('names its close button for the search, not for Settings', async () => {
  const onClose = vi.fn();
  render(<Search open query="" scope="all" requestId={0} currentRequestId={0} hits={[]} onQuery={vi.fn()} onScope={vi.fn()} onPick={vi.fn()} onClose={onClose} />);
  expect(screen.queryByRole('button', { name: 'Close settings' })).toBeNull();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledOnce();
});

it('announces a missing row and focuses a surviving textbox', async () => {
  const user = userEvent.setup();
  const hit = { id: 'aa'.repeat(16) + ':1', channelId: 'aa'.repeat(16), communityId: null, seq: '1', snippet: 'gone', location: 'general' };
  render(<Search open query="gone" scope="all" requestId={1} currentRequestId={1} hits={[hit]} onQuery={vi.fn()} onScope={vi.fn()} onPick={() => Promise.resolve(false)} onClose={vi.fn()} />);
  await user.click(screen.getByRole('option', { name: /gone/ }));
  expect(screen.getByRole('status')).toHaveTextContent('That message is no longer available');
  expect(screen.getByRole('combobox', { name: 'Search your messages' })).toHaveFocus();
});

// J1, R-S4: on a desktop the palette is the one modal dialog (no wrapper of its own): the shell stays in the DOM and Escape gives focus back.
it('is the palette’s own modal dialog on a desktop, over a shell that stays mounted, and Escape returns focus', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const Host = ({ open }: { open: boolean }) => <>
    <main><button type="button">opener</button></main>
    <Search open={open} query="" scope="all" requestId={0} currentRequestId={0} hits={[]} onQuery={vi.fn()} onScope={vi.fn()} onPick={vi.fn()} onClose={onClose} />
  </>;
  const view = render(<Host open={false} />);
  screen.getByRole('button', { name: 'opener' }).focus();
  view.rerender(<Host open />);
  const dialog = screen.getByRole('dialog', { name: 'Search your messages' });
  expect(dialog).toHaveClass('d-search-palette-dialog');
  expect(document.querySelectorAll('dialog')).toHaveLength(1);
  expect(document.querySelector('.dw-search')).toBeNull();
  expect(screen.getByRole('button', { name: 'opener', hidden: true })).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'Search your messages' })).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalledOnce();
  view.rerender(<Host open={false} />);
  expect(screen.getByRole('button', { name: 'opener' })).toHaveFocus();
});

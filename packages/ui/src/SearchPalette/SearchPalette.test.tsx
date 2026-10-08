import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { expectNoAxeViolations } from '../test/setup.ts';
import { SearchPalette } from './SearchPalette.tsx';

const hits = [{ id: 'hit-1', snippet: 'lamp one', location: 'general' }, { id: 'hit-2', snippet: 'lamp two', location: 'loot' }];
const labels = { search: 'Search your messages', empty: 'No results in this scope', close: 'Close', scope: { channel: 'this conversation', community: 'this community', all: 'everything' } };

describe('SearchPalette', () => {
  it('keeps textbox focus while arrows and Enter choose a result', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    const view = render(<SearchPalette open query="lamp" scope="all" hits={hits} labels={labels} onQuery={vi.fn()} onScope={vi.fn()} onPick={onPick} onClose={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: labels.search });
    input.focus();
    await user.keyboard('{ArrowDown}');
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('aria-activedescendant', hits[1].id);
    await user.keyboard('{Enter}');
    expect(onPick).toHaveBeenCalledExactlyOnceWith('hit-2');
    expect(screen.getByRole('listbox').querySelectorAll('[role="option"]')).toHaveLength(2);
    await expectNoAxeViolations(view.container);
  });
  it('announces one empty status, changes scope and closes on Escape', async () => {
    const user = userEvent.setup();
    const onScope = vi.fn();
    const onClose = vi.fn();
    render(<SearchPalette open query="absent" scope="channel" hits={[]} labels={labels} onQuery={vi.fn()} onScope={onScope} onPick={vi.fn()} onClose={onClose} />);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent(labels.empty);
    await user.click(screen.getByRole('button', { name: labels.scope.all }));
    expect(onScope).toHaveBeenCalledWith('all');
    screen.getByRole('textbox', { name: labels.search }).focus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });
  it('keeps selection, active descendant, arrows and Enter aligned after hits shrink', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    const props = { open: true, query: 'lamp', scope: 'all' as const, labels, onQuery: vi.fn(), onScope: vi.fn(), onPick, onClose: vi.fn() };
    const view = render(<SearchPalette {...props} hits={hits} />);
    const input = screen.getByRole('textbox', { name: labels.search });
    input.focus();
    await user.keyboard('{ArrowDown}');
    const replacement = [{ id: 'fresh', snippet: 'new result', location: 'general' }];
    view.rerender(<SearchPalette {...props} hits={replacement} />);
    expect(input).toHaveAttribute('aria-activedescendant', 'fresh');
    expect(screen.getByRole('option', { name: /new result/ })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');
    expect(onPick).toHaveBeenCalledExactlyOnceWith('fresh');
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('option', { name: /new result/ })).toHaveAttribute('aria-selected', 'true');
  });
});

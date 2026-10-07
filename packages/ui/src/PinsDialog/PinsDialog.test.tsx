import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { PinsDialog, type PinsDialogProps } from './PinsDialog.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

function item(n: number, spy = vi.fn()): PinsDialogProps['items'][number] {
  return { id: `p${n}`, author: n === 1 ? 'björn' : 'mira', time: '21:0' + String(n), excerpt: `pinned text ${n}`, pinnedBy: 'pinned by ada',
    jumpLabel: 'go to message', onJump: () => spy(`jump ${n}`), unpinLabel: 'unpin', onUnpin: () => spy(`unpin ${n}`) };
}

describe('PinsDialog', () => {
  it('lists the pins with author, time, excerpt and who pinned, each button described by its excerpt', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<PinsDialog open title="Pinned in #general" closeLabel="Close" onClose={() => {}} emptyLabel="Nothing is pinned here yet."
      items={[item(1, spy), item(2, spy)]} />);
    const dialog = screen.getByRole('dialog', { name: 'Pinned in #general' });
    const rows = within(dialog).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('björn');
    expect(rows[0]).toHaveTextContent('21:01');
    expect(rows[0]).toHaveTextContent('pinned text 1');
    expect(rows[0]).toHaveTextContent('pinned by ada');
    const jump = within(rows[1]!).getByRole('button', { name: 'go to message' });
    expect(jump).toHaveAccessibleDescription('pinned text 2');
    expect(within(rows[1]!).getByRole('button', { name: 'unpin' })).toHaveAccessibleDescription('pinned text 2');
    await user.click(jump);
    await user.click(within(rows[0]!).getByRole('button', { name: 'unpin' }));
    expect(spy.mock.calls.map((c) => c[0])).toEqual(['jump 2', 'unpin 1']);
    expect(screen.queryByText('Nothing is pinned here yet.')).toBeNull();
  });

  it('says so when nothing is pinned, and closes from Escape and from its close button', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<PinsDialog open title="Pinned with mira" closeLabel="Close" onClose={onClose} emptyLabel="Nothing is pinned here yet." items={[]} />);
    expect(screen.getByText('Nothing is pinned here yet.')).toHaveClass('d-pins-dialog__empty');
    expect(screen.queryByRole('list')).toBeNull();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('shows nothing while closed', () => {
    render(<PinsDialog open={false} title="Pinned in #general" closeLabel="Close" onClose={() => {}} emptyLabel="Nothing is pinned here yet." items={[item(1)]} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('pinned text 1')).toBeNull();
  });

  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><PinsDialog open title="Pinned in #general" closeLabel="Close" onClose={() => {}}
      emptyLabel="Nothing is pinned here yet." items={[item(1), item(2)]} /></div>);
    await expectNoAxeViolations(container);
  });
});

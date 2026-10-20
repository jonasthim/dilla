import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { AddServerDialog } from './AddServerDialog.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

function Harness({ onJoin = () => {}, onCreate = () => {} }: { onJoin?(): void; onCreate?(): void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="d-root">
      <button type="button" onClick={() => setOpen(true)}>add a server</button>
      <AddServerDialog open={open} title="add a server" joinLabel="join a server" createLabel="new server" onClose={() => setOpen(false)} onJoin={onJoin} onCreate={onCreate} />
    </div>
  );
}

describe('AddServerDialog', () => {
  it('is one dialog named add a server with the two choices, focus on the first', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'add a server' }));
    const dialog = screen.getByRole('dialog', { name: 'add a server' });
    expect(dialog).toBeInTheDocument();
    const inside = screen.getAllByRole('button').filter(b => dialog.contains(b)).map(b => b.textContent ?? '');
    expect(inside.slice(0, 2)).toEqual(['join a server', 'new server']);
    expect(inside[2]).toMatch(/^Close/);
    expect(screen.getByRole('button', { name: 'join a server' })).toHaveFocus();
  });
  it('Escape closes and focus goes back to the opener', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'add a server' });
    await user.click(opener);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });
  it('a choice closes the dialog and calls its own handler only', async () => {
    const user = userEvent.setup();
    const onJoin = vi.fn(); const onCreate = vi.fn();
    render(<Harness onJoin={onJoin} onCreate={onCreate} />);
    await user.click(screen.getByRole('button', { name: 'add a server' }));
    await user.click(screen.getByRole('button', { name: 'new server' }));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onJoin).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'add a server' }));
    await user.click(screen.getByRole('button', { name: 'join a server' }));
    expect(onJoin).toHaveBeenCalledTimes(1);
  });
  it('has no serious axe violations', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'add a server' }));
    await expectNoAxeViolations(container);
  });
});

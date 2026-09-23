import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Dialog } from './Dialog.tsx';
import { Button } from '../Button/Button.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

describe('Dialog', () => {
  it('opens as a modal dialog named by its title and closes on Escape', async () => {
    const onClose = vi.fn();
    render(<Dialog open title="Leave voice?" onClose={onClose}><p>You can rejoin any time.</p></Dialog>);
    const dialog = screen.getByRole('dialog', { name: 'Leave voice?' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it('renders nothing visible when closed', () => {
    render(<Dialog open={false} title="Hidden" onClose={() => {}}><p>x</p></Dialog>);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('has a close button in the footer by default', async () => {
    const onClose = vi.fn();
    render(<Dialog open title="Verify device" onClose={onClose}><p>Compare the code.</p></Dialog>);
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><Dialog open title="Leave voice?" onClose={() => {}} footer={<Button variant="danger">Leave</Button>}><p>You can rejoin any time.</p></Dialog></div>);
    await expectNoAxeViolations(container);
  });
});

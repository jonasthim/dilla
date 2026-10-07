import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { AttachmentTray, type AttachmentTrayProps } from './AttachmentTray.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

const STEPS = ['reading', 'preparing', 'uploading', 'ready', 'failed'] as const;
function items(spy = vi.fn()): AttachmentTrayProps['items'] {
  return STEPS.map((step, i) => ({
    id: `t${i}`, name: `file${i}.png`, size: `${i + 1}.0 KB`, step, failed: step === 'failed',
    phase: step === 'failed' ? 'failed (E_TOO_LARGE)' : step, removeLabel: `remove file${i}.png`, onRemove: () => spy(i),
  }));
}

describe('AttachmentTray', () => {
  it('lists each file with its size, its phase in a polite live region and data-phase', () => {
    render(<AttachmentTray label="files to send" items={items()} />);
    const list = screen.getByRole('list', { name: 'files to send' });
    expect(list).toHaveClass('d-attachment-tray');
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('data-phase'))).toEqual([...STEPS]);
    expect(rows.map((r) => r.getAttribute('data-failed'))).toEqual([null, null, null, null, 'true']);
    expect(rows[2]).toHaveTextContent('file2.png');
    expect(rows[2]).toHaveTextContent('3.0 KB');
    const phase = rows[4]!.querySelector('.d-attachment-tray__phase')!;
    expect(phase.textContent).toBe('failed (E_TOO_LARGE)');
    expect(phase).toHaveAttribute('aria-live', 'polite');
  });

  it('shows a failed entry\'s hint', () => {
    render(<AttachmentTray label="files to send" items={[{ id: '1', name: 'a.png', size: '2 KB', phase: 'failed (E_QUOTA)', failed: true, step: 'failed', hint: 'Remove it and attach it again.', removeLabel: 'remove a.png', onRemove: () => {} }]} />);
    expect(screen.getByText('Remove it and attach it again.')).toBeInTheDocument();
  });

  it('removes an entry from its named button', async () => {
    const spy = vi.fn();
    render(<AttachmentTray label="files to send" items={items(spy)} />);
    await userEvent.click(screen.getByRole('button', { name: 'remove file3.png' }));
    expect(spy).toHaveBeenCalledWith(3);
  });

  it('renders nothing when empty', () => {
    const { container } = render(<AttachmentTray label="files to send" items={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><AttachmentTray label="files to send" items={items()} /></div>);
    await expectNoAxeViolations(container);
  });
});

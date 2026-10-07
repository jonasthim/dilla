import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { AttachmentCard, type AttachmentCardProps } from './AttachmentCard.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

const BASE: AttachmentCardProps = {
  kind: 'image', name: 'drawn.png', size: '48 KB', thumbUrl: 'blob:http://127.0.0.1/thumb', w: 640, h: 480,
  openLabel: 'open drawn.png', onOpen: () => {}, saveLabel: 'save drawn.png', onSave: () => {}, state: 'idle', tabbable: true,
};

describe('AttachmentCard', () => {
  it('an image card is one button named open, holding the thumbnail with the name as alt text', async () => {
    const onOpen = vi.fn();
    const { container } = render(<AttachmentCard {...BASE} onOpen={onOpen} />);
    const card = container.firstElementChild!;
    expect(card).toHaveClass('d-attachment-card');
    expect(card).toHaveAttribute('data-kind', 'image');
    expect(card).toHaveAttribute('data-state', 'idle');
    const open = screen.getByRole('button', { name: 'open drawn.png' });
    expect(screen.getAllByRole('button')).toEqual([open]);
    const img = screen.getByRole('img', { name: 'drawn.png' });
    expect(img).toHaveAttribute('src', 'blob:http://127.0.0.1/thumb');
    expect(img).toHaveAttribute('data-thumb', 'ready');
    expect(open.style.getPropertyValue('--d-card-ratio')).toBe('640 / 480');
    expect(open.style.getPropertyValue('--d-card-w')).toBe('20rem');
    await userEvent.click(open);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('draws a neutral box until the thumbnail is there, and sizes a small image by its own size', () => {
    const { container } = render(<AttachmentCard {...BASE} thumbUrl={null} w={100} h={50} />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(container.querySelector('.d-attachment-card__box')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('button', { name: 'open drawn.png' }).style.getPropertyValue('--d-card-w')).toBe('6.25rem');
  });

  it('a file card shows its name and size and is one save button', async () => {
    const onSave = vi.fn();
    render(<AttachmentCard {...BASE} kind="file" name="route.gpx" size="12.4 KB" thumbUrl={null} w={null} h={null}
      openLabel="open route.gpx" onOpen={undefined} saveLabel="save route.gpx" onSave={onSave} />);
    expect(screen.getByText('route.gpx')).toBeInTheDocument();
    expect(screen.getByText('12.4 KB')).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'save route.gpx' });
    expect(screen.getAllByRole('button')).toEqual([save]);
    await userEvent.click(save);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('a too-large card has no button and says why', () => {
    render(<AttachmentCard {...BASE} state="too-large" stateText="too large to open in a browser" thumbUrl={null} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('too large to open in a browser')).toHaveClass('d-attachment-card__state');
  });

  it('a loading card is busy; a failed card shows its state; tabbable decides the tab stop', () => {
    const { rerender } = render(<AttachmentCard {...BASE} state="loading" stateText="opening…" />);
    expect(screen.getByRole('button', { name: 'open drawn.png' })).toHaveAttribute('aria-busy', 'true');
    rerender(<AttachmentCard {...BASE} state="failed" stateText="could not open (E_BLOB_OPEN)" tabbable={false} />);
    expect(screen.getByText('could not open (E_BLOB_OPEN)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'open drawn.png' })).not.toHaveAttribute('aria-busy');
    expect(screen.getByRole('button', { name: 'open drawn.png' }).tabIndex).toBe(-1);
  });

  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><AttachmentCard {...BASE} />
      <AttachmentCard {...BASE} kind="file" name="route.gpx" size="12.4 KB" thumbUrl={null} openLabel="open route.gpx" saveLabel="save route.gpx" /></div>);
    await expectNoAxeViolations(container);
  });

  it('renders no save button without onSave (SLICE-UX-14)', () => {
    render(<AttachmentCard kind="file" name="notes.txt" size="2 KB" thumbUrl={null} w={null} h={null} openLabel="open notes.txt" saveLabel="save notes.txt" state="idle" tabbable />);
    expect(screen.queryByRole('button', { name: 'save notes.txt' })).toBeNull();
  });
});

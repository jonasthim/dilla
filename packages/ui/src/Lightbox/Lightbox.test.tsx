import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Lightbox, type LightboxProps } from './Lightbox.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

function box(over: Partial<LightboxProps> = {}) {
  const spy = vi.fn();
  const r = render(<Lightbox open label="drawn.png, 48 KB" src="blob:http://127.0.0.1/full" alt="drawn.png" closeLabel="Close" onClose={() => spy('close')}
    saveLabel="Save" onSave={() => spy('save')} previous={{ label: 'Previous image', onPrevious: () => spy('previous') }}
    next={{ label: 'Next image', onNext: () => spy('next') }} {...over} />);
  return { ...r, spy };
}

describe('Lightbox', () => {
  it('opens as a dialog named by its label, with the image and its buttons; Close takes focus', () => {
    const { container } = box();
    const dialog = screen.getByRole('dialog', { name: 'drawn.png, 48 KB' });
    expect(dialog.tagName).toBe('DIALOG');
    expect(dialog).toHaveClass('d-lightbox');
    expect(screen.getByRole('img', { name: 'drawn.png' })).toHaveAttribute('src', 'blob:http://127.0.0.1/full');
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Previous image', 'Next image', 'Save', 'Close']);
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    expect(container.querySelector('.d-lightbox__label')?.textContent).toBe('drawn.png, 48 KB');
  });

  it('Escape closes; the arrows move to the previous and next image; the buttons do what they say', async () => {
    const user = userEvent.setup();
    const { spy } = box();
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(screen.getByRole('button', { name: 'Next image' }));
    expect(spy.mock.calls.map((c) => c[0])).toEqual(['previous', 'next', 'close', 'save', 'next']);
  });

  it('without previous and next the arrows do nothing; without a source there is no image', () => {
    const { spy } = box({ previous: undefined, next: undefined, src: null });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowLeft' });
    expect(spy).not.toHaveBeenCalled();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Save', 'Close']);
  });

  it('shows nothing while closed', () => {
    box({ open: false });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('has no serious axe violations', async () => {
    const { container } = box();
    await expectNoAxeViolations(container);
  });
});

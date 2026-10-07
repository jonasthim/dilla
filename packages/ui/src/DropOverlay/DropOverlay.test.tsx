import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { DropOverlay } from './DropOverlay.tsx';

describe('DropOverlay', () => {
  it('shows its title and body, hidden from assistive tech, only while active', () => {
    const { container, rerender } = render(<DropOverlay active title="Drop to attach" body="Up to 4 files, 25 MB each." />);
    const overlay = container.firstElementChild!;
    expect(overlay).toHaveClass('d-drop-overlay');
    expect(overlay).toHaveAttribute('aria-hidden', 'true');
    expect(overlay.querySelector('.d-drop-overlay__title')?.textContent).toBe('Drop to attach');
    expect(overlay.querySelector('.d-drop-overlay__body')?.textContent).toBe('Up to 4 files, 25 MB each.');
    rerender(<DropOverlay active={false} title="Drop to attach" body="Up to 4 files, 25 MB each." />);
    expect(container.firstChild).toBeNull();
  });
});

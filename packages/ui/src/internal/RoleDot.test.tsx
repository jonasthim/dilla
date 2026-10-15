import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { RoleDot } from './RoleDot.tsx';
import { hex } from './hex.ts';

describe('hex', () => {
  it('formats 0xRRGGBB as #rrggbb, zero padded and masked to 24 bits', () => {
    expect(hex(0xe74c3c)).toBe('#e74c3c');
    expect(hex(0x0000ff)).toBe('#0000ff');
    expect(hex(0x1ffffff)).toBe('#ffffff');
  });
});

describe('RoleDot', () => {
  it('is an aria-hidden dot filled through --d-swatch', () => {
    const { container } = render(<RoleDot color={0x3498db} />);
    const dot = container.firstElementChild as HTMLElement;
    expect(dot).toHaveClass('d-role-dot');
    expect(dot).not.toHaveClass('d-role-dot--inline');
    expect(dot).toHaveAttribute('aria-hidden', 'true');
    expect(dot.style.getPropertyValue('--d-swatch')).toBe('#3498db');
  });

  it('inline adds the modifier', () => {
    const { container } = render(<RoleDot color={0x3498db} inline />);
    expect(container.firstElementChild).toHaveClass('d-role-dot', 'd-role-dot--inline');
  });
});

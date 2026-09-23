import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Avatar } from './Avatar.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';
import { contrastRatio } from '@dilla/design-tokens';

// HSL to RGB conversion
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;

  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];

  const m = l - c / 2;
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255)
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

describe('Avatar', () => {
  it('derives initials and announces presence in the name', () => {
    render(<Avatar name="jonas" presence="online" />);
    const img = screen.getByRole('img', { name: 'jonas, online' });
    expect(img).toHaveTextContent('JO');
  });
  it('uses given initials and omits presence text when unknown', () => {
    render(<Avatar name="Skald" initials="SK" />);
    expect(screen.getByRole('img', { name: 'Skald' })).toHaveTextContent('SK');
  });
  it('shows presence with a glyph, not only colour', () => {
    render(<Avatar name="lina" presence="idle" />);
    expect(screen.getByRole('img', { name: 'lina, idle' }).querySelector('[data-presence="idle"]')).not.toBeNull();
  });
  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><Avatar name="erik" presence="dnd" size="lg" /></div>);
    await expectNoAxeViolations(container);
  });
  it('maintains ≥4.5:1 contrast with white across all avatar hues', () => {
    // The avatar background uses HSL(H 45% 42%) with white text (#fff)
    // All hues in the curated palette must maintain >= 4.5:1 contrast
    const AVATAR_HUES = [0, 20, 210, 230, 250, 270, 300, 330];
    const MIN_CONTRAST = 4.5;

    AVATAR_HUES.forEach(hue => {
      const [r, g, b] = hslToRgb(hue, 45, 42);
      const bgHex = rgbToHex(r, g, b);
      const ratio = contrastRatio('#FFFFFF', bgHex);
      expect(ratio, `Hue ${hue}° has contrast ${ratio.toFixed(2)}:1 with white`).toBeGreaterThanOrEqual(MIN_CONTRAST);
    });
  });
});

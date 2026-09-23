import { describe, it, expect } from 'vitest';
import { themes, TEXT_PAIRS, UI_PAIRS, structural, densities, type ThemeName } from './tokens.ts';
import { contrastRatio } from './contrast.ts';

const names = Object.keys(themes) as ThemeName[];

describe('themes', () => {
  it('defines mesh, light and high-contrast with the same keys', () => {
    expect(names.sort()).toEqual(['high-contrast', 'light', 'mesh']);
    const keys = Object.keys(themes.mesh).sort();
    for (const n of names) expect(Object.keys(themes[n]).sort()).toEqual(keys);
  });
  it('keeps the Mesh accent and background', () => {
    expect(themes.mesh.bg).toBe('#070809');
    expect(themes.mesh.accent).toBe('#7CFF8E');
    expect(themes.mesh.fg4).toBe('#5E635E');
  });
});

describe('WCAG AA guard', () => {
  for (const n of names) {
    for (const [fg, bg] of TEXT_PAIRS) {
      it(`${n}: text ${fg} on ${bg} is at least 4.5:1`, () => {
        expect(contrastRatio(themes[n][fg], themes[n][bg])).toBeGreaterThanOrEqual(4.5);
      });
    }
    for (const [fg, bg] of UI_PAIRS) {
      it(`${n}: ui ${fg} on ${bg} is at least 3:1`, () => {
        expect(contrastRatio(themes[n][fg], themes[n][bg])).toBeGreaterThanOrEqual(3);
      });
    }
  }
  it('high-contrast underlines links', () => {
    expect(themes['high-contrast'].linkUnderline).toBe(1);
    expect(themes.mesh.linkUnderline).toBe(0);
  });
});

describe('structural tokens', () => {
  it('has the Mesh radii and layout dimensions', () => {
    expect(structural.radius.md).toBe('2px');
    expect(structural.radius.pill).toBe('999px');
    expect(structural.layout.railW).toBe('60px');
    expect(structural.layout.bottombarH).toBe('26px');
  });
  it('has three densities', () => {
    expect(Object.keys(densities)).toEqual(['compact', 'regular', 'cozy']);
    expect(densities.regular.avatar).toBe('32px');
  });
});

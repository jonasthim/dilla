import { describe, it, expect } from 'vitest';
import { relativeLuminance, contrastRatio, parseColor, composite } from './contrast.ts';
import { contrastRatio as contrastRatioFromRoot } from '../src/index.ts';

describe('parseColor', () => {
  it('parses hex and rgba', () => {
    expect(parseColor('#FFFFFF')).toEqual([255, 255, 255, 1]);
    expect(parseColor('#070809')).toEqual([7, 8, 9, 1]);
    expect(parseColor('rgba(124,255,142,0.14)')).toEqual([124, 255, 142, 0.14]);
    expect(() => parseColor('blue')).toThrow();
  });
});

describe('relativeLuminance', () => {
  it('is 0 for black and 1 for white', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 6);
  });
});

describe('contrastRatio', () => {
  it('is 21 for white on black and symmetric', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 2);
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 2);
  });
  it('matches the well-known 4.54:1 of #767676 on white', () => {
    expect(contrastRatio('#767676', '#FFFFFF')).toBeCloseTo(4.54, 2);
  });
  it('flattens alpha colours onto the background before comparing', () => {
    // 14% green tint on near-black is almost the background: ratio close to 1
    expect(contrastRatio('rgba(124,255,142,0.14)', '#070809')).toBeLessThan(1.6);
  });
});

describe('composite', () => {
  it('returns the background for alpha 0 and the foreground for alpha 1', () => {
    expect(composite('rgba(255,0,0,0)', '#070809')).toBe('#070809');
    expect(composite('rgba(255,0,0,1)', '#070809')).toBe('#ff0000');
  });
});

describe('package root export', () => {
  it('exports functions from the package entry point', () => {
    expect(contrastRatioFromRoot('#FFFFFF', '#000000')).toBeCloseTo(21, 2);
  });
});

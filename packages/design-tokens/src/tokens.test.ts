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
  });
  it('states the type scale in rem at a 16px root, never px', () => {
    expect(structural.text).toEqual({
      micro: '0.625rem', xs: '0.6875rem', sm: '0.78125rem', base: '0.84375rem',
      md: '0.875rem', lg: '1.0625rem', xl: '1.375rem',
    });
    for (const [step, size] of Object.entries(structural.text)) {
      expect(size, `--text-${step} must be rem so browser text size and 200 % zoom scale it`).toMatch(/rem$/);
    }
  });
  it('sizes the boxes that bound text in rem, and only the resizable panes in px', () => {
    // A box that bounds scale text has to grow with the text (WCAG 1.4.4):
    // a px bar around rem text clips it. The pane widths are furniture the
    // user drags, not text boxes, so they stay px.
    expect(structural.layout.topbarH).toBe('2rem');
    expect(structural.layout.bottombarH).toBe('1.625rem');
    expect(structural.layout.channelHeaderH).toBe('3rem');
    expect(structural.layout.railW).toBe('60px');
    expect(structural.layout.sidebarW).toBe('240px');
    expect(structural.layout.membersW).toBe('232px');
    expect(structural.layout.threadW).toBe('380px');
  });
  it('has three densities, every length in rem', () => {
    expect(Object.keys(densities)).toEqual(['compact', 'regular', 'cozy']);
    expect(densities.regular.avatar).toBe('2rem');
    for (const [name, d] of Object.entries(densities)) {
      for (const key of ['rowPadY', 'rowPadX', 'rowGap', 'groupGap', 'avatar'] as const) {
        expect(d[key], `densities.${name}.${key} must be rem so a raised text size keeps fitting`).toMatch(/rem$/);
      }
      // Unitless on purpose: a line height already scales with its font size.
      expect(d.lineHeight).toMatch(/^[\d.]+$/);
    }
  });
});

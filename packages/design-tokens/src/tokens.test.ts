import { describe, it, expect } from 'vitest';
import { themes, TEXT_PAIRS, UI_PAIRS, structural, densities, type ThemeName } from './tokens.ts';
import { contrastRatio } from './contrast.ts';

const names = Object.keys(themes) as ThemeName[];

describe('themes', () => {
  it('defines signal, light and high-contrast with the same keys', () => {
    expect([...names].sort()).toEqual(['high-contrast', 'light', 'signal']);
    expect(names).toEqual(['signal', 'light', 'high-contrast']);
    const keys = Object.keys(themes.signal).sort();
    for (const n of names) expect(Object.keys(themes[n]).sort()).toEqual(keys);
  });
  it('has the Signal background and blue accent', () => {
    expect(themes.signal.bg).toBe('#08090B');
    expect(themes.signal.accent).toBe('#5AA8E6');
    expect(themes.signal.fg4).toBe('#5C636E');
  });
  it('moves light and high-contrast to the blue accent', () => {
    expect(themes.light.accent).toBe('#005799');
    expect(themes['high-contrast'].accent).toBe('#9CCBFF');
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
    expect(themes.signal.linkUnderline).toBe(0);
  });
});

describe('structural tokens', () => {
  it('has the Signal radii and layout dimensions', () => {
    expect(structural.radius).toEqual({
      sm: '4px', md: '6px', lg: '8px', xl: '10px', xxl: '12px', pill: '999px', avatar: '999px', bot: '6px', seg: '7px',
    });
    expect(structural.layout.railW).toBe('56px');
  });
  it('states the type scale in rem at a 16px root, never px', () => {
    expect(structural.text).toEqual({
      micro: '0.625rem', tag: '0.53125rem', chip: '0.59375rem', xs: '0.6875rem', btn: '0.71875rem', sm: '0.78125rem', input: '0.8125rem', base: '0.84375rem',
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
    expect(structural.layout.topbarH).toBe('2.75rem');
    expect(structural.layout.bottombarH).toBe('1.625rem');
    expect(structural.layout.channelHeaderH).toBe('2.75rem');
    expect(structural.layout.barH).toBe('2.75rem');
    expect(structural.layout.panelH).toBe('4rem');
    expect(structural.layout.rowH).toBe('1.75rem');
    expect(structural.layout.rowHSub).toBe('1.625rem');
    expect(structural.layout.rowH2).toBe('2.75rem');
    expect(structural.layout.listGap).toBe('0.0625rem');
    expect(structural.layout.railTile).toBe('38px');
    expect(structural.layout.slotW).toBe('32px');
    expect(structural.layout.railW).toBe('56px');
    expect(structural.layout.sidebarW).toBe('244px');
    expect(structural.layout.membersW).toBe('232px');
    expect(structural.layout.threadW).toBe('340px');
  });
  it('keeps every bar, row and panel height in rem', () => {
    for (const k of ['topbarH', 'barH', 'channelHeaderH', 'panelH', 'rowH', 'rowHSub'] as const) {
      expect(structural.layout[k], `--${k} must be rem so 200 % text does not clip it`).toMatch(/rem$/);
    }
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

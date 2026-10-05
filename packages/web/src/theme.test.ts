import { describe, it, expect } from 'vitest';
import { applyTheme, followSystemTheme, preferredTheme, THEME_QUERIES } from './theme.ts';

const matching = (on: string[]) => (q: string) => ({ matches: on.includes(q) });

describe('preferredTheme', () => {
  it('follows the OS, and contrast wins over the colour scheme', () => {
    expect(preferredTheme(matching([]))).toBe('mesh');
    expect(preferredTheme(matching([THEME_QUERIES.light]))).toBe('light');
    expect(preferredTheme(matching([THEME_QUERIES.contrast]))).toBe('high-contrast');
    expect(preferredTheme(matching([THEME_QUERIES.light, THEME_QUERIES.contrast]))).toBe('high-contrast');
  });
});

describe('applyTheme', () => {
  it('sets the theme and the regular density', () => {
    const el = document.createElement('html');
    applyTheme(el, 'light');
    expect(el.dataset.theme).toBe('light');
    expect(el.dataset.density).toBe('regular');
  });
});

describe('followSystemTheme', () => {
  it('applies now, follows changes and stops when asked', () => {
    const on = new Set<string>();
    const handlers = new Map<string, Set<() => void>>();
    const mql = (q: string) => ({
      get matches() { return on.has(q); },
      addEventListener: (_: 'change', h: () => void) => { handlers.set(q, (handlers.get(q) ?? new Set()).add(h)); },
      removeEventListener: (_: 'change', h: () => void) => { handlers.get(q)?.delete(h); },
    }) as unknown as MediaQueryList;
    const doc = document.implementation.createHTMLDocument('t');
    const stop = followSystemTheme({ matchMedia: mql, document: doc });
    expect(doc.documentElement.dataset.theme).toBe('mesh');
    on.add(THEME_QUERIES.light);
    handlers.get(THEME_QUERIES.light)?.forEach(h => h());
    expect(doc.documentElement.dataset.theme).toBe('light');
    stop();
    expect(handlers.get(THEME_QUERIES.light)?.size ?? 0).toBe(0);
    expect(handlers.get(THEME_QUERIES.contrast)?.size ?? 0).toBe(0);
  });
});

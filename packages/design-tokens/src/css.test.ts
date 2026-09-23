import { describe, it, expect } from 'vitest';
import { renderCss, kebab } from './css.ts';

describe('kebab', () => {
  it('maps token keys to custom property names', () => {
    expect(kebab('bg2')).toBe('bg-2');
    expect(kebab('surfaceHi')).toBe('surface-hi');
    expect(kebab('accentInk')).toBe('accent-ink');
    expect(kebab('fg')).toBe('fg');
  });
});

describe('renderCss', () => {
  const css = renderCss();
  it('sets the mesh theme on :root and the others on data-theme', () => {
    expect(css).toMatch(/:root\s*{[^}]*--bg:\s*#070809;/);
    expect(css).toMatch(/\[data-theme="light"\]\s*{[^}]*--bg:\s*#F5F6F5;/);
    expect(css).toMatch(/\[data-theme="high-contrast"\]\s*{[^}]*--link-underline:\s*1;/);
  });
  it('follows the OS light setting only when no theme is chosen', () => {
    expect(css).toMatch(/@media \(prefers-color-scheme: light\)\s*{\s*:root:not\(\[data-theme\]\)\s*{[^}]*--bg:\s*#F5F6F5;/);
  });
  it('emits densities and reduced motion', () => {
    expect(css).toMatch(/\[data-density="compact"\]\s*{[^}]*--avatar-size:\s*28px;/);
    expect(css).toMatch(/:root\s*{[^}]*--row-pad-y:\s*6px;/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*{\s*:root\s*{[^}]*--duration-fast:\s*0ms;/);
  });
  it('emits structural tokens', () => {
    expect(css).toContain('--r-md: 2px;');
    expect(css).toContain('--rail-w: 60px;');
    expect(css).toContain('--focus-ring: 2px solid var(--accent);');
    expect(css).toContain('--font-mono: "JetBrains Mono Variable"');
  });
});

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
it('committed dist/tokens.css equals renderCss()', () => {
  const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'tokens.css');
  expect(readFileSync(dist, 'utf8')).toBe(renderCss());
});

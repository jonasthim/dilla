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
  it('follows the OS contrast preference only when no theme is chosen', () => {
    expect(css).toMatch(/@media \(prefers-contrast: more\)\s*{\s*:root:not\(\[data-theme\]\)\s*{[^}]*--bg:\s*#000000;/);
    // and it comes after the colour-scheme block, so a user who asks for
    // more contrast gets it even when the OS is set to light.
    expect(css.indexOf('@media (prefers-contrast: more)')).toBeGreaterThan(css.indexOf('@media (prefers-color-scheme: light)'));
  });
  it('emits densities and reduced motion', () => {
    expect(css).toMatch(/\[data-density="compact"\]\s*{[^}]*--avatar-size:\s*1\.75rem;/);
    expect(css).toMatch(/:root\s*{[^}]*--row-pad-y:\s*0\.375rem;/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*{\s*:root\s*{[^}]*--duration-fast:\s*0ms;/);
  });
  it('emits structural tokens', () => {
    expect(css).toContain('--r-md: 2px;');
    expect(css).toContain('--rail-w: 60px;');
    expect(css).toContain('--focus-ring: 2px solid var(--accent);');
    expect(css).toContain('--font-mono: "JetBrains Mono Variable"');
  });
  it('emits the type scale in rem, never px', () => {
    expect(css).toContain('--text-micro: 0.625rem;');
    expect(css).toContain('--text-base: 0.84375rem;');
    expect(css).toContain('--text-xl: 1.375rem;');
    expect(css).not.toMatch(/--text-[a-z]+:\s*[\d.]+px;/);
  });
  it('emits the boxes around that text in rem, and the resizable panes in px', () => {
    expect(css).toContain('--topbar-h: 2rem;');
    expect(css).toContain('--bottombar-h: 1.625rem;');
    expect(css).toContain('--channel-header-h: 3rem;');
    expect(css).toMatch(/\[data-density="cozy"\]\s*{[^}]*--avatar-size:\s*2\.25rem;/);
    expect(css).toContain('--sidebar-w: 240px;');
    expect(css).toContain('--thread-w: 380px;');
    expect(css).not.toMatch(/--(topbar-h|bottombar-h|channel-header-h|row-pad-[xy]|row-gap|group-gap|avatar-size):\s*[\d.]+px;/);
  });
});

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
it('committed dist/tokens.css equals renderCss()', () => {
  const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'tokens.css');
  expect(readFileSync(dist, 'utf8')).toBe(renderCss());
});

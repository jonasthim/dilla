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
  it('sets the signal theme on :root and the others on data-theme', () => {
    expect(css).toMatch(/:root\s*{[^}]*--bg:\s*#08090B;/);
    expect(css).toMatch(/\[data-theme="signal"\]\s*{[^}]*--bg:\s*#08090B;/);
    expect(css).toMatch(/\[data-theme="light"\]\s*{[^}]*--bg:\s*#F5F6F5;/);
    expect(css).toMatch(/\[data-theme="high-contrast"\]\s*{[^}]*--link-underline:\s*1;/);
    expect(css.toLowerCase()).not.toContain('mesh');
  });
  it('follows the OS light setting only when no theme is chosen', () => {
    expect(css).toMatch(/@media \(prefers-color-scheme: light\)\s*{\s*:root:not\(\[data-theme\]\)\s*{[^}]*--bg:\s*#F5F6F5;[^}]*--accent:\s*#005799;/);
  });
  it('follows the OS contrast preference only when no theme is chosen', () => {
    expect(css).toMatch(/@media \(prefers-contrast: more\)\s*{\s*:root:not\(\[data-theme\]\)\s*{[^}]*--bg:\s*#000000;[^}]*--accent:\s*#9CCBFF;/);
    // and it comes after the colour-scheme block, so a user who asks for
    // more contrast gets it even when the OS is set to light.
    expect(css.indexOf('@media (prefers-contrast: more)')).toBeGreaterThan(css.indexOf('@media (prefers-color-scheme: light)'));
  });
  it('emits densities', () => {
    expect(css).toMatch(/\[data-density="compact"\]\s*{[^}]*--avatar-size:\s*1\.75rem;/);
    expect(css).toMatch(/:root\s*{[^}]*--row-pad-y:\s*0\.375rem;/);
  });
  it('zeroes every duration but the meter, in the media query and under data-motion', () => {
    const zeroed = ['press', 'fast', 'normal', 'slow', 'enter', 'badge', 'toast', 'pulse', 'caret', 'flash'];
    const blocks = [
      css.match(/@media \(prefers-reduced-motion: reduce\)\s*{\s*:root\s*{([^}]*)}/)?.[1],
      css.match(/\[data-motion="reduced"\]\s*{([^}]*)}/)?.[1],
    ];
    for (const body of blocks) {
      expect(body).toBeDefined();
      for (const k of zeroed) expect(body).toContain(`--duration-${k}: 0ms;`);
      expect(body).not.toContain('meter');
    }
    expect(blocks[0]!.replace(/\s+/g, '')).toBe(blocks[1]!.replace(/\s+/g, ''));
  });
  it('emits the new durations, shadow and tracking', () => {
    expect(css).toContain('--duration-press: 120ms;');
    expect(css).toContain('--duration-enter: 380ms;');
    expect(css).toContain('--duration-badge: 450ms;');
    expect(css).toContain('--duration-meter: 120ms;');
    expect(css).toContain('--shadow-3: 0 30px 80px rgba(0,0,0,0.65);');
    expect(css).toContain('--label-tracking-wide: 0.12em;');
    expect(css).toContain('--accent: #5AA8E6;');
    expect(css).toContain('--ok-text: #9EF5AC;');
  });
  it('emits structural tokens', () => {
    expect(css).toContain('--r-md: 6px;');
    expect(css).toContain('--r-xl: 10px;');
    expect(css).toContain('--r-bot: 6px;');
    expect(css).toContain('--rail-w: 56px;');
    expect(css).toContain('--panel-h: 4rem;');
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
    expect(css).toContain('--topbar-h: 2.75rem;');
    expect(css).toContain('--bottombar-h: 1.625rem;');
    expect(css).toContain('--channel-header-h: 2.75rem;');
    expect(css).toContain('--bar-h: 2.75rem;');
    expect(css).toContain('--row-h: 1.75rem;');
    expect(css).toContain('--row-h-sub: 1.625rem;');
    expect(css).toContain('--row-h-2: 2.75rem;');
    expect(css).toContain('--list-gap: 0.0625rem;');
    expect(css).toContain('--rail-tile: 38px;');
    expect(css).toContain('--slot-w: 32px;');
    expect(css).toMatch(/\[data-density="cozy"\]\s*{[^}]*--avatar-size:\s*2\.25rem;/);
    expect(css).toContain('--sidebar-w: 244px;');
    expect(css).toContain('--thread-w: 340px;');
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

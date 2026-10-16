// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('./base.css', import.meta.url)), 'utf8');

// The no-zoom rules (Jonas, 2026-10-16; R10, R11): a field below 16px makes iOS zoom the page on focus.
const NO_ZOOM = `@media (max-width: 47.99rem) {
  .d-root :is(input:not([type="checkbox"], [type="radio"], [type="range"], [type="button"], [type="submit"], [type="reset"]), textarea, select, [contenteditable="true"]) { font-size: 1rem; }
}`;

describe('base.css phone rules', () => {
  it('holds the 16px field rule under the phone breakpoint, byte for byte', () => {
    expect(css).toContain(NO_ZOOM);
  });
  it('sets touch-action: manipulation on .d-root', () => {
    expect(css).toMatch(/\.d-root \{ touch-action: manipulation; \}/);
  });
  it('never disables user scaling and no longer caps the sidebar at 35dvh', () => {
    expect(css).not.toContain('user-scalable');
    expect(css).not.toContain('35dvh');
  });
});

// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('./Composer.css', import.meta.url)), 'utf8');

describe('the composer label and band (G1, G3)', () => {
  it('has no focus-dependent rule, so focusing changes no box height', () => {
    expect(css).not.toMatch(/:not\(:focus-within\)/);
    expect(css).not.toMatch(/\.d-composer:focus-within/);
  });
  it('pins its top edge to the user panel band', () => {
    expect(css).toMatch(/\.d-composer \{[^}]*min-height:\s*var\(--d-composer-band, 0px\)/);
    expect(css).toMatch(/\.d-composer \{[^}]*align-content:\s*end/);
  });
});

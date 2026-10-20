import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Composer.css'), 'utf8');

describe('the composer attach button on a phone', () => {
  it('is a 44 x 44 target under [data-layout="phone"], and 28 elsewhere', () => {
    expect(css).toMatch(/\.d-composer__attach \{[^}]*width: 1\.75rem; height: 1\.75rem/);
    expect(css).toMatch(/\[data-layout="phone"\] \.d-composer__attach \{[^}]*width: 2\.75rem; height: 2\.75rem/);
  });
});

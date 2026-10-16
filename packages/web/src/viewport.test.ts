import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');

describe('the viewport meta', () => {
  it('stops auto-zoom and keeps pinch-zoom', () => {
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />');
    expect(html).not.toContain('user-scalable');
    expect(html).not.toContain('maximum-scale');
  });
});

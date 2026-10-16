import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The served page's CSP is `img-src 'self' blob:` (internal/web/web.go): a data: image, in a stylesheet mask or a script,
// is refused and reported. This reads the built app (npm run build -w @dilla/web) and is skipped until there is one.
const ASSETS = resolve(__dirname, '..', 'dist', 'assets');

describe('the built app', () => {
  it.skipIf(!existsSync(ASSETS))('holds no data: image in any stylesheet or script', () => {
    const found: string[] = [];
    for (const name of readdirSync(ASSETS).filter(n => /\.(css|js)$/.test(n))) {
      const text = readFileSync(join(ASSETS, name), 'utf8');
      if (/data:image|url\(\s*["']?data:/.test(text)) found.push(name);
    }
    expect(found).toEqual([]);
  });
});

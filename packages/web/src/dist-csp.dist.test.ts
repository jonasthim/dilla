import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The served page's CSP is `img-src 'self' blob:` (internal/web/web.go): a data: image, in a stylesheet mask or a script,
// is refused and reported. This reads the built app (npm run build -w @dilla/web). Locally it is skipped until there is a
// build; under CI it fails when there is none, so a job that forgets to build before it cannot pass by skipping.
const ASSETS = resolve(__dirname, '..', 'dist', 'assets');
const built = existsSync(ASSETS);

describe('the built app', () => {
  it.runIf(!built && process.env.CI !== undefined && process.env.CI !== '')('is built when CI runs this guard', () => {
    expect(built, `${ASSETS} is missing: run npm run build -w @dilla/web first`).toBe(true);
  });

  it.skipIf(!built)('holds no data: image in any stylesheet or script, and every url() in its CSS is an emitted file', () => {
    const found: string[] = [];
    const missing: string[] = [];
    for (const name of readdirSync(ASSETS).filter(n => /\.(css|js)$/.test(n))) {
      const text = readFileSync(join(ASSETS, name), 'utf8');
      if (/data:image|url\(\s*["']?data:/.test(text)) found.push(name);
      if (!name.endsWith('.css')) continue;
      for (const m of text.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/g)) {
        const target = m[1];
        if (/^(https?:|data:|#)/.test(target)) continue;
        if (!existsSync(join(ASSETS, '..', target.replace(/^\//, '')))) missing.push(`${name}: ${target}`);
      }
    }
    expect(found).toEqual([]);
    expect(missing).toEqual([]);
  });
});

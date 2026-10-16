// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

// Geometric Shapes (U+25A0-U+25FF), the check marks U+2713 and U+2715, and the double vertical line U+2016 fall
// back to a system font in JetBrains Mono. Icons and StateDot draw them instead.
const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const SELF = path.join('packages', 'ui', 'src', 'test', 'glyphs.test.ts');
const ROOTS = ['ui', 'web'].map(p => path.join(REPO, 'packages', p, 'src'));

function walk(dir: string, out: string[]): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|css)$/.test(e.name)) out.push(p);
  }
  return out;
}

const isFallback = (cp: number) => (cp >= 0x25a0 && cp <= 0x25ff) || cp === 0x2713 || cp === 0x2715 || cp === 0x2016;

describe('font-fallback glyphs', () => {
  it('no source file under ui or web uses a glyph that falls back to a system font', () => {
    const hits: string[] = [];
    for (const file of ROOTS.flatMap(r => walk(r, []))) {
      const rel = path.relative(REPO, file);
      if (rel === SELF) continue;
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, li) => {
        let ch = 0;
        for (const c of line) {
          ch += 1;
          const cp = c.codePointAt(0) ?? 0;
          if (isFallback(cp)) hits.push(`${rel}:${li + 1}:${ch} U+${cp.toString(16).toUpperCase().padStart(4, '0')}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });
});

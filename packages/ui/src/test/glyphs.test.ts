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
// The literal glyph, an HTML entity (&#x25CF; or &#9679;) or a JS/CSS escape (●, \u{25CF}; CSS \25CF).
const ESCAPE = /&#x([0-9a-f]+);|&#(\d+);|\\u([0-9a-f]{4})|\\u\{([0-9a-f]+)\}|\\([0-9a-f]{4,6})(?![0-9a-f])/gi;

/** Every guarded code point in `text`, as `line:char U+XXXX`, whether written literally, as an entity or as an escape. */
function findFallbackGlyphs(text: string): string[] {
  const hits: string[] = [];
  const u = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
  text.split('\n').forEach((line, li) => {
    let ch = 0;
    for (const c of line) {
      ch += 1;
      const cp = c.codePointAt(0) ?? 0;
      if (isFallback(cp)) hits.push(`${li + 1}:${ch} ${u(cp)}`);
    }
    for (const m of line.matchAll(ESCAPE)) {
      const cp = m[1] ? parseInt(m[1], 16) : m[2] ? parseInt(m[2], 10) : parseInt(m[3] ?? m[4] ?? m[5], 16);
      if (isFallback(cp)) hits.push(`${li + 1}:${(m.index ?? 0) + 1} ${u(cp)}`);
    }
  });
  return hits;
}

describe('font-fallback glyphs', () => {
  it('no source file under ui or web uses a glyph that falls back to a system font', () => {
    const hits: string[] = [];
    for (const file of ROOTS.flatMap(r => walk(r, []))) {
      const rel = path.relative(REPO, file);
      if (rel === SELF) continue;
      for (const h of findFallbackGlyphs(fs.readFileSync(file, 'utf8'))) hits.push(`${rel}:${h}`);
    }
    expect(hits).toEqual([]);
  });

  it('catches a literal glyph, an HTML entity and a code escape alike', () => {
    expect(findFallbackGlyphs("const a = '●';")).toEqual(['1:12 U+25CF']);
    expect(findFallbackGlyphs('<b>&#x25CF;</b>')).toEqual(['1:4 U+25CF']);
    expect(findFallbackGlyphs('<b>&#9679;</b>')).toEqual(['1:4 U+25CF']);
    expect(findFallbackGlyphs("const a = '\\u25CF';")).toEqual(['1:12 U+25CF']);
    expect(findFallbackGlyphs("const a = '\\u{2715}';")).toEqual(['1:12 U+2715']);
    expect(findFallbackGlyphs('a::before { content: "\\25B8"; }')).toEqual(['1:23 U+25B8']);
  });

  it('leaves characters outside the guarded set alone', () => {
    expect(findFallbackGlyphs("const a = '›♪'; // &#x203A; \\u203A &#9834; \\266A")).toEqual([]);
  });
});

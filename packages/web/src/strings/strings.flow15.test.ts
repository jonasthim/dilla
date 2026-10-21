// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// @ts-expect-error the copy lint is a plain .mjs script without types
import { FORBIDDEN } from '../../../../scripts/check-ui-copy.mjs';
import { en } from './en.ts';

describe('flow 15 (the GIF picker, E8)', () => {
  const doc = readFileSync(fileURLToPath(new URL('../../../../docs/design/flows/15-gif-picker.md', import.meta.url)), 'utf8');
  const copy = doc.slice(doc.indexOf('## Copy'));
  const pairs = [...copy.matchAll(/`([a-zA-Z][\w.]*)='([^`]*)'`/g)].map(m => [m[1], m[2]] as const);
  it('strings: every flow-15 copy key equals en.ts byte for byte, and every gif key is in the flow', () => {
    const table = en as Readonly<Record<string, string>>;
    expect(pairs.length).toBe(13);
    for (const [key, value] of pairs) expect(table[key], key).toBe(value);
    for (const [key, value] of pairs) {
      for (const f of FORBIDDEN as { word: string; re: RegExp }[]) expect(f.re.test(value), `${key}: ${f.word}`).toBe(false);
    }
    const listed = new Set(pairs.map(([key]) => key));
    expect(Object.keys(en).filter(k => k.startsWith('gif.') && !listed.has(k))).toEqual([]);
  });
  it('the words are lower case except the attribution Giphy asks for', () => {
    const table = en as Readonly<Record<string, string>>;
    for (const [key, value] of pairs) {
      if (key === 'gif.powered') expect(value).toBe('Powered by GIPHY');
      else expect(value, key).toBe(value.toLowerCase());
    }
    expect(table['gif.powered']).toBe('Powered by GIPHY');
  });
  it('sections: States, Keyboard map, Focus rules and Announcements have content', () => {
    const body = (title: string) => {
      const start = doc.indexOf(`## ${title}\n`);
      expect(start, title).toBeGreaterThanOrEqual(0);
      const rest = doc.slice(start + title.length + 4);
      const next = rest.indexOf('\n## ');
      return (next < 0 ? rest : rest.slice(0, next)).trim();
    };
    for (const title of ['States', 'Keyboard map', 'Focus rules', 'Announcements']) expect(body(title).length, title).toBeGreaterThan(0);
    expect(body('Keyboard map')).toContain('`aria-expanded`');
    expect(body('Focus rules')).toContain('Escape');
    expect(body('States')).toContain('no Giphy key');
  });
});

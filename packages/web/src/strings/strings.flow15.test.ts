// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// @ts-expect-error the copy lint is a plain .mjs script without types
import { FORBIDDEN } from '../../../../scripts/check-ui-copy.mjs';
import { en } from './en.ts';

describe('flow 15 (EOD E6, profile)', () => {
  const doc = readFileSync(fileURLToPath(new URL('../../../../docs/design/flows/15-profile.md', import.meta.url)), 'utf8');
  const copy = doc.slice(doc.indexOf('## Copy'));
  const pairs = [...copy.matchAll(/`([a-zA-Z][\w.]*)='([^`]*)'`/g)].map(m => [m[1], m[2]] as const);
  it('strings: every flow-15 copy key equals en.ts byte for byte, and every new key is in the flow', () => {
    const table = en as Readonly<Record<string, string>>;
    expect(pairs.length).toBe(13);
    for (const [key, value] of pairs) expect(table[key], key).toBe(value);
    for (const [key, value] of pairs) {
      for (const f of FORBIDDEN as { word: string; re: RegExp }[]) expect(f.re.test(value), `${key}: ${f.word}`).toBe(false);
    }
    const listed = new Set(pairs.map(([key]) => key));
    const added = Object.keys(en).filter(k => /^(profile\.|settings\.nav\.profile$)/.test(k));
    expect(added.filter(k => !listed.has(k))).toEqual([]);
  });
  it('chrome is lower case and surfaces are sentence case (Mesh style); no exclamation, no reassurance', () => {
    for (const k of ['settings.nav.profile', 'profile.display.label', 'profile.status.label', 'profile.bio.label', 'profile.save', 'profile.card.about'] as const) {
      expect(en[k], k).toMatch(/^[a-z]/);
    }
    for (const k of ['profile.title', 'profile.body', 'profile.status.hint', 'profile.bio.hint', 'profile.saved', 'profile.error.display', 'profile.error.save'] as const) {
      expect(en[k], k).toMatch(/^[A-Z]/);
    }
    for (const [, value] of pairs) expect(value).not.toMatch(/!|\bsecure\b|\bsafe\b|\bprotected\b/i);
  });
  it('the limits in the hints are the server limits', () => {
    expect(en['profile.status.hint']).toContain('190');
    expect(en['profile.bio.hint']).toContain('500');
  });
  it('sections: States, Keyboard map, Focus rules and Announcements have content', () => {
    for (const title of ['States', 'Keyboard map', 'Focus rules', 'Announcements']) {
      const start = doc.indexOf(`## ${title}\n`);
      expect(start, title).toBeGreaterThanOrEqual(0);
      const rest = doc.slice(start + title.length + 4);
      const next = rest.indexOf('\n## ');
      expect((next < 0 ? rest : rest.slice(0, next)).trim().length, title).toBeGreaterThan(0);
    }
  });
});

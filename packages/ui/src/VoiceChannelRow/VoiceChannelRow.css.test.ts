// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const row = readFileSync(fileURLToPath(new URL('./VoiceChannelRow.css', import.meta.url)), 'utf8');
const tile = readFileSync(fileURLToPath(new URL('../CallTile/CallTile.css', import.meta.url)), 'utf8');

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
  const m = new RegExp(`(?:^|\\n)${selector.replace(/[.[\]]/g, '\\$&')} \\{([^}]*)\\}`).exec(css);
  if (m === null) throw new Error(`no rule for ${selector}`);
  return m[1];
}

// web3.8 (U3, R29): the name and its glyphs share one non-wrapping, centred line.
describe('inline state glyph rows (CSS pin)', () => {
  it.each([
    ['.d-voice-row__person', row],
    ['.d-call-tile__caption', tile],
  ])('%s is display: flex; align-items: center; flex-wrap: nowrap; gap: 0.375rem', (selector, css) => {
    const d = rule(css, selector);
    expect(d).toMatch(/display: flex;/);
    expect(d).toMatch(/align-items: center;/);
    expect(d).toMatch(/flex-wrap: nowrap;/);
    expect(d).toMatch(/gap: 0\.375rem;/);
  });
  it.each([
    ['.d-voice-row__person-name', row],
    ['.d-call-tile__name', tile],
  ])('%s truncates: ellipsis, min-width: 0, flex: 0 1 auto', (selector, css) => {
    const d = rule(css, selector);
    expect(d).toMatch(/min-width: 0;/);
    expect(d).toMatch(/flex: 0 1 auto;/);
    expect(d).toMatch(/text-overflow: ellipsis;/);
  });
  it.each([
    ['.d-voice-row__state', row],
    ['.d-call-tile__state', tile],
  ])('%s does not shrink', (selector, css) => {
    expect(rule(css, selector)).toMatch(/flex: none;/);
  });
});

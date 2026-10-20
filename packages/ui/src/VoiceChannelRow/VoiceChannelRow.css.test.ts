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
    ['.d-voice-row__person', row, '0.5rem'],
    ['.d-call-tile__caption', tile, '0.375rem'],
  ])('%s is display: flex; align-items: center; flex-wrap: nowrap; with its gap', (selector, css, gap) => {
    const d = rule(css, selector);
    expect(d).toMatch(/display: flex;/);
    expect(d).toMatch(/align-items: center;/);
    expect(d).toMatch(/flex-wrap: nowrap;/);
    expect(d).toContain(`gap: ${gap};`);
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

// web3.9 (UI-2, R10-R13, R25): one row grammar with ChannelRow.
describe('the voice row grammar (CSS pin)', () => {
  it('.d-voice-row is --row-h tall with --list-gap above and below', () => {
    const d = rule(row, '.d-voice-row');
    expect(d).toMatch(/height: var\(--row-h\);/);
    expect(d).toMatch(/margin: var\(--list-gap\) 0;/);
  });
  it('the glyph column is 16px and does not shrink', () => {
    const d = rule(row, '.d-voice-row__glyph');
    expect(d).toMatch(/flex: none;/);
    expect(d).toMatch(/width: 1rem/);
  });
  it('a person row is --row-h-sub tall and indented to the name x (2rem: 8 + 16 + 8)', () => {
    const d = rule(row, '.d-voice-row__person');
    expect(d).toMatch(/height: var\(--row-h-sub\);/);
    expect(d).toMatch(/padding: 0 0\.5rem 0 2rem;/);
  });
  it('the speaking ring is a 2px accent box-shadow on the square avatar', () => {
    expect(row).toMatch(/\[data-speaking="true"\] \.d-avatar \{ box-shadow: 0 0 0 2px var\(--accent\); \}/);
  });
  it('the join icon sits over the row slot at the same right edge and shows on hover or focus', () => {
    const d = rule(row, '.d-voice-row__join');
    expect(d).toMatch(/right: 0\.5rem;/);
    expect(d).toMatch(/opacity: 0;/);
    expect(row).toMatch(/\.d-voice-item:focus-within \.d-voice-row__join \{ opacity: 1; \}/);
  });
  it('the count never shrinks and the name cuts first', () => {
    expect(rule(row, '.d-voice-row__count')).toMatch(/flex: none;/);
    expect(rule(row, '.d-voice-row__name')).toMatch(/text-overflow: ellipsis;/);
  });
});

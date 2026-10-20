// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('./CommunityRail.css', import.meta.url)), 'utf8');
const rule = (selector: string) => new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';

// web3.9 (UI-2, R20, R22, B3, B4): the 72px rail.
describe('the rail (CSS pin)', () => {
  it('draws its edge as an inset hairline, not a border (B3)', () => {
    const d = rule('.d-community-rail');
    expect(d).toMatch(/box-shadow: inset -1px 0 var\(--hairline\);/);
    expect(d).not.toMatch(/border/);
  });
  it('a tile is var(--rail-tile) square; the list puts tiles at integer positions (12px sides, 8px gaps)', () => {
    const d = rule('.d-community-rail__item');
    expect(d).toMatch(/width: var\(--rail-tile\);/);
    expect(d).toMatch(/height: var\(--rail-tile\);/);
    const l = rule('.d-community-rail__list');
    expect(l).toMatch(/padding: 12px 0;/);
    expect(l).toMatch(/gap: 8px;/);
  });
  it('the pill is 8px for unread, 20 on hover, 40 for the selected tile, at the left edge', () => {
    expect(rule('.d-community-rail__pill')).toMatch(/left: -12px;/);
    expect(rule('.d-community-rail__pill[data-pill="unread"]')).toMatch(/height: 8px;/);
    expect(rule('.d-community-rail__pill[data-pill="selected"]')).toMatch(/height: 40px;/);
    expect(css).toMatch(/\.d-community-rail__item:hover \.d-community-rail__pill\[data-pill="hover"\][^{]*\{ height: 20px; \}/);
  });
  it('the old 3px selected bar and the captions are gone', () => {
    expect(css).not.toContain('width: 3px');
    expect(css).not.toContain('__caption');
  });
  it('the add tile is a dashed square of the tile size', () => {
    const d = rule('.d-community-rail__glyph');
    expect(d).toMatch(/width: var\(--rail-tile\);/);
    expect(d).toMatch(/border: 1px dashed/);
  });
});

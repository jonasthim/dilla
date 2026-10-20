// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const list = read('./ChannelList.css');
const chrow = read('../ChannelRow/ChannelRow.css');
const slot = read('../TrailingSlot/TrailingSlot.css');
const rule = (css: string, selector: string) => new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';

// web3.9 (UI-2, R10-R14): one row grammar for channel rows, voice rows and category headers.
describe('the row grammar (CSS pin)', () => {
  it('a channel row is var(--row-h) tall with var(--list-gap) above and below', () => {
    const d = rule(chrow, '.d-chrow');
    expect(d).toMatch(/height: var\(--row-h\);/);
    expect(d).toMatch(/margin: var\(--list-gap\) 0;/);
  });
  it('the glyph column is 16px and does not shrink', () => {
    const d = rule(chrow, '.d-chrow__glyph');
    expect(d).toMatch(/flex: none;/);
    expect(d).toMatch(/width: 1rem/);
  });
  it('the name truncates with an ellipsis', () => {
    const d = rule(chrow, '.d-chrow__name');
    expect(d).toMatch(/min-width: 0;/);
    expect(d).toMatch(/text-overflow: ellipsis;/);
  });
  it('the trailing slot is a fixed column that never shrinks', () => {
    const d = rule(slot, '.d-slot');
    expect(d).toMatch(/width: var\(--slot-w\);/);
    expect(d).toMatch(/flex: none;/);
  });
  it('selected is the fill and a 2px inset accent bar; unread is a 4px inset tick, with no bold', () => {
    expect(chrow).toMatch(/\.d-chrow\[aria-current="page"\] \{[^}]*background: var\(--surface-hi\);[^}]*box-shadow: inset 2px 0 0 var\(--accent\);/);
    expect(chrow).toMatch(/\.d-chrow:not\(\[data-unread="0"\]\)[^{]*\{[^}]*box-shadow: inset 4px 0 0 /);
    expect(chrow).not.toMatch(/font-weight: 700/);
  });
  it('the lock is an icon box, not text', () => {
    expect(rule(chrow, '.d-chrow__lock')).not.toMatch(/font-size|filter/);
  });
});

describe('the category header (CSS pin)', () => {
  it('is var(--row-h) tall on the same padding and gap as a row, so its label starts at the name x', () => {
    const d = rule(list, '.d-channel-list__cat-head');
    expect(d).toMatch(/height: var\(--row-h\);/);
    expect(d).toMatch(/padding: 0 0\.5rem;/);
    expect(d).toMatch(/gap: 0\.5rem;/);
    expect(d).toMatch(/margin: var\(--list-gap\) 0;/);
  });
  it('the chevron is in the 16px glyph column and turns -90deg when collapsed', () => {
    const d = rule(list, '.d-channel-list__cat-chevron');
    expect(d).toMatch(/flex: none;/);
    expect(d).toMatch(/width: 1rem/);
    expect(list).toMatch(/\[data-collapsed="true"\] \.d-channel-list__cat-chevron \{ transform: rotate\(-90deg\); \}/);
  });
  it('the label is micro, uppercase and tracked', () => {
    const d = rule(list, '.d-channel-list__cat-label');
    expect(d).toMatch(/font-size: var\(--text-micro\);/);
    expect(d).toMatch(/letter-spacing: var\(--label-tracking\);/);
    expect(d).toMatch(/text-transform: uppercase;/);
  });
  it('the "+" shares the slot right edge, shows on hover or focus, and always on a device without hover or on a phone', () => {
    expect(rule(list, '.d-channel-list__cat-add')).toMatch(/right: 0\.5rem;/);
    expect(list).toMatch(/\.d-channel-list__cat:focus-within \.d-channel-list__cat-add \{ opacity: 1; \}/);
    expect(list).toMatch(/@media \(hover: none\) \{ \.d-channel-list__cat-add \{ opacity: 1; \} \}/);
    expect(list).toMatch(/\[data-layout="phone"\] \.d-channel-list__cat-add \{ opacity: 1; \}/);
  });
});

describe('the header row (CSS pin)', () => {
  it('is var(--bar-h) tall, with and without a header action', () => {
    expect(rule(list, '.d-channel-list__title')).toMatch(/height: var\(--bar-h\);/);
    expect(rule(list, '.d-channel-list__head')).toMatch(/height: var\(--bar-h\);/);
  });
  it('the retired list-header "+" row and text join have no rules', () => {
    expect(list).not.toContain('.d-channel-list__list-head');
    expect(list).not.toContain('.d-channel-list__join');
  });
});

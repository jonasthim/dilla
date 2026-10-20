// @vitest-environment node
// web3.8 FX (final review, the cramped phone stage): jsdom cannot lay out, so the phone rules are pinned as text; the docs
// shoot (voice-stage-phone.png) shows them in a real browser.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const stage = readFileSync(fileURLToPath(new URL('./CallStage.css', import.meta.url)), 'utf8');
const tile = readFileSync(fileURLToPath(new URL('../CallTile/CallTile.css', import.meta.url)), 'utf8');
const PHONE = '@media (max-width: 47.99rem), (pointer: coarse) and (max-height: 31.99rem) {';

/** The bodies of every phone @media block of `css`, joined. */
function phone(css: string): string {
  const out: string[] = [];
  let at = css.indexOf(PHONE);
  while (at >= 0) {
    let depth = 0;
    let end = at + PHONE.length - 1;
    for (; end < css.length; end += 1) {
      if (css[end] === '{') depth += 1;
      else if (css[end] === '}' && (depth -= 1) === 0) break;
    }
    out.push(css.slice(at + PHONE.length, end));
    at = css.indexOf(PHONE, end);
  }
  return out.join('\n');
}

/** The declarations of the last rule in `css` whose selector list contains `selector`. */
function rule(css: string, selector: string): string {
  const all = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(m => m[1].split(',').map(s => s.trim()).includes(selector));
  if (all.length === 0) throw new Error(`no rule for ${selector}`);
  return all[all.length - 1][2];
}

describe('the phone stage (CSS pin)', () => {
  it('up to two tiles: one column across the width; three or more: two columns', () => {
    expect(rule(phone(stage), '.d-call-stage__tiles[data-tiles="stage"]')).toMatch(/grid-template-columns: minmax\(0, 1fr\)/);
    expect(rule(phone(stage), '.d-call-stage .d-call-stage__tiles[data-tiles="stage"][data-many]')).toMatch(/grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
    expect(rule(phone(stage), '.d-call-stage[data-focused-stage] .d-call-stage__tiles[data-tiles="stage"][data-many]')).toMatch(/repeat\(2, minmax\(0, 1fr\)\)/);
  });

  it('an odd last tile spans both columns instead of sitting alone at half width', () => {
    expect(rule(phone(stage), '.d-call-stage .d-call-stage__tiles[data-many] .d-call-stage__tile[data-stage]:last-child:nth-child(odd)')).toMatch(/grid-column: 1 \/ -1/);
    // With a focused tile first (it spans both), the rest start at 2: an even last child is the odd one out.
    expect(rule(phone(stage), '.d-call-stage[data-focused-stage] .d-call-stage__tiles[data-many] .d-call-stage__tile[data-stage]:last-child:nth-child(even)')).toMatch(/grid-column: 1 \/ -1/);
  });

  it('a phone tile is as tall as its content, not a 16:9 box', () => {
    expect(rule(phone(stage), '.d-call-stage__tile[data-stage]')).toMatch(/aspect-ratio: auto/);
    expect(rule(phone(tile), '.d-call-tile[data-stage] .d-call-tile__avatar')).toMatch(/position: relative;[^}]*aspect-ratio: 16 \/ 9/);
  });

  it('the volume is in flow under the caption, never over the face', () => {
    expect(rule(phone(tile), '.d-call-tile[data-stage]')).toMatch(/flex-direction: column/);
    expect(rule(phone(tile), '.d-call-tile[data-stage] .d-call-tile__caption')).toMatch(/position: static/);
    expect(rule(phone(tile), '.d-call-tile[data-stage] .d-call-tile__volume')).toMatch(/position: static/);
  });
});

describe('D1, D4 and C4 (CSS pins)', () => {
  it('a partial last row is centred by shifting its tiles half the empty columns, and only in the grid', () => {
    expect(stage).toMatch(/translate: calc\(\(var\(--d-stage-cols, 1\) - var\(--d-orphan-n, 0\)\) \* \(var\(--d-tile-w, 0px\) \+ 0\.75rem\) \/ 2\) 0;/);
    // The phone's own columns and the filmstrip are not the measured grid: no shift there.
    expect(rule(phone(stage), '.d-call-stage__tile[data-orphan]')).toMatch(/translate: none/);
    expect(rule(stage, '[data-layout="phone"] .d-call-stage__tile[data-orphan]')).toMatch(/translate: none/);
  });

  it('the stage header slot is the 48 bar with the hairline at its foot', () => {
    expect(rule(stage, '.d-call-stage__bar')).toMatch(/height: var\(--bar-h\)/);
    expect(rule(stage, '.d-call-stage__bar')).toMatch(/border-bottom: 1px solid var\(--hairline\)/);
  });

  it('on a phone layout the stage has an 18px gutter, centred avatars and a pinned toolbar', () => {
    expect(rule(stage, '[data-layout="phone"] .d-call-stage')).toMatch(/padding-inline: 1\.125rem/);
    expect(rule(stage, '[data-layout="phone"] .d-call-stage__controls')).toMatch(/position: sticky;[^}]*bottom: 0/);
    expect(rule(tile, '[data-layout="phone"] .d-call-tile__avatar')).toMatch(/place-items: center/);
  });
});

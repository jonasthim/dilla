// @vitest-environment node
// The grouped row's gutter time (flow 04): jsdom cannot lay out, so the rule is pinned as text; the Grouped story shows it in a
// real browser. "10:06 PM" at 10px is about 51 px, wider than the avatar column and its gap at the compact density (40 px), so the
// gutter must also take the row's left padding, and it keeps the body's line box so the time sits on the first line of content.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('./MessageRow.css', import.meta.url)), 'utf8');
const rule = (selector: string): string => {
  const at = css.split('\n').find(line => line.startsWith(`${selector} {`));
  if (at === undefined) throw new Error(`no rule ${selector}`);
  return at;
};

describe('the grouped row gutter', () => {
  const gutter = rule('.d-message-row__gutter');
  it('reaches from the row edge to the content column, so a full 12-hour time fits at every density', () => {
    expect(gutter).toContain('width: calc(var(--row-pad-x) + var(--avatar-size) + 0.75rem)');
    expect(gutter).toContain('margin-left: calc(-1 * var(--row-pad-x))');
    expect(gutter).toContain('margin-right: -0.75rem');
  });
  it('is never clipped and never wraps', () => {
    expect(gutter).toContain('white-space: nowrap');
    expect(gutter).not.toMatch(/overflow\s*:/);
  });
  it('shares the body’s line box so the time is on the first line of content', () => {
    expect(gutter).toContain('line-height: calc(var(--text-base) * var(--line-height))');
    expect(gutter).toContain('padding: 0.125rem 0.375rem 0 0');
  });
});

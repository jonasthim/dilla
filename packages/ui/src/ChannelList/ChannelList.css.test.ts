// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('./ChannelList.css', import.meta.url)), 'utf8');
const rule = (selector: string) => new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';

describe('a voice row with its join (WS5 fix round 1, F1)', () => {
  it('keeps one column: the hidden join reserves no width, so the row and its highlight span the whole item', () => {
    expect(rule('.d-channel-list__voice')).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)\s*;/);
    expect(rule('.d-channel-list__voice')).not.toMatch(/grid-template-columns:[^;]*auto/);
  });
  it('puts the join in the row’s cell, at its end', () => {
    const join = rule('.d-channel-list__join');
    expect(join).toMatch(/grid-column:\s*1\s*;/);
    expect(join).toMatch(/grid-row:\s*1\s*;/);
    expect(join).toMatch(/justify-self:\s*end/);
  });
});

describe('the join and the member count never overlap (WS5 fix round 2, G1)', () => {
  it('on a pointer device the shown join replaces the count', () => {
    expect(css).toMatch(/@media \(hover: hover\) \{[^}]*\.d-channel-list__voice:hover > \.d-voice-row \.d-voice-row__count[^}]*\.d-channel-list__voice:focus-within > \.d-voice-row \.d-voice-row__count[^}]*visibility:\s*hidden/);
  });
  it('on a phone the join is always shown and the row reserves its width, in the media query and the layout twin', () => {
    expect(css).toMatch(/@media \(hover: none\) \{[\s\S]*?\.d-channel-list__voice:has\(> \.d-channel-list__join\) > \.d-voice-row \{ padding-right: [^;}]+; \}/);
    expect(css).toMatch(/\[data-layout="phone"\] \.d-channel-list__voice:has\(> \.d-channel-list__join\) > \.d-voice-row \{ padding-right: [^;}]+; \}/);
    expect(css).toMatch(/\[data-layout="phone"\] \.d-channel-list__join \{ opacity: 1; \}/);
  });
});

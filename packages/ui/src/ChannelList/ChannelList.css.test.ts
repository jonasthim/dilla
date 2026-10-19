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

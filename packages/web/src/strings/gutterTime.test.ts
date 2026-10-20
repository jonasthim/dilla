// The grouped row's gutter time (I2): compact, so it fits the avatar column and its gap at every width.
import { describe, expect, it } from 'vitest';
import { formatGutterTime } from './index.ts';

const at = (h: number, m: number) => new Date(2026, 9, 20, h, m).getTime() / 1000;

describe('formatGutterTime', () => {
  it('cuts the day period to a letter against the digits: the longest en-US value is six characters', () => {
    expect(formatGutterTime(at(12, 59), 'en-US')).toBe('12:59p');
    expect(formatGutterTime(at(0, 5), 'en-US')).toBe('12:05a');
    expect(formatGutterTime(at(9, 30), 'en-US')).toBe('9:30a');
  });
  it('leaves a 24-hour locale alone: en-GB 23:59', () => {
    expect(formatGutterTime(at(23, 59), 'en-GB')).toBe('23:59');
  });
  it('never exceeds six characters in the locales the app is likely to meet', () => {
    for (const locale of ['en-US', 'en-GB', 'sv-SE', 'de-DE', 'fr-FR', 'ja-JP']) {
      for (const h of [0, 9, 12, 13, 23]) expect([...formatGutterTime(at(h, 59), locale)].length, `${locale} ${h}`).toBeLessThanOrEqual(6);
    }
  });
});

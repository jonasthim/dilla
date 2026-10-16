// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { formatWait } from './slow.ts';

describe('formatWait (R7)', () => {
  it.each([
    [0, '0:00'], [999, '0:01'], [5000, '0:05'], [65_000, '1:05'], [3_599_000, '59:59'], [3_600_000, '1:00:00'], [21_600_000, '6:00:00'],
  ])('%i ms is %s', (ms, text) => { expect(formatWait(ms)).toBe(text); });
  it('never shows a negative wait', () => { expect(formatWait(-500)).toBe('0:00'); });
});

import { describe, expect, it } from 'vitest';
import { normaliseRecoveryKey } from './recovery-key';
import { FAKE_RECOVERY_KEY } from './testing/fake-core';

describe('normaliseRecoveryKey (L-CORE-28)', () => {
  // The shared vectors: core/dilla-core/src/identity/recovery.rs asserts the same five pairs.
  it.each([
    ['abcd-efgh', 'ABCDEFGH'],
    ['AB CD\nEF', 'ABCDEF'],
    ['il1o0', '11100'],
    ['A–B—C', 'ABC'],
    ['ABCU', 'ABCU'],
  ])('%j becomes %j (shared vector)', (input, want) => {
    expect(normaliseRecoveryKey(input)).toBe(want);
  });

  it.each([
    ['\tab\r\n', 'AB'],
    ['', ''],
    ['ß é', 'ßé'],
    ['a_b', 'A_B'],
    ['A−B', 'A−B'],
    ['IlLoO', '11100'],
  ])('%j becomes %j', (input, want) => {
    expect(normaliseRecoveryKey(input)).toBe(want);
  });

  it('is the identity on a key as the signup shows it, and removes its grouping', () => {
    expect(normaliseRecoveryKey(FAKE_RECOVERY_KEY)).toBe(FAKE_RECOVERY_KEY);
    const groups = Array.from({ length: 13 }, (_, i) => FAKE_RECOVERY_KEY.slice(i * 4, i * 4 + 4));
    expect(normaliseRecoveryKey(groups.join(' '))).toBe(FAKE_RECOVERY_KEY);
    expect(normaliseRecoveryKey(groups.join('-').toLowerCase())).toBe(FAKE_RECOVERY_KEY);
    expect(normaliseRecoveryKey(groups.join('—'))).toHaveLength(52);
  });
});

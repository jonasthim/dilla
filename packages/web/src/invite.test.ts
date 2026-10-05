import { describe, it, expect } from 'vitest';
import { extractInviteCode } from './invite.ts';

describe('extractInviteCode', () => {
  it.each([
    ['ABCD-EFGH', 'ABCD-EFGH'],
    ['  abcd-efgh \n', 'abcd-efgh'],
    ['https://dilla.test/i/ABCD-EFGH', 'ABCD-EFGH'],
    ['https://dilla.test/i/ABCD-EFGH?ref=chat#x', 'ABCD-EFGH'],
    ['dilla.test/i/AB%2DCD', 'AB-CD'],
    ['https://dilla.test/welcome?invite=WXYZ-1234', 'WXYZ-1234'],
    ['https://dilla.test/welcome?x=1&invite=a%20b', 'a b'],
    ['https://dilla.test/i/%E0%A4%A', '%E0%A4%A'],
    ['', ''],
    ['   ', ''],
  ])('%j → %j', (input, want) => {
    expect(extractInviteCode(input)).toBe(want);
  });
});

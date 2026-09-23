import { it, expect } from 'vitest';
import { hmacSha256 } from './hmac.ts';
import { hex, utf8 } from './bytes.ts';

it('matches RFC 4231 test case 2', async () => {
  const mac = await hmacSha256(utf8('Jefe'), utf8('what do ya want for nothing?'));
  expect(hex(mac)).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
});

import { describe, expect, it } from 'vitest';
import { decodeBotRequest, encodeBotRequest, validateBotContext, BotError } from './protocol.ts';
import { decode } from '../cbor/index.ts';

const id = (n: number) => new Uint8Array(16).fill(n);
const request = (operation = 0, args: (bigint | Uint8Array | string | null)[] = []) => ({
  requestId: id(1), communityId: id(2), channelId: null, operation, revision: null, expires: null, args,
});

describe('bot application codecs', () => {
  it('roundtrips a request and checks authenticated community context', () => {
    const body = encodeBotRequest(request());
    const decoded = decodeBotRequest(body);
    expect(decoded.operation).toBe(0);
    expect(validateBotContext(decoded, { community: id(2), now: 100n })).toBeUndefined();
    expect(() => validateBotContext(decoded, { community: id(3), now: 100n })).toThrow(BotError);
  });

  it('preserves uint64 values exactly and rejects wrong operation arguments', () => {
    const max = (1n << 64n) - 1n;
    const seek = { ...request(17, [max]), channelId: id(3), revision: max, expires: 110n };
    const decoded = decodeBotRequest(encodeBotRequest(seek));
    expect(decoded.args[0]).toBe(max);
    expect(() => encodeBotRequest({ ...request(13, [1n]), channelId: id(3), revision: 1n, expires: 110n })).toThrow(BotError);
  });

  it('rejects noncanonical base64url even when it decodes to valid CBOR', () => {
    const good = encodeBotRequest(request());
    expect(() => decodeBotRequest(`${good}=`)).toThrow(BotError);
    expect(decode).toBeTypeOf('function');
  });
});

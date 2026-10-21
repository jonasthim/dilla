import { describe, expect, it } from 'vitest';
import * as bot from './protocol.ts';
import { decode } from '../cbor/index.ts';

const id = (n: number) => new Uint8Array(16).fill(n);
const request = (operation = 0, args: (bigint | Uint8Array | string | null)[] = []) => ({
  requestId: id(1), communityId: id(2), channelId: null, operation, revision: null, expires: null, args,
});

describe('bot application codecs', () => {
  it('roundtrips a request and checks authenticated community context', () => {
    const body = bot.encodeBotRequest(request());
    const decoded = bot.decodeBotRequest(body);
    expect(decoded.operation).toBe(0);
    expect(bot.validateBotContext(decoded, { community: id(2), now: 100n })).toBeUndefined();
    expect(() => bot.validateBotContext(decoded, { community: id(3), now: 100n })).toThrow(bot.BotError);
  });

  it('preserves uint64 values exactly and rejects wrong operation arguments', () => {
    const max = (1n << 64n) - 1n;
    const seek = { ...request(17, [max]), channelId: id(3), revision: max, expires: 110n };
    const decoded = bot.decodeBotRequest(bot.encodeBotRequest(seek));
    expect(decoded.args[0]).toBe(max);
    expect(() => bot.encodeBotRequest({ ...request(13, [1n]), channelId: id(3), revision: 1n, expires: 110n })).toThrow(bot.BotError);
  });

  it('rejects noncanonical base64url even when it decodes to valid CBOR', () => {
    const good = bot.encodeBotRequest(request());
    expect(() => bot.decodeBotRequest(`${good}=`)).toThrow(bot.BotError);
    expect(decode).toBeTypeOf('function');
  });

  it('binds removal proofs to an expected actor when one is supplied', () => {
    const proof = {
      requestId: id(1), actorUser: id(2), actorDevice: id(3), communityId: id(4), groupId: id(5),
      targetSeq: 1n, expires: 120n,
    };
    expect(() => bot.validateRemovalContext(proof, {
      community: id(4), group: id(5), actorUser: id(9), actorDevice: id(3), now: 100n,
    })).toThrow(bot.BotError);
    expect(() => bot.validateRemovalContext(proof, {
      community: id(4), group: id(5), actorUser: id(2), actorDevice: id(9), now: 100n,
    })).toThrow(bot.BotError);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fromHex, toHex } from '../hex.ts';
import * as bot from './protocol.ts';

type VectorKind = 'request' | 'response' | 'removal' | 'event' | 'receipt' | 'helper_request' | 'helper_response';
type Context = { community: string; group?: string; actor_user?: string; actor_device?: string; now: string };
type Vector = { name: string; kind: VectorKind; hex?: string; body?: string; preimage_hex?: string; context?: Context };
type Vectors = { cases: Vector[]; rejects: Vector[] };
type Decoded =
  | { kind: 'request'; value: bot.BotRequest }
  | { kind: 'response'; value: bot.BotResponse }
  | { kind: 'removal'; value: bot.RemovalProof }
  | { kind: 'event'; value: bot.DurableEvent }
  | { kind: 'receipt'; value: bot.SendReceipt }
  | { kind: 'helper_request'; value: bot.HelperEnvelope }
  | { kind: 'helper_response'; value: bot.HelperResponse };

const vectors = JSON.parse(readFileSync(new URL('../../../../protocol/vectors/bot.json', import.meta.url), 'utf8')) as Vectors;

function context(c: Context): bot.BotContext {
  return {
    community: fromHex(c.community),
    ...(c.group === undefined ? {} : { group: fromHex(c.group) }),
    ...(c.actor_user === undefined ? {} : { actorUser: fromHex(c.actor_user) }),
    ...(c.actor_device === undefined ? {} : { actorDevice: fromHex(c.actor_device) }),
    now: BigInt(c.now),
  };
}

function bodyPayload(body: string): Uint8Array {
  expect(body.startsWith('dilla.bot/1:')).toBe(true);
  const encoded = body.slice('dilla.bot/1:'.length);
  expect(/^[A-Za-z0-9_-]+$/u.test(encoded)).toBe(true);
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - encoded.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bodyFromHex(hex: string): string {
  const binary = String.fromCharCode(...fromHex(hex));
  const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
  return `dilla.bot/1:${encoded}`;
}

function decodeVector(kind: VectorKind, hex: string, body?: string): Decoded {
  switch (kind) {
    case 'request': return { kind, value: bot.decodeBotRequest(body ?? bodyFromHex(hex)) };
    case 'response': return { kind, value: bot.decodeBotResponse(body ?? bodyFromHex(hex)) };
    case 'removal': return { kind, value: bot.decodeRemovalProof(fromHex(hex)) };
    case 'event': return { kind, value: bot.decodeDurableEvent(fromHex(hex)) };
    case 'receipt': return { kind, value: bot.decodeSendReceipt(fromHex(hex)) };
    case 'helper_request': return { kind, value: bot.decodeHelperRequest(fromHex(hex)) };
    case 'helper_response': return { kind, value: bot.decodeHelperResponse(fromHex(hex)) };
  }
}

function encodeVector(decoded: Decoded): Uint8Array | string {
  switch (decoded.kind) {
    case 'request': return bot.encodeBotRequest(decoded.value);
    case 'response': return bot.encodeBotResponse(decoded.value);
    case 'removal': return bot.encodeRemovalProof(decoded.value);
    case 'event': return bot.encodeDurableEvent(decoded.value);
    case 'receipt': return bot.encodeSendReceipt(decoded.value);
    case 'helper_request': return bot.encodeHelperRequest(decoded.value);
    case 'helper_response': return bot.encodeHelperResponse(decoded.value);
  }
}

function checkContext(decoded: Decoded, c: Context): void {
  const ctx = context(c);
  switch (decoded.kind) {
    case 'request': bot.validateBotContext(decoded.value, ctx); break;
    case 'response': bot.validateBotResponseContext(decoded.value, ctx.community); break;
    case 'removal': bot.validateRemovalContext(decoded.value, ctx); break;
    case 'event': bot.validateEventContext(decoded.value, ctx.community); break;
    case 'receipt':
      if (ctx.group === undefined) throw new Error('receipt vector is missing its group context');
      bot.validateReceiptContext(decoded.value, ctx.community, ctx.group);
      break;
    case 'helper_request':
    case 'helper_response': break;
  }
}

describe('shared bot protocol vectors', () => {
  it('roundtrips every valid canonical encoding and checks contexts', () => {
    expect(vectors.cases.length).toBeGreaterThanOrEqual(37);
    const kinds = new Set(vectors.cases.map((vector) => vector.kind));
    expect([...kinds].sort()).toEqual(['event', 'helper_request', 'helper_response', 'receipt', 'removal', 'request', 'response']);

    for (const vector of vectors.cases) {
      const hex = vector.hex;
      if (hex === undefined) throw new Error(`valid vector ${vector.name} is missing hex`);
      const decoded = decodeVector(vector.kind, hex);
      const encoded = encodeVector(decoded);
      expect(typeof encoded === 'string' ? toHex(bodyPayload(encoded)) : toHex(encoded), vector.name).toBe(hex);

      if (vector.body !== undefined && typeof encoded === 'string') {
        expect(toHex(bodyPayload(vector.body)), vector.name).toBe(hex);
        const fromBody = decodeVector(vector.kind, '', vector.body);
        expect(encodeVector(fromBody), vector.name).toBe(vector.body);
        expect(toHex(bodyPayload(encoded)), vector.name).toBe(hex);
      }
      if (vector.context !== undefined) checkContext(decoded, vector.context);
      if (vector.preimage_hex !== undefined) {
        if (decoded.kind !== 'removal') throw new Error(`non-removal vector ${vector.name} has a preimage`);
        expect(toHex(bot.removalPreimage(decoded.value)), vector.name).toBe(vector.preimage_hex);
      }
    }
  });

  it('refuses every structural and context reject vector', () => {
    for (const vector of vectors.rejects) {
      const run = () => {
        if (vector.kind === 'helper_request' && vector.name.includes('length')) {
          if (vector.hex === undefined) throw new Error(`reject vector ${vector.name} is missing hex`);
          bot.parseHelperFrame(fromHex(vector.hex));
          return;
        }
        const decoded = decodeVector(vector.kind, vector.hex ?? '', vector.body);
        if (vector.context !== undefined) checkContext(decoded, vector.context);
      };
      expect(run, vector.name).toThrow(bot.BotError);
    }
  });
});

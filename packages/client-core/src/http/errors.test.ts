import { describe, expect, it } from 'vitest';
import { encode, type CborInput } from '../cbor';
import { DillaHttpError, decodeErrorBody } from './errors';

const body = (value: CborInput): Uint8Array => encode(value);
const REF = new Uint8Array(32).fill(0x11);
const WIN = new Uint8Array(48).fill(0x12);

describe('decodeErrorBody', () => {
  it('reads code, detail, retry delay and extras', () => {
    const e = decodeErrorBody(425, body(['E_COMMIT_REQUIRED', 'outstanding proposals must be committed first', 1500, [REF]]), null);
    expect(e).toBeInstanceOf(DillaHttpError);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('DillaHttpError');
    expect(e.status).toBe(425);
    expect(e.code).toBe('E_COMMIT_REQUIRED');
    expect(e.detail).toBe('outstanding proposals must be committed first');
    expect(e.retryAfterMs).toBe(1500);
    expect(e.extra).toEqual([[REF]]);
    expect(e.message).toBe('E_COMMIT_REQUIRED (425): outstanding proposals must be committed first');
  });

  it('keeps several extras in order', () => {
    const e = decodeErrorBody(409, body(['E_COMMIT_CONFLICT', 'another commit won this epoch', null, WIN, [REF]]), null);
    expect(e.retryAfterMs).toBeNull();
    expect(e.extra).toEqual([WIN, [REF]]);
  });

  it('prefers the body delay, then the Retry-After seconds, then nothing', () => {
    expect(decodeErrorBody(429, body(['E_RATE_LIMITED', 'rate limited', 1200]), '2').retryAfterMs).toBe(1200);
    expect(decodeErrorBody(429, body(['E_RATE_LIMITED', 'rate limited', null]), '2').retryAfterMs).toBe(2000);
    expect(decodeErrorBody(429, body(['E_RATE_LIMITED', 'rate limited', null]), 'soon').retryAfterMs).toBeNull();
    expect(decodeErrorBody(429, body(['E_RATE_LIMITED', 'rate limited', null]), null).retryAfterMs).toBeNull();
  });

  it('clamps a delay beyond the safe integer range', () => {
    expect(decodeErrorBody(503, body(['E_UNAVAILABLE', '', 2n ** 63n]), null).retryAfterMs).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('reads any body that is not a dilla error array as E_HTTP', () => {
    const notArrays: Uint8Array[] = [
      new TextEncoder().encode('404 page not found\n'),
      new Uint8Array(0),
      body([1, 2, 3]),
      body(['E_SHORT', 'two only']),
      body(['not a code', '', null]),
      body(['E_BAD_RETRY', 'detail', 'soon']),
      body(['E_BAD_DETAIL', 7, null]),
      new Uint8Array([0xa0]),
    ];
    for (const [i, raw] of notArrays.entries()) {
      const e = decodeErrorBody(404, raw, null);
      expect(e.code, `case ${i}`).toBe('E_HTTP');
      expect(e.detail, `case ${i}`).toBe('');
      expect(e.extra, `case ${i}`).toEqual([]);
      expect(e.status, `case ${i}`).toBe(404);
    }
    expect(decodeErrorBody(404, new Uint8Array(0), null).message).toBe('E_HTTP (404)');
  });
});

import { describe, it, expect } from 'vitest';
import { errorOf } from './errors.ts';
import { refusal } from '../test/fake-client.ts';

const NONE = { code: 'E_UNKNOWN', detail: '', status: 0, retryAfterMs: null };

describe('errorOf', () => {
  it('reads the four fields of the bridge error', () => {
    expect(errorOf({ code: 'E_RATE_LIMITED', detail: 'slow down', status: 429, retryAfterMs: 4200 }))
      .toEqual({ code: 'E_RATE_LIMITED', detail: 'slow down', status: 429, retryAfterMs: 4200 });
    expect(errorOf(refusal({ code: 'E_INVALID_REQUEST', detail: 'x', status: 409 })))
      .toEqual({ code: 'E_INVALID_REQUEST', detail: 'x', status: 409, retryAfterMs: null });
  });
  it('defaults each missing or mistyped field on its own', () => {
    expect(errorOf({ code: 'E_X' })).toEqual({ code: 'E_X', detail: '', status: 0, retryAfterMs: null });
    expect(errorOf({ code: 'E_X', detail: 5, status: 200, retryAfterMs: 1 })).toEqual({ code: 'E_X', detail: '', status: 200, retryAfterMs: 1 });
    expect(errorOf({ code: 'E_X', detail: 'd', status: '409', retryAfterMs: 1 })).toEqual({ code: 'E_X', detail: 'd', status: 0, retryAfterMs: 1 });
    expect(errorOf({ code: 'E_X', detail: 'd', status: 503, retryAfterMs: '1000' })).toEqual({ code: 'E_X', detail: 'd', status: 503, retryAfterMs: null });
  });
  it('falls back for anything else', () => {
    expect(errorOf(new Error('boom'))).toEqual(NONE);
    expect(errorOf(null)).toEqual(NONE);
    expect(errorOf('E_X')).toEqual(NONE);
    expect(errorOf({ code: 7 })).toEqual(NONE);
  });
});

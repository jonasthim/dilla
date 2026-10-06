// HTTP refusal shape from internal/server/errors.go.
import { CborError, decode, type CborValue } from '../cbor';

export class DillaHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  readonly retryAfterMs: number | null;
  readonly extra: CborValue[];

  constructor(init: { status: number; code: string; detail: string; retryAfterMs: number | null; extra: CborValue[] }) {
    super(`${init.code} (${init.status})${init.detail ? `: ${init.detail}` : ''}`);
    this.name = 'DillaHttpError';
    this.status = init.status;
    this.code = init.code;
    this.detail = init.detail;
    this.retryAfterMs = init.retryAfterMs;
    this.extra = init.extra;
  }
}

export function decodeErrorBody(status: number, body: Uint8Array, retryAfterHeader: string | null): DillaHttpError {
  let value: CborValue;
  try { value = decode(body); }
  catch (e) {
    if (!(e instanceof CborError)) throw e;
    value = null;
  }
  let code = 'E_HTTP';
  let detail = '';
  let delay: bigint | null = null;
  let extra: CborValue[] = [];
  if (Array.isArray(value) && value.length >= 3 && typeof value[0] === 'string'
    && /^E_[A-Z0-9_]{1,64}$/.test(value[0]) && typeof value[1] === 'string'
    && (typeof value[2] === 'bigint' || value[2] === null)) {
    code = value[0];
    detail = value[1];
    delay = value[2];
    extra = value.slice(3);
  }
  const retryAfterMs = delay !== null ? Number(delay > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : delay)
    : retryAfterHeader !== null && /^[0-9]{1,9}$/.test(retryAfterHeader) ? Number(retryAfterHeader) * 1000 : null;
  return new DillaHttpError({ status, code, detail, retryAfterMs, extra });
}

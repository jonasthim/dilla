// Deterministic CBOR (RFC 8949 §4.2.1) for the subset dilla uses:
// unsigned integers, byte strings, text strings, null, and definite-length arrays. Never maps.
export type CborValue = number | bigint | string | Uint8Array | null | CborValue[];

function head(major: number, n: bigint): Uint8Array {
  const m = major << 5;
  if (n < 24n) return new Uint8Array([m | Number(n)]);
  if (n < 0x100n) return new Uint8Array([m | 24, Number(n)]);
  if (n < 0x10000n) return new Uint8Array([m | 25, Number(n >> 8n), Number(n & 0xffn)]);
  if (n < 0x100000000n) return new Uint8Array([m | 26, Number(n >> 24n), Number((n >> 16n) & 0xffn), Number((n >> 8n) & 0xffn), Number(n & 0xffn)]);
  const out = new Uint8Array(9); out[0] = m | 27;
  for (let i = 0; i < 8; i++) out[1 + i] = Number((n >> BigInt(8 * (7 - i))) & 0xffn);
  return out;
}

export function encode(value: CborValue): Uint8Array {
  const parts: Uint8Array[] = [];
  const push = (v: CborValue) => {
    if (v === null) { parts.push(new Uint8Array([0xf6])); return; }
    if (typeof v === 'number') {
      if (!Number.isInteger(v) || v < 0 || v > Number.MAX_SAFE_INTEGER) throw new Error(`not an unsigned safe integer: ${v}`);
      parts.push(head(0, BigInt(v))); return;
    }
    if (typeof v === 'bigint') {
      if (v < 0n || v > 0xffffffffffffffffn) throw new Error(`out of range: ${v}`);
      parts.push(head(0, v)); return;
    }
    if (typeof v === 'string') { const b = new TextEncoder().encode(v); parts.push(head(3, BigInt(b.length)), b); return; }
    if (v instanceof Uint8Array) { parts.push(head(2, BigInt(v.length)), v); return; }
    if (Array.isArray(v)) { parts.push(head(4, BigInt(v.length))); for (const e of v) push(e); return; }
    throw new Error(`unsupported CBOR value: ${typeof v}`);
  };
  push(value);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function decode(bytes: Uint8Array): CborValue {
  let pos = 0;
  const need = (n: number) => { if (pos + n > bytes.length) throw new Error('truncated'); };
  const readArg = (ai: number, major: number): bigint => {
    if (ai < 24) return BigInt(ai);
    const len = ai === 24 ? 1 : ai === 25 ? 2 : ai === 26 ? 4 : ai === 27 ? 8 : -1;
    if (len < 0) throw new Error(`indefinite or reserved additional info ${ai} for major ${major}`);
    need(len); let v = 0n;
    for (let i = 0; i < len; i++) v = (v << 8n) | BigInt(bytes[pos++]);
    const min = len === 1 ? 24n : len === 2 ? 0x100n : len === 4 ? 0x10000n : 0x100000000n;
    if (v < min) throw new Error('non-minimal integer encoding');
    return v;
  };
  const item = (): CborValue => {
    need(1);
    const b = bytes[pos++]; const major = b >> 5; const ai = b & 0x1f;
    switch (major) {
      case 0: { const v = readArg(ai, 0); return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v; }
      case 2: { const n = Number(readArg(ai, 2)); need(n); const s = bytes.slice(pos, pos + n); pos += n; return s; }
      case 3: { const n = Number(readArg(ai, 3)); need(n); const s = new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(pos, pos + n)); pos += n; return s; }
      case 4: { const n = Number(readArg(ai, 4)); const arr: CborValue[] = []; for (let i = 0; i < n; i++) arr.push(item()); return arr; }
      case 7: { if (ai === 22) return null; throw new Error(`unsupported simple value ${ai}`); }
      default: throw new Error(`unsupported major type ${major}`);
    }
  };
  const v = item();
  if (pos !== bytes.length) throw new Error('trailing bytes');
  return v;
}

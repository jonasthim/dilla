import { hkdfSha256 } from './hkdf.ts';
import { concat, utf8, be64, be16 } from './bytes.ts';

/** SFrame cipher suite AES_128_GCM_SHA256_128 (RFC 9605 §4.5 cipher-suite table). */
export const SUITE = 0x0004;
const NK = 16, NN = 12;

/** KID = (leaf_index << 8) | (epoch mod 256); leaf_index < 2^16 (05-media-frames.md). */
export function kid(leafIndex: number, epoch: number): bigint {
  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex > 0xffff) throw new Error(`leaf index out of range: ${leafIndex}`);
  if (!Number.isInteger(epoch) || epoch < 0) throw new Error(`epoch out of range: ${epoch}`);
  return (BigInt(leafIndex) << 8n) | BigInt(epoch % 256);
}

/** RFC 9605 §4.4.2: sframe_secret = Extract("", base_key); key/salt = Expand(secret, label || KID(8) || suite(2), N). */
export async function deriveFrameKeys(baseKey: Uint8Array, k: bigint): Promise<{ key: Uint8Array; salt: Uint8Array }> {
  const key = await hkdfSha256(new Uint8Array(0), baseKey, concat(utf8('SFrame 1.0 Secret key '), be64(k), be16(SUITE)), NK);
  const salt = await hkdfSha256(new Uint8Array(0), baseKey, concat(utf8('SFrame 1.0 Secret salt '), be64(k), be16(SUITE)), NN);
  return { key, salt };
}

/** CTR = slot(8 bits) || layer(4 bits) || seq(52 bits); refuse on wrap. */
export function counter(slot: number, layer: number, seq: bigint | number): bigint {
  const s = BigInt(seq);
  if (slot < 0 || slot > 0xff) throw new Error(`slot out of range: ${slot}`);
  if (layer < 0 || layer > 0xf) throw new Error(`layer out of range: ${layer}`);
  if (s < 0n || s >= (1n << 52n)) throw new Error('sequence counter exhausted');
  return (BigInt(slot) << 56n) | (BigInt(layer) << 52n) | s;
}

/** nonce = salt XOR CTR (big-endian, left-padded to 12 bytes). */
export function nonce(salt: Uint8Array, ctr: bigint): Uint8Array {
  if (salt.length !== NN) throw new Error('salt must be 12 bytes');
  const out = new Uint8Array(NN); let c = ctr;
  for (let i = NN - 1; i >= 0; i--) { out[i] = salt[i] ^ Number(c & 0xffn); c >>= 8n; }
  return out;
}

function minBytes(v: bigint): number { let n = 1; while (v >= (1n << BigInt(8 * n))) n++; return n; }
function beBytes(v: bigint, n: number): Uint8Array { const out = new Uint8Array(n); let c = v; for (let i = n - 1; i >= 0; i--) { out[i] = Number(c & 0xffn); c >>= 8n; } return out; }

/**
 * RFC 9605 §4.3 SFrame header. Config byte bit layout (bit 0 = MSB):
 *   bit 0     X — extended KID flag
 *   bits 1-3  K — KID (if X=0) or (KID byte length - 1) (if X=1)
 *   bit 4     Y — extended CTR flag
 *   bits 5-7  C — CTR (if Y=0) or (CTR byte length - 1) (if Y=1)
 * So as byte weights: config = (X << 7) | (K << 4) | (Y << 3) | C. KID and CTR, when extended, are appended
 * after the config byte as big-endian integers in the minimum number of bytes, KID first then CTR.
 */
export function encodeSframeHeader(k: bigint, ctr: bigint): Uint8Array {
  const kExt = k > 7n, cExt = ctr > 7n;
  const kLen = kExt ? minBytes(k) : 0, cLen = cExt ? minBytes(ctr) : 0;
  if (kLen > 8 || cLen > 8) throw new Error('KID or CTR too large for the header');
  const kField = kExt ? (kLen - 1) : Number(k);
  const cField = cExt ? (cLen - 1) : Number(ctr);
  const config = (kExt ? 0x80 : 0) | (kField << 4) | (cExt ? 0x08 : 0) | cField;
  return concat(new Uint8Array([config]), kExt ? beBytes(k, kLen) : new Uint8Array(0), cExt ? beBytes(ctr, cLen) : new Uint8Array(0));
}

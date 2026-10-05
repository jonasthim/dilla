import { createCipheriv, createDecipheriv } from 'node:crypto';
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
// ---- the frame cipher (protocol/05 "Frame format", "Codec prefixes"; the Rust core's twin) ----

/** AEAD tag length (RFC 9605 Table 1, suite 0x0004). */
export const NT = 16;
export type Codec = 'opus' | 'vp8' | 'vp9' | 'h264';

/** A refusal named by its protocol/05 `E_SFRAME_*` code. */
export class SframeError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}

/** RFC 9605 §4.3, strict: truncation then minimality, KID before CTR. */
export function decodeSframeHeader(b: Uint8Array): { kid: bigint; ctr: bigint; length: number } {
  if (b.length < 1) throw new SframeError('E_SFRAME_TRUNCATED_HEADER');
  const c = b[0];
  let at = 1;
  const field = (extended: boolean, f: number): bigint => {
    if (!extended) return BigInt(f);
    const len = f + 1;
    if (at + len > b.length) throw new SframeError('E_SFRAME_TRUNCATED_HEADER');
    let v = 0n;
    for (let i = 0; i < len; i++) v = (v << 8n) | BigInt(b[at + i]);
    const lead = b[at];
    at += len;
    if (v <= 7n || (len > 1 && lead === 0)) throw new SframeError('E_SFRAME_NON_MINIMAL_HEADER');
    return v;
  };
  const kid = field((c & 0x80) !== 0, (c >> 4) & 7);
  const ctr = field((c & 0x08) !== 0, c & 7);
  return { kid, ctr, length: at };
}

/** The largest dilla-sframe/1 KID: leaf 2^16 - 1, epoch byte 255. */
export const KID_MAX = 0xffffffn;

/**
 * The dilla-sframe/1 receiver's parse (05-media-frames.md "Receiver rules", step 1): the strict
 * RFC 9605 header decode, then E_SFRAME_NON_CANONICAL_KID for a KID of 2^24 or more, before any
 * key is derived for it.
 */
export function parseDillaHeader(b: Uint8Array): { kid: bigint; ctr: bigint; length: number } {
  const h = decodeSframeHeader(b);
  if (h.kid > KID_MAX) throw new SframeError('E_SFRAME_NON_CANONICAL_KID');
  return h;
}

/** The number of `00` bytes ending `prefix`, capped at 2. */
export function trailingZeros(prefix: Uint8Array): number {
  let n = 0;
  for (let i = prefix.length - 1; i >= 0 && n < 2 && prefix[i] === 0; i--) n++;
  return n;
}

/** libwebrtc WriteRbsp with the zero counter seeded: WriteRbsp(00^seed || data)[seed..]. */
export function rbspEscape(seedZeros: number, data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let zeros = Math.min(seedZeros, 2);
  for (const b of data) {
    if (b <= 3 && zeros >= 2) { out.push(3); zeros = 0; }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return new Uint8Array(out);
}

/** libwebrtc ParseRbsp over the seeded input: ParseRbsp(00^seed || data)[seed..]. */
export function rbspUnescape(seedZeros: number, data: Uint8Array): Uint8Array {
  const seed = Math.min(seedZeros, 2);
  const d = concat(new Uint8Array(seed), data);
  const out: number[] = [];
  for (let i = 0; i < d.length;) {
    if (d.length - i >= 3 && d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 3) { out.push(0, 0); i += 3; } else { out.push(d[i]); i += 1; }
  }
  return new Uint8Array(out.slice(seed));
}

/** libwebrtc H264::FindNaluIndices: [start code offset, payload offset, payload end]. */
function findNalus(buf: Uint8Array): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  if (buf.length < 3) return out;
  const end = buf.length - 3;
  for (let i = 0; i < end;) {
    if (buf[i + 2] > 1) i += 3;
    else if (buf[i + 2] === 1) {
      if (buf[i + 1] === 0 && buf[i] === 0) {
        let start = i;
        if (start > 0 && buf[start - 1] === 0) start--;
        if (out.length) out[out.length - 1][2] = start;
        out.push([start, i + 3, buf.length]);
      }
      i += 3;
    } else i += 1;
  }
  return out;
}

/** libdave BytesCoveringH264PPS, with libwebrtc's pps_id <= 255 bound. */
function bytesCoveringPps(p: Uint8Array): number {
  let bit = 0;
  const next = (): number => {
    if (bit % 8 === 0) {
      const at = bit / 8;
      if (at >= 2 && p[at] === 3 && p[at - 1] === 0 && p[at - 2] === 0) bit += 8;
    }
    if (Math.floor(bit / 8) >= p.length) throw new SframeError('E_SFRAME_MALFORMED_PREFIX');
    const b = (p[Math.floor(bit / 8)] >> (7 - (bit % 8))) & 1;
    bit++;
    return b;
  };
  const ue = (): number => {
    let zeros = 0;
    while (next() === 0) if (++zeros > 31) throw new SframeError('E_SFRAME_MALFORMED_PREFIX');
    let v = 0;
    for (let i = 0; i < zeros; i++) v = v * 2 + next();
    return 2 ** zeros - 1 + v;
  };
  ue(); ue();
  if (ue() > 255) throw new SframeError('E_SFRAME_MALFORMED_PREFIX');
  const covered = Math.floor(bit / 8) + 1;
  if (covered > p.length) throw new SframeError('E_SFRAME_MALFORMED_PREFIX');
  return covered;
}

function h264PrefixLen(frame: Uint8Array): number {
  const nalus = findNalus(frame);
  if (!nalus.length || nalus[0][0] !== 0) throw new SframeError('E_SFRAME_MALFORMED_PREFIX');
  for (const [, at, end] of nalus) {
    if (at >= end) throw new SframeError('E_SFRAME_MALFORMED_PREFIX');
    const t = frame[at] & 0x1f;
    if (t === 1 || t === 5) return at + 1 + bytesCoveringPps(frame.subarray(at + 1, end));
    if ([2, 3, 4, 19, 20, 21].includes(t)) throw new SframeError('E_SFRAME_UNSUPPORTED_CODEC');
    if (t === 0 || t >= 24) throw new SframeError('E_SFRAME_MALFORMED_PREFIX');
  }
  throw new SframeError('E_SFRAME_NO_VCL_NAL');
}

/**
 * concat(00 00 00 01 || nal) over FindNaluIndices, and the clear prefix of the result. Access unit
 * delimiters (9) and filler data (12) before the first VCL NAL are dropped (a packetiser may drop
 * them, and the receiver's P would then lack them); after the first VCL NAL everything is kept.
 */
export function canonicalizeH264(frame: Uint8Array): { frame: Uint8Array; prefixLen: number } {
  const nalus = findNalus(frame);
  if (!nalus.length) throw new SframeError('E_SFRAME_MALFORMED_PREFIX');
  const kept: Uint8Array[] = [];
  let inPrefix = true;
  for (const [, at, end] of nalus) {
    const nal = frame.subarray(at, end);
    const t = nal.length ? nal[0] & 0x1f : -1;
    if (inPrefix && (t === 9 || t === 12)) continue;
    if ((t >= 1 && t <= 5) || (t >= 19 && t <= 21)) inPrefix = false;
    kept.push(concat(new Uint8Array([0, 0, 0, 1]), nal));
  }
  const out = concat(...kept);
  if (out.length === 0) throw new SframeError('E_SFRAME_NO_VCL_NAL');
  return { frame: out, prefixLen: h264PrefixLen(out) };
}

/** The clear codec prefix: Opus/VP9 0; VP8 10 (key, P bit 0) or 1; H.264 through pps_id. */
export function prefixLen(codec: Codec, frame: Uint8Array): number {
  switch (codec) {
    case 'opus': case 'vp9': return 0;
    case 'vp8':
      if (frame.length < 1) throw new SframeError('E_SFRAME_MALFORMED_PREFIX');
      if ((frame[0] & 1) === 0) {
        if (frame.length < 10) throw new SframeError('E_SFRAME_MALFORMED_PREFIX');
        return 10;
      }
      return 1;
    case 'h264': return h264PrefixLen(frame);
  }
}

/** P || H || C || T with AAD = H || P (node:crypto AES-128-GCM, 16-byte tag). */
export function encryptFrame(key: Uint8Array, salt: Uint8Array, k: bigint, ctr: bigint, prefix: number, frame: Uint8Array): Uint8Array {
  const header = encodeSframeHeader(k, ctr);
  const p = frame.subarray(0, prefix);
  const c = createCipheriv('aes-128-gcm', key, nonce(salt, ctr), { authTagLength: NT });
  c.setAAD(concat(header, p));
  const body = concat(c.update(frame.subarray(prefix)), c.final());
  return concat(p, header, body, c.getAuthTag());
}

/** The inverse of encryptFrame over the unescaped layout; throws SframeError. */
export function openFrame(key: Uint8Array, salt: Uint8Array, prefix: number, frame: Uint8Array): { kid: bigint; ctr: bigint; plain: Uint8Array } {
  if (prefix > frame.length) throw new SframeError('E_SFRAME_MALFORMED_PREFIX');
  const h = decodeSframeHeader(frame.subarray(prefix));
  const sealed = frame.subarray(prefix + h.length);
  if (sealed.length < NT) throw new SframeError('E_SFRAME_TRUNCATED_FRAME');
  const d = createDecipheriv('aes-128-gcm', key, nonce(salt, h.ctr), { authTagLength: NT });
  d.setAAD(concat(frame.subarray(prefix, prefix + h.length), frame.subarray(0, prefix)));
  d.setAuthTag(sealed.subarray(sealed.length - NT));
  try {
    const plain = concat(frame.subarray(0, prefix), d.update(sealed.subarray(0, sealed.length - NT)), d.final());
    return { kid: h.kid, ctr: h.ctr, plain };
  } catch {
    throw new SframeError('E_SFRAME_AUTH');
  }
}

/** The sender's codec path: prefix (H.264: canonicalise first), seal, and for H.264 the seeded escape. */
export async function protect(baseKey: Uint8Array, k: bigint, ctr: bigint, codec: Codec, frame: Uint8Array): Promise<Uint8Array> {
  const { key, salt } = await deriveFrameKeys(baseKey, k);
  if (codec !== 'h264') return encryptFrame(key, salt, k, ctr, prefixLen(codec, frame), frame);
  const c = canonicalizeH264(frame);
  const sealed = encryptFrame(key, salt, k, ctr, c.prefixLen, c.frame);
  const p = sealed.subarray(0, c.prefixLen);
  return concat(p, rbspEscape(trailingZeros(p), sealed.subarray(c.prefixLen)));
}

/** The receiver's codec path: unescape (H.264), read the KID, derive, open. Returns P || plaintext. */
export async function unprotect(baseKey: Uint8Array, codec: Codec, frame: Uint8Array): Promise<Uint8Array> {
  const prefix = prefixLen(codec, frame);
  const p = frame.subarray(0, prefix);
  const x = codec === 'h264' ? concat(p, rbspUnescape(trailingZeros(p), frame.subarray(prefix))) : frame;
  const { kid: k } = parseDillaHeader(x.subarray(prefix));
  const { key, salt } = await deriveFrameKeys(baseKey, k);
  return openFrame(key, salt, prefix, x).plain;
}

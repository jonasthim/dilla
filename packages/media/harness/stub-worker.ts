// The spike kit's stand-in for the dilla-media worker: it receives encoded frames through either
// attach path (createEncodedStreams + a transferred-stream message, or RTCRtpScriptTransform's
// rtctransform event) and runs one pluggable frame operation. It is NOT a cipher and never ships;
// the real worker is packages/media/src/worker (task 17).
//
// Counters live on globalThis.__stubStats and the H.264 log on globalThis.__stubLog: Playwright's
// worker.evaluate sees globalThis, never module-scoped bindings (G35 Q3).
import type { StubMode } from './main.ts';

type Side = 'encode' | 'decode';
interface StubOptions { side: Side; kind: 'audio' | 'video'; participantIdentity: string; trackId: string }
type EncodedFrame = RTCEncodedVideoFrame | RTCEncodedAudioFrame;
interface Transformer { readable: ReadableStream<EncodedFrame>; writable: WritableStream<EncodedFrame>; options: StubOptions }
interface WorkerScope {
  onmessage: ((ev: MessageEvent) => void) | null;
  onrtctransform?: ((ev: { transformer: Transformer }) => void) | null;
  postMessage(message: unknown): void;
  __stubStats: Record<string, number>;
  __stubLog: H264LogEntry[];
}
export interface H264LogEntry {
  side: Side; rtpTimestamp: number; type: string; prefixLen: number; prefixHex: string; prefixSha256: string;
  sps: Array<{ vui: boolean; bitstreamRestriction: boolean; maxNumReorderFrames: number; maxDecFrameBuffering: number; maxNumRefFrames: number }>;
}

const scope = self as unknown as WorkerScope;
const stats: Record<string, number> = {
  transforms: 0, enc: 0, dec: 0, pass: 0, drop: 0, short: 0, sif: 0, errors: 0,
  encKey: 0, encDelta: 0, decKey: 0, decDelta: 0, typeBitMismatch: 0, logged: 0,
};
scope.__stubStats = stats;
scope.__stubLog = [];
const LOG_CAP = 20_000;

let mode: StubMode = { kind: 'pass' };
let dropUntil = 0;
let sifTrailer: Uint8Array = new Uint8Array(0);

/** A 0x9f config byte: 2-byte KID, 8-byte CTR, the shape of every dilla camera frame (11 bytes). */
const HEADER_LEN = 11;
const TAG_LEN = 16;
let seq = 0;

/** xorshift32 keystream: every byte, bit 0 of byte 0 included, looks random (never the 0x5a XOR). */
function keystream(seed: number, len: number): Uint8Array {
  let x = (Math.imul(seed + 1, 0x9e3779b1) | 0) || 1;
  const ks = new Uint8Array(len);
  for (let i = 0; i < len; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; ks[i] = x & 0xff; }
  return ks;
}

function isVideo(frame: EncodedFrame): frame is RTCEncodedVideoFrame { return 'type' in frame; }

/** VP8: the P bit of the clear first byte decides key (0) or delta (1), on both sides. */
function clearBytes(frame: EncodedFrame, d: Uint8Array, keyPrefix: number, deltaPrefix: number): number {
  if (!isVideo(frame) || d.length === 0) return 0;
  return Math.min(d.length, (d[0] & 1) === 0 ? keyPrefix : deltaPrefix);
}

function xorEncode(frame: EncodedFrame, m: Extract<StubMode, { kind: 'xor' }>): void {
  const d = new Uint8Array(frame.data);
  const n = clearBytes(frame, d, m.keyPrefix, m.deltaPrefix);
  if (isVideo(frame) && d.length > 0) {
    const bitKey = (d[0] & 1) === 0;
    if ((frame.type === 'key') !== bitKey) stats.typeBitMismatch++;
    if (bitKey) stats.encKey++; else stats.encDelta++;
  }
  const seed = (Math.random() * 256) | 0;
  const header = new Uint8Array(m.sframeLayout ? HEADER_LEN : 0);
  if (m.sframeLayout) {
    header[0] = 0x9f; header[1] = 0x03; header[2] = 0x29; header[3] = 0x01;
    new DataView(header.buffer).setUint32(7, seq++ >>> 0);
  }
  const ks = keystream(seed, d.length - n);
  const out = new Uint8Array(n + header.length + (d.length - n) + TAG_LEN);
  out.set(d.subarray(0, n), 0);
  out.set(header, n);
  for (let i = n; i < d.length; i++) out[header.length + i] = m.clearBody ? d[i] : d[i] ^ ks[i - n];
  const tag = keystream(seed + 1, TAG_LEN);
  tag[0] = seed; tag[1] = 0xd1;
  out.set(tag, out.length - TAG_LEN);
  frame.data = out.buffer;
  stats.enc++;
}

function xorDecode(frame: EncodedFrame, m: Extract<StubMode, { kind: 'xor' }>): boolean {
  const d = new Uint8Array(frame.data);
  const headerLen = m.sframeLayout ? HEADER_LEN : 0;
  const n = clearBytes(frame, d, m.keyPrefix, m.deltaPrefix);
  if (d.length < n + headerLen + TAG_LEN || d[d.length - TAG_LEN + 1] !== 0xd1 || (m.sframeLayout && d[n] !== 0x9f)) {
    stats.short++;
    return false;
  }
  const seed = d[d.length - TAG_LEN];
  const bodyLen = d.length - n - headerLen - TAG_LEN;
  const ks = keystream(seed, bodyLen);
  const out = new Uint8Array(n + bodyLen);
  out.set(d.subarray(0, n), 0);
  for (let i = 0; i < bodyLen; i++) out[n + i] = d[n + headerLen + i] ^ ks[i];
  if (isVideo(frame) && out.length > 0) { if ((out[0] & 1) === 0) stats.decKey++; else stats.decDelta++; }
  frame.data = out.buffer;
  stats.dec++;
  return true;
}

// ---- H.264 logging (SP-04): the canonical-prefix rule of protocol/05, as the Rust core runs it ----

function findNalus(b: Uint8Array): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  if (b.length < 3) return out;
  for (let i = 0; i < b.length - 3;) {
    if (b[i + 2] > 1) i += 3;
    else if (b[i + 2] === 1) {
      if (b[i + 1] === 0 && b[i] === 0) {
        const start = i > 0 && b[i - 1] === 0 ? i - 1 : i;
        if (out.length) out[out.length - 1][2] = start;
        out.push([start, i + 3, b.length]);
      }
      i += 3;
    } else i++;
  }
  return out;
}

function unescape(d: Uint8Array): Uint8Array {
  const o: number[] = [];
  for (let i = 0; i < d.length;) {
    if (d.length - i >= 3 && d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 3) { o.push(0, 0); i += 3; } else o.push(d[i++]);
  }
  return new Uint8Array(o);
}

class Bits {
  private bit = 0;
  constructor(private readonly d: Uint8Array, private readonly escaped: boolean) {}
  get position(): number { return this.bit; }
  u(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      if (this.escaped && this.bit % 8 === 0) {
        const at = this.bit / 8;
        if (at >= 2 && this.d[at] === 3 && this.d[at - 1] === 0 && this.d[at - 2] === 0) this.bit += 8;
      }
      if (this.bit / 8 >= this.d.length) throw new Error('overrun');
      v = v * 2 + ((this.d[Math.floor(this.bit / 8)] >> (7 - (this.bit % 8))) & 1);
      this.bit++;
    }
    return v;
  }
  ue(): number { let z = 0; while (this.u(1) === 0) if (++z > 31) throw new Error('ue'); return 2 ** z - 1 + this.u(z); }
  se(): number { const k = this.ue(); return k % 2 ? (k + 1) / 2 : -k / 2; }
}

function spsFields(nal: Uint8Array): H264LogEntry['sps'][number] {
  const r = new Bits(unescape(nal.subarray(1)), false);
  const profile = r.u(8); r.u(16); r.ue();
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    const chroma = r.ue(); if (chroma === 3) r.u(1);
    r.ue(); r.ue(); r.u(1);
    if (r.u(1)) for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) if (r.u(1)) { let last = 8, next = 8; for (let j = 0; j < (i < 6 ? 16 : 64); j++) { if (next) next = (last + r.se() + 256) % 256; if (next) last = next; } }
  }
  r.ue();
  const poc = r.ue();
  if (poc === 0) r.ue(); else if (poc === 1) { r.u(1); r.se(); r.se(); const n = r.ue(); for (let i = 0; i < n; i++) r.se(); }
  const maxNumRefFrames = r.ue();
  r.u(1); r.ue(); r.ue();
  if (!r.u(1)) r.u(1);
  r.u(1);
  if (r.u(1)) { r.ue(); r.ue(); r.ue(); r.ue(); }
  const none = { vui: false, bitstreamRestriction: false, maxNumReorderFrames: -1, maxDecFrameBuffering: -1, maxNumRefFrames };
  if (!r.u(1)) return none;
  if (r.u(1) && r.u(8) === 255) r.u(32);
  if (r.u(1)) r.u(1);
  if (r.u(1)) { r.u(4); if (r.u(1)) r.u(24); }
  if (r.u(1)) { r.ue(); r.ue(); }
  if (r.u(1)) { r.u(32); r.u(33); }
  const hrd = (): void => { const n = r.ue(); r.u(8); for (let i = 0; i <= n; i++) { r.ue(); r.ue(); r.u(1); } r.u(20); };
  const nalHrd = r.u(1); if (nalHrd) hrd();
  const vclHrd = r.u(1); if (vclHrd) hrd();
  if (nalHrd || vclHrd) r.u(1);
  r.u(1);
  if (!r.u(1)) return { ...none, vui: true };
  r.u(1); r.ue(); r.ue(); r.ue(); r.ue();
  return { vui: true, bitstreamRestriction: true, maxNumReorderFrames: r.ue(), maxDecFrameBuffering: r.ue(), maxNumRefFrames };
}

/** Canonical prefix length and the SPS fields; -1 when the frame has no slice NAL. */
function h264Prefix(d: Uint8Array): { canonical: Uint8Array; prefixLen: number; sps: H264LogEntry['sps'] } {
  const nalus = findNalus(d);
  const parts: Uint8Array[] = [];
  const sps: H264LogEntry['sps'] = [];
  let prefixLen = -1;
  let at = 0;
  for (const [, p, end] of nalus) {
    const nal = d.subarray(p, end);
    const t = nal[0] & 0x1f;
    if (prefixLen < 0) {
      if (t === 7) { try { sps.push(spsFields(nal)); } catch { stats.errors++; } }
      if (t === 1 || t === 5) {
        const r = new Bits(nal.subarray(1), true);
        try { r.ue(); r.ue(); r.ue(); prefixLen = at + 5 + Math.floor(r.position / 8) + 1; } catch { prefixLen = -1; }
      }
    }
    parts.push(new Uint8Array([0, 0, 0, 1]), nal);
    at += 4 + nal.length;
  }
  const canonical = new Uint8Array(at);
  let o = 0;
  for (const p of parts) { canonical.set(p, o); o += p.length; }
  return { canonical, prefixLen, sps };
}

async function logH264(frame: EncodedFrame, side: Side): Promise<void> {
  if (!isVideo(frame) || scope.__stubLog.length >= LOG_CAP) return;
  const { canonical, prefixLen, sps } = h264Prefix(new Uint8Array(frame.data));
  const prefix = canonical.subarray(0, Math.max(prefixLen, 0));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', prefix.slice()));
  const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const meta = frame.getMetadata();
  scope.__stubLog.push({
    side, rtpTimestamp: meta.rtpTimestamp ?? frame.timestamp, type: frame.type, prefixLen,
    prefixHex: hex(prefix), prefixSha256: hex(digest), sps: side === 'encode' ? sps : [],
  });
  stats.logged++;
}

function endsWithSif(d: Uint8Array): boolean {
  if (sifTrailer.length === 0 || d.length < sifTrailer.length) return false;
  for (let i = 0; i < sifTrailer.length; i++) if (d[d.length - sifTrailer.length + i] !== sifTrailer[i]) return false;
  return true;
}

function setup(readable: ReadableStream<EncodedFrame>, writable: WritableStream<EncodedFrame>, opts: StubOptions): void {
  stats.transforms++;
  const transform = new TransformStream<EncodedFrame, EncodedFrame>({
    async transform(frame, ctl) {
      const m = mode;
      if (m.kind === 'drop' && opts.side === 'decode' && performance.now() < dropUntil) { stats.drop++; return; }
      if (m.kind === 'count-sif' && opts.side === 'decode' && endsWithSif(new Uint8Array(frame.data))) { stats.sif++; return; }
      if (m.kind === 'log-h264') await logH264(frame, opts.side);
      if (m.kind === 'xor') {
        if (opts.side === 'encode') xorEncode(frame, m);
        else if (!xorDecode(frame, m)) return;
      } else {
        stats.pass++;
      }
      ctl.enqueue(frame);
    },
  });
  readable.pipeThrough(transform).pipeTo(writable).catch(() => { stats.errors++; });
}

scope.onrtctransform = (ev) => setup(ev.transformer.readable, ev.transformer.writable, ev.transformer.options);

scope.onmessage = (ev: MessageEvent) => {
  const m = ev.data as
    | { kind: 'attach'; readable: ReadableStream<EncodedFrame>; writable: WritableStream<EncodedFrame>; options: StubOptions }
    | { kind: 'mode'; mode: StubMode }
    | { kind: 'setSifTrailer'; trailer: Uint8Array }
    | { kind: 'stats'; id: number };
  switch (m.kind) {
    case 'attach': setup(m.readable, m.writable, m.options); break;
    case 'mode': mode = m.mode; dropUntil = m.mode.kind === 'drop' ? performance.now() + m.mode.ms : 0; break;
    case 'setSifTrailer': sifTrailer = m.trailer; break;
    case 'stats': scope.postMessage({ kind: 'stats', id: m.id, stats: { ...stats } }); break;
  }
};

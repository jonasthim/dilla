import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { initSync, MediaReceiver, MediaSender } from '../wasm/dilla_core_wasm.js';
import type { FromWorker, MediaCodec, SlotId } from '../src/protocol';
import { Pipeline, type CryptoFactory, type EncodedFrameLike, type TrackHandle } from '../src/worker/pipeline';
import { OPUS_SILENCE_FRAME } from '../src/worker/sif';
import { kidHex, peekKidHex } from '../src/worker/stats';

const DEV_A = 'a1'.repeat(16);
const DEV_B = 'b2'.repeat(16);
const DEV_C = 'c3'.repeat(16);
const BASE = new Uint8Array(16).fill(0x0a);
const ROSTER = [{ leaf: 0, deviceId: DEV_A }, { leaf: 1, deviceId: DEV_B }, { leaf: 2, deviceId: DEV_C }];
const real: CryptoFactory = {
  newSender: (k, leaf, epoch, minEpoch) => new MediaSender(k, leaf, epoch, minEpoch),
  newReceiver: () => new MediaReceiver(),
};

beforeAll(() => {
  initSync({ module: readFileSync(new URL('../wasm/dilla_core_wasm_bg.wasm', import.meta.url)) });
});

const hex = (s: string): Uint8Array => Uint8Array.from((s.match(/../g) ?? []).map((b) => Number.parseInt(b, 16)));

function frame(bytes: Uint8Array, type?: 'key' | 'delta', ssrc = 1111, spatialIndex = 0, mimeType?: string): EncodedFrameLike {
  return { data: bytes.slice().buffer, type, getMetadata: () => ({ synchronizationSource: ssrc, spatialIndex, mimeType }) };
}

const MIME: Record<MediaCodec, string> = { opus: 'audio/opus', vp8: 'video/VP8', vp9: 'video/VP9', h264: 'video/H264' };

/** A sender-side frame: it carries its codec in getMetadata().mimeType, which is what the encoder reads (C1). */
function ef(h: TrackHandle, bytes: Uint8Array, type?: 'key' | 'delta', ssrc = 1111): EncodedFrameLike {
  return frame(bytes, type, ssrc, 0, MIME[h.opts.codec]);
}

class Sink {
  out: Uint8Array[] = [];
  enqueue(f: EncodedFrameLike): void { this.out.push(new Uint8Array(f.data)); }
}

function worker(crypto: CryptoFactory = real): { p: Pipeline; posted: FromWorker[]; advance(ms: number): void } {
  let now = 1_000;
  const posted: FromWorker[] = [];
  const p = new Pipeline({ crypto, post: (m) => posted.push(m), now: () => now });
  return { p, posted, advance: (ms) => { now += ms; } };
}

function install(p: Pipeline, epoch: bigint, selfLeaf: number, roster = ROSTER): void {
  p.handle({ kind: 'installEpoch', groupId: 'call-group', epoch, baseKey: BASE.slice(), selfLeaf, roster });
}

function encoder(p: Pipeline, sink: Sink, slot: SlotId, codec: MediaCodec, identity = DEV_A): TrackHandle {
  return p.addTrack({ dilla: 1, side: 'encode', trackId: `enc-${slot}`, participantIdentity: identity, slot, codec }, sink);
}

/** A decode track attached early (MediaTrackAdded) and mapped later (TrackSubscribed). */
function decoder(p: Pipeline, sink: Sink, slot: SlotId, codec: MediaCodec, identity: string | null = DEV_A, encryption: 0 | 1 | 2 = 1, requestKeyFrame?: () => Promise<unknown>): TrackHandle {
  const audio = slot === 0 || slot === 3;
  const h = p.addTrack({ dilla: 1, side: 'decode', trackId: `dec-${slot}`, participantIdentity: '', slot: audio ? 0 : 1, codec: audio ? 'opus' : 'vp8' }, sink, requestKeyFrame);
  if (identity !== null) p.handle({ kind: 'mapTrack', trackId: `dec-${slot}`, participantIdentity: identity, slot, codec, encryption });
  return h;
}

function encrypt(p: Pipeline, h: TrackHandle, sink: Sink, bytes: Uint8Array, type?: 'key' | 'delta'): Uint8Array {
  const before = sink.out.length;
  p.frame(h, ef(h, bytes, type));
  expect(sink.out.length).toBe(before + 1);
  return sink.out[sink.out.length - 1];
}

it('passes empty Opus DTX without spending a wasm counter or verifying it', () => {
  const A = worker();
  const B = worker();
  install(A.p, 7n, 0);
  install(B.p, 7n, 1);
  const sent = new Sink();
  const received = new Sink();
  const tx = encoder(A.p, sent, 0, 'opus');
  const rx = decoder(B.p, received, 0, 'opus');
  A.p.frame(tx, ef(tx, new Uint8Array()));
  B.p.frame(rx, frame(sent.out[0]));
  expect(sent.out[0]).toEqual(new Uint8Array());
  expect(received.out[0]).toEqual(new Uint8Array());
  expect(A.p.stats.emptyFrames).toEqual({ encode: 1, decode: 0 });
  expect(B.p.stats.emptyFrames).toEqual({ encode: 0, decode: 1 });
  expect(B.p.stats.verified).toEqual({});
  const sealed = encrypt(A.p, tx, sent, hex('fc0102'));
  // The first real frame still has sequence 0 and authenticates on its original track.
  expect(sealed[0]).toBe(0x70); // KID 7, counter 0 in RFC 9605's short header
  B.p.frame(rx, frame(sealed));
  expect(received.out[1]).toEqual(hex('fc0102'));
  expect(B.p.stats.verified).toEqual({ [DEV_A]: 1 });
  expect(B.p.stats.emptyFramesByTrack['dec-0']).toBe(1);
  expect(B.p.stats.decryptedByTrack['dec-0']).toBe(1);
  expect(B.p.stats.droppedByTrack['dec-0'] ?? 0).toBe(0);
});

const CASES: Array<{ name: string; codec: MediaCodec; slot: SlotId; frames: Array<{ bytes: Uint8Array; type?: 'key' | 'delta' }> }> = [
  { name: 'opus microphone', codec: 'opus', slot: 0, frames: [{ bytes: hex('fc0102030405060708') }] },
  { name: 'vp8 camera key and delta', codec: 'vp8', slot: 1, frames: [
    { bytes: hex('5002009d012a8002e0010102030405060708'), type: 'key' },
    { bytes: hex('310102030405060708'), type: 'delta' },
  ] },
  { name: 'vp9 screen video', codec: 'vp9', slot: 2, frames: [{ bytes: hex('8249834200017000010203040506') }] },
  { name: 'h264 camera IDR and P slice', codec: 'h264', slot: 1, frames: [
    { bytes: hex('0000000165888421ff00000312345a5a5a5a'), type: 'key' },
    { bytes: hex('0000000141888421ff00000312345a5a5a5a'), type: 'delta' },
  ] },
  { name: 'opus screen audio', codec: 'opus', slot: 3, frames: [{ bytes: hex('fc0909090909090909') }] },
];

describe('the dilla-media/1 pipeline over the real wasm', () => {
  for (const c of CASES) {
    it(`${c.name}: encrypts, and the receiver returns the exact frame`, () => {
      const A = worker();
      const B = worker();
      install(A.p, 7n, 0);
      install(B.p, 7n, 1);
      const sa = new Sink();
      const sb = new Sink();
      const enc = encoder(A.p, sa, c.slot, c.codec);
      const dec = decoder(B.p, sb, c.slot, c.codec);
      for (const f of c.frames) {
        const ct = encrypt(A.p, enc, sa, f.bytes, f.type);
        expect(ct).not.toEqual(f.bytes);
        expect(ct.length).toBeGreaterThan(f.bytes.length + 16);
        expect(peekKidHex(c.codec, ct)).toBe(kidHex(0, 7n));
        B.p.frame(dec, frame(ct, f.type));
        expect(sb.out[sb.out.length - 1]).toEqual(f.bytes);
      }
      expect(A.p.stats.encrypted[kidHex(0, 7n)][c.slot]).toBe(c.frames.length);
      expect(B.p.stats.decrypted[kidHex(0, 7n)]).toBe(c.frames.length);
      expect(B.p.stats.decryptedByTrackKid[`dec-${c.slot}`]?.[kidHex(0, 7n)]).toBe(c.frames.length);
      expect(B.p.stats.verifiedByTrack[`dec-${c.slot}`]).toBe(c.frames.length);
      expect(B.p.stats.verified).toEqual({ [DEV_A]: c.frames.length }); // N6
      expect(B.p.stats.passedThrough).toBe(0);
      expect(Object.values(B.p.stats.dropped).every((n) => n === 0)).toBe(true);
    });
  }

  it('N6: a frame of leaf 0 on a publication mapped to another roster device is never counted as verified', () => {
    const A = worker();
    const B = worker();
    install(A.p, 7n, 0);
    install(B.p, 7n, 1);
    const sa = new Sink();
    const sb = new Sink();
    const enc = encoder(A.p, sa, 0, 'opus');
    const dec = decoder(B.p, sb, 0, 'opus', DEV_C); // the SFU claims the track belongs to DEV_C (leaf 2)
    B.p.frame(dec, frame(encrypt(A.p, enc, sa, hex('fc0102030405060708'))));
    expect(sb.out).toHaveLength(0);
    expect(B.p.stats.dropped.senderMismatch).toBe(1);
    expect(B.p.stats.verified).toEqual({});
  });

  it('refuses a removed device under a superseded epoch', () => {
    const A = worker();
    const B = worker();
    install(A.p, 7n, 0);
    install(B.p, 7n, 1);
    const sent = new Sink();
    const received = new Sink();
    const tx = encoder(A.p, sent, 0, 'opus');
    const rx = decoder(B.p, received, 0, 'opus');
    const sealed = encrypt(A.p, tx, sent, hex('fc0102030405060708'));
    install(B.p, 8n, 1, [{ leaf: 1, deviceId: DEV_B }, { leaf: 2, deviceId: DEV_C }]);
    B.p.frame(rx, frame(sealed));
    expect(received.out).toHaveLength(0);
    expect(B.p.stats.dropped.senderMismatch).toBe(1);
  });

  it('reads a three-byte KID (leaf 300) from the header', () => {
    const roster = [{ leaf: 300, deviceId: DEV_A }, { leaf: 1, deviceId: DEV_B }];
    const A = worker();
    install(A.p, 2n, 300, roster);
    const sa = new Sink();
    const ct = encrypt(A.p, encoder(A.p, sa, 0, 'opus'), sa, hex('fc01020304'));
    expect(peekKidHex('opus', ct)).toBe(kidHex(300, 2n));
    expect(kidHex(300, 2n)).toBe('12c02');
  });

  it('drops a frame ending in the SIF trailer as sif before any parsing', () => {
    const B = worker();
    install(B.p, 7n, 1);
    const sb = new Sink();
    const dec = decoder(B.p, sb, 0, 'opus');
    const trailer = new TextEncoder().encode('k3Jd9QpX0aLmNzR4tUvWyB2cE5fG7hI8jK1lMnOpQrS');
    B.p.handle({ kind: 'setSifTrailer', trailer });
    const f = new Uint8Array(80 + trailer.length);
    f.set(OPUS_SILENCE_FRAME);
    f.set(trailer, 80);
    B.p.frame(dec, frame(f));
    expect(sb.out).toHaveLength(0);
    expect(B.p.stats.dropped.sif).toBe(1);
    expect(B.p.stats.sifTrailerLen).toBe(43);
    B.p.handle({ kind: 'setSifTrailer', trailer: new Uint8Array(0) });
    expect(B.p.stats.sifTrailerLen).toBe(43); // an empty trailer is ignored, never "replaces" with nothing
  });

  it('drops every frame of a NONE-flagged publication', () => {
    const A = worker();
    const B = worker();
    install(A.p, 7n, 0);
    install(B.p, 7n, 1);
    const sa = new Sink();
    const sb = new Sink();
    const ct = encrypt(A.p, encoder(A.p, sa, 0, 'opus'), sa, hex('fc0102030405060708'));
    B.p.frame(decoder(B.p, sb, 0, 'opus', DEV_A, 0), frame(ct));
    expect(sb.out).toHaveLength(0);
    expect(B.p.stats.dropped.noneFlagged).toBe(1);
  });

  it('holds unknown-KID frames in order and releases them when the epoch arrives', () => {
    const A = worker();
    const B = worker();
    install(A.p, 7n, 0);
    install(A.p, 8n, 0);
    install(B.p, 7n, 1);
    const sa = new Sink();
    const sb = new Sink();
    const enc = encoder(A.p, sa, 0, 'opus');
    const dec = decoder(B.p, sb, 0, 'opus');
    const plain = [hex('fc01'), hex('fc02'), hex('fc03')];
    for (const p of plain) B.p.frame(dec, frame(encrypt(A.p, enc, sa, p)));
    expect(sb.out).toHaveLength(0);
    expect(dec.fifo.length).toBe(3);
    install(B.p, 8n, 1);
    expect(sb.out).toEqual(plain);
    expect(B.p.stats.decrypted[kidHex(0, 8n)]).toBe(3);
    expect(B.posted.some((m) => m.kind === 'epochInstalled' && m.epoch === 8n)).toBe(true);
  });

  it('drops a held frame older than 2000 ms as bufferTimeout', () => {
    const A = worker();
    const B = worker();
    install(A.p, 9n, 0);
    install(B.p, 7n, 1);
    const sa = new Sink();
    const sb = new Sink();
    const dec = decoder(B.p, sb, 0, 'opus');
    B.p.frame(dec, frame(encrypt(A.p, encoder(A.p, sa, 0, 'opus'), sa, hex('fc01'))));
    B.advance(2_001);
    B.p.tick();
    expect(dec.fifo.length).toBe(0);
    expect(B.p.stats.dropped.bufferTimeout).toBe(1);
    expect(sb.out).toHaveLength(0);
  });

  it('holds frames that arrive before the publication is mapped, then decrypts them', () => {
    const A = worker();
    const B = worker();
    install(A.p, 7n, 0);
    install(B.p, 7n, 1);
    const sa = new Sink();
    const sb = new Sink();
    const dec = decoder(B.p, sb, 0, 'opus', null);
    B.p.frame(dec, frame(encrypt(A.p, encoder(A.p, sa, 0, 'opus'), sa, hex('fc0a0b'))));
    expect(sb.out).toHaveLength(0);
    B.p.handle({ kind: 'mapTrack', trackId: 'dec-0', participantIdentity: DEV_A, slot: 0, codec: 'opus', encryption: 1 });
    expect(sb.out).toEqual([hex('fc0a0b')]);
  });

  // Measured in a real Chromium call (task 17): Room's own MediaTrackAdded listener runs before the manager's and
  // emits TrackSubscribed synchronously, so mapTrack reaches the worker before the attach (or the retarget of a
  // re-delivered receiver). The mapping must survive both orders.
  it('applies a mapping that arrives before the attach', () => {
    const A = worker();
    const B = worker();
    install(A.p, 7n, 0);
    install(B.p, 7n, 1);
    const sa = new Sink();
    const sb = new Sink();
    B.p.handle({ kind: 'mapTrack', trackId: 'dec-0', participantIdentity: DEV_A, slot: 0, codec: 'opus', encryption: 1 });
    const dec = B.p.addTrack({ dilla: 1, side: 'decode', trackId: 'dec-0', participantIdentity: '', slot: 0, codec: 'opus' }, sb);
    B.p.frame(dec, frame(encrypt(A.p, encoder(A.p, sa, 0, 'opus'), sa, hex('fc0a0b'))));
    expect(sb.out).toEqual([hex('fc0a0b')]);
  });

  it('keeps the mapping when a re-delivered MediaTrackAdded retargets the handle after TrackSubscribed', () => {
    const A = worker();
    const B = worker();
    install(A.p, 7n, 0);
    install(B.p, 7n, 1);
    const sa = new Sink();
    const sb = new Sink();
    const enc = encoder(A.p, sa, 0, 'opus');
    const dec = B.p.addTrack({ dilla: 1, side: 'decode', trackId: 'rx-1', participantIdentity: '', slot: 0, codec: 'opus' }, sb);
    B.p.handle({ kind: 'mapTrack', trackId: 'rx-2', participantIdentity: DEV_A, slot: 0, codec: 'opus', encryption: 1 });
    B.p.handle({ kind: 'retarget', data: { previousTrackId: 'rx-1', dilla: 1, side: 'decode', trackId: 'rx-2', participantIdentity: '', slot: 0, codec: 'opus' } });
    B.p.frame(dec, frame(encrypt(A.p, enc, sa, hex('fc0c'))));
    B.p.handle({ kind: 'retarget', data: { previousTrackId: 'rx-2', dilla: 1, side: 'decode', trackId: 'rx-2', participantIdentity: '', slot: 0, codec: 'opus' } });
    B.p.frame(dec, frame(encrypt(A.p, enc, sa, hex('fc0d'))));
    expect(sb.out).toEqual([hex('fc0c'), hex('fc0d')]);
    B.p.handle({ kind: 'detach', trackId: 'rx-2' });
    B.p.handle({ kind: 'retarget', data: { previousTrackId: 'rx-2', dilla: 1, side: 'decode', trackId: 'rx-2', participantIdentity: '', slot: 0, codec: 'opus' } });
    B.p.frame(dec, frame(encrypt(A.p, enc, sa, hex('fc0e'))));
    expect(sb.out).toHaveLength(2); // a detach forgets the mapping: held until TrackSubscribed maps it again
    expect(dec.fifo.length).toBe(1);
  });

  const REJECTS: Array<{ name: string; reason: string; setup: (B: Pipeline) => void; identity: string; slot: SlotId; mutate?: (ct: Uint8Array) => void; twice?: boolean }> = [
    { name: 'a flipped tag bit', reason: 'aeadFail', setup: (B) => install(B, 7n, 1), identity: DEV_A, slot: 0, mutate: (ct) => { ct[ct.length - 1] ^= 1; } },
    { name: 'a slot that is not the track source slot', reason: 'slotMismatch', setup: (B) => install(B, 7n, 1), identity: DEV_A, slot: 3 },
    { name: 'the receiver’s own leaf', reason: 'ownKid', setup: (B) => install(B, 7n, 0), identity: DEV_A, slot: 0 },
    { name: 'a KID leaf that is not the track device’s leaf', reason: 'senderMismatch', setup: (B) => install(B, 7n, 1), identity: DEV_C, slot: 0 },
    { name: 'a leaf absent from the epoch’s roster', reason: 'foreignLeaf', setup: (B) => install(B, 7n, 1, [{ leaf: 1, deviceId: DEV_B }, { leaf: 2, deviceId: DEV_C }]), identity: DEV_A, slot: 0 },
    { name: 'a replayed frame', reason: 'replay', setup: (B) => install(B, 7n, 1), identity: DEV_A, slot: 0, twice: true },
    { name: 'an identity that is not a device id', reason: 'senderMismatch', setup: (B) => install(B, 7n, 1), identity: `${DEV_A}#rig`, slot: 0 },
  ];
  for (const r of REJECTS) {
    it(`drops ${r.name} as ${r.reason}`, () => {
      const A = worker();
      const B = worker();
      install(A.p, 7n, 0);
      r.setup(B.p);
      const sa = new Sink();
      const sb = new Sink();
      const ct = encrypt(A.p, encoder(A.p, sa, 0, 'opus'), sa, hex('fc0102030405060708'));
      r.mutate?.(ct);
      const dec = decoder(B.p, sb, r.slot, 'opus', r.identity);
      B.p.frame(dec, frame(ct));
      if (r.twice === true) B.p.frame(dec, frame(ct));
      expect(sb.out).toHaveLength(r.twice === true ? 1 : 0);
      expect(B.p.stats.dropped[r.reason as keyof typeof B.p.stats.dropped]).toBe(1);
    });
  }

  it('stops the encoder on E_SFRAME_COUNTER_EXHAUSTED and asks for a rekey', () => {
    const exhausting: CryptoFactory = {
      newSender: (k, leaf, epoch, minEpoch) => {
        const s = new MediaSender(k, leaf, epoch, minEpoch);
        return {
          encrypt: () => { throw new Error('E_SFRAME_COUNTER_EXHAUSTED'); },
          rekey: (a, b, c) => s.rekey(a, b, c),
          exhausted: () => true,
          free: () => s.free(),
        };
      },
      newReceiver: () => new MediaReceiver(),
    };
    const A = worker(exhausting);
    install(A.p, 7n, 0);
    const sa = new Sink();
    const enc = encoder(A.p, sa, 0, 'opus');
    A.p.frame(enc, ef(enc, hex('fc01')));
    A.p.frame(enc, ef(enc, hex('fc02')));
    expect(sa.out).toHaveLength(0);
    expect(A.posted.filter((m) => m.kind === 'seqExhausted')).toEqual([{ kind: 'seqExhausted', slot: 0, layer: 0 }]);
    expect(A.posted.filter((m) => m.kind === 'rekeyNeeded')).toEqual([{ kind: 'rekeyNeeded', reason: 'seqExhausted' }]);
  });

  it('drops the 17th simulcast layer of a KID and asks for a rekey once', () => {
    const A = worker();
    install(A.p, 7n, 0);
    const sa = new Sink();
    const enc = encoder(A.p, sa, 1, 'vp8');
    for (let ssrc = 1; ssrc <= 18; ssrc++) A.p.frame(enc, ef(enc, hex('310102030405060708'), 'delta', ssrc));
    expect(sa.out).toHaveLength(16);
    expect(A.posted.filter((m) => m.kind === 'rekeyNeeded')).toEqual([{ kind: 'rekeyNeeded', reason: 'layerSpace' }]);
  });

  it('encrypts nothing before an epoch, and after clearKeys never re-enters an epoch it already used (N1)', () => {
    const A = worker();
    const sa = new Sink();
    const enc = encoder(A.p, sa, 0, 'opus');
    A.p.frame(enc, ef(enc, hex('fc01')));
    expect(sa.out).toHaveLength(0);
    expect(A.posted.some((m) => m.kind === 'error' && m.code === 'E_NO_EPOCH')).toBe(true);
    install(A.p, 7n, 0);
    A.p.frame(enc, ef(enc, hex('fc02')));
    expect(sa.out).toHaveLength(1);
    A.p.handle({ kind: 'clearKeys' });
    install(A.p, 7n, 0);
    A.p.frame(enc, ef(enc, hex('fc03')));
    expect(sa.out).toHaveLength(1);
    install(A.p, 8n, 0);
    A.p.frame(enc, ef(enc, hex('fc04')));
    expect(sa.out).toHaveLength(2);
    expect(peekKidHex('opus', sa.out[1])).toBe(kidHex(0, 8n));
  });

  it('retires a superseded epoch after 10 s and mirrors the stats on globalThis', () => {
    const B = worker();
    install(B.p, 7n, 1);
    install(B.p, 8n, 1);
    expect(B.p.stats.currentEpoch).toBe('8');
    expect(B.p.stats.knownKids).toEqual(expect.arrayContaining([kidHex(0, 7n), kidHex(0, 8n)]));
    B.advance(10_000);
    B.p.tick();
    expect(B.posted.filter((m) => m.kind === 'epochRetired')).toEqual([{ kind: 'epochRetired', epoch: 7n }]);
    expect(B.p.stats.knownKids).not.toContain(kidHex(0, 7n));
    expect((globalThis as { __dillaMediaStats?: unknown }).__dillaMediaStats).toBe(B.p.stats);
  });

  it('mirrors the wasm receiver’s late-install, retired-epoch and same-mod-256 rules', () => {
    const B = worker();
    install(B.p, 300n, 1);
    install(B.p, 44n, 1); // same low byte, but outside the 255-epoch window
    expect(B.p.stats.currentEpoch).toBe('300');
    expect(B.posted.filter((m) => m.kind === 'epochInstalled')).toHaveLength(1);
    install(B.p, 301n, 1);
    B.advance(10_000);
    B.p.tick();
    install(B.p, 300n, 1); // a dropped epoch cannot reappear
    expect(B.posted.filter((m) => m.kind === 'epochInstalled')).toHaveLength(2);
    install(B.p, 557n, 1); // aliases 301 modulo 256
    expect(B.posted).toContainEqual({ kind: 'epochRetired', epoch: 301n });
    expect(B.p.stats.currentEpoch).toBe('557');
    expect(B.p.stats.knownKids).toHaveLength(ROSTER.length);
  });
});

// SP-02 (task 15, measured): one sendKeyFrameRequest() sent < 500 ms after another receiver's PLI is eaten by
// LiveKit's layer-0 throttle and recovery falls back to the 3 s timeout; re-sending every 500 ms until a key frame
// passes recovered at p50 536 ms. So the worker repeats the request until it enqueues a decrypted key frame.
describe('key-frame requests on the script path (SP-02)', () => {
  const KEY = hex('5002009d012a8002e0010102030405060708');
  const DELTA = hex('310102030405060708');

  function call(): { A: ReturnType<typeof worker>; B: ReturnType<typeof worker>; enc: TrackHandle; dec: TrackHandle; sa: Sink; sb: Sink; requests: number[] } {
    const A = worker();
    const B = worker();
    install(A.p, 7n, 0);
    install(B.p, 7n, 1);
    const sa = new Sink();
    const sb = new Sink();
    const requests: number[] = [];
    let t = 0;
    const enc = encoder(A.p, sa, 1, 'vp8');
    const dec = decoder(B.p, sb, 1, 'vp8', DEV_A, 1, async () => { requests.push(t++); });
    return { A, B, enc, dec, sa, sb, requests };
  }

  function tampered(c: ReturnType<typeof call>, bytes: Uint8Array, type: 'key' | 'delta'): EncodedFrameLike {
    const ct = encrypt(c.A.p, c.enc, c.sa, bytes, type);
    ct[ct.length - 1] ^= 1;
    return frame(ct, type);
  }

  it('asks once on a drop, repeats every 500 ms while only delta frames pass, and stops at a key frame', () => {
    const c = call();
    c.B.p.frame(c.dec, tampered(c, DELTA, 'delta'));
    expect(c.B.p.stats.dropped.aeadFail).toBe(1);
    expect(c.requests).toHaveLength(1);
    c.B.advance(100);
    c.B.p.frame(c.dec, frame(encrypt(c.A.p, c.enc, c.sa, DELTA, 'delta'), 'delta'));
    c.B.p.tick();
    expect(c.requests).toHaveLength(1); // at most one request per 500 ms
    c.B.advance(400);
    c.B.p.tick();
    expect(c.requests).toHaveLength(2); // repeated: no key frame has passed yet
    c.B.advance(500);
    c.B.p.frame(c.dec, frame(encrypt(c.A.p, c.enc, c.sa, DELTA, 'delta'), 'delta'));
    expect(c.requests).toHaveLength(3);
    c.B.p.frame(c.dec, frame(encrypt(c.A.p, c.enc, c.sa, KEY, 'key'), 'key'));
    expect(c.sb.out.at(-1)).toEqual(KEY);
    c.B.advance(5_000);
    c.B.p.tick();
    c.B.p.frame(c.dec, frame(encrypt(c.A.p, c.enc, c.sa, DELTA, 'delta'), 'delta'));
    expect(c.requests).toHaveLength(3); // a decrypted key frame ends the episode
  });

  it('a dropped key frame does not end the episode', () => {
    const c = call();
    c.B.p.frame(c.dec, tampered(c, KEY, 'key'));
    expect(c.requests).toHaveLength(1);
    c.B.advance(600);
    c.B.p.tick();
    expect(c.requests).toHaveLength(2);
  });

  it('never asks for a sif or noneFlagged drop, nor on an audio track, and stops asking once detached', () => {
    const c = call();
    const trailer = new TextEncoder().encode('k3Jd9QpX0aLmNzR4tUvWyB2cE5fG7hI8jK1lMnOpQrS');
    c.B.p.handle({ kind: 'setSifTrailer', trailer });
    const sifFrame = new Uint8Array(31 + trailer.length);
    sifFrame.set(trailer, 31);
    c.B.p.frame(c.dec, frame(sifFrame, 'key'));
    expect(c.B.p.stats.dropped.sif).toBe(1);
    expect(c.requests).toHaveLength(0);

    const audioRequests: number[] = [];
    const audio = c.B.p.addTrack({ dilla: 1, side: 'decode', trackId: 'dec-audio', participantIdentity: DEV_A, slot: 0, codec: 'opus', encryption: 1 }, new Sink(), async () => { audioRequests.push(1); });
    c.B.p.frame(audio, frame(hex('fc0102030405060708')));
    expect(c.B.p.stats.dropped.parse + c.B.p.stats.dropped.aeadFail + c.B.p.stats.dropped.unknownKid).toBeGreaterThan(0);
    expect(audioRequests).toHaveLength(0);

    const none = c.B.p.addTrack({ dilla: 1, side: 'decode', trackId: 'dec-none', participantIdentity: DEV_A, slot: 1, codec: 'vp8', encryption: 0 }, new Sink(), async () => { audioRequests.push(2); });
    c.B.p.frame(none, frame(DELTA, 'delta'));
    expect(c.B.p.stats.dropped.noneFlagged).toBe(1);
    expect(audioRequests).toHaveLength(0);

    c.B.p.frame(c.dec, tampered(c, DELTA, 'delta'));
    expect(c.requests).toHaveLength(1);
    c.B.p.handle({ kind: 'detach', trackId: 'dec-1' });
    c.B.advance(1_000);
    c.B.p.tick();
    expect(c.requests).toHaveLength(1);
  });
});

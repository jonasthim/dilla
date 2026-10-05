// The pipeline's fail-closed paths over a fake cipher (Node, no wasm): what happens when the cipher throws something
// other than a dilla-sframe/1 code, when a frame's own codec has no prefix rule, when a transform is blocked, and
// whether every copy of a base key the worker handled is zero afterwards (task 17 review I3, C1 step 2, M7).
import { describe, expect, it } from 'vitest';
import type { DillaBlockOptions, DillaTransformOptions, FromWorker, SlotId } from '../src/protocol';
import { CODEC_NUMBER } from '../src/slots';
import { HOLD_MAX_BYTES } from '../src/worker/pending';
import { Pipeline, type CryptoFactory, type EncodedFrameLike, type ReceiverLike, type SenderLike } from '../src/worker/pipeline';

const DEV_A = 'a1'.repeat(16);
const DEV_B = 'b2'.repeat(16);
const ROSTER = [{ leaf: 0, deviceId: DEV_A }, { leaf: 1, deviceId: DEV_B }];

class FakeCipher implements CryptoFactory {
  encryptError: unknown = undefined;
  decryptError: unknown = undefined;
  /** Every key array the pipeline handed to the cipher, and a copy of its bytes at the time of the call. */
  readonly keys: Array<{ array: Uint8Array; atCall: number[] }> = [];
  readonly encrypts: Array<{ codec: number; slot: number; layer: number }> = [];
  readonly decrypts: number[] = [];

  private record(k: Uint8Array): void {
    this.keys.push({ array: k, atCall: [...k] });
  }

  newSender(baseKey: Uint8Array): SenderLike {
    this.record(baseKey);
    return {
      encrypt: (codec, slot, layer, frame) => {
        this.encrypts.push({ codec, slot, layer });
        if (this.encryptError !== undefined) throw this.encryptError;
        return Uint8Array.from([0xee, ...frame.map((b) => b ^ 0xff)]);
      },
      rekey: (k) => this.record(k),
      exhausted: () => false,
      free: () => undefined,
    };
  }

  newReceiver(): ReceiverLike {
    return {
      install_epoch: (_e, k) => this.record(k),
      expire: () => undefined,
      decrypt: (_codec, frame) => {
        this.decrypts.push(_codec);
        if (this.decryptError !== undefined) throw this.decryptError;
        return frame.slice(1).map((b) => b ^ 0xff);
      },
      free: () => undefined,
    };
  }
}

class Sink {
  out: Uint8Array[] = [];
  enqueue(f: EncodedFrameLike): void { this.out.push(new Uint8Array(f.data)); }
}

function frame(bytes: number[] | Uint8Array, mimeType?: string, ssrc = 1): EncodedFrameLike {
  return { data: Uint8Array.from(bytes).buffer, getMetadata: () => ({ synchronizationSource: ssrc, spatialIndex: 0, mimeType }) };
}

function setup(): { p: Pipeline; cipher: FakeCipher; posted: FromWorker[]; advance(ms: number): void } {
  let now = 1_000;
  const cipher = new FakeCipher();
  const posted: FromWorker[] = [];
  const p = new Pipeline({ crypto: cipher, post: (m) => posted.push(m), now: () => now });
  return { p, cipher, posted, advance: (ms) => { now += ms; } };
}

function install(p: Pipeline, epoch = 7n, baseKey = new Uint8Array(16).fill(7)): Uint8Array {
  p.handle({ kind: 'installEpoch', groupId: 'g', epoch, baseKey, selfLeaf: 0, roster: ROSTER });
  return baseKey;
}

const enc = (slot: SlotId, codec: DillaTransformOptions['codec'] = slot === 0 || slot === 3 ? 'opus' : 'vp8'): DillaTransformOptions => ({
  dilla: 1, side: 'encode', trackId: `enc-${slot}`, participantIdentity: DEV_A, slot, codec,
});
const dec = (trackId = 'dec-0'): DillaTransformOptions => ({
  dilla: 1, side: 'decode', trackId, participantIdentity: DEV_B, slot: 0, codec: 'opus', encryption: 1,
});

describe('epoch window mirrors the receiver', () => {
  it('never lists an epoch dropped 25 seconds ago when it is reinstalled', () => {
    const { p, posted, advance } = setup();
    install(p, 5n);
    install(p, 6n);
    advance(25_000);
    p.tick();
    install(p, 5n);
    expect(p.stats.currentEpoch).toBe('6');
    expect(p.stats.knownKids).not.toContain('5');
    expect(posted.filter((m) => m.kind === 'epochInstalled' && m.epoch === 5n)).toHaveLength(1);
  });
  it('expires an old held epoch before deciding a late reinstall without a tick', () => {
    const { p, advance } = setup();
    install(p, 5n);
    install(p, 6n);
    advance(25_000);
    install(p, 5n);
    expect(p.stats.knownKids).not.toContain('5');
  });
  it('ignores a late install older than 255 commits, even when its KID aliases the newest', () => {
    const { p, cipher, posted } = setup();
    install(p, 300n);
    const calls = cipher.keys.length;
    install(p, 44n);
    expect(cipher.keys).toHaveLength(calls);
    expect(p.stats.currentEpoch).toBe('300');
    expect(p.stats.knownKids).toHaveLength(2);
    expect(posted.filter((m) => m.kind === 'epochInstalled')).toHaveLength(1);
  });

  it('does not reinstall a retired epoch and retires epochs outside the window', () => {
    const { p, posted, advance } = setup();
    install(p, 5n);
    install(p, 6n);
    advance(10_000);
    p.tick();
    const installed = posted.filter((m) => m.kind === 'epochInstalled').length;
    install(p, 5n);
    expect(posted.filter((m) => m.kind === 'epochInstalled')).toHaveLength(installed);
    install(p, 7n);
    install(p, 263n);
    expect(posted).toContainEqual({ kind: 'epochRetired', epoch: 6n });
    expect(p.stats.knownKids).not.toContain('6');
  });
  it('retires same-mod-256 and more-than-255-behind epochs immediately', () => {
    const { p, posted } = setup();
    install(p, 1n);
    install(p, 257n);
    expect(posted).toContainEqual({ kind: 'epochRetired', epoch: 1n });
    expect(p.stats.knownKids).toHaveLength(2); // the alias now belongs only to epoch 257
    install(p, 258n);
    install(p, 514n);
    expect(posted).toContainEqual({ kind: 'epochRetired', epoch: 257n });
    expect(p.stats.knownKids).toHaveLength(2);
  });
});

describe('zero-byte audio DTX frames', () => {
  it('sends empty audio without encryption and still encrypts a one-byte audio frame', () => {
    const { p, cipher } = setup();
    install(p);
    const sink = new Sink();
    const h = p.addTrack(enc(0), sink);
    p.frame(h, frame([], 'audio/opus'));
    p.frame(h, frame([0xfc], 'audio/opus'));
    expect(sink.out.map((b) => [...b])).toEqual([[], [0xee, 0x03]]);
    expect(cipher.encrypts).toHaveLength(1);
    expect(p.stats.emptyFrames).toEqual({ encode: 1, decode: 0 });
    expect(p.stats.encrypted['7'][0]).toBe(1);
  });

  it('does not pass an empty video frame', () => {
    const { p } = setup();
    install(p);
    const sink = new Sink();
    const h = p.addTrack(enc(1), sink);
    p.frame(h, frame([], 'video/VP8'));
    expect(sink.out).toHaveLength(0);
  });

  it('receives empty audio before mapping without decrypting, verifying, dropping, or holding it', () => {
    const { p, cipher } = setup();
    install(p);
    const sink = new Sink();
    const h = p.addTrack({ ...dec(), participantIdentity: '', encryption: undefined }, sink);
    cipher.decryptError = new Error('E_SFRAME_AUTH');
    p.frame(h, frame([]));
    expect(sink.out.map((b) => [...b])).toEqual([[]]);
    expect(h.fifo.length).toBe(0);
    expect(p.stats.emptyFrames).toEqual({ encode: 0, decode: 1 });
    expect(p.stats.decrypted).toEqual({});
    expect(p.stats.verified).toEqual({});
    expect(Object.values(p.stats.dropped).every((n) => n === 0)).toBe(true);
    p.frame(h, frame([0x01]));
    expect(sink.out.map((b) => [...b])).toEqual([[]]);
    expect(p.stats.dropped.aeadFail).toBe(0); // unmapped non-empty frames still enter the hold
    expect(h.fifo.length).toBe(1);
  });

  it('delivers an empty frame after an older held frame', () => {
    const { p, cipher } = setup();
    install(p);
    const sink = new Sink();
    const h = p.addTrack(dec(), sink);
    cipher.decryptError = new Error('E_SFRAME_UNKNOWN_KID');
    p.frame(h, frame([0x80, 0x01]));
    expect(h.fifo.length).toBe(1);
    p.frame(h, frame([]));
    expect(h.fifo.length).toBe(2);
    expect(sink.out).toHaveLength(0);
    cipher.decryptError = undefined;
    install(p, 8n);
    expect(sink.out.map((b) => [...b])).toEqual([[0xfe], []]);
    expect(p.stats.emptyFrames.decode).toBe(1);
    expect(p.stats.decryptedByTrack['dec-0']).toBe(1);
  });

  it('counts an expired held frame as dropped and then releases its queued empty frame', () => {
    const { p, cipher, advance } = setup();
    install(p);
    const sink = new Sink();
    const h = p.addTrack(dec(), sink);
    cipher.decryptError = new Error('E_SFRAME_UNKNOWN_KID');
    p.frame(h, frame([0x80, 0x01]));
    p.frame(h, frame([]));
    expect(sink.out).toHaveLength(0);
    expect(h.fifo.length).toBe(2);
    advance(2_001);
    p.tick();
    expect(sink.out.map((b) => [...b])).toEqual([[]]);
    expect(p.stats.dropped.bufferTimeout).toBe(1);
    expect(p.stats.droppedByTrack['dec-0']).toBe(1);
    expect(p.stats.decryptedByTrack['dec-0']).toBeUndefined();
    expect(p.stats.emptyFrames.decode).toBe(1);
  });

  it('blocks empty audio on both sides and drops empty video on receive', () => {
    const { p } = setup();
    install(p);
    const send = new Sink();
    const recv = new Sink();
    p.frame(p.addTrack(block('encode', 'blocked-send'), send), frame([], 'audio/opus'));
    p.frame(p.addTrack(block('decode', 'blocked-recv'), recv), frame([]));
    const video = new Sink();
    p.frame(p.addTrack({ ...dec('video'), slot: 1, codec: 'vp8' }, video), frame([]));
    expect(send.out).toHaveLength(0);
    expect(recv.out).toHaveLength(0);
    expect(video.out).toHaveLength(0);
    expect(p.stats.dropped.blocked).toBe(2);
    expect(p.stats.emptyFrames).toEqual({ encode: 0, decode: 0 });
  });
});
it('dropHeld counts every cleared frame on its track', () => {
  const { p, cipher } = setup();
  install(p);
  cipher.decryptError = new Error('E_SFRAME_UNKNOWN_KID');
  const h = p.addTrack(dec(), new Sink());
  p.frame(h, frame([1]));
  p.handle({ kind: 'detach', trackId: 'dec-0' });
  expect(p.stats.droppedByTrack['dec-0']).toBe(1);
});

it('uses a receiver frame codec when exposed instead of its mapped publication codec', () => {
  const { p, cipher } = setup();
  install(p);
  const h = p.addTrack({ ...dec(), slot: 1, codec: 'vp8' }, new Sink());
  p.frame(h, frame([0x01, 0x02], 'video/H264'));
  expect(cipher.decrypts).toEqual([CODEC_NUMBER.h264]);
});

it('reports the side of an unsupported codec and cannot replace an opposite-side handle', () => {
  const { p, posted } = setup();
  install(p);
  const send = new Sink();
  const h = p.addTrack({ ...enc(1), trackId: 'same' }, send);
  p.addTrack({ ...dec('same'), slot: 1, codec: 'vp8' }, new Sink());
  expect((p as unknown as { tracks: Map<string, unknown> }).tracks.get('same')).toBe(h);
  p.frame(h, frame([1, 2], 'video/AV1'));
  expect(posted).toContainEqual(expect.objectContaining({ kind: 'error', code: 'unsupportedCodec', side: 'encode' }));
  expect(send.out).toHaveLength(0);
});
const block = (side: 'encode' | 'decode', trackId: string): DillaBlockOptions => ({ dilla: 1, side, trackId, block: true });

describe('the encoder takes each frame’s codec from the frame (C1 step 2, M6)', () => {
  it('drops and counts a video frame whose own codec has no prefix rule, whatever the attach-time label said', () => {
    const { p, cipher } = setup();
    install(p);
    const sink = new Sink();
    const h = p.addTrack(enc(1, 'vp8'), sink);
    p.frame(h, frame([1, 2, 3], 'video/AV1'));
    p.frame(h, frame([1, 2, 3], 'video/H265'));
    p.frame(h, frame([1, 2, 3], undefined));
    p.frame(h, frame([1, 2, 3], 'audio/opus'));
    expect(sink.out).toHaveLength(0);
    expect(cipher.encrypts).toHaveLength(0);
    expect(p.stats.dropped.unsupportedCodec).toBe(4);
  });

  it('encrypts a frame under the rule of its own codec, not the attach-time codec', () => {
    const { p, cipher } = setup();
    install(p);
    const sink = new Sink();
    const h = p.addTrack(enc(1, 'vp8'), sink);
    p.frame(h, frame([1, 2, 3], 'video/VP9'));
    p.frame(h, frame([1, 2, 3], 'video/h264'));
    p.frame(h, frame([1, 2, 3], 'video/VP8'));
    expect(cipher.encrypts.map((e) => e.codec)).toEqual([CODEC_NUMBER.vp9, CODEC_NUMBER.h264, CODEC_NUMBER.vp8]);
    expect(sink.out).toHaveLength(3);
  });

  it('drops an audio-slot frame that is not Opus', () => {
    const { p, cipher } = setup();
    install(p);
    const sink = new Sink();
    const h = p.addTrack(enc(0), sink);
    p.frame(h, frame([1, 2, 3], 'audio/PCMU'));
    p.frame(h, frame([1, 2, 3], 'audio/red'));
    p.frame(h, frame([1, 2, 3], undefined));
    p.frame(h, frame([1, 2, 3], 'audio/opus'));
    expect(cipher.encrypts.map((e) => e.codec)).toEqual([CODEC_NUMBER.opus]);
    expect(sink.out).toHaveLength(1);
    expect(p.stats.dropped.unsupportedCodec).toBe(3);
  });
});

describe('nothing passes when the cipher throws (I3: review mutants M4 and M10)', () => {
  const THROWN: Array<[string, unknown]> = [
    ['a dilla-sframe/1 code other than counter exhaustion', new Error('E_SFRAME_MALFORMED_PREFIX')],
    ['a wasm trap', new WebAssembly.RuntimeError('unreachable')],
    ['a TypeError', new TypeError('x is not a function')],
    ['a thrown string', 'boom'],
  ];

  for (const [name, err] of THROWN) {
    it(`an encoder whose encrypt throws ${name} enqueues nothing and leaves the frame unencrypted in no sink`, () => {
      const { p, cipher } = setup();
      install(p);
      cipher.encryptError = err;
      const sink = new Sink();
      const h = p.addTrack(enc(0), sink);
      for (let i = 0; i < 3; i++) p.frame(h, frame([0xfc, i], 'audio/opus'));
      expect(sink.out).toHaveLength(0);
      expect(Object.values(p.stats.encrypted)).toEqual([]);
      cipher.encryptError = undefined;
      p.frame(h, frame([0xfc, 9], 'audio/opus'));
      expect(sink.out).toEqual([Uint8Array.from([0xee, 0x03, 0xf6])]); // the track keeps encrypting afterwards
    });

    it(`a decoder whose decrypt throws ${name} renders nothing and counts the drop`, () => {
      const { p, cipher } = setup();
      install(p, 7n);
      cipher.decryptError = err;
      const sink = new Sink();
      const h = p.addTrack(dec(), sink);
      p.frame(h, frame([0x01, 0x02, 0x03]));
      expect(sink.out).toHaveLength(0);
      expect(h.fifo.length).toBe(0);
      const dropped = Object.values(p.stats.dropped).reduce((a, b) => a + b, 0);
      expect(dropped).toBe(1);
      expect(p.stats.decrypted).toEqual({});
    });
  }

  it('classifies a trap or a foreign exception as internal, and a dilla code by its reason', () => {
    const { p, cipher } = setup();
    install(p);
    const sink = new Sink();
    const h = p.addTrack(dec(), sink);
    cipher.decryptError = new WebAssembly.RuntimeError('unreachable');
    p.frame(h, frame([1]));
    cipher.decryptError = new Error('E_SFRAME_AUTH');
    p.frame(h, frame([2]));
    expect(p.stats.dropped.internal).toBe(1);
    expect(p.stats.dropped.aeadFail).toBe(1);
  });

  it('fault() drops and counts a frame the pipeline threw on, and the track keeps working', () => {
    const { p, posted } = setup();
    install(p);
    const sink = new Sink();
    const h = p.addTrack(enc(0), sink);
    p.fault(h, new Error('stream glitch'));
    expect(p.stats.dropped.internal).toBe(1);
    expect(posted.some((m) => m.kind === 'error' && m.code === 'internal' && m.trackId === 'enc-0')).toBe(true);
    p.frame(h, frame([0xfc], 'audio/opus'));
    expect(sink.out).toHaveLength(1);
  });
});

describe('blocking transforms (C1 step 1)', () => {
  it('a blocked encoder or decoder forwards no frame and counts every one as blocked', () => {
    const { p, cipher } = setup();
    install(p);
    const s1 = new Sink();
    const s2 = new Sink();
    const e = p.addTrack(block('encode', 'tx'), s1);
    const d = p.addTrack(block('decode', 'rx'), s2);
    for (let i = 0; i < 4; i++) {
      p.frame(e, frame([0xfc, i], 'audio/opus'));
      p.frame(d, frame([0xfc, i]));
    }
    p.handle({ kind: 'mapTrack', trackId: 'rx', participantIdentity: DEV_B, slot: 0, codec: 'opus', encryption: 1 });
    p.frame(d, frame([0xfc, 9]));
    p.tick();
    expect(s1.out).toHaveLength(0);
    expect(s2.out).toHaveLength(0);
    expect(cipher.encrypts).toHaveLength(0);
    expect(p.stats.dropped.blocked).toBe(9);
  });

  it('a retarget with full options upgrades a blocked handle; one with block options blocks a working one', () => {
    const { p } = setup();
    install(p);
    const sink = new Sink();
    const h = p.addTrack(block('encode', 'tx-1'), sink);
    p.frame(h, frame([0xfc], 'audio/opus'));
    p.handle({ kind: 'retarget', data: { previousTrackId: 'tx-1', ...enc(0), trackId: 'tx-2' } });
    p.frame(h, frame([0xfc], 'audio/opus'));
    expect(sink.out).toHaveLength(1);
    p.handle({ kind: 'retarget', data: { previousTrackId: 'tx-2', ...block('encode', 'tx-3') } });
    p.frame(h, frame([0xfc], 'audio/opus'));
    expect(sink.out).toHaveLength(1);
    expect(p.stats.dropped.blocked).toBe(2);
  });

  // N7 (task 17 re-review, mutant 11): a retarget never moves a handle to the other side. The stream it wraps keeps
  // its direction (an encoder's input is plaintext, a decoder's output is rendered), so options for the other side
  // block the handle and are reported.
  it('a retarget with full options for the other side blocks the handle instead of switching it', () => {
    const { p, posted } = setup();
    install(p);
    const encSink = new Sink();
    const decSink = new Sink();
    const e = p.addTrack(enc(0), encSink);
    const d = p.addTrack({ ...dec('rx-1'), slot: 0 }, decSink);
    p.handle({ kind: 'retarget', data: { previousTrackId: 'enc-0', ...dec('tx-2') } });
    p.handle({ kind: 'retarget', data: { previousTrackId: 'rx-1', ...enc(0), trackId: 'rx-2' } });
    for (let i = 0; i < 3; i++) {
      p.frame(e, frame([0xfc, i], 'audio/opus'));
      p.frame(d, frame([0xee, 0x03, i]));
    }
    expect(encSink.out).toHaveLength(0);
    expect(decSink.out).toHaveLength(0);
    expect(e.opts.side).toBe('encode');
    expect(d.opts.side).toBe('decode');
    expect(p.stats.dropped.blocked).toBe(6);
    expect(posted.filter((m) => m.kind === 'error' && m.code === 'E_BAD_OPTIONS').map((m) => (m as { trackId?: string }).trackId)).toEqual(['tx-2', 'rx-2']);
  });
});

// N6 (task 17 re-review): the "verified" signal is counted per mapped device by the decoder itself, after the cipher
// authenticated the frame and bound it to that device (expectedDevice), not from the JS KID peek.
describe('verified decrypts are counted per mapped device (N6)', () => {
  it('counts an authenticated frame for the participantIdentity the track is mapped to, whatever its KID bytes say', () => {
    const { p, cipher } = setup();
    install(p);
    const sink = new Sink();
    const h = p.addTrack(dec(), sink);
    p.frame(h, frame([0xee, 0x01])); // byte 0 reads as no valid KID header for the peek
    p.frame(h, frame([0x80, 0x01, 0x02]));
    expect(sink.out).toHaveLength(2);
    expect(p.stats.verified).toEqual({ [DEV_B]: 2 });
    cipher.decryptError = new Error('E_SFRAME_AUTH');
    p.frame(h, frame([0x80, 0x01, 0x02]));
    cipher.decryptError = new Error('E_SFRAME_SENDER_MISMATCH');
    p.frame(h, frame([0x80, 0x01, 0x02]));
    expect(p.stats.verified).toEqual({ [DEV_B]: 2 }); // a failed or mis-bound frame is never counted
  });

  it('counts nothing for an unmapped, blocked or NONE-flagged track', () => {
    const { p } = setup();
    install(p);
    const unmapped = p.addTrack({ ...dec('rx-u'), participantIdentity: '', encryption: undefined }, new Sink());
    const blocked = p.addTrack(block('decode', 'rx-b'), new Sink());
    const none = p.addTrack({ ...dec('rx-n'), encryption: 0 }, new Sink());
    for (const h of [unmapped, blocked, none]) p.frame(h, frame([0x80, 0x01]));
    expect(p.stats.verified).toEqual({});
  });
});

describe('worker-side key zeroing (I3: review mutant M9, M4)', () => {
  it('zeroes the transferred key and every copy it handed to the cipher, after the cipher saw the real key', () => {
    const { p, cipher } = setup();
    const key = install(p, 7n);
    expect([...key]).toEqual(new Array(16).fill(0));
    expect(cipher.keys.length).toBeGreaterThanOrEqual(2); // the receiver's install and the sender's construction
    for (const k of cipher.keys) {
      expect(k.atCall).toEqual(new Array(16).fill(7));
      expect([...k.array]).toEqual(new Array(16).fill(0));
    }
    const rekeyKey = install(p, 8n, new Uint8Array(16).fill(9));
    expect([...rekeyKey]).toEqual(new Array(16).fill(0));
    for (const k of cipher.keys.slice(2)) {
      expect(k.atCall).toEqual(new Array(16).fill(9));
      expect([...k.array]).toEqual(new Array(16).fill(0));
    }
  });

  it('zeroes the key also when the cipher throws during the install', () => {
    const posted: FromWorker[] = [];
    const failing: CryptoFactory = {
      newSender: () => { throw new Error('E_BAD_OPTIONS'); },
      newReceiver: () => ({ install_epoch: (_e, k) => { k.fill(1); throw new Error('E_BAD_OPTIONS'); }, expire: () => undefined, decrypt: () => new Uint8Array(), free: () => undefined }),
    };
    const q = new Pipeline({ crypto: failing, post: (m) => posted.push(m), now: () => 0 });
    const key = new Uint8Array(16).fill(7);
    q.handle({ kind: 'installEpoch', groupId: 'g', epoch: 7n, baseKey: key, selfLeaf: 0, roster: ROSTER });
    expect([...key]).toEqual(new Array(16).fill(0));
    expect(posted).toContainEqual({ kind: 'error', code: 'E_WASM', epoch: 7n, trackId: undefined, participantIdentity: undefined });
    expect(posted.some((m) => m.kind === 'epochInstalled')).toBe(false);
  });
});

describe('the hold is bounded by bytes as well (M7)', () => {
  it('evicts the oldest held frames, counted unknownKid, once a track holds more than HOLD_MAX_BYTES', () => {
    const { p, cipher } = setup();
    install(p);
    cipher.decryptError = new Error('E_SFRAME_UNKNOWN_KID');
    const sink = new Sink();
    const h = p.addTrack(dec(), sink);
    const quarter = HOLD_MAX_BYTES / 4;
    for (let i = 0; i < 4; i++) p.frame(h, frame(new Uint8Array(quarter)));
    expect(h.fifo.length).toBe(4);
    expect(p.stats.dropped.unknownKid).toBe(0);
    p.frame(h, frame(new Uint8Array(16)));
    expect(h.fifo.length).toBe(4);
    expect(p.stats.dropped.unknownKid).toBe(1);
    p.frame(h, frame(new Uint8Array(HOLD_MAX_BYTES + 1)));
    expect(h.fifo.length).toBe(0); // a frame larger than the cap evicts everything, itself included
    expect(p.stats.dropped.unknownKid).toBe(6);
    expect(sink.out).toHaveLength(0);
  });
});

import { describe, expect, it } from 'vitest';
import { parseToWorker } from '../src/worker/messages';

// The worker speaks dilla-media/1 only. livekit-client's own E2EE worker protocol (init with keyProviderOptions,
// setKey, ratchetRequest, enable, encode, decode, updateCodec, setSifTrailer with a data member, …) is never
// spoken to a custom manager's worker (DEV-12); if such a message ever arrives it is ignored, never acted on.
const DEV = 'a1'.repeat(16);
const opts = { dilla: 1, side: 'decode', trackId: 't', participantIdentity: DEV, slot: 1, codec: 'vp8' } as const;

describe('parseToWorker (dilla-media/1 only)', () => {
  it('accepts every dilla-media/1 message shape', () => {
    const accepted = [
      { kind: 'init', v: 1, logLevel: 'warn', wasmUrl: 'http://x/dilla_core_wasm_bg.wasm' },
      { kind: 'installEpoch', groupId: 'g', epoch: 3n, baseKey: new Uint8Array(16), selfLeaf: 0, roster: [{ leaf: 0, deviceId: DEV }] },
      { kind: 'clearKeys' },
      { kind: 'setSifTrailer', trailer: new Uint8Array(43) },
      { kind: 'attach', data: { ...opts, readable: new ReadableStream(), writable: new WritableStream() } },
      { kind: 'retarget', data: { ...opts, previousTrackId: 'old' } },
      { kind: 'attach', data: { dilla: 1, side: 'encode', trackId: 't', block: true, readable: new ReadableStream(), writable: new WritableStream() } },
      { kind: 'retarget', data: { dilla: 1, side: 'encode', trackId: 't', block: true, previousTrackId: 'old' } },
      { kind: 'mapTrack', trackId: 't', participantIdentity: DEV, slot: 1, codec: 'vp8', encryption: 1 },
      { kind: 'detach', trackId: 't' },
      { kind: 'stats', id: 4 },
    ];
    for (const m of accepted) expect(parseToWorker(m)).toBe(m);
  });

  it('ignores livekit-client’s E2EE worker messages: setKey, ratchetRequest, enable, encode/decode and its setSifTrailer', () => {
    const ignored: unknown[] = [
      { kind: 'init', data: { keyProviderOptions: { sharedKey: true }, loglevel: 'warn' } },
      { kind: 'setKey', data: { key: {}, participantIdentity: DEV, keyIndex: 0 } },
      { kind: 'ratchetRequest', data: { participantIdentity: DEV, keyIndex: 0 } },
      { kind: 'enable', data: { enabled: false, participantIdentity: DEV } },
      { kind: 'enable', data: { enabled: true, participantIdentity: DEV } },
      { kind: 'encode', data: { readableStream: new ReadableStream(), writableStream: new WritableStream(), trackId: 't' } },
      { kind: 'decode', data: { readableStream: new ReadableStream(), writableStream: new WritableStream(), trackId: 't' } },
      { kind: 'updateCodec', data: { trackId: 't', codec: 'vp8' } },
      { kind: 'setSifTrailer', data: { trailer: new Uint8Array(43) } },
      { kind: 'removeTransform', data: { trackId: 't' } },
    ];
    for (const m of ignored) expect(parseToWorker(m)).toBeNull();
  });

  it('refuses malformed dilla-media/1 messages', () => {
    const bad: unknown[] = [
      null, 'clearKeys', 42,
      { kind: 'init', v: 2, logLevel: 'warn', wasmUrl: 'x' },
      { kind: 'installEpoch', groupId: 'g', epoch: 3, baseKey: new Uint8Array(16), selfLeaf: 0, roster: [] },
      { kind: 'installEpoch', groupId: 'g', epoch: 3n, baseKey: [1, 2], selfLeaf: 0, roster: [] },
      { kind: 'installEpoch', groupId: 'g', epoch: 3n, baseKey: new Uint8Array(16), selfLeaf: 0, roster: [{ leaf: '0', deviceId: DEV }] },
      { kind: 'attach', data: { ...opts, codec: 'av1', readable: new ReadableStream(), writable: new WritableStream() } },
      { kind: 'attach', data: { ...opts } },
      { kind: 'retarget', data: { ...opts, dilla: 2, previousTrackId: 'old' } },
      { kind: 'attach', data: { dilla: 1, side: 'encode', trackId: 't', block: 'yes', readable: new ReadableStream(), writable: new WritableStream() } },
      { kind: 'retarget', data: { dilla: 1, side: 'sideways', trackId: 't', block: true, previousTrackId: 'old' } },
      { kind: 'mapTrack', trackId: 't', participantIdentity: DEV, slot: 4, codec: 'vp8', encryption: 1 },
      { kind: 'mapTrack', trackId: 't', participantIdentity: DEV, slot: 1, codec: 'vp8', encryption: 3 },
      { kind: 'detach' },
      { kind: 'stats', id: '1' },
    ];
    for (const m of bad) expect(parseToWorker(m)).toBeNull();
  });
});

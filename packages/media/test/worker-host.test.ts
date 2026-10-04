// worker/index.ts's wiring, through the host it starts (worker/host.ts): init, unknown messages, the transferred
// streams of the createEncodedStreams path, the RTCRtpScriptTransform path, blocking transforms, and a throwing
// transform callback (task 17 review I3). Node, fake cipher, real WHATWG streams.
import { describe, expect, it, vi } from 'vitest';
import type { DillaTransformOptions, FromWorker } from '../src/protocol';
import { startWorker, type TransformerLike, type WorkerScopeLike } from '../src/worker/host';
import type { CryptoFactory, EncodedFrameLike } from '../src/worker/pipeline';

const DEV_A = 'a1'.repeat(16);
const DEV_B = 'b2'.repeat(16);

const cipher = (): CryptoFactory => ({
  newSender: () => ({
    encrypt: (_c, _s, _l, f) => Uint8Array.from([0xee, ...f]),
    rekey: () => undefined, exhausted: () => false, free: () => undefined,
  }),
  newReceiver: () => ({
    install_epoch: () => undefined, expire: () => undefined,
    decrypt: (_c, f) => {
      if (f[0] !== 0xee) throw new Error('E_SFRAME_AUTH');
      return f.slice(1);
    },
    free: () => undefined,
  }),
});

class Scope implements WorkerScopeLike {
  posted: FromWorker[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onrtctransform: ((e: { transformer: TransformerLike }) => void) | null = null;
  postMessage(m: FromWorker): void { this.posted.push(m); }
  send(data: unknown): void { this.onmessage?.({ data }); }
  kinds(): string[] { return this.posted.map((m) => m.kind); }
}

function start(load: (url: string) => Promise<CryptoFactory> = async () => cipher()) {
  const scope = new Scope();
  const loads = vi.fn(load);
  const host = startWorker(scope, { load: loads, now: () => 1_000, every: () => undefined, scriptTransform: true });
  return { scope, host, loads };
}

async function ready(s: Scope, host: ReturnType<typeof start>['host']): Promise<void> {
  s.send({ kind: 'init', v: 1, logLevel: 'warn', wasmUrl: 'x.wasm' });
  await host.settled();
}

function installEpoch(s: Scope): void {
  s.send({ kind: 'installEpoch', groupId: 'g', epoch: 7n, baseKey: new Uint8Array(16).fill(7), selfLeaf: 0, roster: [{ leaf: 0, deviceId: DEV_A }, { leaf: 1, deviceId: DEV_B }] });
}

/** A frame source the test pushes into, and a sink that records what the transform wrote. */
function pipe(): { readable: ReadableStream<EncodedFrameLike>; writable: WritableStream<EncodedFrameLike>; push(f: EncodedFrameLike): void; written: Uint8Array[]; aborted: () => boolean } {
  let ctrl!: ReadableStreamDefaultController<EncodedFrameLike>;
  const written: Uint8Array[] = [];
  let aborted = false;
  return {
    readable: new ReadableStream<EncodedFrameLike>({ start(c) { ctrl = c; } }),
    writable: new WritableStream<EncodedFrameLike>({ write(f) { written.push(new Uint8Array(f.data)); }, abort() { aborted = true; } }),
    push: (f) => ctrl.enqueue(f),
    written,
    aborted: () => aborted,
  };
}

const frame = (bytes: number[], mimeType?: string): EncodedFrameLike => ({ data: Uint8Array.from(bytes).buffer, getMetadata: () => ({ synchronizationSource: 1, spatialIndex: 0, mimeType }) });
const poisoned = (): EncodedFrameLike => ({ data: Uint8Array.of(0xfc).buffer, getMetadata: () => { throw new Error('metadata gone'); } });
const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };

const encOpts = (trackId = 'tx-mic'): DillaTransformOptions => ({ dilla: 1, side: 'encode', trackId, participantIdentity: DEV_A, slot: 0, codec: 'opus' });
const decOpts = (trackId = 'rx-1', slot: 0 | 1 = 0): DillaTransformOptions => ({ dilla: 1, side: 'decode', trackId, participantIdentity: '', slot, codec: slot === 0 ? 'opus' : 'vp8' });

describe('the dilla-media worker host (worker/index.ts)', () => {
  it('acks init once the wasm has loaded and ignores a second init', async () => {
    const { scope, host, loads } = start();
    await ready(scope, host);
    expect(scope.posted).toContainEqual({ kind: 'initAck', v: 1, scriptTransform: true });
    scope.send({ kind: 'init', v: 1, logLevel: 'debug', wasmUrl: 'other.wasm' });
    await host.settled();
    expect(loads).toHaveBeenCalledTimes(1);
    expect(scope.kinds().filter((k) => k === 'initAck')).toHaveLength(1);
  });

  it('a failed wasm load is a worker-wide E_WASM, with no initAck; every later message and attach fails closed', async () => {
    const { scope, host } = start(async () => { throw new Error('404'); });
    await ready(scope, host);
    expect(scope.posted).toContainEqual({ kind: 'error', code: 'E_WASM' });
    expect(scope.kinds()).not.toContain('initAck');
    installEpoch(scope);
    await host.settled();
    expect(scope.posted.filter((m) => m.kind === 'error' && m.code === 'E_WASM')).toHaveLength(2);
    const p = pipe();
    scope.send({ kind: 'attach', data: { ...encOpts(), readable: p.readable, writable: p.writable } });
    await host.settled();
    p.push(frame([0xfc, 1], 'audio/opus'));
    await flush();
    expect(p.written).toEqual([]);
    const t = pipe();
    scope.onrtctransform?.({ transformer: { options: encOpts('tx-2'), readable: t.readable, writable: t.writable } });
    t.push(frame([0xfc, 2], 'audio/opus'));
    await flush();
    expect(t.written).toEqual([]);
  });

  it('ignores every message that is not dilla-media/1 and keeps working', async () => {
    const { scope, host } = start();
    await ready(scope, host);
    const before = scope.posted.length;
    for (const m of [
      { kind: 'setKey', key: new Uint8Array(16) }, { kind: 'enable', enabled: false }, { kind: 'ratchetRequest' },
      { kind: 'encode', readableStream: null }, { kind: 'setSifTrailer', data: new Uint8Array(44) }, { kind: 'nope' },
      { kind: 'attach', data: { dilla: 1, side: 'encode', trackId: 'x' } }, 42, null, 'clearKeys',
    ]) scope.send(m);
    await host.settled();
    const added = scope.posted.slice(before);
    expect(added.every((m) => m.kind === 'log' && m.level === 'debug')).toBe(true);
    expect(added).toHaveLength(10);
    installEpoch(scope);
    await host.settled();
    expect(scope.kinds()).toContain('epochInstalled');
  });

  it('wires transferred streams: encrypts, keeps the stream alive past a frame the pipeline throws on, and never writes that frame', async () => {
    const { scope, host } = start();
    await ready(scope, host);
    installEpoch(scope);
    const p = pipe();
    scope.send({ kind: 'attach', data: { ...encOpts(), readable: p.readable, writable: p.writable } });
    await host.settled();
    expect(scope.posted).toContainEqual({ kind: 'attached', trackId: 'tx-mic', side: 'encode' });
    p.push(frame([0xfc, 1], 'audio/opus'));
    p.push(poisoned());
    p.push(frame([0xfc, 2], 'audio/opus'));
    await flush();
    expect(p.written).toEqual([Uint8Array.of(0xee, 0xfc, 1), Uint8Array.of(0xee, 0xfc, 2)]);
    expect(p.aborted()).toBe(false);
    expect(host.pipeline()?.stats.dropped.internal).toBe(1);
  });

  it('retarget and detach reach the handle of transferred streams', async () => {
    const { scope, host } = start();
    await ready(scope, host);
    installEpoch(scope);
    const p = pipe();
    scope.send({ kind: 'attach', data: { ...decOpts('rx-1'), readable: p.readable, writable: p.writable } });
    scope.send({ kind: 'retarget', data: { previousTrackId: 'rx-1', ...decOpts('rx-2') } });
    scope.send({ kind: 'mapTrack', trackId: 'rx-2', participantIdentity: DEV_A, slot: 0, codec: 'opus', encryption: 1 });
    await host.settled();
    p.push(frame([0xee, 0xfc, 5]));
    await flush();
    expect(p.written).toEqual([Uint8Array.of(0xfc, 5)]);
    scope.send({ kind: 'detach', trackId: 'rx-2' });
    await host.settled();
    p.push(frame([0xee, 0xfc, 6]));
    await flush();
    expect(p.written).toHaveLength(1); // unmapped again: held, never rendered
    expect(host.pipeline()?.stats.decrypted).toBeDefined();
  });

  it('blocks a transferred pair attached with block options', async () => {
    const { scope, host } = start();
    await ready(scope, host);
    installEpoch(scope);
    const p = pipe();
    scope.send({ kind: 'attach', data: { dilla: 1, side: 'encode', trackId: 'tx-x', block: true, readable: p.readable, writable: p.writable } });
    await host.settled();
    p.push(frame([0xfc, 1], 'audio/opus'));
    await flush();
    expect(p.written).toEqual([]);
    expect(host.pipeline()?.stats.dropped.blocked).toBe(1);
  });

  it('on the script path: wires dilla options, blocks block options and blocks options it does not recognise', async () => {
    const { scope, host } = start();
    await ready(scope, host);
    installEpoch(scope);
    const ok = pipe();
    const blocked = pipe();
    const foreign = pipe();
    scope.onrtctransform?.({ transformer: { options: encOpts('tx-1'), readable: ok.readable, writable: ok.writable } });
    scope.onrtctransform?.({ transformer: { options: { dilla: 1, side: 'encode', trackId: 'tx-2', block: true }, readable: blocked.readable, writable: blocked.writable } });
    scope.onrtctransform?.({ transformer: { options: { kind: 'encode', participantIdentity: DEV_A, trackId: 'tx-3' }, readable: foreign.readable, writable: foreign.writable } });
    for (const p of [ok, blocked, foreign]) p.push(frame([0xfc, 1], 'audio/opus'));
    await flush();
    expect(ok.written).toEqual([Uint8Array.of(0xee, 0xfc, 1)]);
    expect(blocked.written).toEqual([]);
    expect(foreign.written).toEqual([]);
    expect(host.pipeline()?.stats.dropped.blocked).toBe(2);
    expect(scope.posted.some((m) => m.kind === 'error' && m.code === 'E_BAD_OPTIONS')).toBe(true);
  });

  it('queues script transforms that arrive before init and wires them after it; asks key frames only for video receivers', async () => {
    const { scope, host } = start();
    const audio = pipe();
    const video = pipe();
    const sendAudio = vi.fn(async () => undefined);
    const sendVideo = vi.fn(async () => undefined);
    scope.onrtctransform?.({ transformer: { options: decOpts('rx-a', 0), readable: audio.readable, writable: audio.writable, sendKeyFrameRequest: sendAudio } });
    scope.onrtctransform?.({ transformer: { options: decOpts('rx-v', 1), readable: video.readable, writable: video.writable, sendKeyFrameRequest: sendVideo } });
    expect(scope.kinds()).not.toContain('attached');
    await ready(scope, host);
    installEpoch(scope);
    scope.send({ kind: 'mapTrack', trackId: 'rx-a', participantIdentity: DEV_A, slot: 0, codec: 'opus', encryption: 1 });
    scope.send({ kind: 'mapTrack', trackId: 'rx-v', participantIdentity: DEV_A, slot: 1, codec: 'vp8', encryption: 1 });
    await host.settled();
    expect(scope.posted.filter((m) => m.kind === 'attached')).toHaveLength(2);
    audio.push(frame([0x00, 1])); // fails the tag: dropped
    video.push(frame([0x00, 1]));
    await flush();
    expect(audio.written).toEqual([]);
    expect(video.written).toEqual([]);
    expect(sendAudio).not.toHaveBeenCalled();
    expect(sendVideo).toHaveBeenCalledTimes(1);
  });
});

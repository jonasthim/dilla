import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Track, type AudioProcessorOptions } from 'livekit-client';
// A plain .mjs build script without declarations. ts-ignore, not ts-expect-error: whether tsc reports
// TS7016 on the next line depends on whether task 1's tsconfig includes test/.
// @ts-ignore
import { DATA_URI_PREFIX, extractRnnoiseWasm, rnnoiseSyncPath } from '../scripts/extract-rnnoise-wasm.mjs';
import { VoiceGate } from '../src/audio/gate';
import { DillaRnnoiseProcessor } from '../src/audio/rnnoise';

describe('the build-time wasm extraction (DEV-37)', () => {
  it('extracts exactly the wasm inlined in rnnoise-sync.js', () => {
    const source = readFileSync(rnnoiseSyncPath(), 'utf8');
    const { bytes, sha256 } = extractRnnoiseWasm(source) as { bytes: Buffer; sha256: string };
    expect(bytes.length).toBe(1_440_118);
    expect([...bytes.subarray(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d]); // "\0asm"
    const start = source.lastIndexOf(DATA_URI_PREFIX) + DATA_URI_PREFIX.length;
    const b64 = /^[A-Za-z0-9+/=]+/.exec(source.slice(start))![0];
    // 1 920 160 base64 characters (the whole line 268 is 1 920 217 with the code around the URI).
    expect(b64.length).toBe(1_920_160);
    expect(sha256).toBe(createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex'));
  });

  it('refuses a source without the data URI', () => {
    expect(() => extractRnnoiseWasm('export default 1;')).toThrow('no data:application/octet-stream;base64, URI');
  });
});

describe('the VAD/PTT gate', () => {
  it('open passes everything', () => {
    const g = new VoiceGate({ mode: 'open' });
    expect(g.update(0, 0)).toBe(true);
  });

  it('vad opens above openAt, holds for holdMs below closeAt, then closes', () => {
    const g = new VoiceGate({ mode: 'vad', openAt: 0.6, closeAt: 0.3, holdMs: 300 });
    expect(g.update(0.1, 0)).toBe(false);
    expect(g.update(0.9, 10)).toBe(true);
    expect(g.update(0.45, 20)).toBe(true); // between the thresholds: stays open
    expect(g.update(0.1, 100)).toBe(true); // inside the hold
    expect(g.update(0.1, 400)).toBe(true);
    expect(g.update(0.1, 401)).toBe(false);
  });

  it('ptt follows the key and ignores VAD', () => {
    const g = new VoiceGate({ mode: 'ptt' });
    expect(g.update(1, 0)).toBe(false);
    g.setPtt(true);
    expect(g.update(0, 1)).toBe(true);
    g.setPtt(false);
    expect(g.update(1, 2)).toBe(false);
  });
});

class FakePort {
  sent: unknown[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  postMessage(m: unknown) {
    this.sent.push(m);
  }
}
class FakeNode {
  readonly port = new FakePort();
  connected: unknown[] = [];
  constructor(readonly ctx: unknown, readonly name: string, readonly options: AudioWorkletNodeOptions) {}
  connect(n: unknown) {
    this.connected.push(n);
    return n;
  }
  disconnect() {}
}

function fakeContext() {
  const processed = { id: 'processed-1', kind: 'audio' };
  const ctx = {
    closed: false,
    modules: [] as string[],
    sources: [] as Array<{ stream: unknown; disconnected: boolean }>,
    audioWorklet: { addModule: async (url: string) => void ctx.modules.push(url) },
    resume: async () => {},
    close: async () => void (ctx.closed = true),
    createMediaStreamSource(stream: unknown) {
      const s = { stream, disconnected: false, connect: (n: unknown) => n, disconnect: () => void (s.disconnected = true) };
      ctx.sources.push(s);
      return s;
    },
    createMediaStreamDestination() {
      return { channelCount: 2, stream: { getAudioTracks: () => [processed] } };
    },
  };
  return ctx;
}

describe('DillaRnnoiseProcessor', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubAudioGlobals() {
    vi.stubGlobal('AudioWorkletNode', FakeNode);
    vi.stubGlobal('MediaStream', class { constructor(readonly tracks: unknown[]) {} });
  }

  it('owns its own context and never touches the room context (G40 a)', async () => {
    stubAudioGlobals();
    const ctx = fakeContext();
    const touched: PropertyKey[] = [];
    const roomContext = new Proxy({}, { get: (_t, key) => void touched.push(key) });
    const p = new DillaRnnoiseProcessor({
      createContext: () => ctx as unknown as AudioContext,
      workletUrl: '/w.js',
      wasmUrl: '/r.wasm',
      fetchWasm: async () => new Uint8Array([0, 1, 2, 3]).buffer,
    });
    await p.init({ kind: Track.Kind.Audio, track: { id: 'mic-1' } as MediaStreamTrack, audioContext: roomContext as AudioContext } as AudioProcessorOptions);
    expect(touched).toEqual([]);
    expect(ctx.modules).toEqual(['/w.js']);
    expect(p.processedTrack?.id).toBe('processed-1');
  });

  it('the default context is 48 kHz interactive', async () => {
    stubAudioGlobals();
    const made: AudioContextOptions[] = [];
    vi.stubGlobal('AudioContext', class {
      constructor(o: AudioContextOptions) {
        made.push(o);
        return fakeContext();
      }
    });
    const p = new DillaRnnoiseProcessor({ workletUrl: '/w.js', wasmUrl: '/r.wasm', fetchWasm: async () => new ArrayBuffer(4) });
    await p.init({ kind: Track.Kind.Audio, track: { id: 'mic-1' } as MediaStreamTrack } as AudioProcessorOptions);
    expect(made).toEqual([{ sampleRate: 48_000, latencyHint: 'interactive' }]);
  });

  it('the worklet node and the destination are mono (SP-09)', async () => {
    stubAudioGlobals();
    const ctx = fakeContext();
    const p = new DillaRnnoiseProcessor({ createContext: () => ctx as unknown as AudioContext, workletUrl: '/w.js', wasmUrl: '/r.wasm', fetchWasm: async () => new ArrayBuffer(4) });
    await p.init({ kind: Track.Kind.Audio, track: { id: 'mic-1' } as MediaStreamTrack } as AudioProcessorOptions);
    const node = (p as unknown as { node: FakeNode }).node;
    expect(node.name).toBe('dilla-rnnoise-gate');
    expect(node.options).toMatchObject({ channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1] });
    const dest = (p as unknown as { dest: { channelCount: number } }).dest;
    expect(dest.channelCount).toBe(1);
  });

  it('a wasm that does not compile here is handed over as bytes, never decoded in the worklet from base64', async () => {
    stubAudioGlobals();
    const ctx = fakeContext();
    const p = new DillaRnnoiseProcessor({ createContext: () => ctx as unknown as AudioContext, workletUrl: '/w.js', wasmUrl: '/r.wasm', fetchWasm: async () => new Uint8Array([1, 2, 3]).buffer });
    await p.init({ kind: Track.Kind.Audio, track: { id: 'mic-1' } as MediaStreamTrack } as AudioProcessorOptions);
    const node = (p as unknown as { node: FakeNode }).node;
    expect(node.port.sent).toEqual([{ kind: 'bytes', bytes: expect.any(ArrayBuffer) }]);
  });

  it('restart swaps only the source; processedTrack keeps its identity', async () => {
    stubAudioGlobals();
    const ctx = fakeContext();
    const p = new DillaRnnoiseProcessor({ createContext: () => ctx as unknown as AudioContext, workletUrl: '/w.js', wasmUrl: '/r.wasm', fetchWasm: async () => new ArrayBuffer(4) });
    await p.init({ kind: Track.Kind.Audio, track: { id: 'mic-1' } as MediaStreamTrack } as AudioProcessorOptions);
    const before = p.processedTrack;
    await p.restart({ track: { id: 'mic-2' } as MediaStreamTrack, kind: Track.Kind.Audio });
    expect(p.processedTrack).toBe(before);
    expect(ctx.sources).toHaveLength(2);
    expect(ctx.sources[0].disconnected).toBe(true);
    expect(ctx.modules).toEqual(['/w.js']); // no second addModule
  });

  it('PTT and VAD go through the worklet port; destroy closes the context', async () => {
    stubAudioGlobals();
    const ctx = fakeContext();
    const p = new DillaRnnoiseProcessor({ mode: 'ptt', createContext: () => ctx as unknown as AudioContext, workletUrl: '/w.js', wasmUrl: '/r.wasm', fetchWasm: async () => new ArrayBuffer(4) });
    await p.init({ kind: Track.Kind.Audio, track: { id: 'mic-1' } as MediaStreamTrack } as AudioProcessorOptions);
    const node = (p as unknown as { node: FakeNode }).node;
    const seen: number[] = [];
    p.onVad((v) => seen.push(v));
    node.port.onmessage!({ data: { kind: 'vad', p: 0.75 } } as MessageEvent);
    p.setPttActive(true);
    expect(seen).toEqual([0.75]);
    expect(node.port.sent).toContainEqual({ kind: 'ptt', active: true });
    await p.destroy();
    expect(node.port.sent).toContainEqual({ kind: 'destroy' });
    expect(ctx.closed).toBe(true);
  });
});

it('the worklet reports an RNNoise factory failure instead of leaving probe pending', async () => {
  const reports: Array<{ kind: string; compiled: boolean; error: string | null }> = [];
  let Processor: new (opts: unknown) => { port: { onmessage: ((e: MessageEvent) => void) | null } };
  vi.stubGlobal('AudioWorkletProcessor', class {
    port = { onmessage: null as ((e: MessageEvent) => void) | null, postMessage: (m: typeof reports[number]) => reports.push(m) };
  });
  vi.stubGlobal('registerProcessor', (_name: string, ctor: typeof Processor) => { Processor = ctor; });
  try {
    await import('../src/audio/rnnoise-worklet');
    const worklet = new Processor!({ processorOptions: { mode: 'open' } });
    const emptyWasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
    worklet.port.onmessage!({ data: { kind: 'bytes', bytes: emptyWasm.buffer } } as MessageEvent);
    await vi.waitFor(() => expect(reports.some((r) => r.error)).toBe(true));
    expect(reports.at(-1)).toMatchObject({ kind: 'probe', compiled: false, error: expect.any(String) });
  } finally {
    vi.unstubAllGlobals();
  }
});

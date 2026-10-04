/// <reference types="vite/client" />
import type { AudioProcessorOptions, Track, TrackProcessor } from 'livekit-client';
import type { GateMode } from './gate';

export interface RnnoiseProbe {
  atob: string;
  ctorMs: number;
  compiled: boolean;
  error: string | null;
}

export interface RnnoiseProcessorOptions {
  mode?: GateMode;
  /** Test seam; the default is a private 48 kHz interactive context (G40 a). */
  createContext?: () => AudioContext;
  workletUrl?: string;
  wasmUrl?: string;
  fetchWasm?: (url: string) => Promise<ArrayBuffer>;
}

const defaultWorkletUrl = async (): Promise<string> => (await import('./rnnoise-worklet.ts?worker&url')).default;
const defaultWasmUrl = async (): Promise<string> => (await import('./generated/rnnoise.wasm?url')).default;
const defaultFetch = async (url: string): Promise<ArrayBuffer> => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`E_WASM: ${url} answered ${r.status}`);
  return r.arrayBuffer();
};

/**
 * RNNoise plus the VAD/PTT gate as a livekit-client audio processor (DEV-36, DEV-37). It owns its
 * audio graph: livekit never requires a processor to use `opts.audioContext`, and `restart()` is
 * called without one, so the processor keeps one private `AudioContext({sampleRate: 48000})` — the
 * rate RNNoise is trained at — and swaps only the source node on `restart()`, keeping
 * `processedTrack` the same object so the sender's `replaceTrack` target never changes. Attach it with
 * `LocalAudioTrack.setProcessor` only after `publishTrack`; a capture-time processor throws in 2.22.3.
 */
export class DillaRnnoiseProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = 'dilla-rnnoise' as const;
  processedTrack?: MediaStreamTrack;
  private ctx?: AudioContext;
  private node?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private dest?: MediaStreamAudioDestinationNode;
  private readonly vadListeners: Array<(p: number) => void> = [];
  private lastProbe: RnnoiseProbe | null = null;
  private probeWaiters: Array<(p: RnnoiseProbe) => void> = [];

  constructor(private readonly opts: RnnoiseProcessorOptions = {}) {}

  async init(opts: AudioProcessorOptions): Promise<void> {
    const ctx = (this.opts.createContext ?? (() => new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' })))();
    this.ctx = ctx;
    await ctx.resume();
    await ctx.audioWorklet.addModule(this.opts.workletUrl ?? (await defaultWorkletUrl()));
    const node = new AudioWorkletNode(ctx, 'dilla-rnnoise-gate', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      processorOptions: { mode: this.opts.mode ?? 'open' },
    });
    node.port.onmessage = (e: MessageEvent) => this.onWorklet(e.data as { kind: string; p?: number } & RnnoiseProbe);
    this.node = node;
    const bytes = await (this.opts.fetchWasm ?? defaultFetch)(this.opts.wasmUrl ?? (await defaultWasmUrl()));
    // A WebAssembly.Module did not reach Chromium's AudioWorklet port (NV-11). Compile bytes
    // asynchronously in the worklet while its unloaded path passes audio through.
    node.port.postMessage({ kind: 'bytes', bytes }, [bytes]);
    // Keep the destination mono. SP-09 measured that Chromium's source channel count can still
    // determine its stereo decision, independent of this destination setting.
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 1;
    this.dest = dest;
    this.connectSource(opts.track);
    node.connect(dest);
    this.processedTrack = dest.stream.getAudioTracks()[0];
  }

  async restart(opts: { track: MediaStreamTrack; kind: Track.Kind.Audio }): Promise<void> {
    this.source?.disconnect();
    this.connectSource(opts.track);
  }

  async destroy(): Promise<void> {
    this.node?.port.postMessage({ kind: 'destroy' });
    this.source?.disconnect();
    this.node?.disconnect();
    await this.ctx?.close();
    this.ctx = undefined;
  }

  setPttActive(active: boolean): void {
    this.node?.port.postMessage({ kind: 'ptt', active });
  }

  onVad(cb: (probability: number) => void): void {
    this.vadListeners.push(cb);
  }

  /** Resolves with the worklet's report once the module is loaded or has failed (SP-35). */
  probe(timeoutMs = 10_000): Promise<RnnoiseProbe> {
    if (this.lastProbe && (this.lastProbe.compiled || this.lastProbe.error)) return Promise.resolve(this.lastProbe);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the RNNoise worklet reported nothing')), timeoutMs);
      this.probeWaiters.push((p) => {
        clearTimeout(timer);
        resolve(p);
      });
    });
  }

  private connectSource(track: MediaStreamTrack): void {
    const ctx = this.ctx!;
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    source.connect(this.node!);
    this.source = source;
  }

  private onWorklet(d: { kind: string; p?: number } & RnnoiseProbe): void {
    if (d.kind === 'vad' && typeof d.p === 'number') {
      for (const cb of this.vadListeners) cb(d.p);
      return;
    }
    if (d.kind !== 'probe') return;
    const ctorMs = this.lastProbe?.ctorMs ?? d.ctorMs;
    this.lastProbe = { atob: d.atob, ctorMs, compiled: d.compiled, error: d.error };
    if (d.compiled || d.error) {
      for (const w of this.probeWaiters.splice(0)) w(this.lastProbe);
    }
  }
}

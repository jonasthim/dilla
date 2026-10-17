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
  denoise?: boolean;
  allowed?: boolean;
  onFailure?: (reason: string) => void;
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
const INIT_TIMEOUT_MS = 10_000;
function bounded<T>(promise: Promise<T>, step: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`E_AUDIO_TIMEOUT: ${step}`)), INIT_TIMEOUT_MS);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (err: unknown) => { clearTimeout(timer); reject(err); });
  });
}

/**
 * RNNoise plus the VAD/PTT gate as a livekit-client audio processor (DEV-36, DEV-37). It owns its
 * audio graph: livekit never requires a processor to use `opts.audioContext`, and `restart()` is
 * called without one, so the processor keeps one private `AudioContext({sampleRate: 48000})` — the
 * rate RNNoise is trained at — and swaps only the source node on `restart()`, keeping
 * `processedTrack` the same object so the sender's `replaceTrack` target never changes. Attach it with
 * `LocalAudioTrack.setProcessor` only after `publishTrack`; a capture-time processor throws in 2.22.3.
 * Call setProcessor under user activation so the private AudioContext can resume.
 */
export class DillaRnnoiseProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = 'dilla-rnnoise' as const;
  processedTrack?: MediaStreamTrack;
  private ctx?: AudioContext;
  private destroying?: Promise<void>;
  private readonly closing = new WeakMap<AudioContext, Promise<void>>();
  private allowed: boolean;
  private mode: GateMode;
  private generation = 0;
  private bypass = false;
  private node?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private dest?: MediaStreamAudioDestinationNode;
  private readonly vadListeners: Array<(p: number) => void> = [];
  private lastProbe: RnnoiseProbe | null = null;
  private probeWaiters: Array<(p: RnnoiseProbe) => void> = [];

  constructor(private readonly opts: RnnoiseProcessorOptions = {}) { this.allowed = opts.allowed ?? true; this.mode = opts.mode ?? 'open'; }

  async init(opts: AudioProcessorOptions): Promise<void> {
    this.destroying = undefined;
    this.lastProbe = null;
    const generation = ++this.generation;
    const current = () => { if (generation !== this.generation) throw new Error('E_AUDIO_CANCELLED'); };
    const ctx = (this.opts.createContext ?? (() => new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' })))();
    this.ctx = ctx;
    try {
    await bounded(ctx.resume(), 'resume');
    current();
    ctx.onstatechange = () => {
      if (ctx.state === 'suspended') {
        this.opts.onFailure?.('audio-suspended');
        void bounded(ctx.resume(), 'resume').catch(() => undefined);
      }
    };
    await bounded(ctx.audioWorklet.addModule(this.opts.workletUrl ?? (await bounded(defaultWorkletUrl(), 'worklet URL'))), 'addModule');
    current();
    const node = new AudioWorkletNode(ctx, 'dilla-rnnoise-gate', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      processorOptions: { mode: this.mode, denoise: this.opts.denoise ?? true, allowed: this.allowed },
    });
    node.port.onmessage = (e: MessageEvent) => this.onWorklet(e.data as { kind: string; p?: number } & RnnoiseProbe);
    this.node = node;
    node.onprocessorerror = () => this.opts.onFailure?.('processor-error');
    const bytes = await bounded((this.opts.fetchWasm ?? defaultFetch)(this.opts.wasmUrl ?? (await bounded(defaultWasmUrl(), 'wasm URL'))), 'fetch wasm');
    current();
    // The Module handoff stalled in Chromium 153 headless (NV-11); the cause was not isolated.
    // Compile bytes asynchronously while the unloaded worklet passes audio through.
    node.port.postMessage({ kind: 'bytes', bytes }, [bytes]);
    // Keep the destination mono. SP-09 measured that Chromium's source channel count can still
    // determine its stereo decision, independent of this destination setting.
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 1;
    this.dest = dest;
    this.connectSource(opts.track);
    node.connect(dest);
    this.processedTrack = dest.stream.getAudioTracks()[0];
    const probe = await this.probe(INIT_TIMEOUT_MS);
    current();
    if (!probe.compiled) throw new Error(probe.error ?? 'E_WASM: RNNoise did not compile');
    } catch (err) {
      ctx.onstatechange = null;
      this.node?.port.postMessage({ kind: 'destroy' });
      this.source?.disconnect();
      this.node?.disconnect();
      await bounded(this.closeContext(ctx), 'close').catch(() => undefined);
      throw err;
    }
  }

  async restart(opts: { track: MediaStreamTrack; kind: Track.Kind.Audio }): Promise<void> {
    if (this.destroying) return this.destroying;
    this.node?.port.postMessage({ kind: 'flush' });
    this.source?.disconnect();
    this.connectSource(opts.track);
  }

  destroy(): Promise<void> {
    if (this.destroying) return this.destroying;
    this.generation++;
    const ctx = this.ctx;
    if (ctx) ctx.onstatechange = null;
    this.lastProbe = null;
    this.node?.port.postMessage({ kind: 'destroy' });
    this.source?.disconnect();
    this.node?.disconnect();
    this.processedTrack?.stop?.();
    this.processedTrack = undefined;
    this.destroying = ctx ? this.closeContext(ctx) : Promise.resolve();
    return this.destroying;
  }

  /** Startup cancellation and track teardown can both own a pending close. */
  private closeContext(ctx: AudioContext): Promise<void> {
    const existing = this.closing.get(ctx);
    if (existing) return existing;
    if (this.ctx === ctx) this.ctx = undefined;
    ctx.onstatechange = null;
    const closing = Promise.resolve().then(() => ctx.state === 'closed' ? undefined : ctx.close());
    this.closing.set(ctx, closing);
    return closing;
  }

  useBrowserFallback(): void {
    this.bypass = true;
    this.node?.port.postMessage({ kind: 'destroy' });
    this.source?.disconnect(); this.node?.disconnect();
    if (this.source && this.dest) this.source.connect(this.dest);
  }

  setCaptureAllowed(allowed: boolean): void {
    if (this.allowed === allowed) return;
    this.allowed = allowed;
    this.node?.port.postMessage({ kind: 'capture', allowed });
  }

  setMode(mode: GateMode): void { this.mode = mode; this.node?.port.postMessage({ kind: 'mode', mode }); }

  flush(): void { this.node?.port.postMessage({ kind: 'flush' }); }

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
      const waiter = (p: RnnoiseProbe) => {
        clearTimeout(timer);
        resolve(p);
      };
      const timer = setTimeout(() => {
        this.probeWaiters = this.probeWaiters.filter((w) => w !== waiter);
        reject(new Error('the RNNoise worklet reported nothing'));
      }, timeoutMs);
      this.probeWaiters.push(waiter);
    });
  }

  private connectSource(track: MediaStreamTrack): void {
    const ctx = this.ctx!;
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    source.connect(this.bypass ? this.dest! : this.node!);
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

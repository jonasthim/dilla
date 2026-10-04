// The dilla RNNoise + gate AudioWorklet (DEV-36, DEV-37). It never decodes base64 and never compiles
// synchronously: the main thread hands it raw bytes, which it compiles asynchronously while passing
// audio through. The emscripten factory's own
// `instantiateWasm` hook instantiates the module, so the 1.92 MB data URI inside rnnoise-sync.js is
// never read.
// @ts-ignore -- @jitsi/rnnoise-wasm 0.2.1 ships no type declarations (no "types", no "exports")
import createRNNWasmModuleSync from '@jitsi/rnnoise-wasm/dist/rnnoise-sync.js';
import { VoiceGate, type GateMode } from './gate';

declare const currentTime: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

interface RnnoiseModule {
  HEAPF32: Float32Array;
  _rnnoise_create(model: number): number;
  _rnnoise_destroy(state: number): void;
  _rnnoise_process_frame(state: number, out: number, input: number): number;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
}
type Factory = (opts: { instantiateWasm: (info: WebAssembly.Imports, receive: (i: WebAssembly.Instance, m: WebAssembly.Module) => void) => WebAssembly.Exports }) => RnnoiseModule;

const FRAME = 480; // RNNoise FRAME_SIZE: 10 ms at 48 kHz
const QUANTUM = 128;
const RING = 1920; // lcm(128, 480)
const VAD_EVERY = 10; // post the voice probability every 100 ms

class DillaRnnoiseGate extends AudioWorkletProcessor {
  private m: RnnoiseModule | null = null;
  private state = 0;
  private buf = 0;
  private readonly gate: VoiceGate;
  private readonly inQ = new Float32Array(RING);
  private inLen = 0;
  private readonly outQ = new Float32Array(RING * 2);
  private outLen = 0;
  private frames = 0;
  private lastVad = 0;
  private stopped = false;

  constructor(options: { processorOptions?: { mode?: GateMode } }) {
    const t0 = Date.now();
    super();
    this.gate = new VoiceGate({ mode: options.processorOptions?.mode ?? 'open' });
    this.port.onmessage = (e: MessageEvent) => this.onMessage(e.data as { kind: string; module?: WebAssembly.Module; bytes?: ArrayBuffer; active?: boolean; mode?: GateMode });
    this.post({ kind: 'probe', atob: typeof (globalThis as { atob?: unknown }).atob, ctorMs: Date.now() - t0, compiled: false, error: null });
  }

  private post(m: unknown): void {
    this.port.postMessage(m);
  }

  private load(mod: WebAssembly.Module): void {
    try {
      const m = (createRNNWasmModuleSync as Factory)({
        instantiateWasm(info, receive) {
          const inst = new WebAssembly.Instance(mod, info);
          receive(inst, mod);
          return inst.exports;
        },
      });
      this.state = m._rnnoise_create(0);
      this.buf = m._malloc(FRAME * 4);
      this.m = m;
      this.post({ kind: 'probe', atob: typeof (globalThis as { atob?: unknown }).atob, ctorMs: 0, compiled: true, error: null });
    } catch (error) {
      this.post({ kind: 'probe', atob: typeof (globalThis as { atob?: unknown }).atob, ctorMs: 0, compiled: false, error: String(error) });
    }
  }

  private onMessage(d: { kind: string; module?: WebAssembly.Module; bytes?: ArrayBuffer; active?: boolean; mode?: GateMode }): void {
    switch (d.kind) {
      case 'module':
        if (d.module) this.load(d.module);
        break;
      case 'bytes':
        if (d.bytes) {
          WebAssembly.compile(d.bytes).then(
            (mod) => this.load(mod),
            (err: unknown) => this.post({ kind: 'probe', atob: typeof (globalThis as { atob?: unknown }).atob, ctorMs: 0, compiled: false, error: String(err) }),
          );
        }
        break;
      case 'ptt':
        this.gate.setPtt(d.active === true);
        break;
      case 'mode':
        if (d.mode) this.gate.setMode(d.mode);
        break;
      case 'destroy':
        if (this.m) {
          this.m._free(this.buf);
          this.m._rnnoise_destroy(this.state);
          this.m = null;
        }
        this.stopped = true;
        break;
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0][0];
    const input = inputs[0]?.[0];
    if (this.stopped) return false;
    if (!input) {
      out.fill(0);
      return true;
    }
    const m = this.m;
    if (!m) {
      // Not loaded yet: pass the mic through, still gated (PTT/open only; VAD has no probability yet).
      if (this.gate.update(1, currentTime * 1000)) out.set(input);
      else out.fill(0);
      return true;
    }
    this.inQ.set(input, this.inLen);
    this.inLen += input.length;
    while (this.inLen >= FRAME) {
      const base = this.buf >> 2;
      for (let i = 0; i < FRAME; i++) m.HEAPF32[base + i] = this.inQ[i] * 32768;
      const vad = m._rnnoise_process_frame(this.state, this.buf, this.buf);
      const open = this.gate.update(vad, currentTime * 1000);
      for (let i = 0; i < FRAME; i++) this.outQ[this.outLen + i] = open ? m.HEAPF32[base + i] / 32768 : 0;
      this.outLen += FRAME;
      this.inQ.copyWithin(0, FRAME, this.inLen);
      this.inLen -= FRAME;
      this.lastVad = vad;
      if (++this.frames % VAD_EVERY === 0) this.post({ kind: 'vad', p: this.lastVad });
    }
    if (this.outLen >= QUANTUM) {
      out.set(this.outQ.subarray(0, QUANTUM));
      this.outQ.copyWithin(0, QUANTUM, this.outLen);
      this.outLen -= QUANTUM;
    } else {
      out.fill(0); // the first ~10 ms while the first frame fills
    }
    return true;
  }
}

registerProcessor('dilla-rnnoise-gate', DillaRnnoiseGate);

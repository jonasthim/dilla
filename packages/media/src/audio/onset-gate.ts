import { VoiceGate, type GateMode } from './gate';
/** A constant two-frame delay (20 ms at 48 kHz) lets VAD release word beginnings without bursts. */
export class OnsetGate {
  private gate: VoiceGate;
  private readonly history = [new Float32Array(480), new Float32Array(480)];
  private readonly result = new Float32Array(480);
  private index = 0;
  constructor(private mode: GateMode) { this.gate = new VoiceGate({ mode }); }
  setMode(mode: GateMode): void { this.mode = mode; this.reset(); }
  setPtt(active: boolean): void { this.gate.setPtt(active); }
  reset(): void { this.history.forEach(b => b.fill(0)); this.result.fill(0); this.index = 0; this.gate = new VoiceGate({ mode: this.mode }); }
  process(pcm: Float32Array, probability: number, nowMs: number): Float32Array {
    const open = this.gate.update(probability, nowMs);
    if (this.mode !== 'vad') { if (open) this.result.set(pcm); else this.result.fill(0); return this.result; }
    if (open) this.result.set(this.history[this.index]); else this.result.fill(0);
    this.history[this.index].set(pcm); this.index = 1 - this.index;
    return this.result;
  }
}

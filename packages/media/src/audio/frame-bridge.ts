/** The only audio crossing the Worker boundary: one owned buffer, no shared memory. */
export interface AudioFrame { id: number; epoch: number; pcm: Float32Array; processingMs?: number; start?:number; discontinuity?:boolean }
export class FrameBridge {
  private epoch = 0;
  private allowed = false;
  private readonly pool: Array<{ id: number; pcm: Float32Array }>;
  private readonly flight = new Map<number, { epoch: number; at: number; start: number }>();
  private readonly output: Array<AudioFrame & { start: number }> = [];
  private readonly input: Float32Array;
  private inputLength = 0;
  private inputStart = 0;
  private nextInputStart: number | null = null;
  private outputOffset = 0;
  private samples = 0;
  private captureStart: number | null = null;
  private delay = 0;
  readonly stats = { buffers: 0, underruns: 0, dropped: 0, privacyDiscarded: 0, processingMs: 0, frames: 0, processingHistogram: Array<number>(32).fill(0), maxRoundTripSamples: 0, roundTrips: [0,0,0,0,0,0,0] };
  constructor(private readonly send: (frame: AudioFrame) => void, readonly frameSize = 480, private readonly onReset: (epoch:number) => void = () => {}) {
    this.input = new Float32Array(frameSize);
    this.pool = Array.from({ length: 4 }, (_, id) => ({ id, pcm: new Float32Array(frameSize) }));
  }
  setAllowed(allowed: boolean): void {
    if (allowed === this.allowed) return;
    this.allowed = allowed; this.flush();
  }
  flush(): void {
    this.epoch++; this.input.fill(0); this.inputLength = 0; this.nextInputStart = null; this.outputOffset = 0; this.captureStart = null;
    for (const frame of this.output.splice(0)) { frame.pcm.fill(0); this.pool.push(frame); }
    for (const frame of this.pool) frame.pcm.fill(0);
    this.onReset(this.epoch);
    // In-flight buffers remain owned by the worker. Reclaim them only when it returns them.
  }
  accept(frame: AudioFrame): void {
    const pending = this.flight.get(frame.id);
    if (!pending || pending.epoch !== frame.epoch || frame.pcm.length !== this.frameSize) return;
    this.flight.delete(frame.id);
    this.stats.processingMs += frame.processingMs ?? 0;
    this.stats.frames++;
    this.stats.processingHistogram[Math.min(31,Math.floor((frame.processingMs ?? 0)*2))]++;
    const age = this.samples - pending.at;
    this.stats.maxRoundTripSamples = Math.max(this.stats.maxRoundTripSamples, age);
    this.stats.roundTrips[Math.min(6, Math.floor(age / 480))]++;
    if (!this.allowed || frame.epoch !== this.epoch) {
      frame.pcm.fill(0); this.pool.push(frame); this.stats.privacyDiscarded++; return;
    }
    if (age > 2880) { // 60 ms maximum queued age
      frame.pcm.fill(0); this.pool.push(frame); this.stats.dropped++; return;
    }
    this.output.push({ ...frame, start: pending.start });
  }
  render(input: Float32Array | undefined, out: Float32Array): void {
    const now = this.samples;
    out.fill(0); this.samples += out.length;
    if (!this.allowed) return;
    if (this.captureStart === null && input?.length) {
      this.captureStart = now;
      // One frame to collect input, one for Worker scheduling, and the quantum containing
      // the last input sample. Without that remainder, 480/128 alignment creates periodic gaps.
      this.delay = (Math.ceil(this.frameSize * 2 / out.length) + 1) * out.length;
    }
    const started = this.captureStart !== null && now >= this.captureStart + this.delay;
    // Keep the capture/playout timeline fixed. Rebuffering after a stall would permanently
    // delay every later word. Missing samples stay silent and late samples are discarded.
    let wrote = 0;
    let missing = false;
    while (started && wrote < out.length && this.output.length) {
      const frame = this.output[0], target = now + wrote - this.delay;
      if (frame.start + this.frameSize <= target) {
        this.output.shift(); this.pool.push(frame); this.outputOffset = 0; this.stats.dropped++; continue;
      }
      if (frame.start > target) {
        wrote += Math.min(out.length - wrote, frame.start - target); missing = true; continue;
      }
      if (frame.start + this.outputOffset < target) {
        this.outputOffset = target - frame.start; this.stats.dropped++;
      }
      const count = Math.min(out.length - wrote, this.frameSize - this.outputOffset);
      out.set(frame.pcm.subarray(this.outputOffset, this.outputOffset + count), wrote);
      wrote += count; this.outputOffset += count;
      if (this.outputOffset === this.frameSize) { this.output.shift(); this.pool.push(frame); this.outputOffset = 0; }
    }
    this.stats.buffers++;
    if (started && (missing || wrote < out.length)) this.stats.underruns++;
    if (!input?.length) { this.input.fill(0); this.inputLength = 0; return; }
    for (let pos = 0; pos < input.length;) {
      if (this.inputLength === 0) this.inputStart = now + pos;
      const count = Math.min(this.frameSize - this.inputLength, input.length - pos);
      this.input.set(input.subarray(pos, pos + count), this.inputLength); this.inputLength += count; pos += count;
      if (this.inputLength !== this.frameSize) continue;
      this.inputLength = 0;
      const buffer = this.pool.pop();
      if (!buffer) { this.stats.dropped++; continue; }
      buffer.pcm.set(this.input);
      const frame = { ...buffer, epoch: this.epoch, discontinuity: this.nextInputStart !== null && this.inputStart !== this.nextInputStart };
      this.nextInputStart = this.inputStart + this.frameSize;
      this.flight.set(frame.id, { epoch: frame.epoch, at: this.samples, start: this.inputStart }); this.send(frame);
    }
  }
}

/** The only audio crossing the Worker boundary: one owned buffer, no shared memory. */
export interface AudioFrame { id: number; epoch: number; pcm: Float32Array; processingMs?: number }
export class FrameBridge {
  private epoch = 0;
  private allowed = false;
  private readonly pool: Array<{ id: number; pcm: Float32Array }>;
  private readonly flight = new Map<number, { epoch: number; at: number }>();
  private readonly output: AudioFrame[] = [];
  private readonly input: Float32Array;
  private inputLength = 0;
  private outputOffset = 0;
  private samples = 0;
  private started = false;
  readonly stats = { buffers: 0, underruns: 0, dropped: 0, processingMs: 0 };
  constructor(private readonly send: (frame: AudioFrame) => void, readonly frameSize = 480) {
    this.input = new Float32Array(frameSize);
    this.pool = Array.from({ length: 4 }, (_, id) => ({ id, pcm: new Float32Array(frameSize) }));
  }
  setAllowed(allowed: boolean): void {
    if (allowed === this.allowed) return;
    this.allowed = allowed; this.flush();
  }
  flush(): void {
    this.epoch++; this.input.fill(0); this.inputLength = 0; this.outputOffset = 0; this.started = false;
    for (const frame of this.output.splice(0)) { frame.pcm.fill(0); this.pool.push(frame); }
    // In-flight buffers remain owned by the worker. Reclaim them only when it returns them.
  }
  accept(frame: AudioFrame): void {
    const pending = this.flight.get(frame.id);
    if (!pending || pending.epoch !== frame.epoch || frame.pcm.length !== this.frameSize) return;
    this.flight.delete(frame.id);
    this.stats.processingMs += frame.processingMs ?? 0;
    if (!this.allowed || frame.epoch !== this.epoch || this.samples - pending.at > 2880) { // 60 ms maximum queued age
      frame.pcm.fill(0); this.pool.push(frame); this.stats.dropped++; return;
    }
    this.output.push(frame); this.started = true;
  }
  render(input: Float32Array | undefined, out: Float32Array): void {
    out.fill(0); this.samples += out.length;
    if (!this.allowed) return;
    // Consume before dispatch: even a synchronous test worker has the same one-quantum boundary.
    let wrote = 0;
    while (wrote < out.length && this.output.length) {
      const frame = this.output[0], count = Math.min(out.length - wrote, this.frameSize - this.outputOffset);
      out.set(frame.pcm.subarray(this.outputOffset, this.outputOffset + count), wrote);
      wrote += count; this.outputOffset += count;
      if (this.outputOffset === this.frameSize) { this.output.shift(); this.pool.push(frame); this.outputOffset = 0; }
    }
    this.stats.buffers++;
    if (this.started && wrote < out.length) this.stats.underruns++;
    if (!input) return;
    for (let pos = 0; pos < input.length;) {
      const count = Math.min(this.frameSize - this.inputLength, input.length - pos);
      this.input.set(input.subarray(pos, pos + count), this.inputLength); this.inputLength += count; pos += count;
      if (this.inputLength !== this.frameSize) continue;
      this.inputLength = 0;
      const buffer = this.pool.pop();
      if (!buffer) { this.stats.dropped++; continue; }
      buffer.pcm.set(this.input);
      const frame = { ...buffer, epoch: this.epoch };
      this.flight.set(frame.id, { epoch: frame.epoch, at: this.samples }); this.send(frame);
    }
  }
}

/** How the mic opens: always, on RNNoise's voice probability, or while the push-to-talk key is held. */
export type GateMode = 'open' | 'vad' | 'ptt';

/**
 * The gate the worklet applies per 10 ms RNNoise frame. VAD uses two thresholds and a hold so a
 * speaker's pauses between words do not chop the stream; PTT ignores VAD. No key binding exists in
 * this wave — `setPtt` is what client-core's binding will call.
 */
export class VoiceGate {
  private mode: GateMode;
  private readonly openAt: number;
  private readonly closeAt: number;
  private readonly holdMs: number;
  private ptt = false;
  private open = false;
  private silenceSince: number | null = null;

  constructor(opts: { mode?: GateMode; openAt?: number; closeAt?: number; holdMs?: number } = {}) {
    this.mode = opts.mode ?? 'open';
    this.openAt = opts.openAt ?? 0.6;
    this.closeAt = opts.closeAt ?? 0.3;
    this.holdMs = opts.holdMs ?? 300;
  }

  setMode(mode: GateMode): void {
    this.mode = mode;
  }

  setPtt(active: boolean): void {
    this.ptt = active;
  }

  update(vadProbability: number, nowMs: number): boolean {
    if (this.mode === 'open') return true;
    if (this.mode === 'ptt') return this.ptt;
    if (vadProbability >= this.openAt) {
      this.open = true;
      this.silenceSince = null;
    } else if (vadProbability >= this.closeAt) {
      this.silenceSince = null;
    } else if (this.open) {
      this.silenceSince ??= nowMs;
      if (nowMs - this.silenceSince > this.holdMs) this.open = false;
    }
    return this.open;
  }
}

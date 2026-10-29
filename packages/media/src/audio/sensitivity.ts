// Signal task 10b (README §5.9 Input sensitivity): the voice-activity gate on the input level in dB. It runs per 10 ms frame
// inside the input stage's AudioWorklet (so a background tab's throttled timers never hold it), and the same class drives
// the Settings meter's line during Let's check, so the line shows the threshold the call uses. Import-free: the worklet
// bundles it.

/** What the gate is told: off (push to talk, or nothing to gate), the automatic threshold, or a fixed one. */
export interface SensitivityConfig {
  /** False: the gate stays open (push to talk governs the microphone instead). */
  enabled: boolean;
  /** Automatic sensitivity: the threshold follows the room's noise floor. */
  auto: boolean;
  /** The manual threshold, −100..0 dB; ignored while `auto`. */
  thresholdDb: number;
}

export const SENSITIVITY = {
  minDb: -100,
  maxDb: 0,
  /** The automatic line before any room noise was measured (the prototype's resting −48 dB). */
  autoStartDb: -48,
  /** The automatic threshold sits this far above the noise floor… */
  autoMarginDb: 15,
  /** …but never below or above these: a dead-silent input still needs a voice, a loud room never needs a shout. */
  autoMinDb: -70,
  autoMaxDb: -30,
  /** The floor falls quickly to a quieter room and rises at most this fast, from frames below the threshold only. */
  floorRiseDbPerS: 2,
  floorFall: 0.1,
  /** Attack: one frame (10 ms) at or over the line opens the gate at once. Hold: it stays open this long after the
   *  last frame over the line, so pauses between words and soft word endings are not cut. */
  holdMs: 300,
  /** The stage's gain ramps (the worklet): open over 5 ms, close over 60 ms, so neither clicks. */
  attackRampMs: 5,
  releaseRampMs: 60,
  /** The stage delays the audio one frame, so the frame that opened the gate is sent from its start. */
  lookaheadMs: 10,
  frameMs: 10,
} as const;

export const DEFAULT_SENSITIVITY: SensitivityConfig = { enabled: true, auto: true, thresholdDb: -50 };

/** A frame's RMS (0..1 full scale) in dBFS, clamped to −100..0. */
export function dbOf(rms: number): number {
  if (!(rms > 0)) return SENSITIVITY.minDb;
  return Math.max(SENSITIVITY.minDb, Math.min(SENSITIVITY.maxDb, 20 * Math.log10(rms)));
}

const clampDb = (db: number): number => Math.max(SENSITIVITY.minDb, Math.min(SENSITIVITY.maxDb, db));

export class SensitivityGate {
  private cfg: SensitivityConfig;
  private floor: number | null = null;
  private open = false;
  private lastOverMs: number | null = null;
  private lastMs: number | null = null;

  constructor(cfg: SensitivityConfig = DEFAULT_SENSITIVITY) { this.cfg = { ...cfg, thresholdDb: clampDb(cfg.thresholdDb) }; }

  configure(cfg: SensitivityConfig): void { this.cfg = { ...cfg, thresholdDb: clampDb(cfg.thresholdDb) }; }

  /** The threshold in force: the manual one, or the automatic one from the measured floor. */
  threshold(): number {
    if (!this.cfg.auto) return this.cfg.thresholdDb;
    if (this.floor === null) return SENSITIVITY.autoStartDb;
    return Math.round(Math.max(SENSITIVITY.autoMinDb, Math.min(SENSITIVITY.autoMaxDb, this.floor + SENSITIVITY.autoMarginDb)));
  }

  /** One frame's level in dB at `nowMs`; true while the microphone may be heard. */
  update(db: number, nowMs: number): boolean {
    const dt = this.lastMs === null ? SENSITIVITY.frameMs : Math.max(0, nowMs - this.lastMs);
    this.lastMs = nowMs;
    const thr = this.threshold();
    // The floor learns only from frames under the line, so speech never raises it into the voice.
    if (db < thr) {
      if (this.floor === null || db < this.floor) this.floor = this.floor === null ? db : this.floor + (db - this.floor) * SENSITIVITY.floorFall;
      else this.floor = Math.min(db, this.floor + SENSITIVITY.floorRiseDbPerS * dt / 1000);
    }
    if (!this.cfg.enabled) { this.open = true; return true; }
    if (db >= thr) {
      this.open = true;
      this.lastOverMs = nowMs;
    } else if (this.open && (this.lastOverMs === null || nowMs - this.lastOverMs > SENSITIVITY.holdMs)) {
      this.open = false;
    }
    return this.open;
  }

  /** A mute or a new capture: closed, the hold forgotten (the floor is kept: it is the room's). */
  reset(): void { this.open = false; this.lastOverMs = null; this.lastMs = null; }
}

// web3.8 V1: who is speaking, computed in the page from local levels. The own microphone and each attached remote audio
// track get an AnalyserNode in the call's own AudioContext; the level is read after decryption, from what is played, and
// stays in the page (it reaches no worker, no log and no network). The SFU's speaker flag is the fallback only.

/** How often the session samples every meter. */
export const SPEAK_TICK_MS = 25;
/** A level at or above SPEAK_RMS for this long switches speaking on. */
export const SPEAK_ON_MS = 50;
/** A level below SPEAK_RMS for this long switches speaking off. */
export const SPEAK_HOLD_MS = 300;
/** The RMS (0..1) from which a track counts as voiced. */
export const SPEAK_RMS = 0.02;
/** A level change reaches the state at most this often (a speaking flip is published at once). */
export const LEVEL_PUBLISH_MS = 100;

/** On: rms >= SPEAK_RMS continuously for >= SPEAK_ON_MS. Off: below it continuously for >= SPEAK_HOLD_MS. */
export class SpeakingDetector {
  private on = false;
  /** Start of the run that could flip the state: above while off, below while on. */
  private since: number | null = null;

  update(rms: number, now: number): boolean {
    const voiced = rms >= SPEAK_RMS;
    if (voiced === this.on) {
      this.since = null;
      return this.on;
    }
    this.since ??= now;
    if (now - this.since >= (this.on ? SPEAK_HOLD_MS : SPEAK_ON_MS)) {
      this.on = voiced;
      this.since = null;
    }
    return this.on;
  }

  reset(): void {
    this.on = false;
    this.since = null;
  }
}

/** A reader of one audio track's level. */
export interface LevelMeter {
  /** The RMS of the latest samples, 0..1. */
  read(): number;
  close(): void;
}

/** An AnalyserNode on `track` in `ctx`. It is never connected to ctx.destination, so it adds no sound. Null where the
 *  browser refuses (no MediaStream, a closed context): the caller falls back to the SFU's flag. */
export function analyserMeter(ctx: AudioContext, track: MediaStreamTrack): LevelMeter | null {
  if (typeof MediaStream === 'undefined' || ctx.state === 'closed') return null;
  try {
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    return {
      read() {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const s of samples) sum += s * s;
        return Math.sqrt(sum / samples.length);
      },
      close() {
        try { source.disconnect(); } catch { /* already disconnected */ }
        try { analyser.disconnect(); } catch { /* already disconnected */ }
      },
    };
  } catch {
    return null;
  }
}

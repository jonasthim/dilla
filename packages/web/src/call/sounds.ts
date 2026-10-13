// Synthesised call sounds (L-WEB-52, brief § Sound, flow 06 § Sounds). No sound file ships: each sound is a few
// OscillatorNode tones, every one under 300 ms. Whether a sound may play at all (the settings, deafened, one's own
// join or leave, busy or quiet rings, user activation) is the caller's decision; this module only plays.

export type SoundKind = 'join' | 'leave';

export interface Sounds {
  play(kind: SoundKind): void;
  startRing(): void;
  stopRing(): void;
  dispose(): void;
}

/** A two-tone tick: 100 ms each, 20 ms apart, so the whole sound ends 220 ms after it starts. */
const TICK = { tone: 0.1, gap: 0.02 } as const;
const TICKS: Record<SoundKind, readonly [number, number]> = { join: [660, 880], leave: [880, 660] };
/** The ring: 2 × 120 ms pings at 1000 Hz, 40 ms apart, every 2 s, at most 15 times (30 s, R5). */
const RING = { hz: 1000, tone: 0.12, gap: 0.04, everyMs: 2_000, cycles: 15 } as const;
const PEAK = 0.2;
/** The attack and release ramps, so a tone starts and ends without a click. */
const EDGE = 0.005;

function tone(ctx: AudioContext, hz: number, at: number, length: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(hz, at);
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(PEAK, at + EDGE);
  gain.gain.setValueAtTime(PEAK, at + length - EDGE);
  gain.gain.linearRampToValueAtTime(0, at + length);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.onended = () => {
    osc.disconnect();
    gain.disconnect();
  };
  osc.start(at);
  osc.stop(at + length);
}

/** `getContext` is asked on every play, so the caller decides when an AudioContext exists (null: play nothing). */
export function createSounds(getContext: () => AudioContext | null): Sounds {
  let ring: ReturnType<typeof setInterval> | null = null;

  const usable = (): AudioContext | null => {
    const ctx = getContext();
    return ctx && ctx.state !== 'closed' ? ctx : null;
  };
  const ping = (): void => {
    const ctx = usable();
    if (!ctx) return;
    const t = ctx.currentTime;
    tone(ctx, RING.hz, t, RING.tone);
    tone(ctx, RING.hz, t + RING.tone + RING.gap, RING.tone);
  };
  const stopRing = (): void => {
    if (ring !== null) clearInterval(ring);
    ring = null;
  };

  return {
    play(kind) {
      const ctx = usable();
      if (!ctx) return;
      const t = ctx.currentTime;
      const [low, high] = TICKS[kind];
      tone(ctx, low, t, TICK.tone);
      tone(ctx, high, t + TICK.tone + TICK.gap, TICK.tone);
    },
    startRing() {
      stopRing();
      let cycles = 1;
      ping();
      ring = setInterval(() => {
        ping();
        cycles += 1;
        if (cycles >= RING.cycles) stopRing();
      }, RING.everyMs);
    },
    stopRing,
    dispose: stopRing,
  };
}

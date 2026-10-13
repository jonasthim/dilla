import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSounds } from './sounds.ts';

interface ToneRecord { frequency: number; type: string; startAt: number; stopAt: number }

/** A WebAudio double: each oscillator records its frequency and its start and stop times on the context's clock,
 * which follows Date.now() so fake timers move it. */
function fakeAudioContext(): AudioContext & { oscillators: ToneRecord[] } {
  const created = Date.now();
  const oscillators: ToneRecord[] = [];
  const param = (initial: number, onSet?: (v: number) => void) => {
    let value = initial;
    return {
      get value() { return value; },
      set value(v: number) { value = v; onSet?.(v); },
      setValueAtTime(v: number) { value = v; onSet?.(v); return this; },
      linearRampToValueAtTime(v: number) { value = v; return this; },
      exponentialRampToValueAtTime(v: number) { value = v; return this; },
      cancelScheduledValues() { return this; },
    };
  };
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  const ctx = {
    state: 'running',
    oscillators,
    destination: node(),
    get currentTime() { return (Date.now() - created) / 1000; },
    createOscillator() {
      const rec: ToneRecord = { frequency: 440, type: 'sine', startAt: Number.NaN, stopAt: Number.NaN };
      oscillators.push(rec);
      return {
        ...node(),
        get type() { return rec.type; },
        set type(t: string) { rec.type = t; },
        frequency: param(440, (v) => { rec.frequency = v; }),
        start(t = 0) { rec.startAt = t; },
        stop(t = 0) { rec.stopAt = t; },
        onended: null,
      };
    },
    createGain() { return { ...node(), gain: param(1) }; },
  };
  return ctx as unknown as AudioContext & { oscillators: ToneRecord[] };
}

afterEach(() => { vi.useRealTimers(); });

describe('sounds (L-WEB-52)', () => {
  it('sounds: join plays two rising tones under 300 ms in total; nothing without a context', () => {
    const ctx = fakeAudioContext();
    const s = createSounds(() => ctx);
    s.play('join');
    expect(ctx.oscillators.map((o) => o.frequency)).toEqual([660, 880]);
    expect(Math.max(...ctx.oscillators.map((o) => o.stopAt))).toBeLessThan(0.3);
    expect(() => createSounds(() => null).play('join')).not.toThrow();
  });

  it('leave plays the same two tones falling, also under 300 ms', () => {
    const ctx = fakeAudioContext();
    createSounds(() => ctx).play('leave');
    expect(ctx.oscillators.map((o) => o.frequency)).toEqual([880, 660]);
    expect(Math.max(...ctx.oscillators.map((o) => o.stopAt))).toBeLessThan(0.3);
  });

  it('the ring repeats every 2 s and stops on stopRing or after 30 s', () => {
    vi.useFakeTimers();
    const ctx = fakeAudioContext();
    const s = createSounds(() => ctx);

    s.startRing();
    expect(ctx.oscillators).toHaveLength(2);
    for (const o of ctx.oscillators) expect(o.frequency).toBe(1000);
    const [first, second] = ctx.oscillators;
    expect(first.startAt).toBeCloseTo(0, 6);
    expect(first.stopAt - first.startAt).toBeCloseTo(0.12, 6);
    expect(second.startAt - first.stopAt).toBeCloseTo(0.04, 6);
    expect(second.stopAt - second.startAt).toBeCloseTo(0.12, 6);

    vi.advanceTimersByTime(2_000);
    expect(ctx.oscillators).toHaveLength(4);
    s.stopRing();
    vi.advanceTimersByTime(10_000);
    expect(ctx.oscillators).toHaveLength(4);

    ctx.oscillators.length = 0;
    const startedAt = ctx.currentTime;
    s.startRing();
    vi.advanceTimersByTime(40_000);
    expect(ctx.oscillators).toHaveLength(30);
    for (const o of ctx.oscillators) expect(o.startAt - startedAt).toBeLessThan(30);
    s.dispose();
  });

  it('a suspended context schedules nothing, so nothing fires on a later resume', () => {
    vi.useFakeTimers();
    const ctx = fakeAudioContext();
    (ctx as unknown as { state: AudioContextState }).state = 'suspended';
    const s = createSounds(() => ctx);
    expect(() => { s.play('join'); s.play('leave'); s.startRing(); vi.advanceTimersByTime(10_000); }).not.toThrow();
    expect(ctx.oscillators).toHaveLength(0);
    // The caller resumes the context on a gesture: the dropped sounds stay dropped, the next ping plays.
    (ctx as unknown as { state: AudioContextState }).state = 'running';
    expect(ctx.oscillators).toHaveLength(0);
    vi.advanceTimersByTime(2_000);
    expect(ctx.oscillators).toHaveLength(2);
    s.dispose();
  });

  it('a closed context schedules nothing and does not throw', () => {
    vi.useFakeTimers();
    const ctx = fakeAudioContext();
    (ctx as unknown as { state: AudioContextState }).state = 'closed';
    const s = createSounds(() => ctx);
    expect(() => { s.play('join'); s.startRing(); vi.advanceTimersByTime(4_000); s.dispose(); }).not.toThrow();
    expect(ctx.oscillators).toHaveLength(0);
  });

  it('the ring without a context schedules nothing and does not throw', () => {
    vi.useFakeTimers();
    const s = createSounds(() => null);
    expect(() => { s.startRing(); vi.advanceTimersByTime(4_000); s.stopRing(); s.dispose(); }).not.toThrow();
  });
});

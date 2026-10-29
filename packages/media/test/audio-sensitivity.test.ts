import { beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SENSITIVITY, SENSITIVITY, SensitivityGate, dbOf } from '../src/audio/sensitivity';
import { DillaInputStage } from '../src/audio/input-stage';
import { processingConstraints, setBrowserSuppression } from '../src/audio/microphone';

const manual = (thresholdDb: number) => ({ enabled: true, auto: false, thresholdDb });

describe('dbOf', () => {
  it('maps RMS to dBFS clamped to −100..0', () => {
    expect(dbOf(1)).toBe(0);
    expect(dbOf(0.1)).toBeCloseTo(-20);
    expect(dbOf(0)).toBe(-100);
    expect(dbOf(1e-9)).toBe(-100);
    expect(dbOf(2)).toBe(0);
  });
});

describe('SensitivityGate (task 10b)', () => {
  it('opens on the first frame at or over the threshold (attack: one frame)', () => {
    const g = new SensitivityGate(manual(-40));
    expect(g.update(-60, 0)).toBe(false);
    expect(g.update(-41, 10)).toBe(false);
    expect(g.update(-40, 20)).toBe(true);
  });

  it('holds for 300 ms after the last frame over the line, then closes', () => {
    const g = new SensitivityGate(manual(-40));
    g.update(-20, 0);
    expect(g.update(-70, 100)).toBe(true);
    expect(g.update(-70, 300)).toBe(true);
    expect(g.update(-70, 300 + 1)).toBe(false);
  });

  it('a frame over the line during the hold restarts it (pauses between words are kept)', () => {
    const g = new SensitivityGate(manual(-40));
    g.update(-20, 0);
    g.update(-70, 250);
    g.update(-30, 260);
    expect(g.update(-70, 500)).toBe(true);
    expect(g.update(-70, 561)).toBe(false);
  });

  it('disabled (push to talk) is always open', () => {
    const g = new SensitivityGate({ enabled: false, auto: false, thresholdDb: 0 });
    expect(g.update(-100, 0)).toBe(true);
  });

  it('clamps a manual threshold to −100..0', () => {
    expect(new SensitivityGate(manual(-140)).threshold()).toBe(-100);
    expect(new SensitivityGate(manual(12)).threshold()).toBe(0);
  });

  it('automatic: −48 dB before any measurement, then floor + 15 dB within −70..−30', () => {
    const g = new SensitivityGate(DEFAULT_SENSITIVITY);
    expect(g.threshold()).toBe(SENSITIVITY.autoStartDb);
    for (let t = 0; t < 2000; t += 10) g.update(-60, t);
    expect(g.threshold()).toBe(-45);
    const quiet = new SensitivityGate(DEFAULT_SENSITIVITY);
    for (let t = 0; t < 2000; t += 10) quiet.update(-100, t);
    expect(quiet.threshold()).toBe(-70);
  });

  it('automatic: speech over the line never raises the floor into the voice', () => {
    const g = new SensitivityGate(DEFAULT_SENSITIVITY);
    for (let t = 0; t < 1000; t += 10) g.update(-62, t);
    const before = g.threshold();
    for (let t = 1000; t < 20_000; t += 10) g.update(-20, t);
    expect(g.threshold()).toBe(before);
  });

  it('automatic: a louder room raises the floor at most 2 dB/s', () => {
    const g = new SensitivityGate(DEFAULT_SENSITIVITY);
    for (let t = 0; t < 1000; t += 10) g.update(-70, t);
    expect(g.threshold()).toBe(-55);
    // −58 is under the line (−55): the floor creeps up, 2 dB per second at most.
    for (let t = 1000; t < 2000; t += 10) g.update(-58, t);
    expect(g.threshold()).toBeGreaterThan(-55);
    expect(g.threshold()).toBeLessThanOrEqual(-53);
  });

  it('reset closes the gate and forgets the hold', () => {
    const g = new SensitivityGate(manual(-40));
    g.update(-10, 0);
    g.reset();
    expect(g.update(-70, 10)).toBe(false);
  });
});

// The worklet, run against a fake AudioWorkletGlobalScope at 48 kHz.
type Proc = { port: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (m: unknown) => void; sent: unknown[] }; process(i: Float32Array[][], o: Float32Array[][]): boolean };
let Stage: new (o: unknown) => Proc;
beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.sampleRate = 48_000;
  g.AudioWorkletProcessor = class { port = { onmessage: null, sent: [] as unknown[], postMessage(m: unknown) { this.sent.push(m); } }; };
  g.registerProcessor = (_: string, ctor: new (o: unknown) => Proc) => { Stage = ctor; };
  await import('../src/audio/input-stage-worklet');
});

/** Runs `seconds` of a constant-amplitude square-ish signal through the stage; returns every output sample. */
function run(p: Proc, amp: number, ms: number): Float32Array {
  const out = new Float32Array(Math.round(ms * 48));
  for (let at = 0; at < out.length; at += 128) {
    const input = new Float32Array(128);
    for (let i = 0; i < 128; i++) input[i] = (i % 2 === 0 ? 1 : -1) * amp;
    const o = new Float32Array(128);
    p.process([[input]], [[o]]);
    out.set(o.subarray(0, Math.min(128, out.length - at)), at);
  }
  return out;
}
const peak = (a: Float32Array, from = 0, to = a.length) => a.subarray(from, to).reduce((m, x) => Math.max(m, Math.abs(x)), 0);

describe('the input stage worklet (task 10b)', () => {
  it('sends nothing under the threshold, and voice over it', () => {
    const p = new Stage({ processorOptions: { gate: manual(-40), allowed: true } });
    expect(peak(run(p, 0.001, 200))).toBe(0); // −60 dBFS
    const loud = run(p, 0.1, 200); // −20 dBFS
    expect(peak(loud, 48 * 40)).toBeCloseTo(0.1, 5);
  });

  it('keeps the voice through a 250 ms pause (hold), then closes with a ramp, not a click', () => {
    const p = new Stage({ processorOptions: { gate: manual(-40), allowed: true } });
    run(p, 0.1, 100);
    const pause = run(p, 0.001, 250);
    expect(peak(pause, 48 * 200)).toBeCloseTo(0.001, 6);
    const after = run(p, 0.001, 200);
    expect(peak(after, 48 * 150)).toBe(0);
  });

  it('delays the audio one frame, so the onset frame is sent from its start', () => {
    const p = new Stage({ processorOptions: { gate: manual(-40), allowed: true } });
    run(p, 0, 50);
    const onset = run(p, 0.1, 40);
    // The first 10 ms (the look-ahead) are the silence before the voice; the voice follows at once, ramped in 5 ms.
    expect(peak(onset, 0, 480)).toBe(0);
    expect(peak(onset, 480 + 240, 480 + 480)).toBeCloseTo(0.1, 5);
  });

  it('outputs zeros while capture is not allowed, and drops what it held from before', () => {
    const p = new Stage({ processorOptions: { gate: manual(-40), allowed: true } });
    run(p, 0.1, 100);
    p.port.onmessage!({ data: { kind: 'capture', allowed: false } });
    expect(peak(run(p, 0.1, 100))).toBe(0);
    p.port.onmessage!({ data: { kind: 'capture', allowed: true } });
    expect(peak(run(p, 0.1, 10, ), 0, 480)).toBe(0);
  });

  it('a gate message changes the threshold and the level messages carry it', () => {
    const p = new Stage({ processorOptions: { gate: manual(-40), allowed: true } });
    p.port.onmessage!({ data: { kind: 'gate', gate: manual(-10) } });
    expect(peak(run(p, 0.1, 200))).toBe(0); // −20 dB is under −10 now
    const level = p.port.sent.at(-1) as { kind: string; db: number; thresholdDb: number; open: boolean };
    expect(level).toMatchObject({ kind: 'level', thresholdDb: -10, open: false });
    expect(level.db).toBeCloseTo(-20, 0);
  });

  it('push to talk (gate disabled) passes everything', () => {
    const p = new Stage({ processorOptions: { gate: { enabled: false, auto: true, thresholdDb: -50 }, allowed: true } });
    expect(peak(run(p, 0.0001, 100), 48 * 20)).toBeCloseTo(0.0001, 7);
  });
});

describe('DillaInputStage', () => {
  it('without an AudioWorklet passes a clone through, disabled until capture is allowed', async () => {
    const clone = { enabled: true, stop: vi.fn(), clone: vi.fn() };
    const track = { clone: () => clone } as unknown as MediaStreamTrack;
    const stage = new DillaInputStage(null);
    await stage.init({ track, kind: 'audio' } as never);
    expect(stage.active).toBe(false);
    expect(stage.processedTrack).toBe(clone);
    expect(clone.enabled).toBe(false);
    stage.setCaptureAllowed(true);
    expect(clone.enabled).toBe(true);
    await stage.destroy();
    expect(clone.stop).toHaveBeenCalled();
  });

  it('wraps the noise processor: init, restart and destroy reach it, and its output is the stage input', async () => {
    const processed = { enabled: true, stop: vi.fn(), clone: () => ({ enabled: true, stop: vi.fn() }) };
    const inner = { processedTrack: processed as unknown as MediaStreamTrack, init: vi.fn(async () => undefined), restart: vi.fn(async () => undefined), destroy: vi.fn(async () => undefined) };
    const stage = new DillaInputStage(inner, { allowed: true });
    const raw = { clone: vi.fn() } as unknown as MediaStreamTrack;
    await stage.init({ track: raw, kind: 'audio' } as never);
    expect(inner.init).toHaveBeenCalledTimes(1);
    expect(stage.input).toBe(raw);
    await stage.restart({ track: raw, kind: 'audio' } as never);
    expect(inner.restart).toHaveBeenCalledTimes(1);
    await stage.destroy();
    expect(inner.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('echo cancellation and automatic gain (task 10b)', () => {
  it('maps the switches to the capture constraints', () => {
    expect(processingConstraints({ echo: false, agc: true })).toEqual({ echoCancellation: false, autoGainControl: true });
    expect(processingConstraints()).toEqual({ echoCancellation: true, autoGainControl: true });
  });

  it('setBrowserSuppression keeps them as asked', async () => {
    const applyConstraints = vi.fn(async () => undefined);
    const track = { applyConstraints, getConstraints: () => ({}), getSettings: () => ({ noiseSuppression: false }) } as unknown as MediaStreamTrack;
    await setBrowserSuppression(track, false, { echo: false, agc: false });
    expect(applyConstraints).toHaveBeenCalledWith({ noiseSuppression: false, echoCancellation: false, autoGainControl: false });
  });
});

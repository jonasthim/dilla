import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyserMeter, SPEAK_HOLD_MS, SPEAK_ON_MS, SPEAK_RMS, SPEAK_TICK_MS, SpeakingDetector } from './speaking.ts';

describe('SpeakingDetector (web3.8 V1)', () => {
  const run = (d: SpeakingDetector, rms: number, from: number, to: number): boolean => {
    let out = false;
    for (let t = from; t <= to; t += SPEAK_TICK_MS) out = d.update(rms, t);
    return out;
  };

  it('switches on after 50 ms of level, not after 25 ms', () => {
    const d = new SpeakingDetector();
    expect(run(d, 0.05, 0, SPEAK_TICK_MS)).toBe(false);
    const e = new SpeakingDetector();
    expect(run(e, 0.05, 0, SPEAK_ON_MS)).toBe(true);
  });

  it('holds for 300 ms of silence, then switches off', () => {
    const d = new SpeakingDetector();
    run(d, 0.05, 0, SPEAK_ON_MS);
    expect(run(d, 0, 75, 75 + SPEAK_HOLD_MS - SPEAK_TICK_MS)).toBe(true);
    expect(d.update(0, 75 + SPEAK_HOLD_MS)).toBe(false);
  });

  it('a short dip does not switch off, and a short blip does not switch on', () => {
    const d = new SpeakingDetector();
    run(d, 0.05, 0, 100);
    run(d, 0, 125, 300);
    expect(d.update(0.05, 325)).toBe(true);
    expect(run(d, 0, 350, 600)).toBe(true);
    const e = new SpeakingDetector();
    e.update(0.05, 0);
    e.update(0, 25);
    expect(e.update(0.05, 50)).toBe(false);
    expect(e.update(0.05, 75)).toBe(false);
    expect(e.update(0.05, 100)).toBe(true);
  });

  it('the threshold itself counts as voiced, and reset silences at once', () => {
    const d = new SpeakingDetector();
    expect(run(d, SPEAK_RMS, 0, SPEAK_ON_MS)).toBe(true);
    d.reset();
    expect(d.update(0.05, 1000)).toBe(false);
  });
});

describe('analyserMeter', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  const fakeCtx = (fill: number) => {
    const analyser = {
      fftSize: 0,
      connect: vi.fn(),
      disconnect: vi.fn(),
      getFloatTimeDomainData: vi.fn((a: Float32Array) => { a.fill(fill); }),
    };
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    const raw = {
      state: 'running', destination: { id: 'destination' },
      createMediaStreamSource: vi.fn((): unknown => source),
      createAnalyser: vi.fn(() => analyser),
    };
    return { ctx: raw as unknown as AudioContext, analyser, source, raw };
  };

  it('reads the RMS from a 512-sample window and never touches the destination', () => {
    vi.stubGlobal('MediaStream', class { constructor(public tracks: unknown[]) {} });
    const f = fakeCtx(0.1);
    const m = analyserMeter(f.ctx, {} as MediaStreamTrack);
    expect(m).not.toBeNull();
    expect(f.analyser.fftSize).toBe(512);
    expect(m!.read()).toBeCloseTo(0.1, 5);
    expect(f.source.connect).toHaveBeenCalledWith(f.analyser);
    expect(f.analyser.connect).not.toHaveBeenCalled();
    m!.close();
    expect(f.source.disconnect).toHaveBeenCalled();
    expect(f.analyser.disconnect).toHaveBeenCalled();
  });

  it('is null where the browser refuses', () => {
    vi.stubGlobal('MediaStream', class { constructor(public tracks: unknown[]) {} });
    const f = fakeCtx(0);
    f.raw.createMediaStreamSource.mockImplementation(() => { throw new Error('no'); });
    expect(analyserMeter(f.ctx, {} as MediaStreamTrack)).toBeNull();
    const closed = fakeCtx(0);
    closed.raw.state = 'closed';
    expect(analyserMeter(closed.ctx, {} as MediaStreamTrack)).toBeNull();
  });
});

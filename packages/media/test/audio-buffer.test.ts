import { describe, it, expect } from 'vitest';
import { FrameBridge } from '../src/audio/frame-bridge';
import { OnsetGate } from '../src/audio/onset-gate';

describe('worker audio privacy and bounded buffers', () => {
  it('drops audio captured while closed and rejects in-flight output after mute/unmute', () => {
    const sent: Array<{ id: number; epoch: number; pcm: Float32Array }> = [];
    const b = new FrameBridge(m => sent.push(m), 480);
    const out = new Float32Array(480);
    b.render(new Float32Array(480).fill(0.7), out);
    expect(sent).toHaveLength(0);
    b.setAllowed(true);
    b.render(new Float32Array(480).fill(0.5), out);
    const stale = sent[0];
    b.setAllowed(false); b.setAllowed(true);
    b.accept(stale);
    b.render(new Float32Array(480).fill(0.2), out);
    expect([...out].every(x => x === 0)).toBe(true);
    expect(sent.at(-1)!.epoch).not.toBe(stale.epoch);
  });
  it('never queues more than the pool permits when a worker stalls', () => {
    const sent: unknown[] = [];
    const b = new FrameBridge(m => sent.push(m), 480);
    b.setAllowed(true);
    for (let i = 0; i < 100; i++) b.render(new Float32Array(480), new Float32Array(480));
    expect(sent).toHaveLength(4);
    expect(b.stats.dropped).toBe(96);
  });
  it('flushes partial capture and playback on device replacement', () => {
    const sent: Array<{ id: number; epoch: number; pcm: Float32Array }> = [];
    const b = new FrameBridge(m => sent.push(m), 480); b.setAllowed(true);
    b.render(new Float32Array(480).fill(0.9), new Float32Array(480)); b.accept(sent[0]);
    b.flush(); const out = new Float32Array(128);
    b.render(new Float32Array(128).fill(0.1), out);
    expect([...out].every(x => x === 0)).toBe(true);
  });
});
describe('VAD onset buffer', () => {
  it('retains at most 20 ms before speech, without replaying closed capture', () => {
    const g = new OnsetGate('vad'); const frame = (x:number) => new Float32Array(480).fill(x);
    expect(g.process(frame(1), 0, 0)[0]).toBe(0);
    expect(g.process(frame(2), 0, 10)[0]).toBe(0);
    expect(g.process(frame(3), 1, 20)[0]).toBe(1);
    g.reset();
    expect(g.process(frame(4), 1, 30)[0]).toBe(0);
    expect(g.process(frame(5), 1, 40)[0]).toBe(0);
    expect(g.process(frame(6), 1, 50)[0]).toBe(4);
  });
});

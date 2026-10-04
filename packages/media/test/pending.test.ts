import { describe, expect, it } from 'vitest';
import { HOLD_MAX_AGE_MS, HOLD_MAX_FRAMES, PendingQueue } from '../src/worker/pending';

describe('the unknown-KID hold (DEV-19, SP-02)', () => {
  it('holds 2000 ms and 256 frames by default', () => {
    expect(HOLD_MAX_AGE_MS).toBe(2_000);
    expect(HOLD_MAX_FRAMES).toBe(256);
  });

  it('is strictly FIFO', () => {
    const q = new PendingQueue<string>();
    q.push(0, 'a');
    q.push(1, 'b');
    q.push(2, 'c');
    expect([q.shift(), q.shift(), q.shift(), q.shift()]).toEqual(['a', 'b', 'c', undefined]);
  });

  it('evicts and returns the head when the 257th frame arrives', () => {
    const q = new PendingQueue<number>();
    for (let i = 0; i < 256; i++) expect(q.push(i, i)).toBeUndefined();
    expect(q.push(256, 256)).toBe(0);
    expect(q.length).toBe(256);
    expect(q.peek()).toBe(1);
  });

  it('reports an expired head only after the maximum age', () => {
    const q = new PendingQueue<string>();
    q.push(1_000, 'a');
    expect(q.headExpired(3_000)).toBe(false);
    expect(q.headExpired(3_001)).toBe(true);
    expect(new PendingQueue<string>().headExpired(1e9)).toBe(false);
  });

  it('clear returns every held frame and empties the queue', () => {
    const q = new PendingQueue<string>(100, 4);
    q.push(0, 'a');
    q.push(0, 'b');
    expect(q.clear()).toEqual(['a', 'b']);
    expect(q.length).toBe(0);
  });
});

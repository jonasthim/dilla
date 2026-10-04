import { describe, expect, it } from 'vitest';
import { HOLD_MAX_AGE_MS, HOLD_MAX_BYTES, HOLD_MAX_FRAMES, PendingQueue } from '../src/worker/pending';

describe('the unknown-KID hold (DEV-19, SP-02)', () => {
  it('holds 2000 ms, 256 frames and 8 MiB by default', () => {
    expect(HOLD_MAX_AGE_MS).toBe(2_000);
    expect(HOLD_MAX_FRAMES).toBe(256);
    expect(HOLD_MAX_BYTES).toBe(8 * 1024 * 1024);
  });

  it('evicts heads, oldest first, until the held bytes fit the cap (M7)', () => {
    const q = new PendingQueue<string>(2_000, 256, 100);
    expect(q.push(0, 'a', 40)).toEqual([]);
    expect(q.push(0, 'b', 40)).toEqual([]);
    expect(q.bytes).toBe(80);
    expect(q.push(0, 'c', 50)).toEqual(['a']);
    expect(q.bytes).toBe(90);
    expect(q.push(0, 'd', 101)).toEqual(['b', 'c', 'd']);
    expect(q.length).toBe(0);
    expect(q.bytes).toBe(0);
    q.push(0, 'e', 30);
    q.shift();
    expect(q.bytes).toBe(0);
    q.push(0, 'f', 30);
    q.clear();
    expect(q.bytes).toBe(0);
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
    for (let i = 0; i < 256; i++) expect(q.push(i, i)).toEqual([]);
    expect(q.push(256, 256)).toEqual([0]);
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

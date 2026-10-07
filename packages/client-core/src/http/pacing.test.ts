import { describe, expect, it } from 'vitest';
import { PACING, TokenBuckets, type Bucket } from './pacing';

function manualClock() {
  const state = { now: 0 };
  const sleeps: number[] = [];
  return {
    sleeps,
    advance(ms: number) { state.now += ms; },
    deps: {
      now: () => state.now,
      sleep: (ms: number) => {
        sleeps.push(ms);
        state.now += ms;
        return Promise.resolve();
      },
    },
  };
}

async function takeTimes(b: TokenBuckets, bucket: Bucket, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await b.take(bucket);
}

describe('TokenBuckets', () => {
it('is 80 % of the server buckets, the upload bucket 80 % of the per-user 20 a minute', () => {
  expect(PACING).toEqual({
    read: { perSecond: 8, burst: 48 }, write: { perSecond: 1.6, burst: 16 },
    message: { perSecond: 0.8, burst: 16 }, commit: { perSecond: 1.6, burst: 32 },
    proposal: { perSecond: 0.4, burst: 8 }, upload: { perSecond: 16 / 60, burst: 16 },
  });
});

it('lets a full burst through, then waits for one token', async () => {
  const waits: Record<Exclude<Bucket, 'none'>, number> = {
    read: 125, write: 625, message: 1250, commit: 625, proposal: 2500, upload: 3750,
  };
  for (const bucket of ['read', 'write', 'message', 'commit', 'proposal', 'upload'] as const) {
    const clock = manualClock();
    const b = new TokenBuckets(clock.deps);
    await takeTimes(b, bucket, PACING[bucket].burst);
    expect(clock.sleeps, bucket).toEqual([]);
    await b.take(bucket);
    expect(clock.sleeps, bucket).toEqual([waits[bucket]]);
  }
});

  it('refills with elapsed time and never beyond the burst', async () => {
    const clock = manualClock();
    const b = new TokenBuckets(clock.deps);
    await takeTimes(b, 'read', 48);
    clock.advance(1000);
    await takeTimes(b, 'read', 8);
    expect(clock.sleeps).toEqual([]);
    await b.take('read');
    expect(clock.sleeps).toEqual([125]);
    clock.advance(1_000_000_000);
    await takeTimes(b, 'read', 48);
    expect(clock.sleeps).toEqual([125]);
    await b.take('read');
    expect(clock.sleeps).toEqual([125, 125]);
  });

  it('serves takes on one bucket in call order', async () => {
    const clock = manualClock();
    const b = new TokenBuckets(clock.deps);
    await takeTimes(b, 'message', 16);
    const order: number[] = [];
    await Promise.all([
      b.take('message').then(() => order.push(1)),
      b.take('message').then(() => order.push(2)),
    ]);
    expect(order).toEqual([1, 2]);
    expect(clock.sleeps).toEqual([1250, 1250]);
  });

  it('keeps buckets independent and never paces none', async () => {
    const clock = manualClock();
    const b = new TokenBuckets(clock.deps);
    await takeTimes(b, 'read', 48);
    await takeTimes(b, 'write', 16);
    await takeTimes(b, 'none', 1000);
    expect(clock.sleeps).toEqual([]);
  });

  it('rejects an aborted take without consuming a token', async () => {
    const clock = manualClock();
    const b = new TokenBuckets(clock.deps);
    const aborted = new AbortController();
    aborted.abort();
    await expect(b.take('proposal', aborted.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await takeTimes(b, 'proposal', 8);
    expect(clock.sleeps).toEqual([]);
  });
});

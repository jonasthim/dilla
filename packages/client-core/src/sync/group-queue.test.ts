import { describe, expect, it } from 'vitest';
import { SyncError } from './errors';
import { SerialQueues } from './group-queue';
import { deferred, settle } from './testing/model';

describe('SerialQueues: one serial queue per group (rule 1)', () => {
  it('runs the jobs of one key one after another, in the order they were queued', async () => {
    const q = new SerialQueues();
    const log: string[] = [];
    const gate = deferred();
    const a = q.run('g1', async () => {
      log.push('a start');
      await gate.promise;
      log.push('a end');
      return 1;
    });
    const b = q.run('g1', async () => {
      log.push('b start');
      await Promise.resolve();
      log.push('b end');
      return 2;
    });
    await settle();
    expect(log).toEqual(['a start']);
    expect(q.idle('g1')).toBe(false);
    gate.resolve();
    expect(await a).toBe(1);
    expect(await b).toBe(2);
    expect(log).toEqual(['a start', 'a end', 'b start', 'b end']);
    expect(q.idle('g1')).toBe(true);
  });

  it('never starts a job synchronously', async () => {
    const q = new SerialQueues();
    let started = false;
    const p = q.run('g', async () => {
      started = true;
      await Promise.resolve();
    });
    expect(started).toBe(false);
    await p;
    expect(started).toBe(true);
  });

  it('runs two keys concurrently', async () => {
    const q = new SerialQueues();
    const gate = deferred();
    const log: string[] = [];
    const a = q.run('g1', async () => {
      await gate.promise;
      log.push('g1');
    });
    await q.run('g2', async () => {
      await Promise.resolve();
      log.push('g2');
    });
    expect(log).toEqual(['g2']);
    gate.resolve();
    await a;
    expect(log).toEqual(['g2', 'g1']);
  });

  it('keeps going after a job fails', async () => {
    const q = new SerialQueues();
    const failing = q.run('g', async () => {
      await Promise.resolve();
      throw new Error('boom');
    });
    const next = q.run('g', async () => {
      await Promise.resolve();
      return 'ok';
    });
    await expect(failing).rejects.toThrow('boom');
    expect(await next).toBe('ok');
  });

  it('coalesces a tagged job while one with the same tag is still waiting', async () => {
    const q = new SerialQueues();
    const gate = deferred();
    let runs = 0;
    const blocker = q.run('g', async () => {
      await gate.promise;
    });
    const job = async (): Promise<void> => {
      runs += 1;
      await Promise.resolve();
    };
    expect(q.coalesce('g', 'catch-up', job)).toBe(true);
    expect(q.coalesce('g', 'catch-up', job)).toBe(false);
    expect(q.coalesce('g', 'drain', job)).toBe(true);
    gate.resolve();
    await blocker;
    await settle();
    expect(runs).toBe(2);
    expect(q.coalesce('g', 'catch-up', job)).toBe(true);
    await settle();
    expect(runs).toBe(3);
  });

  it('swallows the error of a coalesced job and runs the next one', async () => {
    const q = new SerialQueues();
    expect(
      q.coalesce('g', 't', async () => {
        await Promise.resolve();
        throw new Error('ignored');
      }),
    ).toBe(true);
    await settle();
    expect(
      await q.run('g', async () => {
        await Promise.resolve();
        return 'next';
      }),
    ).toBe('next');
  });

  it('clear() rejects the waiting jobs with E_SYNC_STOPPED and lets the running one finish', async () => {
    const q = new SerialQueues();
    const gate = deferred();
    let ran = false;
    const running = q.run('g', async () => {
      await gate.promise;
      return 'done';
    });
    await settle();
    const waiting = q.run('g', async () => {
      ran = true;
      await Promise.resolve();
    });
    q.clear();
    gate.resolve();
    expect(await running).toBe('done');
    const err: unknown = await waiting.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncError);
    expect(err).toMatchObject({ code: 'E_SYNC_STOPPED' });
    await settle();
    expect(ran).toBe(false);
    expect(q.idle('g')).toBe(true);
  });
  it('clear() leaves an unstarted key idle', async () => {
    const q = new SerialQueues();
    const waiting = q.run('g', async () => { await Promise.resolve(); return 1; });
    q.clear();
    expect(await waiting.catch((e: unknown) => e)).toMatchObject({ code: 'E_SYNC_STOPPED' });
    expect(q.idle('g')).toBe(true);
  });

});

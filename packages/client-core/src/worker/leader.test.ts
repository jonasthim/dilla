import { expect, it } from 'vitest';
import { acquireLeadership, type LockLike, type LockManagerLike } from './leader';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
class Locks implements LockManagerLike {
  held = false;
  exited = 0;
  async request(_name: string, _options: { ifAvailable?: boolean }, callback: (lock: LockLike | null) => Promise<void>): Promise<void> {
    this.held = true;
    try { await callback({ name: 'dilla-core:abc' }); }
    finally { this.held = false; this.exited += 1; }
  }
}
it('holds the one lock until release has left its callback', async () => {
  const locks = new Locks();
  const leadership = await acquireLeadership(locks, 'dilla-core:abc', () => { throw new Error('unexpected wait'); });
  expect(locks.held).toBe(true);
  expect(locks.exited).toBe(0);
  await leadership.release();
  expect(locks.held).toBe(false);
  expect(locks.exited).toBe(1);
});
it('waits for a durable child even after its accepted send command returns', async () => {
  const { CommandBarrier } = await import('./barrier');
  const barrier = new CommandBarrier();
  const write = deferred<void>();
  // eslint-disable-next-line @typescript-eslint/require-await -- a command may return before its durable child
  const accepted = barrier.admit(async () => { void barrier.track(write.promise); return 'queued'; });
  await expect(accepted).resolves.toBe('queued');
  const drained = barrier.close();
  expect(barrier.isClosed()).toBe(true);
  // eslint-disable-next-line @typescript-eslint/require-await -- admission must reject before calling this job
  await expect(barrier.admit(async () => 'late')).rejects.toMatchObject({ code: 'E_NOT_READY' });
  let settled = false;
  void drained.then(() => { settled = true; });
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  write.resolve();
  await drained;
  expect(settled).toBe(true);
});

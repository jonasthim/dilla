// One worker per instance holds the Web Lock until it voluntarily releases it or dies.
import { LOCK_PREFIX } from './protocol';

export interface LockLike { name: string }
export interface LockManagerLike {
  request(name: string, options: { ifAvailable?: boolean }, callback: (lock: LockLike | null) => Promise<void>): Promise<void>;
}

/** An in-place reload finds the lock still held by the dying worker of the old page; other-tab is
 *  published only when the lock is still not held this long after the failed attempt (pre-flight ruling 4). */
export const LEADER = { otherTabGraceMs: 1500 } as const;

export function lockName(instanceHex: string): string {
  return LOCK_PREFIX + instanceHex;
}

export interface Leadership { release(): Promise<void> }

/** Resolves on grant. release resolves only after the lock request callback has exited. */
export async function acquireLeadership(locks: LockManagerLike, name: string, onWaiting: () => void): Promise<Leadership> {
  const request = (ifAvailable: boolean): Promise<Leadership | null> => new Promise((resolve, reject) => {
    let releaseHold: (() => void) | null = null;
    const hold = new Promise<void>((done) => { releaseHold = done; });
    const exited = locks.request(name, { ifAvailable }, async (lock) => {
      if (lock === null) { resolve(null); return; }
      resolve({ release: async () => { releaseHold?.(); await exited; } });
      await hold;
    });
    void exited.catch(reject);
  });
  const immediate = await request(true);
  if (immediate !== null) return immediate;
  onWaiting();
  const waited = await request(false);
  if (waited === null) throw new Error('E_NOT_READY');
  return waited;
}

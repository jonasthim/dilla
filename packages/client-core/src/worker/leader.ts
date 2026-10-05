// The single-tab rule (L-TS-09, ruling 13): one worker per instance holds the Web Lock
// dilla-core:<instance hex> until it dies; the browser releases it on pagehide or termination.
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

/** Never settles: the grant callback returns this, so the lock is held until the worker dies. */
const holdForever = (): Promise<never> => new Promise<never>(() => {});

/** Resolves once this worker holds the lock, which it then keeps until it dies. Calls onWaiting first when another holder exists. */
export async function acquireLeadership(locks: LockManagerLike, name: string, onWaiting: () => void): Promise<void> {
  const granted = await new Promise<boolean>((resolve, reject) => {
    locks.request(name, { ifAvailable: true }, async (lock) => {
      if (lock === null) { resolve(false); return; }
      resolve(true);
      await holdForever();
    }).catch(reject);
  });
  if (granted) return;
  onWaiting();
  await new Promise<void>((resolve, reject) => {
    locks.request(name, {}, async () => {
      resolve();
      await holdForever();
    }).catch(reject);
  });
}

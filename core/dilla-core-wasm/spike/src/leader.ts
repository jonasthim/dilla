/**
 * The leader contract. One exclusive Web Lock named `dilla-core:<instance>` per instance, plus a
 * BroadcastChannel of the same name. The lock is the election; the channel is how followers learn
 * what happened. Web Locks are released automatically when the holding agent dies, which is the
 * whole point: no lease, no TTL, no heartbeat (gap-14 §1).
 */

export type LeaderMessage =
  | { type: 'leader-elected'; instance: string }
  | { type: 'leader-resigned'; instance: string }
  | { type: 'call'; id: number; fn: string; args: unknown[] }
  | { type: 'event'; name: string; detail: unknown };

export interface LeaderSession {
  /** The BroadcastChannel followers listen on; live for as long as the lock is held. */
  readonly channel: BroadcastChannel;
  /** Releases the Web Lock. Call only after the store is paused. */
  resign(): void;
}

export function channelName(instance: string): string {
  return `dilla-core:${instance}`;
}

/**
 * Takes the lock, runs `onElected` while holding it, and keeps holding it until `resign()` is
 * called or the agent dies. `onContended` is called once if the lock was not immediately free, so
 * the caller can report follower status without polling.
 *
 * `onReleased` fires from a `.finally()` on the `navigator.locks.request` promise, which settles only
 * after the callback's returned promise has settled and the browser has actually released the lock.
 * `resign()` merely resolves `held`; recording "lock-released" on the line after `resign()` would
 * record intent, and would still pass if the lock were never released at all — the one failure that
 * wedges every subsequent leader.
 */
export function elect(
  instance: string,
  onElected: (session: LeaderSession) => Promise<void>,
  onContended: () => void,
  onReleased: () => void,
): void {
  const name = channelName(instance);
  const channel = new BroadcastChannel(name);

  // ifAvailable tells us, without waiting, whether somebody already holds it.
  void navigator.locks.request(name, { ifAvailable: true }, async (probe) => {
    if (probe === null) onContended();
  });

  void navigator.locks
    .request(name, { mode: 'exclusive' }, async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await onElected({ channel, resign: release });
      await held;
    })
    .finally(() => {
      onReleased();
    });
}

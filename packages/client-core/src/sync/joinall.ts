/** Join-all (L-TS-22 rule 4, Q02): after every ready sweep and on every new expected list, join each expected group this device does not hold, one group at a time, Welcome first, never registering. */
import type { ExpectedGroup } from '../core-port';
import { toHex } from '../hex';
import { DillaHttpError } from '../http/errors';
import { externalJoin } from './channel';
import { SYNC } from './engine';
import { SyncError } from './errors';
import type { SyncInternals } from './internals';

export interface JoinAllProgress { done: number; total: number; failed: number; }
/** Channels first, then DMs; stable within each kind. */
export function joinOrder(groups: readonly ExpectedGroup[]): ExpectedGroup[] {
  return [...groups.filter((g) => g.communityId !== null), ...groups.filter((g) => g.communityId === null)];
}

export class JoinAll {
  private running = false;
  private again = false;
  private halted = false;
  private retry: number | null = null;

  constructor(private readonly s: SyncInternals, private readonly report: (p: JoinAllProgress) => void) {}

  request(): void {
    if (this.halted || this.s.stopped()) return;
    if (this.retry !== null) { this.s.cancelTimer(this.retry); this.retry = null; }
    if (this.running) { this.again = true; return; }
    void this.pass().catch(() => undefined);
  }

  stop(): void {
    this.halted = true;
    if (this.retry !== null) { this.s.cancelTimer(this.retry); this.retry = null; }
  }

  private async pass(): Promise<void> {
    if (this.halted || this.s.stopped()) return;
    this.running = true;
    try {
      const list = joinOrder(this.s.expected());
      const total = list.length;
      if (total === 0) return;
      const todo = list.filter((g) => {
        const state = this.s.row(g.groupId)?.state;
        return state === undefined || state === 0 || state === 1 || state === 4;
      });
      let done = total - todo.length;
      let failed = 0;
      this.report({ done, total, failed });
      if (todo.length > 0) await this.s.pollWelcomes();
      if (this.halted || this.s.stopped()) return;
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < todo.length && !this.halted && !this.s.stopped()) {
          const g = todo[next++];
          if (g === undefined) return;
          const outcome = await this.joinOne(g);
          if (this.halted || this.s.stopped() || outcome === 'stopped') return;
          if (outcome === 'failed') failed += 1; else done += 1;
          this.report({ done, total, failed });
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, SYNC.joinAllConcurrency) }, () => worker()));
      if (!this.halted && !this.s.stopped() && failed > 0) {
        this.retry = this.s.armTimer(SYNC.joinAllRetryMs, () => { this.retry = null; this.request(); });
      }
    } finally {
      this.running = false;
      if (this.again && !this.halted && !this.s.stopped()) { this.again = false; this.request(); }
    }
  }

  private async joinOne(eg: ExpectedGroup): Promise<'joined' | 'held' | 'failed' | 'stopped'> {
    const key = `g:${toHex(eg.groupId)}`;
    const budget = { joins: 0 };
    for (;;) {
      if (this.halted || this.s.stopped()) return 'stopped';
      try {
        const result = await this.s.queues.run(key, async () => {
          const state = this.s.row(eg.groupId)?.state;
          if (state === 2 || state === 3) return 'held' as const;
          if (state === 0 || state === 1) this.s.deps.core.groupDiscard(eg.groupId);
          await externalJoin(this.s, eg, budget);
          return 'joined' as const;
        });
        await this.s.queues.run(key, () => Promise.resolve());
        return result;
      } catch (e) {
        if (this.s.stopped() || e instanceof SyncError && e.code === 'E_SYNC_STOPPED') return 'stopped';
        if (e instanceof DillaHttpError && e.status === 409 && e.code === 'E_COMMIT_CONFLICT' && budget.joins < SYNC.commitRetryMax) continue;
        return 'failed';
      }
    }
  }
}

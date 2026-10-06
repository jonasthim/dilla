import { SyncError } from './errors';

interface Job {
  started: boolean;
  cancel(): void;
}
interface Lane {
  tail: Promise<void>;
  count: number;
  tags: Set<string>;
  jobs: Set<Job>;
}

export class SerialQueues {
  private readonly lanes = new Map<string, Lane>();

  run<T>(key: string, job: () => Promise<T>): Promise<T> {
    let lane = this.lanes.get(key);
    if (lane === undefined) {
      lane = { tail: Promise.resolve(), count: 0, tags: new Set(), jobs: new Set() };
      this.lanes.set(key, lane);
    }
    const current = lane;
    current.count += 1;
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const answer = new Promise<T>((r, j) => { resolve = r; reject = j; });
    const pending: Job = { started: false, cancel: () => { reject(new SyncError('E_SYNC_STOPPED')); } };
    current.jobs.add(pending);
    current.tail = current.tail.then(async () => {
      if (!current.jobs.has(pending)) return;
      pending.started = true;
      let value: T | undefined;
      let error: unknown;
      let failed = false;
      try { value = await job(); } catch (e) { error = e; failed = true; }
      current.jobs.delete(pending);
      current.count -= 1;
      if (current.count === 0) this.lanes.delete(key);
      if (failed) reject(error);
      else resolve(value as T);
    });
    return answer;
  }

  coalesce(key: string, tag: string, job: () => Promise<void>): boolean {
    const lane = this.lanes.get(key);
    if (lane?.tags.has(tag)) return false;
    const promise = this.run(key, async () => {
      this.lanes.get(key)?.tags.delete(tag);
      await job();
    });
    this.lanes.get(key)?.tags.add(tag);
    void promise.catch(() => undefined);
    return true;
  }

  idle(key: string): boolean { return !this.lanes.has(key); }

  clear(): void {
    for (const [key, lane] of this.lanes) {
      lane.tags.clear();
      for (const job of lane.jobs) {
        if (job.started) continue;
        job.cancel();
        lane.jobs.delete(job);
        lane.count -= 1;
      }
      if (lane.count === 0) this.lanes.delete(key);
    }
  }
}

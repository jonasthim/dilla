// The command drain boundary and the search generation gate. They live apart from runtime.ts, which
// imports the wasm core, so the controller and its tests load without a built @dilla/core-wasm.

/** Accepted commands and the durable work they spawn share one drain boundary. */
export class CommandBarrier {
  private closed = false;
  private readonly pending = new Set<Promise<unknown>>();
  isClosed(): boolean { return this.closed; }
  track<T>(job: Promise<T>): Promise<T> {
    this.pending.add(job);
    void job.finally(() => { this.pending.delete(job); }).catch(() => undefined);
    return job;
  }
  admit<T>(job: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(Object.assign(new Error('E_NOT_READY'), { code: 'E_NOT_READY' }));
    try { return this.track(job()); }
    catch (e) { return Promise.reject(e instanceof Error ? e : new Error('E_INTERNAL')); }
  }
  async close(): Promise<void> {
    this.closed = true;
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }
  reopen(): void { this.closed = false; }
}

export class SearchGate {
  private id = 0;
  next(): number { return ++this.id; }
  current(id: number): boolean { return id === this.id; }
  invalidate(): void { this.id += 1; }
}

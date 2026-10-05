// The page side of the core worker (L-TS-10): calls go out with an id and come back as one ret; slices
// come in with a revision, and the page keeps only the newest of each.
import type { SliceName, SliceTypes, WorkerError } from './state/types';
import type { Command } from './worker/protocol';

export class CoreCallError extends Error {
  readonly code: string;
  readonly detail: string;
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(error: WorkerError) {
    super(error.detail === '' ? error.code : `${error.code}: ${error.detail}`);
    this.name = 'CoreCallError';
    this.code = error.code;
    this.detail = error.detail;
    this.status = error.status;
    this.retryAfterMs = error.retryAfterMs;
  }
}

export interface CoreClient {
  call<C extends Command>(command: C): Promise<unknown>;
  get<N extends SliceName>(name: N): SliceTypes[N] | undefined;
  subscribe(name: SliceName, listener: () => void): () => void;
  dispose(): void;
}

const DISPOSED: WorkerError = { code: 'E_DISPOSED', detail: '', status: 0, retryAfterMs: null };

function workerError(value: unknown): WorkerError {
  if (typeof value === 'object' && value !== null) {
    const e = value as Record<string, unknown>;
    if (typeof e.code === 'string' && typeof e.detail === 'string' && typeof e.status === 'number'
      && (typeof e.retryAfterMs === 'number' || e.retryAfterMs === null)) {
      return { code: e.code, detail: e.detail, status: e.status, retryAfterMs: e.retryAfterMs };
    }
  }
  return { code: 'E_INTERNAL', detail: 'malformed worker error', status: 0, retryAfterMs: null };
}

export function connectCore(worker: Worker): CoreClient {
  let next = 1;
  let disposed = false;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: CoreCallError) => void }>();
  const slices = new Map<SliceName, { rev: number; value: unknown }>();
  // One entry object per subscription, so subscribing the same function twice needs two removals.
  const listeners = new Map<SliceName, Set<{ listener: () => void }>>();

  worker.addEventListener('message', (event: MessageEvent<unknown>) => {
    const data = event.data;
    if (typeof data !== 'object' || data === null) return;
    const m = data as Record<string, unknown>;
    if (m.t === 'ret' && typeof m.id === 'number') {
      const call = pending.get(m.id);
      if (call === undefined) return;
      pending.delete(m.id);
      if (m.ok === true) call.resolve(m.value);
      else call.reject(new CoreCallError(workerError(m.error)));
      return;
    }
    if (m.t === 'slice' && typeof m.name === 'string' && typeof m.rev === 'number') {
      const name = m.name as SliceName;
      if (m.rev <= (slices.get(name)?.rev ?? 0)) return;
      slices.set(name, { rev: m.rev, value: m.value });
      for (const entry of [...(listeners.get(name) ?? [])]) {
        try { entry.listener(); }
        catch (err) { queueMicrotask(() => { throw err; }); }
      }
    }
  });

  return {
    call(command) {
      if (disposed) return Promise.reject(new CoreCallError(DISPOSED));
      const id = next++;
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ t: 'call', id, command });
      });
    },
    get<N extends SliceName>(name: N): SliceTypes[N] | undefined {
      return slices.get(name)?.value as SliceTypes[N] | undefined;
    },
    subscribe(name, listener) {
      const entry = { listener };
      const set = listeners.get(name) ?? new Set<{ listener: () => void }>();
      set.add(entry);
      listeners.set(name, set);
      return () => { set.delete(entry); };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      worker.terminate();
      for (const call of pending.values()) call.reject(new CoreCallError(DISPOSED));
      pending.clear();
    },
  };
}

export function createCoreWorker(): Worker {
  return new Worker(new URL('./worker/entry.ts', import.meta.url), { type: 'module', name: 'dilla-core' });
}

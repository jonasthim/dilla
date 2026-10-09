/// <reference lib="webworker" />
// The real browser wiring of the core worker (C5, C7): the worker scope's fetch, WebSocket, Web Locks,
// IndexedDB and OPFS, and the one dynamic import of the wasm core.
import { boot, opfsDirectoryExists, wasmCoreOpener } from '../account/boot';
import { indexedDbKekStore } from '../account/kek';
import type { CoreWasmModule } from '../core-port';
import { toHex } from '../hex';

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
import { Controller, type ControllerParts } from './controller';

type WasmModule = CoreWasmModule & { default(): Promise<unknown> };
let wasm: Promise<WasmModule> | null = null;

/** Loads @dilla/core-wasm once. With no argument wasm-bindgen's init fetches the .wasm next to its glue
 *  (new URL('dilla_core_wasm_bg.wasm', import.meta.url)), which Vite emits as one hashed asset. The
 *  generated types are not imported statically (L-TS-03 keeps them out of the lint). */
function loadCoreWasm(): Promise<WasmModule> {
  wasm ??= (async () => {
    const mod = (await import('@dilla/core-wasm')) as unknown as WasmModule;
    await mod.default();
    return mod;
  })();
  return wasm;
}

function isNotFound(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'NotFoundError';
}

export function startCoreWorker(scope: DedicatedWorkerGlobalScope, options: { testHooks: boolean; parts?: Partial<ControllerParts> }): Controller {
  const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise<void>((resolve, reject) => {
    const aborted = (): Error => (signal?.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError'));
    if (signal?.aborted === true) { reject(aborted()); return; }
    const onAbort = (): void => { scope.clearTimeout(timer); reject(aborted()); };
    const timer = scope.setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  const kek = indexedDbKekStore(scope.indexedDB, scope.crypto.subtle, (a) => scope.crypto.getRandomValues(a));
  const controller = new Controller({
    origin: scope.location.origin,
    fetch: scope.fetch.bind(scope),
    // The worker's global WebSocket; lib.webworker declares it as a global, not as a member of the scope type.
    WebSocket: (scope as DedicatedWorkerGlobalScope & typeof globalThis).WebSocket,
    locks: { request: async (name, opts, callback) => { await scope.navigator.locks.request(name, opts, callback); } },
    now: () => Date.now(),
    random: () => Math.random(),
    setTimeout: (fn, ms) => scope.setTimeout(fn, ms),
    clearTimeout: (id) => { scope.clearTimeout(id); },
    sleep,
    post: (message) => { scope.postMessage(message); },
    testHooks: options.testHooks,
    boot: async (instance) => {
      const mod = await loadCoreWasm();
      const root = await scope.navigator.storage.getDirectory();
      return boot({
        instance,
        probePersistence: () => mod.probe_persistence(),
        storeExists: (dir) => opfsDirectoryExists(root, dir),
        kek,
        openCore: wasmCoreOpener(mod, (ms) => sleep(ms)),
      });
    },
    resetDevice: async (instance) => {
      const hex = toHex(instance.instanceId);
      await kek.remove(hex);
      const root = await scope.navigator.storage.getDirectory();
      try {
        const dilla = await root.getDirectoryHandle('dilla');
        await dilla.removeEntry(hex, { recursive: true });
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
    },
    ...(options.parts === undefined ? {} : { parts: options.parts }),
  });
  scope.addEventListener('message', (e: MessageEvent<unknown>) => { controller.handle(e.data); });
  return controller;
}

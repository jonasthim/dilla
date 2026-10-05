import { CoreCallError, connectCore, type Command, type SliceName, type TestHook } from '../src/index';

export type HarnessResult = { ok: true; value: unknown } | { ok: false; code: string; detail: string; status: number; retryAfterMs: number | null };
export interface HarnessApi {
  call(command: Command): Promise<HarnessResult>;
  get(name: string): unknown;
  hook(op: TestHook['op']): void;
}

// The core-worker suite's page (e2e/web/core-worker.spec.ts): the real bridge over the real worker,
// whose entry also honours the two gateway test hooks. It renders nothing; the spec reads slices.
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'dilla-core' });
const client = connectCore(worker);

const api: HarnessApi = {
  async call(command) {
    try {
      return { ok: true, value: await client.call(command) };
    } catch (e) {
      if (e instanceof CoreCallError) return { ok: false, code: e.code, detail: e.detail, status: e.status, retryAfterMs: e.retryAfterMs };
      return { ok: false, code: 'E_HARNESS', detail: e instanceof Error ? e.message : String(e), status: 0, retryAfterMs: null };
    }
  },
  get: (name) => client.get(name as SliceName) ?? null,
  hook: (op) => {
    const message: TestHook = { t: 'test', op };
    worker.postMessage(message);
  },
};

(window as Window & { dilla?: HarnessApi }).dilla = api;
const status = document.getElementById('status');
if (status) status.textContent = 'ready';

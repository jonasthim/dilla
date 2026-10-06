import { CoreCallError, connectCore, type Command, type SliceName, type TestHook } from '../src/index';
import { isSpikeEvent, type SpikeEvent, type SpikeRequest } from './spike';

export type HarnessResult = { ok: true; value: unknown } | { ok: false; code: string; detail: string; status: number; retryAfterMs: number | null };
export type SpikeRecord = SpikeEvent & { at: number };
export interface SpikeApi {
  events(): SpikeRecord[];
  watchActive(communityId: string): void;
  activeLog(): { at: number; active: number }[];
  timeGroups(): Promise<Extract<SpikeEvent, { kind: 'groups' }>>;
}
export interface HarnessApi {
  call(command: Command): Promise<HarnessResult>;
  get(name: string): unknown;
  hook(op: TestHook['op']): void;
  spike: SpikeApi;
}

// The core-worker suite's page (e2e/web/core-worker.spec.ts): the real bridge over the real worker,
// whose entry also honours the two gateway test hooks. It renders nothing; the spec reads slices.
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'dilla-core' });
const client = connectCore(worker);
const spikeEvents: SpikeRecord[] = [];
const active: { at: number; active: number }[] = [];
worker.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (isSpikeEvent(event.data)) spikeEvents.push({ ...event.data, at: Date.now() });
});

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
  spike: {
    events: () => [...spikeEvents],
    watchActive: (communityId) => {
      const name = `channels:${communityId}` as const;
      const record = (): void => {
        const channels = client.get(name);
        const count = channels?.filter((channel) => channel.group === 'active').length ?? 0;
        if (active.length === 0 || count > active[active.length - 1].active) {
          active.push({ at: Date.now(), active: count });
        }
      };
      record();
      client.subscribe(name, record);
    },
    activeLog: () => [...active],
    timeGroups: () => new Promise((resolve) => {
      const onMessage = (event: MessageEvent<unknown>): void => {
        if (!isSpikeEvent(event.data) || event.data.kind !== 'groups') return;
        worker.removeEventListener('message', onMessage);
        resolve(event.data);
      };
      worker.addEventListener('message', onMessage);
      worker.postMessage({ t: 'spike', op: 'time-groups' } satisfies SpikeRequest);
    }),
  },
};

(window as Window & { dilla?: HarnessApi }).dilla = api;
const status = document.getElementById('status');
if (status) status.textContent = 'ready';

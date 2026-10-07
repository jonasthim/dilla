/// <reference lib="webworker" />
import { startCoreWorker } from '../src/worker/runtime';
import { REAL_PARTS, type ControllerParts } from '../src/worker/controller';
import type { CorePort } from '../src/core-port';
import type { SyncDeps } from '../src/sync/engine';
import { toHex } from '../src/hex';
import { SPIKE_GROUPS_RUNS, isSpikeRequest, type SpikeEvent } from './spike';

const held: { core: CorePort | null; routeCalls: number } = { core: null, routeCalls: 0 };
const post = (event: SpikeEvent): void => { self.postMessage(event); };

const spikeSync: ControllerParts['sync'] = (deps: SyncDeps) => {
  held.core = deps.core;
  const sweep: { begun: number | null; expected: number; seen: Set<string>; done: boolean } = {
    begun: null, expected: 0, seen: new Set(), done: false,
  };
  deps.gateway.subscribe((event) => {
    if (event.type !== 'ready') return;
    sweep.expected = deps.core.groups().filter((g) => g.state === 2).length;
    sweep.seen.clear();
    sweep.begun = performance.now();
    sweep.done = false;
    if (sweep.expected === 0) {
      post({ t: 'spike', kind: 'sweep', groups: 0, ms: 0 });
      sweep.done = true;
    }
  });
  const routes = new Proxy(deps.routes, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]): unknown => {
        held.routeCalls += 1;
        const answer = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (key !== 'getHandshakes') return answer;
        return Promise.resolve(answer).then((page) => {
          if (sweep.begun !== null && !sweep.done) {
            sweep.seen.add(toHex(args[0] as Uint8Array));
            if (sweep.seen.size >= sweep.expected) {
              post({ t: 'spike', kind: 'sweep', groups: sweep.expected, ms: performance.now() - sweep.begun });
              sweep.done = true;
            }
          }
          return page;
        });
      };
    },
  });
  return REAL_PARTS.sync({
    ...deps,
    routes,
    onJoinAll: (progress) => {
      deps.onJoinAll(progress);
      post({ t: 'spike', kind: 'join-all', done: progress.done, total: progress.total, failed: progress.failed });
    },
  });
};

self.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (!isSpikeRequest(event.data)) return;
  const core = held.core;
  if (core === null) {
    post({ t: 'spike', kind: 'groups', ok: false, rows: 0, medianMs: 0, maxMs: 0, routeCalls: { before: 0, after: 0 } });
    return;
  }
  const before = held.routeCalls;
  core.groups();
  const times: number[] = [];
  let last: ReturnType<CorePort['groups']> = [];
  for (let i = 0; i < SPIKE_GROUPS_RUNS; i += 1) {
    const begun = performance.now();
    last = core.groups();
    times.push(performance.now() - begun);
  }
  const after = held.routeCalls;
  times.sort((a, b) => a - b);
  post({ t: 'spike', kind: 'groups', ok: true, rows: last.filter((g) => g.state === 2).length,
    medianMs: times[10], maxMs: times[19], routeCalls: { before, after } });
});

// lib.webworker types self as WorkerGlobalScope & typeof globalThis, which already satisfies the parameter.
startCoreWorker(self, { testHooks: true, parts: { sync: spikeSync } });

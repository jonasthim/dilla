/// <reference lib="webworker" />
// dilla-media-worker: the only host of every RTCRtpScriptTransform and transferred createEncodedStreams pair of
// a call tab (gap G13). The wiring and its fail-closed rules live in ./host.ts.
import { startWorker, type WorkerScopeLike } from './host';
import { loadCrypto } from './wasm';

declare const self: DedicatedWorkerGlobalScope;

startWorker(self as unknown as WorkerScopeLike, {
  load: loadCrypto,
  now: () => performance.now(),
  every: (fn, ms) => { setInterval(fn, ms); },
  scriptTransform: 'RTCTransformEvent' in self,
});

/// <reference lib="webworker" />
// dilla-media-worker: the only host of every RTCRtpScriptTransform and transferred createEncodedStreams pair of
// a call tab (gap G13). Messages run strictly in order. A transform whose options are not dilla-media/1 is
// never read, so none of its frames reaches the decoder or the wire (fail closed). A message that is not
// dilla-media/1 (livekit-client's setKey, ratchetRequest, enable, its setSifTrailer, …) is ignored.
import type { DillaTransformOptions, FromWorker, ToWorker } from '../protocol';
import { isTransformOptions, parseToWorker } from './messages';
import { Pipeline, type EncodedFrameLike, type TrackHandle } from './pipeline';
import { loadCrypto } from './wasm';

declare const self: DedicatedWorkerGlobalScope;

let pipeline: Pipeline | null = null;
let queue: Promise<void> = Promise.resolve();
const pendingTransforms: Array<() => void> = [];
const post = (m: FromWorker): void => self.postMessage(m);

function connect(opts: DillaTransformOptions, readable: ReadableStream, writable: WritableStream, requestKeyFrame?: () => Promise<unknown>): void {
  const p = pipeline;
  if (p === null) {
    post({ kind: 'error', code: 'E_WASM', trackId: opts.trackId });
    return;
  }
  let handle: TrackHandle | null = null;
  readable
    .pipeThrough(new TransformStream<EncodedFrameLike, EncodedFrameLike>({
      start(controller) { handle = p.addTrack(opts, controller, requestKeyFrame); },
      transform(frame) { if (handle !== null) p.frame(handle, frame); },
    }))
    .pipeTo(writable)
    .catch((err: unknown) => post({ kind: 'log', level: 'debug', msg: `pipe ${opts.trackId} closed: ${String(err)}` }));
}

async function handleMessage(m: ToWorker): Promise<void> {
  if (m.kind === 'init') {
    if (pipeline !== null) return; // one init per worker; a second one never replaces the keys or the counters
    try {
      const crypto = await loadCrypto(m.wasmUrl);
      pipeline = new Pipeline({ crypto, post, now: () => performance.now() });
      setInterval(() => pipeline?.tick(), 100);
    } catch (err) {
      post({ kind: 'error', code: 'E_WASM' });
      post({ kind: 'log', level: 'error', msg: `wasm: ${String(err)}` });
    }
    post({ kind: 'initAck', v: 1, scriptTransform: 'RTCTransformEvent' in self });
    for (const run of pendingTransforms.splice(0)) run();
    return;
  }
  if (pipeline === null) {
    post({ kind: 'error', code: 'E_WASM' });
    return;
  }
  if (m.kind === 'attach') {
    const { readable, writable, ...opts } = m.data;
    connect(opts, readable, writable);
    return;
  }
  pipeline.handle(m);
}

self.onmessage = (e: MessageEvent<unknown>): void => {
  const m = parseToWorker(e.data);
  if (m === null) {
    const kind = typeof e.data === 'object' && e.data !== null ? String((e.data as { kind?: unknown }).kind) : typeof e.data;
    post({ kind: 'log', level: 'debug', msg: `ignored a message that is not dilla-media/1 (kind ${kind})` });
    return;
  }
  queue = queue.then(() => handleMessage(m)).catch((err: unknown) => post({ kind: 'log', level: 'error', msg: String(err) }));
};

if ('RTCTransformEvent' in self) {
  self.onrtctransform = (e: RTCTransformEvent): void => {
    const t = e.transformer;
    const opts: unknown = t.options;
    const run = (): void => {
      if (!isTransformOptions(opts)) {
        post({ kind: 'error', code: 'E_BAD_OPTIONS' });
        return;
      }
      const video = opts.slot === 1 || opts.slot === 2;
      connect(opts, t.readable, t.writable, opts.side === 'decode' && video ? () => t.sendKeyFrameRequest() : undefined);
    };
    if (pipeline === null) pendingTransforms.push(run);
    else run();
  };
}

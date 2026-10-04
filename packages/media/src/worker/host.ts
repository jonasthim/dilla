// The dilla-media worker's wiring, separated from `self` so it can be tested (worker/index.ts starts it). It hosts
// every RTCRtpScriptTransform and transferred createEncodedStreams pair of a call tab (gap G13). Messages run
// strictly in order. Fail closed throughout:
// - a transform whose options are not dilla-media/1, or are DillaBlockOptions, is read and every frame discarded
//   (counted `blocked`), so none of its frames reaches the wire or a decoder;
// - a frame the pipeline throws on is dropped and counted `internal`; the stream stays open for the next frame;
// - if the wasm never loads, no initAck is sent, a worker-wide E_WASM is, and every stream is drained and discarded;
// - a message that is not dilla-media/1 (livekit-client's setKey, ratchetRequest, enable, its setSifTrailer, …) is
//   ignored.
import type { DillaBlockOptions, DillaTransformOptions, FromWorker, ToWorker } from '../protocol';
import { isBlockOptions, isTransformOptions, parseToWorker } from './messages';
import { Pipeline, type CryptoFactory, type EncodedFrameLike, type TrackHandle } from './pipeline';

export interface TransformerLike {
  options?: unknown;
  readable: ReadableStream;
  writable: WritableStream;
  sendKeyFrameRequest?: () => Promise<unknown>;
}

export interface WorkerScopeLike {
  postMessage(m: FromWorker): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  onrtctransform?: ((e: { transformer: TransformerLike }) => void) | null;
}

export interface HostDeps {
  load(wasmUrl: string): Promise<CryptoFactory>;
  now(): number;
  every(fn: () => void, ms: number): void;
  /** RTCTransformEvent exists in this worker (Firefox, Safari): onrtctransform is installed. */
  scriptTransform: boolean;
}

export interface WorkerHost {
  pipeline(): Pipeline | null;
  /** Resolves once every message received so far has been handled. */
  settled(): Promise<void>;
}

const TICK_MS = 100;

export function startWorker(scope: WorkerScopeLike, deps: HostDeps): WorkerHost {
  let pipeline: Pipeline | null = null;
  let initStarted = false;
  let initDone = false;
  let queue: Promise<void> = Promise.resolve();
  const pendingTransforms: Array<() => void> = [];
  const post = (m: FromWorker): void => scope.postMessage(m);

  /** Reads and discards every frame: nothing is ever written to the transform's writable. */
  function discard(trackId: string, readable: ReadableStream): void {
    readable
      .pipeTo(new WritableStream())
      .catch((err: unknown) => post({ kind: 'log', level: 'debug', msg: `discarded ${trackId} closed: ${String(err)}` }));
  }

  function connect(opts: DillaTransformOptions | DillaBlockOptions, readable: ReadableStream, writable: WritableStream, requestKeyFrame?: () => Promise<unknown>): void {
    const p = pipeline;
    if (p === null) {
      post({ kind: 'error', code: 'E_WASM', trackId: opts.trackId });
      discard(opts.trackId, readable);
      return;
    }
    let handle: TrackHandle | null = null;
    readable
      .pipeThrough(new TransformStream<EncodedFrameLike, EncodedFrameLike>({
        start(controller) { handle = p.addTrack(opts, controller, requestKeyFrame); },
        transform(frame) {
          if (handle === null) return;
          try {
            p.frame(handle, frame);
          } catch (err) {
            p.fault(handle, err);
          }
        },
      }))
      .pipeTo(writable)
      .catch((err: unknown) => post({ kind: 'log', level: 'debug', msg: `pipe ${opts.trackId} closed: ${String(err)}` }));
  }

  async function handleMessage(m: ToWorker): Promise<void> {
    if (m.kind === 'init') {
      if (initStarted) return; // one init per worker; a second one never replaces the keys or the counters
      initStarted = true;
      try {
        const crypto = await deps.load(m.wasmUrl);
        pipeline = new Pipeline({ crypto, post, now: deps.now });
        deps.every(() => pipeline?.tick(), TICK_MS);
        post({ kind: 'initAck', v: 1, scriptTransform: deps.scriptTransform });
      } catch (err) {
        post({ kind: 'error', code: 'E_WASM' }); // worker-wide: no trackId, no epoch
        post({ kind: 'log', level: 'error', msg: `wasm: ${String(err)}` });
      }
      initDone = true;
      for (const run of pendingTransforms.splice(0)) run();
      return;
    }
    if (pipeline === null) {
      post(m.kind === 'installEpoch' ? { kind: 'error', code: 'E_WASM', epoch: m.epoch } : { kind: 'error', code: 'E_WASM' });
      if (m.kind === 'installEpoch') m.baseKey.fill(0);
      if (m.kind === 'attach') discard(m.data.trackId, m.data.readable);
      return;
    }
    if (m.kind === 'attach') {
      const { readable, writable, ...opts } = m.data;
      connect(opts, readable, writable);
      return;
    }
    pipeline.handle(m);
  }

  scope.onmessage = (e: { data: unknown }): void => {
    const m = parseToWorker(e.data);
    if (m === null) {
      const kind = typeof e.data === 'object' && e.data !== null ? String((e.data as { kind?: unknown }).kind) : typeof e.data;
      post({ kind: 'log', level: 'debug', msg: `ignored a message that is not dilla-media/1 (kind ${kind})` });
      return;
    }
    queue = queue.then(() => handleMessage(m)).catch((err: unknown) => post({ kind: 'log', level: 'error', msg: String(err) }));
  };

  if (deps.scriptTransform) {
    scope.onrtctransform = (e: { transformer: TransformerLike }): void => {
      const t = e.transformer;
      const opts: unknown = t.options;
      const run = (): void => {
        if (isTransformOptions(opts)) {
          const video = opts.slot === 1 || opts.slot === 2;
          const send = t.sendKeyFrameRequest;
          connect(opts, t.readable, t.writable, opts.side === 'decode' && video && send !== undefined ? () => send.call(t) : undefined);
          return;
        }
        if (!isBlockOptions(opts)) post({ kind: 'error', code: 'E_BAD_OPTIONS' });
        const side = isObj(opts) && opts.side === 'encode' ? 'encode' : 'decode';
        const trackId = isObj(opts) && typeof opts.trackId === 'string' ? opts.trackId : '';
        connect({ dilla: 1, side, trackId, block: true }, t.readable, t.writable);
      };
      if (initDone) run();
      else pendingTransforms.push(run);
    };
  }

  return {
    pipeline: () => pipeline,
    settled: () => queue,
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

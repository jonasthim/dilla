// The loader is supplied by the offline runner or the same-origin browser harness.
import rnnoiseFactory from '@jitsi/rnnoise-wasm/dist/rnnoise-sync.js';
import * as df from './assets/df.mjs';
import { GtcrnProcessor, loadGtcrnModule } from './assets/package/dist/index.js';
export async function createEngine(name, load) {
  if (name === 'rnnoise' || name === 'vad') {
    const module = await WebAssembly.compile(await load('rnnoise.wasm'));
    const m = rnnoiseFactory({ instantiateWasm(imports, receive) { const instance = new WebAssembly.Instance(module, imports); receive(instance, module); return instance.exports; } });
    let state = m._rnnoise_create(0); const ptr = m._malloc(480 * 4), out = new Float32Array(480);
    return { frameSize:480, modelRate:48000, lookaheadMs:10,
      process(input) { const at = ptr >>> 2; for(let i=0;i<480;i++) m.HEAPF32[at+i] = input[i]*32768;
        const probability = m._rnnoise_process_frame(state, ptr, ptr);
        for(let i=0;i<480;i++) out[i] = name === 'vad' ? input[i] : m.HEAPF32[at+i]/32768;
        return { pcm:out, probability }; },
      reset() { m._rnnoise_destroy(state); state = m._rnnoise_create(0); },
      destroy() { m._rnnoise_destroy(state); m._free(ptr); },
    };
  }
  if (name === 'deepfilter') {
    await df.default(await load('df_bg.wasm'));
    const model = new Uint8Array(await load('deepfilter-model.bin'));
    let state = df.df_create(model, 100);
    if (df.df_get_frame_length(state) !== 480) throw Error('Unexpected DeepFilterNet frame size');
    return { frameSize:480, modelRate:48000, lookaheadMs:40,
      process(input) { return { pcm:df.df_process_frame(state, input), probability:0 }; },
      reset() { df.df_reset(state); },
      destroy() { df.df_free(state); },
    };
  }
  if (name === 'gtcrn') {
    const m = await loadGtcrnModule({wasmBinary:new Uint8Array(await load('package/dist/gtcrn.wasm'))});
    let p = new GtcrnProcessor(m, { sampleRate:48000 });
    return { frameSize:p.frameSize, modelRate:16000, lookaheadMs:null,
      process(input) { return {pcm:p.process(input), probability:0}; },
      reset() { p.destroy(); p = new GtcrnProcessor(m, {sampleRate:48000}); }, destroy() {p.destroy();},
    };
  }
  throw Error(`Unsupported experimental engine: ${name}`);
}
export function processClip(engine, input) {
  const frame = new Float32Array(engine.frameSize), output = new Float32Array(Math.ceil((input.length + 4800)/engine.frameSize)*engine.frameSize), timings=[];
  for (let at=0;at<output.length;at+=frame.length) {
    frame.fill(0); frame.set(input.subarray(at,at+frame.length));
    const start = performance.now(), result = engine.process(frame); timings.push(performance.now()-start);
    if (result.pcm.length !== frame.length || !result.pcm.every(Number.isFinite)) throw Error('Invalid inference output');
    output.set(result.pcm, at);
  }
  timings.sort((a,b)=>a-b);
  return {pcm:output, metrics:{frames:timings.length, meanMs:timings.reduce((a,b)=>a+b,0)/timings.length, p99Ms:timings[Math.min(timings.length-1,Math.floor(timings.length*0.99))], modelRate:engine.modelRate, frameMs:engine.frameSize/48, addedDelayMs:null, alignment:'uncompensated; includes 100 ms tail padding'}};
}

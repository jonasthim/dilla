// Inference and the independent raw-input detector live only in this dedicated Worker.
// @ts-ignore -- pinned upstream package has no declarations
import rnnoiseFactory from '@jitsi/rnnoise-wasm/dist/rnnoise-sync.js';
import { verifiedAsset, type NoiseAssets } from './enhanced-assets';
import { LookaheadGate } from './lookahead-gate';
import { primeEnhancer } from './prime-enhancer';
import type { AudioFrame } from './frame-bridge';
import type { GateMode } from './gate';
import { TrackCapture } from './track-capture';
interface DeepFilter {
  default(bytes: ArrayBuffer): Promise<unknown>;
  df_create(model: Uint8Array, attenuation: number): number;
  df_get_frame_length(state: number): number;
  df_process_frame(state: number, pcm: Float32Array): Float32Array;
  df_reset(state: number): void;
}
interface Detector {
  HEAPF32: Float32Array;
  _rnnoise_create(model: number): number;
  _rnnoise_destroy(state: number): void;
  _rnnoise_process_frame(state: number, out: number, input: number): number;
  _malloc(bytes: number): number;
}
self.onmessage = async event => {
  const {port,assets,mode} = event.data as {port:MessagePort; assets:NoiseAssets; mode:GateMode};
  if (!(port instanceof MessagePort)) return;
  try {
    const [,bytes,model,detectorBytes] = await Promise.all([verifiedAsset(assets.glue),verifiedAsset(assets.wasm),verifiedAsset(assets.model),verifiedAsset(assets.detector)]);
    // The build emits immutable content-hashed glue at this verified same-origin URL.
    const df: DeepFilter = await import(/* @vite-ignore */ new URL(assets.glue.url,self.location.origin).href);
    await df.default(bytes);
    const state = df.df_create(new Uint8Array(model),100);
    if (df.df_get_frame_length(state) !== 480) throw Error('Expected 48 kHz / 480 sample frames');
    const compiled = await WebAssembly.compile(detectorBytes);
    const detector:Detector = rnnoiseFactory({instantiateWasm(imports:WebAssembly.Imports,receive:(instance:WebAssembly.Instance,module:WebAssembly.Module)=>void){const instance=new WebAssembly.Instance(compiled,imports);receive(instance,compiled);return instance.exports;}});
    let detectionState=detector._rnnoise_create(0);
    const pointer=detector._malloc(480*4), at=pointer>>>2;
    const gate=new LookaheadGate(mode);
    let epoch:number|null=null, time=0, slow=0, failed=false;
    const reset=()=>{df.df_reset(state);detector._rnnoise_destroy(detectionState);detectionState=detector._rnnoise_create(0);detector.HEAPF32.fill(0,at,at+480);gate.reset();};
    primeEnhancer(pcm=>{
      for(let i=0;i<480;i++)detector.HEAPF32[at+i]=pcm[i]*32768;
      detector._rnnoise_process_frame(detectionState,pointer,pointer);
      df.df_process_frame(state,pcm);
    },reset);
    const receive=(e:MessageEvent)=>{
      if(e.data.kind==='capture'){void capture.apply(e.data).then(()=>self.postMessage({kind:'capture-closed',epoch:e.data.epoch})).catch(error=>{failed=true;self.postMessage({kind:'error',reason:'processor-error',detail:String(error)});});return;}
      if(e.data.kind==='recycle'){capture.recycle(e.data.frame);return;}
      if(e.data.kind==='mode'){gate.setMode(e.data.mode);return;}
      if(e.data.kind==='reset'){try{reset();epoch=e.data.epoch;if(e.data.mode)gate.setMode(e.data.mode);}catch{failed=true;self.postMessage({kind:'error',reason:'processor-error'});}return;}
      const frame=e.data as AudioFrame;
      const start=performance.now();
      try {
        if(failed){frame.pcm.fill(0);}else{
          if(frame.discontinuity||epoch!==null&&epoch!==frame.epoch)reset();
          epoch=frame.epoch;
          for(let i=0;i<480;i++)detector.HEAPF32[at+i]=frame.pcm[i]*32768;
          const probability=detector._rnnoise_process_frame(detectionState,pointer,pointer);
          const enhanced=df.df_process_frame(state,frame.pcm);
          time+=10;frame.pcm.set(gate.process(enhanced,probability,time));
          if(!frame.pcm.every(Number.isFinite))throw Error('Invalid model output');
        }
        frame.processingMs=performance.now()-start;
        slow=frame.processingMs>8?slow+1:Math.max(0,slow-1);
        port.postMessage(frame,[frame.pcm.buffer]);
        if(slow>=50&&!failed){failed=true;self.postMessage({kind:'error',reason:'sustained-overload'});}
      }catch {frame.pcm.fill(0);port.postMessage(frame,[frame.pcm.buffer]);if(!failed){failed=true;self.postMessage({kind:'error',reason:'processor-error'});}}
    };
    const capture=new TrackCapture(frame=>receive({data:frame} as MessageEvent),
      (nextEpoch,_allowed,mode)=>{reset();epoch=nextEpoch;gate.setMode(mode);},
      count=>port.postMessage({kind:'capture-drop',epoch,count}),error=>{failed=true;self.postMessage({kind:'error',reason:'processor-error',detail:String(error)});});
    port.onmessage=receive;self.onmessage=receive;
    port.start();self.postMessage({kind:'ready'});
  }catch(error){self.postMessage({kind:'error',reason:'initialization-failed',detail:String(error)});}
};

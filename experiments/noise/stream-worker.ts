import { createEngine } from './engines.mjs';
import { load } from './asset-loader';
import { OnsetGate } from '../../packages/media/src/audio/onset-gate';
import type { AudioFrame } from '../../packages/media/src/audio/frame-bridge';
self.onmessage = async event => {
  const {port,mode,engine:name} = event.data;
  if (!(port instanceof MessagePort)) return;
  try {
    let engine = await createEngine(name,load), detector = name === 'rnnoise' ? null : await createEngine('vad',load);
    const gate = new OnsetGate(mode); let epoch: number | null = null, elapsed=0, slow=0, downgraded=false, switching=false;
    const probabilities:number[]=[];
    const reset = () => {engine.reset(); detector?.reset(); gate.reset(); probabilities.length=0;};
    port.onmessage = e => {
      const frame = e.data as AudioFrame;
      const start = performance.now();
      try {
        if(switching) {frame.pcm.fill(0);} else {
          if(epoch !== null && epoch !== frame.epoch) reset(); epoch=frame.epoch;
          const detected = detector?.process(frame.pcm);
          const result = engine.process(frame.pcm);
          probabilities.push(detected?.probability ?? result.probability);
          // Match raw-input VAD to the enhancement's lookahead before the additional 20 ms onset buffer.
          const delay = detector ? 4 : 0;
          const probability = probabilities.length > delay ? probabilities.shift()! : 0;
          elapsed+=10; frame.pcm.set(gate.process(result.pcm,probability,elapsed));
        }
        frame.processingMs = performance.now()-start;
        slow = frame.processingMs > 8 ? slow+1 : Math.max(0,slow-1);
        port.postMessage(frame,[frame.pcm.buffer]);
        if(slow >= 50 && !downgraded) {
          downgraded=true; switching=true;
          engine.destroy(); detector?.destroy(); detector=null;
          void createEngine('rnnoise',load).then(next=>{engine=next; gate.reset(); epoch=null; probabilities.length=0; switching=false; self.postMessage({kind:'fallback',reason:'sustained-overload',effective:'rnnoise'});},()=>self.postMessage({kind:'error',reason:'fallback-failed'}));
        }
      } catch { frame.pcm.fill(0); port.postMessage(frame,[frame.pcm.buffer]); self.postMessage({kind:'error',reason:'inference-failed'}); }
    };
    port.start(); self.postMessage({kind:'ready',effective:name});
  } catch (error) { self.postMessage({kind:'error',reason:'initialization-failed',detail:String(error)}); }
};

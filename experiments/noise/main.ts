import { ExperimentalDeepFilterProcessor } from './processor';
import { DillaRnnoiseProcessor } from '../../packages/media/src/audio/rnnoise';
import type { AudioProcessorOptions } from 'livekit-client';
import recordUrl from '../../packages/media/src/audio/record-worklet.ts?worker&url';
import { measureDelay } from './delay.mjs';
import { encodeWav } from './benchmark.mjs';
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function run(engine:string,seconds=3,capture=false,mode:'open'|'vad'='open') {
  const ctx=new AudioContext({sampleRate:48000,latencyHint:'interactive'});await ctx.resume();
  const events:Record<string,unknown>[]=[];
  const p=engine==='deepfilter'?new ExperimentalDeepFilterProcessor(e=>events.push(e),mode):new DillaRnnoiseProcessor({mode});
  let stream:MediaStream|undefined;let source:OscillatorNode|undefined;let started=false;
  const dest=ctx.createMediaStreamDestination(); dest.channelCount=1;
  const reads:AudioWorkletNode[]=[];
  try {
    if(capture)stream=await navigator.mediaDevices.getUserMedia({audio:{sampleRate:48000,channelCount:1,echoCancellation:true,autoGainControl:true,noiseSuppression:engine==='current'}});
    else {source=ctx.createOscillator();source.frequency.value=440;const gain=ctx.createGain();gain.gain.value=0.1;source.connect(gain).connect(dest);stream=dest.stream;}
    const track=stream.getAudioTracks()[0];
    await p.init({track,kind:'audio'} as AudioProcessorOptions);p.setCaptureAllowed(true);
    await ctx.audioWorklet.addModule(recordUrl);
    const record=(t:MediaStreamTrack)=>new Promise<Float32Array>(resolve=>{
      const node=new AudioWorkletNode(ctx,'dilla-local-recorder',{channelCount:1,channelCountMode:'explicit'});reads.push(node);
      ctx.createMediaStreamSource(new MediaStream([t])).connect(node);node.connect(ctx.destination);
      node.port.onmessage=e=>resolve(e.data as Float32Array);
    });
    const raw=record(track),processed=record(p.processedTrack!);source?.start();started=true;
    await pause(Math.min(seconds,10)*1000);reads.forEach(n=>n.port.postMessage('finish'));
    const [input,output]=await Promise.all([raw,processed]);
    const peak=Math.max(...output.subarray(0,48000).map(Math.abs));
    // Verify that the application gate silences output while inference continues.
    p.setCaptureAllowed(false);await pause(100);
    const muted=record(p.processedTrack!);await pause(200);reads.at(-1)!.port.postMessage('finish');
    const silence=await muted;
    const result={kind:'browser-streaming-smoke',engine,userAgent:navigator.userAgent,hardwareConcurrency:navigator.hardwareConcurrency,seconds,loadedCall:false,qualified:false,parityClaim:false,inputSettings:track.getSettings(),rate:ctx.sampleRate,inputSamples:input.length,outputSamples:output.length,outputPeak:peak,mutedPeak:silence.reduce((m,x)=>Math.max(m,Math.abs(x)),0),...capture?measureDelay(input,output):{addedDelayMs:null,correlation:null},mode,events,limitations:['Synthetic/fake-capture smoke check, not speech quality or a loaded encrypted call.',capture?'Waveform correlation measures raw tap to processed tap, including transport and VAD; excludes network and playback device latency.':'Periodic tone cannot provide unambiguous delay; use a speech fixture.'],wav:Array.from(encodeWav(output))};
    document.querySelector('#report')!.textContent=JSON.stringify({...result,wav:undefined},null,2);
    return result;
  } finally {for(const t of stream?.getTracks()??[])t.stop();if(started)source?.stop();reads.forEach(n=>n.disconnect());await p.destroy();await ctx.close();}
}
(window as unknown as {noiseHarness:unknown}).noiseHarness={run};
document.querySelector('#run')!.addEventListener('click',()=>{document.querySelector('#report')!.textContent='Running locally…';void run((document.querySelector('#engine') as HTMLSelectElement).value).catch(e=>{document.querySelector('#report')!.textContent=String(e);});});

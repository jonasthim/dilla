// Test harness only. Audio is observed at the outgoing track, without an extra playback graph.
import {ExperimentalDeepFilterProcessor} from './processor';
import {measureTrackDelay} from './track-delay.mjs';
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
type Chunk={pcm:Float32Array;received:number};
function readTrack(track:MediaStreamTrack){
  const Ctor=(window as any).MediaStreamTrackProcessor;
  if(!Ctor)throw Error('This browser cannot measure outgoing audio tracks directly');
  const reader=new Ctor({track,maxBufferSize:100}).readable.getReader();
  const chunks:Chunk[]=[];
  const done=(async()=>{
    while(true){
      const {value,done}=await reader.read();if(done)break;
      const received=performance.now(),pcm=new Float32Array(value.numberOfFrames);
      try{if(value.sampleRate!==48000)throw Error('Expected 48 kHz');value.copyTo(pcm,{planeIndex:0,format:'f32-planar'});chunks.push({pcm,received});}finally{value.close();}
    }
    return chunks;
  })();
  return {done,stop:()=>reader.cancel()};
}
export async function measureTracks(calibration=false,loaded=false,workletCapture=false){
  const events:Record<string,unknown>[]=[],readers:ReturnType<typeof readTrack>[]=[];
  let ctx:AudioContext|undefined,processor:ExperimentalDeepFilterProcessor|undefined,load:ReturnType<typeof setInterval>|undefined;
  const stream=await navigator.mediaDevices.getUserMedia({audio:{sampleRate:48000,channelCount:1,echoCancellation:true,autoGainControl:true,noiseSuppression:false}});
  const track=stream.getAudioTracks()[0],outputs:MediaStreamTrack[]=[];
  try{
    if(calibration){
      ctx=new AudioContext({sampleRate:48000,latencyHint:'interactive'});await ctx.resume();
      const source=ctx.createMediaStreamSource(stream);
      for(const seconds of [0,.04]){const destination=ctx.createMediaStreamDestination(),delay=ctx.createDelay();destination.channelCount=1;delay.delayTime.value=seconds;source.connect(delay).connect(destination);outputs.push(destination.stream.getAudioTracks()[0]);}
    }else{
      processor=new ExperimentalDeepFilterProcessor(e=>events.push(e),'vad');
      const capture=(window as any).MediaStreamTrackProcessor;
      try{if(workletCapture)(window as any).MediaStreamTrackProcessor=undefined;await processor.init({track,kind:'audio'} as never);}
      finally{(window as any).MediaStreamTrackProcessor=capture;}
      processor.setCaptureAllowed(true);outputs.push(processor.processedTrack!);
    }
    await pause(300);
    if(loaded)load=setInterval(()=>{const until=performance.now()+6;while(performance.now()<until)Math.sqrt(Math.random());},16);
    readers.push(...[track,...outputs].map(readTrack));await pause(8000);
    await Promise.all(readers.map(r=>r.stop()));const [raw,...processed]=await Promise.all(readers.map(r=>r.done));
    const measurements=processed.map(output=>measureTrackDelay(raw,output));
    return {calibration,loaded,transport:workletCapture?'worklet':'automatic',seconds:8,inputSettings:track.getSettings(),measurements,events,
      boundary:'Raw microphone track availability to processed track availability, before encryption; includes browser buffering and VAD. No observer AudioContext and no subtracted bypass delay.',
      limitations:['Chromium/Linux file-backed fake microphone; not physical device qualification.','Each result is the worst of three speech-window correlation estimates aligned to median chunk-delivery clocks. Main-thread observation jitter remains possible.']};
  }finally{
    clearInterval(load);await Promise.all(readers.map(r=>r.stop().catch(()=>{})));
    for(const t of stream.getTracks())t.stop();await processor?.destroy();for(const t of outputs)t.stop();await ctx?.close();
  }
}

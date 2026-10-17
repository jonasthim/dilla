import {measureDelay} from './delay.mjs';
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
function flatten(chunks){
 let length=0;const clocks=chunks.map(c=>{const row={at:length,received:c.received};length+=c.pcm.length;return row;});
 const pcm=new Float32Array(length);chunks.forEach((c,i)=>pcm.set(c.pcm,clocks[i].at));return {pcm,clocks};
}
/** Compare PCM, then align each analysis window to the actual delivery clocks of both tracks.
 * The worst measured window includes the browser's capture-to-track buffering and VAD.
 * There is no extra AudioContext consuming the output and no subtracted bypass latency. */
export function measureTrackDelay(input,output,rate=48000){
 const raw=flatten(input),processed=flatten(output),windows=[];
 for(const seconds of [0,2.5,5]){
  const start=Math.round(seconds*rate),end=start+Math.round(2.5*rate);
  if(Math.min(raw.pcm.length,processed.pcm.length)<end)continue;
  const measured=measureDelay(raw.pcm.subarray(start,end),processed.pcm.subarray(start,end),rate,160);
  if(measured.addedDelayMs===null){windows.push({atSeconds:seconds,...measured});continue;}
  const lag=measured.addedDelayMs*rate/1000;
  const offset=(data,shift)=>median(data.clocks.filter(c=>c.at>=start+rate/4+shift&&c.at<start+rate*2.25+shift).map(c=>c.received-c.at/rate*1000));
  const clockOffset=offset(processed,lag)-offset(raw,0),delay=measured.addedDelayMs+clockOffset;
  windows.push({atSeconds:seconds,addedDelayMs:Number.isFinite(delay)&&delay>=0?delay:null,correlation:measured.correlation,pcmLagMs:measured.addedDelayMs,deliveryClockOffsetMs:clockOffset});
 }
 const complete=windows.length===3&&windows.every(w=>w.addedDelayMs!==null);
 return {addedDelayMs:complete?Math.max(...windows.map(w=>w.addedDelayMs)):null,windows,reason:complete?null:'Three measurable speech windows are required'};
}

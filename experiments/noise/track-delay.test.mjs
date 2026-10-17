import{test}from'node:test';import assert from'node:assert/strict';
import {measureTrackDelay} from './track-delay.mjs';
// Audio chunk delivery clocks start at different times. Comparing concatenated PCM alone
// reports 90 ms here, although the actual capture-to-available delay is 70 ms.
function fixture(delayMs=70){
 let seed=11;const samples=Float32Array.from({length:48000*8},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32-.5;});
 const shifted=new Float32Array(samples.length),lag=(delayMs+20)*48;shifted.set(samples.subarray(0,samples.length-lag),lag);
 const chunks=(pcm,origin)=>Array.from({length:800},(_,i)=>({pcm:pcm.slice(i*480,(i+1)*480),received:origin+i*10+(i%3-1)*.2}));
 return [chunks(samples,1000),chunks(shifted,980)];
}
test('measures outgoing track availability against the capture clock, including browser buffering',()=>{
 const report=measureTrackDelay(...fixture());
 assert.equal(report.windows.length,3);
 for(const w of report.windows)assert.ok(Math.abs(w.addedDelayMs-70)<.25,JSON.stringify(w));
 assert.ok(Math.abs(report.addedDelayMs-70)<.25);
 const slower=measureTrackDelay(...fixture(110));assert.ok(Math.abs(slower.addedDelayMs-110)<.25);
});
test('refuses silent or short track recordings rather than qualifying them',()=>{
 const chunks=Array.from({length:800},(_,i)=>({pcm:new Float32Array(480),received:1000+i*10}));
 assert.equal(measureTrackDelay(chunks,chunks).addedDelayMs,null);
 assert.equal(measureTrackDelay(chunks.slice(0,10),chunks.slice(0,10)).addedDelayMs,null);
});

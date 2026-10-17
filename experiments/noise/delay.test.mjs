import {test} from 'node:test';
import assert from 'node:assert/strict';
import {measureDelay} from './delay.mjs';
test('measures the whole buffered path and refuses silence',()=>{
  let seed=123;const input=Float32Array.from({length:48000*3},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32-.5;});
  const output=new Float32Array(input.length);output.set(input.subarray(0,input.length-3168),3168);
  const result=measureDelay(input,output);assert.equal(result.addedDelayMs,66);assert.equal(result.correlation,1);
  assert.equal(measureDelay(new Float32Array(48000),new Float32Array(48000)).addedDelayMs,null);
});

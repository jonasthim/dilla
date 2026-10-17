import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as benchmark from '../benchmark.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
test('decodes each listener with their own randomization, rejecting ambiguous shared keys',()=>{
  const keys={listeners:{alice:{key:[{code:'c0-s0',clip:'one',engine:'deepfilter'}]},bob:{key:[{code:'c0-s0',clip:'one',engine:'krisp'}]}}};
  const ratings=[{listener:'alice',code:'c0-s0'},{listener:'bob',code:'c0-s0'}];
  const decoded=benchmark.decodeRatings(ratings,keys);
  assert.deepEqual(decoded.map(r=>r.engine),['deepfilter','krisp']);
  assert.throws(()=>benchmark.decodeRatings(ratings,keys.listeners.alice),/listener/);
  assert.throws(()=>benchmark.decodeRatings([{listener:'eve',code:'c0-s0'}],keys),/listener/);
});
test('matched references survive real comparison and blind-listening preparation', {skip:!existsSync(new URL('../assets/df.mjs',import.meta.url))},()=>{
  const dir=mkdtempSync(join(tmpdir(),'dilla-noise-workflow-'));
  try {
    const pcm=Float32Array.from({length:4800},(_,i)=>Math.sin(i*0.13)*0.1),wav=benchmark.encodeWav(pcm);
    writeFileSync(join(dir,'input.wav'),wav);writeFileSync(join(dir,'original-reference.wav'),wav);
    const corpus={clips:[{id:'fixture',file:'input.wav',sha256:hash(wav),license:'CC0 synthesized test signal',language:'en',categories:['clean'],reference:{file:'original-reference.wav',sha256:hash(wav),inputSha256:hash(wav),version:'test fixture only',captureSettings:{sampleRate:48000},lawfulUse:'Self-generated signal, not a Krisp quality reference'}}]};
    writeFileSync(join(dir,'corpus.json'),JSON.stringify(corpus));
    execFileSync(process.execPath,[resolve('experiments/noise/compare.mjs'),join(dir,'corpus.json'),join(dir,'output')]);
    const report=JSON.parse(readFileSync(join(dir,'output/report.json')));
    assert.equal(report.results.find(r=>r.engine==='krisp').file,'0-krisp.wav');
    execFileSync(process.execPath,[resolve('experiments/noise/listen.mjs'),join(dir,'output/report.json'),join(dir,'blind')]);
    assert.equal(JSON.parse(readFileSync(join(dir,'blind-key.json'))).key.length,5);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

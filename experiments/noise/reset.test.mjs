// Runs against the pinned, locally prepared WASM; no network or microphone.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createEngine} from './engines.mjs';
const load=async name=>new Uint8Array(await readFile(new URL(`./assets/${name}`,import.meta.url))).buffer;
test('DeepFilter reset clears all audio and recurrent state without recompiling the model',async()=>{
  const engine=await createEngine('deepfilter',load);
  const frames=Array.from({length:40},(_,n)=>Float32Array.from({length:480},(_,i)=>0.2*Math.sin((n*480+i)*.13)+.1*Math.cos((n*480+i)*.071)));
  try {
    const reference=frames.map(frame=>engine.process(frame).pcm.slice());
    let worst=0;
    for(let round=0;round<5;round++){
      const start=performance.now();engine.reset();worst=Math.max(worst,performance.now()-start);
      for(let n=0;n<frames.length;n++)assert.deepEqual(engine.process(frames[n]).pcm,reference[n]);
    }
    assert.ok(worst<10,`Reset took ${worst.toFixed(2)} ms; it must fit a 10 ms frame`);
  }finally{engine.destroy();}
});

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import {noiseIdentity} from '../../scripts/noise-identity.mjs';
import { validateCorpus, decodeWav, encodeWav } from './benchmark.mjs';
import { createEngine, processClip } from './engines.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const [manifest, outputArg]=process.argv.slice(2);
if (!manifest || !outputArg) throw Error('Usage: node experiments/noise/compare.mjs corpus.json output-directory');
const hash = b => createHash('sha256').update(b).digest('hex');
const corpus=JSON.parse(readFileSync(manifest)), base=dirname(resolve(manifest)), output=resolve(outputArg), lock=JSON.parse(readFileSync(resolve(here,'asset-lock.json')));
validateCorpus(corpus); mkdirSync(output,{recursive:true});
for (const [file,expected] of Object.entries(lock.sha256)) if(hash(readFileSync(resolve(here,'assets',file)))!==expected) throw Error(`Asset changed: ${file}`);
const load = async path => { const b=readFileSync(resolve(here,'assets',path)); return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength); };
const report={...noiseIdentity(),kind:'offline-inference', qualified:false, parityClaim:false, hardware:{cpu:os.cpus()[0]?.model,cores:os.cpus().length,memoryBytes:os.totalmem(),platform:os.platform(),arch:os.arch(),node:process.version},assets:lock,settings:{rate:48000,channels:1,attenuationDb:100,gate:'open',browserAEC:false,browserAGC:false,browserNS:false},results:[],limitations:['Offline timings exclude capture, buffering, VAD and browser scheduling.','Browser+RNNoise baseline must be captured with browser-run.mjs using the identical WAV.','Krisp outputs must be supplied lawfully; no automatic download or substituted demos.']};
for (const [index,clip] of corpus.clips.entries()) {
  const bytes=readFileSync(resolve(base,clip.file)); if(hash(bytes)!==clip.sha256) throw Error(`Input changed: ${clip.id}`);
  const input=decodeWav(bytes);
  for(const name of ['rnnoise','deepfilter','gtcrn','hush']) {
    let result;
    if(name==='hush') {
      const src=resolve(output,`${index}-hush-input.f32`), dst=resolve(output,`${index}-hush-output.f32`);
      const raw=Buffer.alloc(input.length*4); input.forEach((x,i)=>raw.writeFloatLE(x,i*4)); writeFileSync(src,raw);
      const metrics=JSON.parse(execFileSync('python3',[resolve(here,'hush.py'),resolve(here,'assets/libweya_nc.so'),resolve(here,'assets/hush-model.tar.gz'),src,dst],{encoding:'utf8'}));
      const b=readFileSync(dst), pcm=new Float32Array(b.length/4); pcm.forEach((_,i)=>pcm[i]=b.readFloatLE(i*4)); result={pcm,metrics};
    } else { const engine=await createEngine(name,load); try {result=processClip(engine,input);} finally {engine.destroy();} }
    const wav=encodeWav(result.pcm), file=`${index}-${name}.wav`; writeFileSync(resolve(output,file),wav);
    report.results.push({clip:clip.id,inputSha256:clip.sha256,engine:name,file,sha256:hash(wav),...result.metrics});
  }
  if(clip.reference) { const bytes=readFileSync(resolve(base,clip.reference.file)); if(hash(bytes)!==clip.reference.sha256) throw Error(`Reference changed: ${clip.id}`); decodeWav(bytes); const file=`${index}-krisp.wav`; writeFileSync(resolve(output,file),bytes); report.results.push({clip:clip.id,inputSha256:clip.sha256,engine:'krisp',...clip.reference,file}); }
}
writeFileSync(resolve(output,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(`Saved ${report.results.length} comparisons to ${output}; qualification remains pending.`);

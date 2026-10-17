// Build-time only. No model acquisition, external loader, or telemetry runs in the app.
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {noiseIdentity} from './noise-identity.mjs';
import {recheckQualification} from '../experiments/noise/qualification.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function validateRelease(report,review,lockHash,implementationHash){
  if(!implementationHash||report.implementationSha256!==implementationHash||review.implementationSha256!==implementationHash)throw Error('Qualification implementation does not match');
  if(report.candidate!=='deepfilter'||report.evidenceVerified!==true||!report.evidenceManifestSha256)throw Error('Bound qualification evidence is missing');
  if(report.assetLockSha256!==lockHash||review.assetLockSha256!==lockHash)throw Error('Qualification asset hashes do not match');
  if(!report.coverage?.complete||!report.runtime?.qualified||!report.listening?.qualified||report.reasons?.length)throw Error('Listening/runtime qualification has not passed');
  if(!review.reviewer||!review.date||review.modelLicense?.cleared!==true||!review.modelLicense.spdx||!review.modelLicense.source)throw Error('Exact model license review is missing');
  for(const check of ['matchedCapture','onsetWords','lifecycle','encryption','screenShare','sameOriginAssets','physicalBrowserMatrix'])if(review.checks?.[check]!==true)throw Error(`Release review missing: ${check}`);
  if(!Array.isArray(review.evidence)||!review.evidence.length)throw Error('Release evidence is missing');
}
export function noiseBuild(mode=process.env.DILLA_NOISE_MODE??'disabled'){
  if(!['disabled','evaluation','beta','qualified'].includes(mode))throw Error('DILLA_NOISE_MODE must be disabled, evaluation, beta, or qualified');
  let manifest={},files=[];
  if(mode!=='disabled'){
    const lockPath=resolve(root,'experiments/noise/asset-lock.json'),lockBytes=readFileSync(lockPath),lock=JSON.parse(lockBytes);
    if(mode==='qualified'){
      const report=JSON.parse(readFileSync(resolve(root,'experiments/noise/results/release-qualification.json')));
      const review=JSON.parse(readFileSync(resolve(root,'experiments/noise/results/release-review.json')));
      validateRelease(report,review,hash(lockBytes),noiseIdentity().implementationSha256);
      recheckQualification(report);
      for(const e of review.evidence){
        if(!e.path||!e.sha256||e.path.includes('..')||e.path.startsWith('/'))throw Error('Invalid evidence path');
        if(hash(readFileSync(resolve(root,e.path)))!==e.sha256)throw Error(`Release evidence changed: ${e.path}`);
      }
    }
    for(const [key,name] of Object.entries({glue:'df.mjs',wasm:'df_bg.wasm',model:'deepfilter-model.bin',detector:'rnnoise.wasm'})){
      const source=readFileSync(resolve(root,'experiments/noise/assets',name)),sha256=hash(source);
      if(sha256!==lock.sha256[name])throw Error(`Local noise asset changed: ${name}; run noise:prepare and requalify`);
      const ext=key==='glue'?'.js':name.slice(name.lastIndexOf('.')),fileName=`assets/noise-${key}-${sha256.slice(0,16)}${ext}`;
      manifest[key]={url:`/${fileName}`,sha256};if(key!=='detector')files.push({fileName,source});
    }
    files.push({fileName:'noise-build.json',source:JSON.stringify({mode,...noiseIdentity()})+'\n'});
    const notice=readFileSync(resolve(root,'experiments/noise/licenses/deepfilter-LICENSE-MIT'));
    files.push({fileName:'assets/noise-LICENSE-MIT.txt',source:notice});
    files.push({fileName:'assets/noise-LICENSE-APACHE.txt',source:readFileSync(resolve(root,'experiments/noise/licenses/deepfilter-LICENSE-APACHE'))});
  }
  return {
    name:'dilla-private-noise',
    enforce:'pre',
    config(){return {define:{__DILLA_NOISE_MODE__:JSON.stringify(mode)}};},
    resolveId(id){if(id==='virtual:dilla-noise-assets')return '\0dilla-noise-assets';},
    load(id){
      // Worker URL transforms emit assets before Rollup removes unreachable imports.
      if(mode==='disabled'&&id.replaceAll('\\','/').endsWith('/audio/enhanced-provider.ts'))return 'export async function createEnhanced(){return null}';
      if(id==='\0dilla-noise-assets')return mode==='disabled'?'export default {}':`import detectorUrl from ${JSON.stringify(resolve(root,'packages/media/src/audio/generated/rnnoise.wasm')+'?url')}; const assets=${JSON.stringify(manifest)}; assets.detector.url=detectorUrl; export default assets;`;},
    generateBundle(){for(const file of files)this.emitFile({type:'asset',...file});},
    configureServer(server){
      server.middlewares.use((req,res,next)=>{
        const file=files.find(f=>`/${f.fileName}`===req.url?.split('?')[0]);
        if(!file)return next();
        res.setHeader('Content-Type',file.fileName.endsWith('.js')?'text/javascript':file.fileName.endsWith('.wasm')?'application/wasm':'application/octet-stream');
        res.end(file.source);
      });
    },
  };
}

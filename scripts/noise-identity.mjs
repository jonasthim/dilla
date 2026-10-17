import{readFileSync,readdirSync}from'node:fs';
import{resolve,relative,dirname}from'node:path';
import{fileURLToPath}from'node:url';
import{createHash}from'node:crypto';
export const noiseRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export function noiseIdentity(){
  const files=[];
  const walk=dir=>{for(const entry of readdirSync(resolve(noiseRoot,dir),{withFileTypes:true})){const path=`${dir}/${entry.name}`;if(entry.isDirectory())walk(path);else if(/\.(ts|tsx|mjs|json)$/.test(path))files.push(path);}};
  for(const dir of ['packages/media/src/audio','packages/web/src/call','packages/web/src/screens/settings'])walk(dir);
  files.push('packages/web/src/screens/voice/useCall.tsx','packages/web/vite.config.ts','package-lock.json','scripts/noise-build.mjs','scripts/noise-identity.mjs','experiments/noise/engines.mjs');
  const digest=createHash('sha256');
  for(const file of files.sort()){digest.update(file+'\0');digest.update(readFileSync(resolve(noiseRoot,file)));digest.update('\0');}
  return {assetLockSha256:sha256(readFileSync(resolve(noiseRoot,'experiments/noise/asset-lock.json'))),implementationSha256:digest.digest('hex')};
}
export function evidenceFile(path){
  const rel=relative(noiseRoot,resolve(path));
  if(rel.startsWith('..')||rel.startsWith('/'))throw Error('Qualification evidence must be stored within the repository');
  const bytes=readFileSync(resolve(noiseRoot,rel));return {path:rel,sha256:sha256(bytes),value:JSON.parse(bytes)};
}

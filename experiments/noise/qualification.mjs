import{resolve}from'node:path';
import{noiseRoot,evidenceFile,noiseIdentity}from'../../scripts/noise-identity.mjs';
import{validateCorpus,summarizeRatings,runtimeVerdict,decodeRatings}from'./benchmark.mjs';
import{validateEvidence}from'./evidence.mjs';
export function qualify(paths){
  const files=Object.fromEntries(['corpus','runtime','ratings','blindKey','evidence','outputIndex'].map(k=>[k,evidenceFile(paths[k])]));
  const v=k=>files[k].value,identity=noiseIdentity();
  const ratings=decodeRatings(v('ratings'),v('blindKey'));
  const hashes={...identity,...Object.fromEntries(['corpus','runtime','ratings','blindKey','outputIndex'].map(k=>[`${k}Sha256`,files[k].sha256]))};
  validateEvidence(v('evidence'),{corpus:v('corpus'),ratings,runtime:v('runtime'),output:v('outputIndex'),hashes,keys:v('blindKey')});
  const coverage=validateCorpus(v('corpus')),runtime=runtimeVerdict(v('runtime')),listening=summarizeRatings(ratings,'deepfilter');
  const reasons=[...coverage.complete?[]:['Corpus coverage or matched references incomplete'],...runtime.reasons,...listening.reasons];
  return {...identity,candidate:'deepfilter',evidenceVerified:true,evidenceManifestSha256:files.evidence.sha256,inputs:Object.fromEntries(Object.entries(files).map(([k,{path,sha256}])=>[k,{path,sha256}])),qualified:reasons.length===0,parityClaim:false,releaseReviewRequired:true,coverage,runtime,listening,reasons};
}
export function recheckQualification(report){
  const paths={};
  for(const k of ['corpus','runtime','ratings','blindKey','evidence','outputIndex']){
    const f=report.inputs?.[k];if(!f?.path||!f.sha256)throw Error(`Missing qualification source: ${k}`);
    const file=evidenceFile(resolve(noiseRoot,f.path));if(file.sha256!==f.sha256)throw Error(`Qualification source changed: ${k}`);paths[k]=resolve(noiseRoot,file.path);
  }
  const actual=qualify(paths);
  if(!actual.qualified||actual.evidenceManifestSha256!==report.evidenceManifestSha256)throw Error('Recomputed qualification failed');
  return actual;
}

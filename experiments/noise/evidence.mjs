/** Bind what was listened to and timed to the candidate being qualified. Never infer provenance. */
export function validateEvidence(e,{corpus,ratings,runtime,output,hashes,keys}){
  const hash=/^[a-f0-9]{64}$/;
  if(e.schema!==1||e.candidate!=='deepfilter')throw Error('Missing DeepFilter evidence manifest');
  for(const k of ['assetLockSha256','implementationSha256','corpusSha256','outputIndexSha256','ratingsSha256','blindKeySha256','runtimeSha256'])if(!hash.test(e[k])||e[k]!==hashes[k])throw Error(`Evidence identity mismatch: ${k}`);
  if(output.assetLockSha256!==e.assetLockSha256||output.implementationSha256!==e.implementationSha256)throw Error('Outputs measure another asset set or implementation');
  if(!Array.isArray(e.clips)||e.clips.length!==corpus.clips.length||new Set(e.clips.map(c=>c.id)).size!==e.clips.length)throw Error('Evidence corpus mismatch');
  const ids=new Set(corpus.clips.map(c=>c.id));
  if(ratings.some(r=>!ids.has(r.clip)))throw Error('Ratings name clips outside this corpus');
  for(const c of corpus.clips){
    const m=e.clips.find(x=>x.id===c.id);
    if(m?.inputSha256!==c.sha256)throw Error('Input hash mismatch');
    for(const engine of ['deepfilter','krisp']){
      const rows=output.results.filter(r=>r.clip===c.id&&r.engine===engine);
      if(rows.length!==1||rows[0].inputSha256!==c.sha256||!hash.test(m.outputs?.[engine])||rows[0].sha256!==m.outputs[engine])throw Error(`Output hash mismatch: ${c.id}/${engine}`);
    }
    if(c.reference?.sha256!==m.outputs.krisp)throw Error('Krisp reference hash mismatch');
  }
  if(!runtime.length||new Set(runtime.map(r=>r.platform)).size!==runtime.length)throw Error('Missing or duplicate runtime platform');
  for(const r of runtime)if(r.engine!=='deepfilter'||r.assetLockSha256!==e.assetLockSha256||r.implementationSha256!==e.implementationSha256)throw Error('Runtime measures another engine, asset set or implementation');
  if(keys){
    for(const rating of ratings){
      const key=(keys.listeners?keys.listeners[rating.listener]?.key:keys.key)?.find(k=>k.code===rating.code);
      const m=e.clips.find(c=>c.id===rating.clip);
      if(['deepfilter','krisp'].includes(rating.engine)&&(key?.sha256!==m?.outputs[rating.engine]||key?.inputSha256!==m?.inputSha256))throw Error('Blind key is not bound to the rated audio');
    }
  }
}

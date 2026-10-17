import{test}from'node:test';import assert from'node:assert/strict';
import{validateEvidence}from'./evidence.mjs';
const h='a'.repeat(64),old='b'.repeat(64);
function evidence(){return {schema:1,candidate:'deepfilter',assetLockSha256:h,implementationSha256:h,corpusSha256:h,outputIndexSha256:h,ratingsSha256:h,blindKeySha256:h,runtimeSha256:h,clips:[{id:'speech-1',inputSha256:h,outputs:{deepfilter:h,krisp:old}}]};}
const corpus={clips:[{id:'speech-1',sha256:h,reference:{sha256:old}}]};
const ratings=[{listener:'one',clip:'speech-1',engine:'deepfilter'}];
const runtime=[{platform:'desktop-chrome',engine:'deepfilter',assetLockSha256:h,implementationSha256:h}];
const hashes={assetLockSha256:h,implementationSha256:h,corpusSha256:h,outputIndexSha256:h,ratingsSha256:h,blindKeySha256:h,runtimeSha256:h};
const output={assetLockSha256:h,implementationSha256:h,results:[{clip:'speech-1',engine:'deepfilter',inputSha256:h,sha256:h},{clip:'speech-1',engine:'krisp',inputSha256:h,sha256:old}]};
test('qualification binds clip IDs, candidate outputs and runtime to the exact measured assets and implementation',()=>{
 assert.doesNotThrow(()=>validateEvidence(evidence(),{corpus,ratings,runtime,output,hashes}));
 assert.throws(()=>validateEvidence(evidence(),{corpus,ratings:[{...ratings[0],clip:'unrelated'}],runtime,output,hashes}));
 assert.throws(()=>validateEvidence(evidence(),{corpus,ratings,runtime:[{...runtime[0],engine:'rnnoise'}],output,hashes}));
 assert.throws(()=>validateEvidence(evidence(),{corpus,ratings,runtime:[{...runtime[0],assetLockSha256:old}],output,hashes}));
 assert.throws(()=>validateEvidence(evidence(),{corpus,ratings,runtime,output,hashes:{...hashes,implementationSha256:old}}));
 assert.throws(()=>validateEvidence(evidence(),{corpus,ratings,runtime,output:{...output,results:[{...output.results[0],sha256:old},output.results[1]]},hashes}));
});

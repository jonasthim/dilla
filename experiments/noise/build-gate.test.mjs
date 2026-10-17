import { test } from 'node:test';
import assert from 'node:assert/strict';
import {noiseBuild,validateRelease} from '../../scripts/noise-build.mjs';
test('ordinary builds have no enhanced assets and reject unknown enablement modes',()=>{
  const plugin=noiseBuild('disabled'),emitted=[];
  plugin.generateBundle.call({emitFile:f=>emitted.push(f)});
  assert.deepEqual(emitted,[]);
  assert.throws(()=>noiseBuild('true'));
});
test('release gate requires matching assets, completed qualification and reviewed evidence',()=>{
  const report={candidate:'deepfilter',evidenceVerified:true,evidenceManifestSha256:'manifest',implementationSha256:'code',assetLockSha256:'abc',coverage:{complete:true},runtime:{qualified:true},listening:{qualified:true},reasons:[]};
  const review={implementationSha256:'code',assetLockSha256:'abc',reviewer:'Reviewer',date:'2026-10-17',modelLicense:{cleared:true,spdx:'MIT',source:'license grant'},checks:Object.fromEntries(['matchedCapture','onsetWords','lifecycle','encryption','screenShare','sameOriginAssets','physicalBrowserMatrix'].map(k=>[k,true])),evidence:[{path:'report.json',sha256:'hash'}]};
  assert.doesNotThrow(()=>validateRelease(report,review,'abc','code'));
  assert.throws(()=>validateRelease(report,review,'changed','code'));
  assert.throws(()=>validateRelease({...report,listening:{qualified:false}},review,'abc','code'));
  assert.throws(()=>validateRelease(report,{...review,modelLicense:{cleared:false}},'abc','code'));
  assert.throws(()=>validateRelease(report,{...review,checks:{}},'abc','code'));
  assert.throws(()=>validateRelease(report,{...review,evidence:[]},'abc','code'));
});
test('disabled builds prune the provider before Vite can emit Worker assets',()=>{
  const source=noiseBuild('disabled').load('/repo/packages/media/src/audio/enhanced-provider.ts');
  assert.ok(source&&!source.includes('import('),'A disabled provider must not reach Vite worker URL transforms');
});

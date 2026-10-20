import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('./release-noise-mode.mjs',import.meta.url));
test('every release tag bundles the enhancement',()=>{
  for(const tag of ['v0.1.0-noise-beta.1','v1.2.3-noise-beta.12','v0.1.0-web3.8','v0.1.0-web3.7.2','v1.0.0','v0.1.0-noise-beta.1-extra','feature/noise-beta.1','']){
    const r=spawnSync(process.execPath,[script,tag],{encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.trim(),'beta',tag);
  }
});

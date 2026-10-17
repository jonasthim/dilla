import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('./release-noise-mode.mjs',import.meta.url));
test('only explicit noise-beta release tags bundle opt-in enhancement',()=>{
  for(const [tag,want] of [['v0.1.0-noise-beta.1','beta'],['v1.2.3-noise-beta.12','beta'],['v0.1.0-web3.7.2','disabled'],['v1.0.0','disabled'],['v0.1.0-noise-beta.1-extra','disabled'],['feature/noise-beta.1','disabled']]){
    const r=spawnSync(process.execPath,[script,tag],{encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.trim(),want,tag);
  }
});

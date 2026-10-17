// Build-time network only. Runtime never fetches an upstream URL.
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
const assets = resolve(here, 'assets'), work = resolve(here, 'work');
mkdirSync(assets, {recursive:true}); mkdirSync(work, {recursive:true});
const sources = {
  deepfilter: {url:'https://github.com/Rikorose/DeepFilterNet.git', revision:'d375b2d8309e0935d165700c91da9de862a99c31'},
  hush: {url:'https://github.com/pulp-vision/Hush.git', revision:'9f6414e91461a8f4bdf9840c0cdcdcb7da986339'},
};
const run = (cmd, args, cwd = here) => execFileSync(cmd, args, {cwd, stdio:'inherit'});
for (const [name, s] of Object.entries(sources)) {
  // Optional source checkouts avoid downloads on a developer machine; revision is always verified.
  const src = process.env[`NOISE_${name.toUpperCase()}_SOURCE`] ?? resolve(work, name);
  if (!existsSync(src)) { run('git', ['init', src]); run('git', ['-C', src, 'fetch', '--depth', '1', s.url, s.revision]); run('git', ['-C', src, 'checkout', '--detach', 'FETCH_HEAD']); }
  const actual = execFileSync('git', ['-C', src, 'rev-parse', 'HEAD'], {encoding:'utf8'}).trim();
  if (actual !== s.revision || execFileSync('git', ['-C', src, 'status', '--porcelain', '--untracked-files=no'], {encoding:'utf8'}).trim()) throw Error(`Unpinned/modified ${name} source`);
  if (name === 'deepfilter') {
    const output = resolve(work, 'df-wasm');
    copyFileSync(resolve(here, 'deepfilter-Cargo.lock'), resolve(src, 'Cargo.lock'));
    try { run('git', ['-C', src, 'apply', resolve(here, 'deepfilter-free.patch')]);
    run('wasm-pack', ['build', 'libDF', '--target', 'web', '--release', '--out-dir', output, '--', '--locked', '--no-default-features', '--features', 'wasm'], src); } finally { writeFileSync(resolve(src, 'Cargo.lock'), execFileSync('git', ['-C', src, 'show', 'HEAD:Cargo.lock'])); writeFileSync(resolve(src, 'libDF/src/wasm.rs'), execFileSync('git', ['-C', src, 'show', 'HEAD:libDF/src/wasm.rs'])); }
    for (const f of ['df.js', 'df_bg.wasm']) copyFileSync(resolve(output, f), resolve(assets, f === 'df.js' ? 'df.mjs' : f));
    copyFileSync(resolve(src, 'models/DeepFilterNet3_onnx.tar.gz'), resolve(assets, 'deepfilter-model.bin'));
    for (const f of ['LICENSE', 'LICENSE-MIT', 'LICENSE-APACHE']) copyFileSync(resolve(src, f), resolve(here, 'licenses', `deepfilter-${f}`));
  } else {
    // Pinned upstream Linux x64 binary for the offline challenger, not a browser dependency.
    copyFileSync(resolve(src, 'deployment/lib/libweya_nc.so'), resolve(assets, 'libweya_nc.so'));
    copyFileSync(resolve(src, 'deployment/models/advanced_dfnet16k_model_best_onnx.tar.gz'), resolve(assets, 'hush-model.tar.gz'));
    copyFileSync(resolve(src, 'LICENSE'), resolve(here, 'licenses/hush-LICENSE'));
  }
}
run('npm', ['pack', '@sapphi-red/gtcrn-wasm@0.0.3', '--pack-destination', assets]);
const tgz = resolve(assets, 'sapphi-red-gtcrn-wasm-0.0.3.tgz');
if (`sha512-${createHash('sha512').update(readFileSync(tgz)).digest('base64')}` !== 'sha512-2GRgtytMrE+UsZwuKYY9u6RfTBhYD1O7x6IG8Uh+MeVPubRpECDfzOl2CjekdUtAxg5XC6S1nFI04z3qbDZxkg==') throw Error('GTCRN integrity mismatch');
run('tar', ['-xzf', tgz, '-C', assets]);
copyFileSync(resolve(assets, 'package/LICENSE'), resolve(here, 'licenses/gtcrn-LICENSE'));
run('node', ['packages/media/scripts/extract-rnnoise-wasm.mjs'], resolve(here, '../..'));
copyFileSync(resolve(here, '../../packages/media/src/audio/generated/rnnoise.wasm'), resolve(assets, 'rnnoise.wasm'));
const hashes = {};
function scan(dir) { for (const e of readdirSync(dir, {withFileTypes:true})) { const p = resolve(dir, e.name); if (e.isDirectory()) scan(p); else hashes[p.slice(assets.length + 1)] = createHash('sha256').update(readFileSync(p)).digest('hex'); } }
scan(assets);
writeFileSync(resolve(here, 'asset-lock.json'), JSON.stringify({sources, gtcrn:'@sapphi-red/gtcrn-wasm@0.0.3', rnnoise:'@jitsi/rnnoise-wasm@0.2.1', toolchain:{node:process.version, rust:execFileSync('rustc',['--version'],{encoding:'utf8'}).trim(), wasmPack:execFileSync('wasm-pack',['--version'],{encoding:'utf8'}).trim()}, sha256:hashes},null,2)+'\n');

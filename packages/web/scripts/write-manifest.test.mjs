// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkDist, ALLOWED_EXTENSIONS } from './write-manifest.mjs';
// The one manifest implementation (task 18, ruling 37); its own test owns the manifest's content.
import { buildManifest, MANIFEST_NAME } from '../../../scripts/write-manifest.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'write-manifest.mjs');
const WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const INDEX = '<!doctype html><html lang="en"><head>'
  + '<script type="module" crossorigin src="/assets/index-AbC123.js"></script>'
  + '<link rel="stylesheet" crossorigin href="/assets/index-Def456.css"></head>'
  + '<body><div id="root" class="d-root"></div></body></html>\n';

let dir;
function put(path, content) {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}
function validDist() {
  put('index.html', INDEX);
  put('assets/index-AbC123.js', 'export {};\n');
  put('assets/index-Def456.css', 'body{margin:0}\n');
  put('assets/entry-Ghi789.js', 'self.onmessage=null;\n');
  put('assets/dilla_core_wasm_bg-Jkl012.wasm', WASM);
  put('favicon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dilla-web-dist-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('checkDist', () => {
  it('accepts a servable build', () => {
    validDist();
    expect(checkDist(dir)).toEqual([]);
  });
  it('names the served extensions of the dillad content-type table', () => {
    expect(ALLOWED_EXTENSIONS).toEqual(['.html', '.js', '.css', '.wasm', '.json', '.woff2', '.woff', '.svg', '.png', '.ico', '.txt']);
  });
  it('refuses an inline script, an inline style and a style attribute', () => {
    validDist();
    put('index.html', INDEX.replace('<body>', '<body><script>window.x = 1</script><style>p{}</style><p style="color:red">x</p>'));
    expect(checkDist(dir)).toEqual([
      'index.html: inline <script>',
      'index.html: inline <style>',
      'index.html: style attribute',
    ]);
  });
  it('refuses a font or an octet stream inlined as a data: URL', () => {
    validDist();
    put('assets/index-Def456.css', '@font-face{src:url(data:font/woff2;base64,AAAA)}\n');
    put('assets/entry-Ghi789.js', 'const w="data:application/octet-stream;base64,AGFzbQ==";\n');
    expect(checkDist(dir)).toEqual([
      'assets/entry-Ghi789.js: contains data:application/octet-stream;base64',
      'assets/index-Def456.css: contains data:font',
    ]);
  });
  it('refuses a file dillad would not serve', () => {
    validDist();
    put('assets/index-AbC123.js.map', '{}\n');
    put('LICENSE', 'text\n');
    expect(checkDist(dir)).toEqual([
      'LICENSE: extension (none) is not served',
      'assets/index-AbC123.js.map: extension .map is not served',
    ]);
  });
  it('wants exactly one wasm and an index.html', () => {
    put('assets/a.js', 'export {};\n');
    expect(checkDist(dir)).toEqual(['index.html is missing', 'expected exactly 1 .wasm file, found 0']);
    put('index.html', INDEX);
    put('assets/one.wasm', WASM);
    put('assets/two.wasm', WASM);
    expect(checkDist(dir)).toEqual(['expected exactly 1 .wasm file, found 2']);
  });
});

describe('the command', () => {
  it('writes the root writer’s manifest of a servable build', () => {
    validDist();
    const r = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(MANIFEST_NAME).toBe('dilla-manifest.json');
    const written = readFileSync(join(dir, MANIFEST_NAME), 'utf8');
    // buildManifest skips the manifest itself, so computing it after the write sees the same tree.
    expect(written).toBe(JSON.stringify(buildManifest(dir)) + '\n');
  });
  it('refuses a build that is not servable and writes nothing', () => {
    validDist();
    put('index.html', INDEX.replace('<body>', '<body><script>window.x = 1</script>'));
    const r = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('index.html: inline <script>');
    expect(existsSync(join(dir, MANIFEST_NAME))).toBe(false);
  });
  it('prints its usage without an argument', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('usage: write-manifest.mjs <dist-dir>');
  });
});

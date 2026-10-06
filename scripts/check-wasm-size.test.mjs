import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WASM_MAX_BYTES, WASM_MAX_NAME_SECTION, checkWasm } from './check-wasm-size.mjs';

const SCRIPT = fileURLToPath(new URL('./check-wasm-size.mjs', import.meta.url));
const HEADER = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

/** Unsigned LEB128, as the wasm binary format writes section sizes. */
function leb(n) {
  const out = [];
  let v = n;
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v !== 0) b |= 0x80;
    out.push(b);
  } while (v !== 0);
  return out;
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function section(id, payload) {
  return concat(Uint8Array.from([id, ...leb(payload.length)]), payload);
}

/** A custom section whose payload, name field included, is exactly `size` bytes. */
function custom(name, size) {
  const nameBytes = new TextEncoder().encode(name);
  const head = Uint8Array.from([...leb(nameBytes.length), ...nameBytes]);
  assert.ok(size >= head.length, 'fixture sanity: the payload holds the name');
  const payload = new Uint8Array(size);
  payload.set(head, 0);
  return section(0, payload);
}

function wasmModule(...sections) {
  return concat(HEADER, ...sections);
}

/** A module of exactly `total` bytes: `rest` plus one custom section "pad" sized to fill. */
function moduleOfSize(total, ...rest) {
  const used = HEADER.length + rest.reduce((n, s) => n + s.length, 0);
  // id byte + a 4-byte LEB size (every pad here is between 2^21 and 2^28 bytes).
  const pad = custom('pad', total - used - 1 - 4);
  const bytes = wasmModule(...rest, pad);
  assert.equal(bytes.length, total, 'fixture sanity: the module has the intended size');
  return bytes;
}

function writeTemp(bytes) {
  const dir = mkdtempSync(join(tmpdir(), 'dilla-wasm-size-'));
  const file = join(dir, 'm.wasm');
  writeFileSync(file, bytes);
  return file;
}

test('the bounds are the ruled values', () => {
  assert.equal(WASM_MAX_BYTES, 3_400_000);
  assert.equal(WASM_MAX_NAME_SECTION, 4_096);
});

test('an empty module passes', () => {
  assert.deepEqual(checkWasm(wasmModule()), []);
});

test('a name section of exactly the bound passes', () => {
  assert.deepEqual(checkWasm(wasmModule(custom('name', 4096))), []);
});

test('a name section one byte over the bound is reported with its size', () => {
  assert.deepEqual(checkWasm(wasmModule(custom('name', 4097))), [
    'name section is 4097 bytes, above the 4096-byte bound: build with --profile wasm-release (strip = true, C16)',
  ]);
});

test('every custom section named "name" counts toward the bound', () => {
  const problems = checkWasm(wasmModule(custom('name', 3000), custom('name', 1100)));
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /^name section is 4100 bytes/);
});

test('other custom sections and non-custom sections do not count', () => {
  const bytes = wasmModule(custom('producers', 10_000), custom('names', 5000), section(1, new Uint8Array(5000)));
  assert.deepEqual(checkWasm(bytes), []);
});

test('a module of exactly the budget passes', () => {
  assert.deepEqual(checkWasm(moduleOfSize(3_400_000)), []);
});

test('a module one byte over the budget is reported', () => {
  assert.deepEqual(checkWasm(moduleOfSize(3_400_001)), [
    'wasm is 3400001 bytes, above the 3400000-byte budget (web-1 ruling 23)',
  ]);
});

test('both violations are reported, size first', () => {
  const problems = checkWasm(moduleOfSize(3_400_001, custom('name', 5000)));
  assert.equal(problems.length, 2, problems.join('\n'));
  assert.match(problems[0], /^wasm is 3400001 bytes/);
  assert.match(problems[1], /^name section is 5000 bytes/);
});

test('a bad magic is not a wasm module', () => {
  assert.deepEqual(checkWasm(Uint8Array.from([0x00, 0x61, 0x73, 0x6e, 0x01, 0x00, 0x00, 0x00])), [
    'not a wasm module: bad magic or version',
  ]);
});

test('a version other than 1 is not a wasm module', () => {
  assert.deepEqual(checkWasm(Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x02, 0x00, 0x00, 0x00])), [
    'not a wasm module: bad magic or version',
  ]);
});

test('a header shorter than 8 bytes is not a wasm module', () => {
  assert.deepEqual(checkWasm(Uint8Array.from([0x00, 0x61, 0x73])), ['not a wasm module: bad magic or version']);
});

test('a section that runs past the end is malformed', () => {
  const bytes = wasmModule(Uint8Array.from([0, ...leb(100), 4, 0x6e, 0x61, 0x6d, 0x65]));
  assert.deepEqual(checkWasm(bytes), ['malformed wasm: section at offset 8 runs past the end']);
});

test('an unterminated size field is malformed', () => {
  assert.deepEqual(checkWasm(wasmModule(Uint8Array.from([0, 0x80]))), [
    'malformed wasm: unterminated size at offset 8',
  ]);
});

test('a custom section name longer than its section is malformed', () => {
  assert.deepEqual(checkWasm(wasmModule(Uint8Array.from([0, 2, 9, 0x6e]))), [
    'malformed wasm: custom section name at offset 8 runs past its section',
  ]);
});

test('the CLI without an argument prints its usage and exits 2', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /usage: check-wasm-size\.mjs <file\.wasm>/);
});

test('the CLI on a missing file exits 2', () => {
  const r = spawnSync(process.execPath, [SCRIPT, join(tmpdir(), 'no-such-dilla-file.wasm')], { encoding: 'utf8' });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /check-wasm-size: cannot read /);
});

test('the CLI prints both numbers and exits 0 within the bounds', () => {
  const bytes = wasmModule(custom('name', 10));
  const file = writeTemp(bytes);
  const r = spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `${file}: ${bytes.length} bytes (budget 3400000), name section 10 bytes (bound 4096)`);
  assert.equal(r.stderr, '');
});

test('the CLI reports a violation on stderr and exits 1', () => {
  const bytes = wasmModule(custom('name', 5000));
  const file = writeTemp(bytes);
  const r = spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^check-wasm-size: name section is 5000 bytes, above the 4096-byte bound/m);
  assert.equal(r.stdout.trim(), `${file}: ${bytes.length} bytes (budget 3400000), name section 5000 bytes (bound 4096)`);
});

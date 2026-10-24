import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyShippingCoreWasmInDist } from './shipping-wasm.mjs';

const header = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dilla-shipping-wasm-'));
  const assets = join(root, 'assets');
  mkdirSync(assets);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, assets };
}

function writeArtifact(root, assets, name = 'dilla_core_wasm_bg-Test123.wasm', bytes = Buffer.concat([header, Buffer.alloc(64)])) {
  writeFileSync(join(assets, name), bytes);
  const path = `assets/${name}`;
  const files = [{ path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }];
  writeFileSync(join(root, 'dilla-manifest.json'), JSON.stringify({ v: 1, files }));
  return join(assets, name);
}

test('accepts only the hashed core wasm named by the matching shipping manifest', t => {
  const { root, assets } = fixture(t);
  const expected = writeArtifact(root, assets);
  assert.equal(verifyShippingCoreWasmInDist(root), expected);
});

test('rejects missing or ambiguous core wasm artifacts', t => {
  const { root, assets } = fixture(t);
  assert.throws(() => verifyShippingCoreWasmInDist(root), /exactly one hashed core WASM/u);
  writeArtifact(root, assets);
  writeArtifact(root, assets, 'dilla_core_wasm_bg-Other456.wasm');
  assert.throws(() => verifyShippingCoreWasmInDist(root), /exactly one hashed core WASM/u);
});

test('rejects an artifact whose bytes disagree with the shipping manifest', t => {
  const { root, assets } = fixture(t);
  writeArtifact(root, assets);
  const altered = Buffer.concat([header, Buffer.alloc(63), Buffer.from([1])]);
  writeFileSync(join(assets, 'dilla_core_wasm_bg-Test123.wasm'), altered);
  assert.throws(() => verifyShippingCoreWasmInDist(root), /does not match its shipping manifest/u);
});


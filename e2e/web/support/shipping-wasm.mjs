import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const CORE_WASM = /^dilla_core_wasm_bg-[\w-]+\.wasm$/u;
const WASM_HEADER = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const MAX_CORE_WASM_BYTES = 3_500_000;

/** Verify the hashed core wasm named by the downloaded shipping manifest. */
export function verifyShippingCoreWasmInDist(webDistRoot) {
  const assetsRoot = join(webDistRoot, 'assets');
  const candidates = readdirSync(assetsRoot).filter(name => CORE_WASM.test(name));
  if (candidates.length !== 1) {
    throw new Error('web dist must contain exactly one hashed core WASM artifact');
  }

  const name = candidates[0];
  const path = join(assetsRoot, name);
  const bytes = readFileSync(path);
  if (bytes.length < WASM_HEADER.length || bytes.length > MAX_CORE_WASM_BYTES || !WASM_HEADER.equals(bytes.subarray(0, WASM_HEADER.length))) {
    throw new Error('web dist core WASM artifact has an invalid module shape');
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(webDistRoot, 'dilla-manifest.json'), 'utf8'));
  } catch {
    throw new Error('web dist shipping manifest is missing or invalid');
  }
  if (manifest?.v !== 1 || !Array.isArray(manifest.files)) {
    throw new Error('web dist shipping manifest has an unsupported shape');
  }
  const entries = manifest.files.filter(file => file?.path === `assets/${name}`);
  const expectedHash = createHash('sha256').update(bytes).digest('hex');
  if (entries.length !== 1 || entries[0].size !== bytes.length || entries[0].sha256 !== expectedHash) {
    throw new Error('web dist core WASM artifact does not match its shipping manifest');
  }
  return path;
}


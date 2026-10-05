// DEV-37: @jitsi/rnnoise-wasm 0.2.1's sync build inlines its wasm as a base64 data URI and decodes it
// with `atob`, which AudioWorkletGlobalScope does not have (G40 c), so the worklet would run a pure-JS
// decode of 1.92 MB plus a synchronous compile on the audio thread. The bytes are extracted here,
// at build time, and compiled off the audio thread by DillaRnnoiseProcessor.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATA_URI_PREFIX = 'data:application/octet-stream;base64,';

export function rnnoiseSyncPath() {
  return createRequire(import.meta.url).resolve('@jitsi/rnnoise-wasm/dist/rnnoise-sync.js');
}

export function extractRnnoiseWasm(source) {
  // The bundle also declares the prefix as a string constant before the actual wasm URI.
  const at = source.lastIndexOf(DATA_URI_PREFIX);
  if (at < 0) throw new Error(`rnnoise-sync.js carries no ${DATA_URI_PREFIX} URI`);
  const b64 = /^[A-Za-z0-9+/=]+/.exec(source.slice(at + DATA_URI_PREFIX.length))?.[0] ?? '';
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x0061736d) {
    throw new Error('the inlined payload is not a WebAssembly module');
  }
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const here = dirname(fileURLToPath(import.meta.url));
  const out = join(here, '..', 'src', 'audio', 'generated', 'rnnoise.wasm');
  const { bytes, sha256 } = extractRnnoiseWasm(readFileSync(rnnoiseSyncPath(), 'utf8'));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, bytes);
  console.log(`${sha256}  ${bytes.length}`);
}

/**
 * Gate the browser core's raw wasm size (web-1 ruling 23, L-CI-02).
 * The `name` section is bounded separately: strip = true removes it, so a
 * large one means wasm-pack did not use the wasm-release profile.
 */
import { readFileSync } from 'node:fs';

export const WASM_MAX_BYTES = 3_400_000;
export const WASM_MAX_NAME_SECTION = 4_096;

const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

/** Read an unsigned LEB128 encoded in at most five bytes. */
function readLeb(bytes, at) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (at + i >= bytes.length) return null;
    const byte = bytes[at + i];
    value += (byte & 0x7f) * 2 ** (7 * i);
    if ((byte & 0x80) === 0) return { value, next: at + i + 1 };
  }
  return null;
}

function nameSectionSize(bytes) {
  let size = 0;
  let at = HEADER.length;
  while (at < bytes.length) {
    const offset = at;
    const id = bytes[at++];
    const payload = readLeb(bytes, at);
    if (!payload) return { problem: `malformed wasm: unterminated size at offset ${offset}` };
    const end = payload.next + payload.value;
    if (end > bytes.length) return { problem: `malformed wasm: section at offset ${offset} runs past the end` };
    if (id === 0) {
      const nameLength = readLeb(bytes.subarray(0, end), payload.next);
      if (!nameLength || nameLength.next + nameLength.value > end) {
        return { problem: `malformed wasm: custom section name at offset ${offset} runs past its section` };
      }
      const name = new TextDecoder().decode(bytes.subarray(nameLength.next, nameLength.next + nameLength.value));
      if (name === 'name') size += payload.value;
    }
    at = end;
  }
  return { size };
}

/** Return one problem per exceeded bound, or one problem for malformed input. */
export function checkWasm(bytes) {
  if (bytes.length < HEADER.length || HEADER.some((b, i) => bytes[i] !== b)) {
    return ['not a wasm module: bad magic or version'];
  }
  const name = nameSectionSize(bytes);
  if (name.problem) return [name.problem];
  const problems = [];
  if (bytes.length > WASM_MAX_BYTES) {
    problems.push(`wasm is ${bytes.length} bytes, above the 3400000-byte budget (web-1 ruling 23)`);
  }
  if (name.size > WASM_MAX_NAME_SECTION) {
    problems.push(`name section is ${name.size} bytes, above the 4096-byte bound: build with --profile wasm-release (strip = true, C16)`);
  }
  return problems;
}

if (import.meta.url === 'file://' + process.argv[1]) {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: check-wasm-size.mjs <file.wasm>');
    process.exit(2);
  }
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    console.error(`check-wasm-size: cannot read ${path}: ${error.message}`);
    process.exit(2);
  }
  const problems = checkWasm(bytes);
  const name = bytes.length >= HEADER.length && HEADER.every((b, i) => bytes[i] === b)
    ? nameSectionSize(bytes) : null;
  if (name && !name.problem) {
    console.log(`${path}: ${bytes.length} bytes (budget 3400000), name section ${name.size} bytes (bound 4096)`);
  }
  for (const problem of problems) console.error(`check-wasm-size: ${problem}`);
  process.exit(problems.length === 0 ? 0 : 1);
}

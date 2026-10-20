// Types for the e2e typecheck (e2e/tests/core-handle.spec.ts imports checkWasm).
export const WASM_MAX_BYTES: number;
export const WASM_MAX_NAME_SECTION: number;
export function checkWasm(bytes: Uint8Array): string[];

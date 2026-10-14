/// <reference types="vite/client" />
// The web build's stand-in for packages/media/src/wasm-url.ts (vite.config.ts aliases that module here): the media
// worker loads the very wasm file the core worker's glue loads, so Vite emits it once and the browser downloads it
// once (web-3 decision 5).
import coreWasmUrl from '@dilla/core-wasm/wasm?url';

export const MEDIA_WASM_URL: string = new URL(coreWasmUrl, import.meta.url).href;

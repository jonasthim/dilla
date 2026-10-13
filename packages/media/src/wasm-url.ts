/**
 * The core wasm the media worker loads (MD-4). It lives in its own module so an app bundler can alias this one
 * file to the core wasm it already ships, and the browser downloads that wasm once (web-3 decision 5). Vite
 * resolves this `new URL` pattern relative to this file and applies no alias to it, so an alias must replace the
 * module, not the path.
 */
export const MEDIA_WASM_URL: string = new URL('../wasm/dilla_core_wasm_bg.wasm', import.meta.url).href;

import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const rnnoiseSource = /rnnoise-sync\.js$/;
const inlineWasm = /wasmBinaryFile\s*=\s*"data:application\/octet-stream;base64,[A-Za-z0-9+/=]+"/;
function stripUnusedInlineWasm(source: string): string {
  const stripped = source.replace(inlineWasm, 'wasmBinaryFile = ""');
  if (stripped === source) throw new Error('RNNoise dependency changed: the unused inline wasm was not found');
  return stripped;
}

// The Playwright media harness (e2e/playwright.media.config.ts starts it on 5179). 127.0.0.1 is a
// potentially trustworthy origin, so isSecureContext is true and the encoded-transform APIs exist.
export default defineConfig({
  root: resolve(here, 'harness'),
  plugins: [{
    name: 'dilla-rnnoise-wasm-required',
    configResolved() {
      if (!existsSync(resolve(here, 'src/audio/generated/rnnoise.wasm'))) {
        throw new Error('RNNoise wasm is missing: run node packages/media/scripts/extract-rnnoise-wasm.mjs before starting the harness');
      }
    },
    transform(source, id) {
      if (rnnoiseSource.test(id)) return stripUnusedInlineWasm(source);
      return undefined;
    },
  }],
  optimizeDeps: {
    entries: ['index.html', '../src/audio/rnnoise-worklet.ts', '../src/worker/*.ts'],
    include: ['livekit-client', 'events', '@jitsi/rnnoise-wasm/dist/rnnoise-sync.js'],
    esbuildOptions: { plugins: [{
      name: 'strip-rnnoise-inline-wasm',
      setup(build) {
        build.onLoad({ filter: rnnoiseSource }, (args) => ({ contents: stripUnusedInlineWasm(readFileSync(args.path, 'utf8')), loader: 'js' }));
      },
    }] },
  },
  server: { host: '127.0.0.1', port: 5179, strictPort: true },
  worker: { format: 'es' },
  build: { target: 'es2022' },
});

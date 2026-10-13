import { defineConfig, type ProxyOptions } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

// L-PROBE-1: the network probe page (`npm run probe -w @dilla/media`, http://127.0.0.1:5191). 127.0.0.1 is a
// potentially trustworthy origin, so isSecureContext is true and the encoded-transform APIs exist.
//
// DILLA_PROBE_INSTANCE=https://<instance host> also proxies the instance's /v1, /gateway and /rtc through this server:
// dilla-testkit speaks plain http:// only, so on the session's machines `netprobe prepare` and `netprobe start` take
// `--instance http://127.0.0.1:5191`, and the page's LiveKit signalling (ws://127.0.0.1:5191/rtc) reaches the
// instance the same way. Media never passes through here: ICE runs between the browser and the SFU's node_ip.
const here = dirname(fileURLToPath(import.meta.url));

function instanceProxy(): Record<string, ProxyOptions> | undefined {
  const raw = process.env.DILLA_PROBE_INSTANCE;
  if (raw === undefined || raw === '') return undefined;
  const target = new URL(raw);
  if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new Error(`DILLA_PROBE_INSTANCE ${raw} is not an http(s) URL`);
  // changeOrigin: the instance, and the reverse proxy in front of it, route on their own Host. secure: the TLS
  // certificate is verified.
  const route = (ws: boolean): ProxyOptions => ({ target: target.origin, changeOrigin: true, secure: true, ws });
  return { '/v1': route(false), '/gateway': route(true), '/rtc': route(true) };
}

export default defineConfig({
  root: resolve(here, 'probe'),
  plugins: [{
    name: 'dilla-probe-wasm-required',
    configResolved() {
      if (!existsSync(resolve(here, 'wasm/dilla_core_wasm_bg.wasm'))) {
        throw new Error('the media wasm is missing: run npm run build:wasm -w @dilla/media before starting the probe');
      }
    },
  }],
  optimizeDeps: {
    entries: ['index.html', '../src/worker/*.ts'],
    include: ['livekit-client', 'events'],
  },
  server: { host: '127.0.0.1', port: 5191, strictPort: true, proxy: instanceProxy() },
  preview: { host: '127.0.0.1', port: 5191, strictPort: true, proxy: instanceProxy() },
  worker: { format: 'es' },
  build: { target: 'es2022', outDir: resolve(here, '../../target/netprobe/page'), emptyOutDir: true },
});

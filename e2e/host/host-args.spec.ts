import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostArgs, mediaArgs, mediaToml, swapWebRoot, webhookListenOf, WASI_CORE, type HostConfig } from '../web/support/host.ts';
import { writeFakeDist } from './fake-dist.ts';

const base: HostConfig = { port: 8491, control: 8492, webRoot: null };
const sfu = { port: 7894, udpPort: 7896, departureTimeout: 90 };

test('an in-process SFU keeps its flags: -sfu, the ports and the departure timeout', () => {
  const args = hostArgs({ ...base, sfu }, '/tmp/dw/host-8491');
  expect(args).toEqual(expect.arrayContaining(['-sfu', '-sfu-port', '7894', '-sfu-udp-port', '7896', '-sfu-departure-timeout', '90']));
  expect(args).not.toContain('-sfu-sidecar');
  expect(args).not.toContain('-state-dir');
});

test('a sidecar host gets -sfu-sidecar with its secret and webhook address, and never -sfu', () => {
  const args = hostArgs({ ...base, sfu, sidecar: { secretFile: '/m/livekit.secret', webhookListen: '127.0.0.1:8497' }, stateDir: '/tmp/dw/state-8491' }, '/tmp/dw/host-8491');
  expect(args).not.toContain('-sfu');
  expect(args).toEqual(expect.arrayContaining(['-sfu-sidecar', '-sfu-port', '7894', '-sfu-udp-port', '7896',
    '-sfu-secret-file', '/m/livekit.secret', '-sfu-webhook-listen', '127.0.0.1:8497', '-state-dir', '/tmp/dw/state-8491']));
  // The departure timeout belongs to the process that owns the rooms.
  expect(args).not.toContain('-sfu-departure-timeout');
  expect(args.slice(args.indexOf('-data-dir'), args.indexOf('-data-dir') + 2)).toEqual(['-data-dir', '/tmp/dw/host-8491']);
  expect(args).toContain(WASI_CORE);
});

test('an absolute web root (a swapped copy) is passed as it is, a relative one is resolved against the repo', () => {
  expect(hostArgs({ ...base, webRoot: '/tmp/dw/web-swap' }, '/d')).toEqual(expect.arrayContaining(['-web-root', '/tmp/dw/web-swap']));
  const rel = hostArgs({ ...base, webRoot: 'packages/web/dist' }, '/d');
  expect(rel[rel.indexOf('-web-root') + 1]).toMatch(/\/packages\/web\/dist$/);
});

test('the media process runs `dillad media --config <path>`', () => {
  expect(mediaArgs('/tmp/dw/media-7894/dilla.toml')).toEqual(['media', '--config', '/tmp/dw/media-7894/dilla.toml']);
});

test('the media config names its own data directory, ports, secret and webhook, and no fixed state path', () => {
  const toml = mediaToml({ dataDir: '/tmp/dw/media-7894', port: 7894, udpPort: 7896, webhookListen: '127.0.0.1:8497', secretFile: '/tmp/dw/media-7894/livekit.secret' });
  expect(toml).toContain('data_dir = "/tmp/dw/media-7894"');
  expect(toml).toContain('mode = "sidecar"');
  expect(toml).toContain('port = 7894');
  expect(toml).toContain('udp_port = 7896');
  expect(toml).toContain('webhook_listen = "127.0.0.1:8497"');
  expect(toml).toContain('api_secret_file = "/tmp/dw/media-7894/livekit.secret"');
  expect(toml).toContain('[turn]\nenabled = false');
  expect(toml).not.toContain('/var/lib/dillad');
});

test('the webhook listen address is read out of the webhook URL, and a URL dillad would not post to is refused', () => {
  expect(webhookListenOf('http://127.0.0.1:8497')).toBe('127.0.0.1:8497');
  expect(webhookListenOf('http://127.0.0.1:8497/livekit/webhook')).toBe('127.0.0.1:8497');
  expect(() => webhookListenOf('https://127.0.0.1:8497')).toThrow();
  expect(() => webhookListenOf('http://127.0.0.1')).toThrow();
  expect(() => webhookListenOf('http://127.0.0.1:8497/other')).toThrow();
});

test('the web-root swap renames the entry script and keeps index.html and the manifest consistent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dilla-swap-'));
  const src = join(dir, 'dist');
  writeFakeDist(src);
  const dest = swapWebRoot(src, join(dir, 'swapped'));
  expect(readFileSync(join(dest, 'index.html'), 'utf8')).toContain('src="/assets/index-AbC123-next.js"');
  expect(readdirSync(join(dest, 'assets')).sort()).toEqual(['index-AbC123-next.js', 'index-AbC123.js']);
  const manifest = JSON.parse(readFileSync(join(dest, 'dilla-manifest.json'), 'utf8')) as { v: number; files: { path: string; sha256: string; size: number }[] };
  expect(manifest.files.map((f) => f.path)).toEqual(['assets/index-AbC123-next.js', 'assets/index-AbC123.js', 'index.html']);
  // The source is untouched.
  expect(readFileSync(join(src, 'index.html'), 'utf8')).toContain('src="/assets/index-AbC123.js"');
});

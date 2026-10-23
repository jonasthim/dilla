import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
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
  // A room's departure timeout is the one the API's CreateRoom names (UP9), so the sidecar host takes it too.
  expect(args).toEqual(expect.arrayContaining(['-sfu-departure-timeout', '90']));
  expect(args).not.toContain('-turn-listen');
  expect(args).not.toContain('-hold-public');
  expect(args.slice(args.indexOf('-data-dir'), args.indexOf('-data-dir') + 2)).toEqual(['-data-dir', '/tmp/dw/host-8491']);
  expect(args).toContain(WASI_CORE);
});

test('a sidecar host with the relay names its turn.listen and secret, and a held one says so (UP9)', () => {
  const turn = { listen: '127.0.0.1:8568', secretFile: '/m/turn.secret' };
  const args = hostArgs({ ...base, sfu, sidecar: { secretFile: '/m/livekit.secret', webhookListen: '127.0.0.1:8497', turn }, holdPublic: true }, '/d');
  expect(args).toEqual(expect.arrayContaining(['-turn-listen', '127.0.0.1:8568', '-turn-secret-file', '/m/turn.secret', '-hold-public']));
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

test('with TURN the media config serves plain turn: on loopback in behind_proxy mode, with no public_ip (UP9)', () => {
  const toml = mediaToml({ dataDir: '/tmp/dw/media-7924', port: 7924, udpPort: 7926, webhookListen: '127.0.0.1:8567', secretFile: '/tmp/dw/media-7924/livekit.secret',
    turn: { listen: '127.0.0.1:8568', secretFile: '/tmp/dw/media-7924/turn.secret' } });
  expect(toml).toContain('mode = "behind_proxy"');
  expect(toml).toContain('trusted_proxy_cidrs = ["127.0.0.1/32"]');
  expect(toml).toContain('[turn]\nenabled = true\nlisten = "127.0.0.1:8568"\nshared_secret_file = "/tmp/dw/media-7924/turn.secret"\nrelay_ip = "127.0.0.1"');
  expect(toml).not.toContain('public_ip');
  expect(toml).toContain('ips_excludes = ["0.0.0.0/2","64.0.0.0/3","96.0.0.0/4","112.0.0.0/5","120.0.0.0/6","124.0.0.0/7","126.0.0.0/8","128.0.0.0/1"]');
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
  expect(readdirSync(join(dest, 'assets')).sort()).toEqual(['index-AbC123-next.js', 'index-AbC123.js', 'lazy-XyZ789-next.js', 'lazy-XyZ789.js']);
  // The lazy chunk imports the entry, and the browser keeps assets by name: it is renamed too, and each names the other's new
  // name, so the new page never loads the old entry (a second copy of the app, UP9).
  expect(readFileSync(join(dest, 'assets', 'lazy-XyZ789-next.js'), 'utf8')).toContain('from "./index-AbC123-next.js"');
  expect(readFileSync(join(dest, 'assets', 'index-AbC123-next.js'), 'utf8')).toContain('import("./lazy-XyZ789-next.js")');
  const manifest = JSON.parse(readFileSync(join(dest, 'dilla-manifest.json'), 'utf8')) as { v: number; files: { path: string; sha256: string; size: number }[] };
  expect(manifest.files.map((f) => f.path)).toEqual(['assets/index-AbC123-next.js', 'assets/index-AbC123.js', 'assets/lazy-XyZ789-next.js', 'assets/lazy-XyZ789.js', 'index.html']);
  const lazy = readFileSync(join(dest, 'assets', 'lazy-XyZ789-next.js'));
  expect(manifest.files.find((f) => f.path === 'assets/lazy-XyZ789-next.js')?.sha256).toBe(createHash('sha256').update(lazy).digest('hex'));
  // The source is untouched.
  expect(readFileSync(join(src, 'index.html'), 'utf8')).toContain('src="/assets/index-AbC123.js"');
});

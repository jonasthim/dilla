import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FullConfig } from '@playwright/test';
import { parseInvite } from './driver.ts';

/** web3.8 E2 (pre-flight C-13): `wire` is the one wire version the host's hello offers (`-wire`; 1 or more); the version-reload suite
 *  starts a host that offers 3 so the wire-2 client is refused. `keepData` leaves /tmp/dw/host-<port> in place at start and at stop,
 *  so a second host on the same ports serves the same accounts (the caller removes it with `removeHostData`).
 *  L-E2E-31: `sfu` starts the host's in-process LiveKit (`-sfu -sfu-port -sfu-udp-port`); the voice suite sets it.
 *  `departureTimeout` (seconds, `-sfu-departure-timeout`) lengthens the rooms' departure timeout (task-10 fix review N3). */
export interface HostConfig {
  port: number; control: number; webRoot: string | null; webauthnOrigin?: string; wire?: number; keepData?: boolean;
  sfu?: { port: number; udpPort: number; departureTimeout?: number };
  /** UP5: with `sfu`, the host uses the SFU `startMediaHost` started (`-sfu-sidecar`, sfu.NewRemote) instead of owning one;
   *  `secretFile` is the livekit.api_secret_file that SFU reads and `webhookListen` the address it posts its webhooks to, which
   *  this host serves. Closing the host leaves the SFU running, so `stop()` then `startTestHost` with `keepData` is an API restart. */
  sidecar?: SidecarConfig;
  /** `-state-dir`: the host's process state directory. Unset, it is the data directory; never a fixed path. */
  stateDir?: string;
}
/** What the test host needs to reach a sidecar SFU (UP5). */
export interface SidecarConfig { secretFile: string; webhookListen: string }
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const TESTHOST_BIN = join(REPO_ROOT, 'target', 'dilla-testhost');
export const DILLAD_BIN = join(REPO_ROOT, 'target', 'dillad');
export const WASI_CORE = join(REPO_ROOT, 'internal', 'mlswasi', 'testdata', 'dilla_core_wasi.wasm');
const WAIT_MS = process.env.CI === 'true' ? 90_000 : 60_000;

export function hostArgs(c: HostConfig, dataDir: string): string[] {
  return ['-listen', `127.0.0.1:${c.port}`, '-control', `127.0.0.1:${c.control}`,
    '-core', WASI_CORE, '-log-level', 'warn', '-data-dir', dataDir, '-production-acl',
    ...(c.webRoot === null ? [] : ['-web-root', resolve(REPO_ROOT, c.webRoot)]),
    ...(c.stateDir === undefined ? [] : ['-state-dir', c.stateDir]),
    ...(c.webauthnOrigin === undefined ? [] : ['-webauthn-origin', c.webauthnOrigin]),
    ...(c.wire === undefined ? [] : [`-wire=${String(c.wire)}`]),
    ...(c.sfu === undefined ? [] : [c.sidecar === undefined ? '-sfu' : '-sfu-sidecar', '-sfu-port', String(c.sfu.port), '-sfu-udp-port', String(c.sfu.udpPort),
      ...(c.sidecar === undefined ? [] : ['-sfu-secret-file', c.sidecar.secretFile, '-sfu-webhook-listen', c.sidecar.webhookListen]),
      // A sidecar's rooms take the departure timeout of the process that owns them (its config), not this host's.
      ...(c.sfu.departureTimeout === undefined || c.sidecar !== undefined ? [] : ['-sfu-departure-timeout', String(c.sfu.departureTimeout)])]),
  ];
}

export function removeHostData(port: number): void { rmSync(`/tmp/dw/host-${String(port)}`, { recursive: true, force: true }); }

function waitForLine(child: ChildProcess, pattern: RegExp, what: string, timeoutMs: number): Promise<string> {
  return new Promise((resolveLine, reject) => {
    let seen = '';
    const timer = setTimeout(() => reject(new Error(`${what} did not print ${pattern} within ${timeoutMs} ms:\n${seen}`)), timeoutMs);
    const onData = (chunk: Buffer) => {
      seen += chunk.toString();
      if (pattern.test(seen)) { clearTimeout(timer); resolveLine(seen); }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', (c: Buffer) => { seen += c.toString(); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`${what} exited with ${code}:\n${seen}`)); });
  });
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`${url} did not answer within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((done) => {
    const kill = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.once('exit', () => { clearTimeout(kill); done(); });
    child.kill('SIGTERM');
  });
}

/** A started test host: its public origin, its control origin, the bootstrap invite it printed, and its stop. */
export interface StartedHost { url: string; control: string; invite: string; stop(): Promise<void> }

/**
 * Starts target/dilla-testhost (already built) with `c`, in a fresh data directory under /tmp/dw, logging to
 * e2e/test-results/testhost-<port>.log with the invite redacted. The host starts empty: one instance, its bootstrap
 * invite, no account, no server, no channel (v0.1.0-web3.1's create-flow suite starts a second one of these).
 */
export async function startTestHost(c: HostConfig): Promise<StartedHost> {
  const dataDir = `/tmp/dw/host-${c.port}`;
  if (c.keepData !== true) rmSync(dataDir, { recursive: true, force: true });
  mkdirSync('/tmp/dw', { recursive: true });
  mkdirSync(join(REPO_ROOT, 'e2e', 'test-results'), { recursive: true });
  const log = createWriteStream(join(REPO_ROOT, 'e2e', 'test-results', `testhost-${c.port}.log`));
  const host = spawn(TESTHOST_BIN, hostArgs(c, dataDir), { stdio: ['ignore', 'pipe', 'pipe'] });
  const teardown = async () => { await stop(host); log.end(); if (c.keepData !== true) rmSync(dataDir, { recursive: true, force: true }); };
  host.stdout?.on('data', (b: Buffer) => log.write(b.toString().replace(/DILLA_TESTKIT_INVITE=\S+/g, 'DILLA_TESTKIT_INVITE=[redacted]')));
  host.stderr?.on('data', (b: Buffer) => log.write(b));
  try {
    const banner = await waitForLine(host, /DILLA_TESTKIT_INVITE=\S+/, 'dilla-testhost', WAIT_MS);
    const invite = parseInvite(banner);
    if (!invite) throw new Error(`dilla-testhost printed no DILLA_TESTKIT_INVITE= line:\n${banner}`);
    const url = `http://127.0.0.1:${c.port}`;
    await waitForHttp(url + '/', WAIT_MS);
    return { url, control: `http://127.0.0.1:${c.control}`, invite, stop: teardown };
  } catch (e) { await teardown(); throw e; }
}

/** Builds target/dilla-testhost (go build; `GO` overrides the go binary). */
export function buildTestHost(): void {
  execFileSync(process.env.GO ?? 'go', ['-C', REPO_ROOT, 'build', '-o', TESTHOST_BIN, './cmd/dilla-testhost'], { stdio: 'inherit' });
}

/** Builds target/dillad, the SFU sidecar binary `startMediaHost` runs unless DILLA_SFU_BIN names another. */
export function buildDillad(): void {
  execFileSync(process.env.GO ?? 'go', ['-C', REPO_ROOT, 'build', '-o', DILLAD_BIN, './cmd/dillad'], { stdio: 'inherit' });
}

/** UP5: what `startMediaHost` needs. `bin` defaults to DILLA_SFU_BIN, else the tree's dillad (UP4's compat job points it at the
 *  previous release). `webhookURL` is where the SFU posts its webhooks (the test host serves it: `sidecar.webhookListen`). */
export interface MediaHostConfig { bin?: string; port: number; udpPort: number; webhookURL: string; dataDir?: string; keepData?: boolean }

/** A running `dillad media`: the SFU a sidecar test host talks to. Its state directory is its own generated config's data_dir. */
export interface MediaHost {
  /** Pass to a HostConfig as `sidecar`. */
  sidecar: SidecarConfig;
  dataDir: string;
  configPath: string;
  /** The pid of the running SFU process. */
  pid(): number;
  /** Restarts the SFU process alone (SIGTERM, then the same config), resolving once the new one wrote media.json. */
  restartMedia(): Promise<void>;
  stop(): Promise<void>;
}

/** The webhook receiver's host:port out of a webhook URL: dillad renders `http://<livekit.webhook_listen>/livekit/webhook`. */
export function webhookListenOf(webhookURL: string): string {
  const u = new URL(webhookURL);
  if (u.protocol !== 'http:' || u.port === '') throw new Error(`webhookURL ${webhookURL} is not http://host:port[/livekit/webhook]`);
  if (u.pathname !== '/' && u.pathname !== '/livekit/webhook') throw new Error(`webhookURL ${webhookURL}: dillad posts to /livekit/webhook only`);
  return u.host;
}

/** The dilla.toml `dillad media` runs from: its own data_dir (so media.json lands there, never in /var/lib/dillad), a loopback
 *  SFU on `port`/`udpPort`, and the TURN relay off (UP9 adds TURN and the sockets). */
export function mediaToml(o: { dataDir: string; port: number; udpPort: number; webhookListen: string; secretFile: string }): string {
  const q = (v: string) => JSON.stringify(v);
  return [
    '[instance]', 'domain = "dilla.test"', `data_dir = ${q(o.dataDir)}`, 'public_ip = "127.0.0.1"', '',
    '[tls]', 'agreed = true', '',
    '[log]', 'level = "warn"', '',
    '[turn]', 'enabled = false', '',
    '[livekit]', 'enabled = true', 'mode = "sidecar"', 'bind_address = "127.0.0.1"', `port = ${String(o.port)}`,
    `udp_port = ${String(o.udpPort)}`, 'node_ip = "127.0.0.1"', 'advertise_internal_ip = true', 'api_key = "dilla"',
    `api_secret_file = ${q(o.secretFile)}`, `webhook_listen = ${q(o.webhookListen)}`, '',
  ].join('\n');
}

/** The argument vector of the SFU process. */
export function mediaArgs(configPath: string): string[] { return ['media', '--config', configPath]; }

async function waitForMediaState(dataDir: string, pid: number, timeoutMs: number, poll: { cancelled: boolean }): Promise<void> {
  const file = join(dataDir, 'media.json');
  const deadline = Date.now() + timeoutMs;
  while (!poll.cancelled) {
    try {
      const st = JSON.parse(readFileSync(file, 'utf8')) as { pid?: number };
      if (st.pid === pid) return;
    } catch { /* not written yet */ }
    if (Date.now() > deadline) throw new Error(`dillad media (pid ${pid}) wrote no ${file} within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Starts `dillad media` (the SFU, no API) from a generated dilla.toml in its own data directory under /tmp/dw, logging to
 * e2e/test-results/media-<port>.log. Resolves once it wrote media.json for its own pid, which it does after the SFU accepts
 * RoomService requests. The API test host is started separately with `sidecar: media.sidecar`.
 */
export async function startMediaHost(c: MediaHostConfig): Promise<MediaHost> {
  const bin = c.bin ?? process.env.DILLA_SFU_BIN ?? DILLAD_BIN;
  if (!existsSync(bin)) throw new Error(`${bin} is missing: go build -o target/dillad ./cmd/dillad (or set DILLA_SFU_BIN)`);
  const dataDir = c.dataDir ?? `/tmp/dw/media-${c.port}`;
  if (c.keepData !== true) rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(REPO_ROOT, 'e2e', 'test-results'), { recursive: true });
  const secretFile = join(dataDir, 'livekit.secret');
  if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
  const webhookListen = webhookListenOf(c.webhookURL);
  const configPath = join(dataDir, 'dilla.toml');
  writeFileSync(configPath, mediaToml({ dataDir, port: c.port, udpPort: c.udpPort, webhookListen, secretFile }), { mode: 0o600 });
  const log = createWriteStream(join(REPO_ROOT, 'e2e', 'test-results', `media-${c.port}.log`), { flags: 'a' });
  let child: ChildProcess | null = null;
  const launch = async () => {
    rmSync(join(dataDir, 'media.json'), { force: true });
    const p = spawn(bin, mediaArgs(configPath), { stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout?.on('data', (b: Buffer) => log.write(b));
    p.stderr?.on('data', (b: Buffer) => log.write(b));
    child = p;
    const exited = new Promise<never>((_, reject) => p.once('exit', (code) => reject(new Error(`dillad media exited with ${code}; see ${log.path}`))));
    exited.catch(() => { /* surfaced through the race below; an exit after a stop is expected */ });
    const poll = { cancelled: false };
    try { await Promise.race([waitForMediaState(dataDir, p.pid ?? -1, WAIT_MS, poll), exited]); }
    catch (e) { await stop(p); throw e; }
    finally { poll.cancelled = true; }
    p.removeAllListeners('exit');
  };
  await launch();
  const media: MediaHost = {
    sidecar: { secretFile, webhookListen }, dataDir, configPath,
    pid: () => child?.pid ?? -1,
    restartMedia: async () => { if (child) await stop(child); await launch(); },
    stop: async () => {
      if (child) await stop(child);
      log.end();
      if (c.keepData !== true) rmSync(dataDir, { recursive: true, force: true });
    },
  };
  return media;
}

/** UP5 web-root swap: a copy of `src` (packages/web/dist) whose entry script has another name, so `/app-version.json` names a
 *  build the open page does not run and it reloads. index.html and the manifest follow; nothing else changes. Returns `dest`. */
export function swapWebRoot(src: string, dest: string): string {
  rmSync(dest, { recursive: true, force: true });
  const copy = (from: string, to: string) => {
    mkdirSync(to, { recursive: true });
    for (const e of readdirSync(from, { withFileTypes: true })) {
      if (e.isDirectory()) copy(join(from, e.name), join(to, e.name));
      else copyFileSync(join(from, e.name), join(to, e.name));
    }
  };
  copy(src, dest);
  const indexPath = join(dest, 'index.html');
  const index = readFileSync(indexPath, 'utf8');
  const m = /(<script\s+type="module"[^>]*\ssrc=")(\/assets\/[A-Za-z0-9_./-]+)\.js(")/.exec(index);
  if (!m) throw new Error(`${indexPath} has no module entry script to swap`);
  const oldEntry = `${m[2]}.js`;
  const newEntry = `${m[2]}-next.js`;
  copyFileSync(join(dest, oldEntry), join(dest, newEntry));
  const nextIndex = Buffer.from(index.replace(oldEntry, newEntry));
  writeFileSync(indexPath, nextIndex);
  const manifestPath = join(dest, 'dilla-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { v: number; files: { path: string; sha256: string; size: number }[] };
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const entryBytes = readFileSync(join(dest, newEntry));
  const files = manifest.files.filter((f) => f.path !== 'index.html' && f.path !== newEntry.slice(1));
  files.push({ path: 'index.html', sha256: sha(nextIndex), size: nextIndex.length },
    { path: newEntry.slice(1), sha256: sha(entryBytes), size: entryBytes.length });
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, files }));
  return dest;
}

export default async function globalSetup(config: FullConfig): Promise<() => Promise<void>> {
  const c = config.metadata.dillaHost as HostConfig | undefined;
  if (!c || !Number.isInteger(c.port) || !Number.isInteger(c.control) ||
      (c.webRoot !== null && typeof c.webRoot !== 'string') ||
      (c.sfu !== undefined && (!Number.isInteger(c.sfu.port) || !Number.isInteger(c.sfu.udpPort)))) {
    throw new Error('playwright config metadata.dillaHost is not a HostConfig');
  }
  if (!existsSync(WASI_CORE)) throw new Error(`${WASI_CORE} is missing: cargo build -p dilla-core-wasi --target wasm32-wasip1 --release --locked, then copy it there`);
  if (c.webRoot !== null && !existsSync(join(REPO_ROOT, c.webRoot, 'index.html'))) {
    throw new Error(`${join(REPO_ROOT, c.webRoot)} has no index.html: build it first (npm run build:harness -w @dilla/client-core, or npm run build -w @dilla/web)`);
  }
  buildTestHost();
  const host = await startTestHost(c);
  process.env.DILLA_TESTKIT_INVITE = host.invite;
  process.env.DILLA_TESTKIT_CONTROL = host.control;
  process.env.DILLA_TEST_HOST = host.url;
  return host.stop;
}

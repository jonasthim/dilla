import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FullConfig } from '@playwright/test';
import { parseInvite } from './driver.ts';
import { arr, decode } from '../../../packages/client-core/src/cbor/index';

/** web3.8 E2 (pre-flight C-13): `wire` is the one wire version the host's hello offers (`-wire`; 1 or more); the version-reload suite
 *  starts a host that offers 3 so the wire-2 client is refused. `keepData` leaves the host data directory in place at start and at stop,
 *  so a second host on the same ports serves the same accounts (the caller removes it with `removeHostData`).
 *  L-E2E-31: `sfu` starts the host's in-process LiveKit (`-sfu -sfu-port -sfu-udp-port`); the voice suite sets it.
 *  `departureTimeout` (seconds, `-sfu-departure-timeout`) lengthens the rooms' departure timeout (task-10 fix review N3). */
export interface HostConfig { port: number; control: number; webRoot: string | null; webauthnOrigin?: string; wire?: number; keepData?: boolean; botRuntime?: boolean; sfu?: { port: number; udpPort: number; departureTimeout?: number } }
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const TESTHOST_BIN = join(REPO_ROOT, 'target', 'dilla-testhost');
export const DILLABOT_BIN = join(REPO_ROOT, 'target', 'dillabot');
export const BOT_HELPER_BIN = join(REPO_ROOT, 'target', 'release', 'dilla-bot-core');
export const WASI_CORE = join(REPO_ROOT, 'internal', 'mlswasi', 'testdata', 'dilla_core_wasi.wasm');
const WAIT_MS = process.env.CI === 'true' ? 90_000 : 60_000;
const HOST_DATA_ROOT = process.env.DILLA_E2E_HOST_DATA_ROOT ?? '/tmp/dw';
const hostDataDir = (port: number): string => join(HOST_DATA_ROOT, `host-${String(port)}`);

export function hostArgs(c: HostConfig, dataDir: string): string[] {
  return ['-listen', `127.0.0.1:${c.port}`, '-control', `127.0.0.1:${c.control}`,
    '-core', WASI_CORE, '-log-level', 'warn', '-data-dir', dataDir, '-production-acl',
    ...(c.webRoot === null ? [] : ['-web-root', join(REPO_ROOT, c.webRoot)]),
    ...(c.webauthnOrigin === undefined ? [] : ['-webauthn-origin', c.webauthnOrigin]),
    ...(c.botRuntime === true ? ['-bot-runtime-secret', join(dataDir, 'bot-runtime.token')] : []),
    ...(c.wire === undefined ? [] : [`-wire=${String(c.wire)}`]),
    ...(c.sfu === undefined ? [] : ['-sfu', '-sfu-port', String(c.sfu.port), '-sfu-udp-port', String(c.sfu.udpPort),
      ...(c.sfu.departureTimeout === undefined ? [] : ['-sfu-departure-timeout', String(c.sfu.departureTimeout)])]),
  ];
}

export function removeHostData(port: number): void { rmSync(hostDataDir(port), { recursive: true, force: true }); }

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
export interface StartedHost { url: string; control: string; invite: string; runtimeCredentialFile?: string; stop(): Promise<void> }

/**
 * Starts target/dilla-testhost (already built) with `c`, in a fresh data directory under `DILLA_E2E_HOST_DATA_ROOT`
 * (default `/tmp/dw`), logging to
 * e2e/test-results/testhost-<port>.log with the invite redacted. The host starts empty: one instance, its bootstrap
 * invite, no account, no server, no channel (v0.1.0-web3.1's create-flow suite starts a second one of these).
 */
export async function startTestHost(c: HostConfig): Promise<StartedHost> {
  // The bot acceptance host serves the web bundle from disk; always rebuild that
  // bundle from current source so the acceptance flow cannot pass on stale UI.
  if (c.botRuntime === true && c.webRoot !== null) {
    execFileSync(process.env.NPM ?? 'npm', ['run', 'build', '-w', '@dilla/web'], { cwd: REPO_ROOT, stdio: 'inherit' });
  }
  const dataDir = hostDataDir(c.port);
  if (c.keepData !== true) rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(HOST_DATA_ROOT, { recursive: true });
  mkdirSync(join(REPO_ROOT, 'e2e', 'test-results'), { recursive: true });
  const log = createWriteStream(join(REPO_ROOT, 'e2e', 'test-results', `testhost-${c.port}.log`));
  const host = spawn(TESTHOST_BIN, hostArgs(c, dataDir), { stdio: ['ignore', 'pipe', 'pipe'] });
  let bot: ChildProcess | null = null;
  const teardown = async () => {
    if (bot !== null) await stop(bot);
    await stop(host);
    log.end();
    if (c.keepData !== true) rmSync(dataDir, { recursive: true, force: true });
  };
  host.stdout?.on('data', (b: Buffer) => log.write(b.toString().replace(/DILLA_TESTKIT_INVITE=\S+/g, 'DILLA_TESTKIT_INVITE=[redacted]')));
  host.stderr?.on('data', (b: Buffer) => log.write(b));
  try {
    const banner = await waitForLine(host, /DILLA_TESTKIT_INVITE=\S+/, 'dilla-testhost', WAIT_MS);
    const invite = parseInvite(banner);
    if (!invite) throw new Error(`dilla-testhost printed no DILLA_TESTKIT_INVITE= line:\n${banner}`);
    const url = `http://127.0.0.1:${c.port}`;
    await waitForHttp(url + '/', WAIT_MS);
    if (c.botRuntime === true) bot = await startBotRuntime(url, dataDir, c.port);
    return { url, control: `http://127.0.0.1:${c.control}`, invite,
      ...(c.botRuntime === true ? { runtimeCredentialFile: join(dataDir, 'bot-runtime.token') } : {}), stop: teardown };
  } catch (e) { await teardown(); throw e; }
}

async function startBotRuntime(baseURL: string, dataDir: string, port: number): Promise<ChildProcess> {
  const runtimeToken = join(dataDir, 'bot-runtime.token');
  const stateDir = join(dataDir, 'bot-state');
  const configPath = join(dataDir, 'bot.toml');
  const runtimeLogPath = join(REPO_ROOT, 'e2e', 'test-results', `dillabot-${port}.log`);
  const discoveryResponse = await fetch(`${baseURL}/v1/instance`, { headers: { accept: 'application/cbor' } });
  if (!discoveryResponse.ok) throw new Error(`bot test discovery failed: HTTP ${discoveryResponse.status}`);
  const instanceIdBytes = arr(decode(new Uint8Array(await discoveryResponse.arrayBuffer())))[3];
  if (!(instanceIdBytes instanceof Uint8Array) || instanceIdBytes.length !== 16) throw new Error('bot test discovery returned an invalid instance ID');
  const instanceId = Buffer.from(instanceIdBytes).toString('hex');

  execFileSync(process.env.GO ?? 'go', ['-C', REPO_ROOT, 'build', '-o', DILLABOT_BIN, './cmd/dillabot'], { stdio: 'inherit' });
  execFileSync(process.env.CARGO ?? 'cargo', ['build', '-p', 'dilla-bot-core', '--release', '--locked'], { cwd: REPO_ROOT, stdio: 'inherit' });
  if (!existsSync(BOT_HELPER_BIN)) throw new Error(`${BOT_HELPER_BIN} is missing after cargo build -p dilla-bot-core --release --locked`);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const quote = (value: string): string => JSON.stringify(value);
  const config = [
    `base_url = ${quote(baseURL)}`,
    `instance_id = ${quote(instanceId)}`,
    `runtime_credential_file = ${quote(runtimeToken)}`,
    `helper_executable = ${quote(BOT_HELPER_BIN)}`,
    `wasi_module = ${quote(WASI_CORE)}`,
    `state_dir = ${quote(stateDir)}`,
    'reconcile_interval = "1s"',
    'allow_loopback_http = true',
    '',
  ].join('\n');
  writeFileSync(configPath, config, { mode: 0o600, flag: 'wx' });
  chmodSync(runtimeToken, 0o600);
  const log = createWriteStream(runtimeLogPath);
  const child = spawn(DILLABOT_BIN, ['-config', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  try {
    await waitForBotHealthy(child, log, port);
    return child;
  } catch (error) {
    await stop(child);
    log.end();
    throw error;
  }
}

function waitForBotHealthy(child: ChildProcess, log: ReturnType<typeof createWriteStream>, port: number): Promise<void> {
  return new Promise((resolveHealthy, reject) => {
    let seen = '';
    const timer = setTimeout(() => reject(new Error(`dillabot for test host ${port} did not become healthy:\n${seen}`)), WAIT_MS);
    const onData = (chunk: Buffer): void => {
      seen += chunk.toString();
      if (seen.includes('bot service healthy')) {
        clearTimeout(timer);
        child.stdout?.off('data', onData);
        child.stderr?.off('data', onData);
        resolveHealthy();
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      log.end();
      reject(new Error(`dillabot for test host ${port} exited with ${code}:\n${seen}`));
    });
  });
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
  execFileSync(process.env.GO ?? 'go', ['-C', REPO_ROOT, 'build', '-o', TESTHOST_BIN, './cmd/dilla-testhost'], { stdio: 'inherit' });
  const host = await startTestHost(c);
  process.env.DILLA_TESTKIT_INVITE = host.invite;
  process.env.DILLA_TESTKIT_CONTROL = host.control;
  process.env.DILLA_TEST_HOST = host.url;
  return host.stop;
}

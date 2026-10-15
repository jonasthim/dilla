import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FullConfig } from '@playwright/test';
import { parseInvite } from './driver.ts';

/** L-E2E-31: `sfu` starts the host's in-process LiveKit (`-sfu -sfu-port -sfu-udp-port`); the voice suite sets it.
 *  `departureTimeout` (seconds, `-sfu-departure-timeout`) lengthens the rooms' departure timeout (task-10 fix review N3). */
export interface HostConfig { port: number; control: number; webRoot: string | null; webauthnOrigin?: string; sfu?: { port: number; udpPort: number; departureTimeout?: number } }
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const TESTHOST_BIN = join(REPO_ROOT, 'target', 'dilla-testhost');
export const WASI_CORE = join(REPO_ROOT, 'internal', 'mlswasi', 'testdata', 'dilla_core_wasi.wasm');
const WAIT_MS = process.env.CI === 'true' ? 90_000 : 60_000;

export function hostArgs(c: HostConfig, dataDir: string): string[] {
  return ['-listen', `127.0.0.1:${c.port}`, '-control', `127.0.0.1:${c.control}`,
    '-core', WASI_CORE, '-log-level', 'warn', '-data-dir', dataDir, '-production-acl',
    ...(c.webRoot === null ? [] : ['-web-root', join(REPO_ROOT, c.webRoot)]),
    ...(c.webauthnOrigin === undefined ? [] : ['-webauthn-origin', c.webauthnOrigin]),
    ...(c.sfu === undefined ? [] : ['-sfu', '-sfu-port', String(c.sfu.port), '-sfu-udp-port', String(c.sfu.udpPort),
      ...(c.sfu.departureTimeout === undefined ? [] : ['-sfu-departure-timeout', String(c.sfu.departureTimeout)])]),
  ];
}

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
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync('/tmp/dw', { recursive: true });
  mkdirSync(join(REPO_ROOT, 'e2e', 'test-results'), { recursive: true });
  const log = createWriteStream(join(REPO_ROOT, 'e2e', 'test-results', `testhost-${c.port}.log`));
  const host = spawn(TESTHOST_BIN, hostArgs(c, dataDir), { stdio: ['ignore', 'pipe', 'pipe'] });
  const teardown = async () => { await stop(host); log.end(); rmSync(dataDir, { recursive: true, force: true }); };
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

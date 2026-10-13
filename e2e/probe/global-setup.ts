// Playwright globalSetup for playwright.probe.config.ts: a dilla-testhost with an in-process LiveKit on the probe's own
// ports (8485/8486, LiveKit 7892/7894) and the probe page's Vite server on 5191, proxying that test host as it proxies
// a real instance in the session. Build the test host first:
//   /home/thim/.local/go/bin/go -C <wt> build -o <wt>/target/dilla-testhost ./cmd/dilla-testhost
// It passes its flags itself and imports nothing from e2e/web/support/host.ts. The test host must be the web-3 build
// (lane A's call snapshot route, `GET /v1/channels/{id}/call`, which `netprobe arm` reads).
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TESTHOST_BIN = join(REPO_ROOT, 'target', 'dilla-testhost');
const WASI_CORE = join(REPO_ROOT, 'internal', 'mlswasi', 'testdata', 'dilla_core_wasi.wasm');
const MEDIA_WASM = join(REPO_ROOT, 'packages', 'media', 'wasm', 'dilla_core_wasm_bg.wasm');
export const PROBE_HOST = 'http://127.0.0.1:8485';
export const PROBE_PAGE = 'http://127.0.0.1:5191';
const DATA_DIR = '/tmp/dw/host-8485';
const WAIT_MS = process.env.CI === 'true' ? 90_000 : 60_000;

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

export default async function globalSetup(): Promise<() => Promise<void>> {
  for (const [file, how] of [
    [TESTHOST_BIN, '/home/thim/.local/go/bin/go -C <wt> build -o <wt>/target/dilla-testhost ./cmd/dilla-testhost'],
    [WASI_CORE, 'cargo build -p dilla-core-wasi --target wasm32-wasip1 --release --locked, then copy it there'],
    [MEDIA_WASM, 'npm run build:wasm -w @dilla/media'],
  ] as const) {
    if (!existsSync(file)) throw new Error(`${file} is missing: ${how}`);
  }
  // Firefox's AudioContext needs an audio server: without one the tone is silence, DTX sends nothing, and the loss
  // figure would read as a false pass.
  if (process.env.CI === 'true') execFileSync('sh', [join(REPO_ROOT, 'scripts', 'ci-audio-server.sh')], { stdio: 'inherit' });

  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync('/tmp/dw', { recursive: true });
  const results = join(REPO_ROOT, 'e2e', 'test-results');
  mkdirSync(results, { recursive: true });
  const children: ChildProcess[] = [];
  const teardown = async () => {
    for (const child of children.reverse()) await stop(child);
    rmSync(DATA_DIR, { recursive: true, force: true });
  };
  try {
    const hostLog = createWriteStream(join(results, 'testhost-8485.log'));
    const host = spawn(TESTHOST_BIN, [
      '-listen', '127.0.0.1:8485', '-control', '127.0.0.1:8486', '-core', WASI_CORE, '-log-level', 'warn',
      '-data-dir', DATA_DIR, '-production-acl', '-sfu', '-sfu-port', '7892', '-sfu-udp-port', '7894',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(host);
    host.stdout?.on('data', (b: Buffer) => hostLog.write(b.toString().replace(/DILLA_TESTKIT_INVITE=\S+/g, 'DILLA_TESTKIT_INVITE=[redacted]')));
    host.stderr?.on('data', (b: Buffer) => hostLog.write(b));
    host.once('exit', () => hostLog.end());
    // As e2e/media/support/driver.ts parseInvite reads it.
    const banner = await waitForLine(host, /DILLA_TESTKIT_INVITE=\S+/, 'dilla-testhost', WAIT_MS);
    const invite = /DILLA_TESTKIT_INVITE=(\S+)/.exec(banner)?.[1];
    if (!invite) throw new Error(`dilla-testhost printed no DILLA_TESTKIT_INVITE= line:\n${banner}`);
    process.env.DILLA_PROBE_INVITE = invite;
    await waitForHttp(`${PROBE_HOST}/v1/instance`, WAIT_MS);

    const mediaRoot = join(REPO_ROOT, 'packages', 'media');
    const viteLog = createWriteStream(join(results, 'vite-probe.log'));
    // DILLA_PROBE_PREVIEW=1 serves the static build (`npm run probe -w @dilla/media -- build`) instead of the dev
    // server: the way the outside laptop serves a page built on the dev box.
    const serve = process.env.DILLA_PROBE_PREVIEW === '1' ? ['preview'] : [];
    const vite = spawn(process.execPath, [join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), ...serve, '--config', join(mediaRoot, 'vite.probe.config.ts')], {
      cwd: mediaRoot, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DILLA_PROBE_INSTANCE: PROBE_HOST },
    });
    children.push(vite);
    vite.stdout?.on('data', (c: Buffer) => viteLog.write(c));
    vite.stderr?.on('data', (c: Buffer) => { viteLog.write(c); process.stderr.write(c); });
    vite.once('exit', () => viteLog.end());
    await waitForHttp(`${PROBE_PAGE}/`, WAIT_MS);
  } catch (err) {
    await teardown();
    throw err;
  }
  return teardown;
}

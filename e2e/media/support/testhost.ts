// Playwright globalSetup for playwright.media.config.ts: build cmd/dilla-testhost, start it with an
// in-process LiveKit (-sfu) on the ports the specs use, start the media harness (Vite, 5179), and
// return the teardown that stops both.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseInvite, CONTROL_URL } from './driver';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '..', '..', '..');
export const PUBLIC = 'http://127.0.0.1:8443';
export const CONTROL = 'http://127.0.0.1:8444';
export const HARNESS = 'http://127.0.0.1:5179';
export const SFU_PORT = 7880;
export const SFU_UDP_PORT = 7882;

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
  const out = join(tmpdir(), 'dilla-media-testhost');
  mkdirSync(out, { recursive: true });
  const bin = join(out, 'dilla-testhost');
  execFileSync(process.env.GO ?? 'go', ['-C', REPO_ROOT, 'build', '-o', bin, './cmd/dilla-testhost'], { stdio: 'inherit' });
  const core = join(REPO_ROOT, 'internal', 'mlswasi', 'testdata', 'dilla_core_wasi.wasm');
  if (!existsSync(core)) {
    throw new Error(`${core} is missing: cargo build -p dilla-core-wasi --target wasm32-wasip1 --release --locked, then copy it there`);
  }
  const rnnoise = join(REPO_ROOT, 'packages', 'media', 'src', 'audio', 'generated', 'rnnoise.wasm');
  execFileSync(process.execPath, [join(REPO_ROOT, 'packages', 'media', 'scripts', 'extract-rnnoise-wasm.mjs')], { stdio: 'inherit' });
  if (!existsSync(rnnoise)) throw new Error(`${rnnoise} is missing after RNNoise extraction; the media harness cannot start`);

  // Playwright runs no teardown when globalSetup throws, so a failed start stops whatever it
  // already spawned itself: otherwise the fixed ports stay bound and every later run fails.
  const children: ChildProcess[] = [];
  const teardown = async () => {
    for (const child of children.reverse()) await stop(child);
  };
  try {
    const resultDir = join(REPO_ROOT, 'e2e', 'test-results');
    mkdirSync(resultDir, { recursive: true });
    const hostLog = createWriteStream(join(resultDir, 'testhost.log'));
    const viteLog = createWriteStream(join(resultDir, 'vite.log'));
    const host = spawn(bin, [
      '-listen', '127.0.0.1:8443', '-control', '127.0.0.1:8444', '-core', core, '-log-level', 'warn',
      '-sfu', '-sfu-port', String(SFU_PORT), '-sfu-udp-port', String(SFU_UDP_PORT),
      ...(process.env.DILLA_MEDIA_SFU_NO_INTERNAL_IP === '1' ? ['-sfu-no-internal-ip'] : []),
      ...(process.env.DILLA_MEDIA_SFU_AV1 === '1' ? ['-sfu-av1'] : []),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(host);
    host.stdout?.on('data', (c: Buffer) => hostLog.write(c.toString().replace(/DILLA_TESTKIT_INVITE=\S+/g, 'DILLA_TESTKIT_INVITE=[redacted]')));
    host.stderr?.on('data', (c: Buffer) => hostLog.write(c));
    host.once('exit', () => hostLog.end());
    const banner = await waitForLine(host, /DILLA_TESTKIT_INVITE=\S+/, 'dilla-testhost', 60_000);
    const invite = parseInvite(banner);
    if (!invite) throw new Error(`dilla-testhost printed no DILLA_TESTKIT_INVITE= line:\n${banner}`);
    process.env.DILLA_TESTKIT_INVITE = invite;
    process.env.DILLA_TESTKIT_CONTROL = CONTROL_URL;

    const mediaRoot = process.env.DILLA_MEDIA_SCRATCH_DIR ?? join(REPO_ROOT, 'packages', 'media');
    const vite = spawn(process.execPath, [
      join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
      '--config', join(mediaRoot, 'vite.config.ts'), '--port', '5179', '--strictPort',
    ], { cwd: mediaRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(vite);
    vite.stdout?.on('data', (c: Buffer) => viteLog.write(c));
    vite.stderr?.on('data', (c: Buffer) => { viteLog.write(c); process.stderr.write(c); });
    vite.once('exit', () => viteLog.end());
    await waitForHttp(`${HARNESS}/`, 60_000);
  } catch (err) {
    await teardown();
    throw err;
  }

  return teardown;
}

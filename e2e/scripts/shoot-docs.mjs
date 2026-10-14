// Re-shoots the screenshots of the user documentation (docs/user/screenshots/*.png) against a real
// dilla-testhost serving the built web client, the way the web e2e starts it (e2e/web/support/host.ts).
//
//   npm run build -w @dilla/web
//   GO=/path/to/go npm run docs:shots -w @dilla/e2e            # or: node e2e/scripts/shoot-docs.mjs
//   node e2e/scripts/shoot-docs.mjs --port 8471 --control 8472 --out docs/user/screenshots
//
// What it does, in order:
//   1. builds target/dilla-testhost (`go build`, $GO or `go`) and starts it on 127.0.0.1:<port> and
//      <control>, with -production-acl and -web-root packages/web/dist, in a temporary data directory;
//   2. seeds one server owner through the control listener (POST /debug/seed) and, with that account's
//      session, creates the server "Midgard Crew" with the channels #general and #loot and a server
//      invite through the public HTTP API (protocol/09). web-1 cannot create a server, so this is the
//      only part not done through the client; the owner never posts and holds no MLS state;
//   3. signs ada, björn and mira up through the real onboarding in three Chromium profiles (Mesh theme,
//      1280×800), lets them talk in #general, and shoots mira's screens;
//   3b. replies, reacts, edits, pins, mentions and shares images and files in #general between the three
//      of them and shoots mira's view of each (the images are drawn by canvas in the page at run time);
//   4. signs mira in from a fourth browser (recovery key, then username and password, then done), then
//      shoots Devices in both browsers, notifications, badges, a DM and a DM's badge;
//   4b. (web-3) has ada call mira in their DM and shoots the ring; shoots Settings → Voice; has björn share an audio
//      file and shoots its player; has ada, björn and mira join the voice channel "harbour" and shoots the stage and,
//      from #general, the dock; then all three leave;
//   4c. (web-2c and web-3) the native peer's server "Bridge Watch": Privacy, the comparison, search, diagnostics, the
//      peer's changed identity in the conversation, in Privacy and as a refused voice join, and a second tab;
//   5. removes mira from the server through the owner's session and shoots the "no longer a member" state;
//   6. closes every browser, stops the host and deletes the temporary directories.
//
// The host runs its in-process LiveKit on 127.0.0.1:7888 (signalling, reached through the host's /rtc proxy) and
// 7890 (ICE/UDP); the browsers use Chromium's fake microphone and camera (e2e/media/support/fixtures.ts).
//
// Every name and message is fictional, and the recovery key shown belongs to an account that is
// deleted with the host's data directory. Not part of CI: nothing runs it but a person.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { t } from '../../packages/web/src/strings/index.ts';
import { chromiumMediaArgs, writeFixtures } from '../media/support/fixtures.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TESTHOST_BIN = path.join(REPO_ROOT, 'target', 'dilla-testhost');
const WASI_CORE = path.join(REPO_ROOT, 'internal', 'mlswasi', 'testdata', 'dilla_core_wasi.wasm');
const WEB_ROOT = path.join(REPO_ROOT, 'packages', 'web', 'dist');
const WAIT = 60_000;

// L-DOC-23: the two real browser viewports of the guide's images, and the ten web-2c images, each waiting for the
// data-doc-state its visible root carries (packages/web/src/screens: Privacy, Search, Diagnostics, OtherTab).
// L-DOC-24 (web-3): the six voice states of docs/user/voice.md (packages/web/src/screens: voice/VoiceView, voice/Ring,
// settings/Voice, conversation/Attachments).
export const DOC_VIEWPORTS = { desktop: { width: 1280, height: 800 }, phone: { width: 360, height: 740 } };
const DESKTOP = DOC_VIEWPORTS.desktop;
const PHONE = DOC_VIEWPORTS.phone;
export const DOC_SHOTS = ['trust-privacy', 'trust-compare', 'trust-conversation', 'trust-changed', 'search-results', 'settings-diagnostics', 'tabs-handover',
  'voice-stage', 'voice-dock', 'voice-settings', 'voice-blocked', 'call-ring', 'media-player']
  .flatMap((state) => ['desktop', 'phone'].map((viewport) => ({ name: `${state}-${viewport}`, state: `[data-doc-state="${state}"]`, viewport })));

/**
 * Waits for the named state to be visible, captures it, and closes `context` (when the caller hands one over) in
 * `finally`, so a failed capture never leaves it open. The persistent profiles of main() are not handed over: their
 * owner closes them.
 */
export async function shootNamedState({ context = null, page, state, outFile }) {
  try {
    await page.waitForSelector(state, { state: 'visible', timeout: WAIT });
    await page.screenshot({ path: outFile });
  } finally {
    if (context !== null) await context.close();
  }
}

const SERVER = 'Midgard Crew';
const CHANNELS = [
  { name: 'general', topic: 'plans, raids and everything that is not loot' },
  { name: 'loot', topic: '' },
];
// web-3: the server's voice channel (kind 1, protocol/09), after the text channels.
const VOICE = 'harbour';
// The host's in-process LiveKit: signalling and ICE/UDP (the plan's docs:shots ports).
const SFU = { port: 7888, udpPort: 7890 };
const PEOPLE = {
  ada: { username: 'ada', display: 'Ada' },
  bjorn: { username: 'bjorn', display: 'Björn' },
  mira: { username: 'mira', display: 'Mira' },
};
const MIRA_PASSWORD = 'docs-mira-password';
// [who, body]: the conversation in #general, in order.
const CONVERSATION = [
  ['ada', 'raid tonight at 20:00? bring the good shields'],
  ['bjorn', 'in. last time the bridge troll took everything we had'],
  ['mira', 'I’m in too. Packing list:\nrope\ntorches\nsnacks for Björn'],
  ['ada', 'the map from saturday is in #loot, the one with the coffee stain'],
  ['bjorn', 'see you at the bridge'],
];
// web-2b: what the three say more with, in #general, after the conversation above.
const REPLY = 'ok, 20:00 works, I’ll bring the shields';
const EDITED = 'I’m in too. Packing list:\nrope\ntorches\nsnacks for Björn\nthe good shields';
const MENTION_REST = 'bring the map from #loot, the one with the stain';
const ATTACH_TEXT = 'the map from saturday, coffee stain included';
const MIRA_FILES_TEXT = 'packing list as a file, and the bridge as I remember it';
const MAP = { name: 'saturday-map.png', width: 640, height: 400 };
const BRIDGE = { name: 'bridge-sketch.png', width: 480, height: 320 };
const LOOT_LIST = { name: 'loot-list.txt', mimeType: 'text/plain', text: 'rope\ntorches\nshields\nsnacks for Björn\n' };
const PACKING_LIST = { name: 'packing-list.txt', mimeType: 'text/plain', text: 'rope x2\ntorches x6\nthe good shields\n' };
const SHANTY = { name: 'bridge-shanty.wav', text: 'the shanty from saturday, for the long walk' };

// ---------------------------------------------------------------------------------------------------
// Arguments.

export function parseArgs(argv) {
  const out = { port: 8471, control: 8472, outDir: path.join(REPO_ROOT, 'docs', 'user', 'screenshots') };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === '--port' || flag === '--control') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error(`${flag} must be a port from 1024 to 65535`);
      out[flag.slice(2)] = n;
    } else if (flag === '--out') {
      out.outDir = path.resolve(process.cwd(), value);
    } else {
      throw new Error(`unknown flag ${flag}`);
    }
  }
  if (out.port === out.control) throw new Error('--port and --control must differ');
  return out;
}

// ---------------------------------------------------------------------------------------------------
// A minimal CBOR codec: what the four API calls below send and read (protocol/09 bodies are arrays).

function head(major, n) {
  const m = major << 5;
  if (n < 24) return [m | n];
  if (n < 0x100) return [m | 24, n];
  if (n < 0x10000) return [m | 25, n >> 8, n & 0xff];
  return [m | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

export function encode(value) {
  const out = [];
  const put = (v) => {
    if (v === null) out.push(0xf6);
    else if (typeof v === 'number') out.push(...head(0, v));
    else if (typeof v === 'string') { const b = new TextEncoder().encode(v); out.push(...head(3, b.length), ...b); }
    else if (v instanceof Uint8Array) out.push(...head(2, v.length), ...v);
    else if (Array.isArray(v)) { out.push(...head(4, v.length)); v.forEach(put); }
    else throw new Error(`cbor: cannot encode ${typeof v}`);
  };
  put(value);
  return new Uint8Array(out);
}

export function decode(bytes) {
  let at = 0;
  const uint = (info) => {
    if (info < 24) return info;
    const size = { 24: 1, 25: 2, 26: 4, 27: 8 }[info];
    if (size === undefined) throw new Error(`cbor: unsupported length ${info}`);
    let n = 0n;
    for (let i = 0; i < size; i++) n = (n << 8n) | BigInt(bytes[at++]);
    return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;
  };
  const item = () => {
    const first = bytes[at++];
    const major = first >> 5;
    const info = first & 0x1f;
    switch (major) {
      case 0: return uint(info);
      case 1: { const n = uint(info); return typeof n === 'bigint' ? -1n - n : -1 - n; }
      case 2: { const n = uint(info); const b = bytes.slice(at, at + n); at += n; return b; }
      case 3: { const n = uint(info); const s = new TextDecoder().decode(bytes.slice(at, at + n)); at += n; return s; }
      case 4: { const n = uint(info); return Array.from({ length: n }, item); }
      case 5: { const n = uint(info); const m = new Map(); for (let i = 0; i < n; i++) m.set(item(), item()); return m; }
      case 6: uint(info); return item();
      default:
        if (first === 0xf4) return false;
        if (first === 0xf5) return true;
        if (first === 0xf6 || first === 0xf7) return null;
        throw new Error(`cbor: unsupported initial byte 0x${first.toString(16)}`);
    }
  };
  return item();
}

const hex = (b) => Buffer.from(b).toString('hex');

// ---------------------------------------------------------------------------------------------------
// The test host.

function portFree(port) {
  return new Promise((done) => {
    const s = net.createServer();
    s.once('error', () => done(false));
    s.listen(port, '127.0.0.1', () => s.close(() => done(true)));
  });
}

function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((done) => {
    const kill = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.once('exit', () => { clearTimeout(kill); done(); });
    child.kill('SIGTERM');
  });
}

function startHost(o, dataDir) {
  const child = spawn(TESTHOST_BIN, [
    '-listen', `127.0.0.1:${o.port}`, '-control', `127.0.0.1:${o.control}`, '-core', WASI_CORE,
    '-log-level', 'warn', '-data-dir', dataDir, '-production-acl', '-web-root', WEB_ROOT,
    '-sfu', '-sfu-port', String(SFU.port), '-sfu-udp-port', String(SFU.udpPort),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = new Promise((resolve, reject) => {
    let seen = '';
    const timer = setTimeout(() => reject(new Error(`dilla-testhost did not start within ${WAIT} ms:\n${seen}`)), WAIT);
    child.stdout.on('data', (b) => {
      seen += b.toString();
      const invite = /DILLA_TESTKIT_INVITE=(\S+)/.exec(seen);
      if (invite) { clearTimeout(timer); resolve(invite[1]); }
    });
    child.stderr.on('data', (b) => { seen += b.toString(); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`dilla-testhost exited with ${code}:\n${seen}`)); });
  });
  return { child, ready };
}

// ---------------------------------------------------------------------------------------------------
// The native peer (web-2c): the testkit's web-driver, one JSON line per request (e2e/web/support/driver.ts). It is
// the one member whose identity key can change, which a browser cannot do; nothing it holds is printed.

function startPeer(publicUrl, controlUrl, invite) {
  const bin = process.env.DILLA_TESTKIT ?? path.join(REPO_ROOT, 'target', 'release', 'dilla-testkit');
  if (!existsSync(bin)) throw new Error(`dilla-testkit not found at ${bin}: cargo build -p dilla-testkit --release --locked, or set DILLA_TESTKIT`);
  const child = spawn(bin, ['web-driver', '--ds', publicUrl, '--seed', String(1 + (randomBytes(3).readUIntBE(0, 3) % 0xff_fffe))], {
    env: { ...process.env, DILLA_TESTKIT_INVITE: invite, DILLA_TESTKIT_CONTROL: controlUrl }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let next = 1;
  createInterface({ input: child.stdout }).on('line', (line) => {
    const answer = JSON.parse(line);
    const p = pending.get(answer.id);
    if (!p) return;
    pending.delete(answer.id);
    if (answer.ok) p.resolve(answer); else p.reject(new Error(`web-driver: ${answer.error}`));
  });
  child.stderr.on('data', (d) => process.stderr.write(d));
  child.on('exit', (code) => {
    for (const p of pending.values()) p.reject(new Error(`web-driver exited with ${code}`));
    pending.clear();
  });
  const request = (op, args = {}) => new Promise((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`);
  });
  return { child, request };
}

// ---------------------------------------------------------------------------------------------------
// The server owner and the server, through the control listener and the public API.

async function api(base, token, method, route, body) {
  const res = await fetch(base + route, {
    method,
    headers: {
      authorization: `Bearer ${token}`, accept: 'application/cbor',
      ...(body === undefined ? {} : { 'content-type': 'application/cbor' }),
    },
    body: body === undefined ? undefined : encode(body),
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const value = bytes.length > 0 ? decode(bytes) : null;
  if (!res.ok) throw new Error(`${method} ${route}: ${res.status} ${JSON.stringify(value, (_, v) => (v instanceof Uint8Array ? hex(v) : v))}`);
  return value;
}

async function seedOwner(controlUrl) {
  const device = hex(randomBytes(16));
  const res = await fetch(`${controlUrl}/debug/seed`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify([{
      username: 'sigrid', display: 'Sigrid', bot: false,
      umk_pub: hex(randomBytes(32)), ssk_pub: hex(randomBytes(32)), sig_umk_ssk: hex(randomBytes(64)),
      devices: [{ device_id: device, dsk_pub: hex(randomBytes(32)), tier: 0, signer_tier: 0, credential: hex(randomBytes(32)) }],
    }]),
  });
  if (!res.ok) throw new Error(`POST /debug/seed: ${res.status} ${await res.text()}`);
  const [seeded] = await res.json();
  return seeded.tokens[device];
}

async function createServer(publicUrl, token) {
  const [communityId] = await api(publicUrl, token, 'POST', '/v1/communities', [SERVER, new TextEncoder().encode('{}'), 0, 0]);
  const community = hex(communityId);
  for (const [position, c] of CHANNELS.entries()) {
    await api(publicUrl, token, 'POST', `/v1/communities/${community}/channels`, [0, 0, 0, null, c.name, c.topic, position, 0]);
  }
  await api(publicUrl, token, 'POST', `/v1/communities/${community}/channels`, [1, 0, 0, null, VOICE, '', CHANNELS.length, 0]);
  const answer = await api(publicUrl, token, 'POST', `/v1/communities/${community}/invites`, [50, 24 * 3600, 0]);
  return { community, invite: answer[1] };
}

/** The user id of `username` in the server's member list (rows are [user_id, joined, nick, roles, username, …]). */
async function memberId(publicUrl, token, community, username) {
  const found = [];
  const walk = (v) => {
    if (!Array.isArray(v)) return;
    if (v.length >= 5 && v[0] instanceof Uint8Array && v[4] === username) found.push(hex(v[0]));
    else v.forEach(walk);
  };
  walk(await api(publicUrl, token, 'GET', `/v1/communities/${community}/members`));
  if (found.length !== 1) throw new Error(`the member list of ${SERVER} has ${found.length} rows for ${username}`);
  return found[0];
}

// ---------------------------------------------------------------------------------------------------
// The browser side: the onboarding and shell, driven by the copy of packages/web/src/strings/en.ts.

const byText = (page, role, key, vars) => page.getByRole(role, { name: t(key, vars), exact: true });
const composer = (page, channel) => page.getByRole('textbox', { name: t('shell.composer.label', { channel }), exact: true });
const row = (page, channel, text) => page.getByRole('log', { name: t('shell.log.label', { channel }), exact: true })
  .locator('.d-message-row').filter({ hasText: text });

/** Fonts loaded, animations ended, no hover and no focus ring left over from the pointer or a filled field. */
async function settle(page, { keepFocus = false } = {}) {
  const size = page.viewportSize() ?? DESKTOP;
  await page.mouse.move(size.width - 1, size.height - 1);
  await page.evaluate(async (keep) => {
    if (!keep && document.activeElement instanceof HTMLElement) document.activeElement.blur();
    await document.fonts.ready;
    await Promise.all(document.getAnimations()
      .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime))
      .map((a) => a.finished.catch(() => undefined)));
  }, keepFocus);
}

async function onboard(page, person, invite, shots) {
  const shot = async (name) => { if (shots) { await settle(page); await shots(name); } };
  await page.goto(`/welcome?invite=${encodeURIComponent(invite)}`);
  await page.locator('.d-onboarding-frame h1').waitFor({ timeout: WAIT });
  await shot('onboarding-1-invite');
  await byText(page, 'button', 'onboarding.next').click();
  await byText(page, 'heading', 'onboarding.identity.title').waitFor({ timeout: WAIT });
  await page.getByLabel(t('onboarding.identity.username'), { exact: true }).fill(person.username);
  await page.getByLabel(t('onboarding.identity.display'), { exact: true }).fill(person.display);
  const password = page.getByLabel(t('onboarding.identity.password'), { exact: true });
  if (await password.count() > 0) await password.fill(person.username === 'mira' ? MIRA_PASSWORD : `docs-${hex(randomBytes(8))}`);
  await shot('onboarding-2-name');
  await byText(page, 'button', 'onboarding.next').click();
  await byText(page, 'heading', 'onboarding.keys.title').waitFor({ timeout: WAIT });
  await page.locator('.d-recovery-key li').first().waitFor({ timeout: WAIT });
  const recoveryKey = person.username === 'mira' ? (await page.locator('.d-recovery-key li').allTextContents()).join(' ') : null;
  await shot('onboarding-3-recovery-key');
  await byText(page, 'checkbox', 'onboarding.keys.acknowledge').check();
  await byText(page, 'button', 'onboarding.next').click();
  await byText(page, 'heading', 'onboarding.browser.title').waitFor({ timeout: WAIT });
  await shot('onboarding-4-browser');
  await byText(page, 'button', 'onboarding.browser.submit').click();
  await byText(page, 'heading', 'onboarding.done.title').waitFor({ timeout: WAIT });
  await shot('onboarding-5-done');
  await byText(page, 'button', 'onboarding.done.next').click();
  await byText(page, 'navigation', 'shell.rail.label').waitFor({ timeout: WAIT });
  return recoveryKey;
}

async function send(page, channel, text) {
  const box = composer(page, channel);
  // A composer that is joining or catching up is read-only (aria-disabled), not disabled.
  await box.and(page.locator(':not([readonly])')).waitFor({ timeout: WAIT });
  await box.fill(text);
  await box.press('Enter');
  // A send that raced a member's join is refused at its stale epoch and shown "not sent" (by design,
  // L-TS-07); the person retries it, and so does this script, at most three times.
  const target = row(page, channel, text.split('\n')[0]);
  for (let attempt = 0; attempt < 3; attempt++) {
    await target.and(page.locator('[data-state="ok"], [data-state="failed"]')).waitFor({ timeout: WAIT });
    if (await target.getAttribute('data-state') !== 'failed') break;
    process.stdout.write(`shoot-docs: retrying a refused send (${(await target.innerText()).replace(/\s+/g, ' ')})\n`);
    await target.getByRole('button', { name: t('shell.message.retry'), exact: true }).click();
    await target.and(page.locator('[data-state="failed"]')).waitFor({ state: 'detached', timeout: WAIT });
  }
  await confirmed(page, channel, text);
}

/** Waits until the row of `text` is shown confirmed; on a timeout, says what the log showed instead. */
async function confirmed(page, channel, text) {
  const target = row(page, channel, text.split('\n')[0]);
  try {
    await target.and(page.locator('[data-state="ok"]')).waitFor({ timeout: WAIT });
  } catch (e) {
    const rows = await page.locator('.d-message-row').evaluateAll((els) => els.map((el) => `${el.getAttribute('data-state')}: ${el.textContent}`));
    const main = await page.locator('main').innerText().catch(() => '');
    throw new Error(`${JSON.stringify(text)} was not confirmed in #${channel}; rows: ${JSON.stringify(rows)}; main: ${JSON.stringify(main)}`, { cause: e });
  }
}

const byId = (page, msgId) => page.locator(`.d-message-row[data-msg-id="${msgId}"]`);

async function idOf(page, channel, text) {
  const target = row(page, channel, text).and(page.locator('[data-state="ok"]'));
  await target.waitFor({ timeout: WAIT });
  const id = await target.getAttribute('data-msg-id');
  if (!id || !/^[0-9a-f]{32}$/.test(id)) throw new Error(`no msg id on ${JSON.stringify(text)}`);
  return id;
}

async function toolbarAction(page, msgId, key) {
  await byId(page, msgId).focus();
  await byId(page, msgId).hover();
  await byId(page, msgId).getByRole('toolbar', { name: t('shell.message.toolbar'), exact: true })
    .getByRole('button', { name: t(key), exact: true }).click();
}

async function pickEmoji(page, nameKey) {
  const dialog = page.getByRole('dialog', { name: t('shell.emoji.label'), exact: true });
  await dialog.getByRole('button', { name: t(nameKey), exact: true }).click();
  await dialog.waitFor({ state: 'hidden', timeout: WAIT });
}

async function drawPng(page, spec) {
  const bytes = await page.evaluate(async ({ kind, width, height }) => {
    const canvas = new OffscreenCanvas(width, height);
    const c = canvas.getContext('2d');
    if (kind === 'map') {
      c.fillStyle = '#e8dcc0'; c.fillRect(0, 0, width, height);
      c.strokeStyle = '#4a7fa8'; c.lineWidth = 18;
      c.beginPath(); c.moveTo(0, 260); c.bezierCurveTo(160, 180, 320, 340, 640, 220); c.stroke();
      c.fillStyle = '#6b4f2a'; c.fillRect(296, 222, 48, 64);
      c.strokeStyle = 'rgba(111, 78, 55, 0.55)'; c.lineWidth = 8;
      c.beginPath(); c.arc(150, 110, 46, 0, 2 * Math.PI); c.stroke();
      c.strokeStyle = '#a8323a'; c.lineWidth = 10;
      c.beginPath(); c.moveTo(470, 90); c.lineTo(510, 130); c.moveTo(510, 90); c.lineTo(470, 130); c.stroke();
    } else if (kind === 'bridge') {
      c.fillStyle = '#f4f1ea'; c.fillRect(0, 0, width, height);
      c.strokeStyle = '#3b3b3b'; c.lineWidth = 6;
      c.beginPath(); c.arc(240, 320, 180, Math.PI, 2 * Math.PI); c.stroke();
      c.beginPath(); c.moveTo(40, 150); c.lineTo(440, 150); c.stroke();
      for (const x of [80, 160, 240, 320, 400]) {
        c.beginPath(); c.moveTo(x, 150); c.lineTo(x, 200); c.stroke();
      }
    } else throw new Error(`unknown drawing ${kind}`);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }, spec);
  return Buffer.from(bytes);
}

async function attach(page, file) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: WAIT }),
    page.getByRole('button', { name: t('shell.composer.attach'), exact: true }).click(),
  ]);
  await chooser.setFiles(file);
}

async function trayReady(page, n) {
  const list = page.getByRole('list', { name: t('shell.tray.label'), exact: true });
  await list.locator('li[data-phase="ready"]').nth(n - 1).waitFor({ timeout: WAIT });
  if (await list.locator('li[data-phase="failed"]').count()) {
    throw new Error('a tray entry failed: ' + await list.innerText());
  }
}

async function focusRow(page, channel, msgId) {
  const active = page.getByRole('log', { name: t('shell.log.label', { channel }), exact: true })
    .locator('article.d-message-row[tabindex="0"]');
  await active.focus();
  await active.press('End');
  for (let i = 0; i < 30; i++) {
    if (await byId(page, msgId).evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press('ArrowUp');
  }
  throw new Error('could not move to ' + msgId);
}

/** A 2 s, 48 kHz, 16-bit mono WAV of a short tune, made here (no audio file ships with the script). */
function shantyWav() {
  const rate = 48_000;
  const notes = [392, 440, 494, 523, 494, 440, 392, 330];
  const samples = rate * 2;
  const per = samples / notes.length;
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const at = i % per;
    const fade = Math.min(1, at / 480, (per - at) / 480);
    b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * notes[Math.floor(i / per)] * i) / rate) * 0.3 * fade * 32767), 44 + i * 2);
  }
  return b;
}

// The voice page contract, as e2e/voice/support/voice.ts reads it.
const railServer = (page, name) => byText(page, 'navigation', 'shell.rail.label').getByRole('button', { name: new RegExp(`^${name}(, |$)`) });
const voiceRow = (page, name) => page.getByRole('button', { name: t('voice.open', { name }), exact: true }).first();
const stage = (page) => page.locator('.dw-voice-stage');
const dock = (page) => page.locator('.dw-voice-dock');

/** The call phase is `in` and the dock shows a connected session. */
async function connected(page) {
  await page.locator('[data-call-phase="in"]').first().waitFor({ timeout: WAIT });
  await dock(page).locator('.d-voice-dock[data-phase="connected"]').waitFor({ timeout: WAIT });
}

/** Opens the voice channel `name` of the server `server`, presses `join voice` and waits for a connected call. */
async function joinVoice(page, server, name) {
  await railServer(page, server).click();
  await page.getByRole('tablist', { name: t('shell.tabs.label'), exact: true }).getByRole('tab', { name: /^channels/ }).click();
  await voiceRow(page, name).click();
  await stage(page).getByRole('button', { name: t('voice.join'), exact: true }).click();
  await connected(page);
}

/** Leaves through the dock's `leave` and waits until the dock is gone. */
async function leaveVoice(page) {
  await dock(page).getByRole('button', { name: t('voice.leave'), exact: true }).click();
  await dock(page).waitFor({ state: 'detached', timeout: WAIT });
}

async function main(argv) {
  const o = parseArgs(argv);
  const publicUrl = `http://127.0.0.1:${o.port}`;
  const controlUrl = `http://127.0.0.1:${o.control}`;
  if (!existsSync(path.join(WEB_ROOT, 'index.html'))) throw new Error(`${WEB_ROOT} has no index.html: npm run build -w @dilla/web first`);
  if (!existsSync(WASI_CORE)) throw new Error(`${WASI_CORE} is missing: cargo build -p dilla-core-wasi --target wasm32-wasip1 --release --locked, then copy it there`);
  for (const p of [o.port, o.control, SFU.port]) {
    if (!(await portFree(p))) throw new Error(`127.0.0.1:${p} is in use: pick others with --port and --control`);
  }
  execFileSync(process.env.GO ?? 'go', ['-C', REPO_ROOT, 'build', '-o', TESTHOST_BIN, './cmd/dilla-testhost'], { stdio: 'inherit' });

  const scratch = mkdtempSync(path.join(tmpdir(), 'dilla-docs-shots-'));
  const fixtures = writeFixtures(path.join(scratch, 'media'));
  const host = startHost(o, path.join(scratch, 'host'));
  const contexts = [];
  const problems = [];
  const written = [];
  let peer = null;
  try {
    const instanceInvite = await host.ready;
    const owner = await seedOwner(controlUrl);
    const { community, invite } = await createServer(publicUrl, owner);
    mkdirSync(o.outDir, { recursive: true });

    const open = async (who) => {
      const context = await chromium.launchPersistentContext(path.join(scratch, `profile-${who}`), {
        headless: true, viewport: DESKTOP, deviceScaleFactor: 1, colorScheme: 'dark', reducedMotion: 'reduce',
        locale: 'en-GB', timezoneId: 'Europe/Stockholm', baseURL: publicUrl,
        // web-3: Chromium's fake microphone and camera (a steady tone, a moving gradient), granted without a prompt.
        args: chromiumMediaArgs(fixtures), permissions: ['microphone', 'camera'],
      });
      contexts.push(context);
      // Headless Chromium denies notifications in a persistent profile even after CDP sets "prompt".
      // Show the opt-in state of the real Settings screen; no notification is requested or sent here.
      if (who === 'mira') await context.addInitScript(() => {
        if (window.Notification) Object.defineProperty(window.Notification, 'permission', {
          configurable: true, get: () => 'default',
        });
      });
      context.on('weberror', (e) => problems.push(`${who}: ${String(e.error())}`));
      const page = context.pages()[0] ?? (await context.newPage());
      return page;
    };
    const pages = {};
    const shotsOf = (page) => async (name) => {
      const file = path.join(o.outDir, `${name}.png`);
      await page.screenshot({ path: file });
      written.push(file);
    };

    // Ada and Björn first: Ada's browser opens #general first and so creates its group.
    for (const who of ['ada', 'bjorn']) {
      pages[who] = await open(who);
      await onboard(pages[who], PEOPLE[who], invite, null);
      await composer(pages[who], 'general').and(pages[who].locator(':enabled')).waitFor({ timeout: WAIT });
    }

    // Mira is the camera: the invite landing page, the five onboarding steps, then the shell.
    const mira = pages.mira = await open('mira');
    const shoot = shotsOf(mira);
    await mira.goto(`/i/${encodeURIComponent(invite)}`);
    await settle(mira);
    await shoot('invite-landing');
    const miraKey = await onboard(mira, PEOPLE.mira, invite, shoot);
    await composer(mira, 'general').and(mira.locator(':enabled')).waitFor({ timeout: WAIT });
    // Let Ada's and Björn's tabs apply Mira's join before the first message (fewer stale-epoch retries).
    await mira.waitForTimeout(3000);

    for (const [who, body] of CONVERSATION) {
      await send(pages[who], 'general', body);
      await confirmed(mira, 'general', body);
    }
    await composer(mira, 'general').fill('');
    await composer(mira, 'general').focus();
    await settle(mira, { keepFocus: true });
    await shoot('shell-conversation');

    await mira.setViewportSize(PHONE);
    await settle(mira, { keepFocus: true });
    await shoot('shell-phone');
    await mira.setViewportSize(DESKTOP);

    // Saying more in #general: the same message ids are used across all three browsers.
    const raidId = await idOf(pages.bjorn, 'general', 'raid tonight');
    const packId = await idOf(mira, 'general', 'Packing list');

    await toolbarAction(pages.bjorn, raidId, 'shell.message.reply');
    await pages.bjorn.getByRole('button', { name: t('shell.composer.replyCancel'), exact: true })
      .waitFor({ timeout: WAIT });
    await send(pages.bjorn, 'general', REPLY);
    const replyId = await idOf(pages.bjorn, 'general', 'I’ll bring the shields');
    await confirmed(mira, 'general', REPLY);
    await byId(mira, replyId).locator('.d-message-row__reply')
      .getByRole('button', { name: 'raid tonight' }).waitFor({ timeout: WAIT });

    await toolbarAction(pages.ada, packId, 'shell.message.react');
    await pickEmoji(pages.ada, 'shell.emoji.01');
    await byId(pages.ada, packId).locator('button[data-emoji="👍"][aria-pressed="true"]')
      .waitFor({ timeout: WAIT });
    await byId(pages.bjorn, packId).focus();
    await byId(pages.bjorn, packId).hover();
    await byId(pages.bjorn, packId).locator('button[data-emoji="👍"]').click();
    await byId(pages.bjorn, packId).locator('button[data-emoji="👍"][aria-pressed="true"]')
      .waitFor({ timeout: WAIT });
    await toolbarAction(pages.bjorn, packId, 'shell.message.react');
    await pickEmoji(pages.bjorn, 'shell.emoji.10');
    await byId(pages.bjorn, packId).locator('button[data-emoji="🔥"][aria-pressed="true"]')
      .waitFor({ timeout: WAIT });
    for (const [key, count] of [['shell.emoji.01', 2], ['shell.emoji.10', 1]]) {
      await byId(mira, packId).getByRole('button', {
        name: t('shell.message.reaction', { name: t(key), count }), exact: true,
      }).waitFor({ timeout: WAIT });
    }

    await focusRow(mira, 'general', replyId);
    await byId(mira, replyId).getByRole('toolbar', { name: t('shell.message.toolbar'), exact: true })
      .waitFor({ timeout: WAIT });
    await settle(mira, { keepFocus: true });
    await shoot('conversation-actions');
    await mira.keyboard.press('Escape');

    await composer(mira, 'general').fill('');
    await composer(mira, 'general').focus();
    await composer(mira, 'general').press('ArrowUp');
    const editor = mira.getByRole('textbox', { name: t('shell.edit.label'), exact: true });
    await editor.and(mira.locator(':focus')).waitFor({ timeout: WAIT });
    await editor.fill(EDITED);
    await settle(mira, { keepFocus: true });
    await shoot('conversation-edit');
    await editor.press('Enter');
    await byId(mira, packId).and(mira.locator('[data-edited="true"][data-state="ok"]'))
      .waitFor({ timeout: WAIT });
    await byId(mira, packId).getByText('the good shields', { exact: false }).waitFor({ timeout: WAIT });
    await byId(pages.ada, packId).and(pages.ada.locator('[data-edited="true"]'))
      .waitFor({ timeout: WAIT });

    await toolbarAction(pages.ada, packId, 'shell.message.pin');
    await byId(mira, packId).and(mira.locator('[data-pinned="true"]')).waitFor({ timeout: WAIT });
    await mira.getByRole('button', { name: t('shell.pins.open'), exact: true }).click();
    const pins = mira.getByRole('dialog', { name: t('shell.pins.title', { channel: 'general' }), exact: true });
    await pins.getByText(t('shell.pins.by', { name: PEOPLE.ada.display }), { exact: true })
      .waitFor({ timeout: WAIT });
    await settle(mira, { keepFocus: true });
    await shoot('conversation-pins');
    await mira.keyboard.press('Escape');
    await pins.waitFor({ state: 'hidden', timeout: WAIT });

    const mentionBox = composer(mira, 'general');
    await mentionBox.fill('');
    await mentionBox.pressSequentially('@ad');
    const mentions = mira.getByRole('listbox', { name: t('shell.composer.mentions'), exact: true });
    await mentions.getByRole('option').filter({ hasText: PEOPLE.ada.display }).waitFor({ timeout: WAIT });
    await settle(mira, { keepFocus: true });
    await shoot('conversation-mention');
    await mentionBox.press('Enter');
    await mentions.waitFor({ state: 'hidden', timeout: WAIT });
    const mentionValue = await mentionBox.inputValue();
    if (mentionValue !== '@ada ') throw new Error('the mention was not inserted: ' + JSON.stringify(mentionValue));
    await mentionBox.pressSequentially(MENTION_REST);
    await mentionBox.press('Enter');
    await confirmed(mira, 'general', MENTION_REST);
    await row(pages.ada, 'general', MENTION_REST).and(pages.ada.locator('[data-mention="true"]'))
      .waitFor({ timeout: WAIT });

    const mapPng = await drawPng(pages.bjorn, { kind: 'map', ...MAP });
    await attach(pages.bjorn, { name: MAP.name, mimeType: 'image/png', buffer: mapPng });
    await attach(pages.bjorn, { name: LOOT_LIST.name, mimeType: LOOT_LIST.mimeType,
      buffer: Buffer.from(LOOT_LIST.text, 'utf8') });
    await trayReady(pages.bjorn, 2);
    await send(pages.bjorn, 'general', ATTACH_TEXT);
    await confirmed(mira, 'general', ATTACH_TEXT);
    await mira.locator(`img[alt="${MAP.name}"][data-thumb="ready"]`).waitFor({ timeout: WAIT });
    await mira.getByRole('button', { name: t('shell.attachment.save', { name: LOOT_LIST.name }), exact: true })
      .waitFor({ timeout: WAIT });

    await attach(mira, { name: PACKING_LIST.name, mimeType: PACKING_LIST.mimeType,
      buffer: Buffer.from(PACKING_LIST.text, 'utf8') });
    await attach(mira, { name: BRIDGE.name, mimeType: 'image/png',
      buffer: await drawPng(mira, { kind: 'bridge', ...BRIDGE }) });
    await trayReady(mira, 2);
    await composer(mira, 'general').focus();
    await settle(mira, { keepFocus: true });
    await shoot('conversation-attachments');
    await send(mira, 'general', MIRA_FILES_TEXT);
    await mira.locator(`img[alt="${BRIDGE.name}"][data-thumb="ready"]`).waitFor({ timeout: WAIT });

    await mira.getByRole('button', { name: t('shell.attachment.open', { name: MAP.name }), exact: true }).click();
    const lightbox = mira.locator('dialog[open]').filter({ has: mira.locator(`img[alt="${MAP.name}"]`) });
    await lightbox.waitFor({ timeout: WAIT });
    await mira.waitForFunction((alt) => {
      const i = document.querySelector(`dialog[open] img[alt="${alt}"]`);
      return i instanceof HTMLImageElement && i.complete && i.naturalWidth > 0;
    }, MAP.name, { timeout: WAIT });
    await settle(mira, { keepFocus: true });
    await shoot('conversation-lightbox');
    await mira.keyboard.press('Escape');
    await lightbox.waitFor({ state: 'hidden', timeout: WAIT });
    await composer(mira, 'general').fill('');

    // Sign-in ceremony in a clean fourth browser, in the shipped order: recovery key, then username and
    // password, then (no second factor on this account) done. The key is held only in this short-lived process.
    const second = await open('mira-second');
    const shootSecond = shotsOf(second);
    await second.goto('/welcome');
    await byText(second, 'button', 'onboarding.connect.signIn').waitFor({ timeout: WAIT });
    await settle(second);
    await shootSecond('signin-0-entry');
    await byText(second, 'button', 'onboarding.connect.signIn').click();
    await byText(second, 'heading', 'signin.key.title').waitFor({ timeout: WAIT });
    if (miraKey === null) throw new Error('mira recovery key was not captured');
    await second.getByRole('textbox', { name: t('signin.key.label'), exact: true }).fill(miraKey);
    await settle(second);
    await shootSecond('signin-1-recovery-key');
    await byText(second, 'button', 'signin.login.submit').click();
    await second.getByRole('heading', { name: /^Sign in to / }).waitFor({ timeout: WAIT });
    await second.getByLabel(t('signin.login.username'), { exact: true }).fill(PEOPLE.mira.username);
    await second.getByLabel(t('signin.login.password'), { exact: true }).fill(MIRA_PASSWORD);
    await settle(second);
    await shootSecond('signin-2-login');
    await byText(second, 'button', 'signin.login.submit').click();
    await byText(second, 'heading', 'signin.done.title').waitFor({ timeout: WAIT });
    await settle(second);
    await shootSecond('signin-4-done');
    await byText(second, 'button', 'signin.done.next').click();
    await byText(second, 'navigation', 'shell.rail.label').waitFor({ timeout: WAIT });

    // Mira's original browser shows both signed-in devices and the notification opt-in.
    await byText(mira, 'button', 'shell.rail.settings').click();
    await byText(mira, 'heading', 'devices.title').waitFor({ timeout: WAIT });
    await mira.locator('.d-device-row').nth(1).waitFor({ timeout: WAIT });
    await settle(mira);
    await shoot('settings-devices');
    // The sign-out dialog of the second browser, opened and closed again without sending anything.
    await byText(second, 'button', 'shell.rail.settings').click();
    await byText(second, 'heading', 'devices.title').waitFor({ timeout: WAIT });
    await second.locator('.d-device-row').nth(1).waitFor({ timeout: WAIT });
    await byText(second, 'button', 'devices.signOut').click();
    await byText(second, 'heading', 'devices.signOutTitle').waitFor({ timeout: WAIT });
    await settle(second, { keepFocus: true });
    await shootSecond('settings-devices-signout');
    await second.keyboard.press('Escape');
    await byText(second, 'heading', 'devices.signOutTitle').waitFor({ state: 'hidden', timeout: WAIT });
    await byText(second, 'button', 'settings.close').click();
    await byText(mira, 'button', 'settings.nav.notifications').click();
    await byText(mira, 'heading', 'notify.title').waitFor({ timeout: WAIT });
    await byText(mira, 'button', 'notify.permission.ask').waitFor({ timeout: WAIT });
    await settle(mira);
    await shoot('settings-notifications');
    await byText(mira, 'button', 'settings.close').click();

    // Enter the second channel once so this browser joins its group, then leave it unopened on screen.
    await mira.getByRole('button', { name: 'loot', exact: true }).click();
    await composer(mira, 'loot').and(mira.locator(':enabled')).waitFor({ timeout: WAIT });
    await mira.getByRole('button', { name: 'general', exact: true }).click();
    await composer(mira, 'general').and(mira.locator(':enabled')).waitFor({ timeout: WAIT });

    // A message in the now-unopened channel produces a row and rail badge.
    await pages.ada.getByRole('button', { name: 'loot', exact: true }).click();
    await composer(pages.ada, 'loot').and(pages.ada.locator(':enabled')).waitFor({ timeout: WAIT });
    await send(pages.ada, 'loot', 'the map is in the chest');
    await mira.getByRole('button', { name: /loot, unread 1, mentions 0/ }).waitFor({ timeout: WAIT });
    await settle(mira);
    await shoot('shell-unread-badge');

    // Open a DM from the member picker, then show its conversation.
    await byText(mira, 'tab', 'shell.tabs.dms').click();
    await byText(mira, 'button', 'shell.dms.new').click();
    const picker = byText(mira, 'dialog', 'shell.dms.newTitle');
    await picker.getByRole('listitem').filter({ hasText: PEOPLE.ada.display })
      .getByRole('button', { name: t('shell.dms.open'), exact: true }).click();
    const dmBox = mira.getByRole('textbox', { name: t('shell.dm.composer', { name: PEOPLE.ada.display }), exact: true });
    await dmBox.waitFor({ state: 'visible', timeout: WAIT });
    await dmBox.fill('see you at the bridge, Ada');
    await dmBox.press('Enter');
    await mira.getByRole('log', { name: t('shell.dm.log', { name: PEOPLE.ada.display }) })
      .getByText('see you at the bridge, Ada').waitFor({ timeout: WAIT });
    await settle(mira);
    await shoot('dm-conversation');

    // Return to the channel before the removal proof below.
    await mira.getByRole('tablist', { name: t('shell.tabs.label'), exact: true })
      .getByRole('tab', { name: /^channels/ }).click();
    await mira.getByRole('button', { name: 'general', exact: true }).click();
    await composer(mira, 'general').waitFor({ timeout: WAIT });

    // Ada answers the DM while Mira reads #general: the DMs tab counts it, and #loot (still unread) keeps the
    // server's badge in the rail.
    // The tab's name carries its pill's words once a count shows, so it is matched by its start.
    await pages.ada.getByRole('tab', { name: new RegExp(`^${t('shell.tabs.dms')}`) }).click();
    await pages.ada.getByRole('button', { name: new RegExp(`^${PEOPLE.mira.display}`) }).click();
    const adaDm = pages.ada.getByRole('textbox', { name: t('shell.dm.composer', { name: PEOPLE.mira.display }), exact: true });
    await adaDm.and(pages.ada.locator(':enabled')).waitFor({ timeout: WAIT });
    await adaDm.fill('rope is packed. bring the torches');
    await adaDm.press('Enter');
    await pages.ada.getByRole('log', { name: t('shell.dm.log', { name: PEOPLE.mira.display }) })
      .locator('.d-message-row[data-state="ok"]').filter({ hasText: 'rope is packed' }).waitFor({ timeout: WAIT });
    await mira.getByRole('tablist', { name: t('shell.tabs.label'), exact: true })
      .locator('[data-count="1"]').filter({ hasText: t('shell.tabs.dms') }).waitFor({ timeout: WAIT });
    await settle(mira);
    await shoot('shell-dm-badge');

    // Each data-doc-state shot (L-DOC-23, L-DOC-24) at both viewports once its state is visible; `before` brings the
    // state into view after the viewport changes (a phone stacks the channel list above the conversation).
    const shootState = async (page, state, owned = null, before = null) => {
      for (const shot of DOC_SHOTS.filter((s) => s.state === `[data-doc-state="${state}"]`)) {
        await page.setViewportSize(DOC_VIEWPORTS[shot.viewport]);
        await page.waitForSelector(shot.state, { state: 'visible', timeout: WAIT });
        if (before !== null) await before();
        await settle(page, { keepFocus: true });
        const outFile = path.join(o.outDir, `${shot.name}.png`);
        await shootNamedState({ context: shot.viewport === 'phone' ? owned : null, page, state: shot.state, outFile });
        written.push(outFile);
      }
      if (owned === null) await page.setViewportSize(DESKTOP);
    };
    const openSettings = async (section) => {
      await byText(mira, 'button', 'shell.rail.settings').click();
      await byText(mira, 'navigation', 'settings.nav.label').getByRole('button', { name: t(`settings.nav.${section}`), exact: true }).click();
    };
    const closeSettings = () => byText(mira, 'button', 'settings.close').click();

    // web-3 (L-DOC-24). Ada calls Mira from their DM: Mira's banner rings (30 s from its arrival, time enough for both
    // shots); she declines, and Ada, alone in the call, leaves, which ends it.
    await pages.ada.locator('.dw-call-strip').getByRole('button', { name: t('call.start'), exact: true }).click();
    await connected(pages.ada);
    const ring = mira.locator('.d-ring-banner__ring');
    await ring.getByRole('button', { name: t('call.ring.answer'), exact: true }).waitFor({ timeout: WAIT });
    await shootState(mira, 'call-ring');
    await ring.getByRole('button', { name: t('call.ring.decline'), exact: true }).click();
    await ring.waitFor({ state: 'detached', timeout: WAIT });
    await leaveVoice(pages.ada);

    await openSettings('voice');
    await shootState(mira, 'voice-settings');
    await closeSettings();

    // Björn shares an audio file in #general; Mira presses its play button, and the browser's own player shows.
    await attach(pages.bjorn, { name: SHANTY.name, mimeType: 'audio/wav', buffer: shantyWav() });
    await trayReady(pages.bjorn, 1);
    await send(pages.bjorn, 'general', SHANTY.text);
    await confirmed(mira, 'general', SHANTY.text);
    const player = mira.locator('[data-doc-state="media-player"]').filter({ hasText: SHANTY.name });
    await player.getByRole('button', { name: t('media.play', { name: SHANTY.name }), exact: true }).click();
    await player.locator('audio').waitFor({ timeout: WAIT });
    // The play button had the focus, which shows the message's toolbar: blur it so the shot shows the player alone.
    await shootState(mira, 'media-player', null, async () => {
      await player.scrollIntoViewIfNeeded();
      await mira.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
    });

    // Ada and Björn join "harbour", then Mira; her stage waits until it hears both of them (data-voice-state ok).
    await joinVoice(pages.ada, SERVER, VOICE);
    await joinVoice(pages.bjorn, SERVER, VOICE);
    await joinVoice(mira, SERVER, VOICE);
    await stage(mira).locator('.d-call-tile:not([data-own])[data-voice-state="ok"]').nth(1).waitFor({ timeout: WAIT });
    await shootState(mira, 'voice-stage');
    // Mira reads #general and stays in voice: the dock above her user panel keeps the controls.
    await mira.getByRole('button', { name: 'general', exact: true }).click();
    await composer(mira, 'general').waitFor({ timeout: WAIT });
    await shootState(mira, 'voice-dock', null, () => dock(mira).scrollIntoViewIfNeeded());
    for (const who of [mira, pages.bjorn, pages.ada]) await leaveVoice(who);
    // Back in #general, Ada's and Björn's tabs commit what the instance proposes there (Mira's removal, below).
    for (const who of [pages.bjorn, pages.ada]) {
      await who.getByRole('button', { name: 'general', exact: true }).click();
      await composer(who, 'general').waitFor({ timeout: WAIT });
    }

    // web-2c (L-DOC-23): Privacy, a contact's changed identity, search, diagnostics and the tab hand-over, each shot
    // at both viewports once its data-doc-state is visible. The contact whose key changes is the native peer, in a
    // server of its own that Mira joins.
    peer = startPeer(publicUrl, controlUrl, instanceInvite);
    const watch = (await peer.request('setup', { community: 'Bridge Watch', channel: 'watch', voice: true }));
    await peer.request('register');
    await byText(mira, 'button', 'shell.rail.join').click();
    const join = byText(mira, 'dialog', 'join.title');
    await join.getByLabel(t('join.invite'), { exact: true }).fill(watch.invite_code);
    await join.getByRole('button', { name: t('join.submit'), exact: true }).click();
    await join.waitFor({ state: 'hidden', timeout: WAIT });
    await byText(mira, 'navigation', 'shell.rail.label').getByRole('button', { name: /^Bridge Watch(, |$)/ }).click();
    await byText(mira, 'navigation', 'shell.channels.label').getByRole('button', { name: /^watch(, |$)/ }).click();
    await composer(mira, 'watch').and(mira.locator(':enabled')).waitFor({ timeout: WAIT });
    for (let i = 0; i < 60; i++) {
      await peer.request('sync', { channel_id: watch.channel_id });
      if ((await peer.request('members', { channel_id: watch.channel_id })).devices.length === 2) break;
      await mira.waitForTimeout(500);
    }
    await peer.request('send', { body: 'the bridge is quiet tonight', channel_id: watch.channel_id });
    await row(mira, 'watch', 'the bridge is quiet tonight').and(mira.locator('[data-state="ok"]')).waitFor({ timeout: WAIT });

    await openSettings('privacy');
    await shootState(mira, 'trust-privacy');
    // The comparison itself: the contact, the state, the exact public key and the 12 blocks of five digits.
    await mira.getByRole('button', { name: t('privacy.compare', { name: watch.display }), exact: true }).click();
    await mira.locator('[data-safety-group]').nth(11).waitFor({ timeout: WAIT });
    await shootState(mira, 'trust-compare');
    await mira.keyboard.press('Escape');
    await byText(mira, 'dialog', 'privacy.title').waitFor({ state: 'hidden', timeout: WAIT });
    await closeSettings();

    await composer(mira, 'watch').focus();
    await mira.keyboard.press('ControlOrMeta+K');
    await mira.getByRole('combobox', { name: t('search.placeholder'), exact: true }).fill('bridge');
    await mira.getByRole('option').first().waitFor({ timeout: WAIT });
    await shootState(mira, 'search-results');
    await mira.keyboard.press('Escape');

    await openSettings('diagnostics');
    await shootState(mira, 'settings-diagnostics');
    await closeSettings();

    await peer.request('rotate_umk');
    await peer.request('send', { body: 'new key, same watch', channel_id: watch.channel_id });
    await mira.getByRole('alert').filter({ hasText: t('privacy.changed') }).waitFor({ timeout: WAIT });
    // In the conversation: the alert with Compare, and the message field blocked with the same words.
    await mira.getByText(t('privacy.changed'), { exact: true }).last().waitFor({ timeout: WAIT });
    await shootState(mira, 'trust-conversation');
    await openSettings('privacy');
    await shootState(mira, 'trust-changed');
    await closeSettings();

    // A second tab of Mira's browser waits while this one holds the device; the tab is the shot's own and closes.
    const tab = await mira.context().newPage();
    await tab.goto('/');
    await shootState(tab, 'tabs-handover', { close: () => tab.close() });

    // web-3: the peer's new device opens the call of "watch-voice", and Mira's join is refused before anything is
    // posted, with a notice that names the peer. Shot before the removal below, in the order of the guide (the WB fix
    // wave fixed the not-member report a later frame used to clear, which kept that removal from showing).
    await peer.request('call_join', { actor: 'peer', channel: watch.voice_channel_id });
    await railServer(mira, 'Bridge Watch').click();
    await mira.getByRole('tablist', { name: t('shell.tabs.label'), exact: true }).getByRole('tab', { name: /^channels/ }).click();
    await voiceRow(mira, 'watch-voice').click();
    await stage(mira).getByRole('button', { name: t('voice.join'), exact: true }).click();
    await shootState(mira, 'voice-blocked');

    await byText(mira, 'navigation', 'shell.rail.label').getByRole('button', { name: new RegExp(`^${SERVER}(, |$)`) }).click();
    await mira.getByRole('button', { name: 'general', exact: true }).click();
    await composer(mira, 'general').waitFor({ timeout: WAIT });

    // Mira is removed from the server with her tab open; her next message meets the lost membership.
    const miraId = await memberId(publicUrl, owner, community, PEOPLE.mira.username);
    await api(publicUrl, owner, 'DELETE', `/v1/communities/${community}/members/${miraId}`);
    const box = composer(mira, 'general');
    const notMember = mira.getByText(t('shell.composer.notMember'), { exact: true });
    const lost = 'anyone still here?';
    for (let i = 0; i < 20 && !(await notMember.isVisible()); i++) {
      if (await box.isEnabled() && (await row(mira, 'general', lost).count()) === 0) {
        await box.fill(lost);
        await box.press('Enter');
      }
      await mira.waitForTimeout(1000);
    }
    await notMember.waitFor({ timeout: WAIT });
    await settle(mira);
    await shoot('shell-not-member');
  } finally {
    if (peer !== null) await stop(peer.child);
    for (const c of contexts) await c.close().catch(() => undefined);
    await stop(host.child);
    rmSync(scratch, { recursive: true, force: true });
  }
  for (const file of written) process.stdout.write(`shoot-docs: ${path.relative(REPO_ROOT, file)} (${statSync(file).size} bytes)\n`);
  for (const p of problems) process.stderr.write(`shoot-docs: page error ${p}\n`);
  return problems.length > 0 ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => { process.stderr.write(`${err && err.stack ? err.stack : err}\n`); process.exitCode = 1; },
  );
}

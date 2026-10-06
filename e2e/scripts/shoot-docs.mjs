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
//   4. signs mira in from a fourth browser, then shoots Devices, notifications, badges and a DM;
//   5. removes mira from the server through the owner's session and shoots the "no longer a member" state;
//   6. closes every browser, stops the host and deletes the temporary directories.
//
// Every name and message is fictional, and the recovery key shown belongs to an account that is
// deleted with the host's data directory. Not part of CI: nothing runs it but a person.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { t } from '../../packages/web/src/strings/index.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TESTHOST_BIN = path.join(REPO_ROOT, 'target', 'dilla-testhost');
const WASI_CORE = path.join(REPO_ROOT, 'internal', 'mlswasi', 'testdata', 'dilla_core_wasi.wasm');
const WEB_ROOT = path.join(REPO_ROOT, 'packages', 'web', 'dist');
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 360, height: 800 };
const WAIT = 60_000;

const SERVER = 'Midgard Crew';
const CHANNELS = [
  { name: 'general', topic: 'plans, raids and everything that is not loot' },
  { name: 'loot', topic: '' },
];
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
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = new Promise((resolve, reject) => {
    let seen = '';
    const timer = setTimeout(() => reject(new Error(`dilla-testhost did not start within ${WAIT} ms:\n${seen}`)), WAIT);
    child.stdout.on('data', (b) => {
      seen += b.toString();
      if (/DILLA_TESTKIT_INVITE=\S+/.test(seen)) { clearTimeout(timer); resolve(); }
    });
    child.stderr.on('data', (b) => { seen += b.toString(); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`dilla-testhost exited with ${code}:\n${seen}`)); });
  });
  return { child, ready };
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

async function main(argv) {
  const o = parseArgs(argv);
  const publicUrl = `http://127.0.0.1:${o.port}`;
  const controlUrl = `http://127.0.0.1:${o.control}`;
  if (!existsSync(path.join(WEB_ROOT, 'index.html'))) throw new Error(`${WEB_ROOT} has no index.html: npm run build -w @dilla/web first`);
  if (!existsSync(WASI_CORE)) throw new Error(`${WASI_CORE} is missing: cargo build -p dilla-core-wasi --target wasm32-wasip1 --release --locked, then copy it there`);
  for (const p of [o.port, o.control]) {
    if (!(await portFree(p))) throw new Error(`127.0.0.1:${p} is in use: pick others with --port and --control`);
  }
  execFileSync(process.env.GO ?? 'go', ['-C', REPO_ROOT, 'build', '-o', TESTHOST_BIN, './cmd/dilla-testhost'], { stdio: 'inherit' });

  const scratch = mkdtempSync(path.join(tmpdir(), 'dilla-docs-shots-'));
  const host = startHost(o, path.join(scratch, 'host'));
  const contexts = [];
  const problems = [];
  const written = [];
  try {
    await host.ready;
    const owner = await seedOwner(controlUrl);
    const { community, invite } = await createServer(publicUrl, owner);
    mkdirSync(o.outDir, { recursive: true });

    const open = async (who) => {
      const context = await chromium.launchPersistentContext(path.join(scratch, `profile-${who}`), {
        headless: true, viewport: DESKTOP, deviceScaleFactor: 1, colorScheme: 'dark', reducedMotion: 'reduce',
        locale: 'en-GB', timezoneId: 'Europe/Stockholm', baseURL: publicUrl,
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

    // Sign-in ceremony in a clean fourth browser: the key is held only in this short-lived process.
    const second = await open('mira-second');
    await second.goto('/welcome');
    await byText(second, 'button', 'onboarding.connect.signIn').click();
    await second.getByRole('heading', { name: /^Sign in to / }).waitFor({ timeout: WAIT });
    await settle(second);
    await shotsOf(second)('signin-1-login');
    await second.getByLabel(t('signin.login.username'), { exact: true }).fill(PEOPLE.mira.username);
    await second.getByLabel(t('signin.login.password'), { exact: true }).fill(MIRA_PASSWORD);
    await byText(second, 'button', 'signin.login.submit').click();
    await byText(second, 'heading', 'signin.key.title').waitFor({ timeout: WAIT });
    await settle(second);
    await shotsOf(second)('signin-3-recovery-key');
    if (miraKey === null) throw new Error('mira recovery key was not captured');
    await second.getByRole('textbox', { name: t('signin.key.label'), exact: true }).fill(miraKey);
    await byText(second, 'button', 'signin.key.submit').click();
    await byText(second, 'heading', 'signin.done.title').waitFor({ timeout: WAIT });
    await settle(second);
    await shotsOf(second)('signin-4-done');
    await byText(second, 'button', 'signin.done.next').click();
    await byText(second, 'navigation', 'shell.rail.label').waitFor({ timeout: WAIT });

    // Mira's original browser shows both signed-in devices and the notification opt-in.
    await byText(mira, 'button', 'shell.rail.settings').click();
    await byText(mira, 'heading', 'devices.title').waitFor({ timeout: WAIT });
    await mira.locator('.d-device-row').nth(1).waitFor({ timeout: WAIT });
    await settle(mira);
    await shoot('settings-devices');
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

// web3.9 E-GEO: the layout grammar of the alignment pass, measured in a real browser. From an empty host (with its in-process
// LiveKit) Ada starts "Midgard Crew" and gives it two categories, text channels, an announcement channel, a voice channel with
// a live person in it, the built-in AFK channel and a direct message; then every rule of the grammar is read as a rect at
// 1440x900, 1024x768, 390x844 and 360x740 (the phone sizes on a touch phone context where the engine has one):
//   A5  every list's names share one left x           A4  every row's trailing slot shares one right edge
//   B1  every bar's bottom hairline is at y=48        R9  phone targets: primary 44x44, secondary 24x24
//   C1  at 1024 the header keeps its name             R22 the rail is 72 wide, its tiles 48
//   R23 a collapsed category keeps its current and unread rows, and nothing in `main` leaves its column sideways.
// Assertions are soft: one run names every broken rule at every size, and a control that is missing counts as a broken rule
// too. The world is always built through the current client; DILLA_E2E_CHECK_WEBROOT, a directory holding another build of
// the web client (the web3.8 build, for the red runs the task's report records), makes the host restart on it, over the same
// data and the same browsers, before the rules are read.
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { expect, type BrowserContext, type Page } from '@playwright/test';
import { addServerVia, REPO_ROOT, attachInput, drawImage, messageRow, trayEntries,
  TEST_TIMEOUT, WAIT, channelRow, channelsNav, closeSettings, completeSignUp, copy, dmsNav, escapeRegExp, expectAccessible, expectComposerReady, homeTile, makeInviteLink, newAccount, openSettings, railItem, railNav,
  sendText, settingsDialog, signIn, signUp, test, type Account,
} from './support/app';
import { launchSecond, secondProfileDir } from './support/second-harness';
import { PROFILE_ROOT } from './support/persistent';
import { removeHostData, startTestHost, type HostConfig, type StartedHost } from './support/host';
import { chromiumMediaArgs, FIREFOX_MEDIA_PREFS, writeFixtures } from '../media/support/fixtures';
import { arr, decode } from '../../packages/client-core/src/cbor/index';
import { mkdirSync, rmSync } from 'node:fs';

const CHECK_WEBROOT = process.env.DILLA_E2E_CHECK_WEBROOT === undefined ? null : relative(REPO_ROOT, resolve(process.env.DILLA_E2E_CHECK_WEBROOT));
const LAYOUT_PORT = Number(process.env.DILLA_E2E_LAYOUT_PORT ?? 8615);
const EMPTY: HostConfig = { port: LAYOUT_PORT, control: LAYOUT_PORT + 1, webRoot: 'packages/web/dist', sfu: { port: 7900, udpPort: 7902 }, ...(CHECK_WEBROOT === null ? {} : { keepData: true }) };
const SERVER = 'Midgard Crew';
const OWNER = 'Ada';
const FRIEND = 'Mira';
/** The two categories and what stands in them. */
const PLAN = 'planning';
const LOUNGE = 'lounge';
const RAID = 'raid-planning-for-the-bridge-troll-and-the-long-winter-campaign';
const NEWS = 'news';
const HARBOUR = 'harbour';
const LONG_WORD = 'unbroken'.repeat(24);
const SIZES = [
  { tag: '1440x900', width: 1440, height: 900, phone: false },
  { tag: '1024x768', width: 1024, height: 768, phone: false },
  { tag: '390x844', width: 390, height: 844, phone: true },
  { tag: '360x740', width: 360, height: 740, phone: true },
] as const;
type Size = (typeof SIZES)[number];
const PHONE = { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } as const;

let host: StartedHost | null = null;
let instance = '';

// The two tests are independent (each makes its own accounts on the shared host), so one failing does not skip the other.
test.describe.configure({ mode: 'default', timeout: TEST_TIMEOUT * 4 });
// An action waits as long as one state may (the config leaves actions unbounded), so a missing control fails the check with time left.
test.use({ baseURL: `http://127.0.0.1:${String(EMPTY.port)}`, actionTimeout: WAIT });

test.beforeAll(async () => {
  if (CHECK_WEBROOT !== null) removeHostData(EMPTY.port);
  host = await startTestHost(EMPTY);
  const res = await fetch(`${host.url}/v1/instance`, { headers: { accept: 'application/cbor' } });
  expect(res.status, 'GET /v1/instance').toBe(200);
  const name = arr(decode(new Uint8Array(await res.arrayBuffer())))[5];
  if (typeof name !== 'string' || name === '') throw new Error('GET /v1/instance: element 5 is not the instance name');
  instance = name;
});
test.afterAll(async () => { await host?.stop(); if (CHECK_WEBROOT !== null) removeHostData(EMPTY.port); });

function started(): StartedHost {
  if (host === null) throw new Error('the empty test host did not start');
  return host;
}

// ---------------------------------------------------------------------------------------------------
// Measuring.

interface Box { x: number; y: number; w: number; h: number; r: number; b: number; t: string }
/** The rects of every rendered element matching `selector` (inside the first `root` when given), as the page sees them. */
async function boxes(page: Page, selector: string, root?: string): Promise<Box[]> {
  return page.evaluate(({ selector: sel, root: scope }) => {
    const top = scope === undefined ? document : document.querySelector(scope);
    if (top === null) return [];
    return [...top.querySelectorAll(sel)].filter(e => e.getClientRects().length > 0).map(e => {
      const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom, t: (e.getAttribute('aria-label') ?? e.textContent ?? '').trim().slice(0, 32) };
    });
  }, { selector, root });
}

const TOL = 0.5;
/** Every value lies within TOL of the others; the failure names the rule, the size and each value. */
function expectOne(what: string, values: readonly number[], labels: readonly string[]): void {
  expect.soft(values.length, `${what}: something to measure`).toBeGreaterThan(0);
  if (values.length === 0) return;
  const spread = Math.max(...values) - Math.min(...values);
  expect.soft(spread, `${what}: ${values.map((v, i) => `${labels[i] ?? '?'}=${v.toFixed(1)}`).join(' | ')}`).toBeLessThanOrEqual(TOL);
}
function expectAt(what: string, got: number, want: number, tol = 1): void {
  expect.soft(Math.abs(got - want), `${what}: ${got.toFixed(1)}, want ${String(want)}`).toBeLessThanOrEqual(tol);
}

/** A group of rules: a control it needs that is missing, or any other thrown failure, is one more broken rule, not the end of the run. */
async function attempt(what: string, body: () => Promise<void>): Promise<void> {
  try { await body(); } catch (e) { expect.soft(String(e).split('\n').slice(0, 3).join(' ').slice(0, 300), `${what}: could not be measured`).toBe(''); }
}

/** The first list's names share one x, and its trailing slots one right edge (A5, A4). */
async function expectListGrammar(page: Page, tag: string, list: string, names: string, label: string): Promise<void> {
  const n = await boxes(page, names, list);
  expectOne(`A5 ${label} names share one left x at ${tag}`, n.map(b => b.x), n.map(b => b.t));
  const slots = await boxes(page, '.d-slot', list);
  expectOne(`A4 ${label} trailing slots share one right edge at ${tag}`, slots.map(b => b.r), slots.map((b, i) => `${String(i)}:${b.t || '-'}`));
}

/** Every visible control that takes a tap or a click. */
const CONTROLS = 'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"], [role="menuitem"], [role="switch"], [role="checkbox"], [role="radio"]';
/** The controls a thumb works all day: 44x44 on a phone (R9). Everything else is secondary (24x24, with the 2.5.8 spacing). */
const PRIMARY = [
  '.d-tab-bar__link', '.d-phone-header button', '.d-chrow', '.d-voice-row', '.d-channel-list__cat-head', '.d-voice-row__join button',
  '.d-channel-list__cat-add button', '.d-channel-list__head button', '.d-community-rail__item', '.d-community-rail__join', '.d-composer button',
  '.d-call-bar button', '.d-call-stage__controls button',
].join(', ');

async function expectTargets(page: Page, tag: string, state: string): Promise<void> {
  const small = await page.evaluate(({ controls, primary }) => {
    const out: { name: string; w: number; h: number; tier: number }[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(controls)) {
      if (el.closest('[inert], [aria-hidden="true"], .d-sr-only') !== null) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'inline' || el.getClientRects().length === 0) continue;
      if (el instanceof HTMLInputElement && ['checkbox', 'radio'].includes(el.type) && el.closest('label') !== null) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) continue;
      if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) continue;
      const tier = el.matches(primary) ? 44 : 24;
      if (r.width + 0.5 < tier || r.height + 0.5 < tier) {
        out.push({ name: `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 24)}"`, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10, tier });
      }
    }
    return out;
  }, { controls: CONTROLS, primary: PRIMARY });
  expect.soft(small, `R9 ${state} at ${tag}: controls under their tier (44 primary, 24 secondary)`).toEqual([]);
}

/** Nothing in `main` leaves its column sideways, and the column itself does not scroll sideways. */
async function expectNoOverflow(page: Page, tag: string, state: string): Promise<void> {
  const out = await page.evaluate(() => {
    const main = document.querySelector('main, [role="main"]');
    if (main === null) return { missing: true, wide: [] as string[], scrolls: false };
    const m = main.getBoundingClientRect();
    const wide: string[] = [];
    for (const el of main.querySelectorAll<HTMLElement>('*')) {
      if (el.getClientRects().length === 0) continue;
      // A scroll container (a code block, a table) may be wider than its column; what it holds is its own to scroll.
      let clipped = false;
      for (let p = el.parentElement; p !== null && p !== main; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox !== 'visible') { clipped = true; break; }
      }
      if (clipped || el.closest('.d-sr-only') !== null) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.left < m.left - 0.5 || r.right > m.right + 0.5) wide.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')} ${Math.round(r.left)}..${Math.round(r.right)} in ${Math.round(m.left)}..${Math.round(m.right)}`);
    }
    return { missing: false, wide: wide.slice(0, 6), scrolls: main.scrollWidth > main.clientWidth + 1 };
  });
  expect.soft(out.missing, `main exists in ${state} at ${tag}`).toBe(false);
  expect.soft(out.wide, `no element of main leaves its column sideways in ${state} at ${tag}`).toEqual([]);
  expect.soft(out.scrolls, `main does not scroll sideways in ${state} at ${tag}`).toBe(false);
}

/** A long unbroken word wraps inside the log: the text's own rects, not the box that clips them, stay in the log's content box. */
async function expectWrapsInLog(page: Page, tag: string, state: string): Promise<void> {
  await expect(page.getByRole('log').getByText(LONG_WORD).first(), `the long message reaches the log in ${state} at ${tag}`).toBeVisible({ timeout: WAIT });
  const m = await page.evaluate((word) => {
    const log = document.querySelector('[role="log"]');
    if (log === null) return null;
    const walker = document.createTreeWalker(log, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      if (!(n.textContent ?? '').includes(word)) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const rects = [...range.getClientRects()];
      const box = log.getBoundingClientRect();
      const cs = getComputedStyle(log);
      const scrollbar = (log as HTMLElement).offsetWidth - (log as HTMLElement).clientWidth - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
      const left = box.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
      const right = box.right - parseFloat(cs.borderRightWidth) - scrollbar - parseFloat(cs.paddingRight);
      return { lines: rects.length, textLeft: Math.min(...rects.map(r => r.left)), textRight: Math.max(...rects.map(r => r.right)), left, right };
    }
    return undefined;
  }, LONG_WORD);
  expect.soft(m, `the long message is in the log in ${state} at ${tag}`).toBeTruthy();
  if (m === null || m === undefined) return;
  expect.soft(m.lines, `a long word wraps onto more than one line in ${state} at ${tag}`).toBeGreaterThan(1);
  expect.soft(m.textRight, `the text's right edge is inside the log's content box in ${state} at ${tag} (${m.textRight.toFixed(1)} vs ${m.right.toFixed(1)})`).toBeLessThanOrEqual(m.right + TOL);
  expect.soft(m.textLeft, `the text's left edge is inside the log's content box in ${state} at ${tag}`).toBeGreaterThanOrEqual(m.left - TOL);
}

/** On Chromium, a notched phone: with a 47 px top inset the header clears it (48 + 47), and where base.css zeroes its padding-top
 *  (the ring or the link banner already cleared the notch) it is exactly 48 in the same inset. Other engines have no override. */
async function expectSafeAreaBar(page: Page, tag: string): Promise<void> {
  if (page.context().browser()?.browserType().name() !== 'chromium') return;
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 47, bottom: 0, left: 0, right: 0 } });
    const height = () => page.evaluate(() => document.querySelector('.d-phone-header')?.getBoundingClientRect().height ?? NaN);
    await expect.poll(height, { message: `the phone header with a notch at ${tag}` }).toBeCloseTo(95, 0);
    // The page's CSP forbids a style element; the CSSOM is allowed, and zeroing the padding is what base.css does in those states.
    await page.evaluate(() => { document.querySelector<HTMLElement>('.d-phone-header')?.style.setProperty('padding-top', '0', 'important'); });
    expectAt(`B1 the phone header with a notch but its padding zeroed is 48 high at ${tag}`, await height(), 48, 0.5);
    await page.evaluate(() => { document.querySelector<HTMLElement>('.d-phone-header')?.style.removeProperty('padding-top'); });
  } finally {
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, bottom: 0, left: 0, right: 0 } }).catch(() => undefined);
    await cdp.detach().catch(() => undefined);
  }
}

/** A bar's bottom hairline: its bottom edge, measured from the top of `from` (the page, or the surface the bar stands on). */
async function barBottom(page: Page, bar: string, from?: string): Promise<number | null> {
  return page.evaluate(({ bar: sel, from: top }) => {
    const el = document.querySelector(sel);
    if (el === null || el.getClientRects().length === 0) return null;
    const origin = top === undefined ? 0 : (document.querySelector(top)?.getBoundingClientRect().top ?? 0);
    return el.getBoundingClientRect().bottom - origin;
  }, { bar, from });
}
async function expectBar(page: Page, tag: string, name: string, bar: string, want = 48, from?: string): Promise<void> {
  const got = await barBottom(page, bar, from);
  expect.soft(got, `B1 ${name} (${bar}) is on screen at ${tag}`).not.toBeNull();
  if (got !== null) expectAt(`B1 ${name} bottom hairline at ${tag}`, got, want, 0.5);
}

// ---------------------------------------------------------------------------------------------------
// The world.

const nav = (page: Page) => channelsNav(page);
async function makeCategory(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: copy('admin.open'), exact: true }).click();
  const settings = page.getByRole('dialog', { name: copy('admin.title'), exact: true });
  await settings.getByRole('navigation', { name: copy('admin.nav'), exact: true }).getByRole('button', { name: copy('admin.nav.channels'), exact: true }).click();
  await settings.getByRole('button', { name: copy('admin.channels.newCategory'), exact: true }).click();
  const dialog = page.getByRole('dialog', { name: copy('admin.category.title', { server: SERVER }), exact: true });
  await dialog.getByRole('textbox', { name: copy('admin.category.name'), exact: true }).fill(name);
  await dialog.getByRole('textbox', { name: copy('admin.category.name'), exact: true }).press('Enter');
  await expect(dialog).toBeHidden({ timeout: WAIT });
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden({ timeout: WAIT });
  await expect(nav(page).getByRole('button', { name: new RegExp(`^${name}$`) })).toBeVisible({ timeout: WAIT });
}
async function makeChannelIn(page: Page, category: string, kind: 'text' | 'voice' | 'announce', name: string): Promise<void> {
  await nav(page).getByRole('button', { name: copy('layout.category.add', { name: category }), exact: true }).click();
  const dialog = page.getByRole('dialog', { name: copy('create.channel.title', { server: SERVER }), exact: true });
  if (kind !== 'text') await dialog.getByRole('radio', { name: copy(kind === 'voice' ? 'create.channel.voice' : 'announce.kind'), exact: true }).click();
  await dialog.getByRole('textbox', { name: copy('create.channel.name'), exact: true }).fill(name);
  await dialog.getByRole('textbox', { name: copy('create.channel.name'), exact: true }).press('Enter');
  await expect(dialog).toBeHidden({ timeout: WAIT });
  await expect(kind === 'voice' ? nav(page).getByRole('button', { name: copy('voice.open', { name }), exact: true }) : channelRow(page, name)).toBeVisible({ timeout: WAIT });
}

/** The friend's browser: Chromium and Firefox have a fake microphone (the voice person); WebKit has none, so no live person there. */
function friendLaunch(browserName: string, launchOptions: object): object {
  if (browserName === 'chromium') return { ...launchOptions, args: chromiumMediaArgs(writeFixtures(join(tmpdir(), 'dilla-media-fixtures'))) };
  if (browserName === 'firefox') return { ...launchOptions, firefoxUserPrefs: FIREFOX_MEDIA_PREFS };
  return launchOptions;
}

test('the layout grammar holds at 1440, 1024, 390 and 360', async ({ page, playwright, browserName, launchOptions, headless, channel, guard }, testInfo) => {
  const h = started();
  const t0 = Date.now();
  const lap = (what: string) => console.log(`LAP ${String(Math.round((Date.now() - t0) / 1000))}s ${what}`);
  await page.setViewportSize({ width: 1440, height: 900 });

  // 1. Ada starts the server and gives it two categories, each with channels made from the category's own "+".
  const ada: Account = await signUp(page, h.invite.split(',')[0], instance, OWNER, h.control);
  await addServerVia(page, 'create');
  const start = page.getByRole('dialog', { name: copy('create.server.title'), exact: true });
  await start.getByRole('textbox', { name: copy('create.server.name'), exact: true }).fill(SERVER);
  await page.keyboard.press('Enter');
  await expect(start).toBeHidden({ timeout: WAIT });
  await expectComposerReady(page, 'general');
  await makeCategory(page, PLAN);
  await makeCategory(page, LOUNGE);
  await makeChannelIn(page, PLAN, 'text', RAID);
  await makeChannelIn(page, PLAN, 'announce', NEWS);
  await makeChannelIn(page, LOUNGE, 'voice', HARBOUR);
  await channelRow(page, 'general').click();
  await expectComposerReady(page, 'general');
  await sendText(page, 'general', `the map is in the chest ${LONG_WORD}`);
  const link = await makeInviteLink(page, SERVER);

  lap('world: server and channels');
  // 2. Mira, in a browser of her own: she reads #raid, writes in it (Ada has unread there), writes to Ada, then joins the voice channel.
  const secondDir = secondProfileDir(testInfo.project.name, testInfo.workerIndex);
  const second = await launchSecond(playwright, browserName, { launchOptions: friendLaunch(browserName, launchOptions), headless, channel, viewport: { width: 1440, height: 900 }, baseURL: h.url }, secondDir);
  const phoneDir = `${PROFILE_ROOT}/${testInfo.project.name}-${testInfo.workerIndex}-phone`;
  let phoneContext: BrowserContext | null = null;
  try {
    if (browserName === 'chromium') await second.grantPermissions(['microphone']);
    const mira = second.pages()[0] ?? (await second.newPage());
    await mira.goto(new URL(link).pathname);
    const openLink = mira.getByRole('link', { name: 'Open dilla in this browser', exact: true });
    await expect(openLink).toBeVisible({ timeout: WAIT });
    // The guard watches the web client, not the instance's static invite page (Firefox asks it for /favicon.ico under its default-src 'none').
    await guard.attach(second);
    await openLink.click();
    await completeSignUp(mira, newAccount(FRIEND, h.control), instance);
    await expect(railItem(mira, SERVER)).toBeVisible({ timeout: WAIT });
    await railItem(mira, SERVER).click();
    await channelRow(mira, RAID).click();
    await expectComposerReady(mira, RAID);
    await sendText(mira, RAID, '@Ada can you take the left flank?');
    await homeTile(mira).click();
    await mira.getByRole('button', { name: copy('shell.dms.new'), exact: true }).click();
    await mira.getByRole('dialog', { name: copy('shell.dms.newTitle'), exact: true }).getByRole('button', { name: copy('shell.dms.open'), exact: true }).click();
    const dmBox = mira.getByRole('textbox', { name: copy('shell.dm.composer', { name: OWNER }), exact: true });
    await expect(dmBox).toBeEnabled({ timeout: WAIT });
    await dmBox.fill('see you at the bridge, Ada');
    await dmBox.press('Enter');
    await expect(mira.getByRole('log').locator('.d-message-row').filter({ hasText: 'see you at the bridge' })).toHaveAttribute('data-state', 'ok', { timeout: WAIT });
    let voicePath = '';
    if (browserName !== 'webkit') {
      await railItem(mira, SERVER).click();
      await nav(mira).getByRole('button', { name: copy('voice.open', { name: HARBOUR }), exact: true }).click();
      await expect(mira.locator('[data-call-phase]').first()).toHaveAttribute('data-call-phase', 'in', { timeout: WAIT });
      voicePath = new URL(mira.url()).pathname;
      // Ada sees her under the row.
      await expect(nav(page).locator('.d-voice-row__person').filter({ hasText: FRIEND })).toBeVisible({ timeout: WAIT });
    }
    const serverPath = new URL(page.url()).pathname;
    await expect(page.locator('.d-chrow', { hasText: RAID })).toHaveAttribute('data-unread', /^[1-9]/, { timeout: WAIT });

    lap('world: Mira, DM, voice');
    if (CHECK_WEBROOT !== null) {
      // The red runs: the same server data and the same browsers, served the other build (the live call does not survive the restart).
      await h.stop();
      host = await startTestHost({ ...EMPTY, webRoot: CHECK_WEBROOT });
    }
    // 3. Desktop: 1440 and 1024.
    for (const size of SIZES.filter(s => !s.phone)) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await test.step(`desktop ${size.tag}`, async () => { await attempt(`desktop ${size.tag}`, () => desktopGrammar(page, size, serverPath, voicePath)); });
    }
    // Each opens the server itself: the desktop pass ends on a DM where no voice stage follows it (WebKit has no call).
    await test.step('search is a modal that traps focus', async () => { await page.setViewportSize({ width: 1440, height: 900 }); await attempt('search', () => searchModal(page, serverPath)); });
    await test.step('a collapsed category keeps its current and unread rows', async () => { await attempt('collapsed category', () => collapsedCategory(page, serverPath)); });

    lap('desktop and search and collapse done');
    // 4. Phone: a touch phone where the engine has one (Chromium, WebKit), Ada's second device; Firefox has no mobile emulation,
    // and 390 and 360 wide is a phone layout there too, so its own page is resized.
    let phone: Page = page;
    if (browserName !== 'firefox') {
      rmSync(phoneDir, { recursive: true, force: true });
      mkdirSync(phoneDir, { recursive: true });
      phoneContext = await playwright[browserName].launchPersistentContext(phoneDir, {
        ...launchOptions, headless, channel, ...PHONE, viewport: { width: 390, height: 844 }, baseURL: h.url,
      });
      await guard.attach(phoneContext);
      phone = await phoneContext.newPage();
      await signIn(phone, ada, instance);
    }
    lap('phone signed in');
    // The phone joined after the first long message, so it cannot read it: Ada writes another for the phone's log.
    await openPath(page, serverPath);
    await channelRow(page, 'general').click();
    await sendText(page, 'general', `and again ${LONG_WORD}`);
    for (const size of SIZES.filter(s => s.phone)) {
      await phone.setViewportSize({ width: size.width, height: size.height });
      await test.step(`phone ${size.tag}`, async () => { await attempt(`phone ${size.tag}`, () => phoneGrammar(phone, size, serverPath, voicePath)); });
    }
  } finally {
    await guard.collectWorkers();
    await phoneContext?.close();
    await second.close();
    rmSync(secondDir, { recursive: true, force: true });
    rmSync(phoneDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------
// Desktop.

async function desktopGrammar(page: Page, size: Size, serverPath: string, voicePath: string): Promise<void> {
  const { tag } = size;
  await openPath(page, serverPath);
  await expect(nav(page).getByRole('button', { name: new RegExp(`^${RAID}`) })).toBeVisible({ timeout: WAIT });

  // The rail (R22).
  const rail = await boxes(page, '.d-app-shell__rail');
  expectAt(`R22 the rail is 72 wide at ${tag}`, rail[0]?.w ?? 0, 72, 0.5);
  for (const tile of await boxes(page, '.d-community-rail__item, .d-community-rail__join')) {
    expectAt(`R22 rail tile "${tile.t}" is 48 wide at ${tag}`, tile.w, 48, 0.5);
    expectAt(`R22 rail tile "${tile.t}" is 48 high at ${tag}`, tile.h, 48, 0.5);
  }

  // The channel list (A5, A4): channel rows, voice rows and category labels, and every slot in it.
  await expectListGrammar(page, tag, '.d-channel-list__list', '.d-chrow__name, .d-voice-row__name, .d-channel-list__cat-label', 'channel list');

  // Bars (B1): the sidebar head, the channel header, the members head.
  await expectBar(page, tag, 'the sidebar head', '.d-channel-list__head');
  await expectBar(page, tag, 'the channel header', '.d-channel-header');
  if (size.width >= 1440) await expectBar(page, tag, 'the members head', '.d-member-list__bar');
  await expectNoOverflow(page, tag, 'a channel');

  // C1: at 1024 with the members aside open the header keeps its name and every action stays inside the header.
  if (size.width === 1024) {
    const toggle = page.locator('.d-channel-header').getByRole('button', { name: copy('members.toggle'), exact: true });
    if (await page.locator('.d-app-shell__aside').count() === 0 && await toggle.count() > 0) await toggle.click();
    await expect(page.locator('.d-app-shell__aside')).toBeVisible({ timeout: WAIT });
    await expectBar(page, tag, 'the members head', '.d-member-list__bar');
  }
  const header = (await boxes(page, '.d-channel-header'))[0];
  const name = (await boxes(page, '.d-channel-header__name'))[0];
  expect.soft(name?.w ?? 0, `C1 the header's name is visible at ${tag}`).toBeGreaterThan(24);
  if (header !== undefined) {
    for (const action of await boxes(page, '.d-channel-header__actions button')) {
      expect.soft(action.x, `C1 action "${action.t}" starts inside the header at ${tag}`).toBeGreaterThanOrEqual(header.x - TOL);
      expect.soft(action.r, `C1 action "${action.t}" ends inside the header at ${tag}`).toBeLessThanOrEqual(header.r + TOL);
    }
  }

  // The direct messages (A5, A4, B1): the `@` tile shows the DM list.
  await homeTile(page).click();
  await expect(dmsNav(page).getByRole('button', { name: new RegExp(`^${FRIEND}`) })).toBeVisible({ timeout: WAIT });
  await expectListGrammar(page, tag, '.d-channel-list__list', '.d-chrow__name', 'direct messages');
  await expectBar(page, tag, 'the sidebar head (direct messages)', '.d-channel-list__head, .d-channel-list__title');
  await dmsNav(page).getByRole('button', { name: new RegExp(`^${FRIEND}`) }).click();
  await expect(page.getByRole('log')).toBeVisible({ timeout: WAIT });
  await expectBar(page, tag, 'the conversation header', '.d-channel-header');
  await expectNoOverflow(page, tag, 'a direct message');

  // The voice stage (B1), opened by its path so that Ada does not join (a click on a desktop voice row joins).
  if (voicePath !== '') {
    await openPath(page, voicePath);
    await expect(page.locator('.dw-voice-stage')).toBeVisible({ timeout: WAIT });
    await expectBar(page, tag, 'the stage header', '.d-call-stage__bar');
    await expectListGrammar(page, tag, '.d-channel-list__list', '.d-chrow__name, .d-voice-row__name, .d-channel-list__cat-label', 'channel list with a live person');
    const avatars = await boxes(page, '.d-voice-row__person .d-voice-row__avatar', '.d-channel-list__list');
    const rowNames = await boxes(page, '.d-voice-row__name', '.d-channel-list__list');
    if (avatars.length > 0 && rowNames.length > 0) expectAt(`A7 a person's avatar starts at the names' x at ${tag}`, avatars[0].x, rowNames[0].x, TOL);
    await expectNoOverflow(page, tag, 'the voice stage');
  }

  // User settings (B1): the settings bar's hairline is 48 below the top of the dialog.
  await page.locator('.d-user-panel').getByRole('button', { name: copy('panel.settings'), exact: true }).click();
  await expect(page.getByRole('dialog', { name: copy('settings.title'), exact: true })).toBeVisible({ timeout: WAIT });
  await expectBar(page, tag, 'the settings bar', '.d-settings-frame__bar', 48, '.d-settings-frame__panel');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: copy('settings.title'), exact: true })).toBeHidden({ timeout: WAIT });
}

/** Opens a path in the app without a click that would join a call. */
async function openPath(page: Page, path: string): Promise<void> {
  if (new URL(page.url()).pathname !== path) await page.goto(path);
  await expect(page.locator('.d-app-shell')).toBeVisible({ timeout: WAIT });
}
// ---------------------------------------------------------------------------------------------------
// Search (controller addition, UI-5).

async function searchModal(page: Page, serverPath: string): Promise<void> {
  await openPath(page, serverPath);
  await channelRow(page, 'general').click();
  const opener = channelRow(page, 'general');
  await opener.focus();
  await page.keyboard.press('Control+k');
  const dialog = page.locator('dialog[open]');
  await expect(dialog, 'the search palette is a modal dialog').toBeVisible({ timeout: WAIT });
  // Focus is in the dialog or out of the page (the browser's own chrome, one stop of a Tab cycle: activeElement is the body); a shell control never takes it.
  const stray = () => page.evaluate(() => {
    const el = document.activeElement;
    return el === null || el === document.body ? null : el.closest('dialog[open]') !== null ? null : `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`;
  });
  // More presses than the dialog has controls: Tab cycles inside it.
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Tab');
    expect.soft(await stray(), `Tab press ${String(i + 1)} never reaches a shell control`).toBeNull();
  }
  await page.keyboard.press('Shift+Tab');
  expect.soft(await stray(), 'Shift+Tab never reaches a shell control').toBeNull();
  // The shell behind it is inert: a channel row is not hit-testable, and a click on it does not focus it (it may dismiss the palette, which returns focus to the opener, never to the row).
  const target = channelRow(page, RAID);
  const spot = await target.boundingBox();
  expect.soft(spot, 'a shell row stands behind the dialog').not.toBeNull();
  if (spot !== null) {
    const x = spot.x + 8;
    const y = spot.y + spot.height / 2;
    const hit = await page.evaluate(({ x: px, y: py }) => {
      const el = document.elementFromPoint(px, py);
      return el === null ? 'nothing' : el.closest('dialog[open]') !== null ? 'dialog' : el.closest('.d-chrow') !== null ? 'row' : `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`;
    }, { x, y });
    expect.soft(hit, 'the point over a shell row hits the dialog, not the row').toBe('dialog');
    await page.mouse.click(x, y);
    expect.soft(await target.evaluate(el => el === document.activeElement), 'a click outside the dialog does not focus the shell row').toBe(false);
  }
  if (await page.locator('dialog[open]').count() === 0) {
    // The click on the scrim dismissed it; open it again for the Escape check.
    await opener.focus();
    await page.keyboard.press('Control+k');
    await expect(page.locator('dialog[open]')).toBeVisible({ timeout: WAIT });
  }
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog[open]')).toHaveCount(0, { timeout: WAIT });
  await expect(opener, 'Escape returns focus to the opener').toBeFocused();
}

// ---------------------------------------------------------------------------------------------------
// Collapsed categories (R23).

async function collapsedCategory(page: Page, serverPath: string): Promise<void> {
  const head = (name: string) => nav(page).locator('.d-channel-list__cat-head').filter({ hasText: name });
  await openPath(page, serverPath);
  await channelRow(page, 'general').click();
  // Collapse "planning": #news is read and not current, so it folds away; #raid has Mira's unread message, so it stays.
  await head(PLAN).click();
  await expect(head(PLAN)).toHaveAttribute('aria-expanded', 'false');
  await expect.soft(channelRow(page, RAID), 'an unread row stays in a collapsed category').toBeVisible();
  await expect.soft(channelRow(page, NEWS), 'a read row folds away').toHaveCount(0);
  // Open #raid, which reads it: it is now current, so it stays; #news is still folded.
  await channelRow(page, RAID).click();
  await expect.soft(channelRow(page, RAID), 'the current row stays in a collapsed category').toBeVisible();
  await expect.soft(channelRow(page, NEWS)).toHaveCount(0);
  // Leave it: the read row folds too.
  await channelRow(page, 'general').click();
  await expect.soft(channelRow(page, RAID), 'once read and left, the row folds away').toHaveCount(0);
  await head(PLAN).click();
  await expect(head(PLAN)).toHaveAttribute('aria-expanded', 'true');
  await expect(channelRow(page, NEWS)).toBeVisible();
}

// ---------------------------------------------------------------------------------------------------
// Phone.

async function phoneGrammar(page: Page, size: Size, serverPath: string, voicePath: string): Promise<void> {
  const { tag } = size;
  const tabs = page.getByRole('navigation', { name: copy('nav.tabs.label'), exact: true });
  const tab = (key: string) => tabs.getByRole('link', { name: new RegExp(`^${escapeRegExp(copy(key))}`) });
  const back = page.getByRole('button', { name: copy('nav.back'), exact: true });
  const pane = (want: 'list' | 'view') => expect(page.locator('.d-app-shell')).toHaveAttribute('data-pane', want, { timeout: WAIT });
  /** Back out of a pushed view to the list it came from. */
  const toList = async () => { if (await back.isVisible().catch(() => false)) await back.click(); await pane('list'); };

  // The home tab: the rail beside the server's channel list.
  await openPath(page, serverPath);
  await toList();
  await tab('home.tab').click();
  await expect(nav(page).getByRole('button', { name: new RegExp(`^${escapeRegExp(RAID)}`) })).toBeVisible({ timeout: WAIT });
  await expectListGrammar(page, tag, '.d-channel-list__list', '.d-chrow__name, .d-voice-row__name, .d-channel-list__cat-label', 'channel list');
  await expectBar(page, tag, 'the sidebar head', '.d-channel-list__head');
  await expectTargets(page, tag, 'the home tab');
  for (const tile of await boxes(page, '.d-community-rail__item, .d-community-rail__join')) {
    expect.soft(Math.min(tile.w, tile.h), `R9 rail tile "${tile.t}" is at least 44 at ${tag}`).toBeGreaterThanOrEqual(44 - TOL);
  }
  // The controller addition (UI-2 review): in the real app the voice join button and the category "+" are 44 on a phone.
  for (const [selector, what] of [['.d-voice-row__join button', 'the voice join button'], ['.d-channel-list__cat-add button', 'the category "+"']] as const) {
    const found = await boxes(page, selector);
    expect.soft(found.length, `R9 ${what} is on the home tab at ${tag}`).toBeGreaterThan(0);
    for (const b of found) {
      expect.soft(b.w, `R9 ${what} is 44 wide at ${tag}`).toBeGreaterThanOrEqual(44 - TOL);
      expect.soft(b.h, `R9 ${what} is 44 high at ${tag}`).toBeGreaterThanOrEqual(44 - TOL);
    }
  }

  // A channel is a pushed view under the phone header.
  await channelRow(page, 'general').click();
  await pane('view');
  await expectBar(page, tag, 'the phone header (channel)', '.d-phone-header');
  await expectSafeAreaBar(page, tag);
  await expectTargets(page, tag, 'a channel');
  await expectNoOverflow(page, tag, 'a channel');
  await expectWrapsInLog(page, tag, 'a channel');
  await toList();

  // The voice stage, by its path (a tap on a voice row only opens it, but its join icon joins).
  if (voicePath !== '') {
    await openPath(page, voicePath);
    await pane('view');
    await expect(page.locator('.dw-voice-stage')).toBeVisible({ timeout: WAIT });
    await expectBar(page, tag, 'the phone header (voice)', '.d-phone-header');
    await expectTargets(page, tag, 'the voice stage');
    await expectNoOverflow(page, tag, 'the voice stage');
    await toList();
  }

  // The direct messages: the rail's `@` tile, then a conversation.
  await homeTile(page).click();
  await expect(dmsNav(page).getByRole('button', { name: new RegExp(`^${FRIEND}`) })).toBeVisible({ timeout: WAIT });
  await expectListGrammar(page, tag, '.d-channel-list__list', '.d-chrow__name', 'direct messages');
  await expectBar(page, tag, 'the direct messages head', '.d-channel-list__head');
  await expectTargets(page, tag, 'the direct messages');
  await dmsNav(page).getByRole('button', { name: new RegExp(`^${FRIEND}`) }).click();
  await pane('view');
  await expectBar(page, tag, 'the phone header (direct message)', '.d-phone-header');
  await expectNoOverflow(page, tag, 'a direct message');
  await toList();

  // The activity tab and the you tab, and a settings section reached from it.
  await tab('nav.tab.activity').click();
  await expect(page.locator('.d-phone-header')).toBeVisible({ timeout: WAIT });
  await expectBar(page, tag, 'the phone header (activity)', '.d-phone-header');
  await expectTargets(page, tag, 'the activity tab');
  await tab('nav.tab.you').click();
  await expect(page.locator('[data-settings-section]').first()).toBeVisible({ timeout: WAIT });
  await expectBar(page, tag, 'the phone header (you)', '.d-phone-header');
  await expectTargets(page, tag, 'the you tab');
  await page.locator('[data-settings-section]').first().click();
  await expect(page).toHaveURL(/\/settings\/[a-z]+$/, { timeout: WAIT });
  // User settings on a phone is a pushed view under the phone header: the frame's own Close bar and nav are not drawn, so
  // there is no bar to hold at 48 (nor one at the stacked-nav height).
  await expectBar(page, tag, 'the phone header (settings)', '.d-phone-header');
  expect.soft(await page.locator('.d-settings-frame__bar').evaluate(el => el.getClientRects().length), `the settings Close bar is not drawn on a phone at ${tag}`).toBe(0);
  await expectTargets(page, tag, 'a settings section');
  await back.click();

  // Server settings on a phone is the dialog with its navigation stacked above the pane: the Close bar is 48 high and
  // stands directly under that stack (so its hairline is below 48, never at it).
  await openPath(page, serverPath);
  await toList();
  await page.getByRole('button', { name: copy('admin.open'), exact: true }).click();
  const admin = page.getByRole('dialog', { name: copy('admin.title'), exact: true });
  await expect(admin).toBeVisible({ timeout: WAIT });
  const side = (await boxes(page, '.d-settings-frame__side'))[0];
  const bar = (await boxes(page, '.d-settings-frame__bar'))[0];
  expect.soft(side !== undefined && bar !== undefined, `the server settings dialog has its stacked navigation and its Close bar at ${tag}`).toBe(true);
  if (side !== undefined && bar !== undefined) {
    expectAt(`B1 the Close bar is 48 high at ${tag}`, bar.h, 48, 0.5);
    expectAt(`B1 the Close bar stands directly under the stacked navigation at ${tag}`, bar.y, side.b, 0.5);
    expect.soft(bar.b, `B1 the Close bar's hairline is below the stacked navigation, not at 48, at ${tag}`).toBeGreaterThan(48 + TOL);
  }
  await page.keyboard.press('Escape');
  await expect(admin).toBeHidden({ timeout: WAIT });
}

// ---------------------------------------------------------------------------------------------------
// The built-in AFK channel (WEB-AFK): its row is a voice row on the list's grammar, and its timeout is a settings row under
// the name row in the Overview, on the settings grammar, with the section's one save in the frame's footer.

test('the AFK row and the AFK timeout setting keep the grammar', async ({ page }) => {
  const h = started();
  await page.setViewportSize({ width: 1440, height: 900 });
  await signUp(page, h.invite.split(',')[0], instance, 'Bea', h.control);
  await addServerVia(page, 'create');
  const start = page.getByRole('dialog', { name: copy('create.server.title'), exact: true });
  await start.getByRole('textbox', { name: copy('create.server.name'), exact: true }).fill('Bifrost');
  await page.keyboard.press('Enter');
  await expect(start).toBeHidden({ timeout: WAIT });
  await expectComposerReady(page, 'general');
  const afk = nav(page).getByRole('button', { name: copy('voice.open', { name: 'AFK' }), exact: true });
  await expect(afk, 'the built-in AFK channel is a voice row').toBeVisible({ timeout: WAIT });
  await expectListGrammar(page, 'AFK 1440x900', '.d-channel-list__list', '.d-chrow__name, .d-voice-row__name', 'channel list with the AFK row');
  await page.getByRole('button', { name: copy('admin.open'), exact: true }).click();
  const settings = page.getByRole('dialog', { name: copy('admin.title'), exact: true });
  const nameRow = settings.locator('.d-settings-row').filter({ hasText: copy('admin.overview.name') });
  const timeout = settings.locator('.d-settings-row').filter({ hasText: copy('afk.timeout.label') });
  await expect(timeout, 'the AFK timeout is a settings row in the Overview').toBeVisible({ timeout: WAIT });
  const [nameBox, timeoutBox] = [await nameRow.boundingBox(), await timeout.boundingBox()];
  expect.soft(nameBox !== null && timeoutBox !== null && timeoutBox.y > nameBox.y, 'the timeout row stands under the name row').toBe(true);
  const labels = await boxes(page, '.d-settings-row__label', '.d-settings-frame__body');
  expect.soft(labels.length, 'the Overview has its name and timeout rows').toBeGreaterThanOrEqual(2);
  expectOne('A5 the Overview rows share one label x', labels.map(b => b.x), labels.map(b => b.t));
  const controls = await boxes(page, '.d-settings-row__control', '.d-settings-frame__body');
  expectOne('A4 the Overview rows share one control right edge', controls.map(b => b.r), controls.map(b => b.t));
  await expect(settings.locator('.d-settings-frame__footer').getByRole('button', { name: copy('admin.overview.save'), exact: true }), 'one save in the footer').toHaveCount(1);
  expect.soft(await settings.getByRole('button', { name: copy('admin.overview.save'), exact: true }).count(), 'no other save button').toBe(1);
});

// ---------------------------------------------------------------------------------------------------
// AUDIT-2 FA1 (H4, N3, I1): on a phone every button, select and toggle switch is at least 44 high, outside the shell too
// (onboarding, sign-in), and the invites section is on the settings grammar.

/** Every visible button, select and switch inside `root` (the whole page when omitted) is at least 44 high on a phone. */
async function expectPhoneTargets(page: Page, what: string, root?: string): Promise<void> {
  const found = await boxes(page, 'button, select, [role="switch"], a.d-btn', root);
  expect.soft(found.length, `H4 ${what}: something to measure`).toBeGreaterThan(0);
  for (const b of found) expect.soft(b.h, `H4 ${what}: "${b.t}" is ${b.h.toFixed(1)} high, want 44`).toBeGreaterThanOrEqual(44 - TOL);
}

test('FA1: phone targets are 44 high outside the shell, and the invites section keeps the settings grammar', async ({ page }) => {
  const h = started();
  await page.setViewportSize({ width: 390, height: 844 });
  const account = newAccount('Fia', h.control);
  const invite = h.invite.split(',')[0];
  await page.goto(`/welcome?invite=${encodeURIComponent(invite)}`);
  await expect(page.getByRole('heading', { name: copy('onboarding.connect.title', { instance }), exact: true })).toBeVisible({ timeout: WAIT });
  await expectPhoneTargets(page, 'onboarding connect step at 390');
  await page.getByRole('button', { name: copy('onboarding.connect.signIn'), exact: true }).click();
  await expect(page.getByRole('heading', { name: copy('signin.login.title', { instance }), exact: true })).toBeVisible({ timeout: WAIT });
  await expectPhoneTargets(page, 'sign-in at 390');
  await page.goto(`/welcome?invite=${encodeURIComponent(invite)}`);
  await completeSignUp(page, account, instance);

  for (const section of ['voice', 'devices', 'notifications'] as const) {
    await page.goto(`/settings/${section}`);
    await expect(page.locator('.d-settings-row, .d-voice-settings').first()).toBeVisible({ timeout: WAIT });
    await expectPhoneTargets(page, `settings, ${section} at 390`);
  }
  await page.goto('/settings/devices');
  const refresh = page.getByRole('button', { name: copy('devices.refresh'), exact: true });
  await expect(refresh).toBeVisible({ timeout: WAIT });
  expect.soft((await refresh.boundingBox())?.height ?? 0, 'H4 the refresh button is 44 high on a phone').toBeGreaterThanOrEqual(44 - TOL);

  // The invites section on a desktop: rows of a label and a control column, as the Overview has them; then the link dialog's Copy at 390.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.locator('.d-app-shell')).toBeVisible({ timeout: WAIT });
  await addServerVia(page, 'create');
  const start = page.getByRole('dialog', { name: copy('create.server.title'), exact: true });
  await start.getByRole('textbox', { name: copy('create.server.name'), exact: true }).fill('Invitation');
  await page.keyboard.press('Enter');
  await expect(start).toBeHidden({ timeout: WAIT });
  await expectComposerReady(page, 'general');
  await page.getByRole('button', { name: copy('admin.open'), exact: true }).click();
  const admin = page.getByRole('dialog', { name: copy('admin.title'), exact: true });
  await admin.getByRole('navigation', { name: copy('admin.nav'), exact: true }).getByRole('button', { name: copy('admin.nav.invites'), exact: true }).click();
  const rows = admin.locator('.d-settings-frame__body .d-settings-row');
  await expect(rows.first(), 'I1 the invites section is on SettingsRow').toBeVisible({ timeout: WAIT });
  expect.soft(await rows.count(), 'I1 expires after and max uses are two settings rows').toBe(2);
  expect.soft(await admin.locator('.d-select__label').count(), 'I1 no stacked micro-uppercase label is left').toBe(0);
  const labels = await boxes(page, '.d-settings-row__label', '.d-settings-frame__body');
  expectOne('I1 the invites rows share one label x', labels.map(b => b.x), labels.map(b => b.t));
  const controls = await boxes(page, '.d-settings-row__control', '.d-settings-frame__body');
  expectOne('I1 the invites rows share one control x', controls.map(b => b.x), controls.map(b => b.t));
  expectOne('I1 the invites rows share one control right edge', controls.map(b => b.r), controls.map(b => b.t));
  for (const c of controls) expectAt(`I1 the control column "${c.t}" is 16rem`, c.w, 256, 1);

  // On a phone: the same section, its selects, its make button and the link dialog's Copy are 44 high.
  await page.keyboard.press('Escape');
  await expect(admin).toBeHidden({ timeout: WAIT });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.d-app-shell')).toHaveAttribute('data-layout', 'phone', { timeout: WAIT });
  const back = page.getByRole('button', { name: copy('nav.back'), exact: true });
  if (await back.isVisible().catch(() => false)) await back.click();
  await expect(page.locator('.d-app-shell')).toHaveAttribute('data-pane', 'list', { timeout: WAIT });
  await page.getByRole('button', { name: copy('admin.open'), exact: true }).click();
  await expect(admin).toBeVisible({ timeout: WAIT });
  await admin.getByRole('navigation', { name: copy('admin.nav'), exact: true }).getByRole('button', { name: copy('admin.nav.invites'), exact: true }).click();
  await expect(admin.getByRole('button', { name: copy('admin.invites.create'), exact: true })).toBeVisible({ timeout: WAIT });
  await expectPhoneTargets(page, 'server settings, invites at 390', '.d-settings-frame__body');
  await admin.getByRole('button', { name: copy('admin.invites.create'), exact: true }).click();
  const link = page.locator('.d-invite-link');
  await expect(link.locator('button').first(), 'the link dialog shows its Copy').toBeVisible({ timeout: WAIT });
  await expectPhoneTargets(page, 'the invite link dialog at 390', '.d-invite-link');
});


// ---------------------------------------------------------------------------------------------------
// web3.9 FA2 (AUDIT-2 N1, N2, N4, D4): the DM and voice layout. Each visual element has its room: the desktop call is an icon in
// the DM header (no band under it), "message someone" an icon in the DM list's head (no footer), the voice preview keeps its
// title, people and join in one column at the top, and a phone's call controls pin directly above the tab bar.

test('the DM and the voice layout give each element its room', async ({ page, playwright, browserName, launchOptions, headless, channel, guard }, testInfo) => {
  test.skip(browserName === 'webkit', 'a call needs the media stack; this check measures Chromium and Firefox');
  const h = started();
  await page.setViewportSize({ width: 1440, height: 900 });
  await signUp(page, h.invite.split(',')[0], instance, 'Bea', h.control);
  await addServerVia(page, 'create');
  const start = page.getByRole('dialog', { name: copy('create.server.title'), exact: true });
  await start.getByRole('textbox', { name: copy('create.server.name'), exact: true }).fill('Ydalir');
  await page.keyboard.press('Enter');
  await expect(start).toBeHidden({ timeout: WAIT });
  await expectComposerReady(page, 'general');
  const link = await makeInviteLink(page, 'Ydalir');
  const secondDir = secondProfileDir(testInfo.project.name, testInfo.workerIndex);
  const second = await launchSecond(playwright, browserName, { launchOptions, headless, channel, viewport: { width: 1440, height: 900 }, baseURL: h.url }, secondDir);
  try {
    const cy = second.pages()[0] ?? (await second.newPage());
    await cy.goto(new URL(link).pathname);
    const openLink = cy.getByRole('link', { name: 'Open dilla in this browser', exact: true });
    await expect(openLink).toBeVisible({ timeout: WAIT });
    await guard.attach(second);
    await openLink.click();
    await completeSignUp(cy, newAccount('Cy', h.control), instance);
    await expect(railItem(cy, 'Ydalir')).toBeVisible({ timeout: WAIT });
    await homeTile(cy).click();
    await cy.getByRole('button', { name: copy('shell.dms.new'), exact: true }).click();
    await cy.getByRole('dialog', { name: copy('shell.dms.newTitle'), exact: true }).getByRole('button', { name: copy('shell.dms.open'), exact: true }).click();
    const dmBox = cy.getByRole('textbox', { name: copy('shell.dm.composer', { name: 'Bea' }), exact: true });
    await expect(dmBox).toBeEnabled({ timeout: WAIT });
    await dmBox.fill('hello Bea');
    await dmBox.press('Enter');
    await expect(cy.getByRole('log').locator('.d-message-row').filter({ hasText: 'hello Bea' })).toHaveAttribute('data-state', 'ok', { timeout: WAIT });

    // The AFK channel's path: a click on its desktop row opens it and marks the person away, with no call (AW5); its stage is the preview.
    await nav(page).getByRole('button', { name: copy('voice.open', { name: 'AFK' }), exact: true }).click();
    await expect(page.locator('.dw-voice-stage')).toBeVisible({ timeout: WAIT });
    const afkPath = new URL(page.url()).pathname;

    // N1, N2: the DM list and the DM.
    await homeTile(page).click();
    await expect(dmsNav(page).getByRole('button', { name: /^Cy/ })).toBeVisible({ timeout: WAIT });
    await expect.soft(page.locator('.d-channel-list__head').getByRole('button', { name: copy('shell.dms.new'), exact: true }), 'N2 "message someone" is a button in the DM list head').toBeVisible({ timeout: WAIT });
    expect.soft(await boxes(page, '.d-channel-list__footer'), 'N2 the DM list has no footer row').toEqual([]);
    expect.soft(await page.locator('.d-channel-list').getByRole('button', { name: copy('shell.dms.new'), exact: true }).count(), 'N2 one "message someone" action').toBe(1);
    const dmHead = (await boxes(page, '.d-channel-list__head'))[0];
    const dmNew = (await boxes(page, '.d-channel-list__head button'))[0];
    if (dmHead !== undefined && dmNew !== undefined) {
      expect.soft(dmNew.y >= dmHead.y - TOL && dmNew.b <= dmHead.b + TOL, 'N2 the action stands inside the 48 head').toBe(true);
    }
    await dmsNav(page).getByRole('button', { name: /^Cy/ }).click();
    await expect(page.getByRole('log')).toBeVisible({ timeout: WAIT });
    const header = (await boxes(page, '.d-channel-header'))[0];
    await expect.soft(page.locator('.d-channel-header').getByRole('button', { name: copy('call.start'), exact: true }), 'N1 the call is a button in the DM header').toBeVisible({ timeout: WAIT });
    const callBox = (await boxes(page, '.d-channel-header button[aria-label]')).find(b => b.t === copy('call.start'));
    if (header !== undefined && callBox !== undefined) {
      expect.soft(callBox.y >= header.y - TOL && callBox.b <= header.b + TOL && callBox.r <= header.r + TOL, 'N1 the call button stands inside the header').toBe(true);
      expect.soft(callBox.w, 'N1 the call is an icon, not a text button').toBeLessThanOrEqual(44 + TOL);
    }
    expect.soft((await boxes(page, '.dw-call-strip')).map(b => b.h), 'N1 no band under the header: the call strip is collapsed').toEqual((await boxes(page, '.dw-call-strip')).map(() => 0));
    const log = (await boxes(page, '[role="log"]'))[0];
    if (header !== undefined && log !== undefined) expect.soft(log.y - header.b, 'N1 the log starts directly under the header').toBeLessThanOrEqual(8);

    // N4: the AFK preview, one column at the top.
    await page.goto(afkPath);
    await expect(page.locator('.dw-voice-join')).toBeVisible({ timeout: WAIT });
    // AW5: the AFK channel hosts no call, so its preview has no tiles.
    await expect(page.locator('.dw-voice-stage .d-call-stage__tile'), 'N4 the AFK preview is empty').toHaveCount(0, { timeout: WAIT });
    const join = (await boxes(page, '.dw-voice-join'))[0];
    const texts = await boxes(page, '.d-call-stage__outgoing, .d-call-stage__empty, .d-call-stage__title');
    expect.soft(texts.length, 'N4 the preview has its text').toBeGreaterThan(0);
    if (join !== undefined && texts.length > 0) {
      const lowest = Math.max(...texts.map(b => b.b));
      expect.soft(join.y - lowest, `N4 the join sits within 120 of its text (${texts.map(b => `${b.t}@${b.x.toFixed(0)},${b.y.toFixed(0)}`).join(' | ')} join@${join.x.toFixed(0)},${join.y.toFixed(0)})`).toBeLessThanOrEqual(120);
      expectOne('N4 the preview texts and the join share one left edge', [...texts.map(b => b.x), join.x], [...texts.map(b => b.t), 'join']);
    }
    await expectNoOverflow(page, '1440x900', 'the AFK preview');

    // D4: the phone's call stage fills the view and its controls end directly above the tab bar.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.d-app-shell')).toHaveAttribute('data-layout', 'phone', { timeout: WAIT });
    const phoneJoin = page.locator('.dw-voice-join');
    await expect(phoneJoin).toBeVisible({ timeout: WAIT });
    const pjoin = (await boxes(page, '.dw-voice-join'))[0];
    const ptexts = await boxes(page, '.d-call-stage__outgoing, .d-call-stage__empty');
    if (pjoin !== undefined && ptexts.length > 0) {
      expect.soft(pjoin.y - Math.max(...ptexts.map(b => b.b)), 'N4 on a phone the join sits within 120 of its text').toBeLessThanOrEqual(120);
    }
    // AW5: the AFK channel hosts no call, so D4 measures the call stage of voice general: the phone's server list, a tap on
    // its row (a phone's tap only opens the stage, R24), then its join.
    await page.goto(afkPath.split('/').slice(0, 3).join('/'));
    await nav(page).getByRole('button', { name: copy('voice.open', { name: 'general' }), exact: true }).click();
    await expect(phoneJoin).toBeVisible({ timeout: WAIT });
    await phoneJoin.click();
    await expect(page.locator('.dw-voice-stage')).toHaveAttribute('data-call-phase', 'in', { timeout: WAIT });
    const tabs = (await boxes(page, '.d-tab-bar'))[0];
    const controls = (await boxes(page, '.d-call-stage__controls'))[0];
    expect.soft(tabs !== undefined && controls !== undefined, 'D4 the tab bar and the controls are on screen').toBe(true);
    if (tabs !== undefined && controls !== undefined) {
      expect.soft(tabs.y - controls.b, `D4 the controls' bottom edge is at most 8 above the tab bar (controls ${controls.y.toFixed(0)}..${controls.b.toFixed(0)}, tab bar ${tabs.y.toFixed(0)})`).toBeLessThanOrEqual(8);
      expect.soft(tabs.y - controls.b, 'D4 the controls do not sink into the tab bar').toBeGreaterThanOrEqual(-TOL);
    }
  } finally {
    await second.close();
    rmSync(secondDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------
// web3.9 FA4 (AUDIT-2 J1, H5, H6, I6, I7): search results with #channel, author and time and a KeyHint footer; the You tab's icons
// with sign out; no repeated title in a phone's settings view; the admin reorder as arrow icon buttons with truncated names; privacy
// "Compare with ..." as ghost buttons. Read as rects and computed styles, with axe in all three themes where the surface is new.

const THEMES = ['mesh', 'light', 'high-contrast'] as const;
async function expectAccessibleInThemes(page: Page, state: string): Promise<void> {
  const before = await page.evaluate(() => document.documentElement.dataset.theme ?? '');
  try {
    for (const theme of THEMES) {
      await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
      await expectAccessible(page, `${state} in the ${theme} theme`);
    }
  } finally { await page.evaluate(t => { if (t === '') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t; }, before); }
}

test('FA4: search rows, You icons, phone settings title, channel reorder and privacy Compare', async ({ page, playwright, browserName, launchOptions, headless, channel }, testInfo) => {
  const h = started();
  const CHAN = 'raid-planning-for-the-bridge-troll-and-the-long-winter-campaign';
  await page.setViewportSize({ width: 1440, height: 900 });
  await signUp(page, h.invite.split(',')[0], instance, 'Cleo', h.control);
  await addServerVia(page, 'create');
  const start = page.getByRole('dialog', { name: copy('create.server.title'), exact: true });
  await start.getByRole('textbox', { name: copy('create.server.name'), exact: true }).fill(SERVER);
  await page.keyboard.press('Enter');
  await expect(start).toBeHidden({ timeout: WAIT });
  await expectComposerReady(page, 'general');
  await makeCategory(page, PLAN);
  await makeChannelIn(page, PLAN, 'text', CHAN);
  await makeChannelIn(page, PLAN, 'text', 'second');
  await channelRow(page, 'general').click();
  await expectComposerReady(page, 'general');
  await sendText(page, 'general', 'lamp from Cleo');
  const link = await makeInviteLink(page, SERVER);
  const secondDir = secondProfileDir(testInfo.project.name, testInfo.workerIndex);
  const second = await launchSecond(playwright, browserName, { launchOptions, headless, channel, viewport: { width: 1440, height: 900 }, baseURL: h.url }, secondDir);
  try {
    const mira = second.pages()[0] ?? (await second.newPage());
    await mira.goto(new URL(link).pathname);
    const openLink = mira.getByRole('link', { name: 'Open dilla in this browser', exact: true });
    await expect(openLink).toBeVisible({ timeout: WAIT });
    await openLink.click();
    await completeSignUp(mira, newAccount(FRIEND, h.control), instance);
    await railItem(mira, SERVER).click();
    await channelRow(mira, 'general').click();
    await expectComposerReady(mira, 'general');
    await sendText(mira, 'general', 'lamp from Mira');
    await expect(page.getByRole('log').getByText('lamp from Mira')).toBeVisible({ timeout: WAIT });

    // J1: each result names #channel, author and time; a footer lists the three keys; the palette is at most 40rem.
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox', { name: copy('search.placeholder'), exact: true }).fill('lamp');
    const mine = page.getByRole('option', { name: /lamp from Mira/ });
    await expect(mine).toBeVisible({ timeout: WAIT });
    await attempt('J1 search result', async () => {
      const text = (await mine.innerText()).replace(/\s+/g, ' ');
      expect.soft(text, 'J1 the result names its channel with a hash').toContain('#general');
      expect.soft(text, 'J1 the result names its author').toContain(FRIEND);
      expect.soft(text, 'J1 the result shows a time').toMatch(/\d{1,2}:\d{2}/);
      const own = (await page.getByRole('option', { name: /lamp from Cleo/ }).innerText()).replace(/\s+/g, ' ');
      expect.soft(own, 'J1 the own result names its author').toContain('Cleo');
      const hints = await boxes(page, '.d-search-palette__hints .d-keyhint');
      expect.soft(hints.map(k => k.t), 'J1 the footer lists the three keys').toEqual([`↑↓${copy('layout.search.hint.move')}`, `↵${copy('layout.search.hint.open')}`, `esc${copy('layout.search.hint.close')}`]);
      const list = (await boxes(page, '.d-search-palette [role="listbox"]'))[0];
      const dialog = (await boxes(page, '.d-search-palette'))[0];
      expect.soft(hints.length > 0 && list !== undefined && hints[0].y >= list.b - TOL, 'J1 the footer stands under the results').toBe(true);
      expect.soft(dialog?.w ?? 999, 'J1 the palette is at most 40rem (640)').toBeLessThanOrEqual(640 + TOL);
      const meta = (await boxes(page, '.d-search-palette__meta'))[0];
      expect.soft(meta !== undefined && meta.h < 24, `J1 the meta line is one line (${String(meta?.h)})`).toBe(true);
    });
    await expectAccessibleInThemes(page, 'the search palette with results');
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog.d-search-palette-dialog')).toBeHidden({ timeout: WAIT });

    // I6: move up/down are 32px arrow icon buttons in trailing slots; one right edge; the long name is cut to one line.
    await page.getByRole('button', { name: copy('admin.open'), exact: true }).click();
    const admin = page.getByRole('dialog', { name: copy('admin.title'), exact: true });
    await admin.getByRole('navigation', { name: copy('admin.nav'), exact: true }).getByRole('button', { name: copy('admin.nav.channels'), exact: true }).click();
    await expect(admin.locator('.dw-admin-row').first()).toBeVisible({ timeout: WAIT });
    await attempt('I6 channel reorder', async () => {
      expect.soft(await admin.locator('[data-move$=":up"]').count(), 'I6 a move-up control per channel and category').toBeGreaterThan(2);
      for (const kind of ['up', 'down']) {
        const all = await boxes(page, `[data-move$=":${kind}"]`, '.d-settings-frame__body');
        for (const b of all) { expectAt(`I6 move ${kind} is 32 wide`, b.w, 32, 0.5); expectAt(`I6 move ${kind} is 32 high`, b.h, 32, 0.5); }
        const glyphs = await admin.locator(`[data-move$=":${kind}"] svg`).count();
        expect.soft(glyphs, `I6 every move ${kind} is an icon`).toBe(all.length);
      }
      expect.soft(await admin.locator('[data-move]').evaluateAll(els => els.map(e => (e.textContent ?? '').trim()).filter(Boolean)), 'I6 the moves carry no visible text').toEqual([]);
      const rows = await boxes(page, '.dw-admin-row', '.d-settings-frame__body');
      expectOne('I6 every channel row is as high as the others', rows.map(b => b.h), rows.map(b => b.t));
      expect.soft(rows[0]?.h ?? 99, 'I6 the long-named row is 44 high, not wrapped').toBeLessThanOrEqual(44.5);
      const trail = await boxes(page, '.dw-admin-row .d-manage-list__trail', '.d-settings-frame__body');
      expectOne('I6 the trailing icons share one right edge', trail.map(b => b.r), trail.map(b => b.t));
      // The longest name fits a wide dialog; at a phone's width it must be cut to one line, with the row still 44 high.
      await page.setViewportSize({ width: 390, height: 844 });
      const name = admin.locator('.dw-admin-row .dw-admin-name', { hasText: CHAN });
      await expect.poll(() => name.evaluate(e => e.scrollWidth > e.clientWidth), { message: 'I6 the long name is cut at 390', timeout: WAIT }).toBe(true);
      const cut = await name.evaluate(e => ({ h: e.getBoundingClientRect().height, ellipsis: getComputedStyle(e).textOverflow, ws: getComputedStyle(e).whiteSpace, row: e.closest('.dw-admin-row')?.getBoundingClientRect().height ?? 0 }));
      expect.soft(cut.h, 'I6 the long name is one line high at 390').toBeLessThan(26);
      const rowsPhone = await boxes(page, '.dw-admin-row', '.d-settings-frame__body');
      expectOne('I6 every channel row is as high as the others at 390 (one line each)', rowsPhone.map(b => b.h), rowsPhone.map(b => b.t));
      expect.soft(cut.row, 'I6 the long-named row is one line plus the 44 slots (<= 54) at 390').toBeLessThanOrEqual(54);
      expect.soft(cut.ellipsis === 'ellipsis' && cut.ws === 'nowrap', `I6 the long name is cut with an ellipsis (${JSON.stringify(cut)})`).toBe(true);
      const trailPhone = await boxes(page, '.dw-admin-row .d-manage-list__trail', '.d-settings-frame__body');
      expectOne('I6 the trailing icons share one right edge at 390', trailPhone.map(b => b.r), trailPhone.map(b => b.t));
      await page.setViewportSize({ width: 1440, height: 900 });
    });
    await expectAccessibleInThemes(page, 'the admin channel list');
    await page.keyboard.press('Escape');
    await expect(admin).toBeHidden({ timeout: WAIT });

    // I7: every Compare is a ghost button; at most one accent action in the section.
    const settings = await openSettings(page, 'privacy');
    const compare = settings.getByRole('button', { name: copy('privacy.compare', { name: FRIEND }), exact: true });
    await expect(compare).toBeVisible({ timeout: WAIT });
    await attempt('I7 privacy compare', async () => {
      expect.soft(await compare.getAttribute('data-variant'), 'I7 Compare is a ghost button').toBe('ghost');
      expect.soft(await settings.locator('.dw-settings-section [data-variant="accent"]').count(), 'I7 at most one accent action in the section').toBeLessThanOrEqual(1);
      const look = await compare.evaluate(e => ({ bg: getComputedStyle(e).backgroundColor, h: e.getBoundingClientRect().height }));
      expect.soft(look.bg, 'I7 a ghost button has no fill').toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
      expect.soft(look.h, 'I7 Compare is one line high').toBeLessThanOrEqual(44);
    });
    await expectAccessibleInThemes(page, 'privacy');
    await closeSettings(page);

    // H6 and H5 on a phone: the You tab has an icon per row, including sign out; a settings view repeats no title.
    await page.setViewportSize({ width: 390, height: 844 });
    const tabs = page.getByRole('navigation', { name: copy('nav.tabs.label'), exact: true });
    await tabs.getByRole('link', { name: copy('nav.tab.you'), exact: true }).click();
    await expect(page.locator('[data-settings-section]').first()).toBeVisible({ timeout: WAIT });
    await attempt('H6 You icons', async () => {
      const rowIcons = await boxes(page, '[data-settings-section] > svg:first-child');
      const rowCount = await page.locator('[data-settings-section]').count();
      expect.soft(rowIcons.length, 'H6 every settings row has a leading icon').toBe(rowCount);
      const out = (await boxes(page, '.dw-you__signout svg'))[0];
      expect.soft(out !== undefined, 'H6 sign out has an icon').toBe(true);
      expectOne('H6 the icons share one left x, sign out included', [...rowIcons.map(b => b.x), ...(out === undefined ? [] : [out.x])], [...rowIcons.map(b => b.t || 'row'), 'sign out']);
      const shapes = await page.locator('[data-settings-section] > svg:first-child').evaluateAll(els => els.map(e => e.innerHTML));
      expect.soft(new Set(shapes).size, 'H6 each row has its own icon').toBe(shapes.length);
    });
    await expectAccessibleInThemes(page, 'the You tab');
    await page.locator('[data-settings-section="privacy"]').click();
    const phoneSettings = settingsDialog(page);
    await expect(phoneSettings).toBeVisible({ timeout: WAIT });
    await attempt('H5 phone settings title', async () => {
      const headings = await boxes(page, 'h1, h2', '.d-settings-frame');
      expect.soft(headings.filter(b => b.w > 2 && b.h > 2).map(b => b.t), 'H5 only the PhoneHeader title is drawn as a heading').toHaveLength(1);
    });
    await expectAccessibleInThemes(page, 'a phone settings view');
  } finally {
    await second.close();
    rmSync(secondDir, { recursive: true, force: true });
  }
});

// FB: the Home sidebar of a desktop is titled for the DMs, and at 360 a file card under images keeps its name inside the log.
test('FB1, FB2: the desktop Home title is not the server name; a file card stacks under the images at 360 and keeps its name', async ({ page }) => {
  const h = started();
  await page.setViewportSize({ width: 1440, height: 900 });
  await signUp(page, h.invite.split(',')[0], instance, 'Fia', h.control);
  await addServerVia(page, 'create');
  const start = page.getByRole('dialog', { name: copy('create.server.title'), exact: true });
  await start.getByRole('textbox', { name: copy('create.server.name'), exact: true }).fill('Vanaheim');
  await page.keyboard.press('Enter');
  await expect(start).toBeHidden({ timeout: WAIT });
  await expectComposerReady(page, 'general');
  const fileName = 'quarterly-planning-notes-for-the-long-winter-campaign.bin';
  const drawn = await drawImage(page, { width: 320, height: 240, type: 'image/png', seed: 3 });
  const drawn2 = await drawImage(page, { width: 320, height: 240, type: 'image/png', seed: 4 });
  await attachInput(page).setInputFiles([
    { name: 'one.png', mimeType: 'image/png', buffer: drawn.bytes },
    { name: 'two.png', mimeType: 'image/png', buffer: drawn2.bytes },
    { name: fileName, mimeType: 'application/octet-stream', buffer: Buffer.alloc(70_000, 7) },
  ]);
  await expect(trayEntries(page)).toHaveCount(3, { timeout: WAIT });
  for (let i = 0; i < 3; i++) await expect(trayEntries(page).nth(i)).toHaveAttribute('data-phase', 'ready', { timeout: WAIT });
  const text = `mixed ${String(Date.now())}`;
  await sendText(page, 'general', text);
  await expect(messageRow(page, 'general', text)).toHaveAttribute('data-state', 'ok', { timeout: WAIT });

  const channelPath = new URL(page.url()).pathname;
  await homeTile(page).click();
  const title = dmsNav(page).getByRole('heading', { level: 1 });
  await expect.soft(title, 'FB1 the Home sidebar is titled for the direct messages').toHaveText(copy('shell.dms.label'), { timeout: WAIT });
  await expect.soft(title, 'FB1 not the server name').not.toHaveText('Vanaheim');

  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto(channelPath);
  const row = messageRow(page, 'general', text);
  await expect(row).toBeVisible({ timeout: WAIT });
  await expect(row.locator('.d-attachment-card__file .d-attachment-card__name')).toBeVisible({ timeout: WAIT });
  const log = (await boxes(page, '[role="log"]'))[0];
  const card = (await boxes(page, '.d-attachment-card[data-kind="file"]'))[0];
  const name = (await boxes(page, '.d-attachment-card__file .d-attachment-card__name'))[0];
  const images = await boxes(page, '.d-attachment-card[data-kind="image"]');
  expect(log !== undefined && card !== undefined && name !== undefined && images.length > 0, 'FB2 the log, an image card and the file card are drawn').toBe(true);
  if (log === undefined || card === undefined || name === undefined) return;
  expect.soft(name.w, 'FB2 the file name has room').toBeGreaterThan(40);
  expect.soft(card.r, 'FB2 the file card is not wider than the log').toBeLessThanOrEqual(log.r + TOL);
  expect.soft(card.x, 'FB2 the file card starts inside the log').toBeGreaterThanOrEqual(log.x - TOL);
  expect.soft(card.y, 'FB2 the file card stands under the images').toBeGreaterThanOrEqual(Math.max(...images.map(b => b.b)) - TOL);
  const ellipsed = await page.locator('.d-attachment-card__file .d-attachment-card__name').first().evaluate(e => getComputedStyle(e).textOverflow);
  expect.soft(ellipsed, 'FB2 a long name is cut with an ellipsis').toBe('ellipsis');
});

// FC: "each visual element has its room". A file card beside an image keeps its save button's text whole at 1280 and at 1024
// with the members aside open, and the card stays inside the log; the button's accessible name still carries the file name.
test('FC: the save button of a file card beside an image is not clipped at 1280 and at 1024 with the members open', async ({ page }) => {
  const h = started();
  await page.setViewportSize({ width: 1280, height: 800 });
  await signUp(page, h.invite.split(',')[0], instance, 'Fia', h.control);
  await addServerVia(page, 'create');
  const start = page.getByRole('dialog', { name: copy('create.server.title'), exact: true });
  await start.getByRole('textbox', { name: copy('create.server.name'), exact: true }).fill('Vanaheim');
  await page.keyboard.press('Enter');
  await expect(start).toBeHidden({ timeout: WAIT });
  await expectComposerReady(page, 'general');
  const drawn = await drawImage(page, { width: 320, height: 240, type: 'image/png', seed: 5 });
  await attachInput(page).setInputFiles([
    { name: 'saturday-map.png', mimeType: 'image/png', buffer: drawn.bytes },
    { name: 'loot-list.txt', mimeType: 'text/plain', buffer: Buffer.from('rope\ntorches\nshields\n') },
  ]);
  await expect(trayEntries(page)).toHaveCount(2, { timeout: WAIT });
  for (let i = 0; i < 2; i++) await expect(trayEntries(page).nth(i)).toHaveAttribute('data-phase', 'ready', { timeout: WAIT });
  const text = `loot ${String(Date.now())}`;
  await sendText(page, 'general', text);
  await expect(messageRow(page, 'general', text)).toHaveAttribute('data-state', 'ok', { timeout: WAIT });

  const measure = async (tag: string): Promise<void> => {
    const row = messageRow(page, 'general', text);
    const save = row.getByRole('button', { name: copy('shell.attachment.save', { name: 'loot-list.txt' }), exact: true });
    await expect(save, `${tag} the save button is named for the file`).toBeVisible({ timeout: WAIT });
    await expect.soft(save, `${tag} its visible text is just the save word`).toHaveText(copy('media.save'));
    const clip = await save.evaluate(e => ({ sw: e.scrollWidth, cw: e.clientWidth }));
    expect.soft(clip.sw, `${tag} the save text is not clipped (scrollWidth ${String(clip.sw)} > clientWidth ${String(clip.cw)})`).toBeLessThanOrEqual(clip.cw);
    const log = (await boxes(page, '[role="log"]'))[0];
    const card = (await boxes(page, '.d-attachment-card[data-kind="file"]'))[0];
    const btn = (await boxes(page, '.d-attachment-card__file .d-attachment-card__save'))[0];
    expect(log !== undefined && card !== undefined && btn !== undefined, `${tag} the log, the file card and its save are drawn`).toBe(true);
    if (log === undefined || card === undefined || btn === undefined) return;
    expect.soft(card.r, `${tag} the card is not wider than the log`).toBeLessThanOrEqual(log.r + TOL);
    expect.soft(card.x, `${tag} the card starts inside the log`).toBeGreaterThanOrEqual(log.x - TOL);
    expect.soft(btn.r, `${tag} the save button ends inside its card`).toBeLessThanOrEqual(card.r + TOL);
  };
  await measure('1280');

  await page.setViewportSize({ width: 1024, height: 768 });
  const toggle = page.locator('.d-channel-header').getByRole('button', { name: copy('members.toggle'), exact: true });
  if (await page.locator('.d-app-shell__aside').count() === 0 && await toggle.count() > 0) await toggle.click();
  await expect(page.locator('.d-app-shell__aside')).toBeVisible({ timeout: WAIT });
  await measure('1024 with the members aside');
});

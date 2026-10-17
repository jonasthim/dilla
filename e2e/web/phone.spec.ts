// web3.7 W-Phone-4: the phone shell at 390 x 844 (flow 12), from an empty host and through the UI only: the sign-up steps
// keep the page unzoomed (field sizes of 16 px and up, a visual viewport that stays at scale 1), a server starts in the
// tab bar's servers list, a channel is a pushed view with a back, the other tabs name themselves, the link banner follows
// the network, every tap target is 44 x 44 CSS px, and focus lands where flow 12 says. Chromium and WebKit only: Firefox has
// no mobile emulation (R23).
import { expect, type BrowserContext, type Locator, type Page, type PlaywrightWorkerArgs, type PlaywrightWorkerOptions } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import {
  COPY, SIGNIN, TEST_TIMEOUT, WAIT, channelRow, completeFactorStep, composerBox, copy, expectAccessible, expectComposerReady,
  expectHeading, expectShell, nextButton, newAccount, railNav, readRecoveryKey, sendText, keyField, submitButton, test,
  messageRow, type Account,
} from './support/app';
import { PROFILE_ROOT } from './support/persistent';
import { startTestHost, type HostConfig, type StartedHost } from './support/host';
import { arr, decode } from '../../packages/client-core/src/cbor/index';

const HOST: HostConfig = { port: 8505, control: 8506, webRoot: 'packages/web/dist' };
const SERVER = 'Midgard Crew';
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } as const;

let host: StartedHost | null = null;
let instance = '';
let listPath = '';
let channelPath = '';

test.describe.configure({ mode: 'serial', timeout: TEST_TIMEOUT });
test.use({ baseURL: `http://127.0.0.1:${String(HOST.port)}`, ...PHONE });
test.skip(({ browserName }) => browserName === 'firefox', 'no mobile emulation');

test.beforeAll(async () => {
  host = await startTestHost(HOST);
  const res = await fetch(`${host.url}/v1/instance`, { headers: { accept: 'application/cbor' } });
  expect(res.status, 'GET /v1/instance').toBe(200);
  const name = arr(decode(new Uint8Array(await res.arrayBuffer())))[5];
  if (typeof name !== 'string' || name === '') throw new Error('GET /v1/instance: element 5 is not the instance name');
  instance = name;
});
test.afterAll(async () => { await host?.stop(); });

function started(): StartedHost {
  if (host === null) throw new Error('the empty test host did not start');
  return host;
}

/** A phone context of its own, with touch and mobile emulation. It is persistent (launchPersistentContext on its own profile
 *  dir), as a real phone's browser is: WebKit's ephemeral contexts behave like Safari private browsing, where the app cannot start. */
type PhoneFixtures = Pick<PlaywrightWorkerArgs, 'playwright'> & Pick<PlaywrightWorkerOptions, 'browserName' | 'launchOptions' | 'headless' | 'channel'>;
async function phoneContext(f: PhoneFixtures, dir: string): Promise<BrowserContext> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const { launchOptions, headless, channel } = f;
  return f.playwright[f.browserName].launchPersistentContext(dir, {
    ...launchOptions, headless, channel, ...PHONE, baseURL: `http://127.0.0.1:${String(HOST.port)}`,
  });
}
const phoneDir = (project: string, workerIndex: number, n: number) => `${PROFILE_ROOT}/${project}-${workerIndex}-phone${String(n)}`;

/** Every visible input, textarea and select is at least 16 px, so no browser zooms on focus. A checkbox, a radio and a button
 *  take no typing, so no browser zooms to them and their own 13.33 px default is left alone. */
async function expectFieldSizes(page: Page, state: string, expected = 1): Promise<number> {
  const { checked, small } = await page.evaluate(() => {
    const fields = [...document.querySelectorAll<HTMLElement>('input, textarea, select')]
    .filter((el) => !(el instanceof HTMLInputElement && ['checkbox', 'radio', 'button', 'submit', 'reset', 'hidden', 'file', 'range', 'color'].includes(el.type)))
    .filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden')
    .map((el) => ({ what: `${el.tagName.toLowerCase()}${el instanceof HTMLInputElement ? `[${el.type}]` : ''} ${el.id}`, px: parseFloat(getComputedStyle(el).fontSize) }));
    return { checked: fields.length, small: fields.filter((f) => f.px < 16) };
  });
  expect(small, `fields under 16px in "${state}"`).toEqual([]);
  expect(checked, `"${state}" has text fields to measure`).toBeGreaterThanOrEqual(expected);
  return checked;
}
// A smoke check: Chromium's emulation never auto-zooms, so this cannot fail there. The 16px computed sizes are the proof, and
// the real-iPhone walk covers the zoom itself.
const scale = (page: Page) => page.evaluate(() => window.visualViewport?.scale ?? 1);
async function expectUnzoomedOnFocus(page: Page, field: Locator, state: string): Promise<void> {
  await field.focus();
  await expect(field).toBeFocused();
  expect(await scale(page), `visualViewport.scale after focusing ${state}`).toBe(1);
}
const noFocusMoved = (page: Page) => page.evaluate(() => document.activeElement === document.body || document.activeElement === null);
const tabBar = (page: Page) => page.getByRole('navigation', { name: copy('nav.tabs.label'), exact: true });
const tab = (page: Page, key: string) => tabBar(page).getByRole('link', { name: copy(key), exact: true });
const back = (page: Page) => page.getByRole('button', { name: copy('nav.back'), exact: true });
const viewTitle = (page: Page) => page.locator('.d-app-shell__main .d-phone-header__title');
const listHeading = (page: Page, key: string) => page.getByRole('heading', { name: copy(key), exact: true });

/** The element ends at or above the top of the tab bar, so nothing sits under it. */
async function expectAbove(el: Locator, bar: Locator, what: string): Promise<void> {
  const a = await el.boundingBox();
  const b = await bar.boundingBox();
  expect(a, `${what} has a box`).not.toBeNull();
  expect(b, 'the tab bar has a box').not.toBeNull();
  expect(a!.y + a!.height, `${what} ends above the tab bar`).toBeLessThanOrEqual(b!.y + 1);
}

async function expectTapTargets(controls: Locator, state: string): Promise<void> {
  const count = await controls.count();
  expect(count, `${state} has controls to measure`).toBeGreaterThan(0);
  const small: string[] = [];
  for (let i = 0; i < count; i++) {
    const control = controls.nth(i);
    if (!(await control.isVisible())) continue;
    const box = await control.boundingBox();
    if (box === null) continue;
    if (box.width < 44 || box.height < 44) small.push(`${(await control.getAttribute('aria-label')) ?? (await control.innerText()).trim()} ${box.width}x${box.height}`);
  }
  expect(small, `${state}: controls under 44x44 CSS px`).toEqual([]);
}

test('the phone shell: sign-up unzoomed, the tab bar, a pushed channel, the tabs, the link, tap targets and focus', async ({ playwright, browserName, launchOptions, headless, channel, guard }, testInfo) => {
  const h = started();
  const dir = phoneDir(testInfo.project.name, testInfo.workerIndex, 1);
  const context = await phoneContext({ playwright, browserName, launchOptions, headless, channel }, dir);
  await guard.attach(context);
  const page = await context.newPage();
  const ada: Account = newAccount('Ada', h.control);
  try {
    // 1. The sign-up steps: no field under 16 px, and the focused fields leave the page at scale 1.
    await test.step('sign up with the bootstrap invite', async () => {
      await page.goto(`/welcome?invite=${encodeURIComponent(h.invite.split(',')[0])}`);
      await expectHeading(page, COPY.connectTitle, { instance });
      await expectFieldSizes(page, 'connect');
      await nextButton(page).click();
      await expectHeading(page, COPY.identityTitle);
      await expectFieldSizes(page, 'identity', 3);
      await expectUnzoomedOnFocus(page, page.getByLabel(copy(COPY.usernameLabel), { exact: true }), 'the username');
      await page.getByLabel(copy(COPY.usernameLabel), { exact: true }).fill(ada.username);
      await page.getByLabel(copy(COPY.displayLabel), { exact: true }).fill(ada.display);
      await expectUnzoomedOnFocus(page, page.getByLabel(copy(COPY.passwordLabel), { exact: true }), 'the password');
      await page.getByLabel(copy(COPY.passwordLabel), { exact: true }).fill(ada.password);
      await nextButton(page).click();
      await expectHeading(page, COPY.keysTitle);
      ada.recoveryKey = await readRecoveryKey(page);
      await expectFieldSizes(page, 'recovery key', 0);
      await page.getByRole('checkbox', { name: copy(COPY.keysAcknowledge), exact: true }).check();
      await nextButton(page).click();
      await expectHeading(page, COPY.deviceTitle);
      await expectFieldSizes(page, 'browser', 0);
      await submitButton(page).click();
      await completeFactorStep(page, ada, async (state) => { await expectFieldSizes(page, `factor ${state}`, state === 'totp' ? 1 : 0); });
      await expectHeading(page, COPY.doneTitle);
      await page.getByRole('button', { name: copy(COPY.finish), exact: true }).click();
      await expectShell(page);
    });

    // 2. A server from the servers tab; the tab bar names four places and the status bar is gone.
    await test.step('start the server', async () => {
      await railNav(page).getByRole('button', { name: copy('create.rail.newLabel'), exact: true }).click();
      const dialog = page.getByRole('dialog', { name: copy('create.server.title'), exact: true });
      await dialog.getByRole('textbox', { name: copy('create.server.name'), exact: true }).fill(SERVER);
      await dialog.getByRole('textbox', { name: copy('create.server.name'), exact: true }).press('Enter');
      await expect(dialog).toBeHidden({ timeout: WAIT });
      // A new server opens its #general as a view (the tab bar stays, and nothing focuses the composer: script focus does not
      // open a phone's keyboard); back from it is the server's list.
      await expect(page).toHaveURL(/\/c\/[0-9a-f]{32}\/[0-9a-f]{32}$/, { timeout: WAIT });
      await expect(tabBar(page)).toBeVisible();
      await expect(page.locator('.d-composer textarea')).not.toBeFocused();
      await back(page).click();
      await expect(tabBar(page)).toBeVisible({ timeout: WAIT });
      await expect(tabBar(page).getByRole('link')).toHaveCount(4);
      await expect(tab(page, 'nav.tab.servers')).toHaveAttribute('aria-current', 'page');
      await expect(page.getByRole('region', { name: copy(COPY.statusBarLabel), exact: true })).toHaveCount(0);
      await expect(channelRow(page, 'general')).toBeVisible({ timeout: WAIT });
      listPath = new URL(page.url()).pathname;
    });

    // 3. Tap #general: a pushed view, focus on the title, the tab bar under it, a composer that does not zoom and hides the bar.
    await test.step('open #general', async () => {
      await channelRow(page, 'general').tap();
      await expect(back(page)).toBeVisible({ timeout: WAIT });
      await expect(viewTitle(page)).toBeFocused();
      await expect(tabBar(page)).toBeVisible();
      channelPath = new URL(page.url()).pathname;
      await expectComposerReady(page, 'general');
      const composer = composerBox(page, 'general');
      expect(await composer.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
      await composer.tap();
      await expect(composer).toBeFocused();
      expect(await scale(page), 'visualViewport.scale after tapping into the composer').toBe(1);
      // Typing: the tab bar steps aside, and the composer ends inside the viewport with nothing between it and the keyboard.
      await expect(tabBar(page)).toBeHidden();
      await expect(page.locator('.d-app-shell')).toHaveAttribute('data-typing', 'true');
      const typing = await composer.boundingBox();
      expect(typing!.y + typing!.height, 'the composer ends inside the viewport while typing').toBeLessThanOrEqual(await page.evaluate(() => window.visualViewport?.height ?? innerHeight));
      await sendText(page, 'general', 'hej');
      await expect(messageRow(page, 'general', 'hej')).toBeVisible();
      // Tapping the message log blurs the composer: the tab bar comes back and the scale is still 1.
      await page.getByRole('log').tap();
      await expect(composer).not.toBeFocused();
      await expect(tabBar(page)).toBeVisible();
      expect(await scale(page), 'visualViewport.scale after leaving the composer').toBe(1);
      await expectAccessible(page, 'the channel view');
      await expectTapTargets(page.locator('.d-phone-header').locator('a, button'), 'the channel view header');
    });

    // 3a. web3.7.2: the shell is fixed and follows the visual viewport's offset (--d-vvtop stands in for the iOS pan, which
    // Playwright cannot produce), and a muted call bar button reads as off, not as the accent fill.
    await test.step('the shell follows --d-vvtop and a muted call bar is not accent-filled', async () => {
      const shell = page.locator('.d-app-shell');
      await expect(shell).toHaveCSS('position', 'fixed');
      await page.evaluate(() => document.documentElement.style.setProperty('--d-vvtop', '95px'));
      expect((await shell.boundingBox())!.y, 'the shell sits at the visual viewport top').toBe(95);
      const ringY = await page.evaluate(() => {
        const ring = document.createElement('div');
        ring.className = 'd-app-shell__ring';
        document.querySelector('.d-app-shell')!.append(ring);
        const y = ring.getBoundingClientRect().y;
        ring.remove();
        return y;
      });
      expect(ringY, 'the ring sits at the visual viewport top, not below it').toBe(95);
      await page.evaluate(() => document.documentElement.style.setProperty('--d-vvtop', '0px'));
      expect((await shell.boundingBox())!.y).toBe(0);
      const muted = await page.evaluate(() => {
        const host = document.querySelector('.d-app-shell')!;
        const bar = document.createElement('div');
        bar.className = 'd-call-bar';
        bar.innerHTML = '<button type="button" class="d-btn d-call-bar__mute" aria-pressed="true" data-size="md"></button><i></i>';
        host.append(bar);
        bar.querySelector('i')!.style.setProperty('background', 'var(--surface-2)');
        bar.querySelector('i')!.style.setProperty('color', 'var(--danger)');
        const button = getComputedStyle(bar.querySelector('button')!);
        const probe = getComputedStyle(bar.querySelector('i')!);
        const out = { bg: button.backgroundColor, color: button.color, edge: button.borderTopColor, surface: probe.backgroundColor, danger: probe.color };
        bar.remove();
        return out;
      });
      expect(muted, 'a muted mic: the danger glyph and edge on surface-2').toEqual({ bg: muted.surface, color: muted.danger, edge: muted.danger, surface: muted.surface, danger: muted.danger });
    });

    // 3b. A thread is a sheet: opened from the toolbar, closed by the system back, then reopened by a real click on the chip.
    await test.step('a thread sheet opens from the chip on a real click', async () => {
      const row = messageRow(page, 'general', 'hej');
      await row.focus();
      await row.getByRole('button', { name: copy('thread.open'), exact: true }).click();
      const reply = page.getByRole('textbox', { name: copy('thread.composer'), exact: true });
      await expect(reply).toBeVisible({ timeout: WAIT });
      await reply.fill('svar');
      await reply.press('Enter');
      await expect(page.getByRole('complementary', { name: copy('thread.title') }).getByText('svar')).toBeVisible({ timeout: WAIT });
      const box = await reply.boundingBox();
      expect(box!.y + box!.height, 'the thread composer sits at the bottom of the sheet').toBeGreaterThan(844 - 120);
      await page.goBack();
      await expect(page.getByRole('complementary', { name: copy('thread.title') })).toBeHidden({ timeout: WAIT });
      await row.getByRole('button', { name: copy('thread.summary.one'), exact: true }).click();
      await expect(page.getByRole('complementary', { name: copy('thread.title') })).toBeVisible({ timeout: WAIT });
      await page.goBack();
      await expect(page.getByRole('complementary', { name: copy('thread.title') })).toBeHidden({ timeout: WAIT });
    });

    // The tab bar is the way out of a view: the current tab goes to its list, and the tabs keep their memory.
    await test.step('tapping the current tab in a channel view shows the channel list', async () => {
      await tab(page, 'nav.tab.servers').tap();
      await expect(channelRow(page, 'general')).toBeVisible({ timeout: WAIT });
      await expect(page).toHaveURL(new RegExp(`${listPath}$`));
      await tab(page, 'nav.tab.dms').tap();
      await expect(tab(page, 'nav.tab.dms')).toHaveAttribute('aria-current', 'page');
      await tab(page, 'nav.tab.servers').tap();
      await expect(channelRow(page, 'general')).toBeVisible({ timeout: WAIT });
      await channelRow(page, 'general').tap();
      await expect(back(page)).toBeVisible({ timeout: WAIT });
    });

    // 4. Back: the list, with #general's row focused.
    await test.step('back to the list', async () => {
      await back(page).click();
      await expect(tabBar(page)).toBeVisible({ timeout: WAIT });
      await expect(channelRow(page, 'general')).toBeFocused();
      await expect(tab(page, 'nav.tab.servers')).toHaveAttribute('aria-current', 'page');
    });

    await test.step('the list is accessible and its tap targets are 44 px', async () => {
      await expectAccessible(page, 'the servers list');
      await expectTapTargets(tabBar(page).getByRole('link'), 'the tab bar');
      const menu = page.getByRole('button', { name: copy('nav.server.menu'), exact: true });
      await expectTapTargets(menu, 'the server menu trigger');
      // The owner's menu: new channel, invite, server settings (and "leave" only for a member).
      await menu.click();
      await expect(page.getByRole('menuitem')).toHaveText([copy('search.open'), copy('create.channel.open'), copy('invite.open'), copy('admin.open')]);
      await expectTapTargets(page.getByRole('menuitem'), 'the server menu items');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menuitem')).toHaveCount(0);
      await expect(menu).toBeFocused();
    });

    // Walk 1: a phone has no Control+K, so search opens from the servers list menu, full screen; a hit opens its channel.
    await test.step('search from the servers list menu opens full screen and a hit opens its message', async () => {
      await page.getByRole('button', { name: copy('nav.server.menu'), exact: true }).click();
      await page.getByRole('menuitem', { name: copy('search.open'), exact: true }).tap();
      const palette = page.getByRole('dialog', { name: copy('search.placeholder'), exact: true });
      await expect(palette).toBeVisible({ timeout: WAIT });
      const box = await palette.boundingBox();
      expect(box!.width, 'the palette covers the phone').toBeGreaterThanOrEqual(389);
      expect(box!.height, 'the palette covers the phone').toBeGreaterThanOrEqual(843);
      const input = page.getByRole('combobox', { name: copy('search.placeholder'), exact: true });
      await expect(input).toBeFocused();
      await input.fill('hej');
      const hit = palette.getByRole('option').filter({ hasText: 'hej' }).first();
      await expect(hit).toBeVisible({ timeout: WAIT });
      await hit.tap();
      await expect(palette).toBeHidden({ timeout: WAIT });
      await expect(back(page)).toBeVisible({ timeout: WAIT });
      await expectComposerReady(page, 'general');
      await back(page).click();
      await expect(tabBar(page)).toBeVisible({ timeout: WAIT });
    });

    // The channel menu's sheet: closed by the system back and by its own back, focus returns to the menu trigger.
    await test.step('the members sheet returns focus to the channel menu', async () => {
      await channelRow(page, 'general').tap();
      await expect(back(page)).toBeVisible({ timeout: WAIT });
      const menu = page.getByRole('button', { name: copy('nav.channel.menu'), exact: true });
      await menu.click();
      await page.getByRole('menuitem', { name: copy('members.toggle'), exact: true }).click();
      const close = page.getByRole('button', { name: copy('members.close'), exact: true });
      await expect(close).toBeVisible({ timeout: WAIT });
      await expectAbove(page.getByRole('complementary', { name: /members/ }), tabBar(page), 'the members sheet');
      await page.goBack();
      await expect(close).toBeHidden({ timeout: WAIT });
      await expect(menu).toBeFocused();
      await menu.click();
      await page.getByRole('menuitem', { name: copy('members.toggle'), exact: true }).click();
      await expect(close).toBeVisible({ timeout: WAIT });
      await close.click();
      await expect(close).toBeHidden({ timeout: WAIT });
      await expect(menu).toBeFocused();
      await back(page).click();
      await expect(tabBar(page)).toBeVisible({ timeout: WAIT });
    });

    // 5. The other tabs name themselves, and a tap on a tab puts focus on its heading.
    await test.step('the DMs, Activity and You tabs', async () => {
      await tab(page, 'nav.tab.dms').tap();
      await expect(tab(page, 'nav.tab.dms')).toHaveAttribute('aria-current', 'page');
      await expect(listHeading(page, 'shell.dms.label')).toBeFocused();

      await tab(page, 'nav.tab.activity').tap();
      await expect(tab(page, 'nav.tab.activity')).toHaveAttribute('aria-current', 'page');
      await expect(listHeading(page, 'activity.title')).toBeFocused();
      await expect(page.getByText(copy('activity.empty'), { exact: true }).or(page.getByText(copy('activity.since'), { exact: true }))).toBeVisible();
      await expectAccessible(page, 'Activity');

      await tab(page, 'nav.tab.you').tap();
      await expect(tab(page, 'nav.tab.you')).toHaveAttribute('aria-current', 'page');
      await expect(page.getByRole('heading', { level: 1, name: copy('you.title'), exact: true })).toBeFocused();
      await expect(page.getByRole('heading', { name: copy('you.status'), exact: true })).toBeVisible();
      for (const fact of ['shell.status.node', 'shell.status.link', 'shell.status.gen', 'shell.status.devices']) {
        await expect(page.locator('.dw-you__facts dt').filter({ hasText: copy(fact) })).toBeVisible();
      }
      await expect(page.getByRole('button', { name: copy('devices.signOut'), exact: true })).toBeVisible();
      await expectAccessible(page, 'You');
    });

    // Settings from You, and back to the section's row.
    await test.step('back from Settings lands on the section row', async () => {
      const row = page.locator('[data-settings-section="privacy"]');
      await row.tap();
      await expect(page).toHaveURL(/\/settings\/privacy$/, { timeout: WAIT });
      await expect(back(page)).toBeVisible();
      await expect(tabBar(page)).toBeVisible();
      await expectAbove(page.getByRole('dialog', { name: copy('settings.title'), exact: true }), tabBar(page), 'Settings');
      await back(page).click();
      await expect(tabBar(page)).toBeVisible({ timeout: WAIT });
      await expect(row).toBeFocused();
    });

    // Server settings is a page under the tabs too, and Escape closes it.
    await test.step('server settings keeps the tab bar and closes on Escape', async () => {
      await tab(page, 'nav.tab.servers').tap();
      await page.getByRole('button', { name: copy('nav.server.menu'), exact: true }).click();
      await page.getByRole('menuitem', { name: copy('admin.open'), exact: true }).click();
      const dialog = page.getByRole('dialog', { name: copy('admin.title'), exact: true });
      await expect(dialog).toBeVisible({ timeout: WAIT });
      await expect(tabBar(page)).toBeVisible();
      await expectAbove(dialog, tabBar(page), 'server settings');
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden({ timeout: WAIT });
      await expect(tabBar(page)).toBeVisible();
    });

    // 6. The link banner follows the network.
    await test.step('offline shows the link banner, online removes it', async () => {
      await tab(page, 'nav.tab.servers').tap();
      const logged = guard.consoleErrors.length;
      await context.setOffline(true);
      await expect(page.getByText(copy('nav.link.offline'), { exact: true })).toBeVisible({ timeout: WAIT });
      await context.setOffline(false);
      await expect(page.getByText(copy('nav.link.offline'), { exact: true })).toBeHidden({ timeout: WAIT });
      // The browser logs the requests it refused while the network was off; that is this step's doing, not a fault. Only the
      // entries this step added are cleared, and only those lines: Chromium's ERR_INTERNET_DISCONNECTED, and WebKit's
      // wording for the same refusal (CI webkit-web, 2026-10-16).
      const offlineLine = (text: string): boolean =>
        text.includes('ERR_INTERNET_DISCONNECTED') || text === 'Failed to load resource: WebKit encountered an internal error';
      for (let i = guard.consoleErrors.length - 1; i >= logged; i--) if (offlineLine(guard.consoleErrors[i])) guard.consoleErrors.splice(i, 1);
    });

    // A deep link or a first load moves no focus.
    await test.step('a reload on a channel moves no focus', async () => {
      await channelRow(page, 'general').tap();
      await expect(back(page)).toBeVisible({ timeout: WAIT });
      await page.reload();
      await expect(back(page)).toBeVisible({ timeout: WAIT });
      await expectComposerReady(page, 'general');
      expect(await noFocusMoved(page), 'nothing focused after a reload').toBe(true);
    });

    // A cold deep link to a channel (a fresh page, no in-app history): back is the server's list, never off site, with that
    // channel's row focused.
    await test.step('a cold deep link, then back, lands on the list with the channel row focused', async () => {
      expect(channelPath).toMatch(/^\/c\/[0-9a-f]{32}\/[0-9a-f]{32}$/);
      // Not a second tab (the app lives in one tab per profile): a fresh load of the same page, behind its earlier history.
      await page.goto(channelPath);
      await expect(back(page)).toBeVisible({ timeout: WAIT });
      await expectComposerReady(page, 'general');
      await back(page).click();
      await expect(page).toHaveURL(new RegExp(`${listPath}$`), { timeout: WAIT });
      expect(page.url().startsWith(`http://127.0.0.1:${String(HOST.port)}/`)).toBe(true);
      await expect(tabBar(page)).toBeVisible({ timeout: WAIT });
      await expect(channelRow(page, 'general')).toBeFocused();
    });
  } finally {
    await guard.collectWorkers();
    await context.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the sign-in fields stay at 16 px and unzoomed on a phone', async ({ playwright, browserName, launchOptions, headless, channel, guard }, testInfo) => {
  started();
  const dir = phoneDir(testInfo.project.name, testInfo.workerIndex, 2);
  const context = await phoneContext({ playwright, browserName, launchOptions, headless, channel }, dir);
  await guard.attach(context);
  const page = await context.newPage();
  const key = Array.from({ length: 13 }, () => 'ABCD').join(' ');
  try {
    await page.goto('/welcome');
    await expectHeading(page, COPY.connectTitle, { instance });
    await page.getByRole('button', { name: copy(SIGNIN.entry), exact: true }).click();
    await expectHeading(page, SIGNIN.keyTitle);
    await expectFieldSizes(page, 'sign-in key');
    await expectUnzoomedOnFocus(page, keyField(page), 'the recovery key');
    await keyField(page).fill(key);
    await page.getByRole('button', { name: copy(SIGNIN.loginSubmit), exact: true }).click();
    await expectHeading(page, SIGNIN.loginTitle, { instance });
    await expectFieldSizes(page, 'sign-in login');
    await expectUnzoomedOnFocus(page, page.getByLabel(copy(SIGNIN.username), { exact: true }), 'the username');
    await expectUnzoomedOnFocus(page, page.getByLabel(copy(SIGNIN.password), { exact: true }), 'the password');
    // web3.7.2: no shell here, so the page lock is off and a short window (the keyboard up) still scrolls the form.
    await page.setViewportSize({ width: 390, height: 300 });
    const scrolled = await page.evaluate(() => {
      const el = document.scrollingElement!;
      el.scrollTo(0, 40);
      return { tall: el.scrollHeight > el.clientHeight, y: el.scrollTop };
    });
    expect(scrolled, 'the sign-in page scrolls with a short window').toEqual({ tall: true, y: expect.any(Number) });
    expect(scrolled.y).toBeGreaterThan(0);
  } finally {
    await guard.collectWorkers();
    await context.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

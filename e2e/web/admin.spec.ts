// v0.1.0-web3.4, server admin from an empty instance. Like create.spec.ts this suite starts a test host of its own with no
// account, no server and no channel, and runs a server through the shipping clients only: two browsers, one owner and one
// member. Nothing here seeds state or calls the instance's API on anyone's behalf (GET /v1/instance for the name the
// onboarding shows is the one request the spec makes itself). Controls are found by role and accessible name, with the
// copy keys of flow 08 (strings/{admin,members,moderation}.ts) through copy().
import { expect, type Locator, type Page } from '@playwright/test';
import { addServerVia,
  TEST_TIMEOUT, WAIT, makeInviteLink, completeSignUp, copy, escapeRegExp, expectAccessible, newAccount, openChannel, railItem, railNav,
  signUp, test, channelRow, expectComposerReady,
} from './support/app';
import { startTestHost, type HostConfig, type StartedHost } from './support/host';
import { launchSecond, secondProfileDir } from './support/second-harness';
import { arr, decode } from '../../packages/client-core/src/cbor/index';
import { rmSync } from 'node:fs';

/** Its own ports (E1 reservation). */
const EMPTY: HostConfig = { port: 8487, control: 8488, webRoot: 'packages/web/dist' };
const SERVER = 'Midgard Crew';
const RENAMED = 'Asgard Crew';
const OWNER = 'Ada';
const FRIEND = 'Björn';

let host: StartedHost | null = null;
let instance = '';

test.describe.configure({ mode: 'serial', timeout: TEST_TIMEOUT });
test.use({ baseURL: `http://127.0.0.1:${String(EMPTY.port)}` });

test.beforeAll(async () => {
  host = await startTestHost(EMPTY);
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
const button = (scope: Page | Locator, key: string, vars?: Record<string, string>) =>
  scope.getByRole('button', { name: copy(key, vars), exact: true });
const dialogOf = (page: Page, key: string, vars?: Record<string, string>) =>
  page.getByRole('dialog', { name: copy(key, vars), exact: true });
// The member list is the shell's aside, named "members of {server}" (the list inside takes no second name: final fix M5).
const membersRegion = (page: Page, server: string) => page.getByRole('complementary', { name: copy('members.region', { server }), exact: true });
const memberRow = (page: Page, server: string, name: string) =>
  membersRegion(page, server).getByRole('listitem').filter({ hasText: name });
/** The text of a copy key with one variable left open: a regexp that matches any value for it. */
function anyOf(key: string, vars: Record<string, string>, open: string): RegExp {
  const [pre, post] = copy(key, { ...vars, [open]: '\u0001' }).split('\u0001');
  return new RegExp(`${escapeRegExp(pre ?? '')}.+${escapeRegExp(post ?? '')}`);
}

/** Opens "server settings" in the sidebar and returns the dialog. */
async function openSettings(page: Page): Promise<Locator> {
  await button(page, 'admin.open').click();
  const dialog = dialogOf(page, 'admin.title');
  await expect(dialog).toBeVisible({ timeout: WAIT });
  // Until the permissions are read the dialog shows no tab; the nav fills in when they arrive.
  await expect(dialog.getByRole('navigation', { name: copy('admin.nav'), exact: true })).toBeVisible({ timeout: WAIT });
  return dialog;
}
const navItem = (dialog: Locator, key: string) =>
  dialog.getByRole('navigation', { name: copy('admin.nav'), exact: true }).getByRole('button', { name: copy(key), exact: true });
/** Escape closes the dialog and focus goes back to "server settings" (final fix I1), never to the page. */
async function closeSettings(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(dialogOf(page, 'admin.title')).toBeHidden();
  await expect(button(page, 'admin.open')).toBeFocused();
}
/** Opens the member's action menu from its row and picks `item`. */
async function memberAction(page: Page, server: string, name: string, item: string): Promise<void> {
  await memberRow(page, server, name).getByRole('button', { name: copy('members.actions', { name }), exact: true }).click();
  await page.getByRole('menuitem', { name: copy(item), exact: true }).click();
}
/** Joins `server` with the invite link from the rail's "join" button. */
async function joinWith(page: Page, link: string): Promise<Locator> {
  await addServerVia(page, 'join');
  const dialog = dialogOf(page, 'join.title');
  await dialog.getByLabel(copy('join.invite'), { exact: true }).fill(link);
  await button(dialog, 'join.submit').click();
  return dialog;
}
const noticeOf = (page: Page, server: string) => page.getByText(copy('removed.notice', { server }), { exact: true }).first();

test('a server run from an empty instance: members, rename, channel edit, kick, ban, unban, leave, hand over and delete', async ({
  page, guard, playwright, browserName, launchOptions, headless, channel, viewport,
}, testInfo) => {
  const h = started();

  // 1. Ada signs up with the bootstrap invite and starts "Midgard Crew".
  await signUp(page, h.invite.split(',')[0], instance, OWNER, h.control);
  await addServerVia(page, 'create');
  const start = dialogOf(page, 'create.server.title');
  await start.getByRole('textbox', { name: copy('create.server.name'), exact: true }).fill(SERVER);
  await page.keyboard.press('Enter');
  await expect(start).toBeHidden({ timeout: WAIT });
  await expect(page).toHaveURL(/\/c\/[0-9a-f]{32}\/[0-9a-f]{32}$/, { timeout: WAIT });
  const serverUrl = new URL(page.url()).pathname;
  const communityId = /\/c\/([0-9a-f]{32})\//.exec(serverUrl)?.[1] ?? '';
  expect(communityId).not.toBe('');
  await expectComposerReady(page, 'general');

  // 2. Ada makes an invite; Björn signs up through it in a browser of his own.
  // web3.8 (item 11): the link is made under server settings → Invites.
  const link = await makeInviteLink(page, SERVER);

  const secondDir = secondProfileDir(testInfo.project.name, testInfo.workerIndex);
  const second = await launchSecond(playwright, browserName, { launchOptions, headless, channel, viewport, baseURL: h.url }, secondDir);
  try {
    const page2 = second.pages()[0] ?? (await second.newPage());
    await page2.goto(new URL(link).pathname);
    const openLink = page2.getByRole('link', { name: 'Open dilla in this browser', exact: true });
    await expect(openLink).toHaveAttribute('href', /^\/welcome\?invite=[^&\s]+$/);
    await guard.attach(second);
    await openLink.click();
    await completeSignUp(page2, newAccount(FRIEND, h.control), instance);
    await expect(railItem(page2, SERVER)).toBeVisible({ timeout: WAIT });
    await openChannel(page2, SERVER, 'general');

    // 3. Ada's member list shows Björn.
    await expect(membersRegion(page, SERVER)).toBeVisible({ timeout: WAIT });
    await expect(memberRow(page, SERVER, FRIEND)).toBeVisible({ timeout: WAIT });
    await expect(memberRow(page, SERVER, OWNER)).toBeVisible();
    await expectAccessible(page, 'the members pane');

    // 3b. Audit S3: the members aside draws its own 48px bar, its hairline on the channel header's line, as a column at 1440 and as
    // the overlay at 1024 (where the close control sits in that bar, at its right).
    const original = page.viewportSize();
    for (const [width, height] of [[1440, 900], [1024, 768]] as const) {
      await page.setViewportSize({ width, height });
      const region = membersRegion(page, SERVER);
      await expect(region).toBeVisible({ timeout: WAIT });
      const bar = region.getByRole('heading', { level: 2, name: copy('members.toggle'), exact: true });
      await expect(bar).toBeVisible();
      const barBox = await bar.boundingBox();
      const headerBox = await page.locator('.d-channel-header').boundingBox();
      if (barBox === null || headerBox === null) throw new Error(`no members bar or channel header at ${String(width)}`);
      expect(barBox.height, `members bar height at ${String(width)}`).toBeCloseTo(48, 0);
      expect(barBox.y + barBox.height, `members bar bottom at ${String(width)}`).toBeCloseTo(headerBox.y + headerBox.height, 0);
      const close = page.getByRole('button', { name: copy('members.close'), exact: true });
      if (await close.count() > 0) {
        const closeBox = await close.boundingBox();
        if (closeBox === null) throw new Error('no members close box');
        expect(closeBox.y, 'the close control sits inside the bar').toBeGreaterThanOrEqual(barBox.y - 1);
        expect(closeBox.y + closeBox.height, 'the close control sits inside the bar').toBeLessThanOrEqual(barBox.y + barBox.height + 1);
      }
    }
    if (original !== null) await page.setViewportSize(original);

    // 4. Ada renames the server; Björn's rail shows the new name without a reload.
    let settings = await openSettings(page);
    await expectAccessible(page, 'the server settings dialog');
    await navItem(settings, 'admin.nav.overview').click();
    const nameField = settings.getByRole('textbox', { name: copy('admin.overview.name'), exact: true });
    await nameField.fill(RENAMED);
    await button(settings, 'admin.overview.save').click();
    await expect(settings.getByText(copy('admin.overview.saved'), { exact: true })).toBeVisible({ timeout: WAIT });
    await expect(railItem(page2, RENAMED)).toBeVisible({ timeout: 5_000 });
    await expect(railItem(page, RENAMED)).toBeVisible();

    // 5. Ada edits #general to the name "lobby" and the topic "welcome"; Björn sees both.
    await navItem(settings, 'admin.nav.channels').click();
    await settings.getByRole('listitem').filter({ hasText: '#general' })
      .getByRole('button', { name: copy('admin.channels.editLabel', { name: 'general' }), exact: true }).click();
    const edit = dialogOf(page, 'admin.channel.titleText', { name: 'general' });
    await edit.getByRole('textbox', { name: copy('admin.channel.name'), exact: true }).fill('lobby');
    await edit.getByRole('textbox', { name: copy('admin.channel.topic'), exact: true }).fill('welcome');
    await button(edit, 'admin.channel.save').click();
    await expect(edit).toBeHidden({ timeout: WAIT });
    await closeSettings(page);
    await expect(channelRow(page2, 'lobby')).toBeVisible({ timeout: 5_000 });
    await channelRow(page2, 'lobby').click();
    await expect(page2.getByText('welcome', { exact: true })).toBeVisible({ timeout: WAIT });
    await expect(channelRow(page, 'lobby')).toBeVisible();
    await expect(page.getByText('welcome', { exact: true })).toBeVisible();

    // 6. Ada kicks Björn: his rail loses the server, he sees the notice, his URL leaves the server.
    await memberAction(page, RENAMED, FRIEND, 'members.menu.kick');
    const kick = dialogOf(page, 'mod.kick.title', { name: FRIEND, server: RENAMED });
    await expectAccessible(page, 'the kick confirm');
    await button(kick, 'mod.kick.confirm').click();
    await expect(kick).toBeHidden({ timeout: WAIT });
    await expect(railItem(page2, RENAMED)).toHaveCount(0, { timeout: WAIT });
    await expect(noticeOf(page2, RENAMED)).toBeVisible({ timeout: WAIT });
    await expect(page2).not.toHaveURL(new RegExp(communityId));
    await expect(memberRow(page, RENAMED, FRIEND)).toHaveCount(0, { timeout: WAIT });

    // 7. Björn rejoins with the same link and succeeds.
    const join = await joinWith(page2, link);
    await expect(join).toBeHidden({ timeout: WAIT });
    await expect(railItem(page2, RENAMED)).toBeVisible({ timeout: WAIT });
    await expect(memberRow(page, RENAMED, FRIEND)).toBeVisible({ timeout: WAIT });
    await openChannel(page2, RENAMED, 'lobby');

    // 8. Ada bans Björn with the reason "spam" for 1 day; he sees the notice again.
    await memberAction(page, RENAMED, FRIEND, 'members.menu.ban');
    const ban = dialogOf(page, 'mod.ban.title', { name: FRIEND, server: RENAMED });
    await ban.getByRole('textbox', { name: copy('mod.ban.reason'), exact: true }).fill('spam');
    await ban.getByRole('combobox', { name: copy('mod.ban.duration'), exact: true }).selectOption({ label: copy('mod.ban.duration.day') });
    await expectAccessible(page, 'the ban confirm');
    await button(ban, 'mod.ban.confirm').click();
    await expect(ban).toBeHidden({ timeout: WAIT });
    await expect(railItem(page2, RENAMED)).toHaveCount(0, { timeout: WAIT });
    await expect(noticeOf(page2, RENAMED)).toBeVisible({ timeout: WAIT });

    // 9. Björn's join with the link is refused: join.error.forbidden.
    const refused = await joinWith(page2, link);
    await expect(refused.getByText(copy('join.error.forbidden'), { exact: true })).toBeVisible({ timeout: WAIT });
    await page2.keyboard.press('Escape');
    await expect(refused).toBeHidden();

    // 10. Ada's bans tab lists Björn with "spam" and "banned by Ada"; unban empties it.
    settings = await openSettings(page);
    await navItem(settings, 'admin.nav.bans').click();
    const row = settings.getByRole('listitem').filter({ hasText: FRIEND });
    await expect(row).toBeVisible({ timeout: WAIT });
    await expect(row).toContainText('spam');
    await expect(row).toContainText(anyOf('admin.bans.by', { name: OWNER }, 'date'));
    await row.getByRole('button', { name: copy('admin.bans.unbanLabel', { name: FRIEND }), exact: true }).click();
    const unban = dialogOf(page, 'admin.bans.unbanTitle', { name: FRIEND });
    await button(unban, 'admin.bans.unbanConfirm').click();
    await expect(unban).toBeHidden({ timeout: WAIT });
    await expect(settings.getByText(copy('admin.bans.empty', { server: RENAMED }), { exact: true })).toBeVisible({ timeout: WAIT });
    await closeSettings(page);

    // 11. Björn rejoins.
    const again = await joinWith(page2, link);
    await expect(again).toBeHidden({ timeout: WAIT });
    await expect(railItem(page2, RENAMED)).toBeVisible({ timeout: WAIT });
    await openChannel(page2, RENAMED, 'lobby');
    await expect(memberRow(page, RENAMED, FRIEND)).toBeVisible({ timeout: WAIT });

    // 12. Björn's menu for Ada lists only message and compare; his settings show only invites and the leave tab.
    await expect(membersRegion(page2, RENAMED)).toBeVisible({ timeout: WAIT });
    await memberRow(page2, RENAMED, OWNER).getByRole('button', { name: copy('members.actions', { name: OWNER }), exact: true }).click();
    const items = page2.getByRole('menu').getByRole('menuitem');
    await expect(items).toHaveText([copy('members.menu.message'), copy('members.menu.compare')]);
    await page2.keyboard.press('Escape');
    const mine = await openSettings(page2);
    const nav = mine.getByRole('navigation', { name: copy('admin.nav'), exact: true }).getByRole('button');
    await expect(nav).toHaveText([copy('admin.nav.invites'), copy('admin.nav.leave')]);
    // WS8: the sidebar has no leave button; leave is a section of server settings.
    await expect(page2.locator('.d-channel-list').getByRole('button', { name: copy('admin.leave.open'), exact: true })).toHaveCount(0);
    await navItem(mine, 'admin.nav.leave').click();
    await expect(button(mine.locator('.dw-settings-section'), 'admin.leave.open')).toBeVisible();

    // 13. Björn leaves; Ada's list drops him.
    await button(mine.locator('.dw-settings-section'), 'admin.leave.open').click();
    const leave = dialogOf(page2, 'admin.leave.title', { server: RENAMED });
    await button(leave, 'admin.leave.confirm').click();
    await expect(railItem(page2, RENAMED)).toHaveCount(0, { timeout: WAIT });
    await expect(dialogOf(page2, 'admin.title')).toBeHidden({ timeout: WAIT });
    await expect(memberRow(page, RENAMED, FRIEND)).toHaveCount(0, { timeout: WAIT });

    // 14. Björn rejoins. Ada hands the server to him; her danger tab now offers leave.
    const third = await joinWith(page2, link);
    await expect(third).toBeHidden({ timeout: WAIT });
    await expect(railItem(page2, RENAMED)).toBeVisible({ timeout: WAIT });
    await openChannel(page2, RENAMED, 'lobby');
    await expect(memberRow(page, RENAMED, FRIEND)).toBeVisible({ timeout: WAIT });
    settings = await openSettings(page);
    await navItem(settings, 'admin.nav.delete').click();
    await button(settings.locator('.dw-settings-section'), 'admin.nav.transfer').click();
    const transfer = dialogOf(page, 'admin.transfer.title', { server: RENAMED });
    await transfer.getByRole('combobox', { name: copy('admin.transfer.member'), exact: true }).selectOption({ label: FRIEND });
    await transfer.getByRole('textbox', { name: copy('admin.transfer.confirmName'), exact: true }).fill(RENAMED);
    await button(transfer, 'admin.transfer.confirm').click();
    await expect(transfer).toBeHidden({ timeout: WAIT });
    await expect(navItem(settings, 'admin.nav.leave')).toBeVisible({ timeout: WAIT });
    await expect(navItem(settings, 'admin.nav.delete')).toHaveCount(0);
    await closeSettings(page);

    // 15. Björn deletes the server with its typed name. Both rails are empty and Ada is told.
    const owned = await openSettings(page2);
    await navItem(owned, 'admin.nav.delete').click();
    await button(owned.locator('.dw-settings-section'), 'admin.nav.delete').click();
    const del = dialogOf(page2, 'admin.delete.title', { server: RENAMED });
    await del.getByRole('textbox', { name: copy('admin.delete.confirmName'), exact: true }).fill(RENAMED.normalize('NFD'));
    await button(del, 'admin.delete.confirm').click();
    await expect(railItem(page2, RENAMED)).toHaveCount(0, { timeout: WAIT });
    await expect(railItem(page, RENAMED)).toHaveCount(0, { timeout: WAIT });
    await expect(noticeOf(page, RENAMED)).toBeVisible({ timeout: WAIT });
    await guard.collectWorkers();
  } finally {
    await second.close();
    rmSync(secondDir, { recursive: true, force: true });
  }
});

// v0.1.0-web3.5, roles from an empty instance. Like admin.spec.ts this suite starts a test host of its own with no account,
// no server and no channel, and runs a server through the shipping clients only: two browsers, one owner (Ada) and one
// member (Björn). Nothing here seeds state or calls the instance's API on anyone's behalf (GET /v1/instance for the name
// the onboarding shows is the one request the spec makes itself). Controls are found by role and accessible name, with the
// copy keys of flow 09 (strings/{roles,perm}.ts, the shell's pins and mention keys) through copy().
// Every dialog's focus return is asserted with toBeFocused(), which jsdom cannot prove through portals and the inert drawer.
import { expect, type Locator, type Page } from '@playwright/test';
import {
  CLASS, TEST_TIMEOUT, WAIT, makeInviteLink, newChannelButton, completeSignUp, copy, expectAccessible, expectComposerReady, newAccount, openChannel, railItem, railNav,
  channelRow, composerBox, messageRow, pinsDialog, rowAction, rowToolbar, sendText, signUp, tag, test, mentionList, logRegion,
} from './support/app';
import { startTestHost, type HostConfig, type StartedHost } from './support/host';
import { launchSecond, secondProfileDir } from './support/second-harness';
import { arr, decode } from '../../packages/client-core/src/cbor/index';
import { rmSync } from 'node:fs';

/** Its own ports (E1 reservation). */
const EMPTY: HostConfig = { port: 8491, control: 8492, webRoot: 'packages/web/dist' };
const SERVER = 'Midgard Crew';
const OWNER = 'Ada';
const FRIEND = 'Björn';
const ROLE = 'Crew';

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
const membersRegion = (page: Page) => page.getByRole('complementary', { name: copy('members.region', { server: SERVER }), exact: true });
const memberRow = (page: Page, name: string) => membersRegion(page).getByRole('listitem').filter({ hasText: name });
const memberTrigger = (page: Page, name: string) =>
  memberRow(page, name).getByRole('button', { name: copy('members.actions', { name }), exact: true });
const groupHeading = (page: Page, count: number) =>
  membersRegion(page).getByRole('heading', { name: copy('members.group', { name: ROLE, count }), exact: true });
/** The shell's polite live region: it holds the latest announcement until the next one replaces it. */
const announcer = (page: Page) => page.getByTestId('shell-announcer');
const switchOf = (scope: Locator, key: string) => scope.getByRole('switch', { name: copy(key), exact: true });

/** Opens "server settings" in the sidebar and returns the dialog, with the permissions read. */
async function openSettings(page: Page): Promise<Locator> {
  await button(page, 'admin.open').click();
  const dialog = dialogOf(page, 'admin.title');
  await expect(dialog).toBeVisible({ timeout: WAIT });
  await expect(dialog.getByRole('navigation', { name: copy('admin.nav'), exact: true })).toBeVisible({ timeout: WAIT });
  return dialog;
}
const navItem = (dialog: Locator, key: string) =>
  dialog.getByRole('navigation', { name: copy('admin.nav'), exact: true }).getByRole('button', { name: copy(key), exact: true });
/** Escape closes the settings dialog and focus goes back to "server settings", never to the page. */
async function closeSettings(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(dialogOf(page, 'admin.title')).toBeHidden();
  await expect(button(page, 'admin.open')).toBeFocused();
}
/** Opens the member's action menu from its row and picks `item`. */
async function memberAction(page: Page, name: string, item: string): Promise<void> {
  await memberTrigger(page, name).click();
  await page.getByRole('menuitem', { name: copy(item), exact: true }).click();
}
/** The roles list row of a role: a listitem named by the role's name. */
const roleRow = (settings: Locator, name: string) => settings.getByRole('list', { name: copy('roles.title'), exact: true }).getByRole('listitem').filter({ hasText: name });
/** Opens the editor of the existing role `name` from the roles tab. */
async function editRole(page: Page, settings: Locator, name: string): Promise<Locator> {
  await roleRow(settings, name).getByRole('button', { name: copy('roles.editLabel', { name }), exact: true }).click();
  const editor = dialogOf(page, 'roles.editor.titleEdit', { name });
  await expect(editor).toBeVisible({ timeout: WAIT });
  return editor;
}
async function setSwitch(toggle: Locator, on: boolean): Promise<void> {
  if ((await toggle.getAttribute('aria-checked')) !== String(on)) await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', String(on));
}

test('roles run from an empty instance: make, assign, pin by right, mention, demote and delete', async ({
  page, guard, playwright, browserName, launchOptions, headless, channel, viewport,
}, testInfo) => {
  const h = started();

  // 1. Ada signs up with the bootstrap invite and starts "Midgard Crew"; Björn joins through Ada's invite.
  await signUp(page, h.invite.split(',')[0], instance, OWNER, h.control);
  await railNav(page).getByRole('button', { name: copy('create.rail.newLabel'), exact: true }).click();
  const start = dialogOf(page, 'create.server.title');
  await start.getByRole('textbox', { name: copy('create.server.name'), exact: true }).fill(SERVER);
  await page.keyboard.press('Enter');
  await expect(start).toBeHidden({ timeout: WAIT });
  await expect(page).toHaveURL(/\/c\/[0-9a-f]{32}\/[0-9a-f]{32}$/, { timeout: WAIT });
  await expectComposerReady(page, 'general');

  // A second text channel, so that Björn can stand outside #general while Ada writes there (its row then badges).
  await newChannelButton(page).click();
  const made = dialogOf(page, 'create.channel.title', { server: SERVER });
  await made.getByRole('textbox', { name: copy('create.channel.name'), exact: true }).fill('side');
  await page.keyboard.press('Enter');
  await expect(made).toBeHidden({ timeout: WAIT });
  await expect(channelRow(page, 'side')).toBeVisible({ timeout: WAIT });
  await openChannel(page, SERVER, 'general');

  // web3.8 (item 11): the link is made under server settings → Invites.
  const link = await makeInviteLink(page, SERVER);
  await expect(button(page, 'admin.open')).toBeFocused();

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
    await expect(memberRow(page, FRIEND)).toBeVisible({ timeout: WAIT });
    await expect(memberRow(page2, OWNER)).toBeVisible({ timeout: WAIT });

    // 2. Björn holds no right yet: Ada's message offers him no "pin", and "@ev" in his composer offers no @everyone.
    const hello = `hello ${tag()}`;
    await sendText(page, 'general', hello);
    const theirs = messageRow(page2, 'general', hello);
    await expect(theirs).toBeVisible({ timeout: WAIT });
    await theirs.focus();
    await expect(rowToolbar(theirs)).toBeVisible();
    await expect(rowToolbar(theirs).getByRole('button', { name: copy('shell.message.react'), exact: true })).toBeVisible();
    await expect(rowToolbar(theirs).getByRole('button', { name: copy('shell.message.pin'), exact: true })).toHaveCount(0);
    const box2 = composerBox(page2, 'general');
    await box2.fill('@ev');
    await expect(mentionList(page2)).toHaveCount(0);
    await expect(page2.getByRole('option', { name: copy('shell.composer.mentionEveryone') })).toHaveCount(0);
    await box2.fill('');

    // Ada, by contrast, is offered @everyone.
    const box1 = composerBox(page, 'general');
    await box1.fill('@ev');
    await expect(page.getByRole('option', { name: new RegExp(copy('shell.composer.mentionEveryone')) })).toBeVisible({ timeout: WAIT });
    await box1.fill('');

    // 3. Ada makes the role "Crew": green, shown separately, mentionable, may pin. Focus returns to "new role".
    let settings = await openSettings(page);
    await navItem(settings, 'roles.tab').click();
    const newRole = button(settings, 'roles.new');
    await expect(newRole).toBeVisible({ timeout: WAIT });
    await expectAccessible(page, 'the roles tab');
    await newRole.click();
    let editor = dialogOf(page, 'roles.editor.titleNew', { server: SERVER });
    await expect(editor).toBeVisible({ timeout: WAIT });
    // Escape in a dialog nested in settings closes only that dialog, and focus goes back to its opener.
    await page.keyboard.press('Escape');
    await expect(editor).toBeHidden();
    await expect(settings).toBeVisible();
    await expect(newRole).toBeFocused();
    await newRole.click();
    await expect(editor).toBeVisible({ timeout: WAIT });
    await editor.getByRole('textbox', { name: copy('roles.editor.name'), exact: true }).fill(ROLE);
    await editor.getByRole('radio', { name: copy('roles.color.green'), exact: true }).click();
    await expect(editor.getByRole('radio', { name: copy('roles.color.green'), exact: true })).toHaveAttribute('aria-checked', 'true');
    await setSwitch(switchOf(editor, 'roles.editor.hoist'), true);
    await setSwitch(switchOf(editor, 'roles.editor.mentionable'), true);
    await setSwitch(switchOf(editor, 'perm.pin'), true);
    await expectAccessible(page, 'the role editor');
    await button(editor, 'roles.editor.create').click();
    await expect(editor).toBeHidden({ timeout: WAIT });
    await expect(announcer(page)).toHaveText(copy('roles.editor.created', { name: ROLE }), { timeout: WAIT });
    await expect(newRole).toBeFocused();
    await expect(roleRow(settings, ROLE)).toContainText(copy('roles.row.other', { count: 0 }));
    await closeSettings(page);

    // 4. Ada gives Björn the role from his member menu. "Done" returns focus to his menu trigger; both lists group "Crew — 1".
    await memberAction(page, FRIEND, 'roles.menu.assign');
    const assign = dialogOf(page, 'roles.assign.title', { name: FRIEND });
    await expect(assign).toBeVisible({ timeout: WAIT });
    const crew = assign.getByRole('checkbox', { name: ROLE, exact: true });
    await expect(crew).toBeFocused();
    await expectAccessible(page, 'the assign dialog');
    await crew.click();
    await expect(crew).toBeChecked({ timeout: WAIT });
    await expect(announcer(page)).toHaveText(copy('roles.assign.given', { role: ROLE, name: FRIEND }), { timeout: WAIT });
    await button(assign, 'roles.assign.close').click();
    await expect(assign).toBeHidden();
    await expect(memberTrigger(page, FRIEND)).toBeFocused();
    await expect(groupHeading(page, 1)).toBeVisible({ timeout: WAIT });
    await expect(groupHeading(page2, 1)).toBeVisible({ timeout: WAIT });
    // Escape closes the same dialog the same way.
    await memberAction(page, FRIEND, 'roles.menu.assign');
    await expect(assign).toBeVisible({ timeout: WAIT });
    await page.keyboard.press('Escape');
    await expect(assign).toBeHidden();
    await expect(memberTrigger(page, FRIEND)).toBeFocused();

    // 5. Björn now holds "pin messages" through Crew: he pins Ada's message. Ada's pins list names him and carries the note.
    await rowAction(theirs, 'pin');
    await expect(theirs).toHaveAttribute('data-pinned', 'true', { timeout: WAIT });
    const mine = messageRow(page, 'general', hello);
    await expect(mine).toHaveAttribute('data-pinned', 'true', { timeout: WAIT });
    const pinsButton = page.locator(CLASS.channelHeader).getByRole('button', { name: copy('shell.pins.open'), exact: true });
    await pinsButton.click();
    const pins = pinsDialog(page, 'general');
    await expect(pins).toBeVisible({ timeout: WAIT });
    await expect(pins).toContainText(copy('shell.pins.by', { name: FRIEND }), { timeout: WAIT });
    await expect(pins).toContainText(hello);
    await expect(pins).toContainText(copy('perm.pinsNote'));
    await page.keyboard.press('Escape');
    await expect(pins).toBeHidden();
    await expect(pinsButton).toBeFocused();

    // 6. Ada mentions the role. Björn stands in #side, so #general badges one mention; the message renders "@Crew" on both sides.
    await openChannel(page2, SERVER, 'side');
    await box1.fill('hi @cr');
    const options = mentionList(page);
    await expect(options).toBeVisible({ timeout: WAIT });
    const roleOption = options.getByRole('option', { name: new RegExp(`${ROLE}.*${copy('mention.role.secondary')}`) });
    await expect(roleOption).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(options).toBeHidden();
    await expect(box1).toHaveValue(new RegExp(`^hi @${ROLE.toLowerCase()} ?$`));
    await page.keyboard.press('Enter');
    const sent = logRegion(page, 'general').locator(CLASS.messageRow).filter({ has: page.locator(CLASS.mention).filter({ hasText: `@${ROLE}` }) });
    await expect(sent).toHaveAttribute('data-state', 'ok', { timeout: WAIT });
    await expect(sent).toContainText('hi');
    await expect(channelRow(page2, 'general')).toHaveAttribute('data-mentions', '1', { timeout: WAIT });
    await expect(channelRow(page2, 'general')).toHaveAccessibleName(copy('shell.channels.rowLabel', { name: 'general', unread: 1, mentions: 1 }));
    await channelRow(page2, 'general').click();
    const theirPing = logRegion(page2, 'general').locator(CLASS.messageRow).filter({ has: page2.locator(CLASS.mention).filter({ hasText: `@${ROLE}` }) });
    await expect(theirPing).toBeVisible({ timeout: WAIT });
    await expect(theirPing.locator(CLASS.mention)).toHaveText(`@${ROLE}`);

    // 7. Ada takes "pin messages" from Crew: Björn's pin stops counting. Ada's pins list no longer shows it, and her row loses the pin.
    settings = await openSettings(page);
    await navItem(settings, 'roles.tab').click();
    editor = await editRole(page, settings, ROLE);
    await expect(editor.getByRole('textbox', { name: copy('roles.editor.name'), exact: true })).toBeFocused();
    await setSwitch(switchOf(editor, 'perm.pin'), false);
    await button(editor, 'roles.editor.save').click();
    await expect(editor).toBeHidden({ timeout: WAIT });
    await expect(announcer(page)).toHaveText(copy('roles.editor.saved', { name: ROLE }), { timeout: WAIT });
    await expect(roleRow(settings, ROLE).getByRole('button', { name: copy('roles.editLabel', { name: ROLE }), exact: true })).toBeFocused();
    await closeSettings(page);
    await expect(mine).not.toHaveAttribute('data-pinned', 'true', { timeout: WAIT });
    await pinsButton.click();
    await expect(pins).toBeVisible({ timeout: WAIT });
    await expect(pins.getByText(copy('shell.pins.empty'), { exact: true })).toBeVisible({ timeout: WAIT });
    await expect(pins).not.toContainText(copy('shell.pins.by', { name: FRIEND }));
    await page.keyboard.press('Escape');
    await expect(pins).toBeHidden();
    await expect(pinsButton).toBeFocused();
    // Björn's own app follows too: his offer to pin is gone with the right.
    await theirs.focus();
    await expect(theirs).not.toHaveAttribute('data-pinned', 'true', { timeout: WAIT });
    await expect(rowToolbar(theirs).getByRole('button', { name: copy('shell.message.pin'), exact: true })).toHaveCount(0, { timeout: WAIT });

    // Turning the right back on brings the same pin back: pins follow the current rights, in both directions.
    settings = await openSettings(page);
    await navItem(settings, 'roles.tab').click();
    editor = await editRole(page, settings, ROLE);
    await setSwitch(switchOf(editor, 'perm.pin'), true);
    await button(editor, 'roles.editor.save').click();
    await expect(editor).toBeHidden({ timeout: WAIT });
    await closeSettings(page);
    await expect(mine).toHaveAttribute('data-pinned', 'true', { timeout: WAIT });
    await pinsButton.click();
    await expect(pins).toContainText(copy('shell.pins.by', { name: FRIEND }), { timeout: WAIT });
    await page.keyboard.press('Escape');
    await expect(pins).toBeHidden();

    // 8. Ada deletes Crew. Cancel (and Escape) close only the confirm; the delete returns focus to "new role" and Björn's group goes.
    settings = await openSettings(page);
    await navItem(settings, 'roles.tab').click();
    const del = roleRow(settings, ROLE).getByRole('button', { name: copy('roles.deleteLabel', { name: ROLE }), exact: true });
    await del.click();
    const confirm = dialogOf(page, 'roles.deleteTitle', { name: ROLE });
    await expect(confirm).toBeVisible({ timeout: WAIT });
    await expect(button(confirm, 'roles.editor.cancel')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(confirm).toBeHidden();
    await expect(settings).toBeVisible();
    await expect(del).toBeFocused();
    await del.click();
    await expect(confirm).toBeVisible({ timeout: WAIT });
    await button(confirm, 'roles.deleteConfirm').click();
    await expect(confirm).toBeHidden({ timeout: WAIT });
    await expect(announcer(page)).toHaveText(copy('roles.deleted', { name: ROLE }), { timeout: WAIT });
    await expect(button(settings, 'roles.new')).toBeFocused();
    await expect(roleRow(settings, ROLE)).toHaveCount(0);
    await closeSettings(page);
    await expect(groupHeading(page, 1)).toHaveCount(0, { timeout: WAIT });
    await expect(groupHeading(page2, 1)).toHaveCount(0, { timeout: WAIT });
    await expect(memberRow(page2, FRIEND)).toBeVisible();
    await guard.collectWorkers();
  } finally {
    await second.close();
    rmSync(secondDir, { recursive: true, force: true });
  }
});

// v0.1.0-web3.1, the regression test of the create-flow incident: a fresh instance could not be used from the web client,
// and every suite hid it by seeding its servers through dilla-testhost. This suite starts a test host of its own with no
// account, no server and no channel, and gets from there to two people talking using the shipping client alone: the
// bootstrap invite, "new server", "invite link", a sign-up through that link, a reply, a direct message through the picker,
// and a second channel both of them use. Nothing here seeds state or calls the instance's API on anyone's behalf.
import { mkdirSync, rmSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import {
  TEST_TIMEOUT, WAIT, completeSignUp, composerBox, copy, dmsNav, expectAccessible, expectComposerReady, expectShell, messageRow,
  newAccount, openChannel, railItem, railNav, sendText, sidebarTab, signUp, tag, test,
} from './support/app';
import { startTestHost, type HostConfig, type StartedHost } from './support/host';
import { profileDirFor } from './support/persistent';
import { arr, decode } from '../../packages/client-core/src/cbor/index';

/** Its own ports: the suite's shared host (8463/8464) has servers in it by now. */
const EMPTY: HostConfig = { port: 8477, control: 8478, webRoot: 'packages/web/dist' };
const SERVER = 'Midgard Crew';

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
const log = (page: Page) => page.getByRole('log');
const dmRow = (page: Page, text: string) => log(page).locator('.d-message-row').filter({ hasText: text });

test('from an empty instance: start a server, invite a friend through a link, reply, DM and add a channel', async ({
  page, guard, playwright, browserName, launchOptions, headless, channel, viewport,
}, testInfo) => {
  const h = started();

  // The first person on the instance: the bootstrap invite, then a shell that says how to begin.
  // The host prints its instance invites comma-separated; the first is the one an operator would hand on.
  await signUp(page, h.invite.split(',')[0], instance, 'Ada');
  const empty = page.getByRole('region', { name: copy('shell.noServer.title'), exact: true });
  await expect(empty).toBeVisible({ timeout: WAIT });
  await expect(empty.getByRole('button', { name: copy('shell.noServer.create'), exact: true })).toBeVisible();
  await expect(empty.getByRole('button', { name: copy('shell.noServer.action'), exact: true })).toBeVisible();
  await expectAccessible(page, 'a fresh instance, no server');

  // Start a server from the rail: it comes with #general and a voice general, and #general opens, focus in its composer.
  await railNav(page).getByRole('button', { name: copy('create.rail.newLabel'), exact: true }).click();
  const start = page.getByRole('dialog', { name: copy('create.server.title'), exact: true });
  await expect(start.getByRole('textbox', { name: copy('create.server.name'), exact: true })).toBeFocused();
  await expectAccessible(page, 'start a server');
  await page.keyboard.type(SERVER);
  await page.keyboard.press('Enter');
  await expect(start).toBeHidden({ timeout: WAIT });
  await expect(page).toHaveURL(/\/c\/[0-9a-f]{32}\/[0-9a-f]{32}$/, { timeout: WAIT });
  await expect(railItem(page, SERVER)).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('button', { name: copy('voice.open', { name: 'general' }), exact: true })).toBeVisible();
  await expectComposerReady(page, 'general');
  await expect(composerBox(page, 'general')).toBeFocused();
  const alone = `the first message on a new instance ${tag()}`;
  await sendText(page, 'general', alone);

  // Copy an invite link. Chromium lets the test read the clipboard back; Firefox may refuse a copy that a network round
  // trip separated from the click, and the dialog then says so. Either way the link stands in the dialog.
  if (browserName === 'chromium') await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: copy('invite.open'), exact: true }).click();
  const inviteDialog = page.getByRole('dialog', { name: copy('invite.title', { server: SERVER }), exact: true });
  const status = inviteDialog.getByRole('status');
  if (browserName === 'chromium') await expect(status).toHaveText(copy('invite.copied'), { timeout: WAIT });
  else await expect(status).toHaveText(new RegExp(`^(${copy('invite.copied')}|${copy('invite.blocked')})$`), { timeout: WAIT });
  const link = await inviteDialog.getByRole('textbox', { name: copy('invite.link'), exact: true }).inputValue();
  expect(link).toMatch(/^https?:\/\/[^/\s]+\/i\/[^/\s]+$/);
  if (browserName === 'chromium') expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
  await expectAccessible(page, 'the invite link');
  await page.keyboard.press('Escape');
  await expect(inviteDialog).toBeHidden();

  // The second person, in a browser of their own, through that link: the instance's invite page, then its "open dilla"
  // link, then the sign-up, which lands them in the server. The link names the instance's public domain; this host
  // serves it on loopback, so its path is opened here.
  const secondDir = `${profileDirFor(testInfo.project.name, testInfo.workerIndex)}-second`;
  rmSync(secondDir, { recursive: true, force: true });
  mkdirSync(secondDir, { recursive: true });
  const second = await playwright[browserName].launchPersistentContext(secondDir, { ...launchOptions, headless, channel, viewport, baseURL: h.url });
  try {
    const page2 = second.pages()[0] ?? (await second.newPage());
    await page2.goto(new URL(link).pathname);
    const openLink = page2.getByRole('link', { name: 'Open dilla in this browser' });
    await expect(openLink).toHaveAttribute('href', /^\/welcome\?invite=[^&\s]+$/);
    // The guard watches the web client from its first page on. The invite page before it is the instance's static HTML
    // under `default-src 'none'`: Firefox asks it for /favicon.ico on its own and reports the refusal, which is that CSP
    // working, not the client's (it is not this suite's to judge).
    await guard.attach(second);
    await openLink.click();
    await completeSignUp(page2, newAccount('Björn'), instance);
    await expect(railItem(page2, SERVER)).toBeVisible({ timeout: WAIT });
    await openChannel(page2, SERVER, 'general');
    // A browser shows no message from before it joined (Flow 04); the conversation starts now.
    await expect(messageRow(page2, 'general', alone)).toHaveCount(0);
    const welcome = `welcome to ${SERVER} ${tag()}`;
    await sendText(page, 'general', welcome);
    await expect(messageRow(page2, 'general', welcome)).toHaveAttribute('data-state', 'ok', { timeout: WAIT });
    const reply = `thanks for the link ${tag()}`;
    await sendText(page2, 'general', reply);
    await expect(messageRow(page, 'general', reply)).toHaveAttribute('data-state', 'ok', { timeout: WAIT });

    // A direct message with the first person, through the picker.
    await sidebarTab(page2, 'dms').click();
    await page2.getByRole('button', { name: copy('shell.dms.new'), exact: true }).click();
    const picker = page2.getByRole('dialog', { name: copy('shell.dms.newTitle'), exact: true });
    const pick = picker.getByRole('button', { name: copy('shell.dms.open'), exact: true });
    await expect(pick).toHaveCount(1);
    await expect(pick).toHaveAccessibleDescription('Ada');
    await pick.click();
    await expect(page2).toHaveURL(/\/dm\/[0-9a-f]{32}$/, { timeout: WAIT });
    const dmBox = page2.getByRole('textbox', { name: copy('shell.dm.composer', { name: 'Ada' }), exact: true });
    await expect(dmBox).toBeEnabled({ timeout: WAIT });
    const dmText = `just between us ${tag()}`;
    await dmBox.fill(dmText);
    await dmBox.press('Enter');
    await expect(dmRow(page2, dmText)).toHaveAttribute('data-state', 'ok', { timeout: WAIT });
    await sidebarTab(page, 'dms').click();
    await dmsNav(page).getByRole('button', { name: /^Björn(, |$)/ }).click();
    await expect(dmRow(page, dmText)).toHaveAttribute('data-state', 'ok', { timeout: WAIT });

    // The owner adds a second text channel and both use it. The second person's tab learns of it when it is read again:
    // the window coming back to the tab, a reconnect or, as here, a reload.
    await sidebarTab(page, 'channels').click();
    await page.getByRole('button', { name: copy('create.channel.open'), exact: true }).click();
    const newChannel = page.getByRole('dialog', { name: copy('create.channel.title', { server: SERVER }), exact: true });
    await expect(newChannel.getByRole('textbox', { name: copy('create.channel.name'), exact: true })).toBeFocused();
    await expectAccessible(page, 'new channel');
    await page.keyboard.type('Random');
    await page.keyboard.press('Enter');
    await expect(newChannel).toBeHidden({ timeout: WAIT });
    await expectComposerReady(page, 'random');
    await page2.reload();
    await expectShell(page2);
    await openChannel(page2, SERVER, 'random');
    const inRandom = `the first words in #random ${tag()}`;
    await sendText(page, 'random', inRandom);
    await expect(messageRow(page2, 'random', inRandom)).toHaveAttribute('data-state', 'ok', { timeout: WAIT });
    const answer = `and an answer in #random ${tag()}`;
    await sendText(page2, 'random', answer);
    await expect(messageRow(page, 'random', answer)).toHaveAttribute('data-state', 'ok', { timeout: WAIT });
    await guard.collectWorkers();
  } finally {
    await second.close();
    rmSync(secondDir, { recursive: true, force: true });
  }
});

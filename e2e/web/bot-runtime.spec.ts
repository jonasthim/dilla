import { expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  FIREFOX_FAVICON_LINE, addServerVia, completeSignUp, copy, isFirefoxBrowserFaviconViolation, makeInviteLink, messageRow, newAccount,
  openChannel, reactionChip, rowAction, signUp, test,
} from './support/app';
import { startTestHost, type HostConfig, type StartedHost } from './support/host';
import { arr, decode } from '../../packages/client-core/src/cbor/index';

const HOST: HostConfig = { port: 8491, control: 8492, webRoot: 'packages/web/dist', botRuntime: true };
const ROLE_PANEL_PORT = Number(process.env.DILLA_E2E_ROLE_PANEL_PORT ?? HOST.port);
const ROLE_PANEL_HOST: HostConfig = { ...HOST, port: ROLE_PANEL_PORT, control: ROLE_PANEL_PORT + 1, advanceClockWithWall: true };
const SERVER = 'Runtime Bot Acceptance';

test.use({ baseURL: `http://127.0.0.1:${ROLE_PANEL_PORT}` });

test('the Firefox web guard exempts only its browser-chrome favicon refusal', () => {
  const favicon = {
    directive: 'img-src', blockedURI: 'http://127.0.0.1:8491/favicon.ico', sourceFile: 'resource', sample: '',
  };
  expect(isFirefoxBrowserFaviconViolation('firefox-web', favicon)).toBe(true);
  expect(isFirefoxBrowserFaviconViolation('chromium-web', favicon)).toBe(false);
  expect(isFirefoxBrowserFaviconViolation('firefox-web', { ...favicon, sourceFile: 'http://127.0.0.1:8491/i/invite' })).toBe(false);
  expect(isFirefoxBrowserFaviconViolation('firefox-web', { ...favicon, blockedURI: 'http://127.0.0.1:8491/avatar.png' })).toBe(false);
  expect(FIREFOX_FAVICON_LINE.test('[JavaScript Error: "Content-Security-Policy: The page.s settings blocked the loading of a resource (img-src) at http://127.0.0.1:8491/favicon.ico . {file: "resource:///modules/FaviconLoader.sys.mjs" line: 52}]')).toBe(true);
});

test('a bot enabled through server settings reaches ready through the native runtime', async ({ page, instanceName }) => {
  let host: StartedHost | null = null;
  try {
    host = await startTestHost(HOST);
    const account = await signUp(page, host.invite.split(',')[0] ?? '', instanceName, 'Ada', host.control);
    await addServerVia(page, 'create');
    const create = page.getByRole('dialog', { name: copy('create.server.title'), exact: true });
    await create.getByRole('textbox', { name: copy('create.server.name'), exact: true }).fill(SERVER);
    await page.keyboard.press('Enter');

    await page.getByRole('button', { name: copy('admin.open'), exact: true }).click();
    const settings = page.getByRole('dialog', { name: copy('admin.title'), exact: true });
    await expect(settings.getByRole('navigation', { name: copy('admin.nav'), exact: true })).toBeVisible();
    await settings.getByRole('navigation', { name: copy('admin.nav'), exact: true })
      .getByRole('button', { name: copy('admin.nav.bot'), exact: true }).click();
    await expect(settings.getByText(copy('admin.bot.none'), { exact: true })).toBeVisible();
    // Keep the capability mask empty for this baseline; the rendered chooser is source-current.
    await expect(settings.getByRole('checkbox', { name: copy('admin.bot.capability.roles'), exact: true })).toBeEnabled();
    await settings.getByRole('button', { name: copy('admin.bot.enable'), exact: true }).click();
    const stepUp = page.getByRole('dialog', { name: copy('factorSettings.stepUp.title'), exact: true });
    await stepUp.getByLabel(copy('factorSettings.stepUp.password'), { exact: true }).fill(account.password);
    await stepUp.getByRole('button', { name: copy('factorSettings.stepUp.confirm'), exact: true }).click();

    const runtimeCredentialFile = host.runtimeCredentialFile;
    if (runtimeCredentialFile === undefined) throw new Error('test host did not expose its protected runtime credential path');
    await expect.poll(async () => {
      const token = readFileSync(runtimeCredentialFile, 'utf8').trim();
      const response = await fetch(`${host!.url}/v1/bot-runtime/installations`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/cbor' },
      });
      if (!response.ok) return `HTTP ${response.status}`;
      const rows = arr(decode(new Uint8Array(await response.arrayBuffer())));
      return rows.length === 1 ? arr(rows[0])[2] : `count ${rows.length}`;
    }, { timeout: 90_000, intervals: [1_000, 2_000] }).toBe(3n);

    await expect.poll(async () => {
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: copy('admin.open'), exact: true }).click();
      const refreshed = page.getByRole('dialog', { name: copy('admin.title'), exact: true });
      await refreshed.getByRole('navigation', { name: copy('admin.nav'), exact: true })
        .getByRole('button', { name: copy('admin.nav.bot'), exact: true }).click();
      return refreshed.getByRole('status').innerText();
    }, { timeout: 90_000, intervals: [1_000, 2_000, 3_000] }).toBe(copy('admin.bot.status.ready'));
  } finally {
    await host?.stop();
  }
});


test('a Roles-enabled bot applies the configured join role on join and rejoin', async ({ page, instanceName, browser, guard }) => {
  let host: StartedHost | null = null;
  let secondContext: import('@playwright/test').BrowserContext | null = null;
  const joinRoleName = 'Arrival Crew';
  try {
    host = await startTestHost(HOST);
    const owner = await signUp(page, host.invite.split(',')[0] ?? '', instanceName, 'Ada', host.control);
    await addServerVia(page, 'create');
    const create = page.getByRole('dialog', { name: copy('create.server.title'), exact: true });
    await create.getByRole('textbox', { name: copy('create.server.name'), exact: true }).fill(SERVER);
    await page.keyboard.press('Enter');

    await page.getByRole('button', { name: copy('admin.open'), exact: true }).click();
    let settings = page.getByRole('dialog', { name: copy('admin.title'), exact: true });
    const nav = settings.getByRole('navigation', { name: copy('admin.nav'), exact: true });
    await nav.getByRole('button', { name: copy('roles.tab'), exact: true }).click();
    await settings.getByRole('button', { name: copy('roles.new'), exact: true }).click();
    const roleEditor = page.getByRole('dialog', { name: copy('roles.editor.titleNew', { server: SERVER }), exact: true });
    await roleEditor.getByRole('textbox', { name: copy('roles.editor.name'), exact: true }).fill(joinRoleName);
    await roleEditor.getByRole('button', { name: copy('roles.editor.create'), exact: true }).click();
    await expect(roleEditor).toBeHidden();
    const roleList = settings.getByRole('list', { name: copy('roles.title'), exact: true });
    const roleRow = roleList.getByRole('listitem').filter({ hasText: joinRoleName });
    await expect(roleRow).toContainText(copy('roles.row.other', { count: 0 }));

    await nav.getByRole('button', { name: copy('admin.nav.bot'), exact: true }).click();
    const rolesCapability = settings.getByRole('checkbox', { name: copy('admin.bot.capability.roles'), exact: true });
    await expect(rolesCapability).toBeEnabled();
    await rolesCapability.check();
    await settings.getByRole('button', { name: copy('admin.bot.enable'), exact: true }).click();
    const stepUp = page.getByRole('dialog', { name: copy('factorSettings.stepUp.title'), exact: true });
    await stepUp.getByLabel(copy('factorSettings.stepUp.password'), { exact: true }).fill(owner.password);
    await stepUp.getByRole('button', { name: copy('factorSettings.stepUp.confirm'), exact: true }).click();

    const runtimeCredentialFile = host.runtimeCredentialFile;
    if (runtimeCredentialFile === undefined) throw new Error('test host did not expose its protected runtime credential path');
    await expect.poll(async () => {
      const token = readFileSync(runtimeCredentialFile, 'utf8').trim();
      const response = await fetch(`${host!.url}/v1/bot-runtime/installations`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/cbor' },
      });
      if (!response.ok) return `HTTP ${response.status}`;
      const rows = arr(decode(new Uint8Array(await response.arrayBuffer())));
      return rows.length === 1 ? arr(rows[0])[2] : `count ${rows.length}`;
    }, { timeout: 90_000, intervals: [1_000, 2_000] }).toBe(3n);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: copy('admin.open'), exact: true }).click();
    settings = page.getByRole('dialog', { name: copy('admin.title'), exact: true });
    await settings.getByRole('navigation', { name: copy('admin.nav'), exact: true })
      .getByRole('button', { name: copy('admin.nav.bot'), exact: true }).click();
    await expect(settings.getByRole('status')).toHaveText(copy('admin.bot.status.ready'), { timeout: 30_000 });

    const joinRoleSelect = settings.getByRole('combobox', { name: copy('admin.bot.joinRole.label'), exact: true });
    await expect(joinRoleSelect).toBeVisible();
    const selectedJoinRole = await joinRoleSelect.selectOption({ label: joinRoleName });
    const saveJoinRole = settings.getByRole('button', { name: copy('admin.bot.joinRole.save'), exact: true });
    await expect(saveJoinRole).toBeEnabled();
    await saveJoinRole.click();
    await expect(saveJoinRole).toBeDisabled();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: copy('admin.open'), exact: true }).click();
    settings = page.getByRole('dialog', { name: copy('admin.title'), exact: true });
    await settings.getByRole('navigation', { name: copy('admin.nav'), exact: true })
      .getByRole('button', { name: copy('admin.nav.bot'), exact: true }).click();
    await expect(settings.getByRole('combobox', { name: copy('admin.bot.joinRole.label'), exact: true }))
      .toHaveValue(selectedJoinRole[0] ?? '');
    await settings.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(settings).toBeHidden();
    const inviteLink = await makeInviteLink(page, SERVER);

    secondContext = await browser.newContext({ baseURL: host.url });
    await guard.attach(secondContext);
    const secondPage = await secondContext.newPage();
    await secondPage.goto(new URL(inviteLink).pathname);
    const openInvite = secondPage.getByRole('link', { name: 'Open dilla in this browser', exact: true });
    await openInvite.click();
    await completeSignUp(secondPage, newAccount('Bea', host.control), instanceName);
    await expect.poll(async () => {
      const openSettings = page.getByRole('dialog', { name: copy('admin.title'), exact: true });
      if (await openSettings.isVisible()) {
        await openSettings.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(openSettings).toBeHidden();
      }
      await page.getByRole('button', { name: copy('admin.open'), exact: true }).click();
      settings = page.getByRole('dialog', { name: copy('admin.title'), exact: true });
      await settings.getByRole('navigation', { name: copy('admin.nav'), exact: true })
        .getByRole('button', { name: copy('roles.tab'), exact: true }).click();
      return roleRow.innerText();
    }, { timeout: 90_000, intervals: [1_000, 2_000] }).toContain(copy('roles.row.one'));

    await secondPage.getByRole('button', { name: copy('admin.open'), exact: true }).click();
    const secondSettings = secondPage.getByRole('dialog', { name: copy('admin.title'), exact: true });
    await secondSettings.getByRole('navigation', { name: copy('admin.nav'), exact: true })
      .getByRole('button', { name: copy('admin.nav.leave'), exact: true }).click();
    await secondSettings.getByRole('group').getByRole('button', { name: copy('admin.leave.open'), exact: true }).click();
    const leaveDialog = secondPage.getByRole('dialog', { name: copy('admin.leave.title', { server: SERVER }), exact: true });
    await leaveDialog.getByRole('button', { name: copy('admin.leave.confirm'), exact: true }).click();
    await expect(leaveDialog).toBeHidden();
    await expect(secondPage.getByRole('navigation', { name: copy('shell.rail.label'), exact: true })
      .getByRole('button', { name: SERVER, exact: true })).toHaveCount(0);
    await expect(roleRow).toContainText(copy('roles.row.other', { count: 0 }));

    await addServerVia(secondPage, 'join');
    const joinDialog = secondPage.getByRole('dialog', { name: copy('join.title'), exact: true });
    await joinDialog.getByLabel(copy('join.invite'), { exact: true }).fill(inviteLink);
    await joinDialog.getByRole('button', { name: copy('join.submit'), exact: true }).click();
    await expect(joinDialog).toBeHidden();
    await expect(secondPage.getByRole('navigation', { name: copy('shell.rail.label'), exact: true })
      .getByRole('button', { name: SERVER, exact: true })).toBeVisible();
    await expect.poll(() => roleRow.innerText(), { timeout: 90_000, intervals: [1_000, 2_000] })
      .toContain(copy('roles.row.one'));
  } finally {
    await secondContext?.close();
    await host?.stop();
  }
});

test('a human publishes a bot-authored self-service role panel and its reaction grant keeps its own source', async ({ page, instanceName, browser, guard }) => {
  let host: StartedHost | null = null;
  let secondContext: import('@playwright/test').BrowserContext | null = null;
  let secondPage: import('@playwright/test').Page | null = null;
  const roleName = 'Readers';
  try {
    host = await startTestHost(ROLE_PANEL_HOST);
    const owner = await signUp(page, host.invite.split(',')[0] ?? '', instanceName, 'Ada', host.control);
    await addServerVia(page, 'create');
    const create = page.getByRole('dialog', { name: copy('create.server.title'), exact: true });
    await create.getByRole('textbox', { name: copy('create.server.name'), exact: true }).fill(SERVER);
    await page.keyboard.press('Enter');

    await page.getByRole('button', { name: copy('admin.open'), exact: true }).click();
    let settings = page.getByRole('dialog', { name: copy('admin.title'), exact: true });
    let nav = settings.getByRole('navigation', { name: copy('admin.nav'), exact: true });
    await nav.getByRole('button', { name: copy('roles.tab'), exact: true }).click();
    await settings.getByRole('button', { name: copy('roles.new'), exact: true }).click();
    const roleEditor = page.getByRole('dialog', { name: copy('roles.editor.titleNew', { server: SERVER }), exact: true });
    await roleEditor.getByRole('textbox', { name: copy('roles.editor.name'), exact: true }).fill(roleName);
    await roleEditor.getByRole('switch', { name: copy('roles.editor.hoist'), exact: true }).click();
    await roleEditor.getByRole('button', { name: copy('roles.editor.create'), exact: true }).click();
    await expect(roleEditor).toBeHidden();

    await nav.getByRole('button', { name: copy('admin.nav.bot'), exact: true }).click();
    await settings.getByRole('checkbox', { name: copy('admin.bot.capability.roles'), exact: true }).check();
    await settings.getByRole('button', { name: copy('admin.bot.enable'), exact: true }).click();
    const stepUp = page.getByRole('dialog', { name: copy('factorSettings.stepUp.title'), exact: true });
    await stepUp.getByLabel(copy('factorSettings.stepUp.password'), { exact: true }).fill(owner.password);
    await stepUp.getByRole('button', { name: copy('factorSettings.stepUp.confirm'), exact: true }).click();

    const runtimeCredentialFile = host.runtimeCredentialFile;
    if (runtimeCredentialFile === undefined) throw new Error('test host did not expose its protected runtime credential path');
    await expect.poll(async () => {
      const token = readFileSync(runtimeCredentialFile, 'utf8').trim();
      const response = await fetch(`${host!.url}/v1/bot-runtime/installations`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/cbor' },
      });
      if (!response.ok) return `HTTP ${response.status}`;
      const rows = arr(decode(new Uint8Array(await response.arrayBuffer())));
      return rows.length === 1 ? arr(rows[0])[2] : `count ${rows.length}`;
    }, { timeout: 90_000, intervals: [1_000, 2_000] }).toBe(3n);

    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: copy('admin.open'), exact: true }).click();
    settings = page.getByRole('dialog', { name: copy('admin.title'), exact: true });
    nav = settings.getByRole('navigation', { name: copy('admin.nav'), exact: true });
    await nav.getByRole('button', { name: copy('admin.nav.bot'), exact: true }).click();
    await expect(settings.getByRole('status')).toHaveText(copy('admin.bot.status.ready'), { timeout: 30_000 });

    // Approve a plain role using the owner UI; only approved, eligible roles can appear in the panel publisher.
    await nav.getByRole('button', { name: copy('admin.nav.selfRoles'), exact: true }).click();
    const approval = settings.getByRole('group').filter({ hasText: copy('admin.bot.selfRoles.configure') });
    const approvalCheckbox = approval.getByLabel(roleName, { exact: true });
    await expect(approvalCheckbox).not.toBeChecked();
    await approvalCheckbox.click();
    await expect(approvalCheckbox).toBeChecked();
    await expect(page.getByTestId('shell-announcer')).toContainText(copy('admin.bot.selfRoles.saved'));

    // Join the second human before publishing so the acceptance exercises live encrypted delivery.
    await page.keyboard.press('Escape');
    await expect(settings).toBeHidden();
    const inviteLink = await makeInviteLink(page, SERVER);
    secondContext = await browser.newContext({ baseURL: host.url });
    await guard.attach(secondContext);
    secondPage = await secondContext.newPage();
    await secondPage.goto(new URL(inviteLink).pathname);
    await secondPage.getByRole('link', { name: 'Open dilla in this browser', exact: true }).click();
    await completeSignUp(secondPage, newAccount('Bea', host.control), instanceName);
    await openChannel(secondPage, SERVER, 'general');

    await page.getByRole('button', { name: copy('admin.open'), exact: true }).click();
    settings = page.getByRole('dialog', { name: copy('admin.title'), exact: true });
    nav = settings.getByRole('navigation', { name: copy('admin.nav'), exact: true });
    await nav.getByRole('button', { name: copy('admin.nav.selfRoles'), exact: true }).click();

    await settings.getByLabel(`${copy('admin.bot.rolePanel.emoji')} for ${roleName}`, { exact: true }).fill('👍');
    await settings.getByRole('combobox', { name: copy('admin.bot.rolePanel.channel'), exact: true }).selectOption({ label: 'general' });
    await settings.getByRole('button', { name: copy('admin.bot.rolePanel.publish'), exact: true }).click();
    await expect(settings.getByRole('status')).toHaveText(copy('admin.bot.rolePanel.pending'));
    await expect(settings.getByRole('status')).toHaveText(copy('admin.bot.rolePanel.published'), { timeout: 90_000 });
    await page.keyboard.press('Escape');
    await expect(settings).toBeHidden();

    const panel = messageRow(page, 'general', '👍 Readers');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel).toContainText('React with the matching emoji to choose a role:');
    await expect(panel).toContainText('👍 Readers');
    await expect(panel.getByText('bot', { exact: true })).toBeVisible();
    await expect(panel).toHaveAttribute('data-state', 'ok');

    if (secondPage === null) throw new Error('second member was not joined before panel publish');
    const secondPanel = messageRow(secondPage, 'general', '👍 Readers');
    await expect(secondPanel).toBeVisible({ timeout: 30_000 });
    await rowAction(secondPanel, 'react');
    const emojiPicker = secondPage.getByRole('dialog', { name: copy('shell.emoji.label'), exact: true });
    await emojiPicker.getByRole('button', { name: copy('shell.emoji.01'), exact: true }).click();
    await expect(reactionChip(secondPanel, copy('shell.emoji.01'), 1)).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
    const members = secondPage.getByRole('complementary', { name: copy('members.region', { server: SERVER }), exact: true });
    const memberRole = (count: number) => members.getByRole('heading', { name: copy('members.group', { name: roleName, count }), exact: true });
    await expect(memberRole(1)).toBeVisible({ timeout: 30_000 });

    // The panel reaction and the member's ordinary self-service choice are separate grants.
    await secondPage.getByRole('button', { name: copy('admin.open'), exact: true }).click();
    const memberSettings = secondPage.getByRole('dialog', { name: copy('admin.title'), exact: true });
    await memberSettings.getByRole('navigation', { name: copy('admin.nav'), exact: true })
      .getByRole('button', { name: copy('admin.nav.selfRoles'), exact: true }).click();
    let selfRole = memberSettings.getByRole('group').getByLabel(roleName, { exact: true });
    await expect(selfRole).toBeVisible();
    await expect(selfRole).not.toBeChecked();
    await selfRole.click();
    await expect(selfRole).toBeChecked();
    await secondPage.keyboard.press('Escape');
    await rowAction(secondPanel, 'react');
    const removePicker = secondPage.getByRole('dialog', { name: copy('shell.emoji.label'), exact: true });
    await removePicker.getByRole('button', { name: copy('shell.emoji.01'), exact: true }).click();
    await expect(reactionChip(secondPanel, copy('shell.emoji.01'), 1)).toHaveCount(0, { timeout: 30_000 });
    await secondPage.getByRole('button', { name: copy('admin.open'), exact: true }).click();
    const settingsAfterRemoval = secondPage.getByRole('dialog', { name: copy('admin.title'), exact: true });
    await settingsAfterRemoval.getByRole('navigation', { name: copy('admin.nav'), exact: true })
      .getByRole('button', { name: copy('admin.nav.selfRoles'), exact: true }).click();
    selfRole = settingsAfterRemoval.getByRole('group').getByLabel(roleName, { exact: true });
    await expect(selfRole).toBeChecked();
    await expect(memberRole(1)).toBeVisible({ timeout: 30_000 });
    await selfRole.click();
    await expect(selfRole).not.toBeChecked();
    await expect(memberRole(1)).toHaveCount(0, { timeout: 30_000 });
  } finally {
    await secondContext?.close();
    await host?.stop();
  }
});

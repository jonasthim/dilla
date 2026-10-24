import { expect } from '@playwright/test';
import {
  addServerVia, completeSignUp, composerBox, copy, makeInviteLink, messageRow, newAccount, openChannel, railItem, signUp, test,
} from './support/app';
import { startTestHost, type HostConfig, type StartedHost } from './support/host';

const HOST: HostConfig = {
  port: 8511, control: 8512, webRoot: 'packages/web/dist', botRuntime: true, advanceClockWithWall: true,
};
const SERVER = 'Automatic Moderation Acceptance';
const OWNER = 'Ada';
const TARGET = 'Bea';
const EXCERPT_BODY = `automod-evidence-${'x'.repeat(540)}-AUTOMOD_TAIL_SENTINEL`;

async function sendRepeat(page: import('@playwright/test').Page, text: string): Promise<void> {
  const box = composerBox(page, 'general');
  await box.fill(text);
  await box.press('Enter');
  await expect(messageRow(page, 'general', text).last()).toHaveAttribute('data-state', 'ok');
}

test.use({ baseURL: `http://127.0.0.1:${String(HOST.port)}` });

test('automatic moderation starts log-only, decrypts repeats, bounds evidence, and applies a configured action once', async ({ page, browser, guard, instanceName }) => {
  let host: StartedHost | null = null;
  let targetContext: import('@playwright/test').BrowserContext | null = null;
  try {
    host = await startTestHost(HOST);
    const owner = await signUp(page, host.invite.split(',')[0] ?? '', instanceName, OWNER, host.control);
    await addServerVia(page, 'create');
    const create = page.getByRole('dialog', { name: copy('create.server.title'), exact: true });
    await create.getByRole('textbox', { name: copy('create.server.name'), exact: true }).fill(SERVER);
    await page.keyboard.press('Enter');
    await openChannel(page, SERVER, 'general');

    const invite = await makeInviteLink(page, SERVER);
    targetContext = await browser.newContext({ baseURL: host.url });
    await guard.attach(targetContext);
    const targetPage = await targetContext.newPage();
    await targetPage.goto(new URL(invite).pathname);
    await targetPage.getByRole('link', { name: 'Open dilla in this browser', exact: true }).click();
    await completeSignUp(targetPage, newAccount(TARGET, host.control), instanceName);
    await expect(railItem(targetPage, SERVER)).toBeVisible();
    await openChannel(targetPage, SERVER, 'general');

    // The bot needs only its warnings capability for the later warning action.
    await page.getByRole('button', { name: copy('admin.open'), exact: true }).click();
    let settings = page.getByRole('dialog', { name: copy('admin.title'), exact: true });
    let nav = settings.getByRole('navigation', { name: copy('admin.nav'), exact: true });
    await nav.getByRole('button', { name: copy('admin.nav.bot'), exact: true }).click();
    await settings.getByRole('checkbox', { name: copy('admin.bot.capability.warnings'), exact: true }).check();
    await settings.getByRole('button', { name: copy('admin.bot.enable'), exact: true }).click();
    const stepUp = page.getByRole('dialog', { name: copy('factorSettings.stepUp.title'), exact: true });
    await stepUp.getByLabel(copy('factorSettings.stepUp.password'), { exact: true }).fill(owner.password);
    await stepUp.getByRole('button', { name: copy('factorSettings.stepUp.confirm'), exact: true }).click();
    await expect(settings.getByRole('status')).toHaveText(copy('admin.bot.status.ready'), { timeout: 90_000 });

    // A real user can send repeated plaintext, which the native bot receives as decrypted group events.
    const harmlessRepeat = 'automod default remains passive';
    await sendRepeat(targetPage, harmlessRepeat);
    await sendRepeat(targetPage, harmlessRepeat);
    await sendRepeat(targetPage, harmlessRepeat);
    await expect(targetPage.locator('.d-message-row').filter({ hasText: harmlessRepeat })).toHaveCount(3);

    await settings.getByRole('button', { name: 'Cancel', exact: true }).first().click();
    await expect(settings).toBeHidden();
    await page.getByRole('button', { name: copy('admin.open'), exact: true }).click();
    settings = page.getByRole('dialog', { name: copy('admin.title'), exact: true });
    nav = settings.getByRole('navigation', { name: copy('admin.nav'), exact: true });
    await nav.getByRole('button', { name: copy('admin.nav.bot'), exact: true }).click();

    const loadSettings = settings.getByRole('button', { name: copy('admin.bot.automod.load'), exact: true });
    await loadSettings.click();
    await expect(settings.getByText(copy('admin.bot.automod.loaded'), { exact: true })).toBeVisible();
    const enabled = settings.getByRole('checkbox', { name: copy('admin.bot.automod.enabled'), exact: true });
    const duplicateAction = settings.getByRole('combobox', { name: copy('admin.bot.automod.duplicate'), exact: true });
    await expect(enabled).not.toBeChecked();
    await expect(duplicateAction).toHaveValue('log');

    // The log-only default did not remove content or prevent another send.
    await expect(targetPage.locator('.d-message-row').filter({ hasText: harmlessRepeat })).toHaveCount(3);
    await sendRepeat(targetPage, 'a further message is still allowed under the default policy');

    await enabled.check();
    await duplicateAction.selectOption('warn');
    await settings.getByRole('button', { name: copy('admin.bot.automod.save'), exact: true }).click();
    const saveStepUp = page.getByRole('dialog', { name: copy('factorSettings.stepUp.title'), exact: true });
    await saveStepUp.getByLabel(copy('factorSettings.stepUp.password'), { exact: true }).fill(owner.password);
    await saveStepUp.getByRole('button', { name: copy('factorSettings.stepUp.confirm'), exact: true }).click();
    await expect(settings.getByText(copy('admin.bot.automod.loaded'), { exact: true })).toBeHidden();
    await expect(settings.getByText(copy('admin.bot.automod.loaded'), { exact: true })).toBeVisible({ timeout: 90_000 });
    await expect(enabled).toBeChecked();
    await expect(duplicateAction).toHaveValue('warn');

    // The runtime reconciles saved rule revisions on a one second cadence. Let
    // that activation pass before producing the burst so it cannot be treated
    // as pre-activation journal backlog.
    await targetPage.waitForTimeout(2_200);

    await sendRepeat(targetPage, EXCERPT_BODY);
    await sendRepeat(targetPage, EXCERPT_BODY);
    await sendRepeat(targetPage, EXCERPT_BODY);
    await expect(targetPage.locator('.d-message-row').filter({ hasText: EXCERPT_BODY })).toHaveCount(3);

    const loadCases = settings.getByRole('button', { name: copy('admin.bot.moderationLog.loadAutomatic'), exact: true });
    const automaticCase = settings.locator('article').filter({ hasText: 'duplicate_body' });
    // Each load is a snapshot. If the Bot has not processed the burst yet, request
    // another snapshot instead of waiting for the first response to change.
    await expect(async () => {
      await loadCases.click();
      await expect(automaticCase).toHaveCount(1, { timeout: 5_000 });
    }).toPass({ timeout: 45_000, intervals: [500, 1_000, 2_000] });
    await expect(automaticCase).toContainText('warn');
    const excerpt = await automaticCase.locator('p').nth(1).innerText();
    expect(excerpt.length).toBe(512);
    expect(excerpt).toContain('automod-evidence-');
    expect(excerpt).not.toContain('AUTOMOD_TAIL_SENTINEL');

    // Reloading the durable case feed does not replay the action or duplicate its case.
    await loadCases.click();
    await expect.poll(async () => settings.locator('article').count(), { timeout: 90_000, intervals: [500, 1_000, 2_000] }).toBe(1);
    await expect(targetPage.locator('.d-message-row').filter({ hasText: EXCERPT_BODY })).toHaveCount(3);
  } finally {
    await targetContext?.close();
    await host?.stop();
  }
});

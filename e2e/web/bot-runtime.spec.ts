import { expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  FIREFOX_FAVICON_LINE, addServerVia, completeSignUp, copy, isFirefoxBrowserFaviconViolation, makeInviteLink, messageRow, newAccount,
  openChannel, reactionChip, rowAction, sendText, signIn, signUp, test,
} from './support/app';
import { startTestHost, type HostConfig, type StartedHost } from './support/host';
import { arr, decode } from '../../packages/client-core/src/cbor/index';

const BOT_RUNTIME_PORT = Number(process.env.DILLA_E2E_BOT_RUNTIME_PORT ?? 8491);
const HOST: HostConfig = { port: BOT_RUNTIME_PORT, control: BOT_RUNTIME_PORT + 1, webRoot: 'packages/web/dist', botRuntime: true, advanceClockWithWall: true };
const ROLE_PANEL_PORT = Number(process.env.DILLA_E2E_ROLE_PANEL_PORT ?? HOST.port);
const ROLE_PANEL_HOST: HostConfig = { ...HOST, port: ROLE_PANEL_PORT, control: ROLE_PANEL_PORT + 1, advanceClockWithWall: true };
const SERVER = 'Runtime Bot Acceptance';
const RECOVERY_SERVER = 'Bot Response Recovery';

async function traceCoreWorker(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    const root = window as unknown as { __dillaWorkerTrace?: { calls: unknown[]; returns: unknown[] } };
    root.__dillaWorkerTrace = { calls: [], returns: [] };
    const OriginalWorker = window.Worker;
    window.Worker = new Proxy(OriginalWorker, {
      construct(target, args, newTarget) {
        const worker = Reflect.construct(target, args, newTarget) as Worker;
        const post = worker.postMessage.bind(worker);
        worker.postMessage = (message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) => {
          root.__dillaWorkerTrace?.calls.push(message);
          post(message, transfer as Transferable[]);
        };
        worker.addEventListener('message', event => root.__dillaWorkerTrace?.returns.push(event.data));
        return worker;
      },
    }) as typeof Worker;
  });
}

async function lastWorkerCommandOutcome(page: import('@playwright/test').Page, commandName: string): Promise<{
  requestId: string | null; state: 'waiting' | 'accepted' | 'pending' | 'rejected' | 'unknown' | 'refused'; code: string | null; detail: string | null;
}> {
  return page.evaluate(name => {
    const trace = (window as unknown as { __dillaWorkerTrace?: { calls: unknown[]; returns: unknown[] } }).__dillaWorkerTrace;
    const calls = trace?.calls.map(value => value as { id?: number; command?: { m?: string; requestId?: string } }).reverse() ?? [];
    const call = calls.find(value => value.command?.m === name);
    if (call === undefined) return { requestId: null, state: 'waiting', code: null, detail: null };
    const returned = trace?.returns.map(value => value as { t?: string; id?: number; ok?: boolean; error?: { code?: string; detail?: string }; value?: { status?: string } })
      .find(value => value.t === 'ret' && value.id === call.id);
    if (returned === undefined) return { requestId: call.command?.requestId ?? null, state: 'waiting', code: null, detail: null };
    if (returned.ok === false) {
      const safeCodes = new Set(['E_CORE_STATE', 'E_SYNC_STOPPED', 'E_BAD_INPUT', 'E_FORBIDDEN', 'E_UNAVAILABLE', 'E_INTERNAL']);
      const detailText = returned.error?.detail ?? '';
      const safeDetails: Record<string, string> = {
        'no active interaction group for this community': 'missing_interaction_group',
        'multiple active interaction groups make the Bot target ambiguous': 'ambiguous_interaction_group',
        'unknown community': 'unknown_community',
      };
      return { requestId: call.command?.requestId ?? null, state: 'refused',
        code: safeCodes.has(returned.error?.code ?? '') ? returned.error?.code ?? null : 'other',
        detail: safeDetails[detailText] ?? 'other' };
    }
    const status = returned.value?.status;
    const state = status === 'accepted' || status === 'pending' || status === 'rejected' || status === 'unknown' ? status : 'unknown';
    return { requestId: call.command?.requestId ?? null, state, code: null, detail: null };
  }, commandName);
}

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

test('music chat commands receive public bot replies through the native runtime', async ({ page, instanceName, browser, guard }) => {
  let host: StartedHost | null = null;
  let secondContext: import('@playwright/test').BrowserContext | null = null;
  try {
    host = await startTestHost({ ...HOST, advanceClockWithWall: true });
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
    await settings.getByRole('checkbox', { name: copy('admin.bot.capability.music'), exact: true }).check();
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
    await page.keyboard.press('Escape');
    await openChannel(page, SERVER, 'general');

    const inviteLink = await makeInviteLink(page, SERVER);
    secondContext = await browser.newContext({ baseURL: host.url });
    await guard.attach(secondContext);
    const secondPage = await secondContext.newPage();
    await secondPage.goto(new URL(inviteLink).pathname);
    await secondPage.getByRole('link', { name: 'Open dilla in this browser', exact: true }).click();
    await completeSignUp(secondPage, newAccount('Bea', host.control), instanceName);
    await openChannel(secondPage, SERVER, 'general');
    await openChannel(page, SERVER, 'general');
    await sendText(page, 'general', '/music');
    const help = messageRow(page, 'general', 'Music commands: /play');
    await expect(help).toHaveAttribute('data-state', 'ok');
    await expect(help.locator('[data-kind=bot]')).toHaveText('bot');
    await expect(messageRow(secondPage, 'general', 'Music commands: /play')).toHaveAttribute('data-state', 'ok');
    await sendText(page, 'general', '/play northern lights');
    await expect(messageRow(page, 'general', 'Join a voice channel before using music commands.')).toHaveAttribute('data-state', 'ok');

  } finally {
    await secondContext?.close();
    await host?.stop();
  }
});

test('device 1 recovers its exact encrypted Bot response after Bot and browser restart; device 2 uses its own group', async ({ page, instanceName, relaunch, browser, guard }) => {
  let host: StartedHost | null = null;
  let secondContext: import('@playwright/test').BrowserContext | null = null;
  let secondPage: import('@playwright/test').Page | null = null;
  try {
    await traceCoreWorker(page);
    host = await startTestHost(HOST);
    const owner = await signUp(page, host.invite.split(',')[0] ?? '', instanceName, 'Ada', host.control);
    await addServerVia(page, 'create');
    const create = page.getByRole('dialog', { name: copy('create.server.title'), exact: true });
    await create.getByRole('textbox', { name: copy('create.server.name'), exact: true }).fill(RECOVERY_SERVER);
    await page.keyboard.press('Enter');

    await page.getByRole('button', { name: copy('admin.open'), exact: true }).click();
    let settings = page.getByRole('dialog', { name: copy('admin.title'), exact: true });
    await settings.getByRole('navigation', { name: copy('admin.nav'), exact: true })
      .getByRole('button', { name: copy('admin.nav.bot'), exact: true }).click();
    await settings.getByRole('checkbox', { name: copy('admin.bot.capability.warnings'), exact: true }).check();
    await settings.getByRole('button', { name: copy('admin.bot.enable'), exact: true }).click();
    const stepUp = page.getByRole('dialog', { name: copy('factorSettings.stepUp.title'), exact: true });
    await stepUp.getByLabel(copy('factorSettings.stepUp.password'), { exact: true }).fill(owner.password);
    await stepUp.getByRole('button', { name: copy('factorSettings.stepUp.confirm'), exact: true }).click();
    await expect(settings.getByRole('status')).toHaveText(copy('admin.bot.status.ready'), { timeout: 90_000 });
    // Establish this device's private group before taking its issuer offline.
    await settings.getByRole('button', { name: copy('admin.bot.moderationLog.loadAutomatic'), exact: true }).click();
    await expect(settings.getByText(copy('admin.bot.moderationLog.empty'), { exact: true })).toBeVisible({ timeout: 90_000 });
    await settings.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(settings).toBeHidden();

    // Device 1 submits a real encrypted request while the Bot is offline. The pending response
    // must remain available in this device's native journal after both processes restart.
    await host.stopBotRuntime();
    await page.getByRole('button', { name: copy('admin.open'), exact: true }).click();
    settings = page.getByRole('dialog', { name: copy('admin.title'), exact: true });
    await settings.getByRole('navigation', { name: copy('admin.nav'), exact: true })
      .getByRole('button', { name: copy('admin.nav.bot'), exact: true }).click();
    const loadAutomatic = settings.getByRole('button', { name: copy('admin.bot.moderationLog.loadAutomatic'), exact: true });
    await loadAutomatic.click();
    await expect(settings.getByText(copy('admin.bot.moderationLog.waiting'), { exact: true })).toBeVisible();
    await expect.poll(async () => page.evaluate(() => {
      const trace = (window as unknown as { __dillaWorkerTrace?: { calls: unknown[] } }).__dillaWorkerTrace;
      const call = trace?.calls.map(value => value as { command?: { m?: string; requestId?: string } }).reverse()
        .find(value => value.command?.m === 'listModerationCases');
      return call?.command?.requestId ?? null;
    })).toMatch(/^[0-9a-f]{32}$/u);
    const requestOneId = await page.evaluate(() => {
      const trace = (window as unknown as { __dillaWorkerTrace?: { calls: unknown[] } }).__dillaWorkerTrace;
      const call = trace?.calls.map(value => value as { command?: { m?: string; requestId?: string } }).reverse()
        .find(value => value.command?.m === 'listModerationCases');
      return call?.command?.requestId ?? null;
    });
    expect(requestOneId).toMatch(/^[0-9a-f]{32}$/u);

    const reopened = await relaunch();
    let deviceOne = reopened.page;
    await traceCoreWorker(deviceOne);
    await deviceOne.goto(host.url);
    await expect(deviceOne.getByRole('navigation', { name: copy('shell.rail.label'), exact: true })
      .getByRole('button', { name: RECOVERY_SERVER, exact: true })).toBeVisible({ timeout: 90_000 });
    await host.startBotRuntimeNow();
    await deviceOne.getByRole('button', { name: copy('admin.open'), exact: true }).click();
    settings = deviceOne.getByRole('dialog', { name: copy('admin.title'), exact: true });
    await settings.getByRole('navigation', { name: copy('admin.nav'), exact: true })
      .getByRole('button', { name: copy('admin.nav.bot'), exact: true }).click();
    await settings.getByRole('button', { name: copy('admin.bot.moderationLog.loadAutomatic'), exact: true }).click();
    await expect(settings.getByText(copy('admin.bot.moderationLog.empty'), { exact: true })).toBeVisible({ timeout: 90_000 });
    await expect.poll(async () => deviceOne.evaluate(requestId => {
      const trace = (window as unknown as { __dillaWorkerTrace?: { returns: unknown[] } }).__dillaWorkerTrace;
      return trace?.returns.some(value => {
        const result = value as { t?: string; value?: { responses?: { requestId?: string }[] } };
        return result.t === 'ret' && result.value?.responses?.some(response => response.requestId === requestId) === true;
      }) ?? false;
    }, requestOneId), { timeout: 90_000, intervals: [500, 1_000, 2_000] }).toBe(true);

    // Device 2 enrolls from the same recovery key, gets its own per-device interaction group,
    // and proves that its own encrypted Bot request/response path is usable. This is not a claim
    // that device 2 receives device 1's request ID or response group.
    secondContext = await browser.newContext({ baseURL: host.url });
    await guard.attach(secondContext);
    secondPage = await secondContext.newPage();
    await traceCoreWorker(secondPage);
    await signIn(secondPage, owner, instanceName);
    await expect(secondPage.getByRole('navigation', { name: copy('shell.rail.label'), exact: true })
      .getByRole('button', { name: RECOVERY_SERVER, exact: true })).toBeVisible({ timeout: 90_000 });
    await secondPage.getByRole('button', { name: copy('admin.open'), exact: true }).click();
    const secondSettings = secondPage.getByRole('dialog', { name: copy('admin.title'), exact: true });
    await secondSettings.getByRole('navigation', { name: copy('admin.nav'), exact: true })
      .getByRole('button', { name: copy('admin.nav.bot'), exact: true }).click();
    await secondSettings.getByRole('button', { name: copy('admin.bot.moderationLog.loadAutomatic'), exact: true }).click();
    await expect.poll(() => lastWorkerCommandOutcome(secondPage!, 'listModerationCases'),
      { timeout: 20_000, intervals: [250, 500, 1_000] }).toEqual({
      requestId: expect.stringMatching(/^[0-9a-f]{32}$/u), state: 'accepted', code: null, detail: null,
    });
    const secondRequestId = (await lastWorkerCommandOutcome(secondPage, 'listModerationCases')).requestId;
    expect(secondRequestId).toMatch(/^[0-9a-f]{32}$/u);
    expect(secondRequestId).not.toBe(requestOneId);
    await expect.poll(async () => secondPage!.evaluate(requestId => {
      const trace = (window as unknown as { __dillaWorkerTrace?: { returns: unknown[] } }).__dillaWorkerTrace;
      return trace?.returns.some(value => {
        const result = value as { t?: string; value?: { responses?: { requestId?: string }[] } };
        return result.t === 'ret' && result.value?.responses?.some(response => response.requestId === requestId) === true;
      }) ?? false;
    }, secondRequestId), { timeout: 90_000, intervals: [500, 1_000, 2_000] }).toBe(true);
  } finally {
    await secondContext?.close();
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
    await expect(reactionChip(secondPanel, copy('shell.emoji.01'), 1)).toHaveCount(0);
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

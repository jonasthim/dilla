import { expect, type BrowserContext, type Page } from '@playwright/test';
import type { Locator } from '@playwright/test';
import {
  addServerVia, attachInput, channelRow, composerBox, completeSignUp, copy, logRegion, makeInviteLink, messageRow, newAccount, openChannel,
  rowAction, rowToolbar, sendText, signIn, signUp, trayEntries,
} from './support/app';
import { startTestHost, type HostConfig, type StartedHost } from './support/host';
import { test } from './support/second';
import { installWorkerPort, portCall } from './support/worker-port';
import { connected, dock, joinVoice, voiceRow } from '../voice/support/voice';
import { leaveIfInCall } from '../voice/support/peer-browser';

const PORT = Number(process.env.DILLA_E2E_SLASH_PORT ?? 8581);
const HOST: HostConfig = { port: PORT, control: PORT + 1, webRoot: 'packages/web/dist', botRuntime: true, advanceClockWithWall: true };
const COMMUNITY = 'Slash command acceptance';
const GENERAL = 'general';
const WAIT = process.env.CI === 'true' ? 90_000 : 30_000;
const ACTION_TIMEOUT = process.env.CI === 'true' ? 90_000 : 30_000;
// Utility actions cross several authenticated Bot round trips even on a fast local browser.
const BOT_WAIT = 90_000;
const BASIC_HOST: HostConfig = { port: PORT, control: PORT + 1, webRoot: 'packages/web/dist' };
const SFU_PORT = Number(process.env.DILLA_E2E_SLASH_SFU_PORT ?? PORT + 3);
const VOICE_HOST: HostConfig = { ...HOST, sfu: { port: SFU_PORT, udpPort: SFU_PORT + 2, departureTimeout: 90 } };

test.use({ baseURL: `http://127.0.0.1:${String(PORT)}` });
test.use({ actionTimeout: ACTION_TIMEOUT });
test.describe.configure({ timeout: 360_000 });

async function createCommunity(page: Page): Promise<void> {
  await addServerVia(page, 'create');
  const dialog = page.getByRole('dialog', { name: copy('create.server.title'), exact: true });
  await dialog.getByRole('textbox', { name: copy('create.server.name'), exact: true }).fill(COMMUNITY);
  await page.keyboard.press('Enter');
  await openChannel(page, COMMUNITY, GENERAL);
}

/** Enable the built-in Bot through the shipped settings, then wait for the native daemon to install it. */
async function enableBot(page: Page, password: string, capabilities: string[] = []): Promise<void> {
  await page.getByRole('button', { name: copy('admin.open'), exact: true }).click();
  const settings = page.getByRole('dialog', { name: copy('admin.title'), exact: true });
  const nav = settings.getByRole('navigation', { name: copy('admin.nav'), exact: true });
  await expect(nav).toBeVisible({ timeout: WAIT });
  await nav.getByRole('button', { name: copy('admin.nav.bot'), exact: true }).click();
  for (const capability of capabilities) {
    await settings.getByRole('checkbox', { name: copy(`admin.bot.capability.${capability}`), exact: true }).check();
  }
  await settings.getByRole('button', { name: copy('admin.bot.enable'), exact: true }).click();
  const stepUp = page.getByRole('dialog', { name: copy('factorSettings.stepUp.title'), exact: true });
  await stepUp.getByLabel(copy('factorSettings.stepUp.password'), { exact: true }).fill(password);
  await stepUp.getByRole('button', { name: copy('factorSettings.stepUp.confirm'), exact: true }).click();
  await expect(settings.locator('.dw-bot-settings').getByRole('status').filter({ hasText: copy('admin.bot.status.ready') }))
    .toHaveText(copy('admin.bot.status.ready'), { timeout: 90_000 });
  await settings.getByRole('button', { name: copy('settings.close'), exact: true }).click();
  await expect(settings).toBeHidden();
}

async function disableBot(page: Page): Promise<void> {
  await page.getByRole('button', { name: copy('admin.open'), exact: true }).click();
  const settings = page.getByRole('dialog', { name: copy('admin.title'), exact: true });
  const nav = settings.getByRole('navigation', { name: copy('admin.nav'), exact: true });
  await expect(nav).toBeVisible({ timeout: WAIT });
  await nav.getByRole('button', { name: copy('admin.nav.bot'), exact: true }).click();
  await settings.getByRole('button', { name: 'Disable bot', exact: true }).click();
  await expect(settings.getByRole('button', { name: 'Enable bot', exact: true })).toBeVisible({ timeout: WAIT });
  await settings.getByRole('button', { name: copy('settings.close'), exact: true }).click();
  await expect(settings).toBeHidden();
}

async function joinAs(page: Page, host: StartedHost, inviteLink: string, instance: string, display: string) {
  const account = newAccount(display, host.control);
  await page.goto(new URL(inviteLink).pathname);
  await page.getByRole('link', { name: 'Open dilla in this browser', exact: true }).click();
  await completeSignUp(page, account, instance);
  await openChannel(page, COMMUNITY, GENERAL);
  return account;
}

async function invoke(box: ReturnType<typeof composerBox>, page: Page, command: string): Promise<void> {
  await box.fill(command.startsWith('/') ? command : `/${command}`);
  const region = page.getByRole('region', { name: 'Command composer', exact: true });
  await expect(region).toBeVisible({ timeout: WAIT });
  await region.getByRole('button', { name: 'Run command', exact: true }).click();
}

async function chooseCommand(box: ReturnType<typeof composerBox>, page: Page, command: string): Promise<Locator> {
  await box.fill('/');
  const region = page.getByRole('region', { name: 'Command composer', exact: true });
  const picker = region.getByRole('combobox', { name: 'Command', exact: true });
  await picker.fill(command);
  await expect(region.getByRole('option', { name: new RegExp(`/${command}(?:\\s|$)`) })).toBeVisible({ timeout: WAIT });
  await picker.press('ArrowDown');
  await picker.press('Enter');
  return region;
}

async function traceCoreWorker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const root = window as unknown as { __slashWorkerTrace?: { calls: unknown[]; returns: unknown[]; events: unknown[] } };
    root.__slashWorkerTrace = { calls: [], returns: [], events: [] };
    const OriginalWorker = window.Worker;
    window.Worker = new Proxy(OriginalWorker, {
      construct(target, args, newTarget) {
        const worker = Reflect.construct(target, args, newTarget) as Worker;
        const post = worker.postMessage.bind(worker);
        worker.postMessage = (message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) => {
          root.__slashWorkerTrace?.calls.push(message);
          root.__slashWorkerTrace?.events.push({ direction: 'call', at: Date.now(), message });
          post(message, transfer as Transferable[]);
        };
        worker.addEventListener('message', event => {
          root.__slashWorkerTrace?.returns.push(event.data);
          root.__slashWorkerTrace?.events.push({ direction: 'return', at: Date.now(), message: event.data });
        });
        return worker;
      },
    }) as typeof Worker;
  });
}

async function moderationFailureEvidence(page: Page, member: Page): Promise<unknown> {
  const [composerSnapshot, rosterSnapshot, workerEvents] = await Promise.all([
    page.getByRole('region', { name: 'Command composer', exact: true }).ariaSnapshot().catch(() => ''),
    page.getByRole('complementary', { name: /members/u }).ariaSnapshot().catch(() => ''),
    page.evaluate(() => {
      const trace = (window as unknown as { __slashWorkerTrace?: { events: { direction?: string; at?: number; message?: unknown }[] } }).__slashWorkerTrace;
      return trace?.events.filter(event => /community|member|role|permission|account|botcommandstatus/iu.test(JSON.stringify(event.message)))
        .slice(-120).map(event => ({ direction: event.direction, at: event.at, message: event.message })) ?? [];
    }),
  ]);
  return {
    composerSnapshot,
    ownerRosterSnapshot: rosterSnapshot,
    memberCommunityButtonCount: await member.getByRole('navigation', { name: copy('shell.rail.label'), exact: true })
      .getByRole('button', { name: COMMUNITY, exact: true }).count().catch(() => -1),
    workerEvents,
  };
}

async function pollFailureEvidence(page: Page, question: string): Promise<unknown> {
  return page.evaluate(text => {
    const root = window as unknown as {
      __slashWorkerTrace?: { calls: unknown[]; returns: unknown[] };
      __slashPollObserver?: { targets: Element[]; transitions: { target: Element; intersecting: boolean }[] };
    };
    const trace = root.__slashWorkerTrace;
    const calls = (trace?.calls ?? []).map(value => value as {
      t?: string; id?: number; command?: { m?: string; operation?: number; requestId?: string; communityId?: string; channelId?: string; [key: string]: unknown };
    });
    const relevantCalls = calls.filter(call => {
      const name = call.command?.m ?? '';
      const operation = call.command?.operation;
      return operation === 70 || operation === 71
        || operation !== undefined && operation >= 72 && operation <= 75
        || /capabilit|channel|community|interaction/i.test(name);
    }).map(call => ({ id: call.id, name: call.command?.m, operation: call.command?.operation,
      requestId: call.command?.requestId, communityId: call.command?.communityId, channelId: call.command?.channelId,
      command: call.command }));
    const trackedRequestIds = new Set(calls.filter(call => call.command?.m === 'humanInteractionRequest'
      && (call.command.operation === 3 || call.command.operation !== undefined && call.command.operation >= 70 && call.command.operation <= 75))
      .map(call => call.command?.requestId).filter((id): id is string => typeof id === 'string'));
    const pollReadCalls = calls.filter(call => call.command?.m === 'readBotInteractionResponses'
      && Array.isArray(call.command.requestIds) && call.command.requestIds.some(id => trackedRequestIds.has(String(id)))).slice(-300);
    const readIds = new Set(pollReadCalls.map(call => call.id));
    const workerReturns = (trace?.returns ?? []).map(value => value as {
      t?: string; id?: number; ok?: boolean; value?: { upload?: string; responses?: { requestId?: string; operation?: number; status?: number; data?: Uint8Array; revision?: string }[]; through?: string; blocked?: boolean };
      error?: unknown;
    });
    const interactionReturns = workerReturns.filter(value => value.id !== undefined
      && calls.some(call => call.id === value.id && call.command?.m === 'humanInteractionRequest'
        && (call.command.operation === 3 || call.command.operation !== undefined && call.command.operation >= 70 && call.command.operation <= 75)));
    const pollReadReturns = workerReturns.filter(value => value.id !== undefined && readIds.has(value.id)).map(value => ({
      id: value.id, ok: value.ok, error: value.error, through: value.value?.through, blocked: value.value?.blocked,
      responses: value.value?.responses?.filter(row => trackedRequestIds.has(row.requestId ?? '')).map(row => ({
        requestId: row.requestId, operation: row.operation, status: row.status, revision: row.revision,
        data: row.data instanceof Uint8Array ? Array.from(row.data) : null,
      })) ?? [],
    }));
    const statusCalls = calls.filter(call => call.command?.m === 'getBotCommandStatus').slice(-100);
    const statusReturns = workerReturns.filter(value => value.id !== undefined && statusCalls.some(call => call.id === value.id));
    const textMessages = [...document.querySelectorAll('[data-message-id], article')]
      .filter(element => element.textContent?.includes(text)).slice(-10).map(element => (element as HTMLElement).outerHTML.slice(0, 16_000));
    const observed = root.__slashPollObserver;
    return {
      matchingPollCards: [...document.querySelectorAll('.dw-poll-card')].map(element => (element as HTMLElement).outerHTML),
      matchingQuestionMessages: textMessages,
      observerTargets: observed?.targets.map(target => ({ html: (target as HTMLElement).outerHTML, containsQuestion: target.textContent?.includes(text) })) ?? [],
      observerTransitions: observed?.transitions.map(entry => ({ containsQuestion: entry.target.textContent?.includes(text), intersecting: entry.intersecting })) ?? [],
      interactionCalls: relevantCalls.filter(call => call.operation === 3 || call.operation === 71), interactionReturns, statusReturns,
      pollReadCalls: pollReadCalls.map(call => ({ id: call.id, command: call.command })), pollReadReturns,
      accountChannelAndCapabilityCalls: relevantCalls.filter(call => call.operation !== 71),
    };
  }, question);
}

async function currentBotIdentity(page: Page, communityId: string): Promise<{ installationId: string; botUserId: string }> {
  const response = await portCall(page, { m: 'getBotCommandStatus', communityId });
  expect(response.ok).toBe(true);
  expect(response.value).toMatchObject({ state: 3,
    installationId: expect.stringMatching(/^[0-9a-f]{32}$/u), botUserId: expect.stringMatching(/^[0-9a-f]{32}$/u) });
  const status = response.value as { installationId: string; botUserId: string };
  return { installationId: status.installationId, botUserId: status.botUserId };
}

async function lastReminderRequestId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const trace = (window as unknown as { __slashWorkerTrace?: { calls: unknown[] } }).__slashWorkerTrace;
    const request = trace?.calls.map(value => value as { t?: string; command?: { m?: string; operation?: number; requestId?: string } }).reverse()
      .find(value => value.t === 'call' && value.command?.m === 'humanInteractionRequest' && value.command.operation === 80);
    return request?.command?.requestId ?? null;
  });
}

async function reminderReceipt(page: Page, requestId: string): Promise<{ communityId: string; status: number; data: number[] } | null> {
  return page.evaluate(id => {
    const trace = (window as unknown as { __slashWorkerTrace?: { calls: unknown[]; returns: unknown[] } }).__slashWorkerTrace;
    const calls = trace?.calls.map(value => value as { t?: string; id?: number; command?: {
      m?: string; operation?: number; requestId?: string; requestIds?: string[]; through?: string; communityId?: string;
    } }) ?? [];
    const request = calls.find(value => value.t === 'call' && value.command?.m === 'humanInteractionRequest'
      && value.command.operation === 80 && value.command.requestId === id);
    if (request?.id === undefined) throw new Error(`worker trace has no reminder request ${id}`);
    const requestReturn = trace?.returns.map(value => value as { t?: string; id?: number; ok?: boolean; value?: { requestId?: string; upload?: string } })
      .find(value => value.t === 'ret' && value.id === request.id);
    if (requestReturn?.ok !== true || requestReturn.value?.requestId !== id || requestReturn.value.upload !== 'accepted') {
      throw new Error(`worker did not confirm reminder upload ${id}`);
    }
    const reads = calls.filter(value => value.t === 'call' && value.command?.m === 'readBotInteractionResponses'
      && (value.command.requestIds as string[] | undefined)?.includes(id));
    const returns = trace?.returns.map(value => value as { t?: string; id?: number; ok?: boolean; value?: {
      responses?: { requestId?: string; operation?: number; status?: number; data?: Uint8Array }[]; through?: string | null;
    } }) ?? [];
    let receipt: { status: number; data: Uint8Array; through: string } | null = null;
    for (const read of reads.slice().reverse()) {
      const returned = returns.find(value => value.t === 'ret' && value.id === read.id);
      const row = returned?.value?.responses?.find(value => value.requestId === id && value.operation === 80);
      const through = returned?.value?.through;
      if (returned?.ok !== true || row?.status !== 0 || !(row.data instanceof Uint8Array) || through == null) continue;
      const ack = calls.find(value => value.t === 'call' && value.command?.m === 'ackBotInteractionResponses'
        && value.command.through === through);
      const acked = trace?.returns.map(value => value as { t?: string; id?: number; ok?: boolean })
        .some(value => value.t === 'ret' && value.id === ack?.id && value.ok === true) ?? false;
      if (acked) { receipt = { status: row.status, data: row.data, through }; break; }
    }
    // The worker's first read can be empty while the daemon is still producing the response.
    // Returning null lets expect.poll observe the later successful read/ACK pair.
    if (receipt === null) return null;
    const communityId = request.command?.communityId;
    if (communityId === undefined) throw new Error(`worker trace has no community for reminder request ${id}`);
    return { communityId, status: receipt.status, data: Array.from(receipt.data) };
  }, requestId);
}

async function runKickFromPicker(page: Page, box: ReturnType<typeof composerBox>, member: Page): Promise<Locator> {
  const region = await chooseCommand(box, page, 'kick');
  const user = region.getByRole('combobox', { name: 'user', exact: true });
  await user.fill('Bea');
  const memberOption = region.getByRole('option', { name: 'Bea', exact: true });
  try { await expect(memberOption).toBeVisible({ timeout: WAIT }); }
  catch (error) {
    await test.info().attach('slash-moderation.json', {
      body: Buffer.from(JSON.stringify(await moderationFailureEvidence(page, member), null, 2)), contentType: 'application/json',
    });
    throw error;
  }
  await user.press('ArrowDown');
  await user.press('Enter');
  await region.getByRole('button', { name: 'Run command', exact: true }).click();
  return region;
}

async function leaveCommandMode(page: Page): Promise<void> {
  const region = page.getByRole('region', { name: 'Command composer', exact: true });
  if (await region.count() > 0 && await region.isVisible()) await region.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(region).toHaveCount(0, { timeout: WAIT });
}

async function stopAppBeforeHost(page: Page, host: StartedHost | null): Promise<void> {
  // Cancel the shipping app's background sync before its local server disappears; WebKit reports
  // an in-flight refresh as a console error if the host is stopped while the app stays open.
  await page.goto('about:blank').catch(() => undefined);
  await host?.stop();
}

async function openPollDialog(page: Page, box: Locator, question: string, answers = 'Soup, Salad'): Promise<void> {
  await invoke(box, page, `/poll create question:"${question}" answers:"${answers}" multiple:on`);
  const dialog = page.getByRole('dialog', { name: 'Create a poll', exact: true });
  await expect(dialog).toBeVisible({ timeout: BOT_WAIT });
  await expect(dialog.getByRole('textbox', { name: 'Question', exact: true })).toHaveValue(question);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: BOT_WAIT });
  await leaveCommandMode(page);
}

async function pollOption(card: Locator, answer: string): Promise<Locator> {
  // Shipping labels include the live vote count in the checkbox's accessible name (for
  // example, "Soup 0"). Match the exact answer plus its numeric count.
  const option = card.getByRole('checkbox', { name: new RegExp(`^${answer}\\s+\\d+$`, 'u') });
  await expect(option).toHaveCount(1, { timeout: WAIT });
  return option;
}

test('composer keeps private results private, publishes only explicit text, and retains separate channel/thread drafts', async ({ page, instanceName }) => {
  let host: StartedHost | null = null;
  try {
    host = await startTestHost(BASIC_HOST);
    await signUp(page, host.invite.split(',')[0] ?? '', instanceName, 'Ada', host.control);
    await createCommunity(page);
    const rootText = `thread root ${Date.now()}`;
    const box = composerBox(page, GENERAL);
    await box.fill(rootText);
    await box.press('Enter');
    const root = messageRow(page, GENERAL, rootText);
    await expect(root).toHaveAttribute('data-state', 'ok', { timeout: WAIT });

    const composer = await chooseCommand(box, page, 'help');
    await composer.getByRole('button', { name: 'Run command', exact: true }).click();
    await expect(composer.getByRole('status')).toContainText('/help');
    await expect(logRegion(page, GENERAL)).not.toContainText('/help');
    await expect(page.locator('[data-kind="bot"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(composer).toHaveCount(0, { timeout: WAIT });

    const shrug = await chooseCommand(box, page, 'shrug');
    await shrug.getByRole('button', { name: 'Add optional text', exact: true }).click();
    await shrug.getByLabel('text', { exact: true }).fill('made by the command');
    await shrug.getByRole('button', { name: 'Run command', exact: true }).click();
    await expect(messageRow(page, GENERAL, '¯\\_(ツ)_/¯ made by the command')).toHaveAttribute('data-state', 'ok', { timeout: WAIT });
    await leaveCommandMode(page);

    const literal = `/${'made-up'} exact ${Date.now()}`;
    await box.fill(`/${literal.slice(1)}`);
    await expect(messageRow(page, GENERAL, literal)).toHaveCount(0);
    await page.getByRole('button', { name: 'Send as text', exact: true }).click();
    await expect(messageRow(page, GENERAL, literal)).toHaveAttribute('data-state', 'ok', { timeout: WAIT });
    const escaped = `//exact slash ${Date.now()}`;
    await box.fill(escaped);
    await page.getByRole('button', { name: 'Send as text', exact: true }).click();
    await expect(messageRow(page, GENERAL, '/exact slash ' + escaped.split(' ').at(-1))).toHaveAttribute('data-state', 'ok', { timeout: WAIT });

    await rowAction(root, 'reply');
    const replyChip = page.locator('.d-reply-chip');
    await expect(replyChip).toContainText(rootText, { timeout: WAIT });
    await attachInput(page).setInputFiles({ name: 'preserved.txt', mimeType: 'text/plain', buffer: Buffer.from('keep this attachment') });
    const tray = trayEntries(page);
    await expect(tray).toHaveCount(1, { timeout: WAIT });
    await expect(tray.first()).toHaveAttribute('data-phase', 'ready', { timeout: WAIT });
    await expect(tray.first()).toContainText('preserved.txt');
    await chooseCommand(box, page, 'help');
    await leaveCommandMode(page);
    await expect(replyChip).toContainText(rootText);
    await expect(tray).toHaveCount(1);
    await expect(tray.first()).toHaveAttribute('data-phase', 'ready');
    await tray.getByRole('button', { name: copy('shell.tray.remove', { name: 'preserved.txt' }), exact: true }).click();
    await expect(tray).toHaveCount(0, { timeout: WAIT });
    await replyChip.getByRole('button', { name: copy('shell.composer.replyCancel'), exact: true }).click();
    await expect(replyChip).toHaveCount(0);

    await box.fill('/shrug text:"main draft stays here"');
    const mainDraft = page.getByRole('main').getByRole('region', { name: 'Command composer', exact: true })
      .getByRole('combobox', { name: 'text', exact: true });
    await expect(mainDraft).toHaveValue('main draft stays here');
    const threadButton = rowToolbar(root).getByRole('button', { name: copy('thread.open'), exact: true });
    await root.focus();
    await threadButton.click();
    const thread = page.getByRole('complementary', { name: copy('thread.title'), exact: true });
    await expect(thread).toBeVisible({ timeout: WAIT });
    const threadBox = thread.getByRole('textbox', { name: copy('thread.composer'), exact: true });
    await threadBox.fill('/shrug text:"thread draft stays here"');
    const threadDraft = thread.getByRole('region', { name: 'Command composer', exact: true })
      .getByRole('combobox', { name: 'text', exact: true });
    await expect(threadDraft).toHaveValue('thread draft stays here');
    await thread.getByRole('button', { name: copy('thread.close'), exact: true }).click();
    await expect(mainDraft).toHaveValue('main draft stays here');
  } finally { await stopAppBeforeHost(page, host); }
});

test('polls publish in channels and threads, accept real votes, reject forged markers, and close by the creator', async ({ page, second: secondBrowser, instanceName }, testInfo) => {
  test.setTimeout(600_000); // Aggregate budget for serial authenticated create/vote/voter/close/re-enable round trips.
  let host: StartedHost | null = null;
  let secondContext: BrowserContext | null = null;
  try {
    host = await startTestHost(HOST);
    await installWorkerPort(page.context());
    await traceCoreWorker(page);
    await page.addInitScript(() => {
      const observed = { targets: [] as Element[], transitions: [] as { target: Element; intersecting: boolean }[], outTarget: null as Element | null };
      (window as unknown as { __slashPollObserver?: typeof observed }).__slashPollObserver = observed;
      const NativeObserver = window.IntersectionObserver;
      window.IntersectionObserver = new Proxy(NativeObserver, {
        construct(Target, args) {
          const callback = args[0] as IntersectionObserverCallback;
          const observer = new Target((entries, instance) => {
            for (const entry of entries) observed.transitions.push({ target: entry.target, intersecting: entry.isIntersecting });
            callback(entries, instance);
          }, args[1]);
          const nativeObserve = observer.observe.bind(observer);
          observer.observe = (target: Element) => { observed.targets.push(target); nativeObserve(target); };
          return observer;
        },
      }) as typeof IntersectionObserver;
    });
    const owner = await signUp(page, host.invite.split(',')[0] ?? '', instanceName, 'Ada', host.control);
    await createCommunity(page);
    await enableBot(page, owner.password, ['roles']);
    const invite = await makeInviteLink(page, COMMUNITY);
    const joined = await secondBrowser.open();
    secondContext = joined.context;
    const member = joined.page;
    await traceCoreWorker(member);
    const bea = await joinAs(member, host, invite, instanceName, 'Bea');
    expect(bea.username).not.toBe(owner.username);
    await openChannel(page, COMMUNITY, GENERAL);
    await openChannel(member, COMMUNITY, GENERAL);

    const forged = `[dilla-poll:v1:${'a'.repeat(32)}]`;
    await sendText(member, GENERAL, forged);
    await expect(logRegion(member, GENERAL).locator('.dw-poll-card')).toHaveCount(0);
    for (let index = 0; index < 8; index++) await sendText(page, GENERAL, `observer scroll filler ${index} ${Date.now()}`);

    const question = `Channel poll ${Date.now()}?`;
    await openPollDialog(page, composerBox(page, GENERAL), question);
    const card = logRegion(page, GENERAL).locator('.dw-poll-card').filter({ hasText: question });
    try {
      await expect(card).toBeVisible({ timeout: BOT_WAIT });
    } catch (error) {
      await testInfo.attach('slash-poll-hydration.json', {
        body: Buffer.from(JSON.stringify(await pollFailureEvidence(page, question), null, 2)), contentType: 'application/json',
      });
      throw error;
    }
    const observerTarget = await card.evaluateHandle(element => {
      const observer = (window as unknown as { __slashPollObserver?: { targets: Element[] } }).__slashPollObserver;
      return observer?.targets.find(target => target === element || target.contains(element)) ?? null;
    });
    expect(await observerTarget.evaluate(target => target !== null), 'the real IntersectionObserver observes the loaded card or its stable wrapper').toBe(true);
    const memberCard = logRegion(member, GENERAL).locator('.dw-poll-card').filter({ hasText: question });
    await expect(memberCard).toBeVisible({ timeout: BOT_WAIT });
    const scrollContainer = await card.evaluateHandle(element => {
      let node = element.parentElement;
      while (node !== null && node.scrollHeight <= node.clientHeight + 1) node = node.parentElement;
      return node;
    });
    expect(await scrollContainer.evaluate(node => node !== null), 'the conversation log provides a real scroll container').toBe(true);
    await observerTarget.evaluate(target => {
      (window as unknown as { __slashPollObserver?: { outTarget: Element | null } }).__slashPollObserver!.outTarget = target;
    });
    await scrollContainer.evaluate(node => { if (node !== null) node.scrollTop = 0; });
    await expect.poll(() => observerTarget.evaluate(target => {
      const observer = (window as unknown as { __slashPollObserver?: { transitions: { target: Element; intersecting: boolean }[] } }).__slashPollObserver;
      return observer?.transitions.some(entry => entry.target === target && !entry.intersecting) ?? false;
    }), { timeout: WAIT, message: 'the browser IntersectionObserver must report the loaded card leaving view' }).toBe(true);
    await scrollContainer.evaluate(node => { if (node !== null) node.scrollTop = node.scrollHeight; });
    await expect(card).toBeVisible({ timeout: BOT_WAIT });
    await expect.poll(() => card.evaluate(element => {
      const observer = (window as unknown as { __slashPollObserver?: {
        targets: Element[]; transitions: { target: Element; intersecting: boolean }[]; outTarget: Element | null;
      } }).__slashPollObserver;
      const reattachedTarget = observer?.targets.slice().reverse().find(target => target === element || target.contains(element));
      const leftAt = observer?.transitions.findIndex(entry => entry.target === observer.outTarget && !entry.intersecting) ?? -1;
      return reattachedTarget !== undefined && leftAt >= 0 && observer!.transitions.slice(leftAt + 1)
        .some(entry => entry.target === reattachedTarget && entry.intersecting);
    }), { timeout: WAIT, message: 'the browser IntersectionObserver must reactivate the card on return' }).toBe(true);
    await (await pollOption(memberCard, 'Soup')).check();
    await memberCard.getByRole('button', { name: 'Submit vote', exact: true }).click();
    const soupResults = memberCard.getByRole('button', { name: /1 · Soup/ });
    await expect(soupResults).toBeVisible({ timeout: BOT_WAIT });
    await soupResults.click();
    try { await expect(memberCard).toContainText('Bea', { timeout: BOT_WAIT }); }
    catch (error) {
      const evidence = { card: await memberCard.evaluate(element => (element as HTMLElement).outerHTML), worker: await pollFailureEvidence(member, question) };
      await testInfo.attach('slash-poll-voters.json', { body: Buffer.from(JSON.stringify(evidence, null, 2)), contentType: 'application/json' });
      throw error;
    }
    await (await pollOption(memberCard, 'Soup')).uncheck();
    await (await pollOption(memberCard, 'Salad')).check();
    const submitChangedVote = memberCard.getByRole('button', { name: 'Submit vote', exact: true });
    await expect(submitChangedVote).toBeEnabled({ timeout: BOT_WAIT });
    await submitChangedVote.click();
    await expect(memberCard.getByRole('button', { name: /1 · Salad/ })).toBeVisible({ timeout: BOT_WAIT });
    await expect(memberCard).toContainText('Bea', { timeout: BOT_WAIT });
    await memberCard.getByRole('button', { name: 'Withdraw vote', exact: true }).click();
    await expect(memberCard.getByRole('button', { name: /1 · Salad/ })).toHaveCount(0, { timeout: BOT_WAIT });

    const rootText = `Poll thread ${Date.now()}`;
    await sendText(page, GENERAL, rootText);
    const root = messageRow(page, GENERAL, rootText);
    await root.focus();
    await rowToolbar(root).getByRole('button', { name: copy('thread.open'), exact: true }).click();
    const thread = page.getByRole('complementary', { name: copy('thread.title'), exact: true });
    await expect(thread).toBeVisible({ timeout: WAIT });
    const threadQuestion = `Thread poll ${Date.now()}?`;
    await openPollDialog(page, thread.getByRole('textbox', { name: copy('thread.composer'), exact: true }), threadQuestion);
    const threadCard = thread.locator('.dw-poll-card').filter({ hasText: threadQuestion });
    await expect(threadCard).toBeVisible({ timeout: BOT_WAIT });
    await expect(logRegion(page, GENERAL).locator('.dw-poll-card').filter({ hasText: threadQuestion })).toHaveCount(0);

    await thread.getByRole('button', { name: copy('thread.close'), exact: true }).click();
    await card.getByRole('button', { name: 'Close poll', exact: true }).click();
    await expect(card).toContainText('Poll closed', { timeout: BOT_WAIT });
    const communityId = await page.evaluate(() => {
      const trace = (window as unknown as { __slashWorkerTrace?: { calls: unknown[] } }).__slashWorkerTrace;
      const request = trace?.calls.map(value => value as { command?: { m?: string; operation?: number; communityId?: string } })
        .find(value => value.command?.m === 'humanInteractionRequest' && value.command.operation === 70);
      return request?.command?.communityId;
    });
    expect(communityId).toMatch(/^[0-9a-f]{32}$/u);
    const beforeDisable = await currentBotIdentity(page, communityId!);
    await disableBot(page);
    await expect(card).toHaveCount(0, { timeout: WAIT });
    await enableBot(page, owner.password, ['roles']);
    const afterEnable = await currentBotIdentity(page, communityId!);
    await testInfo.attach('slash-poll-installation-identity.json', {
      body: Buffer.from(JSON.stringify({ beforeDisable, afterEnable }, null, 2)), contentType: 'application/json',
    });
    if (afterEnable.installationId === beforeDisable.installationId && afterEnable.botUserId === beforeDisable.botUserId) {
      // Re-enabling the same authenticated installation keeps this closed backing poll valid.
      await expect(card).toBeVisible({ timeout: BOT_WAIT });
      await expect(card).toContainText('Poll closed', { timeout: BOT_WAIT });
    } else {
      await expect(card).toHaveCount(0, { timeout: BOT_WAIT });
    }
  } finally {
    try { await secondContext?.close(); }
    finally { await stopAppBeforeHost(page, host); }
  }
});

test('music snapshot and clear use the current SFU voice call and report privately', async ({ page, instanceName }) => {
  let host: StartedHost | null = null;
  try {
    host = await startTestHost(VOICE_HOST);
    const owner = await signUp(page, host.invite.split(',')[0] ?? '', instanceName, 'Ada', host.control);
    await createCommunity(page);
    await enableBot(page, owner.password, ['music']);
    await joinVoice(page, COMMUNITY, GENERAL);
    await connected(page);
    // Keep the live voice session while returning to the text channel that hosts the command composer.
    await channelRow(page, GENERAL).click();
    await expect(composerBox(page, GENERAL)).toBeVisible({ timeout: WAIT });
    // The stage and its data-call-phase are unmounted on the text route; assert the still-connected
    // SFU session through the persistent dock and voice-channel roster instead.
    await expect(dock(page).locator('.d-voice-dock')).toHaveAttribute('data-phase', 'connected', { timeout: WAIT });
    await expect(voiceRow(page, GENERAL)).toContainText('connected', { timeout: WAIT });
    await expect(page.getByRole('toolbar', { name: 'voice controls', exact: true })).toBeVisible({ timeout: WAIT });
    const box = composerBox(page, GENERAL);
    await invoke(box, page, '/queue');
    await expect(page.getByRole('region', { name: 'Command composer', exact: true }).getByRole('status'))
      .toContainText(/music queue is empty/i, { timeout: BOT_WAIT });
    await expect(page.locator('[data-kind="bot"]')).toHaveCount(0);
    await leaveCommandMode(page);
    await invoke(box, page, '/queue clear');
    await expect(page.getByRole('region', { name: 'Command composer', exact: true }).getByRole('status'))
      .toContainText('Music queue cleared.', { timeout: BOT_WAIT });
    await expect(page.locator('[data-kind="bot"]')).toHaveCount(0);
  } finally {
    try { await leaveIfInCall(page); }
    finally { await stopAppBeforeHost(page, host); }
  }
});

test('moderation requires confirmation and applies to a distinct joined member', async ({ page, second: secondBrowser, instanceName }) => {
  let host: StartedHost | null = null;
  let secondContext: BrowserContext | null = null;
  try {
    host = await startTestHost(HOST);
    await traceCoreWorker(page);
    const owner = await signUp(page, host.invite.split(',')[0] ?? '', instanceName, 'Ada', host.control);
    await createCommunity(page);
    const invite = await makeInviteLink(page, COMMUNITY);
    const joined = await secondBrowser.open();
    secondContext = joined.context;
    const member = joined.page;
    await traceCoreWorker(member);
    const bea = await joinAs(member, host, invite, instanceName, 'Bea');
    expect(bea.username).not.toBe(owner.username);
    await openChannel(page, COMMUNITY, GENERAL);
    const box = composerBox(page, GENERAL);
    const region = await runKickFromPicker(page, box, member);
    const confirmation = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Continue', exact: true }) });
    await expect(confirmation).toBeVisible({ timeout: WAIT });
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(confirmation).toBeHidden();
    await leaveCommandMode(page);
    await expect(page.getByRole('navigation', { name: copy('shell.rail.label'), exact: true }).getByRole('button', { name: COMMUNITY })).toBeVisible();

    await runKickFromPicker(page, box, member);
    const confirmAgain = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Continue', exact: true }) });
    await expect(confirmAgain).toBeVisible({ timeout: WAIT });
    await confirmAgain.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(member.getByRole('navigation', { name: copy('shell.rail.label'), exact: true }).getByRole('button', { name: COMMUNITY })).toHaveCount(0, { timeout: WAIT });
    await expect(region.getByRole('status')).toContainText('Bea was kicked.', { timeout: WAIT });
  } finally {
    try { await secondContext?.close(); }
    finally { await stopAppBeforeHost(page, host); }
  }
});

test('reminders sync across devices and remain due after Bot restart and reload', async ({ page, second: secondBrowser, instanceName }) => {
  let host: StartedHost | null = null;
  let secondContext: BrowserContext | null = null;
  try {
    await installWorkerPort(page.context());
    await traceCoreWorker(page);
    host = await startTestHost(HOST);
    const owner = await signUp(page, host.invite.split(',')[0] ?? '', instanceName, 'Ada', host.control);
    await createCommunity(page);
    await enableBot(page, owner.password);
    const reminderText = `cross-device reminder ${Date.now()}`;
    await invoke(composerBox(page, GENERAL), page, `/remind when:1m text:"${reminderText}"`);
    const dialog = page.getByRole('dialog', { name: 'Set a reminder', exact: true });
    await expect(dialog).toBeVisible({ timeout: BOT_WAIT });
    await expect(dialog.getByRole('textbox', { name: 'Reminder', exact: true })).toHaveValue(reminderText);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: BOT_WAIT });
    await expect.poll(() => lastReminderRequestId(page), { timeout: BOT_WAIT }).toMatch(/^[0-9a-f]{32}$/u);
    const reminderId = await lastReminderRequestId(page);
    expect(reminderId).toMatch(/^[0-9a-f]{32}$/u);
    const requestId = reminderId!;
    await expect.poll(() => reminderReceipt(page, requestId), { timeout: BOT_WAIT, intervals: [250, 500, 1_000] })
      .toMatchObject({ status: 0 });
    const originalReceipt = await reminderReceipt(page, requestId);
    if (originalReceipt === null) throw new Error(`acknowledged reminder response ${requestId} disappeared from the worker trace`);

    const signedIn = await secondBrowser.open();
    secondContext = signedIn.context;
    const second = signedIn.page;
    await signIn(second, owner, instanceName);
    await openChannel(second, COMMUNITY, GENERAL);
    await second.getByRole('button', { name: 'Reminders', exact: true }).click();
    const inbox = second.getByRole('dialog', { name: 'Your reminders', exact: true });
    await expect(inbox).toContainText(reminderText, { timeout: BOT_WAIT });
    await host.restartBotRuntime();
    await page.context().setOffline(true);
    // Close this device's live gateway as well as taking its browser context offline.
    await page.goto('about:blank');

    // The supported Bot fixture advances host time alongside wall time. Let the real one-minute
    // duration elapse so the due-state path crosses the same authenticated clock used by requests.
    await expect.poll(async () => {
      const currentInbox = second.getByRole('dialog', { name: 'Your reminders', exact: true });
      return currentInbox.getByRole('button', { name: 'Dismiss', exact: true }).count();
    }, { timeout: 180_000, intervals: [2_000, 5_000], message: 'the reminder should become due after one minute' }).toBeGreaterThan(0);

    await page.context().setOffline(false);
    await page.goto(host.url);
    await openChannel(page, COMMUNITY, GENERAL);
    await page.getByRole('button', { name: 'Reminders', exact: true }).click();
    const firstInbox = page.getByRole('dialog', { name: 'Your reminders', exact: true });
    await expect(firstInbox).toContainText(reminderText, { timeout: BOT_WAIT });
    await expect(firstInbox).toContainText('Due');

    const currentInbox = second.getByRole('dialog', { name: 'Your reminders', exact: true });
    await currentInbox.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(firstInbox).not.toContainText(reminderText, { timeout: BOT_WAIT });

    // The shared adapter has already acknowledged this op80 response. Stop the managed Bot,
    // reload this same device, then ask its real worker for that exact request's archived receipt.
    await host.stopBotRuntime();
    await page.reload();
    await expect(page.getByRole('navigation', { name: copy('shell.rail.label'), exact: true })
      .getByRole('button', { name: COMMUNITY, exact: true })).toBeVisible({ timeout: WAIT });
    expect(await page.evaluate(() => {
      const trace = (window as unknown as { __slashWorkerTrace?: { calls: unknown[] } }).__slashWorkerTrace;
      return trace?.calls.map(value => value as { command?: { m?: string; operation?: number } })
        .filter(value => value.command?.m === 'humanInteractionRequest' && value.command.operation === 80).length ?? 0;
    })).toBe(0);
    const archived = await portCall(page, { m: 'readBotInteractionResponses', communityId: originalReceipt.communityId,
      operations: [80], requestIds: [requestId] });
    expect(archived.ok).toBe(true);
    const recoveredPage = archived.value as { responses?: { requestId?: string; operation?: number; status?: number; data?: Uint8Array }[] };
    expect(recoveredPage.responses).toHaveLength(1);
    const recovered = recoveredPage.responses?.[0];
    expect(recovered?.operation).toBe(80);
    expect({ requestId: recovered?.requestId, status: recovered?.status, data: Array.from(recovered?.data ?? []) })
      .toEqual({ requestId, status: originalReceipt.status, data: originalReceipt.data });
    expect(await page.evaluate(() => {
      const trace = (window as unknown as { __slashWorkerTrace?: { calls: unknown[] } }).__slashWorkerTrace;
      return trace?.calls.map(value => value as { command?: { m?: string; operation?: number } })
        .filter(value => value.command?.m === 'humanInteractionRequest' && value.command.operation === 80).length ?? 0;
    })).toBe(0);
  } finally {
    try { await secondContext?.close(); }
    finally { await stopAppBeforeHost(page, host); }
  }
});

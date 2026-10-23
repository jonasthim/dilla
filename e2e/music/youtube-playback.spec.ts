import { expect, test } from '../voice/support/peer-browser';
import { audible, audibleLevel, AUDIBLE_RMS, heardCount, keyPath, joinVoice, WAIT } from '../voice/support/voice';
import { addServerVia, completeSignUp, copy, makeInviteLink, newAccount, signUp } from '../web/support/app';
import { arr, decode } from '../../packages/client-core/src/cbor/index';

const SERVER = 'Music acceptance';
const DJ_ROLE = 'Music DJ';
const FRIEND = 'Bea';
const YOUTUBE_SAMPLE = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';

const dialog = (page: import('@playwright/test').Page, name: string, vars?: Record<string, string | number>) =>
  page.getByRole('dialog', { name: copy(name, vars), exact: true });
const settingsNav = (settings: import('@playwright/test').Locator, key: string) =>
  settings.getByRole('navigation', { name: copy('admin.nav'), exact: true })
    .getByRole('button', { name: copy(key), exact: true });
const memberRow = (page: import('@playwright/test').Page, name: string) =>
  page.getByRole('complementary', { name: copy('members.region', { server: SERVER }), exact: true })
    .getByRole('listitem').filter({ hasText: name });

/** Records only music command names, response status/counts and upload outcomes, never IDs or CBOR payloads. */
function installMusicTransportTrace(): void {
  type Trace = {
    sent: Record<string, number>;
    uploads: { operation: number; result: string }[];
    reads: { completed: number; errors: string[]; responseCount: number; responses: { operation: number; status: number; matchesRequest: boolean }[];
      blockedCount: number; throughPresentCount: number; snapshotFacts: { paused: boolean; hasCurrent: boolean; revision: string }[] };
    acknowledgements: number;
  };
  type Pending = { kind: 'request'; operation: number; requestId: string } | { kind: 'read' } | { kind: 'ack' };
  type Message = { t?: string; id?: number; command?: { m?: string; operation?: number };
    ok?: boolean; value?: { upload?: string; responses?: { requestId?: string; operation?: number; status?: number; data?: Uint8Array }[]; blocked?: boolean;
      through?: string | null };
    error?: { code?: string } };
  const w = window as unknown as { __dillaMusicTrace?: Trace };
  const trace: Trace = { sent: {}, uploads: [], reads: { completed: 0, errors: [], responseCount: 0,
    responses: [], blockedCount: 0, throughPresentCount: 0, snapshotFacts: [] }, acknowledgements: 0 };
  w.__dillaMusicTrace = trace;
  const pending = new Map<number, Pending>();
  const requests = new Map<string, number>();
  const NativeWorker = window.Worker;
  const readSnapshotFacts = (bytes: Uint8Array): { paused: boolean; hasCurrent: boolean; revision: string } | null => {
    let offset = 0;
    const head = (): { major: number; value: bigint } => {
      if (offset >= bytes.length) throw new Error('truncated');
      const initial = bytes[offset++];
      const additional = initial & 31;
      let value: bigint;
      if (additional < 24) value = BigInt(additional);
      else {
        const width = additional === 24 ? 1 : additional === 25 ? 2 : additional === 26 ? 4 : additional === 27 ? 8 : 0;
        if (width === 0 || offset + width > bytes.length) throw new Error('shape');
        value = 0n;
        for (let i = 0; i < width; i++) value = (value << 8n) | BigInt(bytes[offset++]);
      }
      return { major: initial >> 5, value };
    };
    const skip = (): void => {
      const value = head();
      if (value.major === 2 || value.major === 3) offset += Number(value.value);
      else if (value.major === 4) for (let i = 0; i < Number(value.value); i++) skip();
      if (offset > bytes.length) throw new Error('truncated');
    };
    try {
      const root = head();
      if (root.major !== 4 || root.value !== 10n) return null;
      skip();
      const revision = head();
      if (revision.major !== 0) return null;
      const current = head();
      const hasCurrent = !(current.major === 7 && current.value === 22n);
      if (hasCurrent) {
        if (current.major !== 4) return null;
        for (let i = 0; i < Number(current.value); i++) skip();
      }
      skip();
      skip();
      const paused = head();
      if (paused.major !== 0 || paused.value > 1n) return null;
      return { paused: paused.value === 1n, hasCurrent, revision: revision.value.toString() };
    } catch { return null; }
  };
  class TracedWorker extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      this.addEventListener('message', (event) => {
        const message = event.data as Message;
        if (message?.t !== 'ret' || typeof message.id !== 'number') return;
        const command = pending.get(message.id);
        if (command === undefined) return;
        pending.delete(message.id);
        if (command.kind === 'request') {
          const result = message.ok === true ? message.value?.upload ?? 'unknown' : message.error?.code ?? 'worker-error';
          trace.uploads.push({ operation: command.operation, result });
          trace.uploads.splice(0, Math.max(0, trace.uploads.length - 20));
        } else if (command.kind === 'read') {
          const value = message.value;
          if (message.ok === true) {
            const responses = value?.responses ?? [];
            trace.reads.completed += 1;
            trace.reads.responseCount += responses.length;
            trace.reads.responses.push(...responses.map((response) => {
              const expectedOperation = response.requestId === undefined ? undefined : requests.get(response.requestId);
              const matchesRequest = expectedOperation !== undefined && expectedOperation === response.operation;
              if (matchesRequest && response.requestId !== undefined) requests.delete(response.requestId);
              if (matchesRequest && response.operation === 10 && response.status === 0 && response.data instanceof Uint8Array) {
                const facts = readSnapshotFacts(response.data);
                if (facts !== null) {
                  trace.reads.snapshotFacts.push(facts);
                  trace.reads.snapshotFacts.splice(0, Math.max(0, trace.reads.snapshotFacts.length - 8));
                }
              }
              return { operation: response.operation ?? -1, status: response.status ?? -1, matchesRequest };
            }));
            trace.reads.responses.splice(0, Math.max(0, trace.reads.responses.length - 20));
            if (value?.blocked === true) trace.reads.blockedCount += 1;
            if (value?.through != null) trace.reads.throughPresentCount += 1;
          } else {
            trace.reads.errors.push(message.error?.code ?? 'worker-error');
            trace.reads.errors.splice(0, Math.max(0, trace.reads.errors.length - 20));
          }
        } else {
          trace.acknowledgements += message.ok === true ? 1 : 0;
        }
      });
    }
    postMessage(message: unknown, ...transfer: unknown[]): void {
      const request = message as Message;
      const command = request?.command;
      let pendingKind: Pending | undefined;
      if (request?.t === 'call' && typeof request.id === 'number' && command?.m === 'humanInteractionRequest'
          && typeof command.operation === 'number') {
        const requestId = (command as { requestId?: string }).requestId;
        if (typeof requestId === 'string') requests.set(requestId, command.operation);
        pendingKind = { kind: 'request', operation: command.operation, requestId: requestId ?? '' };
      } else if (request?.t === 'call' && typeof request.id === 'number' && command?.m === 'readBotInteractionResponses') {
        pendingKind = { kind: 'read' };
      } else if (request?.t === 'call' && typeof request.id === 'number' && command?.m === 'ackBotInteractionResponses') {
        pendingKind = { kind: 'ack' };
      }
      if (pendingKind !== undefined && typeof request.id === 'number') {
        const key = pendingKind.kind === 'request' ? `humanInteractionRequest:${pendingKind.operation}` : pendingKind.kind;
        trace.sent[key] = (trace.sent[key] ?? 0) + 1;
        pending.set(request.id, pendingKind);
      }
      super.postMessage(message, ...transfer as [Transferable[]]);
    }
  }
  Object.defineProperty(window, 'Worker', { value: TracedWorker, configurable: true, writable: true });
}

test('late-joining DJ gets authenticated YouTube playback controls and encrypted audible media', async ({ peerBrowser }) => {
  const owner = await peerBrowser.open('owner');
  const dj = await peerBrowser.open('dj');
  await dj.context.addInitScript(installMusicTransportTrace);
  const page = owner.page;
  const djPage = dj.page;
  const invite = process.env.DILLA_TESTKIT_INVITE?.split(',')[0];
  if (!invite) throw new Error('global setup did not export the test instance invite');
  const control = process.env.DILLA_TESTKIT_CONTROL;
  if (!control) throw new Error('global setup did not export the test instance control URL');

  const discovery = await fetch(`${process.env.DILLA_TEST_HOST}/v1/instance`, { headers: { accept: 'application/cbor' } });
  expect(discovery.ok, 'test instance discovery').toBe(true);
  const instanceName = arr(decode(new Uint8Array(await discovery.arrayBuffer())))[5];
  if (typeof instanceName !== 'string' || instanceName === '') throw new Error('test instance has no name');

  const ownerAccount = await signUp(page, invite, instanceName, 'Ada', control);
  await addServerVia(page, 'create');
  const createServer = dialog(page, 'create.server.title');
  await createServer.getByRole('textbox', { name: copy('create.server.name'), exact: true }).fill(SERVER);
  await page.keyboard.press('Enter');
  await expect(createServer).toBeHidden({ timeout: WAIT });
  await expect(page.getByRole('button', { name: copy('voice.open', { name: 'general' }), exact: true })).toBeVisible({ timeout: WAIT });

  await page.getByRole('button', { name: copy('admin.open'), exact: true }).click();
  let settings = dialog(page, 'admin.title');
  await settingsNav(settings, 'roles.tab').click();
  await settings.getByRole('button', { name: copy('roles.new'), exact: true }).click();
  const roleEditor = dialog(page, 'roles.editor.titleNew', { server: SERVER });
  await roleEditor.getByRole('textbox', { name: copy('roles.editor.name'), exact: true }).fill(DJ_ROLE);
  await roleEditor.getByRole('button', { name: copy('roles.editor.create'), exact: true }).click();
  await expect(roleEditor).toBeHidden({ timeout: WAIT });

  await settingsNav(settings, 'admin.nav.bot').click();
  await settings.getByRole('checkbox', { name: copy('admin.bot.capability.music'), exact: true }).check();
  await settings.getByRole('button', { name: copy('admin.bot.enable'), exact: true }).click();
  const stepUp = dialog(page, 'factorSettings.stepUp.title');
  await stepUp.getByLabel(copy('factorSettings.stepUp.password'), { exact: true }).fill(ownerAccount.password);
  await stepUp.getByRole('button', { name: copy('factorSettings.stepUp.confirm'), exact: true }).click();
  await expect(settings.getByRole('status')).toHaveText(copy('admin.bot.status.ready'), { timeout: 90_000 });

  await expect(settings.getByRole('checkbox', { name: DJ_ROLE, exact: true })).toBeVisible({ timeout: WAIT });
  const djPolicy = settings.getByRole('group', { name: copy('admin.bot.music.djRoles.label'), exact: true });
  await djPolicy.getByRole('checkbox', { name: DJ_ROLE, exact: true }).check();
  await settings.getByRole('button', { name: copy('admin.bot.music.djRoles.save'), exact: true }).click();
  await expect(page.getByTestId('shell-announcer')).toHaveText(copy('admin.bot.music.djRoles.saved'), { timeout: WAIT });
  await page.keyboard.press('Escape');

  const inviteLink = await makeInviteLink(page, SERVER);
  await djPage.goto(new URL(inviteLink).pathname);
  await djPage.getByRole('link', { name: 'Open dilla in this browser', exact: true }).click();
  await completeSignUp(djPage, newAccount(FRIEND, control), instanceName);
  await expect(djPage.getByRole('navigation', { name: copy('shell.rail.label'), exact: true })
    .getByRole('button', { name: SERVER, exact: true })).toBeVisible({ timeout: WAIT });

  const friend = memberRow(page, FRIEND);
  await expect(friend).toBeVisible({ timeout: WAIT });
  await friend.locator('.d-member-list__open').click();
  await page.getByRole('dialog', { name: FRIEND, exact: true })
    .getByRole('button', { name: copy('layout.profile.manageRoles'), exact: true }).click();
  const assign = dialog(page, 'roles.assign.title', { name: FRIEND });
  await assign.getByRole('checkbox', { name: DJ_ROLE, exact: true }).click();
  await expect(assign.getByRole('checkbox', { name: DJ_ROLE, exact: true })).toBeChecked({ timeout: WAIT });
  await expect(page.getByTestId('shell-announcer')).toHaveText(copy('roles.assign.given', { role: DJ_ROLE, name: FRIEND }), { timeout: WAIT });
  await assign.getByRole('button', { name: copy('roles.assign.close'), exact: true }).click();

  await joinVoice(djPage, SERVER, 'general');
  const panel = djPage.getByRole('region', { name: copy('voice.music.title'), exact: true });
  await expect(panel).toBeVisible({ timeout: WAIT });
  try {
    await expect(panel).toHaveAttribute('data-availability', 'available', { timeout: 90_000 });
  } catch (error) {
    const trace = await djPage.evaluate(() => {
      const w = window as unknown as { __dillaMusicTrace?: unknown };
      return { transport: w.__dillaMusicTrace ?? null,
        callTiles: document.querySelectorAll('.dw-voice-stage .d-call-stage__tile').length,
        ownTiles: document.querySelectorAll('.dw-voice-stage .d-call-tile[data-own="true"]').length };
    });
    throw new Error(`${String(error)}\nSafe music trace (no IDs or payloads): ${JSON.stringify(trace)}`);
  }
  const url = panel.getByRole('textbox', { name: copy('voice.music.urlLabel'), exact: true });
  await url.fill(YOUTUBE_SAMPLE);
  await panel.getByRole('button', { name: copy('voice.music.enqueueAction'), exact: true }).last().click();
  await expect(panel.getByText(copy('voice.music.enqueueSuccess'), { exact: true })).toBeVisible({ timeout: 90_000 });
  await panel.getByRole('button', { name: copy('voice.music.play'), exact: true }).click();
  try {
    await expect(panel.getByRole('button', { name: copy('voice.music.pause'), exact: true })).toBeEnabled({ timeout: WAIT });
  } catch (error) {
    const trace = await djPage.evaluate(() => (window as unknown as { __dillaMusicTrace?: unknown }).__dillaMusicTrace ?? null);
    throw new Error(`${String(error)}\nSafe music trace (no IDs or payloads): ${JSON.stringify(trace)}`);
  }

  const botTile = djPage.locator('.dw-voice-stage .d-call-stage__tile').filter({ has: djPage.locator('.d-call-tile__tag', { hasText: 'bot' }) });
  await expect(botTile).toHaveCount(1, { timeout: 90_000 });
  const tileID = await botTile.getAttribute('data-tile-id');
  const botDevice = tileID?.split(':')[0] ?? '';
  expect(botDevice).toMatch(/^[0-9a-f]{32}$/);
  // The browser's media worker authenticates this provider's SFrame with the call key; the separate analyser proves the
  // decrypted remote audio reached playback. A UI queue row or an SFU track alone cannot satisfy either assertion.
  let verifiedFrames = 0;
  await expect.poll(async () => {
    verifiedFrames = await heardCount(djPage, botDevice);
    return verifiedFrames;
  }, { timeout: 90_000, intervals: [250, 500, 1_000] }).toBeGreaterThan(0);
  await audible(djPage);
  const keyPathResult = await keyPath(djPage);
  expect(keyPathResult.callKeys).toBeGreaterThan(0);
  expect(keyPathResult.messages).toBeGreaterThan(0);
  expect(keyPathResult.findings).toEqual([]);

  const pause = panel.getByRole('button', { name: copy('voice.music.pause'), exact: true });
  await expect(pause).toBeEnabled();
  await pause.click();
  try {
    await expect(panel.getByRole('button', { name: copy('voice.music.play'), exact: true })).toBeEnabled({ timeout: WAIT });
  } catch (error) {
    const trace = await djPage.evaluate(() => (window as unknown as { __dillaMusicTrace?: unknown }).__dillaMusicTrace ?? null);
    throw new Error(`${String(error)}\nSafe music trace after pause (no IDs or payloads): ${JSON.stringify(trace)}`);
  }
  await panel.getByRole('button', { name: copy('voice.music.play'), exact: true }).click();
  try {
    await expect(panel.getByRole('button', { name: copy('voice.music.pause'), exact: true })).toBeEnabled({ timeout: WAIT });
  } catch (error) {
    const trace = await djPage.evaluate(() => (window as unknown as { __dillaMusicTrace?: unknown }).__dillaMusicTrace ?? null);
    throw new Error(`${String(error)}\nSafe music trace after resume (no IDs or payloads): ${JSON.stringify(trace)}`);
  }
  await expect.poll(() => audibleLevel(djPage), { timeout: 90_000, intervals: [250, 500, 1_000] }).toBeGreaterThan(AUDIBLE_RMS);
  await panel.getByRole('button', { name: copy('voice.music.stop'), exact: true }).click();
  await expect(panel.getByText(copy('voice.music.nothingPlaying'), { exact: true })).toBeVisible({ timeout: WAIT });

  // Confirm the human's E2EE worker observed authenticated Bot media and that its IPC boundary never exposed a call key.
  expect(await djPage.locator('.dw-voice-stage .d-call-tile[data-own="true"]').count()).toBe(1);
});

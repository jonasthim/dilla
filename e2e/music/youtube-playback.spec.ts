import { execFileSync } from 'node:child_process';
import { expect, test } from '../voice/support/peer-browser';
import { audible, audibleLevel, AUDIBLE_RMS, callSlice, heardCount, keyPath, joinVoice, self, snapshotDevices, WAIT } from '../voice/support/voice';
import { addServerVia, channelRow, completeSignUp, copy, makeInviteLink, newAccount, signUp } from '../web/support/app';
import { arr, decode } from '../../packages/client-core/src/cbor/index';

const SERVER = 'Music acceptance A';
const SERVER_TWO = 'Music acceptance B';
const DJ_ROLE = 'Music DJ';
const FRIEND = 'Bea';
const FRIEND_TWO = 'Cal';
const YOUTUBE_SAMPLE = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
// Public, two-video playlist. Keep the expected order below so this exercises
// provider expansion and playback of a later imported item, not just URL routing.
const YOUTUBE_PLAYLIST = 'https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf';
const QUALIFIED_YTDLP = '2026.10.21';

function toolVersion(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n')[0] ?? '';
  } catch {
    throw new Error(`YouTube music E2E requires ${command} on PATH; install the qualified Bot provider tools first.`);
  }
}

test.beforeAll(() => {
  const ytdlp = toolVersion('yt-dlp', ['--version']);
  if (ytdlp !== QUALIFIED_YTDLP) {
    throw new Error(`YouTube music E2E requires yt-dlp ${QUALIFIED_YTDLP}, found ${ytdlp}. Use experiments/bot-providers/youtube-requirements.txt.`);
  }
  const node = toolVersion('node', ['--version']);
  const nodeMajor = Number(/^v(\d+)/u.exec(node)?.[1]);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 22) throw new Error(`YouTube music E2E requires Node 22 or newer, found ${node}.`);
  const bwrap = toolVersion('bwrap', ['--version']);
  const python = toolVersion('python3', ['--version']);
  const ffmpeg = toolVersion('ffmpeg', ['-version']);
  console.info(`YouTube music E2E provider tools: yt-dlp ${ytdlp}, ${node}, ${bwrap}, ${python}, ${ffmpeg}`);
});

const dialog = (page: import('@playwright/test').Page, name: string, vars?: Record<string, string | number>) =>
  page.getByRole('dialog', { name: copy(name, vars), exact: true });
const settingsNav = (settings: import('@playwright/test').Locator, key: string) =>
  settings.getByRole('navigation', { name: copy('admin.nav'), exact: true })
    .getByRole('button', { name: copy(key), exact: true });
const memberRow = (page: import('@playwright/test').Page, server: string, name: string) =>
  page.getByRole('complementary', { name: copy('members.region', { server }), exact: true })
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

test('two communities run isolated YouTube playback with independent Bot identities and SFrame keys', async ({ peerBrowser }) => {
  const owner = await peerBrowser.open('owner');
  const dj = await peerBrowser.open('dj');
  const djTwo = await peerBrowser.open('dj-two');
  await dj.context.addInitScript(installMusicTransportTrace);
  await djTwo.context.addInitScript(installMusicTransportTrace);
  const page = owner.page;
  const djPage = dj.page;
  const djTwoPage = djTwo.page;
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

  await channelRow(page, 'general').click();

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

  // Create and configure the second community through the shipping client. Its installation is
  // independently managed and receives its own user/device identity and MLS group.
  await addServerVia(page, 'create');
  const createServerTwo = dialog(page, 'create.server.title');
  await createServerTwo.getByRole('textbox', { name: copy('create.server.name'), exact: true }).fill(SERVER_TWO);
  await page.keyboard.press('Enter');
  await expect(createServerTwo).toBeHidden({ timeout: WAIT });
  await expect(page.getByRole('button', { name: copy('voice.open', { name: 'general' }), exact: true })).toBeVisible({ timeout: WAIT });
  await page.getByRole('button', { name: copy('admin.open'), exact: true }).click();
  settings = dialog(page, 'admin.title');
  await settingsNav(settings, 'roles.tab').click();
  await settings.getByRole('button', { name: copy('roles.new'), exact: true }).click();
  const roleEditorTwo = dialog(page, 'roles.editor.titleNew', { server: SERVER_TWO });
  await roleEditorTwo.getByRole('textbox', { name: copy('roles.editor.name'), exact: true }).fill(DJ_ROLE);
  await roleEditorTwo.getByRole('button', { name: copy('roles.editor.create'), exact: true }).click();
  await expect(roleEditorTwo).toBeHidden({ timeout: WAIT });
  await settingsNav(settings, 'admin.nav.bot').click();
  await settings.getByRole('checkbox', { name: copy('admin.bot.capability.music'), exact: true }).check();
  await settings.getByRole('button', { name: copy('admin.bot.enable'), exact: true }).click();
  const stepUpTwo = dialog(page, 'factorSettings.stepUp.title');
  await stepUpTwo.getByLabel(copy('factorSettings.stepUp.password'), { exact: true }).fill(ownerAccount.password);
  await stepUpTwo.getByRole('button', { name: copy('factorSettings.stepUp.confirm'), exact: true }).click();
  await expect(settings.getByRole('status')).toHaveText(copy('admin.bot.status.ready'), { timeout: 90_000 });
  await expect(settings.getByRole('checkbox', { name: DJ_ROLE, exact: true })).toBeVisible({ timeout: WAIT });
  const djPolicyTwo = settings.getByRole('group', { name: copy('admin.bot.music.djRoles.label'), exact: true });
  await djPolicyTwo.getByRole('checkbox', { name: DJ_ROLE, exact: true }).check();
  await settings.getByRole('button', { name: copy('admin.bot.music.djRoles.save'), exact: true }).click();
  await expect(page.getByTestId('shell-announcer')).toHaveText(copy('admin.bot.music.djRoles.saved'), { timeout: WAIT });
  await page.keyboard.press('Escape');

  const inviteLinkTwo = await makeInviteLink(page, SERVER_TWO);
  await djTwoPage.goto(new URL(inviteLinkTwo).pathname);
  await djTwoPage.getByRole('link', { name: 'Open dilla in this browser', exact: true }).click();
  await completeSignUp(djTwoPage, newAccount(FRIEND_TWO, control), instanceName);
  await expect(djTwoPage.getByRole('navigation', { name: copy('shell.rail.label'), exact: true })
    .getByRole('button', { name: SERVER_TWO, exact: true })).toBeVisible({ timeout: WAIT });

  // Give each community's DJ role to its local member only.
  for (const [server, name] of [[SERVER, FRIEND], [SERVER_TWO, FRIEND_TWO]] as const) {
    await page.getByRole('navigation', { name: copy('shell.rail.label'), exact: true })
      .getByRole('button', { name: server, exact: true }).click();
    const friend = memberRow(page, server, name);
    await expect(friend).toBeVisible({ timeout: WAIT });
    await friend.locator('.d-member-list__open').click();
    await page.getByRole('dialog', { name, exact: true })
      .getByRole('button', { name: copy('layout.profile.manageRoles'), exact: true }).click();
    const assign = dialog(page, 'roles.assign.title', { name });
    await assign.getByRole('checkbox', { name: DJ_ROLE, exact: true }).click();
    await expect(assign.getByRole('checkbox', { name: DJ_ROLE, exact: true })).toBeChecked({ timeout: WAIT });
    await expect(page.getByTestId('shell-announcer')).toHaveText(copy('roles.assign.given', { role: DJ_ROLE, name }), { timeout: WAIT });
    await assign.getByRole('button', { name: copy('roles.assign.close'), exact: true }).click();
  }

  await joinVoice(djPage, SERVER, 'general');
  await joinVoice(djTwoPage, SERVER_TWO, 'general');
  const panelA = djPage.getByRole('region', { name: copy('voice.music.title'), exact: true });
  const panelB = djTwoPage.getByRole('region', { name: copy('voice.music.title'), exact: true });
  for (const [musicPage, panel] of [[djPage, panelA], [djTwoPage, panelB]] as const) {
    await expect(panel).toBeVisible({ timeout: WAIT });
    try {
      await expect(panel).toHaveAttribute('data-availability', 'available', { timeout: 90_000 });
    } catch (error) {
      const trace = await musicPage.evaluate(() => {
        const w = window as unknown as { __dillaMusicTrace?: unknown };
        return { transport: w.__dillaMusicTrace ?? null,
          callTiles: document.querySelectorAll('.dw-voice-stage .d-call-stage__tile').length,
          ownTiles: document.querySelectorAll('.dw-voice-stage .d-call-tile[data-own="true"]').length };
      });
      throw new Error(`${String(error)}\nSafe music trace (no IDs or payloads): ${JSON.stringify(trace)}`);
    }
  }
  const enqueue = async (panel: typeof panelA, input = YOUTUBE_SAMPLE) => {
    const requestsBefore = await panel.evaluate(() => {
      const trace = (window as unknown as { __dillaMusicTrace?: { sent?: Record<string, number> } }).__dillaMusicTrace;
      return trace?.sent?.['humanInteractionRequest:12'] ?? 0;
    });
    await panel.getByRole('textbox', { name: copy('voice.music.urlLabel'), exact: true }).fill(input);
    await panel.getByRole('button', { name: copy('voice.music.enqueueAction'), exact: true }).last().click();
    try {
      await expect(panel.getByText(copy('voice.music.enqueueSuccess'), { exact: true })).toBeVisible({ timeout: 90_000 });
      const requestsAfter = await panel.evaluate(() => {
        const trace = (window as unknown as { __dillaMusicTrace?: { sent?: Record<string, number> } }).__dillaMusicTrace;
        return trace?.sent?.['humanInteractionRequest:12'] ?? 0;
      });
      expect(requestsAfter - requestsBefore, 'one authenticated queue request for each submitted input').toBe(1);
    } catch (error) {
      const diagnostic = await panel.evaluate((element) => ({ text: element.innerText,
        trace: (window as unknown as { __dillaMusicTrace?: unknown }).__dillaMusicTrace ?? null }));
      throw new Error(`${String(error)}\nSafe enqueue diagnostic (no IDs or payloads): ${JSON.stringify(diagnostic)}`);
    }
  };
  const queueA = panelA.getByRole('list', { name: copy('voice.music.queue'), exact: true });
  const queueB = panelB.getByRole('list', { name: copy('voice.music.queue'), exact: true });
  await panelA.getByRole('button', { name: copy('voice.music.showQueue'), exact: true }).click();
  await panelB.getByRole('button', { name: copy('voice.music.showQueue'), exact: true }).click();
  await enqueue(panelA, YOUTUBE_PLAYLIST);
  await expect(queueA.getByRole('listitem')).toHaveCount(2);
  await expect(queueB.getByRole('listitem')).toHaveCount(0);
  // Exercise B before doing the second real YouTube extraction for A so both calls stay active.
  await enqueue(panelB);
  await expect(queueB.getByRole('listitem')).toHaveCount(1);
  await expect(queueA.getByRole('listitem')).toHaveCount(2);
  await enqueue(panelA);
  await expect(queueA.getByRole('listitem')).toHaveCount(3);
  await expect(queueB.getByRole('listitem')).toHaveCount(1);
  await panelA.getByRole('button', { name: copy('voice.music.play'), exact: true }).click();
  await panelB.getByRole('button', { name: copy('voice.music.play'), exact: true }).click();
  await expect(panelA.getByRole('button', { name: copy('voice.music.pause'), exact: true })).toBeEnabled({ timeout: WAIT });
  try {
    await expect(panelB.getByRole('button', { name: copy('voice.music.pause'), exact: true })).toBeEnabled({ timeout: WAIT });
  } catch (error) {
    const trace = await djPage.evaluate(() => (window as unknown as { __dillaMusicTrace?: unknown }).__dillaMusicTrace ?? null);
    throw new Error(`${String(error)}\nSafe music trace (no IDs or payloads): ${JSON.stringify(trace)}`);
  }

  const botDeviceFor = async (musicPage: typeof page) => {
    const botTile = musicPage.locator('.dw-voice-stage .d-call-stage__tile').filter({ has: musicPage.locator('.d-call-tile__tag', { hasText: 'bot' }) });
    await expect(botTile).toHaveCount(1, { timeout: 90_000 });
    const tileID = await botTile.getAttribute('data-tile-id');
    const botDevice = tileID?.split(':')[0] ?? '';
    expect(botDevice).toMatch(/^[0-9a-f]{32}$/);
    return botDevice;
  };
  const requireAudible = async (musicPage: typeof page, panel: typeof panelA, botDevice: string,
    previousFrames?: number, tracksBefore?: string[]) => {
    try {
      await audible(musicPage);
    } catch (error) {
      const diagnostic = await musicPage.evaluate(({ currentTitle, rms, verifiedFrames, previousFrames, tracksBefore }) => {
        const windowState = window as unknown as {
          __dw?: { contexts?: AudioContext[]; remoteTracks?: Set<string>; remoteAnalysers?: AnalyserNode[] };
          __dillaMusicTrace?: { sent?: Record<string, number>; reads?: { errors?: string[]; responses?: { operation: number; status: number }[] } };
        };
        return {
          title: currentTitle,
          rms,
          verifiedFrames,
          contexts: (windowState.__dw?.contexts ?? []).map((context) => context.state),
          remoteTrackIDs: [...(windowState.__dw?.remoteTracks ?? [])].sort(),
          remoteAnalyserCount: windowState.__dw?.remoteAnalysers?.length ?? 0,
          previousFrames,
          framesAddedSincePrevious: previousFrames === undefined ? null : verifiedFrames - previousFrames,
          trackIDsAddedSincePrevious: tracksBefore === undefined ? null :
            [...(windowState.__dw?.remoteTracks ?? [])].filter((trackID) => !tracksBefore.includes(trackID)).sort(),
          musicRequests: windowState.__dillaMusicTrace?.sent ?? {},
          musicReadErrors: windowState.__dillaMusicTrace?.reads?.errors ?? [],
          musicResponseStatuses: (windowState.__dillaMusicTrace?.reads?.responses ?? []).map((response) => response.status),
        };
      }, { currentTitle: await panel.locator('.dw-voice-music__now > strong').textContent().catch(() => null),
        rms: await audibleLevel(musicPage), verifiedFrames: await heardCount(musicPage, botDevice), previousFrames,
        tracksBefore });
      throw new Error(`${String(error)}\nSafe audio diagnostic (no IDs or media payloads): ${JSON.stringify(diagnostic)}`);
    }
  };
  const botDeviceA = await botDeviceFor(djPage);
  const botDeviceB = await botDeviceFor(djTwoPage);
  // Separate communities must have separate managed Bot device identities.
  expect(botDeviceA).not.toBe(botDeviceB);
  const callA = await callSlice(djPage);
  const callB = await callSlice(djTwoPage);
  expect(callA?.channelId).not.toBeNull();
  expect(callB?.channelId).not.toBeNull();
  expect(callA?.channelId).not.toBe(callB?.channelId);
  expect(callA?.callId).not.toBe(callB?.callId);
  expect(callA?.epoch).not.toBeNull();
  expect(callB?.epoch).not.toBeNull();
  const djSelf = await self(djPage);
  const djTwoSelf = await self(djTwoPage);
  await expect.poll(() => snapshotDevices(djPage, callA!.channelId!), { timeout: WAIT }).toEqual([botDeviceA, djSelf.device].sort());
  await expect.poll(() => snapshotDevices(djTwoPage, callB!.channelId!), { timeout: WAIT }).toEqual([botDeviceB, djTwoSelf.device].sort());
  // The browser's media worker authenticates this provider's SFrame with the call key; the separate analyser proves the
  // decrypted remote audio reached playback. A UI queue row or an SFU track alone cannot satisfy either assertion.
  let verifiedFrames = 0;
  await expect.poll(async () => {
    verifiedFrames = await heardCount(djPage, botDeviceA);
    return verifiedFrames;
  }, { timeout: 90_000, intervals: [250, 500, 1_000] }).toBeGreaterThan(0);
  await expect.poll(() => heardCount(djTwoPage, botDeviceB), { timeout: 90_000, intervals: [250, 500, 1_000] }).toBeGreaterThan(0);
  await requireAudible(djPage, panelA, botDeviceA);
  await requireAudible(djTwoPage, panelB, botDeviceB);
  for (const musicPage of [djPage, djTwoPage]) {
    const result = await keyPath(musicPage);
    expect(result.callKeys).toBeGreaterThan(0);
    expect(result.messages).toBeGreaterThan(0);
    expect(result.findings).toEqual([]);
  }

  // Verify the first imported item is actually playing before advancing within
  // the playlist. Then require another authenticated media frame on item two.
  const nowPlayingA = panelA.locator('.dw-voice-music__now > strong');
  await expect(nowPlayingA).toHaveText('Deep Learning State of the Art (2020)', { timeout: WAIT });
  const framesBeforePlaylistSkip = await heardCount(djPage, botDeviceA);
  const tracksBeforePlaylistSkip = await djPage.evaluate(() =>
    [...((window as unknown as { __dw: { remoteTracks: Set<string> } }).__dw.remoteTracks)].sort());
  await panelA.getByRole('button', { name: copy('voice.music.skip'), exact: true }).click();
  await expect(nowPlayingA).toHaveText('Deep Learning Basics: Introduction and Overview', { timeout: WAIT });
  await expect.poll(() => heardCount(djPage, botDeviceA), { timeout: 90_000, intervals: [250, 500, 1_000] })
    .toBeGreaterThan(framesBeforePlaylistSkip);
  await requireAudible(djPage, panelA, botDeviceA, framesBeforePlaylistSkip, tracksBeforePlaylistSkip);

  const pause = panelA.getByRole('button', { name: copy('voice.music.pause'), exact: true });
  await expect(pause).toBeEnabled();
  await pause.click();
  try {
    await expect(panelA.getByRole('button', { name: copy('voice.music.play'), exact: true })).toBeEnabled({ timeout: WAIT });
  } catch (error) {
    const trace = await djPage.evaluate(() => (window as unknown as { __dillaMusicTrace?: unknown }).__dillaMusicTrace ?? null);
    throw new Error(`${String(error)}\nSafe music trace after pause (no IDs or payloads): ${JSON.stringify(trace)}`);
  }
  await expect(panelB.getByRole('button', { name: copy('voice.music.pause'), exact: true })).toBeEnabled();
  await panelA.getByRole('button', { name: copy('voice.music.play'), exact: true }).click();
  try {
    await expect(panelA.getByRole('button', { name: copy('voice.music.pause'), exact: true })).toBeEnabled({ timeout: WAIT });
  } catch (error) {
    const trace = await djPage.evaluate(() => (window as unknown as { __dillaMusicTrace?: unknown }).__dillaMusicTrace ?? null);
    throw new Error(`${String(error)}\nSafe music trace after resume (no IDs or payloads): ${JSON.stringify(trace)}`);
  }
  await expect.poll(() => audibleLevel(djPage), { timeout: 90_000, intervals: [250, 500, 1_000] }).toBeGreaterThan(AUDIBLE_RMS);
  await expect.poll(() => audibleLevel(djTwoPage), { timeout: 90_000, intervals: [250, 500, 1_000] }).toBeGreaterThan(AUDIBLE_RMS);
  // Stopping A leaves B's independent queue and audio running.
  await panelA.getByRole('button', { name: copy('voice.music.stop'), exact: true }).click();
  await expect(panelA.getByText(copy('voice.music.nothingPlaying'), { exact: true })).toBeVisible({ timeout: WAIT });
  await expect(panelB.getByRole('button', { name: copy('voice.music.pause'), exact: true })).toBeEnabled();
  await expect.poll(() => audibleLevel(djPage), { timeout: WAIT, intervals: [250, 500, 1_000] }).toBeLessThan(AUDIBLE_RMS);
  await expect.poll(() => audibleLevel(djTwoPage), { timeout: WAIT, intervals: [250, 500, 1_000] }).toBeGreaterThan(AUDIBLE_RMS);
  await panelA.getByRole('button', { name: copy('voice.music.play'), exact: true }).click();
  await expect(panelA.getByRole('button', { name: copy('voice.music.pause'), exact: true })).toBeEnabled({ timeout: WAIT });
  await expect.poll(() => audibleLevel(djPage), { timeout: 90_000, intervals: [250, 500, 1_000] }).toBeGreaterThan(AUDIBLE_RMS);

  // Disable only community A's Bot through its owner controls. Community B must keep its
  // authenticated Bot stream and audible output while A's stream disappears.
  await page.getByRole('navigation', { name: copy('shell.rail.label'), exact: true })
    .getByRole('button', { name: SERVER, exact: true }).click();
  await page.getByRole('button', { name: copy('admin.open'), exact: true }).click();
  settings = dialog(page, 'admin.title');
  await settingsNav(settings, 'admin.nav.bot').click();
  await settings.getByRole('button', { name: copy('admin.bot.disable'), exact: true }).click();
  await expect(settings.getByRole('status')).toHaveText(copy('admin.bot.status.disabled'), { timeout: WAIT });
  await expect(page.getByTestId('shell-announcer')).toHaveText(copy('admin.bot.disabledNotice'), { timeout: WAIT });
  await expect.poll(() => snapshotDevices(djPage, callA!.channelId!), { timeout: 90_000 }).not.toContain(botDeviceA);
  await expect.poll(() => audibleLevel(djPage), { timeout: WAIT, intervals: [250, 500, 1_000] }).toBeLessThan(AUDIBLE_RMS);
  await expect.poll(() => heardCount(djTwoPage, botDeviceB), { timeout: WAIT, intervals: [250, 500, 1_000] }).toBeGreaterThan(0);
  await expect.poll(() => audibleLevel(djTwoPage), { timeout: WAIT, intervals: [250, 500, 1_000] }).toBeGreaterThan(AUDIBLE_RMS);

  await panelB.getByRole('button', { name: copy('voice.music.stop'), exact: true }).click();
  await expect(panelB.getByText(copy('voice.music.nothingPlaying'), { exact: true })).toBeVisible({ timeout: WAIT });

  // Confirm the human's E2EE worker observed authenticated Bot media and that its IPC boundary never exposed a call key.
  expect(await djPage.locator('.dw-voice-stage .d-call-tile[data-own="true"]').count()).toBe(1);
  expect(await djTwoPage.locator('.dw-voice-stage .d-call-tile[data-own="true"]').count()).toBe(1);
});

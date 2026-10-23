import { randomBytes } from 'node:crypto';
import { expect } from '@playwright/test';
import { arr, decode, encode } from '../../packages/client-core/src/cbor/index';
import { test as appTest, addServerVia, copy, signUp, type Account } from './support/app';
import { startTestHost, type HostConfig, type StartedHost } from './support/host';

const HOST: HostConfig = { port: 8521, control: 8522, webRoot: 'packages/web/dist', botRuntime: true, advanceClockWithWall: true };
const SERVER = 'Announcement Scheduler Acceptance';
const MESSAGE = `scheduled browser notice ${randomBytes(5).toString('hex')}`;

appTest.use({ baseURL: `http://127.0.0.1:${String(HOST.port)}` });

/** Capture actual core-worker replies from the shipping UI and provide a test call over that same authenticated worker. */
function installCoreWorkerBridge(): void {
  type Reply = { t?: string; id?: number; ok?: boolean; value?: unknown; error?: { code?: string; detail?: string } };
  type Call = { t: 'call'; id: number; command: { m: string; [key: string]: unknown } };
  type Pending = { command: Call['command']; resolve?: (value: unknown) => void; reject?: (error: Error) => void };
  const state = window as unknown as { __dillaAnnouncementBridge?: {
    replies: { command: Call['command']; reply: Reply }[];
    invoke(command: Call['command']): Promise<unknown>;
  } };
  const NativeWorker = window.Worker;
  const workers: Worker[] = [];
  const pending = new Map<number, Pending>();
  let nextId = 1_000_000;
  class ObservedWorker extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      workers.push(this);
      this.addEventListener('message', event => {
        const reply = event.data as Reply;
        if (reply?.t !== 'ret' || typeof reply.id !== 'number') return;
        const active = pending.get(reply.id);
        if (active === undefined) return;
        pending.delete(reply.id);
        state.__dillaAnnouncementBridge?.replies.push({ command: active.command, reply });
        if (active.resolve === undefined) return;
        if (reply.ok === true) active.resolve(reply.value);
        else active.reject?.(new Error(`${reply.error?.code ?? 'worker-error'} ${reply.error?.detail ?? ''}`.trim()));
      });
    }
    postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions): void {
      const call = message as Call;
      if (call?.t === 'call' && typeof call.id === 'number' && typeof call.command?.m === 'string' && !pending.has(call.id)) {
        pending.set(call.id, { command: call.command });
      }
      super.postMessage(message, options as Transferable[]);
    }
  }
  Object.defineProperty(window, 'Worker', { value: ObservedWorker, configurable: true, writable: true });
  state.__dillaAnnouncementBridge = {
    replies: [],
    invoke(command) {
      const worker = workers.at(-1);
      if (worker === undefined) return Promise.reject(new Error('shipping core worker is not ready'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { command, resolve, reject });
        worker.postMessage({ t: 'call', id, command });
      });
    },
  };
}

type InteractionPage = { responses: { requestId: string; operation: number; status: number; revision: string | null; data: number[] }[]; through: string | null };

async function coreCall<T>(page: import('@playwright/test').Page, command: Record<string, unknown>): Promise<T> {
  return page.evaluate(async (input) => {
    const bridge = (window as unknown as { __dillaAnnouncementBridge?: { invoke(command: never): Promise<unknown> } }).__dillaAnnouncementBridge;
    if (bridge === undefined) throw new Error('shipping core worker bridge was not installed');
    return bridge.invoke(input as never);
  }, command) as Promise<T>;
}

function requestId(): string { return randomBytes(16).toString('hex'); }

async function botInteraction(page: import('@playwright/test').Page, communityId: string, operation: number, args: unknown[], revision: string | null): Promise<string> {
  const id = requestId();
  const result = await coreCall<{ requestId: string; upload: string }>(page, {
    m: 'humanInteractionRequest', communityId, channelId: null, requestId: id, operation, args, revision,
  });
  expect(result).toEqual({ requestId: id, upload: 'accepted' });
  return id;
}

async function interactionResponse(page: import('@playwright/test').Page, communityId: string, operation: number, requestId: string): Promise<{ status: number; revision: string | null; data: Uint8Array }> {
  let found: { status: number; revision: string | null; data: Uint8Array } | undefined;
  await expect.poll(async () => {
    const result = await coreCall<InteractionPage & { blocked: boolean }>(page, { m: 'readBotInteractionResponses', communityId, operations: [operation] });
    const row = result.responses.find(response => response.requestId === requestId);
    if (row !== undefined) found = { status: row.status, revision: row.revision, data: new Uint8Array(row.data) };
    if (result.through !== null) await coreCall(page, { m: 'ackBotInteractionResponses', communityId, through: result.through });
    return found !== undefined;
  }, { timeout: 12_000, intervals: [250, 500, 1_000] }).toBe(true);
  if (found === undefined) throw new Error(`Bot interaction ${String(operation)} had no response`);
  return found;
}

function stockholmMinuteAfter(seconds: number): { date: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(Date.now() + seconds * 1000));
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { date: `${value.year}-${value.month}-${value.day}`, hour: Number(value.hour), minute: Number(value.minute) };
}

appTest('creates and sends a one-off announcement through the browser client, then survives a Bot restart without a duplicate', async ({ page, instanceName }) => {
  appTest.setTimeout(360_000);
  await page.addInitScript(installCoreWorkerBridge);
  let host: StartedHost | null = null;
  try {
    host = await startTestHost(HOST);
    const account = await signUp(page, host.invite.split(',')[0] ?? '', instanceName, 'Ada', host.control);
    await addServerVia(page, 'create');
    const create = page.getByRole('dialog', { name: copy('create.server.title'), exact: true });
    await create.getByRole('textbox', { name: copy('create.server.name'), exact: true }).fill(SERVER);
    await page.keyboard.press('Enter');
    const general = page.getByRole('button', { name: copy('voice.open', { name: 'general' }), exact: true });
    await expect(general).toBeVisible({ timeout: 30_000 });
    const created = await page.evaluate(() => {
      const bridge = (window as unknown as { __dillaAnnouncementBridge?: { replies: { command: { m: string; kind?: string }; reply: { ok?: boolean; value?: unknown } }[] } }).__dillaAnnouncementBridge;
      return bridge?.replies.filter(row => row.command.m === 'createCommunity' && row.reply.ok === true).at(-1)?.reply.value ?? null;
    }) as { communityId?: string } | null;
    if (created?.communityId === undefined) throw new Error('shipping UI did not return the created community ID');
    const communityId = created.communityId;
    const channel = await page.evaluate(() => {
      const bridge = (window as unknown as { __dillaAnnouncementBridge?: { replies: { command: { m: string; kind?: string }; reply: { ok?: boolean; value?: unknown } }[] } }).__dillaAnnouncementBridge;
      return bridge?.replies.filter(row => row.command.m === 'createChannel' && row.command.kind === 'text' && row.reply.ok === true).at(-1)?.reply.value ?? null;
    }) as { channelId?: string } | null;
    if (channel?.channelId === undefined) throw new Error('shipping UI did not return its starter text channel ID');
    const textChannel = page.getByRole('button', { name: 'general', exact: true });
    await expect(textChannel).toBeVisible();
    await textChannel.click();

    await page.getByRole('button', { name: copy('admin.open'), exact: true }).click();
    const settings = page.getByRole('dialog', { name: copy('admin.title'), exact: true });
    await settings.getByRole('navigation', { name: copy('admin.nav'), exact: true })
      .getByRole('button', { name: copy('admin.nav.bot'), exact: true }).click();
    await settings.getByRole('checkbox', { name: copy('admin.bot.capability.announcements'), exact: true }).check();
    await settings.getByRole('button', { name: copy('admin.bot.enable'), exact: true }).click();
    const stepUp = page.getByRole('dialog', { name: copy('factorSettings.stepUp.title'), exact: true });
    await stepUp.getByLabel(copy('factorSettings.stepUp.password'), { exact: true }).fill(account.password);
    await stepUp.getByRole('button', { name: copy('factorSettings.stepUp.confirm'), exact: true }).click();
    await expect(settings.getByRole('status')).toHaveText(copy('admin.bot.status.ready'), { timeout: 90_000 });
    await page.keyboard.press('Escape');

    const welcomeSettingsId = await botInteraction(page, communityId, 1, [5], null);
    expect((await interactionResponse(page, communityId, 1, welcomeSettingsId)).status).toBe(0);

    const runAt = stockholmMinuteAfter(30);
    const schedule = encode([1n, new Uint8Array(16).fill(0x31), Uint8Array.from(channel.channelId.match(/../gu)!.map(byte => Number.parseInt(byte, 16))),
      MESSAGE, 'one_off', 'Europe/Stockholm', runAt.date, runAt.hour, runAt.minute, 0, 1, 1]);
    const putId = await botInteraction(page, communityId, 51, [null, schedule], '0');
    const put = await interactionResponse(page, communityId, 51, putId);
    expect(put.status).toBe(0);
    expect(put.revision).toBe('1');
    expect(decode(put.data)).toEqual([]);

    const listId = await botInteraction(page, communityId, 50, [0], null);
    const listed = await interactionResponse(page, communityId, 50, listId);
    expect(listed.status).toBe(0);
    const [version, offset, total, rows] = arr(decode(listed.data), 4);
    expect([version, offset, total]).toEqual([1n, 0n, 1n]);
    const listedSchedule = arr(arr(rows)[0] ?? null);
    expect(listedSchedule.slice(0, 5)).toEqual([
      new Uint8Array(16).fill(0x31),
      Uint8Array.from(channel.channelId.match(/../gu)!.map(byte => Number.parseInt(byte, 16))),
      MESSAGE, 'one_off', 'Europe/Stockholm',
    ]);

    await expect(page.getByText(MESSAGE, { exact: true })).toHaveCount(1, { timeout: 120_000 });
    await host.restartBotRuntime();
    await expect(page.getByText(MESSAGE, { exact: true })).toHaveCount(1, { timeout: 60_000 });
    const afterRestartId = await botInteraction(page, communityId, 50, [0], null);
    const afterRestart = await interactionResponse(page, communityId, 50, afterRestartId);
    const [, , afterTotal, afterRows] = arr(decode(afterRestart.data), 4);
    expect(afterTotal).toBe(1n);
    expect(arr(afterRows)).toHaveLength(1);
    await expect(page.getByText(MESSAGE, { exact: true })).toHaveCount(1);
  } finally {
    await host?.stop();
  }
});

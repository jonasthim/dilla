import { createElement, useEffect } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { decode, encode, fromHex, PERM, type CoreClient, type CommandContext as Binding } from '@dilla/client-core';
import type { CommandExecutionContext } from './command-types.ts';
import { useBotCommandProvider } from './bot-handlers.ts';

const COMMUNITY = '11'.repeat(16); const TEXT = '22'.repeat(16); const VOICE = '33'.repeat(16); const USER = '44'.repeat(16);
const INSTALLATION = '55'.repeat(16); const ITEM = '66'.repeat(16); const PARENT = '77'.repeat(16);
type Wire = Record<string, unknown>;
function musicSnapshot(revision: number, paused: boolean, queue: { id: string; provider: string; canonical: string; title: string; artist: string }[] = []) {
  return encode([1n, BigInt(revision), null,
    queue.map(row => [row.id, row.provider, row.canonical, row.title, row.artist, '', 120_000n, '']),
    0n, paused ? 1n : 0n, 70n, 0n, 0n, 1n]);
}
function fixture(options: { failRegistrationOnce?: boolean; failResume?: boolean; invalidRefreshAfterEnqueue?: boolean; seededQueue?: boolean; seedSchedule?: boolean; malformedAnnouncementReceipt?: boolean } = {}) {
  let musicRevision = 1; let paused = true; let badSnapshotOnce = false;
  let queue: { id: string; provider: string; canonical: string; title: string; artist: string }[] = options.seededQueue
    ? [{ id: ITEM, provider: 'youtube', canonical: 'abcdefghijk', title: 'Queued track', artist: 'Listener' }] : [];
  let announcementRevision = 1; const schedules: unknown[][] = options.seedSchedule
    ? [[fromHex('99'.repeat(16)), fromHex(TEXT), 'Launch plan', 'one_off', 'Europe/Stockholm', '2099-01-01', 12n, 0n, 0n, 1n, 1n]] : [];
  let failRegistrationOnce = options.failRegistrationOnce === true;
  const requests: Wire[] = []; const responses: { deliveryId: string; requestId: string; communityId: string; operation: number; channelId: string | null; status: number; revision: string | null; data: Uint8Array }[] = [];
  let delivery = 0;
  const client = {
    // eslint-disable-next-line @typescript-eslint/require-await -- models CoreClient.call while resolving each worker command.
    call: vi.fn(async (command: Wire): Promise<unknown> => {
      if (command.m === 'getBotCommandStatus') return { installationId: INSTALLATION, botUserId: null, state: 3, revision: '9' };
      if (command.m === 'listSelfRoles') return [{ id: '88'.repeat(16), name: 'Reader' }];
      if (command.m === 'registerRolePanel') { requests.push(command); if (failRegistrationOnce) { failRegistrationOnce = false; throw new Error('temporary registration failure'); } return null; }
      if (command.m === 'humanInteractionRequest') {
        requests.push(command);
        const operation = command.operation as number; const id = command.requestId as string;
        let status = 0; let revision: string | null = null; let data: Uint8Array = encode([]);
        if (operation === 10) { revision = String(musicRevision); data = badSnapshotOnce ? Uint8Array.of(0xff) : musicSnapshot(musicRevision, paused, queue); badSnapshotOnce = false; }
        if (operation === 11) data = encode([1n, [['yt:abcdefghijk', 'youtube', 'abcdefghijk', 'First result', 'Listener', '', 120_000n, '']]]);
        if (operation === 12) { queue = [{ id: ITEM, provider: 'youtube', canonical: 'abcdefghijk', title: 'First result', artist: 'Listener' }]; musicRevision++; revision = String(musicRevision); if (options.invalidRefreshAfterEnqueue) badSnapshotOnce = true; }
        if (operation === 13) { paused = true; musicRevision++; revision = String(musicRevision); }
        if (operation === 14 && options.failResume) status = 2;
        else if (operation === 14) { paused = false; musicRevision++; revision = String(musicRevision); }
        if (operation === 15 || operation === 16 || operation === 17 || operation === 18 || operation === 19 || operation === 20 || operation === 21 || operation === 22 || operation === 23) { musicRevision++; revision = String(musicRevision); }
        if (operation === 50) { revision = String(announcementRevision); data = encode([1n, 0n, BigInt(schedules.length), schedules as never]); }
        if (operation === 51) {
          const value = decode((command.args as unknown[])[1] as Uint8Array) as unknown[];
          if ((command.args as unknown[])[0] === null) schedules.push(value);
          else { const index = schedules.findIndex(row => row[1] instanceof Uint8Array && Array.from(row[1]).map(x => x.toString(16).padStart(2, '0')).join('') === '99'.repeat(16)); if (index >= 0) schedules[index] = value; }
          announcementRevision++; revision = String(announcementRevision);
          if (options.malformedAnnouncementReceipt) data = encode([1n]);
        }
        if (operation === 52) { announcementRevision++; revision = String(announcementRevision); }
        if (operation === 31) data = encode([fromHex(TEXT), 99n]);
        responses.push({ deliveryId: String(++delivery), requestId: id, communityId: COMMUNITY, operation, channelId: command.channelId as string | null,
          status, revision, data });
        return { requestId: id, upload: 'accepted' };
      }
      if (command.m === 'readBotInteractionResponses') {
        const operations = command.operations as number[]; const requestIds = command.requestIds as string[];
        return { responses: responses.filter(row => operations.includes(row.operation) && requestIds.includes(row.requestId)), through: null, blocked: false };
      }
      if (command.m === 'ackBotInteractionResponses') return null;
      return null;
    }),
    get: (key: string) => key === 'account' ? { phase: 'ready', user: { id: USER }, deviceId: 'aa'.repeat(16), instance: { id: 'bb'.repeat(16) } }
      : key === 'communities' ? [{ id: COMMUNITY }] : key === `permissions:${COMMUNITY}` ? { loaded: true, manageCommunity: true, manageRoles: true }
        : key === `channels:${COMMUNITY}` ? [{ id: TEXT, communityId: COMMUNITY, kind: 0, name: 'announcements' }, { id: VOICE, communityId: COMMUNITY, kind: 1, name: 'voice' }]
          : key === 'call' ? { channelId: VOICE } : undefined,
    subscribe: () => () => undefined, onCallKeys: () => () => undefined, dispose: () => undefined,
  } as unknown as CoreClient;
  return { client, requests, schedules };
}
function commandContext(client: CoreClient, over: Partial<CommandExecutionContext> = {}): CommandExecutionContext {
  const binding: Binding = { communityId: COMMUNITY, channelId: TEXT, bits: PERM.manageCommunity | PERM.manageRoles };
  return { requestId: PARENT, binding, getCurrentBinding: () => binding, isCurrent: () => true, client,
    getCall: () => ({ channelId: VOICE, session: {} } as never), call: {} as never, navigate: vi.fn(), openThread: vi.fn(), openSearch: vi.fn(),
    items: [], selfId: USER, encodeMessage: text => text, confirm: () => Promise.resolve(true), openInvite: () => Promise.resolve(true), openGif: vi.fn(), openModerationLog: vi.fn(), ...over };
}
function mountProvider(client: CoreClient, capture: { value?: ReturnType<typeof useBotCommandProvider> }) {
  function Probe() { const value = useBotCommandProvider(client, COMMUNITY); useEffect(() => { capture.value = value; }); return createElement('div', null, value.dialogs); }
  return render(createElement(Probe));
}

describe('Bot slash command provider', () => {
  it('plays the first worker search result, then resumes with distinct stable child request IDs', async () => {
    const f = fixture(); const capture: { value?: ReturnType<typeof useBotCommandProvider> } = {};
    mountProvider(f.client, capture); await waitFor(() => expect(capture.value).toBeDefined());
    const context = commandContext(f.client);
    const result = await capture.value!.handlers.play!({ commandId: 'play', args: { 'query-or-url': 'harbor song' } }, context);
    expect(result).toMatchObject({ status: 'success', private: true });
    const writes = f.requests.filter(row => row.m === 'humanInteractionRequest' && [11, 12, 14].includes(row.operation as number));
    expect(writes.map(row => row.operation)).toEqual([11, 12, 14]);
    expect(writes[1]?.args).toEqual(['https://www.youtube.com/watch?v=abcdefghijk']);
    expect(writes.map(row => row.requestId)).toHaveLength(new Set(writes.map(row => row.requestId)).size);
    expect(writes.every(row => row.requestId !== context.requestId)).toBe(true);
    expect(f.requests.filter(row => row.m === 'humanInteractionRequest' && row.operation === 12)).toHaveLength(1);
  });

  it('refuses music controls without a current joined call and sends no Bot interaction', async () => {
    const f = fixture(); const capture: { value?: ReturnType<typeof useBotCommandProvider> } = {};
    mountProvider(f.client, capture); await waitFor(() => expect(capture.value).toBeDefined());
    const result = await capture.value!.handlers.pause!({ commandId: 'pause', args: {} }, commandContext(f.client, { getCall: () => ({ channelId: VOICE, session: null } as never) }));
    expect(result).toMatchObject({ status: 'failure', private: true });
    expect(f.requests.filter(row => row.m === 'humanInteractionRequest')).toHaveLength(0);
  });

  it.each([
    ['pause', {}, 13, []], ['resume', {}, 14, []], ['skip', {}, 15, []], ['stop', {}, 16, []],
    ['seek', { position: '1:02' }, 17, [62_000]], ['volume', { level: '42' }, 18, [42]], ['shuffle', { mode: 'on' }, 19, []],
    ['repeat', { mode: 'all' }, 20, [2]], ['queue remove', { item: ITEM }, 21, [ITEM]], ['queue move', { item: ITEM, position: '1' }, 22, [ITEM, null]],
    ['queue clear', {}, 23, []],
  ] as const)('runs %s with its exact worker operation and arguments', async (commandId, args, operation, wireArgs) => {
    const f = fixture({ seededQueue: commandId.startsWith('queue ') }); const capture: { value?: ReturnType<typeof useBotCommandProvider> } = {};
    mountProvider(f.client, capture); await waitFor(() => expect(capture.value).toBeDefined());
    const provider = capture.value;
    if (provider === undefined) throw new Error('Bot provider did not mount.');
    const handler = provider.handlers[commandId];
    if (handler === undefined) throw new Error(`Missing handler for ${commandId}.`);
    const result = await handler({ commandId, args }, commandContext(f.client));
    expect(result).toMatchObject({ status: 'success', private: true });
    const mutation = f.requests.find(row => row.m === 'humanInteractionRequest' && row.operation === operation);
    expect(mutation?.args).toEqual(wireArgs);
    expect(mutation?.revision).toBe('1');
  });

  it('does not enqueue a second time when accepted enqueue refresh is uncertain, and reconciles using the same request id', async () => {
    const f = fixture({ invalidRefreshAfterEnqueue: true }); const capture: { value?: ReturnType<typeof useBotCommandProvider> } = {};
    mountProvider(f.client, capture); await waitFor(() => expect(capture.value).toBeDefined());
    const context = commandContext(f.client); const invocation = { commandId: 'play', args: { 'query-or-url': 'https://youtube.com/watch?v=abcdefghijk' } };
    expect(await capture.value!.handlers.play!(invocation, context)).toMatchObject({ status: 'uncertain', private: true });
    expect(await capture.value!.handlers.play!(invocation, context)).toMatchObject({ status: 'success', private: true });
    const enqueueRequests = f.requests.filter(row => row.m === 'humanInteractionRequest' && row.operation === 12);
    expect(enqueueRequests).toHaveLength(1);
    expect(enqueueRequests[0]?.args).toEqual(['https://youtube.com/watch?v=abcdefghijk']);
  });

  it('reports accepted enqueue as partial success when resume is refused and never repeats enqueue', async () => {
    const f = fixture({ failResume: true }); const capture: { value?: ReturnType<typeof useBotCommandProvider> } = {};
    mountProvider(f.client, capture); await waitFor(() => expect(capture.value).toBeDefined());
    const context = commandContext(f.client); const invocation = { commandId: 'play', args: { 'query-or-url': 'https://youtube.com/watch?v=abcdefghijk' } };
    const result = await capture.value!.handlers.play!(invocation, context);
    expect(result).toMatchObject({ status: 'success', private: true });
    expect(result.message).toMatch(/already in the queue/u);
    await capture.value!.handlers.play!(invocation, context);
    expect(f.requests.filter(row => row.m === 'humanInteractionRequest' && row.operation === 12)).toHaveLength(1);
    expect(f.requests.filter(row => row.m === 'humanInteractionRequest' && row.operation === 14)).toHaveLength(1);
  });

  it('lists announcements from an authenticated response and keeps output private', async () => {
    const f = fixture(); const capture: { value?: ReturnType<typeof useBotCommandProvider> } = {};
    mountProvider(f.client, capture); await waitFor(() => expect(capture.value).toBeDefined());
    const result = await capture.value!.handlers['announcement list']!({ commandId: 'announcement list', args: {} }, commandContext(f.client));
    expect(result).toMatchObject({ status: 'success', private: true, message: 'No scheduled announcements.' });
    const reads = f.requests.filter(row => row.m === 'humanInteractionRequest' && row.operation === 50);
    expect(reads.length).toBeGreaterThan(0);
    expect(new Set(reads.map(row => row.requestId)).size).toBe(reads.length);
  });

  it('debounces play autocomplete 250 ms, skips short queries, and returns the selected worker result input', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); const capture: { value?: ReturnType<typeof useBotCommandProvider> } = {};
      mountProvider(f.client, capture); await vi.waitFor(() => expect(capture.value).toBeDefined());
      const provider = capture.value!; const binding: Binding = { communityId: COMMUNITY, channelId: TEXT };
      const option = { name: 'query-or-url', kind: 'text' as const, description: 'query', required: true, freeText: true };
      await expect(provider.suggest('play', option, 'a', binding)).resolves.toEqual([]);
      expect(f.requests.filter(row => row.m === 'humanInteractionRequest' && row.operation === 11)).toHaveLength(0);
      const suggestions = provider.suggest('play', option, 'harbor', binding);
      await vi.advanceTimersByTimeAsync(249);
      expect(f.requests.filter(row => row.m === 'humanInteractionRequest' && row.operation === 11)).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      await expect(suggestions).resolves.toEqual([{ id: 'yt:abcdefghijk', value: 'https://www.youtube.com/watch?v=abcdefghijk', label: 'First result', description: 'Listener' }]);
      expect(f.requests.filter(row => row.m === 'humanInteractionRequest' && row.operation === 11)).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it('resolves an announcement suggestion by saved stable ID as well as its title', async () => {
    const f = fixture({ seedSchedule: true }); const capture: { value?: ReturnType<typeof useBotCommandProvider> } = {};
    mountProvider(f.client, capture); await waitFor(() => expect(capture.value).toBeDefined());
    const provider = capture.value!; const binding: Binding = { communityId: COMMUNITY, channelId: TEXT };
    const option = { name: 'announcement', kind: 'announcement' as const, description: 'announcement', required: true };
    await expect(provider.suggest('announcement edit', option, '99'.repeat(16), binding)).resolves.toEqual([
      expect.objectContaining({ id: '99'.repeat(16), value: '99'.repeat(16), label: 'Launch plan' }),
    ]);
  });

  it('edits a selected announcement with the current global revision and preserves its recurrence', async () => {
    const f = fixture({ seedSchedule: true }); const capture: { value?: ReturnType<typeof useBotCommandProvider> } = {};
    const user = userEvent.setup(); mountProvider(f.client, capture); await waitFor(() => expect(capture.value).toBeDefined());
    const pending = capture.value!.handlers['announcement edit']!({ commandId: 'announcement edit', args: { announcement: '99'.repeat(16), text: 'Revised plan' } }, commandContext(f.client));
    await screen.findByRole('dialog', { name: 'Edit scheduled announcement' });
    expect(screen.getByLabelText('Repeat')).toHaveValue('one_off');
    expect(screen.getByLabelText('Date')).toHaveValue('2099-01-01');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await pending).toMatchObject({ status: 'success', private: true, message: 'Announcement updated.' });
    const save = f.requests.find(row => row.m === 'humanInteractionRequest' && row.operation === 51)!;
    expect(save.revision).toBe('1');
    expect((save.args as unknown[])[0]).toEqual(fromHex('99'.repeat(16)));
    const value = decode((save.args as unknown[])[1] as Uint8Array) as unknown[];
    expect(value.slice(3, 6)).toEqual(['Revised plan', 'one_off', 'Europe/Stockholm']);
  });

  it('confirms announcement deletion and binds the delete to schedule and document revisions', async () => {
    const f = fixture({ seedSchedule: true }); const capture: { value?: ReturnType<typeof useBotCommandProvider> } = {};
    mountProvider(f.client, capture); await waitFor(() => expect(capture.value).toBeDefined());
    const context = commandContext(f.client, { confirm: () => Promise.resolve(true) });
    const result = await capture.value!.handlers['announcement delete']!({ commandId: 'announcement delete', args: { announcement: '99'.repeat(16) } }, context);
    expect(result).toMatchObject({ status: 'success', private: true, message: 'Scheduled announcement deleted.' });
    const deletion = f.requests.find(row => row.m === 'humanInteractionRequest' && row.operation === 52)!;
    expect(deletion).toMatchObject({ revision: '1', args: [fromHex('99'.repeat(16)), 1] });
  });

  it('opens a focused role panel editor and uses separate publication and registration IDs', async () => {
    const f = fixture(); const capture: { value?: ReturnType<typeof useBotCommandProvider> } = {};
    const user = userEvent.setup(); mountProvider(f.client, capture); await waitFor(() => expect(capture.value).toBeDefined());
    const pending = capture.value!.handlers['rolepanel create']!({ commandId: 'rolepanel create', args: {} }, commandContext(f.client));
    const checkbox = await screen.findByRole('checkbox', { name: 'Reader' }); await user.click(checkbox);
    await user.type(screen.getByLabelText('Reaction for Reader'), '📚');
    await user.click(screen.getByRole('button', { name: 'Publish panel' }));
    const result = await pending;
    expect(result).toMatchObject({ status: 'success', private: true });
    const publication = f.requests.find(row => row.m === 'humanInteractionRequest' && row.operation === 31)!;
    const registration = f.requests.find(row => row.m === 'registerRolePanel')!;
    expect(publication.requestId).not.toBe(registration.requestId);
    expect(registration).toMatchObject({ communityId: COMMUNITY, channelId: TEXT, messageSeq: '99' });
  });

  it('recovers a published role panel by retrying registration without publishing another message', async () => {
    const f = fixture({ failRegistrationOnce: true }); const capture: { value?: ReturnType<typeof useBotCommandProvider> } = {};
    const user = userEvent.setup(); mountProvider(f.client, capture); await waitFor(() => expect(capture.value).toBeDefined());
    const context = commandContext(f.client);
    const first = capture.value!.handlers['rolepanel create']!({ commandId: 'rolepanel create', args: {} }, context);
    await user.click(await screen.findByRole('checkbox', { name: 'Reader' }));
    await user.type(screen.getByLabelText('Reaction for Reader'), '📚');
    await user.click(screen.getByRole('button', { name: 'Publish panel' }));
    expect(await first).toMatchObject({ status: 'uncertain', private: true });
    const retry = await capture.value!.handlers['rolepanel create']!({ commandId: 'rolepanel create', args: {} }, context);
    expect(retry).toMatchObject({ status: 'success', private: true });
    expect(f.requests.filter(row => row.m === 'humanInteractionRequest' && row.operation === 31)).toHaveLength(1);
    const registrations = f.requests.filter(row => row.m === 'registerRolePanel');
    expect(registrations).toHaveLength(2);
    expect(registrations[0]).toEqual(registrations[1]);
  });

  it('sends a schedule only after the announcement editor submits valid data', async () => {
    const f = fixture(); const capture: { value?: ReturnType<typeof useBotCommandProvider> } = {};
    const user = userEvent.setup(); mountProvider(f.client, capture); await waitFor(() => expect(capture.value).toBeDefined());
    const pending = capture.value!.handlers['announcement create']!({ commandId: 'announcement create', args: { text: 'Meet at noon' } }, commandContext(f.client));
    await screen.findByRole('dialog', { name: 'Schedule an announcement' });
    expect(f.requests.filter(row => row.m === 'humanInteractionRequest' && row.operation === 51)).toHaveLength(0);
    const destination = screen.getByLabelText('Destination channel'); fireEvent.change(destination, { target: { value: TEXT } });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const result = await pending;
    expect(result).toMatchObject({ status: 'success', private: true, message: 'Announcement scheduled.' });
    const save = f.requests.find(row => row.m === 'humanInteractionRequest' && row.operation === 51)!;
    expect(save.args).toHaveLength(2); expect(save.revision).toBe('1');
    expect((decode((save.args as unknown[])[1] as Uint8Array) as unknown[])[3]).toBe('Meet at noon');
  });

  it('keeps the original announcement request and body when an accepted save has a malformed receipt', async () => {
    const f = fixture({ malformedAnnouncementReceipt: true }); const capture: { value?: ReturnType<typeof useBotCommandProvider> } = {};
    const user = userEvent.setup(); mountProvider(f.client, capture); await waitFor(() => expect(capture.value).toBeDefined());
    const context = commandContext(f.client); const invocation = { commandId: 'announcement create', args: { text: 'Original schedule body' } };
    const pending = capture.value!.handlers['announcement create']!(invocation, context);
    await screen.findByRole('dialog', { name: 'Schedule an announcement' });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await pending).toMatchObject({ status: 'uncertain', private: true });
    const first = f.requests.find(row => row.m === 'humanInteractionRequest' && row.operation === 51)!;
    const originalBody = (first.args as unknown[])[1] as Uint8Array;
    expect(await capture.value!.handlers['announcement create']!(invocation, context)).toMatchObject({ status: 'uncertain', private: true });
    const saves = f.requests.filter(row => row.m === 'humanInteractionRequest' && row.operation === 51);
    expect(saves).toHaveLength(1);
    expect(saves.map(row => (row.args as unknown[])[1])).toEqual([originalBody]);
    expect(f.schedules).toHaveLength(1);
  });
});

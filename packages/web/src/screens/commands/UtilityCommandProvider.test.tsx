import { createElement, useEffect } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decode, encode as importEncode, fromHex, PERM, type CoreClient, type CommandContext as Binding, type PollSummary } from '@dilla/client-core';
import { FakeClient } from '../../test/fake-client.ts';
import type { CommandExecutionContext } from './command-types.ts';
import { finalPollMarker, PollCard } from './PollCard.tsx';
import { notifyReminder, useUtilityCommandProvider } from './UtilityCommandProvider.tsx';

const COMMUNITY = '11'.repeat(16); const CHANNEL = '22'.repeat(16); const USER = '33'.repeat(16);
const INSTALLATION = '44'.repeat(16); const BOT = '55'.repeat(16); const POLL = '77'.repeat(16);
const wire = (value: unknown): Uint8Array => importEncode(value as never);
const asBytes = (id: string) => fromHex(id); const toHex = (id: Uint8Array) => Array.from(id, byte => byte.toString(16).padStart(2, '0')).join('');
const supported = [3, 70, 71, 72, 73, 74, 75, 80, 81, 82, 83, 84].map(BigInt);
function pollSummary(over: Partial<PollSummary> = {}): PollSummary { return { id: POLL, channelId: CHANNEL, threadId: null, creatorId: USER, question: 'Lunch?', answers: ['Soup', 'Salad'], multi: true, createdAt: 1_800_000_000n, dueAt: 1_800_003_600n, closed: false, counts: [0n, 0n], myChoices: [], revision: 1n, ...over }; }
function pollWire(p: PollSummary): unknown[] { return [asBytes(p.id), asBytes(p.channelId), p.threadId === null ? null : asBytes(p.threadId), asBytes(p.creatorId), p.question, p.answers, p.multi ? 1n : 0n, p.createdAt, p.dueAt, p.closed ? 1n : 0n, p.counts, p.myChoices?.map(BigInt) ?? null, p.revision]; }
function utilityFixture() {
  const core = new FakeClient();
  core.set('account', ({ phase: 'ready', user: { id: USER, username: 'ada' }, deviceId: '88'.repeat(16), instance: { id: '99'.repeat(16), name: 'test', registrationMode: 0, passwordSignup: true, totp: false, passkeys: false }, recoveryKey: null, error: null, signIn: null, factorSetup: null, rootMismatch: null, ownTrust: [] } as never));
  core.set('communities', [{ id: COMMUNITY, name: 'Test', owner: USER }]); core.set(`permissions:${COMMUNITY}`, { loaded: true } as never);
  core.set(`channels:${COMMUNITY}`, [{ id: CHANNEL, communityId: COMMUNITY, kind: 0, mode: 0, name: 'lobby', topic: '', parentId: null, position: 0, slowmode: 0, announcement: false, group: 'active' }]);
  core.set(`members:${COMMUNITY}`, [{ userId: USER, username: 'ada', display: 'Ada', kind: 0, roleIds: [] }]);
  const requests: { operation: number; requestId: string; args: readonly unknown[] }[] = [];
  const responses: { deliveryId: string; requestId: string; communityId: string; operation: number; channelId: null; status: number; revision: string | null; data: Uint8Array }[] = [];
  let row = pollSummary(); let reminder: unknown[] | null = null; let delivery = 0; let failOperation: number | null = null; let failApplies = true;
  core.handler = command => Promise.resolve().then(() => {
    if (command.m === 'getBotCommandStatus') return { installationId: INSTALLATION, botUserId: BOT, state: 3, revision: '1' };
    if (command.m === 'humanInteractionRequest') {
      const operation = command.operation; const id = command.requestId; const args = command.args; requests.push({ operation, requestId: id, args });
      let data = wire([]); let revision: string | null = null; let status = 0;
      if (operation === 3) data = wire([1n, asBytes(INSTALLATION), asBytes(BOT), 1n, supported]);
      if (operation === 70) { const payload = decode(args[0] as Uint8Array) as unknown[]; const answers = payload[4] as string[];
        row = pollSummary({ id, channelId: toHex(payload[1] as Uint8Array), threadId: payload[2] === null ? null : toHex(payload[2] as Uint8Array), question: String(payload[3]), answers, multi: payload[5] === 1n, dueAt: 1_800_000_000n + BigInt(payload[6] as bigint) });
        data = wire([1n, pollWire(row)]); revision = '1'; }
      if (operation === 71) { data = wire([1n, pollWire(row)]); revision = row.revision.toString(); }
      if (operation === 72) data = wire([1n, [pollWire(row)], null]);
      if (operation === 73 && !(failOperation === operation && !failApplies)) { const choices = decode(args[1] as Uint8Array) as bigint[]; const next = row.revision + 1n;
        row = { ...row, revision: next, myChoices: choices.map(Number), counts: row.answers.map((_, index) => BigInt(choices.includes(BigInt(index)) ? 1 : 0)) };
        data = wire([1n, pollWire(row)]); revision = next.toString(); }
      if (operation === 74) { row = { ...row, closed: true, revision: row.revision + 1n }; data = wire([1n, pollWire(row)]); revision = row.revision.toString(); }
      if (operation === 75) data = wire([1n, [asBytes(USER)], null]);
      if (operation === 80) { const payload = decode(args[0] as Uint8Array) as unknown[];
        reminder = [asBytes(id), payload[3], BigInt(Math.floor(Date.now() / 1000)) + BigInt(payload[2] as bigint), payload[4], payload[5], payload[6], 0n, 1n]; data = wire([1n, reminder]); revision = '1'; }
      if (operation === 81) data = wire([1n, reminder === null ? [] : [reminder], null]);
      if (operation === 82 || operation === 83) if (reminder !== null && !(failOperation === operation && !failApplies)) { const next = BigInt(reminder[7] as bigint) + 1n; reminder = [...reminder.slice(0, 6), operation === 82 ? 2n : 3n, next]; data = wire([1n, reminder]); revision = String(next); }
      if (failOperation === operation) { status = 5; failOperation = null; failApplies = true; }
      responses.push({ deliveryId: String(++delivery), requestId: id, communityId: COMMUNITY, operation, channelId: null, status, revision, data });
      return { requestId: id, upload: 'accepted' };
    }
    if (command.m === 'readBotInteractionResponses') { const operations = command.operations as number[]; const ids = command.requestIds as string[] | undefined;
      return { responses: responses.filter(response => operations.includes(response.operation) && (ids === undefined || ids.includes(response.requestId))), through: null, blocked: false }; }
    if (command.m === 'ackBotInteractionResponses') return null; return null;
  });
  return { client: core, requests, get poll() { return row; }, get reminder() { return reminder; }, failNext(operation: number, apply = true) { failOperation = operation; failApplies = apply; },
    markReminderDue() { if (reminder !== null) reminder = [...reminder.slice(0, 2), BigInt(Math.floor(Date.now() / 1000)) - 60n, ...reminder.slice(3, 6), 1n, BigInt(reminder[7] as bigint) + 1n]; } };
}
function commandContext(client: CoreClient, requestId: string, over: Partial<CommandExecutionContext> = {}): CommandExecutionContext {
  const binding: Binding = { communityId: COMMUNITY, channelId: CHANNEL, bits: PERM.manageMessages };
  return { requestId, binding, getCurrentBinding: () => binding, isCurrent: () => true, client, getCall: () => ({} as never), call: {} as never,
    navigate: vi.fn(), openThread: vi.fn(), openSearch: vi.fn(), items: [], selfId: USER, encodeMessage: value => value, confirm: () => Promise.resolve(true), openInvite: () => Promise.resolve(true), openGif: vi.fn(), openModerationLog: vi.fn(), ...over };
}
function mount(client: CoreClient, community: string | null = COMMUNITY) { const captured: { value?: ReturnType<typeof useUtilityCommandProvider> } = {};
  function Probe() { const value = useUtilityCommandProvider(client, community); useEffect(() => { captured.value = value; }); return createElement('div', null, value.dialogs, value.inbox); }
  const view = render(createElement(Probe)); return { captured, ...view, rerenderProbe: () => view.rerender(createElement(Probe)) }; }
afterEach(() => { vi.restoreAllMocks(); });

describe('utility command provider', () => {
  it('publishes a poll through the adapter from the focused create dialog', async () => {
    const user = userEvent.setup(); const f = utilityFixture(); const mounted = mount(f.client); await waitFor(() => expect(mounted.captured.value).toBeDefined());
    let run!: Promise<unknown>; act(() => { run = mounted.captured.value!.handlers['poll create']!({ commandId: 'poll create', args: { question: 'Lunch?', answers: 'Soup, Salad', multiple: 'on' } }, commandContext(f.client, 'aa'.repeat(16))); });
    await screen.findByRole('heading', { name: 'Create a poll' }); await user.click(screen.getByRole('button', { name: 'Save' }));
    const result = await run; expect(result).toMatchObject({ status: 'success', private: true });
    expect(f.requests.filter(row => row.operation === 70)).toHaveLength(1);
    const created = f.requests.find(row => row.operation === 70)!; expect(created.requestId).toBe('aa'.repeat(16));
    expect(decode(created.args[0] as Uint8Array)).toMatchObject([1n, asBytes(CHANNEL), null, 'Lunch?', ['Soup', 'Salad'], 1n, 86_400n]);
    expect(f.poll.id).toBe('aa'.repeat(16)); mounted.unmount();
  });
  it('replaces a vote with the selected answer and reports the returned count', async () => {
    const f = utilityFixture(); const mounted = mount(f.client); await waitFor(() => expect(mounted.captured.value).toBeDefined());
    const result = await mounted.captured.value!.handlers['poll vote']!({ commandId: 'poll vote', args: { poll: POLL, choice: '2' } }, commandContext(f.client, 'bb'.repeat(16)));
    expect(result).toMatchObject({ status: 'success' }); const mutation = f.requests.find(row => row.operation === 73)!;
    expect(mutation.requestId).toBe('bb'.repeat(16)); expect(decode(mutation.args[1] as Uint8Array)).toEqual([1n]);
    expect(f.poll.myChoices).toEqual([1]); expect(f.poll.counts).toEqual([0n, 1n]); mounted.unmount();
  });
  it('requires an explicit DST fold choice before creating an ambiguous reminder', async () => {
    const user = userEvent.setup(); const f = utilityFixture(); const mounted = mount(f.client); await waitFor(() => expect(mounted.captured.value).toBeDefined());
    let run!: Promise<unknown>; act(() => { run = mounted.captured.value!.handlers.remind!({ commandId: 'remind', args: { when: '2026-11-01 01:30', text: 'Call home' } }, commandContext(f.client, 'cc'.repeat(16))); });
    await screen.findByRole('heading', { name: 'Set a reminder' }); await user.clear(screen.getByLabelText('Time zone')); await user.type(screen.getByLabelText('Time zone'), 'America/New_York');
    expect(await screen.findByText('This local time occurs twice. Choose which time you mean.')).toBeInTheDocument();
    const choices = screen.getAllByRole('radio'); expect(choices).toHaveLength(2); await user.click(choices[1]); await user.click(screen.getByRole('button', { name: 'Save' }));
    const result = await run; expect(result).toMatchObject({ status: 'success' }); const mutation = f.requests.find(row => row.operation === 80)!;
    expect(mutation.requestId).toBe('cc'.repeat(16)); const payload = decode(mutation.args[0] as Uint8Array) as unknown[];
    expect(payload[1]).toBe(1n); expect(payload[4]).toBe('America/New_York'); expect(payload[2]).toBe(1_793_514_600n); mounted.unmount();
  });

  it('shows due reminders in the inbox and reuses an uncertain dismissal attempt', async () => {
    const user = userEvent.setup(); const f = utilityFixture(); const mounted = mount(f.client);
    await waitFor(() => expect(mounted.captured.value).toBeDefined());
    await waitFor(() => expect(f.requests.some(row => row.operation === 81)).toBe(true));
    let create!: Promise<unknown>;
    act(() => { create = mounted.captured.value!.handlers.remind!({ commandId: 'remind', args: { when: 'in 1h', text: 'Call home' } }, commandContext(f.client, 'dd'.repeat(16))); });
    await screen.findByRole('heading', { name: 'Set a reminder' }); await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await create).toMatchObject({ status: 'success' });
    f.markReminderDue();
    await act(async () => { await mounted.captured.value!.handlers['reminders list']!({ commandId: 'reminders list', args: {} }, commandContext(f.client, 'ee'.repeat(16))); });
    await waitFor(() => expect(screen.getByRole('button', { name: /1 due/ })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Reminders/ }));
    expect(await screen.findByText('Call home')).toBeInTheDocument();
    f.failNext(83, false); await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(await screen.findByText('The change may have been saved. Refresh reminders before trying again.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(f.requests.filter(row => row.operation === 83)).toHaveLength(1));
    expect(f.requests.find(row => row.operation === 83)?.requestId).toMatch(/^[0-9a-f]{32}$/u);
    mounted.unmount();
  });

  it('keeps the reminders inbox available when no community composer is active', async () => {
    const f = utilityFixture(); const mounted = mount(f.client, null);
    await waitFor(() => expect(mounted.captured.value).toBeDefined());
    expect(screen.getByRole('button', { name: 'Reminders' })).toBeInTheDocument();
    expect(mounted.captured.value!.handlers.remind).toBeUndefined();
    mounted.unmount();
  });
  it('hides fetched reminder data immediately when the owner changes', async () => {
    const user = userEvent.setup(); const f = utilityFixture(); const mounted = mount(f.client);
    await waitFor(() => expect(mounted.captured.value).toBeDefined());
    let create!: Promise<unknown>;
    act(() => { create = mounted.captured.value!.handlers.remind!({ commandId: 'remind', args: { when: 'in 1h', text: 'Private account reminder' } }, commandContext(f.client, 'ff'.repeat(16))); });
    await screen.findByRole('heading', { name: 'Set a reminder' }); await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await create).toMatchObject({ status: 'success' }); f.markReminderDue();
    await act(async () => { await mounted.captured.value!.handlers['reminders list']!({ commandId: 'reminders list', args: {} }, commandContext(f.client, '01'.repeat(16))); });
    await user.click(screen.getByRole('button', { name: /Reminders/ }));
    expect(await screen.findByText('Private account reminder')).toBeInTheDocument();
    const nextAccount = { ...f.client.get('account')!, user: { ...f.client.get('account')!.user!, id: 'ab'.repeat(16) } };
    act(() => f.client.set('account', nextAccount)); mounted.rerenderProbe();
    expect(screen.queryByText('Private account reminder')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /1 due/ })).not.toBeInTheDocument();
    mounted.unmount();
  });
});

it('notifies a newly due reminder once, while honoring DND and visibility', () => {
  const f = utilityFixture(); const entry = { communityId: COMMUNITY, reminder: {
    id: 'ab'.repeat(16), communityId: COMMUNITY, text: 'Check the oven', createdAt: 1n, dueUnixSeconds: 2n,
    timezone: 'UTC', sourceChannelId: CHANNEL, sourceThreadId: null, state: 'due' as const, revision: 1n,
  } };
  const constructor = vi.fn(function NotificationMock() { return { onclick: null, close: vi.fn() }; });
  Object.assign(constructor, { permission: 'granted' }); vi.stubGlobal('Notification', constructor);
  f.client.set('settings', { 'notify.default': 'everything' });
  let visible: DocumentVisibilityState = 'hidden';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visible });
  const openInbox = vi.fn();
  const account = f.client.get('account')!;
  act(() => f.client.set('account', { ...account, presenceChoice: 'dnd' }));
  notifyReminder(entry, f.client, openInbox); expect(constructor).not.toHaveBeenCalled();
  act(() => f.client.set('account', { ...account, presenceChoice: 'online' }));
  visible = 'visible'; notifyReminder(entry, f.client, openInbox); expect(constructor).not.toHaveBeenCalled();
  visible = 'hidden'; notifyReminder(entry, f.client, openInbox); notifyReminder(entry, f.client, openInbox);
  expect(constructor).toHaveBeenCalledOnce();
  delete (document as Partial<Record<'visibilityState', unknown>>).visibilityState;
});

describe('poll card binding', () => {
  it('accepts only the exact final marker line', () => { const marker = `[dilla-poll:v1:${POLL}]`;
    expect(finalPollMarker(`note ${marker}\ntext`)).toBeNull(); expect(finalPollMarker(`${marker}\nanswer`)).toBeNull(); expect(finalPollMarker(`Question\n${marker}`)).toBe(POLL);
    expect(finalPollMarker(`Question\n${marker}\n`)).toBeNull(); expect(finalPollMarker(`Question\n[dilla-poll:v1:${'AB'.repeat(16)}]`)).toBeNull(); });
  it('rejects a human or edited marker before asking the Bot for any poll record', () => { const f = utilityFixture();
    const props = { client: f.client, communityId: COMMUNITY, channelId: CHANNEL, threadId: null, body: `[dilla-poll:v1:${POLL}]`, authorId: BOT, bot: false, edited: false, deleted: false, selfId: USER, bits: 0 };
    expect(render(createElement(PollCard, props)).container.firstChild).toBeNull(); expect(render(createElement(PollCard, { ...props, bot: true, edited: true })).container.firstChild).toBeNull(); expect(f.requests).toHaveLength(0); });
  it('rejects a bot marker when the authenticated author or backing thread does not match', async () => {
    const f = utilityFixture(); const props = { client: f.client, communityId: COMMUNITY, channelId: CHANNEL, threadId: null, body: `Lunch?\n[dilla-poll:v1:${POLL}]`, authorId: 'aa'.repeat(16), bot: true, edited: false, deleted: false, selfId: USER, bits: 0 };
    const { container } = render(createElement(PollCard, props)); expect(container.querySelector('section')).toBeNull(); await waitFor(() => expect(f.requests.some(row => row.operation === 3)).toBe(true)); expect(f.requests.some(row => row.operation === 71)).toBe(false);
    render(createElement(PollCard, { ...props, authorId: BOT, threadId: 'ee'.repeat(16) }));
    await waitFor(() => expect(f.requests.some(row => row.operation === 71)).toBe(true));
    expect(screen.queryByRole('heading', { name: 'Lunch?' })).not.toBeInTheDocument();
  });
  it('loads a bot-authored record and supports multivote replacement, withdrawal, voters and creator close', async () => {
    const user = userEvent.setup(); const f = utilityFixture();
    render(createElement(PollCard, { client: f.client, communityId: COMMUNITY, channelId: CHANNEL, threadId: null, body: `Lunch?\n[dilla-poll:v1:${POLL}]`, authorId: BOT, bot: true, edited: false, deleted: false, selfId: USER, bits: 0 }));
    expect(await screen.findByRole('heading', { name: 'Lunch?' })).toBeInTheDocument(); expect(f.requests.some(row => row.operation === 71)).toBe(true);
    await user.click(screen.getByRole('button', { name: '0 · Soup' })); expect(await screen.findByText('Ada')).toBeInTheDocument();
    const choices = screen.getAllByRole('checkbox'); await user.click(choices[0]); await user.click(choices[1]); await user.click(screen.getByRole('button', { name: 'Submit vote' }));
    await waitFor(() => expect(f.poll.myChoices).toEqual([0, 1]));
    await user.click(screen.getByRole('button', { name: 'Withdraw vote' })); await waitFor(() => expect(f.poll.myChoices).toEqual([]));
    await user.click(screen.getByRole('button', { name: 'Close poll' })); await waitFor(() => expect(f.poll.closed).toBe(true));
    expect(f.requests.filter(row => row.operation === 73).map(row => row.requestId)).toHaveLength(2); expect(f.requests.some(row => row.operation === 74)).toBe(true);
  });
  it('retries an uncertain poll vote with the same request id', async () => {
    const user = userEvent.setup(); const f = utilityFixture();
    render(createElement(PollCard, { client: f.client, communityId: COMMUNITY, channelId: CHANNEL, threadId: null, body: `Lunch?\n[dilla-poll:v1:${POLL}]`, authorId: BOT, bot: true, edited: false, deleted: false, selfId: USER, bits: 0 }));
    expect(await screen.findByRole('heading', { name: 'Lunch?' })).toBeInTheDocument();
    f.failNext(73, false);
    await user.click(screen.getByRole('button', { name: '0 · Soup' })); await user.click(screen.getByRole('button', { name: 'Submit vote' }));
    await screen.findByText('The vote result is uncertain. Refresh the poll before trying again.');
    const first = f.requests.find(row => row.operation === 73)!;
    await user.click(screen.getByRole('button', { name: 'Retry vote' }));
    await screen.findByText('The vote result is uncertain. Refresh the poll before trying again.');
    const mutations = f.requests.filter(row => row.operation === 73);
    expect(mutations.length).toBeGreaterThan(0); expect(mutations.every(row => row.requestId === first.requestId)).toBe(true);
  });
});

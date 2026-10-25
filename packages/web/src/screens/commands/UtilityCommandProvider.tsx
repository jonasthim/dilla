import { createElement, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Dialog } from '@dilla/ui';
import { BotUtilitiesError, BotUtilitiesProviderUnavailableError, BotUtilitiesStatusError, BotUtilitiesUncertainMutationError,
  createBotUtilities, encode, fromHex, parseReminderTime, resolveReminderTimeCandidate,
  type BotUtilities, type CoreClient, type ReminderSummary, type ReminderTimeResult } from '@dilla/client-core';
import { channelBitsOf, PERM, type CommandContext as Binding, type CommandInvocation, type CommandResult } from '@dilla/client-core';
import { shouldNotify, notificationCtor } from '../../notify.ts';
import { t } from '../../strings/index.ts';
import type { CommandExecutionContext, CommandProviderHandlers, CommandSuggestion, CommandSuggestionProvider } from './command-types.ts';
import { utilityText as copy } from './utility-copy.ts';
import './UtilityCards.css';

const DURATIONS: Readonly<Record<string, number>> = { '1h': 3600, '4h': 14_400, '8h': 28_800, '24h': 86_400, '3d': 259_200, '7d': 604_800 };
const hexID = /^[0-9a-f]{32}$/u;
const makeId = (): string => { const bytes = new Uint8Array(16); crypto.getRandomValues(bytes); if (bytes.every(x => x === 0)) bytes[0] = 1; return [...bytes].map(x => x.toString(16).padStart(2, '0')).join(''); };
const success = (message: string): CommandResult => ({ status: 'success', message, private: true });
const failure = (message: string): CommandResult => ({ status: 'failure', message, private: true });
const uncertain = (message: string): CommandResult => ({ status: 'uncertain', message, private: true });
const thread = (binding: Readonly<Binding>) => binding.threadId === undefined ? null : binding.threadId;
type CreateAttempt = { kind: string; scope: string; installationId: string; value: Record<string, unknown> };
const createAttempts = new WeakMap<CoreClient, Map<string, CreateAttempt>>();
const inboxAttempts = new WeakMap<CoreClient, Map<string, { id: string; revision: string; installationId: string }>>();
function inboxAttemptMap(client: CoreClient): Map<string, { id: string; revision: string; installationId: string }> {
  const found = inboxAttempts.get(client); if (found) return found;
  const created = new Map<string, { id: string; revision: string; installationId: string }>(); inboxAttempts.set(client, created); return created;
}
function createAttemptMap(client: CoreClient): Map<string, CreateAttempt> {
  const current = createAttempts.get(client); if (current) return current;
  const created = new Map<string, CreateAttempt>(); createAttempts.set(client, created); return created;
}
function executionScope(context: CommandExecutionContext): string {
  const account = context.client.get('account');
  return [account?.instance?.id ?? '', account?.user?.id ?? '', account?.deviceId ?? '', context.binding.communityId ?? '', context.binding.channelId ?? '', thread(context.binding) ?? ''].join(':');
}
function canCreateFromContext(context: CommandExecutionContext, communityId: string): boolean {
  const current = context.getCurrentBinding();
  return context.isCurrent() && current.communityId === communityId && current.channelId !== null
    && current.channelId === context.binding.channelId && ((current.bits ?? 0) & PERM.sendMessages) !== 0;
}
function pollPublished(context: CommandExecutionContext, pollId: string, channelId: string, threadId: string | null, botId: string): boolean {
  return context.items.some(item => item.state === 'ok' && !item.edited && item.senderUser === botId && item.bot
    && finalMarker(item.body) === pollId && (threadId === null ? item.reply?.threadRoot == null : item.reply?.threadRoot === threadId)
    && item.msgId !== null && item.body.split(/\r?\n/u).at(-1) === `[dilla-poll:v1:${pollId}]`);
}
function finalMarker(body: string): string | null {
  const value = body.split(/\r?\n/u).at(-1) ?? '';
  const match = /^\[dilla-poll:v1:([0-9a-f]{32})\]$/u.exec(value);
  return match?.[1] ?? null;
}
const caught = (error: unknown, kind: 'poll' | 'reminder' = 'poll'): CommandResult => {
  if (error instanceof BotUtilitiesUncertainMutationError) return uncertain(copy(kind === 'poll' ? 'poll.createdUncertain' : 'reminder.uncertain'));
  if (error instanceof BotUtilitiesProviderUnavailableError) return failure('The Bot is unavailable in this community.');
  if (error instanceof BotUtilitiesStatusError) {
    if (error.status === 4) return failure('The record changed. Refresh it and try again.');
    if (error.status === 2 || error.status === 3) return failure('This action is no longer available.');
  }
  const code = error instanceof BotUtilitiesError ? error.code : '';
  return failure(code === 'poll-payload-too-large' ? 'The answers use too much space. Shorten them and try again.' : 'Check the fields and try again.');
};

export interface UtilityDialogBase { isCurrent(): boolean; onCancel(): void; }
export type UtilityDialogInput =
  | { kind: 'poll'; question: string; answers: string; multi: boolean; duration: string; channelId: string; threadId: string | null }
  | { kind: 'reminder'; when: string; text: string; timezone: string; chosen?: number };
export type UtilityDialogState =
  | (UtilityDialogBase & { kind: 'poll'; question: string; answers: string; multi: boolean; duration: string; channelId: string; threadId: string | null; onSubmit(value: { question: string; answers: string[]; multi: boolean; duration: number }): void })
  | (UtilityDialogBase & { kind: 'reminder'; when: string; text: string; timezone: string; chosen?: number; onSubmit(value: { when: string; text: string; timezone: string; result: Extract<ReminderTimeResult, { kind: 'valid' }> }): void });

export function UtilityCommandDialogs({ dialog }: { dialog: UtilityDialogState | null }): React.JSX.Element | null {
  useEffect(() => {
    if (dialog === null) return;
    const timer = window.setInterval(() => { if (!dialog.isCurrent()) dialog.onCancel(); }, 100);
    return () => window.clearInterval(timer);
  }, [dialog]);
  if (dialog === null) return null;
  return dialog.kind === 'poll' ? <PollCreateDialog key="poll" dialog={dialog} /> : <ReminderCreateDialog key="reminder" dialog={dialog} />;
}
function PollCreateDialog({ dialog }: { dialog: Extract<UtilityDialogState, { kind: 'poll' }> }): React.JSX.Element {
  const [question, setQuestion] = useState(dialog.question); const [answers, setAnswers] = useState(dialog.answers);
  const [multi, setMulti] = useState(dialog.multi); const [duration, setDuration] = useState(dialog.duration); const [error, setError] = useState('');
  const lines = answers.split(/\r?\n/u).map(value => value.trim());
  let bytes: number | null = null; let aggregateError = false;
  if (duration in DURATIONS && question.trim() !== '' && lines.length >= 2 && lines.length <= 10 && lines.every(value => value !== '')) {
    try { bytes = encode([1n, fromHex(dialog.channelId), dialog.threadId === null ? null : fromHex(dialog.threadId), question.trim(), lines, multi ? 1n : 0n, BigInt(DURATIONS[duration]) ]).length; aggregateError = bytes > 1800; }
    catch { aggregateError = new TextEncoder().encode(question + lines.join('')).length > 1600; }
  }
  const liveError = question.trim() === '' || Array.from(question).length > 300 || lines.length < 2 || lines.length > 10
    || lines.some(value => value === '' || Array.from(value).length > 100) || new Set(lines).size !== lines.length || !(duration in DURATIONS)
    ? copy('poll.validation') : aggregateError ? 'Poll answers exceed the 1800 byte limit. Shorten them before publishing.' : '';
  const submit = () => {
    if (liveError !== '') { setError(liveError); return; }
    dialog.onSubmit({ question: question.trim(), answers: lines, multi, duration: DURATIONS[duration] });
  };
  return <Dialog open title={copy('poll.createTitle')} closeLabel={t('dialog.close')} onClose={() => dialog.onCancel()}
    footer={<><Button onClick={() => dialog.onCancel()}>{t('chperm.cancel')}</Button><Button variant="accent" onClick={submit}>{t('botCommand.save')}</Button></>}>
    <label>{copy('poll.question')}<textarea value={question} onChange={event => {
      const next = event.currentTarget.value;
      if (Array.from(next).length <= 300) setQuestion(next);
    }} data-autofocus /></label>
    <p>{copy('poll.charCount', { current: Array.from(question).length, limit: 300 })}</p>
    <label>{copy('poll.answers')}<textarea value={answers} onChange={event => setAnswers(event.currentTarget.value)} /></label><p>{copy('poll.answerHelp')}</p>
    <p>{copy('poll.byteCount', { current: bytes ?? new TextEncoder().encode(question + lines.join('')).length, limit: 1800 })}{aggregateError ? <span role="alert">Poll answers exceed the 1800 byte limit.</span> : null}</p>
    <label><input type="checkbox" checked={multi} onChange={event => setMulti(event.currentTarget.checked)} />{copy('poll.multiple')}</label>
    <label>{copy('poll.duration')}<select value={duration} onChange={event => setDuration(event.currentTarget.value)}>
      {Object.keys(DURATIONS).map(value => <option key={value} value={value}>{value}</option>)}</select></label>
    {error ? <p role="alert">{error}</p> : null}
  </Dialog>;
}
function ReminderCreateDialog({ dialog }: { dialog: Extract<UtilityDialogState, { kind: 'reminder' }> }): React.JSX.Element {
  const [when, setWhen] = useState(dialog.when); const [text, setText] = useState(dialog.text); const [timezone, setTimezone] = useState(dialog.timezone);
  const [chosen, setChosen] = useState<number | null>(dialog.chosen ?? null); const [error, setError] = useState(''); const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 15_000); return () => window.clearInterval(timer); }, []);
  const parsed = useMemo(() => parseReminderTime(when.trim().replace(/^in\s+/iu, ''), timezone, now), [when, timezone, now]);
  const resolved = parsed.kind === 'ambiguous' && chosen !== null ? resolveReminderTimeCandidate(parsed, chosen, now) : parsed;
  const textBytes = new TextEncoder().encode(text).length;
  const submit = () => {
    if (text.trim() === '' || textBytes > 1500 || resolved.kind !== 'valid') { setError(resolved.kind === 'ambiguous' ? copy('reminder.ambiguous') : copy('reminder.invalid')); return; }
    dialog.onSubmit({ when, text: text.trim(), timezone, result: resolved });
  };
  return <Dialog open title={copy('reminder.createTitle')} closeLabel={t('dialog.close')} onClose={() => dialog.onCancel()}
    footer={<><Button onClick={() => dialog.onCancel()}>{t('chperm.cancel')}</Button><Button variant="accent" onClick={submit}>{t('botCommand.save')}</Button></>}>
    <label>{copy('reminder.when')}<input value={when} onChange={event => { setWhen(event.currentTarget.value); setChosen(null); }} data-autofocus placeholder="in 2h or 2026-10-26 09:00" /></label>
    <label>{copy('reminder.timezone')}<input value={timezone} onChange={event => { setTimezone(event.currentTarget.value); setChosen(null); }} /></label>
    <label>{copy('reminder.text')}<textarea value={text} onChange={event => setText(event.currentTarget.value)} /></label><p>{copy('reminder.byteCount', { current: textBytes, limit: 1500 })}</p>
    {resolved.kind === 'valid' ? <p aria-live="polite">{copy('reminder.preview', { preview: resolved.preview })}</p> : null}
    {parsed.kind === 'ambiguous' ? <fieldset><legend>{copy('reminder.ambiguous')}</legend>{parsed.candidates.map((candidate, index) => <label key={candidate.unixSeconds}>
      <input type="radio" name="reminder-fold" checked={chosen === candidate.unixSeconds} onChange={() => setChosen(candidate.unixSeconds)} />
      {copy(index === 0 ? 'reminder.earlier' : 'reminder.later', { offset: candidate.offsetLabel })} · {candidate.preview}</label>)}</fieldset> : null}
    {error ? <p role="alert">{error}</p> : null}
  </Dialog>;
}

export interface ReminderInboxEntry { communityId: string; reminder: ReminderSummary; }
export type UtilityNavigate = (communityId: string, channelId: string, threadId: string | null) => void;
function sourceAccessible(client: CoreClient, communityId: string, channelId: string | null): boolean {
  if (channelId === null) return false;
  const community = client.get('communities')?.find(row => row.id === communityId);
  const channel = client.get(`channels:${communityId}`)?.find(row => row.id === channelId);
  const account = client.get('account'); const access = client.get(`permissions:${communityId}`);
  const roles = client.get(`roles:${communityId}`); const members = client.get(`members:${communityId}`); const overwrites = client.get(`overwrites:${communityId}`);
  if (community === undefined || channel?.kind !== 0 || channel.group !== 'active' || account?.user === null || account?.user === undefined
    || access === undefined || !access.loaded || !access.overwritesLoaded || access.everyoneId === '' || roles === undefined || members === undefined || overwrites === undefined) return false;
  const bits = channelBitsOf({ owner: community.owner, everyoneId: access.everyoneId, roles, members, overwrites: overwrites[channelId] ?? [] }, account.user.id);
  return bits !== null && (bits & PERM.viewChannel) !== 0;
}
export function useUtilityCommandProvider(client: CoreClient, communityId: string | null, onNavigate?: UtilityNavigate): {
  handlers: CommandProviderHandlers; suggest: CommandSuggestionProvider; dialogs: ReactNode; inbox: ReactNode; dueCount: number;
} {
  const account = client.get('account');
  const ownerKey = account?.instance?.id && account.user?.id && account.deviceId ? `${account.instance.id}:${account.user.id}:${account.deviceId}` : '';
  const liveScope = useRef({ client, ownerKey, communityId });
  liveScope.current = { client, ownerKey, communityId };
  const [dialog, setDialog] = useState<UtilityDialogState | null>(null);
  const [dialogScope, setDialogScope] = useState<{ client: CoreClient; owner: string; communityId: string | null } | null>(null);
  const resolveDialog = useRef<((value: unknown) => void) | null>(null);
  const cancelDialog = useRef<(() => void) | null>(null);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [records, setRecords] = useState<{ client: CoreClient; owner: string; rows: ReminderInboxEntry[]; loading: boolean; error: boolean } | null>(null);
  const [pausedCommunities, setPausedCommunities] = useState<Map<string, string>>(() => new Map());
  const [sourceAccessVersion, setSourceAccessVersion] = useState(0);
  const joinedCommunityKey = (client.get('communities') ?? []).map(row => row.id).sort().join(':');
  const [observedCommunities, setObservedCommunities] = useState(joinedCommunityKey);
  useEffect(() => client.subscribe('communities', () => setObservedCommunities((client.get('communities') ?? []).map(row => row.id).sort().join(':'))), [client]);
  useEffect(() => {
    const ids = joinedCommunityKey.split(':').filter(Boolean);
    const keys = ids.flatMap(id => [`channels:${id}` as const, `permissions:${id}` as const, `roles:${id}` as const, `members:${id}` as const, `overwrites:${id}` as const]);
    const off = keys.map(key => client.subscribe(key, () => setSourceAccessVersion(value => value + 1)));
    return () => { for (const unsubscribe of off) unsubscribe(); };
  }, [client, joinedCommunityKey]);
  const currentRecords = useMemo(() => {
    const liveCommunityIds = new Set(joinedCommunityKey.split(':').filter(Boolean));
    return records?.client === client && records.owner === ownerKey ? records.rows.filter(row => liveCommunityIds.has(row.communityId)) : [];
  }, [client, joinedCommunityKey, ownerKey, records]);

  const knownDue = useRef<{ owner: string; ids: Set<string> } | null>(null);
  const fetchToken = useRef(0);
  const utilityFor = useCallback((id: string) => createBotUtilities(client, id), [client]);
  const fetchInbox = useCallback(async (showLoading = false, retryPaused = false) => {
    if (ownerKey === '' || observedCommunities !== joinedCommunityKey) { setRecords(null); return []; }
    const token = ++fetchToken.current; const currentOwner = ownerKey;
    const joined = (client.get('communities') ?? []).slice();
    if (retryPaused) setPausedCommunities(new Map());
    if (showLoading) setRecords({ client, owner: currentOwner, rows: [], loading: true, error: false });
    const next: ReminderInboxEntry[] = []; let failed = false; const unavailable = new Set<string>();
    const pauseKey = `${currentOwner}:${joinedCommunityKey}`;
    for (const [index, community] of joined.entries()) {
      if (token !== fetchToken.current || liveScope.current.client !== client || liveScope.current.ownerKey !== currentOwner) return [];
      if (!retryPaused && pausedCommunities.get(community.id) === pauseKey) continue;
      if (index > 0) await new Promise(resolve => window.setTimeout(resolve, Math.min(index * 120, 900)));
      const staged: ReminderInboxEntry[] = [];
      try {
        const utility = utilityFor(community.id); const caps = await utility.capabilities();
        if (!caps.supportedOperations.includes(81)) { unavailable.add(community.id); continue; }
        let cursor: Uint8Array | null = null;
        for (let page = 0; page < 5; page++) {
          const result = await utility.reminderList(cursor);
          staged.push(...result.items.filter(item => item.state === 'scheduled' || item.state === 'due').map(reminder => ({ communityId: community.id, reminder })));
          cursor = result.nextCursor; if (cursor === null) break;
        }
        if (cursor !== null) { failed = true; continue; }
        if (token !== fetchToken.current || liveScope.current.client !== client || liveScope.current.ownerKey !== currentOwner
          || !(client.get('communities') ?? []).some(row => row.id === community.id)) return [];
        next.push(...staged);
      } catch (error) {
        if (error instanceof BotUtilitiesProviderUnavailableError || (error instanceof BotUtilitiesStatusError && (error.status === 2 || error.status === 3))) unavailable.add(community.id);
        else failed = true;
        // This community is deliberately absent: disabled or inaccessible private data never stays visible.
      }
    }
    if (token !== fetchToken.current || liveScope.current.client !== client || liveScope.current.ownerKey !== currentOwner) return [];
    setPausedCommunities(previous => {
      const currentIds = new Set(joined.map(row => row.id));
      const nextPaused = retryPaused ? new Map<string, string>() : new Map([...previous].filter(([id]) => currentIds.has(id)));
      let changed = nextPaused.size !== previous.size;
      for (const id of unavailable) {
        if (nextPaused.get(id) !== pauseKey) { nextPaused.set(id, pauseKey); changed = true; }
      }
      if (retryPaused && previous.size > 0) changed = true;
      return changed ? nextPaused : previous;
    });
    const ordered = next.sort((a, b) => Number(a.reminder.dueUnixSeconds - b.reminder.dueUnixSeconds));
    const previous = knownDue.current?.owner === currentOwner ? knownDue.current.ids : null;
    const seen = new Set(previous ?? []);
    if (previous !== null) for (const entry of ordered) if (entry.reminder.state === 'due' && !seen.has(entry.reminder.id)) notifyReminder(entry, client, () => setInboxOpen(true));
    for (const entry of ordered) if (entry.reminder.state === 'due') seen.add(entry.reminder.id);
    knownDue.current = { owner: currentOwner, ids: seen };
    setRecords({ client, owner: currentOwner, rows: ordered, loading: false, error: failed }); return ordered;
  }, [client, ownerKey, utilityFor, joinedCommunityKey, observedCommunities, pausedCommunities]);
  useEffect(() => {
    if (ownerKey === '') { fetchToken.current++; knownDue.current = null; setRecords(null); return; }
    knownDue.current = null;
    let stopped = false; let running = false; let queued = false; let timer = 0;
    let availabilityTicks = 0;
    const poll = async (initial = false): Promise<void> => {
      if (stopped) return;
      if (running) { queued = true; return; }
      running = true; availabilityTicks++; await fetchInbox(initial, availabilityTicks % 5 === 0); running = false;
      if (stopped) return;
      if (queued) { queued = false; void poll(); }
      else timer = window.setTimeout(() => { void poll(); }, 60_000);
    };
    void poll(true);
    const onVisible = () => { if (document.visibilityState === 'visible') void poll(); };
    document.addEventListener('visibilitychange', onVisible);
    const token = fetchToken;
    return () => { stopped = true; token.current++; window.clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [ownerKey, fetchInbox]);
  const openDialog = useCallback((state: UtilityDialogInput, context: CommandExecutionContext, installationId: string, operation: 70 | 80) => new Promise<unknown>(resolve => {
    if (liveScope.current.client !== client || liveScope.current.ownerKey === '' || !context.isCurrent()) { resolve(null); return; }
    cancelDialog.current?.();
    const scope = { client, owner: liveScope.current.ownerKey, communityId };
    setDialogScope(scope);
    resolveDialog.current = resolve;
    const capturedBinding = context.binding;
    const isScopeCurrent = () => {
      const current = context.getCurrentBinding();
      return liveScope.current.client === scope.client && liveScope.current.ownerKey === scope.owner && liveScope.current.communityId === scope.communityId
        && current.communityId === communityId && current.channelId === capturedBinding.channelId && current.channelId !== null
        && ((current.bits ?? 0) & PERM.sendMessages) !== 0 && context.isCurrent();
    };
    let timer = 0; let capabilityProbe = 0; let settled = false;
    const finish = (value: unknown) => {
      if (settled) return; settled = true; window.clearInterval(timer);
      if (resolveDialog.current === resolve) { resolveDialog.current = null; cancelDialog.current = null; setDialog(null); setDialogScope(null); }
      resolve(value);
    };
    const cancel = () => finish(null);
    cancelDialog.current = cancel;
    timer = window.setInterval(() => {
      if (!isScopeCurrent()) { cancel(); return; }
      capabilityProbe++;
      if (capabilityProbe % 10 === 0 && communityId !== null) void utilityFor(communityId).capabilities().then(caps => {
        if (!isScopeCurrent() || caps.installationId !== installationId || !caps.supportedOperations.includes(operation)) cancel();
      }).catch(cancel);
    }, 100);
    const submit = (value: unknown) => { if (!isScopeCurrent()) { cancel(); return; } finish(value); };
    setDialog({ ...state, isCurrent: isScopeCurrent, onCancel: cancel, onSubmit: submit });
  }), [client, communityId, utilityFor]);
  useEffect(() => {
    if (dialogScope === null || (dialogScope.client === client && dialogScope.owner === ownerKey && dialogScope.communityId === communityId)) return;
    cancelDialog.current?.();
  }, [client, communityId, dialogScope, ownerKey]);
  useEffect(() => () => { fetchToken.current++; cancelDialog.current?.(); }, []);
  const refreshRequestId = useCallback(() => { void fetchInbox(); }, [fetchInbox]);
  const open = useCallback(async (state: UtilityDialogInput, context: CommandExecutionContext) => {
    if (communityId === null || !canCreateFromContext(context, communityId)) return null;
    const operation = state.kind === 'poll' ? 70 : 80;
    try {
      const caps = await utilityFor(communityId).capabilities();
      if (!canCreateFromContext(context, communityId) || !caps.supportedOperations.includes(operation)) return null;
      const value = await openDialog(state, context, caps.installationId, operation);
      return context.isCurrent() ? value : null;
    } catch { return null; }
  }, [communityId, openDialog, utilityFor]);
  const commandHandlers = useMemo<CommandProviderHandlers>(() => {
    if (communityId === null) return {};
    const handlers: Record<string, (invocation: CommandInvocation, context: CommandExecutionContext) => Promise<CommandResult>> = {};
    handlers['poll create'] = async (invocation, context) => {
      const scope = executionScope(context); const attempts = createAttemptMap(client); const prior = attempts.get(context.requestId);
      if (prior && (prior.kind !== 'poll' || prior.scope !== scope)) return uncertain(copy('poll.createdUncertain'));
      if (!canCreateFromContext(context, communityId) || !context.binding.channelId) return prior ? uncertain(copy('poll.createdUncertain')) : failure('Create a poll in a community channel.');
      let utility: BotUtilities; let caps;
      try { utility = utilityFor(communityId); caps = await utility.capabilities(); }
      catch (error) { return prior ? uncertain(copy('poll.createdUncertain')) : caught(error); }
      if (!canCreateFromContext(context, communityId) || !caps.supportedOperations.includes(70)) return prior ? uncertain(copy('poll.createdUncertain')) : failure('The Bot cannot create polls in this channel.');
      if (prior && prior.installationId !== caps.installationId) return uncertain(copy('poll.createdUncertain'));
      const answers = invocation.args.answers ?? '';
      const saved = prior?.value as { question: string; answers: string[]; multi: boolean; duration: number } | undefined;
      if (prior) {
        try {
          const receipt = await utility.read(context.requestId, 70);
          if (receipt?.status === 4) { attempts.delete(context.requestId); return failure('Poll creation was rejected. Start a new poll command.'); }
          const poll = await utility.pollGet(context.requestId, { channelId: context.binding.channelId, threadId: thread(context.binding) });
          if (poll.question === saved?.question && poll.answers.join('\u0000') === saved?.answers.join('\u0000')
            && poll.multi === saved?.multi && pollPublished(context, poll.id, context.binding.channelId, thread(context.binding), caps.botUserId)) {
            attempts.delete(context.requestId); return success(copy('poll.created') + ` ${poll.id}`);
          }
          if (receipt?.status === 0 || (receipt !== null && receipt?.status !== 5)) return uncertain(copy('poll.createdUncertain'));
        } catch { return uncertain(copy('poll.createdUncertain')); }
      }
      // A retained mutation is immutable. Reopening its fields would imply that edits are
      // part of the retry even though the original request ID is body-bound.
      const raw = saved ?? await open({ kind: 'poll', question: invocation.args.question ?? '', answers: answers.replace(/\s*,\s*/gu, '\n'), multi: invocation.args.multiple === 'on', duration: invocation.args.duration ?? '24h', channelId: context.binding.channelId, threadId: thread(context.binding) }, context) as { question: string; answers: string[]; multi: boolean; duration: number } | null;
      if (raw === null) return prior ? uncertain(copy('poll.createdUncertain')) : failure('Poll creation cancelled.');
      const submitted = saved ?? raw;
      const attempt = prior ?? { kind: 'poll' as const, scope, installationId: caps.installationId, value: { ...raw, answers: [...raw.answers] } };
      attempts.set(context.requestId, attempt);
      try { if (!canCreateFromContext(context, communityId)) return uncertain(copy('poll.createdUncertain'));
        const poll = await utility.pollCreate({ requestId: context.requestId, channelId: context.binding.channelId, threadId: thread(context.binding), question: submitted.question, answers: submitted.answers, multi: submitted.multi, durationSeconds: submitted.duration });
        attempts.delete(context.requestId);
        return success(copy('poll.created') + ` ${poll.id}`);
      } catch (error) {
        if (error instanceof BotUtilitiesStatusError && (error.status === 4 || (!prior && error.status !== 5))) attempts.delete(context.requestId);
        return caught(error);
      }
    };
    for (const id of ['poll vote', 'poll results', 'poll close']) handlers[id] = async (invocation, context) => {
      const attempts = createAttemptMap(client); const scope = executionScope(context); const prior = attempts.get(context.requestId);
      if (prior && (prior.kind !== id || prior.scope !== scope)) return uncertain(copy('poll.uncertain'));
      if (!context.isCurrent() || context.binding.communityId !== communityId) return prior ? uncertain(copy('poll.uncertain')) : failure('The conversation changed.');
      const pollId = invocation.args.poll;
      const saved = prior?.value as { pollId: string; channelId: string; threadId: string | null; revision: string; choices?: number[] } | undefined;
      if ((!pollId || !hexID.test(pollId)) && !saved) return failure('Choose a poll from this conversation.');
      try {
        const utility = utilityFor(communityId); const operation = id === 'poll close' ? 74 : id === 'poll results' ? 71 : 73;
        const caps = await utility.capabilities();
        if (prior && prior.installationId !== caps.installationId) return uncertain(copy('poll.uncertain'));
        if (prior) {
          const status = await utility.read(context.requestId, operation);
          if (status?.status === 0) { attempts.delete(context.requestId); return success(id === 'poll close' ? copy('poll.closed') : 'Vote saved.'); }
          if (status?.status === 4) { attempts.delete(context.requestId); return failure(copy('poll.conflict')); }
          if (status?.status === 2 || status?.status === 3) return uncertain(copy('poll.uncertain'));
        }
        if (!caps.supportedOperations.includes(operation)) return prior ? uncertain(copy('poll.uncertain')) : failure('The Bot cannot update this poll.');
        const poll = await utility.pollGet(saved?.pollId ?? pollId, { channelId: saved?.channelId ?? context.binding.channelId, threadId: saved?.threadId ?? thread(context.binding) });
        if (id === 'poll results') return success(copy('poll.results', { question: poll.question, answers: poll.answers.map((answer, i) => `${answer}: ${poll.counts[i]}`).join('\n') }));
        if (id === 'poll close') {
          if (poll.creatorId !== context.selfId && ((context.getCurrentBinding().bits ?? 0) & PERM.manageMessages) === 0) return prior ? uncertain(copy('poll.uncertain')) : failure('You cannot close this poll.');
          const input = saved ?? { pollId: poll.id, channelId: poll.channelId, threadId: poll.threadId, revision: poll.revision.toString() };
          if (!context.isCurrent()) return prior ? uncertain(copy('poll.uncertain')) : failure('The conversation changed.');
          attempts.set(context.requestId, prior ?? { kind: id, scope, installationId: caps.installationId, value: input });
          await utility.pollClose({ requestId: context.requestId, ...input });
          attempts.delete(context.requestId);
          return success(copy('poll.closed'));
        }
        const choices = (invocation.args.choice ?? '').split(',').map(value => value.trim()).filter(Boolean);
        const indexes = choices.map(value => { const numeric = Number(value); if (Number.isInteger(numeric) && numeric >= 1 && numeric <= poll.answers.length) return numeric - 1; return poll.answers.findIndex(answer => answer.toLocaleLowerCase() === value.toLocaleLowerCase()); });
        if (!prior && (indexes.length === 0 || indexes.some(index => index < 0) || (!poll.multi && indexes.length > 1))) return failure('Choose one or more answer names, separated by commas.');
        if (prior && saved?.choices === undefined) return uncertain(copy('poll.uncertain'));
        const input = { pollId: saved?.pollId ?? poll.id, channelId: saved?.channelId ?? poll.channelId, threadId: saved?.threadId ?? poll.threadId,
          revision: saved?.revision ?? poll.revision.toString(), choices: saved?.choices ?? indexes };
        if (!context.isCurrent()) return prior ? uncertain(copy('poll.uncertain')) : failure('The conversation changed.');
        attempts.set(context.requestId, prior ?? { kind: id, scope, installationId: caps.installationId, value: input });
        const updated = await utility.pollVote({ requestId: context.requestId, ...input });
        attempts.delete(context.requestId);
        return success(`Vote saved. ${updated.answers.map((answer, i) => `${answer}: ${updated.counts[i]}`).join(', ')}`);
      } catch (error) {
        const pending = createAttemptMap(client).get(context.requestId);
        if (error instanceof BotUtilitiesStatusError && (error.status === 4 || (pending === undefined && error.status !== 5))) createAttemptMap(client).delete(context.requestId);
        if (prior && error instanceof BotUtilitiesStatusError && error.status === 4) return failure(id === 'poll close' ? copy('poll.closeConflict') : copy('poll.conflict'));
        return prior ? uncertain(copy('poll.uncertain')) : caught(error);
      }
    };
    handlers.remind = async (invocation, context) => {
      const scope = executionScope(context); const attempts = createAttemptMap(client); const prior = attempts.get(context.requestId);
      if (prior && (prior.kind !== 'reminder' || prior.scope !== scope)) return uncertain(copy('reminder.uncertain'));
      if (!canCreateFromContext(context, communityId)) return prior ? uncertain(copy('reminder.uncertain')) : failure('Set reminders in a Bot-enabled community.');
      let utility: BotUtilities; let caps;
      try { utility = utilityFor(communityId); caps = await utility.capabilities(); }
      catch (error) { return prior ? uncertain(copy('reminder.uncertain')) : caught(error, 'reminder'); }
      if (!canCreateFromContext(context, communityId) || !caps.supportedOperations.includes(80)) return prior ? uncertain(copy('reminder.uncertain')) : failure('Reminders are unavailable in this channel.');
      if (prior && prior.installationId !== caps.installationId) return uncertain(copy('reminder.uncertain'));
      const saved = prior?.value as { when: string; text: string; timezone: string; result: Extract<ReminderTimeResult, { kind: 'valid' }> } | undefined;
      if (prior) {
        try {
          const receipt = await utility.read(context.requestId, 80);
          if (receipt?.status === 4) { attempts.delete(context.requestId); return failure(copy('reminder.conflict')); }
          let cursor: Uint8Array | null = null; let found: ReminderSummary | undefined;
          for (let page = 0; page < 5; page++) { const result = await utility.reminderList(cursor); found = result.items.find(item => item.id === context.requestId); if (found) break; cursor = result.nextCursor; if (cursor === null) break; }
          const sourceMatches = found?.sourceChannelId === context.binding.channelId && found.sourceThreadId === thread(context.binding)
            || found?.sourceChannelId === null && found.sourceThreadId === null;
          if (found && found.text === saved?.text && found.timezone === saved?.timezone && sourceMatches) {
            attempts.delete(context.requestId); refreshRequestId(); return success(`${copy('reminder.created')} ${found.id}`);
          }
          if (receipt?.status === 0 || (receipt !== null && receipt?.status !== 5)) return uncertain(copy('reminder.uncertain'));
        } catch { return uncertain(copy('reminder.uncertain')); }
      }
      const value = await open({ kind: 'reminder', when: invocation.args.when, text: invocation.args.text, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }, context) as { when: string; text: string; timezone: string; result: Extract<ReminderTimeResult, { kind: 'valid' }> } | null;
      if (value === null) return prior ? uncertain(copy('reminder.uncertain')) : failure('Reminder creation cancelled.');
      const submitted = saved ?? value;
      attempts.set(context.requestId, prior ?? { kind: 'reminder', scope, installationId: caps.installationId,
        value: { when: submitted.when, text: submitted.text, timezone: submitted.timezone, result: submitted.result } });
      try {
        if (!canCreateFromContext(context, communityId)) return uncertain(copy('reminder.uncertain'));
        const reminder = await utility.reminderCreate({ requestId: context.requestId,
          whenKind: submitted.result.mode === 'relative' ? 0 : 1,
          when: submitted.result.mode === 'relative' ? submitted.result.seconds : submitted.result.unixSeconds,
          text: submitted.text, timezone: submitted.timezone, sourceChannelId: context.binding.channelId, sourceThreadId: thread(context.binding) });
        attempts.delete(context.requestId);
        refreshRequestId(); return success(`${copy('reminder.created')} ${reminder.id}`);
      } catch (error) {
        if (error instanceof BotUtilitiesStatusError && (error.status === 4 || (!prior && error.status !== 5))) attempts.delete(context.requestId);
        return caught(error, 'reminder');
      }
    };
    handlers['reminders list'] = async (_invocation, context) => {
      if (!context.isCurrent()) return failure('The conversation changed.');
      const rows = (await fetchInbox(true, true)).filter(row => row.reminder.state === 'scheduled' || row.reminder.state === 'due');
      if (!context.isCurrent()) return failure('The conversation changed.');
      if (rows.length === 0) return success(copy('reminder.empty'));
      return success(copy('reminder.list', { count: rows.length, items: rows.slice(0, 12).map(row => `${row.reminder.id}: ${row.reminder.text}`).join('; ') }));
    };
    for (const id of ['reminders cancel', 'reminders dismiss']) handlers[id] = async (invocation, context) => {
      const operation = id === 'reminders cancel' ? 82 : 83; const attempts = createAttemptMap(client);
      const prior = attempts.get(context.requestId); const saved = prior?.value as { communityId: string; reminderId: string; revision: string } | undefined;
      if (prior && (prior.kind !== id || !saved)) return uncertain(copy('reminder.uncertainMutation'));
      if (!context.isCurrent()) return prior ? uncertain(copy('reminder.uncertainMutation')) : failure('The conversation changed.');
      const target = invocation.args.reminder;
      try {
        const row = prior === undefined ? (await fetchInbox(true, true)).find(item => item.reminder.id === target) : undefined;
        if (!prior && !row) return failure('Choose one of your accessible reminders.');
        const community = saved?.communityId ?? row!.communityId;
        const scope = `${executionScope(context)}:${community}:${saved?.reminderId ?? row!.reminder.id}:${id}`;
        if (prior && prior.scope !== scope) return uncertain(copy('reminder.uncertainMutation'));
        const utility = utilityFor(community); const caps = await utility.capabilities();
        if (prior && prior.installationId !== caps.installationId) return uncertain(copy('reminder.uncertainMutation'));
        if (prior) {
          const status = await utility.read(context.requestId, operation);
          if (status?.status === 0) { attempts.delete(context.requestId); refreshRequestId(); return success(copy(id === 'reminders cancel' ? 'reminder.cancelled' : 'reminder.dismissed')); }
          if (status?.status === 4) { attempts.delete(context.requestId); return failure(copy('reminder.conflict')); }
          if (status?.status === 2 || status?.status === 3) return uncertain(copy('reminder.uncertainMutation'));
        } else if (!caps.supportedOperations.includes(operation)) return failure(copy('reminder.unavailable'));
        if (!caps.supportedOperations.includes(operation)) return uncertain(copy('reminder.uncertainMutation'));
        const currentRow = prior ? (await fetchInbox(true, true)).find(item => item.communityId === community && item.reminder.id === saved!.reminderId) : row;
        if (!currentRow) return prior ? uncertain(copy('reminder.uncertainMutation')) : failure('Choose one of your accessible reminders.');
        const input = { requestId: context.requestId, reminderId: saved?.reminderId ?? currentRow.reminder.id, revision: saved?.revision ?? currentRow.reminder.revision.toString() };
        if (!context.isCurrent()) return prior ? uncertain(copy('reminder.uncertainMutation')) : failure('The conversation changed.');
        attempts.set(context.requestId, prior ?? { kind: id, scope, installationId: caps.installationId, value: { communityId: community, reminderId: input.reminderId, revision: input.revision } });
        if (id === 'reminders cancel') await utility.reminderCancel(input); else await utility.reminderDismiss(input);
        attempts.delete(context.requestId);
        refreshRequestId(); return success(copy(id === 'reminders cancel' ? 'reminder.cancelled' : 'reminder.dismissed'));
      } catch (error) {
        if (error instanceof BotUtilitiesStatusError && (error.status === 4 || (!prior && error.status !== 5))) attempts.delete(context.requestId);
        return prior ? uncertain(copy('reminder.uncertainMutation')) : caught(error, 'reminder');
      }
    };
    return handlers;
  }, [client, communityId, fetchInbox, open, refreshRequestId, utilityFor]);
  const suggest = useCallback<CommandSuggestionProvider>(async (commandId, option, query, binding, values) => {
    const q = query.toLocaleLowerCase(); const out: CommandSuggestion[] = [];
    const add = (id: string, label: string, value: string, description?: string) => { if (label.toLocaleLowerCase().includes(q) || value === query) out.push({ id, label, value, ...(description ? { description } : {}) }); };
    if (communityId !== null && (commandId.startsWith('poll ') || commandId === 'poll create')) {
      const currentCommunity = binding.communityId;
      if (currentCommunity !== communityId || !binding.channelId || option.name === 'question' || option.name === 'answers') return [];
      try {
        const utility = utilityFor(communityId); const page = await utility.pollList({ channelId: binding.channelId, threadId: thread(binding) });
        const polls = [...page.items]; let cursor = page.nextCursor;
        for (let n = 0; cursor !== null && n < 7; n++) { const next = await utility.pollList({ channelId: binding.channelId, threadId: thread(binding), cursor }); polls.push(...next.items); cursor = next.nextCursor; }
        if (option.name === 'poll') for (const poll of polls) add(poll.id, poll.question, poll.id, `${poll.answers.length} answers`);
        if (option.name === 'choice' && values?.poll) { const poll = polls.find(item => item.id === values.poll); for (const [index, answer] of (poll?.answers ?? []).entries()) add(String(index), answer, String(index + 1)); }
      } catch { return []; }
    }
    if (commandId.startsWith('reminders ') && option.name === 'reminder') for (const row of currentRecords) add(row.reminder.id, row.reminder.text, row.reminder.id, row.reminder.state);
    return out.slice(0, 20);
  }, [communityId, currentRecords, utilityFor]);
  const dueCount = currentRecords.filter(row => row.reminder.state === 'due').length;
  const visibleDialog = dialogScope?.client === client && dialogScope.owner === ownerKey && dialogScope.communityId === communityId ? dialog : null;
  const inbox = <ReminderInbox client={client} ownerKey={ownerKey} rows={currentRecords} sourceAccessVersion={sourceAccessVersion} loading={records?.client !== client || records?.owner !== ownerKey ? ownerKey !== '' : records.loading}
    error={records?.client === client && records?.owner === ownerKey ? records.error : false} dueCount={dueCount} open={inboxOpen} onOpen={() => setInboxOpen(true)} onClose={() => setInboxOpen(false)}
    onRefresh={() => void fetchInbox(true, true)} onNavigate={onNavigate} utilityFor={utilityFor} />;
  return { handlers: commandHandlers, suggest, dialogs: createElement(UtilityCommandDialogs, { dialog: visibleDialog }), inbox, dueCount };
}

function ReminderInbox(props: { client: CoreClient; ownerKey: string; rows: ReminderInboxEntry[]; sourceAccessVersion: number; loading: boolean; error: boolean; dueCount: number;
  open: boolean; onOpen(): void; onClose(): void; onRefresh(): void; onNavigate?: UtilityNavigate; utilityFor(id: string): BotUtilities }): React.JSX.Element {
  const [busy, setBusy] = useState<string | null>(null); const [error, setError] = useState('');
  const attempts = inboxAttemptMap(props.client);
  const renderScope = useRef({ client: props.client, owner: props.ownerKey }); renderScope.current = { client: props.client, owner: props.ownerKey };
  const accountNow = props.client.get('account'); const liveOwner = accountNow?.instance?.id && accountNow.user?.id && accountNow.deviceId ? `${accountNow.instance.id}:${accountNow.user.id}:${accountNow.deviceId}` : '';
  const current = liveOwner === props.ownerKey ? props.rows : [];
  const due = current.filter(row => row.reminder.state === 'due'); const scheduled = current.filter(row => row.reminder.state === 'scheduled');
  const mutate = async (row: ReminderInboxEntry, action: 'cancel' | 'dismiss') => {
    const key = `${props.ownerKey}:${row.communityId}:${row.reminder.id}:${action}`;
    if (busy !== null) return; setBusy(key); setError('');
    try {
      const currentOwner = () => { const live = props.client.get('account'); return `${live?.instance?.id ?? ''}:${live?.user?.id ?? ''}:${live?.deviceId ?? ''}`; };
      const isCurrent = () => renderScope.current.client === props.client && renderScope.current.owner === props.ownerKey && currentOwner() === props.ownerKey
        && (props.client.get('communities') ?? []).some(item => item.id === row.communityId);
      if (!isCurrent()) return;
      const prior = attempts.get(key);
      const utility = props.utilityFor(row.communityId); const caps = await utility.capabilities();
      if (!isCurrent()) return;
      const op = action === 'cancel' ? 82 : 83;
      if (prior !== undefined) {
        if (prior.installationId !== caps.installationId) { setError(copy('reminder.uncertainMutation')); return; }
        const result = await utility.read(prior.id, op);
        if (!isCurrent()) return;
        if (result?.status === 0) { attempts.delete(key); props.onRefresh(); return; }
        if (result?.status === 4) { attempts.delete(key); setError(copy('reminder.conflict')); props.onRefresh(); return; }
        if (result?.status === 2 || result?.status === 3 || !caps.supportedOperations.includes(op)) { setError(copy('reminder.uncertainMutation')); return; }
      } else if (!caps.supportedOperations.includes(op)) { setError(copy('reminder.unavailable')); return; }
      const attempt = prior ?? { id: makeId(), revision: row.reminder.revision.toString(), installationId: caps.installationId };
      attempts.set(key, attempt);
      if (attempt.installationId !== caps.installationId) { setError(copy('reminder.uncertainMutation')); return; }
      const input = { requestId: attempt.id, reminderId: row.reminder.id, revision: attempt.revision };
      if (!isCurrent()) { setError(copy('reminder.uncertainMutation')); return; }
      if (action === 'cancel') await utility.reminderCancel(input); else await utility.reminderDismiss(input);
      if (!isCurrent()) return;
      attempts.delete(key); props.onRefresh();
    } catch (cause) {
      if (cause instanceof BotUtilitiesStatusError && cause.status === 4) {
        attempts.delete(key); setError(copy('reminder.conflict')); props.onRefresh();
      } else if (cause instanceof BotUtilitiesUncertainMutationError) {
        const attempt = attempts.get(key);
        if (attempt !== undefined) {
          try {
            const result = await props.utilityFor(row.communityId).read(attempt.id, action === 'cancel' ? 82 : 83);
            const latest = props.client.get('account');
            if (`${latest?.instance?.id ?? ''}:${latest?.user?.id ?? ''}:${latest?.deviceId ?? ''}` !== props.ownerKey
              || !(props.client.get('communities') ?? []).some(item => item.id === row.communityId)) return;
            if (result?.status === 0) { attempts.delete(key); props.onRefresh(); return; }
            if (result?.status === 4) { attempts.delete(key); setError(copy('reminder.conflict')); props.onRefresh(); return; }
          } catch { /* Keep the captured revision and id for a later reconciliation. */ }
        }
        setError(copy('reminder.uncertainMutation')); props.onRefresh();
      } else {
        if (!(cause instanceof BotUtilitiesStatusError && (cause.status === 2 || cause.status === 3))) {
          // Once an attempt has been retained, transport/provider failures cannot release its ID.
          if (!attempts.has(key)) attempts.delete(key);
        }
        setError(cause instanceof BotUtilitiesProviderUnavailableError ? copy('reminder.unavailable') : 'Could not update this reminder. Refresh and try again.');
      }
    }
    finally { setBusy(null); }
  };
  const sourceAvailable = (row: ReminderInboxEntry): boolean => {
    const item = row.reminder;
    return props.onNavigate !== undefined && sourceAccessible(props.client, row.communityId, item.sourceChannelId);
  };
  const jump = (row: ReminderInboxEntry) => {
    if (liveOwner !== props.ownerKey || !sourceAvailable(row) || row.reminder.sourceChannelId === null) return;
    props.onNavigate?.(row.communityId, row.reminder.sourceChannelId, row.reminder.sourceThreadId);
  };
  return <>
    <Button variant="ghost" aria-haspopup="dialog" onClick={() => props.onOpen()}>{copy('reminder.inbox')}{props.dueCount > 0 ? <span className="dw-reminder-badge" aria-label={copy('reminder.badge', { count: props.dueCount })}>{props.dueCount}</span> : null}</Button>
    <Dialog open={props.open} title={copy('reminder.inboxTitle')} closeLabel={copy('reminder.close')} onClose={() => props.onClose()}>
      <div className="dw-reminder-inbox">
        {props.loading ? <p role="status">{copy('reminder.loading')}</p> : null}
        {props.error ? <p role="alert">{copy('reminder.loadError')}</p> : null}
        {error ? <p role="alert">{error}</p> : null}
        {!props.loading && current.length === 0 ? <p>{copy('reminder.emptyInbox')}</p> : null}
        {due.length ? <section aria-labelledby="dw-reminders-due"><h3 id="dw-reminders-due">{copy('reminder.due')}</h3><ul>
          {due.map(row => <ReminderRow key={`${row.communityId}:${row.reminder.id}`} row={row} busy={busy !== null} canSource={sourceAvailable(row)} onSource={() => jump(row)} onCancel={() => void mutate(row, 'cancel')} onDismiss={() => void mutate(row, 'dismiss')} />)}
        </ul></section> : null}
        {scheduled.length ? <section aria-labelledby="dw-reminders-upcoming"><h3 id="dw-reminders-upcoming">{copy('reminder.upcoming')}</h3><ul>
          {scheduled.map(row => <ReminderRow key={`${row.communityId}:${row.reminder.id}`} row={row} busy={busy !== null} canSource={sourceAvailable(row)} onSource={() => jump(row)} onCancel={() => void mutate(row, 'cancel')} onDismiss={() => void mutate(row, 'dismiss')} />)}
        </ul></section> : null}
      </div>
    </Dialog>
  </>;
}
function ReminderRow(props: { row: ReminderInboxEntry; busy: boolean; canSource: boolean; onSource(): void; onCancel(): void; onDismiss(): void }): React.JSX.Element {
  const item = props.row.reminder;
  return <li className="dw-reminder-card"><p>{item.text}</p><p>{new Date(Number(item.dueUnixSeconds) * 1000).toLocaleString()} · {item.timezone}</p>
    {item.sourceChannelId !== null ? props.canSource ? <Button variant="ghost" onClick={() => props.onSource()}>{copy('reminder.source')}</Button> : <span>{copy('reminder.sourceUnavailable')}</span> : null}
    {item.state === 'scheduled' || item.state === 'due' ? <Button variant="ghost" disabled={props.busy} onClick={() => props.onCancel()}>{copy('reminder.cancel')}</Button> : null}
    {item.state === 'due' ? <Button variant="ghost" disabled={props.busy} onClick={() => props.onDismiss()}>{copy('reminder.dismiss')}</Button> : null}
  </li>;
}

const notifiedReminders = new WeakMap<CoreClient, Map<string, Set<string>>>();
export function notifyReminder(entry: ReminderInboxEntry, client: CoreClient, openInbox: () => void): void {
  const Ctor = notificationCtor(); if (Ctor === undefined || Ctor.permission !== 'granted' || document.visibilityState === 'visible') return;
  const account = client.get('account');
  const owner = account?.instance?.id && account.user?.id && account.deviceId ? `${account.instance.id}:${account.user.id}:${account.deviceId}` : '';
  if (owner === '') return;
  let notified = notifiedReminders.get(client);
  if (notified === undefined) { notified = new Map(); notifiedReminders.set(client, notified); }
  const seen = notified.get(owner) ?? new Set<string>();
  if (seen.has(entry.reminder.id)) return;
  const sourceChannel = entry.reminder.sourceChannelId ?? `reminder-${entry.communityId}`;
  const notice = { id: 0, channelId: sourceChannel, communityId: entry.communityId, kind: 'message' as const, senderUser: null,
    senderName: '', body: entry.reminder.text, ts: Number(entry.reminder.dueUnixSeconds), threadRoot: entry.reminder.sourceThreadId };
  const allowed = shouldNotify(notice, 0, { permission: Ctor.permission, settings: client.get('settings') ?? {}, visible: false, onScreen: null, presenceChoice: account?.presenceChoice });
  if (!allowed) return;
  try { const notification = new Ctor(copy('reminder.inbox'), { body: entry.reminder.text, tag: `dilla-reminder-${entry.reminder.id}`, silent: false });
    notification.onclick = () => { window.focus(); openInbox(); notification.close(); };
    seen.add(entry.reminder.id); notified.set(owner, seen);
    if (seen.size > 512) seen.delete(seen.values().next().value!);
  } catch { /* Browser notification constructors may be unavailable in restricted contexts. */ }
}

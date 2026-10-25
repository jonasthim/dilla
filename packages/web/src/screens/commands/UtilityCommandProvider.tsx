import { createElement, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Dialog } from '@dilla/ui';
import { BotUtilitiesError, BotUtilitiesProviderUnavailableError, BotUtilitiesStatusError, BotUtilitiesUncertainMutationError,
  createBotUtilities, encode, fromHex, parseReminderTime, resolveReminderTimeCandidate,
  type BotUtilities, type CoreClient, type ReminderSummary, type ReminderTimeResult } from '@dilla/client-core';
import { PERM, type CommandContext as Binding, type CommandInvocation, type CommandResult } from '@dilla/client-core';
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
  | { kind: 'reminder'; when: string; text: string; timezone: string };
export type UtilityDialogState =
  | (UtilityDialogBase & { kind: 'poll'; question: string; answers: string; multi: boolean; duration: string; channelId: string; threadId: string | null; onSubmit(value: { question: string; answers: string[]; multi: boolean; duration: number }): void })
  | (UtilityDialogBase & { kind: 'reminder'; when: string; text: string; timezone: string; onSubmit(value: { when: string; text: string; timezone: string; result: Extract<ReminderTimeResult, { kind: 'valid' }> }): void });

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
    <label>{copy('poll.question')}<textarea value={question} maxLength={300} onChange={event => setQuestion(event.currentTarget.value)} data-autofocus /></label>
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
  const [chosen, setChosen] = useState<number | null>(null); const [error, setError] = useState(''); const [now, setNow] = useState(() => new Date());
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
  const [inboxOpen, setInboxOpen] = useState(false);
  const [records, setRecords] = useState<{ client: CoreClient; owner: string; rows: ReminderInboxEntry[]; loading: boolean; error: boolean } | null>(null);
  const joinedCommunityKey = (client.get('communities') ?? []).map(row => row.id).sort().join(':');
  const [observedCommunities, setObservedCommunities] = useState(joinedCommunityKey);
  useEffect(() => client.subscribe('communities', () => setObservedCommunities((client.get('communities') ?? []).map(row => row.id).sort().join(':'))), [client]);
  const currentRecords = useMemo(() => {
    const liveCommunityIds = new Set(joinedCommunityKey.split(':').filter(Boolean));
    return records?.client === client && records.owner === ownerKey ? records.rows.filter(row => liveCommunityIds.has(row.communityId)) : [];
  }, [client, joinedCommunityKey, ownerKey, records]);

  const knownDue = useRef<{ owner: string; ids: Set<string> } | null>(null);
  const fetchToken = useRef(0);
  const utilityFor = useCallback((id: string) => createBotUtilities(client, id), [client]);
  const fetchInbox = useCallback(async (showLoading = false) => {
    if (ownerKey === '' || observedCommunities !== joinedCommunityKey) { setRecords(null); return []; }
    const token = ++fetchToken.current; const currentOwner = ownerKey;
    const joined = (client.get('communities') ?? []).slice();
    if (showLoading) setRecords({ client, owner: currentOwner, rows: [], loading: true, error: false });
    const next: ReminderInboxEntry[] = []; let failed = false;
    for (const [index, community] of joined.entries()) {
      if (token !== fetchToken.current || liveScope.current.client !== client || liveScope.current.ownerKey !== currentOwner) return [];
      if (index > 0) await new Promise(resolve => window.setTimeout(resolve, Math.min(index * 120, 900)));
      try {
        const utility = utilityFor(community.id); await utility.capabilities();
        let cursor: Uint8Array | null = null;
        for (let page = 0; page < 4; page++) {
          const result = await utility.reminderList(cursor);
          next.push(...result.items.filter(item => item.state === 'scheduled' || item.state === 'due').map(reminder => ({ communityId: community.id, reminder })));
          cursor = result.nextCursor; if (cursor === null) break;
        }
      } catch (error) {
        if (!(error instanceof BotUtilitiesProviderUnavailableError) && !(error instanceof BotUtilitiesStatusError && error.status === 2)) failed = true;
        // This community is deliberately absent: disabled or inaccessible private data never stays visible.
      }
    }
    if (token !== fetchToken.current || liveScope.current.client !== client || liveScope.current.ownerKey !== currentOwner) return [];
    const ordered = next.sort((a, b) => Number(a.reminder.dueUnixSeconds - b.reminder.dueUnixSeconds));
    const previous = knownDue.current?.owner === currentOwner ? knownDue.current.ids : null;
    const seen = new Set(previous ?? []);
    if (previous !== null) for (const entry of ordered) if (entry.reminder.state === 'due' && !seen.has(entry.reminder.id)) notifyReminder(entry, client, () => setInboxOpen(true));
    for (const entry of ordered) if (entry.reminder.state === 'due') seen.add(entry.reminder.id);
    knownDue.current = { owner: currentOwner, ids: seen };
    setRecords({ client, owner: currentOwner, rows: ordered, loading: false, error: failed }); return ordered;
  }, [client, ownerKey, utilityFor, joinedCommunityKey, observedCommunities]);
  useEffect(() => {
    if (ownerKey === '') { fetchToken.current++; knownDue.current = null; setRecords(null); return; }
    knownDue.current = null;
    let stopped = false; let running = false; let queued = false; let timer = 0;
    const poll = async (initial = false): Promise<void> => {
      if (stopped) return;
      if (running) { queued = true; return; }
      running = true; await fetchInbox(initial); running = false;
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
  const openDialog = useCallback((state: UtilityDialogInput, context: CommandExecutionContext) => new Promise<unknown>(resolve => {
    if (liveScope.current.client !== client || liveScope.current.ownerKey === '' || !context.isCurrent()) { resolve(null); return; }
    const scope = { client, owner: liveScope.current.ownerKey, communityId };
    setDialogScope(scope);
    resolveDialog.current?.(null); resolveDialog.current = resolve;
    const isScopeCurrent = () => liveScope.current.client === scope.client && liveScope.current.ownerKey === scope.owner && liveScope.current.communityId === scope.communityId && context.isCurrent();
    const cancel = () => { resolveDialog.current?.(null); resolveDialog.current = null; setDialog(null); setDialogScope(null); };
    const submit = (value: unknown) => { if (!isScopeCurrent()) { cancel(); return; } resolveDialog.current?.(value); resolveDialog.current = null; setDialog(null); setDialogScope(null); };
    setDialog({ ...state, isCurrent: isScopeCurrent, onCancel: cancel, onSubmit: submit });
  }), [client, communityId]);
  useEffect(() => {
    if (dialogScope === null || (dialogScope.client === client && dialogScope.owner === ownerKey && dialogScope.communityId === communityId)) return;
    resolveDialog.current?.(null); resolveDialog.current = null; setDialog(null); setDialogScope(null);
  }, [client, communityId, dialogScope, ownerKey]);
  useEffect(() => () => { fetchToken.current++; resolveDialog.current?.(null); resolveDialog.current = null; }, []);
  const refreshRequestId = useCallback(() => { void fetchInbox(); }, [fetchInbox]);
  const open = useCallback(async (state: UtilityDialogInput, context: CommandExecutionContext) => {
    if (!context.isCurrent()) return null;
    const value = await openDialog(state, context);
    return context.isCurrent() ? value : null;
  }, [openDialog]);
  const commandHandlers = useMemo<CommandProviderHandlers>(() => {
    if (communityId === null) return {};
    const handlers: Record<string, (invocation: CommandInvocation, context: CommandExecutionContext) => Promise<CommandResult>> = {};
    handlers['poll create'] = async (invocation, context) => {
      if (!context.isCurrent() || context.binding.communityId !== communityId || !context.binding.channelId) return failure('Create a poll in a community channel.');
      const answers = invocation.args.answers ?? '';
      const raw = await open({ kind: 'poll', question: invocation.args.question ?? '', answers: answers.replace(/\s*,\s*/gu, '\n'), multi: invocation.args.multiple === 'on', duration: invocation.args.duration ?? '24h', channelId: context.binding.channelId, threadId: thread(context.binding) }, context) as { question: string; answers: string[]; multi: boolean; duration: number } | null;
      if (raw === null) return failure('Poll creation cancelled.');
      try { if (!context.isCurrent()) return failure('The conversation changed.');
        const utility = utilityFor(communityId); const poll = await utility.pollCreate({ requestId: context.requestId, channelId: context.binding.channelId, threadId: thread(context.binding), question: raw.question, answers: raw.answers, multi: raw.multi, durationSeconds: raw.duration });
        return success(copy('poll.created') + ` ${poll.id}`);
      } catch (error) { return caught(error); }
    };
    for (const id of ['poll vote', 'poll results', 'poll close']) handlers[id] = async (invocation, context) => {
      if (!context.isCurrent() || context.binding.communityId !== communityId) return failure('The conversation changed.');
      const pollId = invocation.args.poll;
      if (!pollId || !hexID.test(pollId)) return failure('Choose a poll from this conversation.');
      try {
        const utility = utilityFor(communityId); const poll = await utility.pollGet(pollId, { channelId: context.binding.channelId, threadId: thread(context.binding) });
        if (id === 'poll results') return success(copy('poll.results', { question: poll.question, answers: poll.answers.map((answer, i) => `${answer}: ${poll.counts[i]}`).join('\n') }));
        if (id === 'poll close') {
          if (poll.creatorId !== context.selfId && ((context.getCurrentBinding().bits ?? 0) & PERM.manageMessages) === 0) return failure('You cannot close this poll.');
          if (!context.isCurrent()) return failure('The conversation changed.');
          await utility.pollClose({ requestId: context.requestId, pollId, channelId: poll.channelId, threadId: poll.threadId, revision: poll.revision });
          return success(copy('poll.closed'));
        }
        const choices = (invocation.args.choice ?? '').split(',').map(value => value.trim()).filter(Boolean);
        const indexes = choices.map(value => { const numeric = Number(value); if (Number.isInteger(numeric) && numeric >= 1 && numeric <= poll.answers.length) return numeric - 1; return poll.answers.findIndex(answer => answer.toLocaleLowerCase() === value.toLocaleLowerCase()); });
        if (indexes.length === 0 || indexes.some(index => index < 0) || (!poll.multi && indexes.length > 1)) return failure('Choose one or more answer names, separated by commas.');
        if (!context.isCurrent()) return failure('The conversation changed.');
        const updated = await utility.pollVote({ requestId: context.requestId, pollId, channelId: poll.channelId, threadId: poll.threadId, revision: poll.revision, choices: indexes });
        return success(`Vote saved. ${updated.answers.map((answer, i) => `${answer}: ${updated.counts[i]}`).join(', ')}`);
      } catch (error) { return caught(error); }
    };
    handlers.remind = async (invocation, context) => {
      if (!context.isCurrent() || context.binding.communityId !== communityId) return failure('Set reminders in a Bot-enabled community.');
      const value = await open({ kind: 'reminder', when: invocation.args.when, text: invocation.args.text, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }, context) as { when: string; text: string; timezone: string; result: Extract<ReminderTimeResult, { kind: 'valid' }> } | null;
      if (value === null) return failure('Reminder creation cancelled.');
      try {
        if (!context.isCurrent()) return failure('The conversation changed.');
        const utility = utilityFor(communityId); const reminder = await utility.reminderCreate({ requestId: context.requestId,
          whenKind: value.result.mode === 'relative' ? 0 : 1,
          when: value.result.mode === 'relative' ? value.result.seconds : value.result.unixSeconds,
          text: value.text, timezone: value.timezone, sourceChannelId: context.binding.channelId, sourceThreadId: thread(context.binding) });
        refreshRequestId(); return success(`${copy('reminder.created')} ${reminder.id}`);
      } catch (error) { return caught(error, 'reminder'); }
    };
    handlers['reminders list'] = async (_invocation, context) => {
      if (!context.isCurrent()) return failure('The conversation changed.');
      const rows = (await fetchInbox()).filter(row => row.reminder.state === 'scheduled' || row.reminder.state === 'due');
      if (!context.isCurrent()) return failure('The conversation changed.');
      if (rows.length === 0) return success(copy('reminder.empty'));
      return success(copy('reminder.list', { count: rows.length, items: rows.slice(0, 12).map(row => `${row.reminder.id}: ${row.reminder.text}`).join('; ') }));
    };
    for (const id of ['reminders cancel', 'reminders dismiss']) handlers[id] = async (invocation, context) => {
      if (!context.isCurrent()) return failure('The conversation changed.');
      const target = invocation.args.reminder;
      const row = (await fetchInbox()).find(item => item.reminder.id === target);
      if (!context.isCurrent()) return failure('The conversation changed.');
      if (!row) return failure('Choose one of your accessible reminders.');
      try {
        const utility = utilityFor(row.communityId); const input = { requestId: context.requestId, reminderId: row.reminder.id, revision: row.reminder.revision };
        if (id === 'reminders cancel') await utility.reminderCancel(input); else await utility.reminderDismiss(input);
        refreshRequestId(); return success(copy(id === 'reminders cancel' ? 'reminder.cancelled' : 'reminder.dismissed'));
      } catch (error) { return caught(error, 'reminder'); }
    };
    return handlers;
  }, [communityId, fetchInbox, open, refreshRequestId, utilityFor]);
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
  const inbox = <ReminderInbox client={client} ownerKey={ownerKey} rows={currentRecords} loading={records?.client !== client || records?.owner !== ownerKey ? ownerKey !== '' : records.loading}
    error={records?.client === client && records?.owner === ownerKey ? records.error : false} dueCount={dueCount} open={inboxOpen} onOpen={() => setInboxOpen(true)} onClose={() => setInboxOpen(false)}
    onRefresh={() => void fetchInbox(true)} onNavigate={onNavigate} utilityFor={utilityFor} />;
  return { handlers: commandHandlers, suggest, dialogs: createElement(UtilityCommandDialogs, { dialog: visibleDialog }), inbox, dueCount };
}

function ReminderInbox(props: { client: CoreClient; ownerKey: string; rows: ReminderInboxEntry[]; loading: boolean; error: boolean; dueCount: number;
  open: boolean; onOpen(): void; onClose(): void; onRefresh(): void; onNavigate?: UtilityNavigate; utilityFor(id: string): BotUtilities }): React.JSX.Element {
  const [busy, setBusy] = useState<string | null>(null); const [error, setError] = useState(''); const attempts = useRef(new Map<string, string>());
  const accountNow = props.client.get('account'); const liveOwner = accountNow?.instance?.id && accountNow.user?.id && accountNow.deviceId ? `${accountNow.instance.id}:${accountNow.user.id}:${accountNow.deviceId}` : '';
  const current = liveOwner === props.ownerKey ? props.rows : [];
  const due = current.filter(row => row.reminder.state === 'due'); const scheduled = current.filter(row => row.reminder.state === 'scheduled');
  const mutate = async (row: ReminderInboxEntry, action: 'cancel' | 'dismiss') => {
    const key = `${props.ownerKey}:${row.communityId}:${row.reminder.id}:${action}`;
    if (busy !== null) return; setBusy(key); setError('');
    const requestId = attempts.current.get(key) ?? makeId(); attempts.current.set(key, requestId);
    try {
      const live = props.client.get('account');
      if (`${live?.instance?.id ?? ''}:${live?.user?.id ?? ''}:${live?.deviceId ?? ''}` !== props.ownerKey) return;
      const utility = props.utilityFor(row.communityId); const input = { requestId, reminderId: row.reminder.id, revision: row.reminder.revision };
      if (action === 'cancel') await utility.reminderCancel(input); else await utility.reminderDismiss(input);
      const after = props.client.get('account');
      if (`${after?.instance?.id ?? ''}:${after?.user?.id ?? ''}:${after?.deviceId ?? ''}` !== props.ownerKey) return;
      attempts.current.delete(key); props.onRefresh();
    } catch (cause) {
      if (!(cause instanceof BotUtilitiesUncertainMutationError)) attempts.current.delete(key);
      setError(cause instanceof BotUtilitiesUncertainMutationError ? copy('reminder.uncertainMutation') : 'Could not update this reminder. Refresh and try again.');
      props.onRefresh();
    }
    finally { setBusy(null); }
  };
  const sourceAvailable = (row: ReminderInboxEntry): boolean => {
    const item = row.reminder; if (!item.sourceChannelId) return false;
    const channels = props.client.get(`channels:${row.communityId}`) ?? [];
    return props.onNavigate !== undefined && channels.some(channel => channel.id === item.sourceChannelId && channel.kind === 0);
  };
  const jump = (row: ReminderInboxEntry) => {
    if (liveOwner !== props.ownerKey || !sourceAvailable(row) || row.reminder.sourceChannelId === null) return;
    props.onNavigate?.(row.communityId, row.reminder.sourceChannelId, row.reminder.sourceThreadId);
  };
  return <>
    <Button variant="ghost" aria-haspopup="dialog" onClick={() => props.onOpen()}>{copy('reminder.inbox')}{props.dueCount > 0 ? <span className="dw-reminder-badge" aria-label={copy('reminder.badge', { count: props.dueCount })}>{props.dueCount}</span> : null}</Button>
    <Dialog open={props.open} title={copy('reminder.inboxTitle')} closeLabel={copy('reminder.close')} onClose={() => props.onClose()}>
      <div key={props.ownerKey} className="dw-reminder-inbox">
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
    {item.state === 'scheduled' ? <Button variant="ghost" disabled={props.busy} onClick={() => props.onCancel()}>{copy('reminder.cancel')}</Button> : null}
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

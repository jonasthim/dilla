import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PERM, createBotUtilities, type CoreClient, type PollSummary } from '@dilla/client-core';
import { Button } from '@dilla/ui';
import { utilityText as t } from './utility-copy.ts';
import './UtilityCards.css';

const MARKER = /^\[dilla-poll:v1:([0-9a-f]{32})\]$/u;
const attemptsByClient = new WeakMap<CoreClient, Map<string, { id: string; kind: 'vote' | 'close'; choices: number[] }>>();
function attemptMap(client: CoreClient): Map<string, { id: string; kind: 'vote' | 'close'; choices: number[] }> {
  const prior = attemptsByClient.get(client); if (prior) return prior; const map = new Map<string, { id: string; kind: 'vote' | 'close'; choices: number[] }>(); attemptsByClient.set(client, map); return map;
}
export function finalPollMarker(body: string): string | null {
  const finalLine = body.split(/\r?\n/u).at(-1) ?? '';
  return MARKER.exec(finalLine)?.[1] ?? null;
}
function requestId(): string {
  const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
  if (bytes.every(value => value === 0)) bytes[15] = 1;
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}
function countLabel(value: bigint): string { return value.toString(); }

export interface PollCardProps {
  client: CoreClient; communityId: string | null; channelId: string; threadId: string | null; body: string;
  authorId: string | null; bot: boolean; edited: boolean; deleted: boolean; selfId: string | null; bits: number | null;
  onOpenThread?(rootMessageId: string): void;
}

/** A poll is interactive only after the authenticated bot author, final marker and durable record agree. */
export function PollCard(props: PollCardProps): React.JSX.Element | null {
  const pollId = finalPollMarker(props.body);
  if (pollId === null || props.communityId === null || !props.bot || props.edited || props.deleted || props.authorId === null || props.selfId === null) return null;
  return <VerifiedPollCard key={`${props.communityId}:${props.channelId}:${props.threadId ?? ''}:${pollId}:${props.selfId}`} {...props} pollId={pollId} />;
}

function VerifiedPollCard(props: PollCardProps & { pollId: string }): React.JSX.Element | null {
  const owner = `${props.client.get('account')?.instance?.id ?? ''}:${props.selfId}:${props.client.get('account')?.deviceId ?? ''}`;
  const isSameOwner = useCallback(() => { const account = props.client.get('account'); return `${account?.instance?.id ?? ''}:${account?.user?.id ?? ''}:${account?.deviceId ?? ''}` === owner; }, [props.client, owner]);
  const [installationId, setInstallationId] = useState<string | null>(null);
  const installationRef = useRef(installationId); installationRef.current = installationId;
  const scopeKey = `${owner}:${installationId ?? ''}:${props.communityId}:${props.channelId}:${props.threadId ?? ''}:${props.pollId}`;
  const [record, setRecord] = useState<{ client: CoreClient; scope: string; poll: PollSummary } | null>(null);
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<number[]>([]);
  const attemptKey = `${owner}:${installationId ?? ''}:${props.communityId}:${props.pollId}`;
  const [storedAttempt, setStoredAttempt] = useState<{ key: string; value: { id: string; kind: 'vote' | 'close'; choices: number[] } | null } | null>(null);
  const attempt = storedAttempt?.key === attemptKey ? storedAttempt.value : attemptMap(props.client).get(attemptKey) ?? null;
  const rememberAttempt = (next: { id: string; kind: 'vote' | 'close'; choices: number[] } | null) => {
    if (next === null) attemptMap(props.client).delete(attemptKey); else attemptMap(props.client).set(attemptKey, next);
    setStoredAttempt({ key: attemptKey, value: next });
  };
  const [voters, setVoters] = useState<{ option: number; ids: string[]; cursor: Uint8Array | null } | null>(null);
  const ref = useRef<HTMLDivElement>(null); const generation = useRef(0);
  const utilities = useMemo(() => createBotUtilities(props.client, props.communityId!), [props.client, props.communityId]);
  const refresh = useCallback(async (): Promise<PollSummary | null> => {
    const current = ++generation.current;
    try {
      const caps = await utilities.capabilities();
      if (generation.current !== current || !isSameOwner() || caps.botUserId !== props.authorId
        || utilities.binding?.installationId !== caps.installationId || utilities.binding?.botUserId !== caps.botUserId) return null;
      setInstallationId(caps.installationId);
      const poll = await utilities.pollGet(props.pollId, { channelId: props.channelId, threadId: props.threadId });
      const latestCaps = await utilities.capabilities();
      if (generation.current !== current || !isSameOwner() || latestCaps.installationId !== caps.installationId || latestCaps.botUserId !== props.authorId
        || poll.channelId !== props.channelId || poll.threadId !== props.threadId) return null;
      const boundScope = `${owner}:${caps.installationId}:${props.communityId}:${props.channelId}:${props.threadId ?? ''}:${props.pollId}`;
      setRecord({ client: props.client, scope: boundScope, poll }); setSelected(poll.myChoices ?? []); setError(''); return poll;
    } catch { if (generation.current === current) setRecord(null); return null; }
  }, [utilities, isSameOwner, owner, props.client, props.communityId, props.authorId, props.pollId, props.channelId, props.threadId]);
  useEffect(() => {
    const node = ref.current; if (node === null) return;
    if (typeof IntersectionObserver === 'undefined') { setActive(true); return; }
    const observer = new IntersectionObserver(entries => setActive(entries.some(entry => entry.isIntersecting)), { rootMargin: '160px' });
    observer.observe(node); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!active) { generation.current++; setRecord(null); return; }
    const currentGeneration = generation;
    void refresh(); const timer = window.setInterval(() => { void refresh(); }, 30_000);
    return () => { window.clearInterval(timer); currentGeneration.current++; };
  }, [active, refresh]);
  const poll = record?.client === props.client && record.scope === scopeKey ? record.poll : null;
  const canClose = poll !== null && (poll.creatorId === props.selfId || (props.bits !== null && (props.bits & PERM.manageMessages) !== 0));
  if (poll === null) return <div ref={ref} className="dw-poll-card" aria-hidden="true" />;
  const submit = async (choices: number[]) => {
    if (busy || (attempt !== null && (attempt.kind !== 'vote' || attempt.choices.join(',') !== choices.join(',')))) return;
    const id = attempt?.id ?? requestId(); rememberAttempt({ id, kind: 'vote', choices }); setBusy(true); setError('');
    try {
      const caps = await utilities.capabilities();
      if (!isSameOwner() || caps.installationId !== installationId || caps.botUserId !== props.authorId) { await refresh(); return; }
      const updated = await utilities.pollVote({ requestId: id, pollId: poll.id, channelId: poll.channelId, threadId: poll.threadId, revision: poll.revision, choices });
      if (!isSameOwner()) return;
      setRecord({ client: props.client, scope: scopeKey, poll: updated }); setSelected(updated.myChoices ?? []); rememberAttempt(null);
    } catch (cause) {
      const code = cause instanceof Error && 'code' in cause ? String((cause as Error & { code: string }).code) : '';
      if (code === 'interaction-status' && (cause as Error & { status?: number }).status === 4) { rememberAttempt(null); await refresh(); setError(t('poll.conflict')); }
      else { const latest = await refresh(); if (latest !== null && latest.revision > poll.revision && latest.myChoices?.join(',') === choices.join(',')) { rememberAttempt(null); setSelected(latest.myChoices ?? []); } else setError(t('poll.uncertain')); }
    } finally { setBusy(false); }
  };
  const close = async () => {
    if (!canClose || busy || (attempt !== null && attempt.kind !== 'close')) return;
    const id = attempt?.id ?? requestId(); rememberAttempt({ id, kind: 'close', choices: [] }); setBusy(true); setError('');
    try { const caps = await utilities.capabilities(); if (!isSameOwner() || caps.installationId !== installationId || caps.botUserId !== props.authorId) { await refresh(); return; }
      const updated = await utilities.pollClose({ requestId: id, pollId: poll.id, channelId: poll.channelId, threadId: poll.threadId, revision: poll.revision }); if (!isSameOwner()) return; setRecord({ client: props.client, scope: scopeKey, poll: updated }); rememberAttempt(null); }
    catch { const latest = await refresh(); if (latest?.closed === true) rememberAttempt(null); else setError(t('poll.uncertain')); }
    finally { setBusy(false); }
  };
  const loadVoters = async (option: number, cursor: Uint8Array | null = null) => {
    const identity = owner; const installation = installationId;
    try { const page = await utilities.pollVoters({ pollId: poll.id, channelId: poll.channelId, threadId: poll.threadId, option, cursor }); if (!isSameOwner() || identity !== owner || installationRef.current !== installation) return;
      setVoters(previous => ({ option, ids: cursor !== null && previous?.option === option ? [...previous.ids, ...page.voters] : page.voters, cursor: page.nextCursor })); }
    catch { setError(t('poll.readError')); }
  };
  const toggle = (index: number) => setSelected(current => current.includes(index) ? current.filter(value => value !== index) : poll.multi ? [...current, index] : [index]);
  return <section ref={ref} className="dw-poll-card" aria-labelledby={`poll-${poll.id}-question`}>
    <h3 id={`poll-${poll.id}-question`}>{poll.question}</h3>
    <fieldset disabled={busy || attempt !== null || poll.closed}>
      <legend>{poll.multi ? t('poll.chooseMany') : t('poll.chooseOne')}</legend>
      {poll.answers.map((answer, index) => <label className="dw-poll-card__answer" key={`${poll.id}:${index}`}>
        <input type={poll.multi ? 'checkbox' : 'radio'} name={`poll-${poll.id}`} checked={selected.includes(index)} onChange={() => toggle(index)} />
        <span>{answer}</span><span className="dw-poll-card__count">{countLabel(poll.counts[index] ?? 0n)}</span>
      </label>)}
    </fieldset>
    <div className="dw-poll-card__actions">
      {!poll.closed ? <Button variant="accent" disabled={busy || (attempt !== null && (attempt.kind !== 'vote' || attempt.choices.join(',') !== selected.join(',')))} onClick={() => void submit(selected)}>{attempt?.kind === 'vote' ? t('poll.retryVote') : t('poll.submit')}</Button> : null}
      {!poll.closed && poll.myChoices !== null && poll.myChoices.length > 0 ? <Button variant="ghost" disabled={busy || (attempt !== null && (attempt.kind !== 'vote' || attempt.choices.length !== 0))} onClick={() => void submit(attempt?.kind === 'vote' ? attempt.choices : [])}>{attempt?.kind === 'vote' && attempt.choices.length === 0 ? t('poll.retryWithdraw') : t('poll.withdraw')}</Button> : null}
      {canClose && !poll.closed ? <Button variant="ghost" disabled={busy || (attempt !== null && attempt.kind !== 'close')} onClick={() => void close()}>{attempt?.kind === 'close' ? t('poll.retryClose') : t('poll.close')}</Button> : null}
    </div>
    <p className="dw-poll-card__due">{poll.closed ? t('poll.closed') : t('poll.closes', { time: new Date(Number(poll.dueAt) * 1000).toLocaleString() })}</p>
    {poll.answers.map((answer, index) => <div className="dw-poll-card__voters" key={`voters-${index}`}><Button variant="ghost" onClick={() => void loadVoters(index)}>{t('poll.voters', { answer, count: countLabel(poll.counts[index] ?? 0n) })}</Button></div>)}
    {voters !== null ? <div className="dw-poll-card__voter-list" aria-live="polite">{voters.ids.length ? <ul>{voters.ids.map(id => { const member = props.client.get(`members:${props.communityId}`)?.find(row => row.userId === id); return <li key={id}>{member?.display || member?.username || id.slice(0, 8)}</li>; })}</ul> : t('poll.noVoters')}{voters.cursor ? <Button variant="ghost" onClick={() => void loadVoters(voters.option, voters.cursor)}>{t('poll.moreVoters')}</Button> : null}</div> : null}
    {error ? <p role="alert">{error}</p> : null}
    {poll.threadId !== null && props.onOpenThread ? <Button variant="ghost" onClick={() => props.onOpenThread?.(poll.threadId!)}>{t('poll.openThread')}</Button> : null}
  </section>;
}

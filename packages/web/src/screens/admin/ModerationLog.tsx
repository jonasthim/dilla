import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@dilla/ui';
import { useCore } from '../../core/context.tsx';
import { t } from '../../strings/index.ts';

interface ModerationCase {
  key: string; channelId: string; actorId: string; messageId: string; revision: string;
  reason: string; action: string; excerpt: string; receivedAt: string;
}
interface ModerationResponse {
  deliveryId: string; requestId: string; status: number; cases: ModerationCase[]; hasMore: boolean;
}
type ReadResult = { authorized: boolean; responses: ModerationResponse[]; through: string | null; blocked: boolean };
type Phase = 'idle' | 'sending' | 'waiting' | 'ready' | 'denied' | 'error';
const POLL_MS = 2_000;

const requestId = (): string => [...crypto.getRandomValues(new Uint8Array(16))]
  .map(byte => byte.toString(16).padStart(2, '0')).join('');

export function ModerationLog({ communityId }: { communityId: string }): React.JSX.Element {
  const client = useCore();
  const base = useId();
  const [forCommunity, setForCommunity] = useState(communityId);
  const [phase, setPhase] = useState<Phase>('idle');
  const [request, setRequest] = useState<string | null>(null);
  const [responses, setResponses] = useState<ModerationResponse[]>([]);
  const [ackThrough, setAckThrough] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    setForCommunity(communityId);
    setPhase('idle');
    setRequest(null);
    setResponses([]);
    setAckThrough(null);
    setBlocked(false);
    return () => { generation.current += 1; };
  }, [communityId]);

  const load = (): void => {
    if (phase === 'sending' || forCommunity !== communityId) return;
    const request = requestId();
    const id = ++generation.current;
    setRequest(request);
    setResponses([]);
    setAckThrough(null);
    setBlocked(false);
    setPhase('sending');
    void Promise.resolve(client.call({ m: 'listModerationCases', communityId, requestId: request, offset: 0 })).then(value => {
      if (id !== generation.current) return;
      const result = value as { status?: unknown };
      if (result.status === 'accepted' || result.status === 'pending') setPhase('waiting');
      else setPhase('error');
    }).catch(() => { if (id === generation.current) setPhase('error'); });
  };

  useEffect(() => {
    if ((phase !== 'waiting' && phase !== 'ready') || request === null) return;
    const id = generation.current;
    let canceled = false;
    let timer: number | undefined;
    const poll = (): void => {
      void Promise.resolve(client.call({ m: 'readHumanInteractionResponses', communityId })).then(value => {
        if (canceled || id !== generation.current) return;
        const page = value as ReadResult;
        if (!page.authorized) {
          setResponses([]);
          setAckThrough(null);
          setBlocked(false);
          setPhase('denied');
          return;
        }
        setBlocked(page.blocked);
        if (page.responses.length > 0) {
          setResponses(page.responses);
          if (page.through !== null) setAckThrough(page.through);
          if (page.responses.some(response => response.requestId === request)) setPhase('ready');
        } else if (page.through !== null) {
          // The core suppressed a no-longer-live source event; committing the empty page is safe.
          setAckThrough(page.through);
        }
        timer = window.setTimeout(poll, page.blocked ? 10_000 : phase === 'ready' ? 10_000 : POLL_MS);
      }).catch(() => {
        if (!canceled && id === generation.current) {
          setResponses([]);
          setAckThrough(null);
          setBlocked(false);
          setPhase('error');
        }
      });
    };
    poll();
    return () => { canceled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [client, communityId, phase, request]);

  // This effect runs after React commits the response rows to the DOM. Until then the durable
  // journal remains readable across a reload or a permission-fetch failure.
  useEffect(() => {
    if (ackThrough === null) return;
    const through = ackThrough;
    void Promise.resolve(client.call({ m: 'ackHumanInteractionResponses', communityId, through })).then(() => {
      setAckThrough(value => value === through ? null : value);
    }).catch(() => undefined);
  }, [ackThrough, client, communityId]);

  const current = forCommunity === communityId;
  const currentResponses = current ? responses : [];
  const cases = currentResponses.flatMap(response => response.cases);
  const date = (seconds: string): string => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    .format(new Date(Number(seconds) * 1000));

  return <section aria-labelledby={`${base}-title`}>
    <h3 id={`${base}-title`}>{t('admin.bot.moderationLog.title')}</h3>
    <Button aria-disabled={!current || phase === 'sending' || undefined} onClick={load}>
      {phase === 'sending' ? t('admin.bot.moderationLog.loading') : t('admin.bot.moderationLog.load')}
    </Button>
    {phase === 'waiting' ? <p role="status">{t('admin.bot.moderationLog.waiting')}</p> : null}
    {phase === 'denied' ? <p role="note">{t('admin.bot.moderationLog.denied')}</p> : null}
    {current && blocked ? <p role="note">{t('admin.bot.moderationLog.blocked')}</p> : null}
    {phase === 'error' ? <p role="alert">{t('admin.bot.moderationLog.error')}</p> : null}
    {current && phase === 'ready' && currentResponses.some(response => response.requestId === request && response.status !== 0)
      ? <p role="status">{t('admin.bot.moderationLog.responseUnavailable')}</p> : null}
    {current && phase === 'ready' && cases.length === 0 && currentResponses.every(response => response.status === 0)
      ? <p role="note">{t('admin.bot.moderationLog.empty')}</p> : null}
    {cases.map(row => <article key={row.key}>
      <p>{t('admin.bot.moderationLog.caseMeta', { action: row.action, reason: row.reason, date: date(row.receivedAt) })}</p>
      <p>{row.excerpt}</p>
    </article>)}
    {currentResponses.some(response => response.hasMore) ? <p role="note">{t('admin.bot.moderationLog.more')}</p> : null}
  </section>;
}

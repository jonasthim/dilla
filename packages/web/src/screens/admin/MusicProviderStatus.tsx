import { useEffect, useRef, useState } from 'react';
import { decodeMusicProviderCapability, decodeMusicProviderStatus, toHex, type MusicProviderStatusSnapshot } from '@dilla/client-core';
import { Button } from '@dilla/ui';
import { useCore } from '../../core/context.tsx';
import { useSlice } from '../../core/use-slice.ts';
import { t, type StringKey } from '../../strings/index.ts';
import { spotifyReturnDeadline } from '../../settings/spotify-return.ts';

interface Response { requestId: string; communityId: string; operation: number; status: number; data: Uint8Array }
interface Page { responses: Response[]; through: string | null; blocked: boolean }
const labels: Record<string, StringKey> = {
  unknown: 'workspace.providers.unknown', not_linked: 'workspace.providers.notLinked', linked: 'workspace.providers.linked',
  needs_attention: 'workspace.providers.attention', configured: 'workspace.providers.configured', missing_requirements: 'workspace.providers.missing',
};
const newRequestId = () => toHex(crypto.getRandomValues(new Uint8Array(16)));

/** Operation 24 observes runtime state. OAuth delivery and local configuration never imply an account is linked. */
export function MusicProviderStatus({ communityId, installationId }: { communityId: string; installationId: string | null }) {
  const client = useCore();
  const access = useSlice(`permissions:${communityId}`);
  const authorized = access?.loaded === true && access.manageCommunity;
  const [generation, refresh] = useState(0);
  const [snapshot, setSnapshot] = useState<MusicProviderStatusSnapshot | null>(null);
  const [phase, setPhase] = useState<'loading' | 'known' | 'unavailable'>('loading');
  const [now, setNow] = useState(Date.now());
  const live = useRef({ communityId, authorized });
  live.current = { communityId, authorized };
  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(clock);
  }, []);
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const canRead = () => !stopped && live.current.communityId === communityId && live.current.authorized;
    setSnapshot(null);
    if (!authorized || installationId === null) { setPhase('unavailable'); return; }
    setPhase('loading');
    const oauthDeadline = spotifyReturnDeadline(communityId);
    const deadline = oauthDeadline ?? Date.now() + 30_000;
    let requestId = newRequestId();
    // Ask an operation understood by older bots before sending the new status operation.
    let operation: 0 | 24 = 0;
    const later = (work: () => Promise<void>) => {
      if (!canRead()) return;
      if (Date.now() >= deadline) { setPhase('unavailable'); return; }
      timer = window.setTimeout(() => void work(), 1000);
    };
    const poll = async (): Promise<void> => {
      if (!canRead()) return;
      try {
        const page = await client.call({ m: 'readBotInteractionResponses', communityId, operations: [operation] }) as Page;
        if (!canRead()) return;
        const response = page.responses.find(row => row.requestId === requestId && row.communityId === communityId && row.operation === operation);
        // The worker owns disposable observation acknowledgements, including after this page unmounts.
        if (!response) { later(poll); return; }
        if (response.status !== 0) { setPhase('unavailable'); return; }
        if (operation === 0) {
          if (!decodeMusicProviderCapability(response.data)) { setPhase('unavailable'); return; }
          operation = 24;
          requestId = newRequestId();
          await send();
          return;
        }
        const observed = decodeMusicProviderStatus(response.data);
        if (toHex(observed.installationId) !== installationId || observed.observedAt > BigInt(Math.floor(Date.now() / 1000) + 5)) throw new Error('invalid observation');
        setSnapshot(observed); setNow(Date.now()); setPhase('known');
        if (oauthDeadline !== null && observed.spotifyAccount !== 'linked' && Date.now() < deadline) {
          requestId = newRequestId(); later(send);
        }
      } catch { if (canRead()) setPhase('unavailable'); }
    };
    const send = async (): Promise<void> => {
      if (!canRead()) return;
      try {
        const sent = await client.call({ m: 'humanInteractionRequest', communityId, channelId: null, requestId, operation, args: [], revision: null }) as { upload: string };
        if (!canRead()) return;
        if (sent?.upload === 'rejected') { setPhase('unavailable'); return; }
        await poll();
      } catch { if (canRead()) setPhase('unavailable'); }
    };
    void send();
    return () => { stopped = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [client, communityId, installationId, authorized, generation]);
  const shown = authorized ? snapshot : null;
  const stale = shown !== null && now / 1000 - Number(shown.observedAt) > 60;
  const current = phase === 'known' && !stale;
  return <section aria-labelledby="music-provider-status-title" data-setting="music-providers">
    <h3 id="music-provider-status-title">{t('workspace.providers.title')}</h3>
    <p role="status" aria-busy={authorized && phase === 'loading'}>{t(authorized && phase === 'loading' ? 'workspace.providers.loading'
      : stale ? 'workspace.providers.stale' : phase === 'unavailable' || !authorized ? 'workspace.providers.unavailable' : 'workspace.providers.linkedHelp')}</p>
    <dl>
      <dt>{t('workspace.providers.spotifyAccount')}</dt><dd>{t(labels[current && shown ? shown.spotifyAccount : 'unknown'])}</dd>
      <dt>{t('workspace.providers.spotifySetup')}</dt><dd>{t(labels[current && shown ? shown.spotifyPlayback : 'unknown'])}</dd>
      <dt>{t('workspace.providers.youtubeSetup')}</dt><dd>{t(labels[current && shown ? shown.youtubePlayback : 'unknown'])}</dd>
    </dl>
    {shown ? <p>{t('workspace.providers.observed', { time: new Date(Number(shown.observedAt) * 1000).toLocaleString() })}</p> : null}
    <Button disabled={!authorized || installationId === null || phase === 'loading'} onClick={() => refresh(value => value + 1)}>{t('workspace.providers.refresh')}</Button>
  </section>;
}

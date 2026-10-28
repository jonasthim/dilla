import { useEffect, useRef, useState } from 'react';
import { createBotInteractionClient, decodeMusicProviderCapability, decodeMusicProviderStatus, toHex, type MusicProviderStatusSnapshot } from '@dilla/client-core';
import { Button, SettingsRow } from '@dilla/ui';
import { useCore } from '../../core/context.tsx';
import { useSlice } from '../../core/use-slice.ts';
import { t, type StringKey } from '../../strings/index.ts';
import { spotifyReturnDeadline } from '../../settings/spotify-return.ts';

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
    // A worker request can itself stall before polling begins. Bound the entire
    // observation attempt independently of whether individual calls settle.
    const timeout = window.setTimeout(() => {
      if (!canRead()) return;
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      setPhase('unavailable');
    }, Math.max(0, deadline - Date.now()));
    const interactions = createBotInteractionClient(client, communityId);
    let requestId = newRequestId();
    // Ask an operation understood by older bots before sending the new status operation.
    let operation: 0 | 24 = 0;
    const later = (work: () => Promise<void>) => {
      if (!canRead()) return;
      if (Date.now() >= deadline) { setPhase('unavailable'); return; }
      timer = window.setTimeout(() => void work(), 1000);
    };
    const request = async (): Promise<void> => {
      if (!canRead()) return;
      try {
        const response = await interactions.request({ requestId, operation, args: [], revision: null, channelId: null });
        if (!canRead()) return;
        if (response.status !== 0) { setPhase('unavailable'); return; }
        if (operation === 0) {
          if (!decodeMusicProviderCapability(response.data)) { setPhase('unavailable'); return; }
          operation = 24;
          requestId = newRequestId();
          await request();
          return;
        }
        const observed = decodeMusicProviderStatus(response.data);
        if (toHex(observed.installationId) !== installationId || observed.observedAt > BigInt(Math.floor(Date.now() / 1000) + 5)) throw new Error('invalid observation');
        setSnapshot(observed); setNow(Date.now()); setPhase('known');
        if (oauthDeadline !== null && observed.spotifyAccount !== 'linked' && Date.now() < deadline) {
          requestId = newRequestId(); later(request);
        } else window.clearTimeout(timeout);
      } catch { if (canRead()) setPhase('unavailable'); }
    };
    void request();
    return () => { stopped = true; window.clearTimeout(timeout); if (timer !== undefined) window.clearTimeout(timer); };
  }, [client, communityId, installationId, authorized, generation]);
  const shown = authorized ? snapshot : null;
  const stale = shown !== null && now / 1000 - Number(shown.observedAt) > 60;
  const current = phase === 'known' && !stale;
  const youtube = current && shown ? shown.youtubePlayback : 'unknown';
  const busy = authorized && phase === 'loading';
  // Task 10c, the prototype's Music page: YouTube is one row (its host status, a READY tag, "Check again"); Spotify's
  // observed account and setup follow as the row the Spotify link sits under.
  const youtubeHint = busy ? t('workspace.providers.loading') : stale ? t('workspace.providers.stale')
    : phase === 'unavailable' || !authorized ? t('workspace.providers.unavailable')
      : youtube === 'configured' ? t('serverSettings.music.youtubeReady')
        : youtube === 'missing_requirements' ? t('serverSettings.music.youtubeMissing') : t('serverSettings.music.youtubeUnknown');
  // No wrapper: the rows must stay siblings of the page's other rows so they draw one group (README §5.9).
  return <>
    <SettingsRow id="music-provider-youtube" anchor="music-providers" icon="play" label={t('serverSettings.music.youtube')} hint={youtubeHint}
      {...(youtube === 'configured' && !stale ? { tag: t('serverSettings.music.youtubeTag') } : {})}>
      <Button size="sm" aria-busy={busy || undefined} aria-disabled={!authorized || installationId === null || busy || undefined}
        onClick={() => { if (authorized && installationId !== null && !busy) refresh(value => value + 1); }}>{t('serverSettings.music.checkAgain')}</Button>
      <span className="d-sr-only" role="status">{youtubeHint}</span>
    </SettingsRow>
    {shown ? <SettingsRow id="music-provider-spotify" icon="music" label={t('workspace.providers.spotifyAccount')}
      hint={`${t(labels[current ? shown.spotifyAccount : 'unknown'])} · ${t('workspace.providers.spotifySetup')}: ${t(labels[current ? shown.spotifyPlayback : 'unknown'])} · ${t('workspace.providers.observed', { time: new Date(Number(shown.observedAt) * 1000).toLocaleString() })}`}>
      <span />
    </SettingsRow> : null}
  </>;
}

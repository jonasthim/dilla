// Server Settings → Bot: inspect the managed installation and enable/disable it through the core worker.
import { useEffect, useId, useRef, useState } from 'react';
import { Avatar, Button, SettingsRow } from '@dilla/ui';
import { useCore } from '../../core/context.tsx';
import { errorOf, type UiError } from '../../core/errors.ts';
import { useSlice } from '../../core/use-slice.ts';
import { t, type StringKey } from '../../strings/index.ts';
import { StepUpDialog } from '../settings/StepUpDialog.tsx';
import { type SectionProps } from './shared.ts';
import { authorizeSpotify, spotifySession } from './spotify-link.ts';

type Installation = { id: string; communityId: string; state: 0 | 1 | 2 | 3 | 4 | 5; revision: string;
  userId: string | null; deviceId: string | null; capabilities: number; updatedAt: string };
type Phase = 'idle' | 'stepup';
type StepUpPurpose = 'bot' | 'spotify';
const SPOTIFY_ATTEMPT_KEY = 'dilla.spotifyAttempt';

const requestId = (): string => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
const stateKey = (state: Installation['state']): StringKey => state <= 1 ? 'admin.bot.status.pending'
  : state === 2 ? 'admin.bot.status.joining' : state === 3 ? 'admin.bot.status.ready'
    : state === 4 ? 'admin.bot.status.disabled' : 'admin.bot.status.failed';
const capabilityNames = (n: number): string => [
  'music', 'welcome', 'roles', 'announcements', 'warnings', 'removal', 'kick', 'ban',
].filter((_, bit) => (n & (1 << bit)) !== 0).map(name => t(`admin.bot.capability.${name}` as StringKey)).join(', ');

function errorMessage(error: UiError): string {
  if (error.code === 'E_FORBIDDEN' || error.status === 403) return t('admin.bot.error.forbidden');
  if (error.status === 409 || error.code === 'E_CONFLICT') return t('admin.bot.error.conflict');
  return t('admin.bot.error.other', { code: error.code });
}

export function BotSection({ communityId, announce }: SectionProps): React.JSX.Element {
  const client = useCore();
  const base = useId();
  const factors = useSlice('factors');
  const members = useSlice(`members:${communityId}`);
  const [installation, setInstallation] = useState<Installation | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [stepUpPurpose, setStepUpPurpose] = useState<StepUpPurpose>('bot');
  const [busyFor, setBusyFor] = useState<string | null>(null);
  const readGeneration = useRef(0);
  const selectedCommunity = useRef(communityId);
  selectedCommunity.current = communityId;

  useEffect(() => {
    const generation = ++readGeneration.current;
    setInstallation(null);
    setLoadedFor(null);
    setError(null);
    setPhase('idle');
    void client.call({ m: 'getBotInstallation', communityId }).then(value => {
      if (generation !== readGeneration.current) return;
      setInstallation(value as Installation | null);
      setLoadedFor(communityId);
    }).catch((e: unknown) => {
      if (generation !== readGeneration.current) return;
      setError(errorMessage(errorOf(e)));
      setLoadedFor(communityId);
    });
    void client.call({ m: 'refreshFactors' }).catch(() => undefined);
  }, [client, communityId]);

  const current = loadedFor === communityId;
  const currentInstallation = current && installation?.communityId === communityId ? installation : null;
  const currentError = current ? error : null;
  const busy = busyFor === communityId;
  const enable = () => {
    if (busy || !current || currentError !== null || factors === undefined) return;
    setStepUpPurpose('bot');
    setPhase('stepup');
  };
  const configure = (stepUp: string) => {
    if (busy || selectedCommunity.current !== communityId || !current || currentError !== null || factors === undefined) return;
    const requestCommunity = communityId;
    const generation = readGeneration.current;
    setBusyFor(requestCommunity);
    setError(null);
    void client.call({ m: 'configureBotInstallation', communityId, requestId: requestId(),
      expectedRevision: currentInstallation?.revision ?? null, capabilities: 0, stepUp }).then(value => {
      if (generation !== readGeneration.current) return;
      setInstallation(value as Installation);
      announce(t('admin.bot.enabledNotice'));
    }).catch((e: unknown) => { if (generation === readGeneration.current) setError(errorMessage(errorOf(e))); })
      .finally(() => setBusyFor(value => value === requestCommunity ? null : value));
  };
  const disable = () => {
    if (busy || !current || currentError !== null || currentInstallation === null) return;
    const requestCommunity = communityId;
    const generation = readGeneration.current;
    setBusyFor(requestCommunity);
    setError(null);
    void client.call({ m: 'disableBotInstallation', communityId: requestCommunity, requestId: requestId(), expectedRevision: currentInstallation.revision }).then(value => {
      if (generation !== readGeneration.current) return;
      setInstallation(value as Installation);
      announce(t('admin.bot.disabledNotice'));
    }).catch((e: unknown) => { if (generation === readGeneration.current) setError(errorMessage(errorOf(e))); })
      .finally(() => setBusyFor(value => value === requestCommunity ? null : value));
  };
  const linkSpotify = () => {
    if (busy || !current || currentError !== null || factors === undefined) return;
    setStepUpPurpose('spotify');
    setPhase('stepup');
  };
  const beginSpotify = (stepUp: string) => {
    if (busy || selectedCommunity.current !== communityId || !current || currentError !== null) return;
    const requestCommunity = communityId;
    const generation = readGeneration.current;
    setBusyFor(requestCommunity);
    setError(null);
    let attemptId: string | null = null;
    void client.call({ m: 'beginBotSpotifyAttempt', communityId: requestCommunity, stepUp }).then((value) => {
      if (generation !== readGeneration.current || selectedCommunity.current !== requestCommunity) return;
      const attempt = value as { attemptId?: unknown; authorizeUrl?: unknown; expires?: unknown };
      if (typeof attempt.attemptId !== 'string' || !/^[0-9a-f]{32}$/.test(attempt.attemptId)
        || typeof attempt.authorizeUrl !== 'string' || typeof attempt.expires !== 'string' || !/^\d+$/.test(attempt.expires)) {
        throw new Error('invalid Spotify attempt');
      }
      attemptId = attempt.attemptId;
      const authorize = new URL(attempt.authorizeUrl);
      const states = authorize.searchParams.getAll('state');
      const expires = Number(attempt.expires);
      if (authorize.protocol !== 'https:' || authorize.hostname !== 'accounts.spotify.com' || authorize.port !== ''
        || authorize.pathname !== '/authorize' || states.length !== 1 || states[0].length < 1 || states[0].length > 256
        || !Number.isSafeInteger(expires) || expires <= Math.floor(Date.now() / 1000)) throw new Error('invalid Spotify authorization URL');
      const account = client.get('account');
      if (account?.phase !== 'ready' || !account.instance?.id || !account.user?.id || !account.deviceId) throw new Error('no active account');
      // This tab stores only public identifiers, the CSRF state and expiry. Authorization codes and all credentials
      // remain transient in the callback request and worker bridge.
      spotifySession.setItem(SPOTIFY_ATTEMPT_KEY, JSON.stringify({ communityId: requestCommunity,
        attemptId: attempt.attemptId, state: states[0], expires: attempt.expires,
        instanceId: account.instance.id, userId: account.user.id, deviceId: account.deviceId }));
      authorizeSpotify(attempt.authorizeUrl);
    }).catch(() => {
      try { spotifySession.removeItem(SPOTIFY_ATTEMPT_KEY); } catch { /* storage may be unavailable */ }
      if (attemptId !== null) void client.call({ m: 'cancelBotSpotifyAttempt', communityId: requestCommunity, attemptId }).catch(() => undefined);
      if (generation === readGeneration.current) setError(t('admin.bot.music.callbackFailed'));
    }).finally(() => setBusyFor(value => value === requestCommunity ? null : value));
  };

  const bot = currentInstallation?.userId === null || currentInstallation?.userId === undefined
    ? undefined : members?.find(m => m.userId === currentInstallation.userId && m.kind === 1);
  const enabled = currentInstallation !== null && currentInstallation.state !== 4;
  const enableUnavailable = !current || currentError !== null || factors === undefined;
  const status = currentInstallation === null ? null : t(stateKey(currentInstallation.state));

  return (
    <section className="dw-settings-section" aria-labelledby={`${base}-title`}>
      <h2 id={`${base}-title`} tabIndex={-1}>{t('admin.bot.title')}</h2>
      {!current ? <p aria-busy="true">{t('admin.bot.loading')}</p> : null}
      {current && currentInstallation === null && currentError === null ? <p>{t('admin.bot.none')}</p> : null}
      {currentInstallation !== null ? (
        <SettingsRow id={`${base}-status-row`} label={t('admin.bot.title')}>
          {bot ? <div className="dw-bot-identity"><Avatar name={bot.display || bot.username} size="sm" /><span>{bot.display || bot.username}</span></div> : null}
          <p role="status" aria-live="polite">{status}</p>
          <p>{currentInstallation.capabilities === 0 ? t('admin.bot.staged') : t('admin.bot.capabilities', { names: capabilityNames(currentInstallation.capabilities) })}</p>
        </SettingsRow>
      ) : null}
      <section aria-labelledby={`${base}-music-title`}>
        <h3 id={`${base}-music-title`}>{t('admin.bot.music.title')}</h3>
        <SettingsRow id={`${base}-spotify-row`} label={t('admin.bot.music.spotify')}>
          <Button aria-disabled={busy || !current || currentError !== null || factors === undefined || undefined}
            onClick={linkSpotify}>{busy ? t('admin.bot.music.spotifyLinking') : t('admin.bot.music.spotifyLink')}</Button>
        </SettingsRow>
        <SettingsRow id={`${base}-youtube-row`} label={t('admin.bot.music.youtube')}>
          <p>{t('admin.bot.music.providerUnknown')}</p>
          <p>{t('admin.bot.music.youtubeHelp')}</p>
        </SettingsRow>
      </section>
      {currentError === null ? null : <p role="alert">{currentError}</p>}
      <div>
        {enabled ? <Button aria-disabled={busy || undefined} onClick={disable}>{busy ? t('admin.bot.disabling') : t('admin.bot.disable')}</Button>
          : <Button variant="accent" aria-disabled={busy || enableUnavailable || undefined}
            aria-describedby={factors === undefined ? `${base}-stepup-reason` : undefined} onClick={enable}>
            {busy ? t('admin.bot.enabling') : t('admin.bot.enable')}
          </Button>}
      </div>
      {factors === undefined && !enabled ? <p id={`${base}-stepup-reason`}>{t('admin.bot.stepUpMissing')}</p> : null}
      <StepUpDialog open={phase === 'stepup'} hasPassword={factors?.hasPassword ?? true} notice={null}
        onToken={value => { setPhase('idle'); if (stepUpPurpose === 'spotify') beginSpotify(value); else configure(value); }}
        onClose={() => setPhase('idle')} />
    </section>
  );
}

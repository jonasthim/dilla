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
type JoinRoleSetting = { roleId: string | null; installationId: string };
const SPOTIFY_ATTEMPT_KEY = 'dilla.spotifyAttempt';
const BOT_STATUS_POLL_INTERVAL_MS = 2_000;
const BOT_STATUS_POLL_LIMIT = 30;

const CAPABILITY_OPTIONS = [
  { name: 'music', bit: 1 << 0, permission: null, requirement: 'music' },
  { name: 'welcome', bit: 1 << 1, permission: null, requirement: null },
  { name: 'roles', bit: 1 << 2, permission: 'manageRoles', requirement: 'roles' },
  { name: 'announcements', bit: 1 << 3, permission: null, requirement: null },
  { name: 'warnings', bit: 1 << 4, permission: 'moderateMembers', requirement: 'warnings' },
  { name: 'removal', bit: 1 << 5, permission: null, requirement: 'removal' },
  { name: 'kick', bit: 1 << 6, permission: 'kickMembers', requirement: 'kick' },
  { name: 'ban', bit: 1 << 7, permission: 'banMembers', requirement: 'ban' },
] as const;

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
  const roles = useSlice(`roles:${communityId}`);
  const access = useSlice(`permissions:${communityId}`);
  const [installation, setInstallation] = useState<Installation | null>(null);
  const [joinRole, setJoinRole] = useState<JoinRoleSetting | null>(null);
  const [joinRoleValue, setJoinRoleValue] = useState('');
  const [joinRoleLoadedFor, setJoinRoleLoadedFor] = useState<string | null>(null);
  const [joinRoleError, setJoinRoleError] = useState<string | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [stepUpPurpose, setStepUpPurpose] = useState<StepUpPurpose>('bot');
  const [busyFor, setBusyFor] = useState<string | null>(null);
  const [selectedCapabilities, setSelectedCapabilities] = useState(0);
  const [editingCapabilities, setEditingCapabilities] = useState(false);
  const editingCapabilitiesRef = useRef(false);
  const readGeneration = useRef(0);
  const selectedCommunity = useRef(communityId);
  selectedCommunity.current = communityId;

  useEffect(() => {
    const generation = ++readGeneration.current;
    let canceled = false;
    let statusTimer: number | undefined;
    setInstallation(null);
    setJoinRole(null);
    setJoinRoleValue('');
    setJoinRoleLoadedFor(null);
    setJoinRoleError(null);
    setLoadedFor(null);
    setError(null);
    setPhase('idle');
    setSelectedCapabilities(0);
    setEditingCapabilities(false);
    editingCapabilitiesRef.current = false;
    const scheduleStatusRefresh = (attempt: number): void => {
      if (canceled || attempt >= BOT_STATUS_POLL_LIMIT) return;
      statusTimer = window.setTimeout(() => {
        statusTimer = undefined;
        if (canceled || generation !== readGeneration.current) return;
        void client.call({ m: 'getBotInstallation', communityId }).then(value => {
          if (canceled || generation !== readGeneration.current) return;
          const next = value as Installation | null;
          if (next !== null && next.communityId !== communityId) return;
          if (editingCapabilitiesRef.current) {
            // Keep the edit's revision and mask together. If the server changed
            // capabilities meanwhile, saving with this older revision must conflict.
            setInstallation(current => current === null || next === null ? next : { ...current, state: next.state });
          } else {
            setInstallation(next);
            setSelectedCapabilities(next?.capabilities ?? 0);
          }
          if (next !== null && next.state <= 2) scheduleStatusRefresh(attempt + 1);
        }).catch(() => {
          if (!canceled && generation === readGeneration.current) scheduleStatusRefresh(attempt + 1);
        });
      }, BOT_STATUS_POLL_INTERVAL_MS);
    };
    void client.call({ m: 'getBotInstallation', communityId }).then(value => {
      if (canceled || generation !== readGeneration.current) return;
      const loadedInstallation = value as Installation | null;
      if (loadedInstallation !== null && loadedInstallation.communityId !== communityId) return;
      setInstallation(loadedInstallation);
      setSelectedCapabilities(loadedInstallation?.capabilities ?? 0);
      setLoadedFor(communityId);
      if (loadedInstallation !== null && loadedInstallation.state <= 2) scheduleStatusRefresh(0);
    }).catch((e: unknown) => {
      if (canceled || generation !== readGeneration.current) return;
      setError(errorMessage(errorOf(e)));
      setLoadedFor(communityId);
    });
    void client.call({ m: 'getBotJoinRole', communityId }).then(value => {
      if (generation !== readGeneration.current) return;
      const setting = value as JoinRoleSetting | null;
      setJoinRole(setting);
      setJoinRoleValue(setting?.roleId ?? '');
      setJoinRoleLoadedFor(communityId);
    }).catch((e: unknown) => {
      if (generation !== readGeneration.current) return;
      setJoinRoleError(errorMessage(errorOf(e)));
      setJoinRoleLoadedFor(communityId);
    });
    void client.call({ m: 'refreshFactors' }).catch(() => undefined);
    return () => {
      canceled = true;
      if (statusTimer !== undefined) window.clearTimeout(statusTimer);
    };
  }, [client, communityId]);

  const current = loadedFor === communityId;
  const currentInstallation = current && installation?.communityId === communityId ? installation : null;
  const currentError = current ? error : null;
  const busy = busyFor === communityId;
  const enable = () => {
    if (busy || !current || currentError !== null || factors === undefined || access?.loaded !== true || !access.manageCommunity) return;
    setStepUpPurpose('bot');
    setPhase('stepup');
  };
  const configure = (stepUp: string) => {
    if (busy || selectedCommunity.current !== communityId || !current || currentError !== null || factors === undefined
      || access?.loaded !== true || !access.manageCommunity) return;
    const requestCommunity = communityId;
    const generation = readGeneration.current;
    setBusyFor(requestCommunity);
    setError(null);
    void client.call({ m: 'configureBotInstallation', communityId, requestId: requestId(),
      expectedRevision: currentInstallation?.revision ?? null, capabilities: selectedCapabilities, stepUp }).then(value => {
      if (generation !== readGeneration.current) return;
      const updatedInstallation = value as Installation;
      setInstallation(updatedInstallation);
      setSelectedCapabilities(updatedInstallation.capabilities);
      setEditingCapabilities(false);
      editingCapabilitiesRef.current = false;
      announce(currentInstallation === null || currentInstallation.state === 4
        ? t('admin.bot.enabledNotice') : t('admin.bot.capabilities.updated'));
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
  const saveJoinRole = () => {
    if (busy || selectedCommunity.current !== communityId || !current || currentError !== null || !access?.manageRoles
      || joinRoleValue === (joinRole?.roleId ?? '')
      || joinRole === null || currentInstallation?.id !== joinRole.installationId) return;
    const requestCommunity = communityId;
    const generation = readGeneration.current;
    const zeroId = '0'.repeat(32);
    const roleId = joinRoleValue || zeroId;
    setBusyFor(requestCommunity);
    setJoinRoleError(null);
    void client.call({ m: 'configureBotJoinRole', communityId: requestCommunity, requestId: requestId(), roleId,
      installationId: joinRole.installationId }).then(value => {
      if (generation !== readGeneration.current) return;
      const ack = value as { installationId?: unknown };
      if (ack?.installationId !== joinRole.installationId) throw new Error('bot installation changed');
      setJoinRole(value => value === null ? value : { ...value, roleId: roleId === zeroId ? null : roleId });
      announce(t('admin.bot.joinRole.saved'));
    }).catch((e: unknown) => { if (generation === readGeneration.current) setJoinRoleError(errorMessage(errorOf(e))); })
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
  const canEditInstallationCapabilities = currentInstallation !== null && currentInstallation.state <= 3;
  const enableUnavailable = !current || currentError !== null || factors === undefined
    || access?.loaded !== true || !access.manageCommunity;
  const status = currentInstallation === null ? null : t(stateKey(currentInstallation.state));
  const joinRoleCandidates = (roles ?? []).filter(role => role.position > 0
    && (access?.owner === true || role.position < (access?.top ?? 0)));
  const joinRoleReady = current && joinRole !== null && currentInstallation?.id === joinRole.installationId;
  const canSelectCapability = (option: typeof CAPABILITY_OPTIONS[number]): boolean => access?.loaded === true && access.manageCommunity
    && (option.permission === null || access[option.permission] === true);
  const showCapabilitySelection = current && currentError === null
    && (currentInstallation === null || currentInstallation.state === 4 || editingCapabilities);

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
      {canEditInstallationCapabilities && !editingCapabilities ? <Button aria-disabled={busy || enableUnavailable || undefined}
        onClick={() => { editingCapabilitiesRef.current = true; setEditingCapabilities(true); }}>{t('admin.bot.capabilities.edit')}</Button> : null}
      {showCapabilitySelection ? (
        <fieldset aria-describedby={`${base}-capability-help`}>
          <legend>{t('admin.bot.capabilities.select')}</legend>
          <p id={`${base}-capability-help`}>{t('admin.bot.capabilities.permissionCeiling')}</p>
          {CAPABILITY_OPTIONS.map(option => {
            const key = `admin.bot.capability.${option.name}` as StringKey;
            const requirement = option.requirement === null ? undefined : t(`admin.bot.capability.requires.${option.requirement}` as StringKey);
            const checked = (selectedCapabilities & option.bit) !== 0;
            // A lost permission must block adding a capability, but it must not
            // trap an already-approved capability in the selected mask.
            const disabled = busy || (!checked && !canSelectCapability(option));
            return <div key={option.name}>
              <label htmlFor={`${base}-capability-${option.name}`}>
                <input id={`${base}-capability-${option.name}`} type="checkbox" checked={checked} disabled={disabled}
                  aria-describedby={requirement === undefined ? `${base}-capability-help` : `${base}-capability-help ${base}-capability-${option.name}-help`}
                  onChange={event => {
                    const checkedNow = event.currentTarget.checked;
                    setSelectedCapabilities(mask => checkedNow ? mask | option.bit : mask & ~option.bit);
                  }} />
                {t(key)}
              </label>
              {requirement === undefined ? null : <span id={`${base}-capability-${option.name}-help`}>{requirement}</span>}
              {option.permission !== null && !canSelectCapability(option) && access?.loaded === true
                ? <span>{t('admin.bot.capabilities.permissionUnavailable')}</span> : null}
            </div>;
          })}
          {canEditInstallationCapabilities ? <div>
            <Button aria-disabled={busy || enableUnavailable || undefined} onClick={enable}>{t('admin.bot.capabilities.save')}</Button>
            <Button aria-disabled={busy || undefined} onClick={() => {
              setSelectedCapabilities(currentInstallation?.capabilities ?? 0);
              setEditingCapabilities(false);
              editingCapabilitiesRef.current = false;
            }}>{t('admin.bot.capabilities.cancel')}</Button>
          </div> : null}
        </fieldset>
      ) : null}
      <section aria-labelledby={`${base}-join-role-title`}>
        <h3 id={`${base}-join-role-title`}>{t('admin.bot.joinRole.title')}</h3>
        <p>{t('admin.bot.joinRole.honest')}</p>
        {joinRoleLoadedFor === communityId && joinRole === null && joinRoleError === null && currentError === null ? <p>{t('admin.bot.joinRole.requiresBot')}</p> : null}
        {joinRoleLoadedFor === communityId && joinRoleError !== null && access?.manageRoles ? <p role="alert">{joinRoleError}</p> : null}
        {joinRoleLoadedFor !== communityId ? <p aria-busy="true">{t('admin.bot.loading')}</p> : null}
        {joinRoleReady && access?.manageRoles ? <SettingsRow id={`${base}-join-role-row`} label={t('admin.bot.joinRole.label')}>
          <select aria-label={t('admin.bot.joinRole.label')} value={joinRoleValue} disabled={busy}
            onChange={event => setJoinRoleValue(event.currentTarget.value)}>
            <option value="">{t('admin.bot.joinRole.none')}</option>
            {joinRoleCandidates.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}
          </select>
          <Button aria-disabled={busy || joinRoleValue === (joinRole?.roleId ?? '') || undefined} onClick={saveJoinRole}>
            {busy ? t('admin.bot.joinRole.saving') : t('admin.bot.joinRole.save')}
          </Button>
        </SettingsRow> : null}
      </section>
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

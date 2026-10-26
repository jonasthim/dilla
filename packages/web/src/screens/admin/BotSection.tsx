// Server Settings → Bot: inspect the managed installation and enable/disable it through the core worker.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Avatar, Button, SettingsRow, TextField } from '@dilla/ui';
import { useCore } from '../../core/context.tsx';
import { errorOf, type UiError } from '../../core/errors.ts';
import { useSlice } from '../../core/use-slice.ts';
import { t, type StringKey } from '../../strings/index.ts';
import { StepUpDialog } from '../settings/StepUpDialog.tsx';
import { useSettingsEdit, useSettingsWorkspace, type SettingsEditState } from '../../settings/edit-state.tsx';
import { ModerationLog } from './ModerationLog.tsx';
import { AutoModerationSettingsPanel } from './AutoModerationSettingsPanel.tsx';
import { WelcomeSettingsPanel, type WelcomeSettingsGateway } from './WelcomeSettingsPanel.tsx';
import { type SectionProps } from './shared.ts';
import { authorizeSpotify, spotifySession } from './spotify-link.ts';
import { MusicProviderStatus } from './MusicProviderStatus.tsx';
import { useRoute } from '../../router.ts';
import { useBotDraftState, useBotMutation } from './bot-settings-context.tsx';

export type BotPageKind = 'bot' | 'welcome' | 'joinRoles' | 'music' | 'automoderation' | 'moderationLog';

type Installation = { id: string; communityId: string; state: 0 | 1 | 2 | 3 | 4 | 5; revision: string;
  userId: string | null; deviceId: string | null; capabilities: number; updatedAt: string };
type Phase = 'idle' | 'stepup';
type StepUpPurpose = 'bot' | 'spotify';
type JoinRoleSetting = { roleId: string | null; installationId: string };
type DjRoleSetting = { roleIds: string[]; installationId: string };
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

export function BotSection({ communityId, announce, page = 'bot' }: SectionProps & { page?: BotPageKind }): React.JSX.Element {
  const client = useCore();
  const base = useId();
  const factors = useSlice('factors');
  const workspace = useSettingsWorkspace();
  const [, navigate] = useRoute();
  const beginMutation = useBotMutation();
  const members = useSlice(`members:${communityId}`);
  const channelsState = useSlice(`channels:${communityId}`);
  const communities = useSlice('communities');
  const roles = useSlice(`roles:${communityId}`);
  const access = useSlice(`permissions:${communityId}`);
  const [installation, setInstallation] = useBotDraftState<Installation | null>(communityId, 'bot.installation', null);
  const [statusRefreshing, setStatusRefreshing] = useState(false);
  const [statusRefreshError, setStatusRefreshError] = useState<string | null>(null);
  const [statusPollGeneration, setStatusPollGeneration] = useState(0);
  const [joinRole, setJoinRole] = useBotDraftState<JoinRoleSetting | null>(communityId, 'bot.joinRole', null);
  const [joinRoleValue, setJoinRoleValue] = useBotDraftState(communityId, 'bot.joinRoleValue', '');
  const [joinRoleLoadedFor, setJoinRoleLoadedFor] = useBotDraftState<string | null>(communityId, 'bot.joinRoleLoadedFor', null);
  const [joinRoleError, setJoinRoleError] = useBotDraftState<string | null>(communityId, 'bot.joinRoleError', null);
  const [djRoles, setDjRoles] = useBotDraftState<DjRoleSetting | null>(communityId, 'bot.djRoles', null);
  const [djRoleValues, setDjRoleValues] = useBotDraftState<string[]>(communityId, 'bot.djRoleValues', []);
  const [djRolesLoadedFor, setDjRolesLoadedFor] = useBotDraftState<string | null>(communityId, 'bot.djRolesLoadedFor', null);
  const [djRolesError, setDjRolesError] = useBotDraftState<string | null>(communityId, 'bot.djRolesError', null);
  const [spotifyClientId, setSpotifyClientId] = useBotDraftState(communityId, 'bot.spotifyClientId', '');
  const [spotifyRedirectUrl, setSpotifyRedirectUrl] = useBotDraftState(communityId, 'bot.spotifyRedirectUrl', '');
  const [spotifyConfigError, setSpotifyConfigError] = useBotDraftState<string | null>(communityId, 'bot.spotifyConfigError', null);
  const [botNameDraft, setBotNameDraft] = useBotDraftState(communityId, 'bot.nameDraft', '');
  const [botNameOverride, setBotNameOverride] = useBotDraftState<{ userId: string; display: string } | null>(communityId, 'bot.nameOverride', null);
  const [botNameError, setBotNameError] = useBotDraftState<string | null>(communityId, 'bot.nameError', null);
  const [loadedFor, setLoadedFor] = useBotDraftState<string | null>(communityId, 'bot.loadedFor', null);
  const [error, setError] = useBotDraftState<string | null>(communityId, 'bot.error', null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [stepUpPurpose, setStepUpPurpose] = useState<StepUpPurpose>('bot');
  const capabilitySaveResolver = useRef<((saved: boolean) => void) | null>(null);
  const [busyFor, setBusyFor] = useBotDraftState<string | null>(communityId, 'bot.busyFor', null);
  const [selectedCapabilities, setSelectedCapabilities] = useBotDraftState(communityId, 'bot.capabilities', 0);
  const [editingCapabilities, setEditingCapabilities] = useBotDraftState(communityId, 'bot.editingCapabilities', false);
  const editingCapabilitiesRef = useRef(false);
  const readGeneration = useRef(0);
  const djRolesReadGeneration = useRef(0);
  const previousInstallation = useRef<{ communityId: string; id: string; state: Installation['state'] } | null>(null);
  const statusPollAttempts = useRef({ communityId, attempts: 0 });
  const selectedCommunity = useRef(communityId);
  selectedCommunity.current = communityId;
  editingCapabilitiesRef.current = editingCapabilities;
  const serverName = communities?.find(community => community.id === communityId)?.name ?? '';
  const textChannels = useMemo(() => (channelsState ?? []).filter(channel => channel.kind === 0)
    .map(channel => ({ id: channel.id, name: channel.name })), [channelsState]);
  const welcomeGateway = useMemo<WelcomeSettingsGateway>(() => ({
    request: async input => {
      const result = await client.call({ m: 'humanInteractionRequest', ...input });
      return result as Awaited<ReturnType<WelcomeSettingsGateway['request']>>;
    },
    read: async (id, operations) => {
      const page = await client.call({ m: 'readBotInteractionResponses', communityId: id, operations });
      return page as Awaited<ReturnType<WelcomeSettingsGateway['read']>>;
    },
    ack: async (id, through) => { await client.call({ m: 'ackBotInteractionResponses', communityId: id, through }); return null; },
  }), [client]);

  useEffect(() => {
    const generation = ++readGeneration.current;
    let canceled = false;
    statusPollAttempts.current = { communityId, attempts: 0 };
    setStatusRefreshing(false);
    setStatusRefreshError(null);
    setPhase('idle');
    void client.call({ m: 'getBotInstallation', communityId }).then(value => {
      if (canceled || generation !== readGeneration.current) return;
      const loadedInstallation = value as Installation | null;
      if (loadedInstallation !== null && loadedInstallation.communityId !== communityId) return;
      setInstallation(loadedInstallation);
      if (!editingCapabilitiesRef.current) setSelectedCapabilities(loadedInstallation?.capabilities ?? 0);
      setLoadedFor(communityId);
    }).catch((e: unknown) => {
      if (canceled || generation !== readGeneration.current) return;
      setError(errorMessage(errorOf(e)));
      setLoadedFor(communityId);
    });
    void client.call({ m: 'refreshFactors' }).catch(() => undefined);
    return () => {
      canceled = true;
    };
  }, [client, communityId, setError, setInstallation, setLoadedFor, setSelectedCapabilities]);

  useEffect(() => {
    if (page !== 'joinRoles' || access?.loaded !== true || !access.manageCommunity || !access.manageRoles) return;
    let canceled = false;
    const generation = readGeneration.current;
    setJoinRoleLoadedFor(null); setJoinRoleError(null);
    void client.call({ m: 'getBotJoinRole', communityId }).then(value => {
      if (canceled || generation !== readGeneration.current) return;
      const setting = value as JoinRoleSetting | null;
      setJoinRole(setting); setJoinRoleValue(setting?.roleId ?? ''); setJoinRoleLoadedFor(communityId);
    }).catch((e: unknown) => {
      if (!canceled && generation === readGeneration.current) { setJoinRoleError(errorMessage(errorOf(e))); setJoinRoleLoadedFor(communityId); }
    });
    return () => { canceled = true; };
  }, [access?.loaded, access?.manageCommunity, access?.manageRoles, client, communityId, page, setJoinRole, setJoinRoleError, setJoinRoleLoadedFor, setJoinRoleValue]);

  useEffect(() => {
    if (page !== 'music' || access?.loaded !== true || !access.manageCommunity || !access.manageRoles) return;
    let canceled = false;
    const generation = readGeneration.current;
    const djRolesRead = ++djRolesReadGeneration.current;
    setDjRolesLoadedFor(null); setDjRolesError(null);
    void client.call({ m: 'getBotDjRoles', communityId }).then(value => {
      if (canceled || generation !== readGeneration.current || djRolesRead !== djRolesReadGeneration.current) return;
      const setting = value as DjRoleSetting | null;
      setDjRoles(setting); setDjRoleValues(setting?.roleIds ?? []); setDjRolesLoadedFor(communityId);
    }).catch((e: unknown) => {
      if (!canceled && generation === readGeneration.current && djRolesRead === djRolesReadGeneration.current) {
        setDjRolesError(errorMessage(errorOf(e))); setDjRolesLoadedFor(communityId);
      }
    });
    return () => { canceled = true; };
  }, [access?.loaded, access?.manageCommunity, access?.manageRoles, client, communityId, page, setDjRoleValues, setDjRoles, setDjRolesError, setDjRolesLoadedFor]);

  useEffect(() => {
    if (page !== 'music' || access?.loaded !== true || !access.manageCommunity) return;
    let canceled = false;
    const generation = readGeneration.current;
    void client.call({ m: 'getBotSpotifyConfig', communityId }).then(value => {
      if (canceled || generation !== readGeneration.current || value === null) return;
      const setting = value as { clientId: string; redirectUrl: string };
      setSpotifyClientId(setting.clientId); setSpotifyRedirectUrl(setting.redirectUrl);
    }).catch(() => { if (!canceled && generation === readGeneration.current) setSpotifyConfigError(t('admin.bot.music.spotifyConfigFailed')); });
    return () => { canceled = true; };
  }, [access?.loaded, access?.manageCommunity, client, communityId, page, setSpotifyClientId, setSpotifyConfigError, setSpotifyRedirectUrl]);

  useEffect(() => {
    if (page !== 'music') return;
    if (installation?.communityId !== communityId) return;
    const previous = previousInstallation.current;
    previousInstallation.current = { communityId, id: installation.id, state: installation.state };
    if (installation.state !== 3) return;
    if (previous?.communityId !== communityId || previous.id !== installation.id || previous.state === 3) return;
    const generation = readGeneration.current;
    const djRolesRead = ++djRolesReadGeneration.current;
    setDjRolesLoadedFor(null);
    setDjRolesError(null);
    void client.call({ m: 'getBotDjRoles', communityId }).then(value => {
      if (generation !== readGeneration.current || djRolesRead !== djRolesReadGeneration.current) return;
      const setting = value as DjRoleSetting | null;
      setDjRoles(setting);
      setDjRoleValues(setting?.roleIds ?? []);
      setDjRolesLoadedFor(communityId);
    }).catch((e: unknown) => {
      if (generation !== readGeneration.current || djRolesRead !== djRolesReadGeneration.current) return;
      setDjRolesError(errorMessage(errorOf(e)));
      setDjRolesLoadedFor(communityId);
    });
  }, [client, communityId, installation, page, setDjRoleValues, setDjRoles, setDjRolesError, setDjRolesLoadedFor]);

  const installationCommunityId = installation?.communityId;
  const installationState = installation?.state;
  useEffect(() => {
    if (loadedFor !== communityId || installationCommunityId !== communityId || installationState === undefined
      || installationState > 2) return;
    const generation = readGeneration.current;
    let canceled = false;
    let statusTimer: number | undefined;
    const scheduleStatusRefresh = (): void => {
      if (canceled || statusPollAttempts.current.communityId !== communityId
        || statusPollAttempts.current.attempts >= BOT_STATUS_POLL_LIMIT) return;
      statusTimer = window.setTimeout(() => {
        statusTimer = undefined;
        if (canceled || generation !== readGeneration.current) return;
        statusPollAttempts.current.attempts += 1;
        void client.call({ m: 'getBotInstallation', communityId }).then(value => {
          if (canceled || generation !== readGeneration.current) return;
          const next = value as Installation | null;
          if (next !== null && next.communityId !== communityId) return;
          if (editingCapabilitiesRef.current) {
            // Keep the edit's revision and mask together. If the server changed
            // capabilities meanwhile, saving with this older revision must conflict.
            setInstallation(previous => previous === null || next === null ? next : { ...previous, state: next.state });
          } else {
            setInstallation(next);
            setSelectedCapabilities(next?.capabilities ?? 0);
          }
          // A state transition restarts this effect; unchanged transient states
          // continue the same bounded loop without creating a second poller.
          if (next !== null && next.state <= 2 && next.state === installationState) scheduleStatusRefresh();
        }).catch(() => {
          if (!canceled && generation === readGeneration.current) scheduleStatusRefresh();
        });
      }, BOT_STATUS_POLL_INTERVAL_MS);
    };
    scheduleStatusRefresh();
    return () => {
      canceled = true;
      if (statusTimer !== undefined) window.clearTimeout(statusTimer);
    };
  }, [client, communityId, installationCommunityId, installationState, loadedFor, statusPollGeneration, setInstallation, setSelectedCapabilities]);

  const current = loadedFor === communityId;
  const currentInstallation = current && installation?.communityId === communityId ? installation : null;
  const currentError = current ? error : null;
  const busy = busyFor === communityId;
  const refreshStatus = () => {
    if (!current || statusRefreshing) return;
    const generation = readGeneration.current;
    setStatusRefreshing(true);
    setStatusRefreshError(null);
    void client.call({ m: 'getBotInstallation', communityId }).then(value => {
      if (generation !== readGeneration.current) return;
      const refreshed = value as Installation | null;
      if (refreshed !== null && refreshed.communityId !== communityId) return;
      if (editingCapabilitiesRef.current && refreshed?.state !== 3) {
        editingCapabilitiesRef.current = false;
        setEditingCapabilities(false);
        setInstallation(refreshed);
        setSelectedCapabilities(refreshed?.capabilities ?? 0);
      } else if (editingCapabilitiesRef.current) {
        setInstallation(previous => previous === null || refreshed === null ? refreshed : { ...previous, state: refreshed.state });
      } else {
        setInstallation(refreshed);
        setSelectedCapabilities(refreshed?.capabilities ?? 0);
      }
      statusPollAttempts.current = { communityId, attempts: 0 };
      setStatusPollGeneration(value => value + 1);
    }).catch((e: unknown) => {
      if (generation === readGeneration.current) setStatusRefreshError(errorMessage(errorOf(e)));
    }).finally(() => {
      if (generation === readGeneration.current) setStatusRefreshing(false);
    });
  };
  const enable = () => {
    if (busy || !current || currentError !== null || factors === undefined || access?.loaded !== true || !access.manageCommunity) return;
    setStepUpPurpose('bot');
    setPhase('stepup');
  };
  const configure = async (stepUp: string): Promise<boolean> => {
    if (busy || selectedCommunity.current !== communityId || !current || currentError !== null || factors === undefined
      || access?.loaded !== true || !access.manageCommunity) return false;
    const requestCommunity = communityId;
    const finishMutation = beginMutation?.();
    setBusyFor(requestCommunity);
    setError(null);
    try {
      const value = await client.call({ m: 'configureBotInstallation', communityId, requestId: requestId(),
        expectedRevision: currentInstallation?.revision ?? null, capabilities: selectedCapabilities, stepUp });
      if (selectedCommunity.current !== requestCommunity) return false;
      const updatedInstallation = value as Installation;
      setInstallation(updatedInstallation);
      setSelectedCapabilities(updatedInstallation.capabilities);
      setEditingCapabilities(false);
      editingCapabilitiesRef.current = false;
      announce(currentInstallation === null || currentInstallation.state === 4
        ? t('admin.bot.enabledNotice') : t('admin.bot.capabilities.updated'));
      return true;
    } catch (e) {
      if (selectedCommunity.current === requestCommunity) setError(errorMessage(errorOf(e)));
      return false;
    } finally {
      setBusyFor(value => value === requestCommunity ? null : value);
      finishMutation?.();
    }
  };
  const disable = () => {
    if (busy || !current || currentError !== null || currentInstallation === null) return;
    const requestCommunity = communityId;
    const generation = readGeneration.current;
    const finishMutation = beginMutation?.();
    setBusyFor(requestCommunity);
    setError(null);
    void client.call({ m: 'disableBotInstallation', communityId: requestCommunity, requestId: requestId(), expectedRevision: currentInstallation.revision }).then(value => {
      if (generation !== readGeneration.current) return;
      setInstallation(value as Installation);
      announce(t('admin.bot.disabledNotice'));
    }).catch((e: unknown) => { if (generation === readGeneration.current) setError(errorMessage(errorOf(e))); })
      .finally(() => { setBusyFor(value => value === requestCommunity ? null : value); finishMutation?.(); });
  };
  const saveJoinRole = useCallback(async (): Promise<boolean> => {
    if (busy || selectedCommunity.current !== communityId || !current || currentError !== null || !access?.manageRoles
      || joinRoleValue === (joinRole?.roleId ?? '')
      || joinRole === null || currentInstallation?.id !== joinRole.installationId) return false;
    const requestCommunity = communityId;
    const zeroId = '0'.repeat(32);
    const roleId = joinRoleValue || zeroId;
    const finishMutation = beginMutation?.();
    setBusyFor(requestCommunity);
    setJoinRoleError(null);
    try {
      const value = await client.call({ m: 'configureBotJoinRole', communityId: requestCommunity, requestId: requestId(), roleId,
        installationId: joinRole.installationId });
      if (selectedCommunity.current !== requestCommunity) return false;
      const ack = value as { installationId?: unknown };
      if (ack?.installationId !== joinRole.installationId) throw new Error('bot installation changed');
      setJoinRole(value => value === null ? value : { ...value, roleId: roleId === zeroId ? null : roleId });
      announce(t('admin.bot.joinRole.saved'));
      return true;
    } catch (e) { if (selectedCommunity.current === requestCommunity) setJoinRoleError(errorMessage(errorOf(e))); return false; }
    finally { setBusyFor(value => value === requestCommunity ? null : value); finishMutation?.(); }
  }, [busy, selectedCommunity, communityId, current, currentError, access?.manageRoles, joinRoleValue, joinRole, currentInstallation?.id, beginMutation,
    setBusyFor, setJoinRoleError, client, announce, setJoinRole]);
  const djRoleCandidates = (roles ?? []).filter(role => role.position > 0
    && (access?.owner === true || role.position < (access?.top ?? 0)));
  const saveDjRoles = useCallback(async (): Promise<boolean> => {
    if (busy || selectedCommunity.current !== communityId || !current || currentError !== null
      || access?.loaded !== true || !access.manageCommunity || !access.manageRoles || djRoles === null
      || currentInstallation?.state !== 3 || currentInstallation.id !== djRoles.installationId
      || djRoleValues.length > 250 || new Set(djRoleValues).size !== djRoleValues.length
      || djRoleValues.some(id => !djRoleCandidates.some(role => role.id === id))) return false;
    const requestCommunity = communityId;
    const finishMutation = beginMutation?.();
    setBusyFor(requestCommunity);
    setDjRolesError(null);
    try {
      await client.call({ m: 'configureBotDjRoles', communityId: requestCommunity, requestId: requestId(),
        installationId: djRoles.installationId, roleIds: djRoleValues });
      if (selectedCommunity.current !== requestCommunity) return false;
      setDjRoles(value => value === null ? value : { ...value, roleIds: djRoleValues });
      announce(t('admin.bot.music.djRoles.saved'));
      return true;
    } catch (e) { if (selectedCommunity.current === requestCommunity) setDjRolesError(errorMessage(errorOf(e))); return false; }
    finally { setBusyFor(value => value === requestCommunity ? null : value); finishMutation?.(); }
  }, [busy, selectedCommunity, communityId, current, currentError, access?.loaded, access?.manageCommunity, access?.manageRoles, djRoles,
    currentInstallation?.state, currentInstallation?.id, djRoleValues, djRoleCandidates, beginMutation, setBusyFor, setDjRolesError, client, announce, setDjRoles]);
  const linkSpotify = () => {
    if (busy || !current || currentError !== null || factors === undefined) return;
    if (!/^[A-Za-z0-9]{1,256}$/u.test(spotifyClientId)) {
      setSpotifyConfigError(t('admin.bot.music.spotifyClientIdInvalid'));
      return;
    }
    setSpotifyConfigError(null);
    setStepUpPurpose('spotify');
    setPhase('stepup');
  };
  const beginSpotify = (stepUp: string) => {
    if (busy || selectedCommunity.current !== communityId || !current || currentError !== null) return;
    const requestCommunity = communityId;
    const generation = readGeneration.current;
    const finishMutation = beginMutation?.();
    setBusyFor(requestCommunity);
    setError(null);
    let attemptId: string | null = null;
    void client.call({ m: 'beginBotSpotifyAttempt', communityId: requestCommunity, stepUp, clientId: spotifyClientId }).then((value) => {
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
    }).finally(() => { setBusyFor(value => value === requestCommunity ? null : value); finishMutation?.(); });
  };

  const bot = currentInstallation?.userId === null || currentInstallation?.userId === undefined
    ? undefined : members?.find(m => m.userId === currentInstallation.userId && m.kind === 1);
  const botDisplay = bot && botNameOverride?.userId === bot.userId ? botNameOverride.display : bot?.display || bot?.username || '';
  useEffect(() => {
    if (bot && botNameOverride?.userId !== bot.userId && botNameDraft === '') setBotNameDraft(bot.display || bot.username || '');
  }, [bot, botNameDraft, botNameOverride?.userId, setBotNameDraft]);
  const saveBotName = useCallback(async (): Promise<boolean> => {
    if (busy || !current || currentError !== null || bot === undefined || access?.manageCommunity !== true) return false;
    const display = botNameDraft.trim();
    if (display === '') { setBotNameError(t('admin.bot.name.invalid')); return false; }
    const requestCommunity = communityId;
    const finishMutation = beginMutation?.();
    setBusyFor(requestCommunity);
    setBotNameError(null);
    try {
      const value = await client.call({ m: 'patchBotProfile', communityId: requestCommunity, display });
      if (selectedCommunity.current !== requestCommunity) return false;
      const saved = value as string;
      setBotNameDraft(saved);
      setBotNameOverride({ userId: bot.userId, display: saved });
      announce(t('admin.bot.name.saved'));
      return true;
    } catch (e) {
      if (selectedCommunity.current === requestCommunity) setBotNameError(errorMessage(errorOf(e)));
      return false;
    } finally { setBusyFor(value => value === requestCommunity ? null : value); finishMutation?.(); }
  }, [busy, current, currentError, bot, access?.manageCommunity, botNameDraft, communityId, beginMutation, setBusyFor, setBotNameError,
    client, selectedCommunity, setBotNameDraft, setBotNameOverride, announce]);
  const enabled = currentInstallation !== null && currentInstallation.state !== 4;
  const welcomeEnabled = currentInstallation?.state === 3 && (currentInstallation.capabilities & (1 << 1)) !== 0;
  const canEditInstallationCapabilities = currentInstallation !== null && currentInstallation.state <= 3;
  const enableUnavailable = !current || currentError !== null || factors === undefined
    || access?.loaded !== true || !access.manageCommunity;
  const status = currentInstallation === null ? null : t(stateKey(currentInstallation.state));
  const joinRoleCandidates = (roles ?? []).filter(role => role.position > 0
    && (access?.owner === true || role.position < (access?.top ?? 0)));
  const joinRoleReady = current && joinRole !== null && currentInstallation?.id === joinRole.installationId;
  const djRolesReady = current && djRoles !== null && currentInstallation?.state === 3 && currentInstallation?.id === djRoles.installationId;
  const canEditDjRoles = djRolesReady && access?.loaded === true && access.manageCommunity && access.manageRoles;
  const canSelectCapability = (option: typeof CAPABILITY_OPTIONS[number]): boolean => access?.loaded === true && access.manageCommunity
    && (option.permission === null || access[option.permission] === true);
  const showCapabilitySelection = current && currentError === null
    && (currentInstallation === null || currentInstallation.state === 4 || editingCapabilities);
  const botNameDirty = bot !== undefined && botNameDraft.trim() !== botDisplay;
  const capabilityDirty = editingCapabilities && currentInstallation !== null && currentInstallation.state <= 3
    && selectedCapabilities !== currentInstallation.capabilities;
  const joinRoleDirty = page === 'joinRoles' && joinRole !== null && joinRoleValue !== (joinRole.roleId ?? '');
  const djRolesDirty = page === 'music' && djRoles !== null && djRoleValues.join(',') !== djRoles.roleIds.join(',');
  const formDirty = page === 'bot' && (botNameDirty || capabilityDirty) || joinRoleDirty || djRolesDirty;
  const saveBotForm = useCallback(async (): Promise<boolean> => {
    if (page === 'joinRoles') return saveJoinRole();
    if (page === 'music' && djRolesDirty) return saveDjRoles();
    if (botNameDirty && !(await saveBotName())) return false;
    if (!capabilityDirty) return true;
    return new Promise(resolve => {
      capabilitySaveResolver.current = resolve;
      setStepUpPurpose('bot'); setPhase('stepup');
    });
  }, [page, saveJoinRole, djRolesDirty, saveDjRoles, botNameDirty, saveBotName, capabilityDirty]);
  const canSavePage = page === 'bot' ? access?.loaded === true && access.manageCommunity && factors !== undefined
    && (!botNameDirty || botNameDraft.trim() !== '') : page === 'joinRoles'
      ? access?.loaded === true && access.manageCommunity && access.manageRoles && joinRole !== null
      : page === 'music' ? access?.loaded === true && access.manageCommunity && access.manageRoles && djRoles !== null : false;
  const botEditState = useMemo<SettingsEditState>(() => ({ dirty: formDirty, busy, canSave: formDirty && !busy && canSavePage, save: saveBotForm, reset: () => {
      if (page === 'joinRoles' && joinRole !== null) setJoinRoleValue(joinRole.roleId ?? '');
      else if (page === 'music' && djRoles !== null) setDjRoleValues(djRoles.roleIds);
      else {
      setBotNameDraft(botDisplay);
      setBotNameError(null);
      setSelectedCapabilities(currentInstallation?.capabilities ?? 0);
      setEditingCapabilities(false);
      }
    },
  }), [formDirty, busy, canSavePage, saveBotForm, page, joinRole, djRoles, setJoinRoleValue, setDjRoleValues,
    setBotNameDraft, setBotNameError, setSelectedCapabilities, setEditingCapabilities, botDisplay, currentInstallation?.capabilities]);
  const managedBotForm = useSettingsEdit(botEditState);
  const pageTitle: StringKey = page === 'bot' ? 'admin.bot.title' : page === 'welcome' ? 'admin.bot.welcomeSettings.title'
    : page === 'joinRoles' ? 'admin.bot.joinRole.title' : page === 'music' ? 'admin.bot.music.title'
      : page === 'automoderation' ? 'admin.bot.automod.title' : 'admin.bot.moderationLog.title';

  return (
    <section className="dw-settings-section dw-bot-settings" aria-labelledby={`${base}-title`}>
      <h2 id={`${base}-title`} tabIndex={-1}>{t(pageTitle)}</h2>
      {!current ? <p aria-busy="true">{t('admin.bot.loading')}</p> : null}
      {current && currentInstallation === null && currentError === null ? <p>{t('admin.bot.none')}</p> : null}
      {page !== 'bot' && page !== 'moderationLog' && current && currentInstallation?.state !== 3 ? <Button onClick={() => void navigate({ name: 'serverSettings', communityId, section: 'bot', from: null }, true)}>{t('workspace.botSetup')}</Button> : null}
      {page === 'bot' && currentInstallation !== null ? (
        <div className="dw-bot-overview">
          <div className="dw-bot-identity">
            {bot ? <Avatar name={botDisplay} size="lg" /> : null}
            <div>
              {bot ? <strong>{botDisplay}</strong> : null}
              <p role="status" aria-live="polite">{status}</p>
            </div>
            <Button aria-disabled={statusRefreshing || undefined} onClick={refreshStatus}>
              {statusRefreshing ? t('admin.bot.status.refreshing') : t('admin.bot.status.refresh')}
            </Button>
          </div>
          {bot && access?.manageCommunity === true ? <div className="dw-bot-name">
            <TextField id={`${base}-bot-display`} label={t('admin.bot.name.label')} maxLength={64} value={botNameDraft} disabled={busy}
              onChange={value => { setBotNameDraft(value); setBotNameError(null); }} error={botNameError ?? undefined} />
            {!managedBotForm ? <Button aria-disabled={busy || botNameDraft.trim() === '' || botNameDraft.trim() === botDisplay || undefined}
              onClick={() => void saveBotName()}>{t('admin.bot.name.save')}</Button> : null}
          </div> : null}
          <p className="dw-bot-capabilities-summary">{currentInstallation.capabilities === 0 ? t('admin.bot.staged') : t('admin.bot.capabilities', { names: capabilityNames(currentInstallation.capabilities) })}</p>
        </div>
      ) : null}
      {page === 'bot' && canEditInstallationCapabilities && !editingCapabilities ? <Button aria-disabled={busy || enableUnavailable || undefined}
        onClick={() => { editingCapabilitiesRef.current = true; setEditingCapabilities(true); }}>{t('admin.bot.capabilities.edit')}</Button> : null}
      {page === 'bot' && showCapabilitySelection ? (
        <fieldset className="dw-bot-capabilities" aria-describedby={`${base}-capability-help`}>
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
            {!managedBotForm ? <Button aria-disabled={busy || enableUnavailable || undefined} onClick={enable}>{t('admin.bot.capabilities.save')}</Button> : null}
            {(!managedBotForm || !capabilityDirty) ? <Button aria-disabled={busy || undefined} onClick={() => {
              setSelectedCapabilities(currentInstallation?.capabilities ?? 0);
              setEditingCapabilities(false);
              editingCapabilitiesRef.current = false;
            }}>{t('admin.bot.capabilities.cancel')}</Button> : null}
          </div> : null}
        </fieldset>
      ) : null}
      {page === 'joinRoles' ? <section aria-labelledby={`${base}-join-role-title`}>
        <h3 id={`${base}-join-role-title`}>{t('admin.bot.joinRole.title')}</h3>
        <p>{t('admin.bot.joinRole.honest')}</p>
        {joinRoleLoadedFor === communityId && joinRole === null && joinRoleError === null && currentError === null ? <p>{t('admin.bot.joinRole.requiresBot')}</p> : null}
        {access?.loaded === true && (!access.manageCommunity || !access.manageRoles) ? <p role="note">{t('admin.bot.joinRole.requiresBot')}</p> : null}
        {joinRoleLoadedFor === communityId && joinRoleError !== null && access?.manageCommunity && access.manageRoles ? <p role="alert">{joinRoleError}</p> : null}
        {joinRoleLoadedFor !== communityId ? <p aria-busy="true">{t('admin.bot.loading')}</p> : null}
        {joinRoleReady && access?.manageRoles ? <SettingsRow id={`${base}-join-role-row`} label={t('admin.bot.joinRole.label')}>
          <select aria-label={t('admin.bot.joinRole.label')} value={joinRoleValue} disabled={busy}
            onChange={event => setJoinRoleValue(event.currentTarget.value)}>
            <option value="">{t('admin.bot.joinRole.none')}</option>
            {joinRoleCandidates.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}
          </select>
          {!managedBotForm ? <Button aria-disabled={busy || joinRoleValue === (joinRole?.roleId ?? '') || undefined} onClick={() => void saveJoinRole()}>
            {busy ? t('admin.bot.joinRole.saving') : t('admin.bot.joinRole.save')}
          </Button> : null}
        </SettingsRow> : null}
      </section> : null}
      {page === 'music' ? <section aria-labelledby={`${base}-music-title`}>
        <h3 id={`${base}-music-title`}>{t('admin.bot.music.title')}</h3>
        <p>{t('admin.bot.music.djRoles.help')}</p>
        {djRolesLoadedFor !== communityId ? <p aria-busy="true">{t('admin.bot.loading')}</p> : null}
        {djRolesLoadedFor === communityId && djRoles === null && djRolesError === null ? <p>{t('admin.bot.music.djRoles.requiresBot')}</p> : null}
        {currentInstallation?.state === 3 && access?.loaded === true && (!access.manageCommunity || !access.manageRoles)
          ? <p role="note">{t('admin.bot.music.djRoles.readOnly')}</p> : null}
        {djRolesError !== null ? <p role="alert">{djRolesError}</p> : null}
        {djRolesReady ? <SettingsRow id={`${base}-dj-roles-row`} label={t('admin.bot.music.djRoles.label')} layout="stacked">
          <fieldset disabled={!canEditDjRoles || busy}>
            <legend>{t('admin.bot.music.djRoles.label')}</legend>
            {djRoleCandidates.map(role => <label key={role.id}>
              <input type="checkbox" value={role.id} checked={djRoleValues.includes(role.id)} disabled={!canEditDjRoles || busy}
                onChange={event => { const checked = event.currentTarget.checked; setDjRoleValues(value => checked
                  ? [...value, role.id] : value.filter(id => id !== role.id)); }} />{role.name}
            </label>)}
            {djRoleCandidates.length === 0 ? <p>{t('admin.bot.music.djRoles.noCandidates')}</p> : null}
          </fieldset>
          {canEditDjRoles && !managedBotForm ? <Button aria-disabled={busy || (djRoles?.roleIds.join(',') ?? '') === djRoleValues.join(',') || undefined}
            onClick={() => void saveDjRoles()}>{t('admin.bot.music.djRoles.save')}</Button> : null}
        </SettingsRow> : null}
        <SettingsRow id={`${base}-spotify-row`} label={t('admin.bot.music.spotify')} layout="stacked">
          <p>{t('admin.bot.music.spotifyClientIdHelp')}</p>
          <TextField id={`${base}-spotify-client-id`} label={t('admin.bot.music.spotifyClientId')} value={spotifyClientId}
            maxLength={256} disabled={busy || access?.manageCommunity !== true} autoComplete="off" spellCheck={false}
            onChange={value => { setSpotifyClientId(value.trim()); setSpotifyConfigError(null); }} />
          {spotifyRedirectUrl !== '' ? <p><strong>{t('admin.bot.music.spotifyCallback')}</strong> <code>{spotifyRedirectUrl}</code></p> : null}
          {spotifyConfigError !== null ? <p role="alert">{spotifyConfigError}</p> : null}
          <Button aria-disabled={busy || !current || currentError !== null || factors === undefined || undefined}
            onClick={linkSpotify}>{busy ? t('admin.bot.music.spotifyLinking') : t('admin.bot.music.spotifyLink')}</Button>
        </SettingsRow>
        <SettingsRow id={`${base}-music-commands-row`} label={t('admin.bot.music.commands')} layout="stacked">
          <p>{t('admin.bot.music.chatHelp')}</p>
        </SettingsRow>
        <MusicProviderStatus communityId={communityId} installationId={currentInstallation?.id ?? null} />
      </section> : null}
      {page === 'welcome' ? <WelcomeSettingsPanel communityId={communityId} serverName={serverName} channels={textChannels}
        enabled={welcomeEnabled} canManage={access?.loaded === true && access.manageCommunity} gateway={welcomeGateway} />
        : null}
      {page === 'automoderation' ? <AutoModerationSettingsPanel communityId={communityId} botReady={currentInstallation?.state === 3}
        canManage={access?.loaded === true && access.manageCommunity}
        canManageMessages={access?.loaded === true && (access.manageMessages ?? access.owner)}
        canModerateMembers={access?.loaded === true && (access.moderateMembers ?? access.owner)}
        capabilities={currentInstallation?.capabilities ?? 0} /> : null}
      {page === 'moderationLog' ? <ModerationLog communityId={communityId} showHeading={false} /> : null}
      {page === 'bot' && currentError === null ? null : page === 'bot' ? <p role="alert">{currentError}</p> : null}
      {page === 'bot' && statusRefreshError !== null ? <p role="alert">{statusRefreshError}</p> : null}
      {page === 'bot' ? <div className="dw-bot-lifecycle">
        {enabled ? <Button aria-disabled={busy || undefined} onClick={disable}>{busy ? t('admin.bot.disabling') : t('admin.bot.disable')}</Button>
          : <Button variant="accent" aria-disabled={busy || enableUnavailable || undefined}
            aria-describedby={factors === undefined ? `${base}-stepup-reason` : undefined} onClick={enable}>
            {busy ? t('admin.bot.enabling') : t('admin.bot.enable')}
          </Button>}
      </div> : null}
      {page === 'bot' && factors === undefined && !enabled ? <p id={`${base}-stepup-reason`}>{t('admin.bot.stepUpMissing')}</p> : null}
      <StepUpDialog open={phase === 'stepup'} hasPassword={factors?.hasPassword ?? true} notice={null}
        onToken={value => { setPhase('idle'); if (stepUpPurpose === 'spotify') {
          const authorize = () => beginSpotify(value);
          if (workspace) void workspace.requestNavigation(authorize); else authorize();
        } else void configure(value).then(saved => { capabilitySaveResolver.current?.(saved); capabilitySaveResolver.current = null; }); }}
        onClose={() => { setPhase('idle'); capabilitySaveResolver.current?.(false); capabilitySaveResolver.current = null; }} />
    </section>
  );
}

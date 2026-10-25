import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Button, SettingsRow } from '@dilla/ui';
import { t } from '../../strings/index.ts';
import { decodeWelcomeSettings, encodeWelcomeSettings, type WelcomeSettingsValue } from './welcome-settings.ts';

type Upload = 'accepted' | 'pending' | 'rejected' | 'unknown';
type WelcomeResponse = {
  deliveryId: string;
  requestId: string;
  communityId: string;
  operation: number;
  channelId: string | null;
  status: number;
  revision: string | null;
  data: Uint8Array;
  sourceSeq: string;
};
export interface WelcomeSettingsGateway {
  request(input: { communityId: string; channelId: null; requestId: string; operation: 1 | 2;
    args: readonly (string | number | Uint8Array | null)[]; revision: string | null }): Promise<{ requestId: string; upload: Upload }>;
  read(communityId: string, operations: readonly number[], requestIds: readonly string[]): Promise<{ responses: WelcomeResponse[]; through: string | null; blocked: boolean }>;
  ack(communityId: string, through: string): Promise<null>;
}

interface WelcomeSettingsPanelProps {
  communityId: string;
  serverName: string;
  channels: { id: string; name: string }[];
  enabled: boolean;
  canManage: boolean;
  gateway: WelcomeSettingsGateway;
}

interface PendingRequest {
  communityId: string;
  requestId: string;
  operation: 1 | 2;
  saved?: WelcomeSettingsValue;
}

const newRequestId = (): string => [...crypto.getRandomValues(new Uint8Array(16))]
  .map(byte => byte.toString(16).padStart(2, '0')).join('');
const validRevision = (value: string | null): value is string => value !== null && /^(0|[1-9][0-9]{0,18})$/u.test(value)
  && BigInt(value) <= 0x7fff_ffff_ffff_ffffn;

export function WelcomeSettingsPanel({ communityId, serverName, channels, enabled, canManage, gateway }: WelcomeSettingsPanelProps): React.JSX.Element {
  const base = useId();
  const [config, setConfig] = useState<WelcomeSettingsValue | null>(null);
  const [revision, setRevision] = useState<string | null>(null);
  const [selectedChannel, setSelectedChannel] = useState('');
  const [template, setTemplate] = useState('Welcome {member} to {server}!');
  const [loaded, setLoaded] = useState(false);
  const [mustReload, setMustReload] = useState(false);
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const [ackThrough, setAckThrough] = useState<{ communityId: string; through: string } | null>(null);
  const [ackRetry, setAckRetry] = useState(0);
  const generation = useRef(0);
  const currentCommunity = useRef(communityId);
  const sendingRequest = useRef<string | null>(null);
  useLayoutEffect(() => {
    currentCommunity.current = communityId;
    generation.current += 1;
    sendingRequest.current = null;
  }, [communityId]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const unavailable = !enabled || !canManage || channels.length === 0;
  const channelIdsKey = channels.map(channel => channel.id).join(',');
  const fallbackChannel = channels[0]?.id ?? '';
  const configuredDraft = config !== null && config.channelId === selectedChannel
    && config.template === template && config.serverName === serverName;

  const request = async (operation: 1 | 2, saved?: WelcomeSettingsValue): Promise<void> => {
    if (sendingRequest.current !== null || pending?.communityId === communityId || unavailable) return;
    const requestId = newRequestId();
    const requestGeneration = generation.current;
    sendingRequest.current = requestId;
    setError(null);
    setNotice(null);
    try {
      const args: readonly (string | number | Uint8Array | null)[] = operation === 1
        ? [5]
        : [5, encodeWelcomeSettings(saved!)];
      const upload = await gateway.request({ communityId, channelId: null, requestId, operation, args,
        revision: operation === 1 ? null : revision });
      if (requestGeneration !== generation.current || currentCommunity.current !== communityId) return;
      if (upload.requestId !== requestId || upload.upload === 'rejected') {
        setError(t('admin.bot.welcomeSettings.uploadFailed'));
        return;
      }
      setPending({ communityId, requestId, operation, ...(saved === undefined ? {} : { saved }) });
      setNotice(t(upload.upload === 'accepted' ? 'admin.bot.welcomeSettings.waiting' : 'admin.bot.welcomeSettings.uploadUncertain'));
    } catch {
      if (requestGeneration === generation.current && currentCommunity.current === communityId) {
        setError(t('admin.bot.welcomeSettings.uploadFailed'));
      }
    } finally {
      if (sendingRequest.current === requestId) sendingRequest.current = null;
    }
  };

  useEffect(() => {
    setConfig(null);
    setRevision(null);
    setSelectedChannel('');
    setTemplate('Welcome {member} to {server}!');
    setLoaded(false);
    setMustReload(false);
    setPending(null);
    setAckThrough(null);
    setAckRetry(0);
    setError(null);
    setNotice(null);
  }, [communityId]);

  useEffect(() => {
    if (pending === null || pending.communityId !== communityId) return;
    let canceled = false;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      try {
        const page = await gateway.read(communityId, [1, 2], [pending.requestId]);
        if (canceled) return;
        const response = page.responses.find(row => row.requestId === pending.requestId && row.communityId === pending.communityId
          && row.operation === pending.operation && row.channelId === null);
        if (response !== undefined) {
          if (response.status === 0 && validRevision(response.revision)) {
            if (pending.operation === 1) {
              const saved = decodeWelcomeSettings(response.data);
              setConfig(saved);
              setSelectedChannel(saved?.channelId ?? fallbackChannel);
              setTemplate(saved?.template ?? 'Welcome {member} to {server}!');
              setRevision(response.revision);
              setLoaded(true);
              setMustReload(false);
              setNotice(null);
            } else if (pending.saved !== undefined) {
              const empty = decodeWelcomeSettings(response.data);
              if (empty !== null) throw new Error('unexpected welcome save response data');
              setConfig(pending.saved);
              setRevision(response.revision);
              setLoaded(true);
              setMustReload(false);
              setNotice(t('admin.bot.welcomeSettings.saved'));
            }
            setPending(null);
          } else {
            setPending(null);
            setError(t(response.status === 4 ? 'admin.bot.welcomeSettings.conflict' : 'admin.bot.welcomeSettings.responseFailed'));
            if (response.status === 4) { setMustReload(true); setConfig(null); }
          }
          // Acknowledge in an effect after React commits the visible result.
          const through = page.through === null ? null : BigInt(page.through);
          const ackableRows = through === null ? [] : page.responses.filter(row => BigInt(row.deliveryId) <= through);
          const ownResponse = (row: WelcomeResponse): boolean => row.requestId === pending.requestId
            && row.communityId === pending.communityId && row.operation === pending.operation && row.channelId === null;
          if (through !== null && page.through !== null && BigInt(response.deliveryId) <= through && ackableRows.every(ownResponse)) {
            setAckRetry(0);
            setAckThrough({ communityId: pending.communityId, through: page.through });
          }
        }
        if (!canceled && pending !== null) timer = window.setTimeout(() => { void poll(); }, 750);
      } catch {
        if (!canceled) {
          setError(t('admin.bot.welcomeSettings.readFailed'));
          timer = window.setTimeout(() => { void poll(); }, 1500);
        }
      }
    };
    void poll();
    return () => { canceled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [communityId, channelIdsKey, fallbackChannel, gateway, pending]);

  useEffect(() => {
    if (ackThrough === null) return;
    let canceled = false;
    let retryTimer: number | undefined;
    void gateway.ack(ackThrough.communityId, ackThrough.through).then(() => {
      if (!canceled) setAckThrough(current => current?.communityId === ackThrough.communityId
        && current.through === ackThrough.through ? null : current);
    }).catch(() => {
      if (!canceled) retryTimer = window.setTimeout(() => {
        setAckRetry(attempt => attempt + 1);
      }, 1500);
    });
    return () => { canceled = true; if (retryTimer !== undefined) window.clearTimeout(retryTimer); };
  }, [ackThrough, ackRetry, gateway]);

  const load = (): void => { void request(1); };
  const save = (): void => {
    if (mustReload || revision === null || selectedChannel === '' || template.trim() === '' || new TextEncoder().encode(template).length > 2000) {
      setError(t('admin.bot.welcomeSettings.invalid'));
      return;
    }
    void request(2, { channelId: selectedChannel, template, serverName });
  };

  return <section aria-labelledby={`${base}-title`}>
    <h3 id={`${base}-title`}>{t('admin.bot.welcomeSettings.title')}</h3>
    <p>{t('admin.bot.welcomeSettings.help')}</p>
    {!enabled ? <p role="note">{t('admin.bot.welcomeSettings.requiresCapability')}</p> : null}
    {!canManage ? <p role="note">{t('admin.bot.welcomeSettings.readOnly')}</p> : null}
    {channels.length === 0 ? <p role="note">{t('admin.bot.welcomeSettings.noChannels')}</p> : null}
    {!loaded ? <Button aria-disabled={unavailable || pending !== null || undefined} onClick={load}>
      {pending?.operation === 1 ? t('admin.bot.welcomeSettings.loading') : t('admin.bot.welcomeSettings.load')}
    </Button> : <>
      <SettingsRow id={`${base}-channel`} label={t('admin.bot.welcomeSettings.channel')}>
        <select aria-label={t('admin.bot.welcomeSettings.channel')} value={selectedChannel} disabled={unavailable || pending !== null}
          onChange={event => setSelectedChannel(event.currentTarget.value)}>
          <option value="">{t('admin.bot.welcomeSettings.chooseChannel')}</option>
          {channels.map(channel => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
        </select>
      </SettingsRow>
      <SettingsRow id={`${base}-template`} label={t('admin.bot.welcomeSettings.template')}>
        <textarea aria-label={t('admin.bot.welcomeSettings.template')} value={template} maxLength={2000}
          disabled={unavailable || pending !== null} onChange={event => setTemplate(event.currentTarget.value)} />
        <p>{t('admin.bot.welcomeSettings.tokens')}</p>
      </SettingsRow>
      <Button aria-disabled={unavailable || pending !== null || revision === null || mustReload || undefined} onClick={save}>
        {pending?.operation === 2 ? t('admin.bot.welcomeSettings.saving') : t('admin.bot.welcomeSettings.save')}
      </Button>
      <Button aria-disabled={pending !== null || undefined} onClick={load}>{t('admin.bot.welcomeSettings.reload')}</Button>
    </>}
    {notice !== null ? <p role="status" aria-live="polite">{notice}</p> : null}
    {error !== null ? <p role="alert">{error}</p> : null}
    {configuredDraft && loaded ? <p>{t('admin.bot.welcomeSettings.configured')}</p> : null}
  </section>;
}

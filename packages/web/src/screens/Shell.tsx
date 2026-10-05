import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ChannelGroupState, TimelineItem, TimelineItemState } from '@dilla/client-core';
import {
  AppShell, Banner, ChannelHeader, ChannelList, CommunityRail, Composer, EmptyState, MessageLog, MessageRow, StatusBar, StatusChunk,
} from '@dilla/ui';
import { useCore } from '../core/context.tsx';
import { errorOf, type UiError } from '../core/errors.ts';
import { useSlice } from '../core/use-slice.ts';
import { readJoinError, useRoute } from '../router.ts';
import { t, type StringKey } from '../strings/index.ts';
import { JoinCommunity } from './JoinCommunity.tsx';
import {
  authorName, composerBlock, defaultChannel, isUnsupported, messageTime, orderChannels, stepChannel, unsupportedBody,
} from './shell-model.ts';

/** The core's body limit in UTF-8 bytes (L-CORE-09, ruling 39). */
const MESSAGE_BYTES = 4000;

const STATE_LABEL: Record<TimelineItemState, StringKey | null> = {
  ok: null,
  pending: 'shell.message.pending',
  failed: 'shell.message.failed',
  'cannot-read': 'shell.message.cannotRead',
  deleted: 'shell.message.deleted',
};

/** The composer textarea, blocked or not: a blocked one stays focusable so its reason is heard (L-UI-13). */
function focusComposer(): void {
  document.querySelector<HTMLTextAreaElement>('.d-composer textarea')?.focus();
}

/**
 * The signed-in shell: the server rail, the selected server's channels, the selected channel's
 * timeline and composer, the banners and the status bar. The route is the selection (L-TS-13); the
 * worker loads a server's lists on selectCommunity and opens a channel's group on openChannel.
 */
export function Shell(): React.JSX.Element {
  const client = useCore();
  const [route, navigate] = useRoute();
  const communityId = route.name === 'channel' ? route.communityId : null;
  const channelId = route.name === 'channel' ? route.channelId : null;

  const account = useSlice('account');
  const connection = useSlice('connection');
  const communities = useSlice('communities');
  // An empty id names a slice that never exists, so it reads undefined.
  const channels = useSlice(`channels:${communityId ?? ''}`);
  const members = useSlice(`members:${communityId ?? ''}`);
  const timeline = useSlice(`timeline:${channelId ?? ''}`);

  const [joinOpen, setJoinOpen] = useState(false);
  const [joinInvite, setJoinInvite] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<UiError | null>(null);
  const [joined, setJoined] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<UiError | null>(null);
  const [openFailure, setOpenFailure] = useState<{ channelId: string; error: UiError } | null>(null);
  const [selectFailure, setSelectFailure] = useState<{ communityId: string; error: UiError } | null>(null);
  // The channel whose loadEarlier call is in flight.
  const [loadingEarlier, setLoadingEarlier] = useState<string | null>(null);
  // The composer is controlled: the text of the channel it was typed in.
  const [draft, setDraft] = useState<{ channelId: string | null; text: string }>({ channelId: null, text: '' });

  const ordered = useMemo(() => orderChannels(channels ?? []), [channels]);
  const community = communities?.find(c => c.id === communityId) ?? null;
  const channel = ordered.find(c => c.id === channelId) ?? null;
  const unsupported = channel !== null && isUnsupported(channel);
  const group: ChannelGroupState = unsupported ? 'unsupported' : timeline?.group ?? channel?.group ?? 'none';
  const openError = openFailure !== null && openFailure.channelId === channelId ? openFailure.error : null;
  // A server whose channels never arrived because its selectCommunity was refused (pre-flight ruling (c)).
  const selectError = selectFailure !== null && selectFailure.communityId === communityId && channels === undefined
    ? selectFailure.error : null;

  const report = useCallback((e: unknown) => setCommandError(errorOf(e)), []);

  const selectCommunity = useCallback((id: string) => {
    setSelectFailure(null);
    client.call({ m: 'selectCommunity', communityId: id }).catch((e: unknown) => {
      setSelectFailure({ communityId: id, error: errorOf(e) });
      report(e);
    });
  }, [client, report]);

  // A refused open is shown in the main pane, never as a banner (Requirement 14).
  const openChannel = useCallback((id: string) => {
    setOpenFailure(null);
    client.call({ m: 'openChannel', channelId: id }).catch((e: unknown) => setOpenFailure({ channelId: id, error: errorOf(e) }));
  }, [client]);

  // (1) / and /welcome go to the first server; a followed invite link opens the join dialog first.
  useEffect(() => {
    if (communities === undefined || route.name === 'channel') return;
    if (route.name === 'welcome' && route.invite !== null) {
      setJoinInvite(route.invite);
      // A join refused right after signup rides on this history entry (task 23, pre-flight ruling (g)).
      setJoinError(readJoinError(window.history.state));
      setJoinOpen(true);
    }
    if (communities.length > 0) navigate({ name: 'channel', communityId: communities[0].id, channelId: null }, true);
    else if (route.name === 'welcome') navigate({ name: 'root' }, true);
  }, [route, communities, navigate]);

  // (2) A server that is not in the list is left for /, except the one the join dialog just reported.
  useEffect(() => {
    if (communities === undefined) return;
    if (joined !== null && communities.some(c => c.id === joined)) setJoined(null);
    if (communityId === null || communityId === joined || communities.some(c => c.id === communityId)) return;
    navigate({ name: 'root' }, true);
  }, [communityId, communities, joined, navigate]);

  // (3) Once per server change, the worker loads its channels and members.
  const known = community !== null;
  useEffect(() => {
    if (known && communityId !== null) selectCommunity(communityId);
  }, [communityId, known, selectCommunity]);

  // (4) With the channels loaded, the route names a listed channel.
  useEffect(() => {
    if (communityId === null || channels === undefined) return;
    if (channelId === null) {
      const first = defaultChannel(ordered);
      if (first !== null) navigate({ name: 'channel', communityId, channelId: first.id }, true);
    } else if (channel === null) {
      navigate({ name: 'channel', communityId, channelId: null }, true);
    }
  }, [communityId, channelId, channels, ordered, channel, navigate]);

  // (5) A selected channel web-1 can open is opened, and closed when it is left.
  const open = channel !== null && !unsupported;
  useEffect(() => {
    if (!open || channelId === null) return;
    const id = channelId;
    openChannel(id);
    return () => { client.call({ m: 'closeChannel', channelId: id }).catch(report); };
  }, [channelId, open, openChannel, client, report]);

  // Alt+ArrowUp/Down select the previous/next listed channel from anywhere; Escape in the log returns to the composer.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (e.target instanceof Element && e.target.closest('[role="log"]') !== null) focusComposer();
        return;
      }
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing || joinOpen || communityId === null) return;
      const next = stepChannel(ordered, channelId, e.key === 'ArrowUp' ? -1 : 1);
      if (next === null) return;
      e.preventDefault();
      navigate({ name: 'channel', communityId, channelId: next.id });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [ordered, channelId, communityId, joinOpen, navigate]);

  // When the join dialog closes, focus goes to the composer (after the dialog returned it to its opener).
  const wasJoinOpen = useRef(false);
  useEffect(() => {
    if (wasJoinOpen.current && !joinOpen) focusComposer();
    wasJoinOpen.current = joinOpen;
  }, [joinOpen]);

  const closeJoin = () => { setJoinOpen(false); setJoinInvite(null); setJoinError(null); };
  const onJoined = (id: string) => {
    setJoined(id);
    closeJoin();
    navigate({ name: 'channel', communityId: id, channelId: null });
  };

  const loadEarlier = () => {
    if (channelId === null) return;
    const id = channelId;
    setLoadingEarlier(id);
    const run = async () => {
      try {
        await client.call({ m: 'loadEarlier', channelId: id });
      } catch (e) {
        report(e);
      } finally {
        setLoadingEarlier(l => (l === id ? null : l));
      }
    };
    void run();
  };

  // The text stays until the send resolves; a refused send keeps it (pre-flight ruling (d)).
  const send = (text: string) => {
    if (channelId === null) return;
    const id = channelId;
    const run = async () => {
      try {
        await client.call({ m: 'send', channelId: id, text });
        setDraft(d => (d.channelId === id && d.text === text ? { channelId: id, text: '' } : d));
      } catch (e) {
        report(e);
      }
    };
    void run();
  };

  const self = account?.user ?? null;
  const now = Date.now();
  const row = (item: TimelineItem) => {
    // Only a row that was read has a body to show; an unreadable or deleted row never shows one.
    const shown = item.state === 'ok' || item.state === 'pending' || item.state === 'failed';
    const label = STATE_LABEL[item.state];
    const msgId = item.msgId;
    return (
      <MessageRow key={item.key} author={authorName(item, members, self)} time={messageTime(item.ts, now)}
        body={shown ? item.body : ''} own={item.own} tag={item.bot ? 'bot' : item.web ? 'web' : undefined} state={item.state}
        stateLabel={label === null ? undefined : t(label)}
        detail={item.state === 'failed' || item.state === 'cannot-read' ? item.reason : undefined}
        actions={item.state === 'failed' && msgId !== null ? [
          { label: t('shell.message.retry'), onAction: () => { client.call({ m: 'retrySend', msgId }).catch(report); } },
          { label: t('shell.message.discard'), onAction: () => { client.call({ m: 'discardSend', msgId }).catch(report); } },
        ] : undefined} />
    );
  };

  let main: ReactNode = null;
  if (communities !== undefined && communities.length === 0 && communityId === null) {
    main = <EmptyState title={t('shell.noServer.title')} body={t('shell.noServer.body')}
      action={{ label: t('shell.noServer.action'), onAction: () => setJoinOpen(true) }} />;
  } else if (community !== null && channels !== undefined && ordered.length === 0) {
    main = <EmptyState title={t('shell.noChannel.title')} body={t('shell.noChannel.body')} />;
  } else if (channel !== null && unsupported) {
    main = <EmptyState title={t('shell.unsupported.title')} body={t(unsupportedBody(channel))} />;
  } else if (channel !== null && openError !== null) {
    const id = channel.id;
    main = <EmptyState title={t('shell.openFailed.title')} body={t('shell.openFailed.body', { code: openError.code })}
      action={{ label: t('shell.openFailed.action'), onAction: () => openChannel(id) }} />;
  } else if (channel !== null) {
    main = (
      <MessageLog label={t('shell.log.label', { channel: channel.name })}
        emptyLabel={timeline === undefined ? t('shell.log.loading') : t('shell.log.empty')}
        earlier={timeline?.hasEarlier ? { label: t('shell.log.earlier'), onLoad: loadEarlier } : undefined}
        busy={timeline === undefined || loadingEarlier === channel.id}>
        {timeline?.items.map(row) ?? null}
      </MessageLog>
    );
  }

  let sidebar: ReactNode = null;
  if (community !== null && selectError !== null) {
    const id = community.id;
    sidebar = <EmptyState title={community.name} body={t('shell.sidebar.loadError', { code: selectError.code })}
      action={{ label: t('shell.sidebar.retry'), onAction: () => selectCommunity(id) }} />;
  } else if (community !== null) {
    sidebar = (
      <ChannelList label={t('shell.channels.label')} title={community.name}
        channels={ordered.map(c => ({ id: c.id, name: c.name, kind: c.kind === 1 ? 'voice' : 'text', readable: c.mode === 1 }))}
        activeId={channelId} onSelect={id => navigate({ name: 'channel', communityId: community.id, channelId: id })}
        emptyLabel={channels === undefined ? t('shell.channels.loading') : t('shell.channels.empty')} />
    );
  }

  const reasonKey: StringKey | null = openError !== null ? 'shell.composer.openFailed' : composerBlock(group);
  const composer = channel === null ? null : (
    <Composer label={t('shell.composer.label', { channel: channel.name })} placeholder={t('shell.composer.placeholder', { channel: channel.name })}
      maxLength={MESSAGE_BYTES} value={draft.channelId === channel.id ? draft.text : ''}
      onChange={text => setDraft({ channelId: channel.id, text })}
      disabled={reasonKey !== null} disabledReason={reasonKey === null ? undefined : t(reasonKey)}
      onSend={send} sendLabel={t('shell.composer.send')} counterLabel={n => t('shell.composer.remaining', { n })} />
  );

  const status = connection?.status ?? 'connecting';
  const tone = status === 'online' ? 'ok' : status === 'connecting' ? 'warn' : 'danger';
  const offline = connection?.status === 'offline';
  const banner = offline || commandError !== null ? (
    <>
      {offline ? (
        <Banner tone="warn">{t(connection.reason === 'version' ? 'shell.banner.clientTooOld' : 'shell.banner.offline')}</Banner>
      ) : null}
      {commandError !== null ? (
        <Banner tone="danger" action={{ label: t('shell.banner.dismiss'), onAction: () => setCommandError(null) }}>
          {t('shell.banner.commandError', { code: commandError.code })}
        </Banner>
      ) : null}
    </>
  ) : undefined;

  return (
    <>
      <AppShell
        skipLabel={t('shell.skip')}
        rail={<CommunityRail label={t('shell.rail.label')} items={communities ?? []} activeId={communityId}
          onSelect={id => navigate({ name: 'channel', communityId: id, channelId: null })}
          joinLabel={t('shell.rail.join')} onJoin={() => setJoinOpen(true)} />}
        sidebar={sidebar}
        header={channel === null ? null : <ChannelHeader name={channel.name} topic={channel.topic === '' ? undefined : channel.topic}
          readable={channel.mode === 1} readableLabel={t('shell.readable')} />}
        composer={composer}
        statusBar={
          <StatusBar position="bottom" label={t('shell.status.label')}>
            <StatusChunk label={t('shell.status.node')}>{account?.instance?.name ?? t('shell.status.unknown')}</StatusChunk>
            <StatusChunk label={t('shell.status.link')} tone={tone}>{t(`shell.status.${status}`)}</StatusChunk>
            <StatusChunk label={t('shell.status.gen')}>{connection?.generation ?? t('shell.status.unknown')}</StatusChunk>
          </StatusBar>
        }
        banner={banner}
      >
        {main}
      </AppShell>
      <JoinCommunity open={joinOpen} initialInvite={joinInvite ?? undefined} initialError={joinError ?? undefined}
        onClose={closeJoin} onJoined={onJoined} />
    </>
  );
}

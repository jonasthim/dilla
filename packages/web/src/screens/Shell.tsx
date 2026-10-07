import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ChannelGroupState, ChannelSummary } from '@dilla/client-core';
import {
  AppShell, Banner, Button, ChannelHeader, ChannelList, CommunityRail, Dialog, EmptyState, SidebarTabs,
  StatusBar, StatusChunk,
} from '@dilla/ui';
import { useCore } from '../core/context.tsx';
import { errorOf, type UiError } from '../core/errors.ts';
import { useSlice, useSlices } from '../core/use-slice.ts';
import { useDocumentVisible } from '../core/use-visible.ts';
import { baseRoute, readJoinError, useRoute } from '../router.ts';
import { t, type StringKey } from '../strings/index.ts';
import { JoinCommunity } from './JoinCommunity.tsx';
import { Conversation, focusComposer, focusLog, useConversationUi } from './conversation/Conversation.tsx';
import { ComposerArea, type OutgoingMessage } from './conversation/ComposerArea.tsx';
import { PinsButton } from './conversation/Pins.tsx';
import {
  badgeLabel, composerBlock, defaultChannel, devicesChunk, dmCandidates, isUnsupported, mentionCandidates, mentionMembers, mergeMembers,
  nameBook, orderChannels, railLabel, rowBadge, stepChannel, sumBadges, unsupportedBody,
} from './shell-model.ts';

/**
 * Focuses the rail's settings button (task 17 names it by `aria-label`), where focus returns when Settings closes;
 * does nothing when there is none.
 */
export function focusRailSettings(): void {
  document.querySelector<HTMLButtonElement>(
    'nav[aria-label="' + t('shell.rail.label') + '"] button[aria-label="' + t('shell.rail.settings') + '"]')?.focus();
}

const CATEGORY = 2;
const HEX32 = /^[0-9a-f]{32}$/;

type SidebarTab = 'channels' | 'dms';

/** True when focus was dropped to the document, as it is when the focused element leaves the DOM. */
function focusLost(): boolean {
  return document.activeElement === null || document.activeElement === document.body;
}

/** Focuses the action of an EmptyState in one pane of the shell; false when there is none. */
function focusEmptyAction(pane: 'content' | 'sidebar'): boolean {
  const button = document.querySelector<HTMLElement>(`.d-app-shell__${pane} .d-empty-state button`);
  button?.focus();
  return button !== null;
}

/**
 * A failed row's actions leave with its failed state (retry turns it pending, discard removes it), so a focused
 * action hands focus to the same action of the next failed row, else to the log (A11Y-DESIGN-05). Nothing moves
 * when focus is not in the row (a pointer that does not focus buttons).
 */
/** A channel row's or DM row's props: what ChannelList draws, with the badge of requirement 6. */
type ListRow = { id: string; name: string; kind: 'text' | 'voice' | 'dm'; readable: boolean; unread: number; mentions: number; muted: boolean };

/**
 * The signed-in shell: the server rail, the selected server's channels and the direct messages, the open
 * channel's or DM's timeline and composer, the banners and the status bar. The route is the selection (L-TS-13);
 * under a settings route the shell shows the route Settings was opened over and never navigates (L-TS-27). The
 * worker loads a server's lists on selectCommunity and opens a channel's or DM's group on openChannel.
 */
export function Shell(): React.JSX.Element {
  const client = useCore();
  const [route, navigate] = useRoute();
  const overlay = route.name === 'settings';
  const base = useMemo(() => baseRoute(route), [route]);
  const routeCommunity = base.name === 'channel' ? base.communityId : null;
  const channelId = base.name === 'channel' ? base.channelId : null;
  const dmId = base.name === 'dm' ? base.channelId : null;

  const account = useSlice('account');
  const connection = useSlice('connection');
  const communities = useSlice('communities');
  const dms = useSlice('dms');
  const badges = useSlice('badges');
  const settings = useSlice('settings');
  const devices = useSlice('devices');

  // A DM route names no server: the sidebar keeps the last one a channel route named in this mount, else the first.
  const [lastCommunity, setLastCommunity] = useState<string | null>(null);
  useEffect(() => {
    if (routeCommunity !== null) setLastCommunity(routeCommunity);
  }, [routeCommunity]);
  const fallbackCommunity = lastCommunity !== null && communities?.some(c => c.id === lastCommunity) === true
    ? lastCommunity : communities?.[0]?.id ?? null;
  const communityId = routeCommunity ?? (dmId !== null ? fallbackCommunity : null);

  // An empty id names a slice that never exists, so it reads undefined.
  const channels = useSlice(`channels:${communityId ?? ''}`);
  const members = useSlice(`members:${communityId ?? ''}`);
  const railSlices = useSlices((communities ?? []).map(c => `channels:${c.id}` as const));
  const memberLists = useSlices((communities ?? []).map(c => `members:${c.id}` as const));
  const allMembers = useMemo(() => mergeMembers(memberLists), [memberLists]);

  const [joinOpen, setJoinOpen] = useState(false);
  const [joinInvite, setJoinInvite] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<UiError | null>(null);
  const [joined, setJoined] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<UiError | null>(null);
  const [openFailure, setOpenFailure] = useState<{ channelId: string; error: UiError } | null>(null);
  const [selectFailure, setSelectFailure] = useState<{ communityId: string; error: UiError } | null>(null);
  // The channel or DM whose loadEarlier call is in flight.
  const [loadingEarlier, setLoadingEarlier] = useState<string | null>(null);
  // The composer is controlled: the text of the channel or DM it was typed in.
  const [draft, setDraft] = useState<{ channelId: string | null; text: string }>({ channelId: null, text: '' });
  // The DM picker (requirement 5).
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [pickerError, setPickerError] = useState<UiError | null>(null);

  const ordered = useMemo(() => orderChannels(channels ?? []), [channels]);
  const community = communities?.find(c => c.id === communityId) ?? null;
  const channel = ordered.find(c => c.id === channelId) ?? null;
  const dm = dmId === null ? null : dms?.find(d => d.id === dmId) ?? null;
  const unsupported = channel !== null && isUnsupported(channel);
  // What is open: an openable channel, else a listed DM. A channel that cannot open keeps no timeline.
  const openId = channel !== null && !unsupported ? channel.id : dm !== null ? dm.id : null;
  // The channel or DM on screen, open or not: the composer, the draft and loadEarlier follow it.
  const targetId = channel?.id ?? dm?.id ?? null;
  const timeline = useSlice(`timeline:${openId ?? ''}`);
  const self = account?.user ?? null;
  const conversationMembers = channel !== null ? members ?? [] : dm !== null ? allMembers.filter(m => dm.members.includes(m.userId)) : [];
  const book = useMemo(() => nameBook(self, channel !== null ? members ?? [] : allMembers), [self, channel, members, allMembers]);
  const encodeWith = mentionMembers(conversationMembers);
  const candidates = mentionCandidates(conversationMembers, self?.id ?? null);
  const broadcast = channel !== null;
  const [ui, dispatch] = useConversationUi(targetId);
  const group: ChannelGroupState = channel !== null
    ? unsupported ? 'unsupported' : timeline?.group ?? channel.group
    : dm !== null ? timeline?.group ?? dm.group : 'none';
  const openError = openFailure !== null && openFailure.channelId === openId ? openFailure.error : null;
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

  // Every effect below that navigates does nothing while Settings is open over the shell (L-TS-27, ruling 16).
  // (1) / and /welcome go to the first server; a followed invite link opens the join dialog first.
  useEffect(() => {
    if (overlay || communities === undefined || base.name === 'channel' || base.name === 'dm') return;
    if (base.name === 'welcome' && base.invite !== null) {
      setJoinInvite(base.invite);
      // A join refused right after signup rides on this history entry (task 23, pre-flight ruling (g)).
      setJoinError(readJoinError(window.history.state));
      setJoinOpen(true);
    }
    if (communities.length > 0) navigate({ name: 'channel', communityId: communities[0].id, channelId: null }, true);
    else if (base.name === 'welcome') navigate({ name: 'root' }, true);
  }, [overlay, base, communities, navigate]);

  // (2) A server that is not in the list is left for /, except the one the join dialog just reported.
  useEffect(() => {
    if (overlay || communities === undefined) return;
    if (joined !== null && communities.some(c => c.id === joined)) setJoined(null);
    if (routeCommunity === null || routeCommunity === joined || communities.some(c => c.id === routeCommunity)) return;
    navigate({ name: 'root' }, true);
  }, [overlay, routeCommunity, communities, joined, navigate]);

  // (2b) A DM the loaded list does not hold is left for /.
  useEffect(() => {
    if (overlay || dmId === null || dms === undefined || dm !== null) return;
    navigate({ name: 'root' }, true);
  }, [overlay, dmId, dms, dm, navigate]);

  // (3) Once per server change, the worker loads its channels and members.
  const listed = community !== null;
  useEffect(() => {
    if (listed && communityId !== null) selectCommunity(communityId);
  }, [communityId, listed, selectCommunity]);

  // (4) With the channels loaded, a channel route names a listed channel.
  useEffect(() => {
    if (overlay || base.name !== 'channel' || communityId === null || channels === undefined) return;
    if (channelId === null) {
      const first = defaultChannel(ordered);
      if (first !== null) navigate({ name: 'channel', communityId, channelId: first.id }, true);
    } else if (channel === null) {
      navigate({ name: 'channel', communityId, channelId: null }, true);
    }
  }, [overlay, base.name, communityId, channelId, channels, ordered, channel, navigate]);

  // (5) The channel or DM that can open is opened, and closed when it is left.
  useEffect(() => {
    if (openId === null) return;
    const id = openId;
    openChannel(id);
    return () => { client.call({ m: 'closeChannel', channelId: id }).catch(report); };
  }, [openId, openChannel, client, report]);

  // (6) Read markers (L-TS-23 markRead): while the open item's timeline is loaded, the page is visible and its badge
  // counts something, the worker moves the marker; once for each distinct (item, newest row, counts). A zero badge
  // means the marker already covers what the count sees, so nothing is sent for it.
  const visible = useDocumentVisible();
  const badge = openId === null ? undefined : badges?.[openId];
  const lastKey = timeline?.items.at(-1)?.key ?? '';
  const timelineLoaded = timeline !== undefined;
  const marked = useRef<string | null>(null);
  useEffect(() => {
    if (openId === null || !timelineLoaded || !visible) return;
    const unread = badge?.unread ?? 0;
    const mentions = badge?.mentions ?? 0;
    if (unread === 0 && mentions === 0) {
      marked.current = null;
      return;
    }
    const mark = `${openId}:${lastKey}:${unread}:${mentions}`;
    if (marked.current === mark) return;
    marked.current = mark;
    client.call({ m: 'markRead', channelId: openId }).catch(report);
  }, [openId, timelineLoaded, visible, badge?.unread, badge?.mentions, lastKey, client, report]);

  // (7) The account's device list, once per mount, for the status bar (Q12); a refusal leaves the chunk unknown.
  useEffect(() => {
    client.call({ m: 'refreshDevices' }).catch(() => undefined);
  }, [client]);

  // The sidebar tab: DMs on a DM route, channels otherwise; it follows the route between the two, and a tab click
  // changes it without navigating. State adjusted during render, React's pattern for derived state.
  // WORKER-WEB-02: with no server listed, the shell opens on the DMs tab (DMs belong to no server).
  const noServer = communities !== undefined && communities.length === 0;
  const routeTab: SidebarTab | null = base.name === 'dm' ? 'dms' : base.name === 'channel' ? 'channels' : null;
  const startTab: SidebarTab | null = routeTab ?? (noServer ? 'dms' : null);
  const [tab, setTab] = useState<SidebarTab>(startTab ?? 'channels');
  const [tabFor, setTabFor] = useState<SidebarTab | null>(startTab);
  if (tabFor !== startTab) {
    setTabFor(startTab);
    if (startTab !== null) setTab(startTab);
  }

  // Alt+ArrowUp/Down select the previous/next listed channel from anywhere on a channel route.
  const channelRoute = base.name === 'channel';
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return;
      if (overlay || joinOpen || pickerOpen || !channelRoute || communityId === null) return;
      const next = stepChannel(ordered, channelId, e.key === 'ArrowUp' ? -1 : 1);
      if (next === null) return;
      e.preventDefault();
      navigate({ name: 'channel', communityId, channelId: next.id });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [ordered, channelId, communityId, channelRoute, overlay, joinOpen, pickerOpen, navigate]);

  // A11Y-DESIGN-01: the log is keyed by its channel or DM and by its first slice, so it mounts with the rows it
  // holds and a polite log announces only rows added later. A log that held focus hands it on to its successor.
  const logKey = targetId === null ? null : `${targetId}:${timeline === undefined ? 'loading' : 'ready'}`;
  const logFocused = useRef(false);
  const conversationFocused = useRef(false);
  const composerFocused = useRef(false);
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      logFocused.current = e.target instanceof Element && e.target.closest('[role="log"]') !== null;
      conversationFocused.current = e.target instanceof Element && e.target.closest('.dw-conversation') !== null;
      composerFocused.current = e.target instanceof HTMLTextAreaElement && e.target.closest('.d-composer') !== null;
    };
    window.addEventListener('focusin', onFocusIn);
    return () => window.removeEventListener('focusin', onFocusIn);
  }, []);
  useLayoutEffect(() => {
    if (logKey !== null && logFocused.current && focusLost()) focusLog();
  }, [logKey]);
  useLayoutEffect(() => {
    if (targetId !== null && conversationFocused.current && focusLost()) focusLog();
  }, [targetId]);
  useLayoutEffect(() => {
    if (targetId !== null && composerFocused.current && focusLost()) focusComposer();
  }, [targetId]);

  // A11Y-DESIGN-05: the two "try again" buttons are replaced in the render their click causes, so focus is placed
  // after it: the main pane's goes to the log, the sidebar's to the channel list's roving stop once its rows are
  // there and the route names a channel. A retry refused again puts focus back on the new "try again".
  const refocus = useRef<'log' | 'channels' | null>(null);
  useLayoutEffect(() => {
    if (openError !== null && focusLost() && (refocus.current === 'log' || logFocused.current)) {
      if (focusEmptyAction('content')) refocus.current = null;
    }
  }, [openError]);
  useLayoutEffect(() => {
    if (selectError !== null && focusLost() && refocus.current === 'channels') {
      if (focusEmptyAction('sidebar')) refocus.current = null;
    }
  }, [selectError]);
  const channelsReady = ordered.length > 0 && (channelId !== null || defaultChannel(ordered) === null);
  // No dependency list: the target may appear several renders after the click.
  useLayoutEffect(() => {
    const want = refocus.current;
    if (want === null) return;
    if (!focusLost()) { refocus.current = null; return; }
    const target = want === 'log' ? document.querySelector<HTMLElement>('[role="log"]')
      // The rows' roving stop, not the tablist's (which sits in the same navigation since task 20).
      : channelsReady ? document.querySelector<HTMLElement>('.d-channel-list__list button[tabindex="0"]') : null;
    if (target === null) return;
    target.focus();
    refocus.current = null;
  });

  // When the join dialog closes, focus goes to the composer (after the dialog returned it to its opener).
  const wasJoinOpen = useRef(false);
  useEffect(() => {
    if (wasJoinOpen.current && !joinOpen) focusComposer();
    wasJoinOpen.current = joinOpen;
  }, [joinOpen]);

  // When the picker opened a DM, focus goes to its composer as the join dialog's does (pre-flight row 2.20); a picker
  // closed without one leaves focus where the dialog returned it, on "message someone".
  const pickedDm = useRef(false);
  useEffect(() => {
    if (pickerOpen || !pickedDm.current) return;
    pickedDm.current = false;
    focusComposer();
  }, [pickerOpen]);

  const closeJoin = () => { setJoinOpen(false); setJoinInvite(null); setJoinError(null); };
  const onJoined = (id: string) => {
    setJoined(id);
    closeJoin();
    navigate({ name: 'channel', communityId: id, channelId: null });
  };

  const closePicker = () => { setPickerOpen(false); setPickerError(null); };
  // One openDm at a time: the ref refuses a second click before the busy render lands.
  const picking = useRef(false);
  const startDm = (userId: string) => {
    if (picking.current) return;
    picking.current = true;
    setPickerBusy(true);
    setPickerError(null);
    const run = async () => {
      try {
        const result = await client.call({ m: 'openDm', userId });
        const id = typeof result === 'object' && result !== null ? (result as { channelId?: unknown }).channelId : undefined;
        if (typeof id === 'string' && HEX32.test(id)) {
          pickedDm.current = true;
          setPickerOpen(false);
          navigate({ name: 'dm', channelId: id });
        }
      } catch (e) {
        setPickerError(errorOf(e));
      } finally {
        picking.current = false;
        setPickerBusy(false);
      }
    };
    void run();
  };

  const loadEarlier = () => {
    if (targetId === null) return;
    const id = targetId;
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

  // The channels whose send is in flight: a second Enter or a click on send meanwhile posts nothing (WEB-APP-01).
  const sending = useRef(new Set<string>());
  // The text stays until the send resolves; a refused send keeps it (pre-flight ruling (d)).
  const send = (m: OutgoingMessage) => {
    if (targetId === null) return;
    const id = targetId;
    if (sending.current.has(id)) return;
    sending.current.add(id);
    const run = async () => {
      try {
        await client.call({ m: 'send', channelId: id, text: m.text,
          ...(m.replyTo !== null ? { replyTo: m.replyTo } : {}),
          ...(m.attachments.length > 0 ? { attachments: [...m.attachments] } : {}) });
        setDraft(d => (d.channelId === id && d.text === m.raw ? { channelId: id, text: '' } : d));
        if (m.replyTo !== null) dispatch({ type: 'replySent', msgId: m.replyTo });
      } catch (e) {
        report(e);
      } finally {
        sending.current.delete(id);
      }
    };
    void run();
  };

  const log = (label: string) => targetId === null || logKey === null ? null : <Conversation key={targetId} channelId={targetId}
    logKey={logKey} label={label} timeline={timeline} book={book} encodeWith={encodeWith} broadcast={broadcast}
    pinsTitle={channel !== null ? t('shell.pins.title', { channel: channel.name }) : t('shell.pins.titleDm', { name: dm?.name ?? '' })}
    ui={ui} dispatch={dispatch} loadingEarlier={loadingEarlier === targetId} onLoadEarlier={loadEarlier} onError={report} />;
  const openFailed = (id: string, error: UiError) => (
    <EmptyState title={t('shell.openFailed.title')} body={t('shell.openFailed.body', { code: error.code })}
      action={{ label: t('shell.openFailed.action'), onAction: () => { refocus.current = 'log'; openChannel(id); } }} />
  );

  let main: ReactNode = null;
  if (dm !== null) {
    main = openError !== null ? openFailed(dm.id, openError) : log(t('shell.dm.log', { name: dm.name }));
  } else if (communities !== undefined && communities.length === 0 && communityId === null) {
    main = <EmptyState title={t('shell.noServer.title')} body={t('shell.noServer.body')}
      action={{ label: t('shell.noServer.action'), onAction: () => setJoinOpen(true) }} />;
  } else if (community !== null && channels !== undefined && ordered.length === 0) {
    main = <EmptyState title={t('shell.noChannel.title')} body={t('shell.noChannel.body')} />;
  } else if (channel !== null && unsupported) {
    main = <EmptyState title={t('shell.unsupported.title')} body={t(unsupportedBody(channel))} />;
  } else if (channel !== null && openError !== null) {
    main = openFailed(channel.id, openError);
  } else if (channel !== null) {
    main = log(t('shell.log.label', { channel: channel.name }));
  }

  // Badges (Q02, Q09, ruling 15): what each row shows, a muted row's unread hidden; the rail and the tabs sum them.
  const channelRows: ListRow[] = ordered.map(c => ({
    id: c.id, name: c.name, kind: c.kind === 1 ? 'voice' : 'text', readable: c.mode === 1, ...rowBadge(badges, settings, c.id),
  }));
  const dmRows: ListRow[] = (dms ?? []).map(d => ({ id: d.id, name: d.name, kind: 'dm', readable: false, ...rowBadge(badges, settings, d.id) }));
  const channelCounts = sumBadges(channelRows);
  const dmCounts = sumBadges(dmRows);
  const railItems = (communities ?? []).map((c, i) => {
    const list: readonly ChannelSummary[] = railSlices[i] ?? [];
    const counts = sumBadges(list.filter(ch => ch.kind !== CATEGORY).map(ch => rowBadge(badges, settings, ch.id)));
    return { id: c.id, name: c.name, unread: counts.unread, mentions: counts.mentions };
  });

  // The sidebar with its tabs stands whenever a server is shown, DMs exist or a DM route is open (WORKER-WEB-02). On the
  // channels tab, a server that did not load and the absence of any server are said inside the tab panel, so the
  // DMs tab stays reachable (A11Y-DESIGN-02).
  let sidebar: ReactNode = null;
  const hasDms = (dms?.length ?? 0) > 0 || dmId !== null;
  if (community !== null || hasDms) {
    const onDms = tab === 'dms';
    const serverId = community?.id ?? null;
    let content: ReactNode;
    if (!onDms && community !== null && selectError !== null) {
      const id = community.id;
      content = <EmptyState title={community.name} body={t('shell.sidebar.loadError', { code: selectError.code })}
        action={{ label: t('shell.sidebar.retry'), onAction: () => { refocus.current = 'channels'; selectCommunity(id); } }} />;
    } else if (!onDms && community === null) {
      content = <EmptyState title={t('shell.noServer.title')} body={t('shell.noServer.body')}
        action={{ label: t('shell.noServer.action'), onAction: () => setJoinOpen(true) }} />;
    }
    sidebar = (
      <ChannelList label={t(onDms ? 'shell.dms.label' : 'shell.channels.label')}
        title={community?.name ?? account?.instance?.name ?? t('shell.status.unknown')}
        tabs={<SidebarTabs label={t('shell.tabs.label')} activeId={tab} onSelect={id => setTab(id === 'dms' ? 'dms' : 'channels')} tabs={[
          { id: 'channels', label: t('shell.tabs.channels'), count: channelCounts.unread, mentions: channelCounts.mentions },
          { id: 'dms', label: t('shell.tabs.dms'), count: dmCounts.unread, mentions: dmCounts.mentions },
        ]} />}
        channels={onDms ? dmRows : channelRows}
        activeId={onDms ? dmId : channelId}
        onSelect={id => navigate(onDms || serverId === null ? { name: 'dm', channelId: id } : { name: 'channel', communityId: serverId, channelId: id })}
        emptyLabel={onDms ? t('shell.dms.empty') : channels === undefined ? t('shell.channels.loading') : t('shell.channels.empty')}
        rowLabel={badgeLabel}
        content={content}
        footer={onDms && community !== null ? <Button variant="ghost" onClick={() => setPickerOpen(true)}>{t('shell.dms.new')}</Button> : undefined} />
    );
  }

  const reasonKey: StringKey | null = openError !== null ? 'shell.composer.openFailed' : composerBlock(group);
  const composerLabel = channel !== null ? t('shell.composer.label', { channel: channel.name })
    : dm !== null ? t('shell.dm.composer', { name: dm.name }) : null;
  const composerPlaceholder = channel !== null ? t('shell.composer.placeholder', { channel: channel.name })
    : dm !== null ? t('shell.dm.composer', { name: dm.name }) : null;
  const composer = targetId === null || composerLabel === null || composerPlaceholder === null ? null : (
    <ComposerArea key={targetId} channelId={targetId} label={composerLabel} placeholder={composerPlaceholder}
      blocked={reasonKey === null ? null : t(reasonKey)} broadcast={broadcast} encodeWith={encodeWith} candidates={candidates}
      items={timeline?.items ?? []} book={book} draft={draft.channelId === targetId ? draft.text : ''}
      onDraft={text => setDraft({ channelId: targetId, text })} ui={ui} dispatch={dispatch} onSend={send} onError={report} />
  );

  const header = channel !== null
    ? <ChannelHeader name={channel.name} topic={channel.topic === '' ? undefined : channel.topic}
      readable={channel.mode === 1} readableLabel={t('shell.readable')}
      actions={openId !== null ? <PinsButton onOpen={() => dispatch({ type: 'pins', open: true })} /> : undefined} />
    : dm !== null ? <ChannelHeader kind="dm" name={dm.name}
      actions={openId !== null ? <PinsButton onOpen={() => dispatch({ type: 'pins', open: true })} /> : undefined} /> : null;

  const status = connection?.status ?? 'connecting';
  const tone = status === 'online' ? 'ok' : status === 'connecting' ? 'warn' : 'danger';
  const offline = connection?.status === 'offline';
  // BACKUPS-RECOVERY-04: persistent, with no dismiss: it stands while the worker reports the mismatch.
  const rootMismatch = account?.rootMismatch === true;
  const banner = offline || commandError !== null || rootMismatch ? (
    <>
      {rootMismatch ? (
        <Banner tone="danger">{t('devices.rootMismatch', { instance: account.instance?.name ?? t('shell.status.unknown') })}</Banner>
      ) : null}
      {offline ? (
        <Banner tone="warn">{t(connection.reason === 'version' ? 'shell.banner.clientTooOld' : 'shell.banner.offline')}</Banner>
      ) : null}
      {commandError !== null ? (
        <Banner tone="danger" action={{ label: t('shell.banner.dismiss'), onAction: () => { focusComposer(); setCommandError(null); } }}>
          {t('shell.banner.commandError', { code: commandError.code })}
        </Banner>
      ) : null}
    </>
  ) : undefined;

  return (
    <>
      <AppShell
        skipLabel={t('shell.skip')}
        rail={<CommunityRail label={t('shell.rail.label')} items={railItems} activeId={communityId}
          onSelect={id => navigate({ name: 'channel', communityId: id, channelId: null })}
          joinLabel={t('shell.rail.join')} onJoin={() => setJoinOpen(true)}
          settingsLabel={t('shell.rail.settings')} onSettings={() => navigate({ name: 'settings', section: 'devices', from: null })}
          itemLabel={railLabel} />}
        sidebar={sidebar}
        header={header}
        composer={composer}
        statusBar={
          <StatusBar position="bottom" label={t('shell.status.label')}>
            <StatusChunk label={t('shell.status.node')}>{account?.instance?.name ?? t('shell.status.unknown')}</StatusChunk>
            <StatusChunk label={t('shell.status.link')} tone={tone}>{t(`shell.status.${status}`)}</StatusChunk>
            <StatusChunk label={t('shell.status.gen')}>{connection?.generation ?? t('shell.status.unknown')}</StatusChunk>
            <StatusChunk label={t('shell.status.devices')}>{devicesChunk(devices)}</StatusChunk>
          </StatusBar>
        }
        banner={banner}
      >
        {main}
      </AppShell>
      <JoinCommunity open={joinOpen} initialInvite={joinInvite ?? undefined} initialError={joinError ?? undefined}
        onClose={closeJoin} onJoined={onJoined} />
      <DmPicker open={pickerOpen} members={dmCandidates(members, self?.id ?? null)} busy={pickerBusy} error={pickerError}
        onClose={closePicker} onPick={startDm} />
    </>
  );
}

/** The DM picker (requirement 5): the server's members, one "message" button each, the refusal inside the dialog. */
function DmPicker(p: {
  open: boolean; members: readonly { userId: string; username: string; display: string }[]; busy: boolean; error: UiError | null;
  onClose: () => void; onPick: (userId: string) => void;
}): React.JSX.Element {
  const idBase = useId();
  return (
    <Dialog open={p.open} title={t('shell.dms.newTitle')} closeLabel={t('dialog.close')} onClose={p.onClose}>
      {p.error !== null ? <Banner tone="danger">{t('shell.banner.commandError', { code: p.error.code })}</Banner> : null}
      <p>{t('shell.dms.newBody')}</p>
      <ul className="dw-dm-picker">
        {p.members.map(m => {
          const nameId = `${idBase}-${m.userId}`;
          return (
            <li key={m.userId} className="dw-dm-picker__row">
              <span id={nameId}>{m.display || m.username}</span>
              <Button size="sm" aria-describedby={nameId} aria-disabled={p.busy ? true : undefined}
                onClick={() => { if (!p.busy) p.onPick(m.userId); }}>{t('shell.dms.open')}</Button>
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}

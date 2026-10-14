import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { ChannelGroupState, ChannelSummary, SendBlock, TrustBlock, TrustSummary } from '@dilla/client-core';
import {
  AppShell, Banner, Button, ChannelHeader, ChannelList, CommunityRail, Dialog, EmptyState, SidebarTabs,
  StatusBar, StatusChunk, UnsupportedVoice,
} from '@dilla/ui';
import { useCore } from '../core/context.tsx';
import { errorOf, type UiError } from '../core/errors.ts';
import { useSlice, useSlices } from '../core/use-slice.ts';
import { useDocumentVisible } from '../core/use-visible.ts';
import { baseRoute, readJoinError, useRoute } from '../router.ts';
import { en, t, type StringKey } from '../strings/index.ts';
import { JoinCommunity } from './JoinCommunity.tsx';
import { CreateChannelFlow, CreateServerFlow, InviteFlow } from './Create.tsx';
import { Conversation, focusComposer, focusLog, useConversationUi } from './conversation/Conversation.tsx';
import { ComposerArea, type OutgoingMessage } from './conversation/ComposerArea.tsx';
import { PinsButton } from './conversation/Pins.tsx';
import { Search, type SearchHitView } from './Search.tsx';
import { TrustAlert, TypingIndicator } from '@dilla/ui';
import {
  badgeLabel, composerBlock, defaultChannel, devicesChunk, dmCandidates, isUnsupported, isVoice, mentionCandidates, mentionMembers, mergeMembers,
  nameBook, orderChannels, railLabel, rowBadge, stepChannel, sumBadges, unsupportedBody,
} from './shell-model.ts';
import { useCall } from './voice/useCall.tsx';
import { ActiveVoiceList, DmCall, Dock, removedFromServer, speakingDevices, VoiceSection, VoiceView, type VoiceContext } from './voice/VoiceView.tsx';
import { RingFlow } from './voice/Ring.tsx';
import { MemberPane } from './admin/MemberPane.tsx';
import { ServerSettings, type AdminTab } from './admin/ServerSettings.tsx';
import { useSounds } from './voice/useSounds.tsx';

/**
 * Focuses the rail's settings button (task 17 names it by `aria-label`), where focus returns when Settings closes;
 * does nothing when there is none.
 */
export function focusRailSettings(): void {
  document.querySelector<HTMLButtonElement>(
    'nav[aria-label="' + t('shell.rail.label') + '"] button[aria-label="' + t('shell.rail.settings') + '"]')?.focus();
}

const CATEGORY = 2;
// The codes a send is refused with when the core's send gate holds the group (L-CORE-40, sec ruling 2).
const TRUST_BLOCKS: ReadonlySet<string> = new Set<TrustBlock>(['E_UMK_CHANGED', 'E_CREDENTIAL', 'E_DEVICE_UNLISTED', 'E_TIER_MISMATCH']);

/**
 * The composer's reason for a send block (W-01, R1). A block only own-user leaves hold names the own account and Devices;
 * a changed key asks for a comparison only when a changed member of the conversation (`changed`) has a key to compare,
 * else it says there is nothing to compare yet; any other failed leaf is privacy.leafFailed.
 */
export function blockReason(block: SendBlock, changed: readonly TrustSummary[]): StringKey {
  if (block.own) return block.code === 'E_UMK_CHANGED' ? 'privacy.ownChanged' : 'privacy.ownUnlisted';
  if (block.code !== 'E_UMK_CHANGED') return 'privacy.leafFailed';
  return changed.some(row => row.changedUmk !== null) ? 'privacy.changed' : 'privacy.changedNoKey';
}

/** A contact whose identity changed: a validated pending key, or a leaf the core holds under a key no list presents. */
export function isChanged(row: TrustSummary): boolean {
  return row.changedUmk !== null || row.blocked === 'E_UMK_CHANGED';
}
const HEX32 = /^[0-9a-f]{32}$/;
/** Flow 07: the selected server's lists are read again when the window comes back, at most this often, so a channel another
 *  member added shows without a reload even when its op 54 community_changed was missed (this is the fallback to op 54). */
export const LIST_REFRESH_MS = 15_000;
// Renew an unchanged typing signal after 5 s: above the server's 3 s meter, inside its 10 s hold (L-HTTP-96).
const TYPING_RENEW_MS = 5_000;
/** No device speaking: the voice rows of calls this device is not in (product walk M3). */
const NOBODY: ReadonlySet<string> = new Set();

type SidebarTab = 'channels' | 'dms';

/** True when focus was dropped to the document, as it is when the focused element leaves the DOM. */
function focusLost(): boolean {
  return document.activeElement === null || document.activeElement === document.body;
}

/**
 * The search palette is a modal dialog, so the shell beneath it is inert and cannot take focus: a picked hit closes that
 * top layer first, then focuses its row (the palette's React state follows when the pick resolves).
 */
function leaveSearchLayer(): void {
  document.querySelector<HTMLDialogElement>('dialog.dw-search[open]')?.close();
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
  const search = useSlice('search');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchScope, setSearchScope] = useState<'channel' | 'community' | 'all'>('all');
  const [searchRequest, setSearchRequest] = useState(0);
  const searchRequestRef = useRef(0);
  // The page's own count of search commands still unanswered: the palette says it is searching until the newest settles.
  const searchCalls = useRef(0);
  const [searchBusy, setSearchBusy] = useState(false);
  // Where focus was when the palette opened; Escape or close returns it there, a picked hit keeps focus on its row.
  const searchOpener = useRef<HTMLElement | null>(null);
  const restoreSearchFocus = useRef<HTMLElement | null>(null);
  const trust = useSlice('trust');
  const sendBlocks = useSlice('sendBlocks');
  const callSlice = useSlice('call');
  const voiceSlice = useSlice('voice');
  const rings = useSlice('rings');
  // A send the core refused for a trust reason, until the next published gate says more (W-01).
  const [refusedSend, setRefusedSend] = useState<{ channelId: string; code: TrustBlock; gate: unknown } | null>(null);

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
  // Flow 07: start a server, add a channel, copy an invite link.
  const [createOpen, setCreateOpen] = useState(false);
  const [channelOpen, setChannelOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  // Flow 08: the member pane (a toggle in the channel header; open at 64rem or wider, not remembered) and the server settings
  // dialog (the server it is open for, and its tab).
  const [membersOpen, setMembersOpen] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 64rem)').matches);
  const [adminFor, setAdminFor] = useState<string | null>(null);
  const [adminTab, setAdminTab] = useState<AdminTab>('overview');
  const access = useSlice(`permissions:${communityId ?? ''}`);
  // The toggle is found by its marker: the shared Button takes no ref, and AppShell reads `current` only when the drawer closes.
  const membersToggle = useMemo<RefObject<HTMLElement | null>>(
    () => ({ get current() { return document.querySelector<HTMLElement>('[data-members-toggle]'); } }), []);
  // The one polite announcer (always rendered); MemberPane and ServerSettings speak through it.
  const [announcement, setAnnouncement] = useState('');
  const announce = useCallback((text: string) => setAnnouncement(text), []);
  const removals = useSlice('removals');
  const [dismissedRemovals, setDismissedRemovals] = useState<ReadonlySet<number>>(() => new Set());
  const seenRemovals = useRef<ReadonlySet<number>>(new Set());
  const createFlowOpen = createOpen || channelOpen || inviteOpen;
  // The text channel a create just opened: its composer takes focus once it is on screen (after the dialog handed focus back).
  // `from` is the conversation open when the wish was made: the shell may still show it for a render or two.
  const pendingFocus = useRef<{ id: string; from: string | null } | null>(null);
  // The DM picker (requirement 5).
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [pickerError, setPickerError] = useState<UiError | null>(null);

  const ordered = useMemo(() => orderChannels(channels ?? []), [channels]);
  const community = communities?.find(c => c.id === communityId) ?? null;
  const channel = ordered.find(c => c.id === channelId) ?? null;
  const dm = dmId === null ? null : dms?.find(d => d.id === dmId) ?? null;
  // A voice channel shows the voice view (web-3): no timeline, no composer.
  const voiceChannel = channel !== null && isVoice(channel) ? channel : null;
  const unsupported = channel !== null && voiceChannel === null && isUnsupported(channel);
  // What is open: an openable channel, else a listed DM. A channel that cannot open keeps no timeline.
  const openId = channel !== null && !unsupported && voiceChannel === null ? channel.id : dm !== null ? dm.id : null;
  // The channel or DM on screen, open or not: the composer, the draft and loadEarlier follow it.
  const targetId = (voiceChannel === null ? channel?.id : undefined) ?? dm?.id ?? null;
  const timeline = useSlice(`timeline:${openId ?? ''}`);
  const typing = useSlice(`typing:${openId ?? ''}`) ?? [];
  const typingNames = [...new Map(typing.map(row => [row.userId, row.name])).values()];
  const searchId = searchScope === 'channel' ? targetId : searchScope === 'community' ? communityId : null;
  const issueSearch = (query: string, scope: 'channel' | 'community' | 'all', id: string | null) => {
    if (!query.trim() || (scope !== 'all' && id === null)) return;
    searchRequestRef.current = Math.max(searchRequestRef.current, search?.requestId ?? 0);
    setSearchRequest(0);
    const call = ++searchCalls.current;
    setSearchBusy(true);
    client.call({ m: 'search', scope, id, query, cursor: null }).catch(report)
      .finally(() => { if (searchCalls.current === call) setSearchBusy(false); });
  };
  useEffect(() => {
    if (searchOpen && search?.requestId && search.requestId > searchRequestRef.current) {
      searchRequestRef.current = search.requestId;
      setSearchRequest(search.requestId);
    }
  }, [searchOpen, search]);
  const startSearch = (scope: 'channel' | 'all') => {
    const active = document.activeElement;
    searchOpener.current = active instanceof HTMLElement && active !== document.body ? active : null;
    setSearchScope(scope);
    setSearchQuery('');
    setSearchOpen(true);
  };
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing || event.shiftKey || event.altKey || !(event.ctrlKey || event.metaKey)) return;
      // M-01: never under another modal (pins, lightbox, any open dialog), and never again while search is open.
      if (overlay || joinOpen || pickerOpen || createFlowOpen || searchOpen || document.querySelector('dialog[open]') !== null) return;
      if (event.key.toLowerCase() === 'k') { event.preventDefault(); startSearch('all'); }
      else if (event.ctrlKey && !event.metaKey && event.key === '/' && targetId !== null) {
        event.preventDefault(); startSearch('channel');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overlay, joinOpen, pickerOpen, createFlowOpen, searchOpen, targetId]);
  useEffect(() => {
    if (searchOpen) return;
    const opener = restoreSearchFocus.current;
    restoreSearchFocus.current = null;
    if (opener?.isConnected) opener.focus();
  }, [searchOpen]);
  const self = account?.user ?? null;
  // A removal is told once: the banner below, and nothing of that server stays open (effects (2) and (1) below already take the route
  // from a server that left the list to the first remaining one).
  useEffect(() => {
    const fresh = (removals ?? []).filter(r => !seenRemovals.current.has(r.id));
    if (fresh.length === 0) return;
    seenRemovals.current = new Set([...seenRemovals.current, ...fresh.map(r => r.id)]);
    const gone = new Set(fresh.map(r => r.communityId));
    setAdminFor(open => (open !== null && gone.has(open) ? null : open));
    if (communityId !== null && gone.has(communityId)) {
      setChannelOpen(false);
      setInviteOpen(false);
    }
  }, [removals, communityId]);
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

  // Voice (web-3, flow 06). The name of a channel or DM for {where}, from every loaded server and the DM list.
  const whereOf = useCallback((id: string) => (railSlices.flat() as ChannelSummary[]).find(c => c.id === id)?.name
    ?? dms?.find(d => d.id === id)?.name ?? id.slice(0, 8), [railSlices, dms]);
  // After a leave the person asked for, focus goes to the voice row (or the DM's call button) the call came from.
  const [leftFrom, setLeftFrom] = useState<{ id: string } | null>(null);
  // Product walk M8: {where} of a call names a DM's call as "the call with {name}", a voice channel by its name.
  const callWhere = useCallback((id: string) => (dms?.some(d => d.id === id) === true ? t('call.where', { name: whereOf(id) }) : whereOf(id)),
    [dms, whereOf]);
  const call = useCall({ client, call: callSlice, settings: settings ?? {}, whereOf: callWhere, onLeft: id => setLeftFrom({ id }),
    stageShown: id => id === (voiceChannel?.id ?? dm?.id) });
  useLayoutEffect(() => {
    if (leftFrom === null) return;
    const name = whereOf(leftFrom.id);
    // WB a11y m5: only the call's own row, or its own DM's call button; else the sidebar's active tab, where the dock was
    // (never another DM's call button, never the page).
    const target = document.querySelector<HTMLElement>(`button.d-voice-row[aria-label="${CSS.escape(t('voice.open', { name }))}"]`)
      ?? (dm?.id === leftFrom.id ? document.querySelector<HTMLElement>('.dw-call-strip__start') : null)
      ?? document.querySelector<HTMLElement>('.dw-sidebar [role="tab"][aria-selected="true"]');
    target?.focus();
    setLeftFrom(null);
  }, [leftFrom, whereOf, dm?.id]);
  // A typing signal is a hint: one the worker refuses (the channel is not viewable any more, or the socket is not online,
  // E_NOT_READY) is simply not sent, never an error banner (the docs shoot's shell-not-member image showed one).
  const typingRefused = useCallback(() => undefined, []);
  const typingSent = useRef<string | null>(null);
  const typingAt = useRef(0);
  useEffect(() => {
    const active = draft.channelId === targetId && draft.text.trim() !== '' ? targetId : null;
    if (typingSent.current === active) {
      // The server holds a typing signal for 10 s and meters one per 3 s (L-HTTP-96): a draft still changing renews it.
      if (active !== null && Date.now() - typingAt.current >= TYPING_RENEW_MS) {
        typingAt.current = Date.now();
        client.call({ m: 'typing', channelId: active, on: true }).catch(typingRefused);
      }
      return;
    }
    if (typingSent.current !== null) client.call({ m: 'typing', channelId: typingSent.current, on: false }).catch(typingRefused);
    typingSent.current = active;
    if (active !== null) {
      typingAt.current = Date.now();
      client.call({ m: 'typing', channelId: active, on: true }).catch(typingRefused);
    }
  }, [client, draft.channelId, draft.text, targetId, typingRefused]);
  useEffect(() => () => {
    if (typingSent.current !== null) client.call({ m: 'typing', channelId: typingSent.current, on: false }).catch(typingRefused);
  }, [client, typingRefused]);

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

  // (3) Once per server change, the worker loads its channels and members, and who is in its voice channels (L-TS-50
  // loadVoice; a refusal leaves the rows without people).
  const listed = community !== null;
  useEffect(() => {
    if (!listed || communityId === null) return;
    selectCommunity(communityId);
    client.call({ m: 'loadVoice', communityId, channelId: null }).catch(() => undefined);
  }, [communityId, listed, selectCommunity, client]);
  // (3a) Flow 07: the selected server's lists again when the window comes back, at most once per LIST_REFRESH_MS (counting the
  // load above). A background read: a failure keeps the lists and raises no banner, as the picker's re-read does. A return
  // inside the window is not dropped: it schedules one trailing read at the window's end (WB m1), which a hidden page skips
  // (its next return reads). The instance's op 54 community_changed is what announces a new channel; this re-read is the
  // fallback for a frame missed while the socket was down or the tab asleep.
  const listedAt = useRef(0);
  useEffect(() => {
    if (!listed || communityId === null) return;
    listedAt.current = Date.now();
    const id = communityId;
    let trailing: ReturnType<typeof setTimeout> | null = null;
    const read = () => {
      listedAt.current = Date.now();
      client.call({ m: 'selectCommunity', communityId: id }).catch(() => undefined);
    };
    const refresh = () => {
      if (document.visibilityState === 'hidden') return;
      const wait = listedAt.current + LIST_REFRESH_MS - Date.now();
      if (wait <= 0) { read(); return; }
      trailing ??= setTimeout(() => {
        trailing = null;
        if (document.visibilityState !== 'hidden') read();
      }, wait);
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      if (trailing !== null) clearTimeout(trailing);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [communityId, listed, client]);
  // (3b) An open DM: whether a call is live in it.
  const dmOpen = dm?.id ?? null;
  useEffect(() => {
    if (dmOpen !== null) client.call({ m: 'loadVoice', communityId: null, channelId: dmOpen }).catch(() => undefined);
  }, [dmOpen, client]);

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
      if (overlay || joinOpen || pickerOpen || createFlowOpen || !channelRoute || communityId === null) return;
      const next = stepChannel(ordered, channelId, e.key === 'ArrowUp' ? -1 : 1);
      if (next === null) return;
      e.preventDefault();
      navigate({ name: 'channel', communityId, channelId: next.id });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [ordered, channelId, communityId, channelRoute, overlay, joinOpen, pickerOpen, createFlowOpen, navigate]);

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

  // Flow 07: a created text channel's composer takes focus once it is on screen. No dependency list: it may appear several
  // renders after the create answered. The wish is dropped once another conversation opens (review M6), so a composer that
  // shows later, after the person went elsewhere and came back, does not take focus.
  useEffect(() => {
    const pending = pendingFocus.current;
    if (pending === null) return;
    if (targetId !== null && targetId !== pending.id && targetId !== pending.from) { pendingFocus.current = null; return; }
    if (targetId !== pending.id) return;
    const box = document.querySelector<HTMLTextAreaElement>('.d-composer textarea');
    if (box === null || createFlowOpen) return;
    box.focus();
    pendingFocus.current = null;
  });

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
        const error = errorOf(e);
        if (TRUST_BLOCKS.has(error.code)) setRefusedSend({ channelId: id, code: error.code as TrustBlock, gate: client.get('sendBlocks') });
        else report(e);
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

  useSounds({ rings, room: call.channelId === null ? undefined : voiceSlice?.[call.channelId], inCall: call.channelId,
    deafened: call.state?.deafened ?? false, settings: settings ?? {}, selfId: self?.id ?? null });
  // A ring is answered in its DM: the DM opens and its call is joined (leaving the current voice first, useCall's join).
  const ringFlow = <RingFlow client={client} rings={rings} dms={dms} settings={settings ?? {}}
    inCallWhere={call.channelId === null ? null : callWhere(call.channelId)}
    onOpen={id => navigate({ name: 'dm', channelId: id })}
    onAnswer={id => { navigate({ name: 'dm', channelId: id }); call.join(id); }} />;
  const voiceCtx: VoiceContext = {
    call, slice: callSlice, voice: voiceSlice, members: allMembers, trust, sendBlocks, settings: settings ?? {}, self, ownDevice: account?.deviceId ?? null,
    onCompare: userId => navigate({ name: 'settings', section: 'privacy', from: null, compare: userId }),
    onVoiceSettings: () => navigate({ name: 'settings', section: 'voice', from: null }),
  };

  // Flow 07: with no server, the one way in is to start one or to join one.
  const noServerState = <EmptyState title={t('shell.noServer.title')} body={t('shell.noServer.body')}
    action={{ label: t('shell.noServer.create'), onAction: () => setCreateOpen(true) }}
    secondary={{ label: t('shell.noServer.action'), onAction: () => setJoinOpen(true) }} />;

  let main: ReactNode = null;
  if (dm !== null) {
    main = openError !== null ? openFailed(dm.id, openError) : <>
      <DmCall v={voiceCtx} channelId={dm.id} name={dm.name} />
      {log(t('shell.dm.log', { name: dm.name }))}
    </>;
  } else if (voiceChannel !== null) {
    main = <VoiceView v={voiceCtx} channelId={voiceChannel.id} name={voiceChannel.name} />;
  } else if (communities !== undefined && communities.length === 0 && communityId === null) {
    main = noServerState;
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
  // The voice channels sit under their own heading with their people (flow 06), not among the text rows.
  const speakingNow = speakingDevices(call.state, account?.deviceId ?? null);
  const voiceRows = ordered.filter(isVoice).map(c => ({ id: c.id, name: c.name, readable: false, current: c.id === channelId,
    joined: call.channelId === c.id, room: voiceSlice?.[c.id], speaking: call.channelId === c.id ? speakingNow : NOBODY,
    held: removedFromServer({ slice: callSlice }, c.id) }));
  const openVoice = (id: string) => { if (communityId !== null) navigate({ name: 'channel', communityId, channelId: id }); };
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
  // Flow 07: with no server the sidebar still stands, on the DMs tab, so its picker can say why it is empty.
  if (community !== null || hasDms || noServer) {
    const onDms = tab === 'dms';
    const serverId = community?.id ?? null;
    let content: ReactNode;
    if (!onDms && community !== null && selectError !== null) {
      const id = community.id;
      content = <EmptyState title={community.name} body={t('shell.sidebar.loadError', { code: selectError.code })}
        action={{ label: t('shell.sidebar.retry'), onAction: () => { refocus.current = 'channels'; selectCommunity(id); } }} />;
    } else if (!onDms && community === null) {
      content = noServerState;
    }
    const voiceHere = !onDms && community !== null && content === undefined;
    // Flow 07: the server's actions. The instance serves no role bits, so the one permission fact here is ownership: the
    // owner holds ManageChannels; every member holds CreateInvite by default (@everyone), and a refusal is said in the dialog.
    const owner = community !== null && self !== null && community.owner === self.id;
    const canManageChannels = access?.loaded === true ? access.manageChannels : owner;
    const openAdmin = (tab: AdminTab) => { if (community !== null) { setAdminTab(tab); setAdminFor(community.id); } };
    const actions = voiceHere ? <>
      {canManageChannels ? <Button className="dw-new-channel" aria-label={t('create.channel.open')} onClick={() => setChannelOpen(true)}>
        {t('create.channel.button')}</Button> : null}
      <Button onClick={() => setInviteOpen(true)}>{t('invite.open')}</Button>
      <Button onClick={() => openAdmin('overview')}>{t('admin.open')}</Button>
      {canManageChannels ? <Button onClick={() => openAdmin('channels')}>{t('admin.channel.open')}</Button> : null}
      {!owner ? <Button onClick={() => openAdmin('danger')}>{t('admin.leave.open')}</Button> : null}
    </> : undefined;
    sidebar = (<div className="dw-sidebar">
      <ChannelList label={t(onDms ? 'shell.dms.label' : 'shell.channels.label')}
        title={community?.name ?? account?.instance?.name ?? t('shell.status.unknown')}
        actions={actions} actionsLabel={t('create.actions')}
        tabs={<>
          <SidebarTabs label={t('shell.tabs.label')} activeId={tab} onSelect={id => setTab(id === 'dms' ? 'dms' : 'channels')} tabs={[
            { id: 'channels', label: t('shell.tabs.channels'), count: channelCounts.unread, mentions: channelCounts.mentions },
            { id: 'dms', label: t('shell.tabs.dms'), count: dmCounts.unread, mentions: dmCounts.mentions },
          ]} />
          {voiceHere ? <ActiveVoiceList rows={voiceRows} onOpen={openVoice} /> : null}
        </>}
        channels={onDms ? dmRows : channelRows.filter(row => !voiceRows.some(v => v.id === row.id))}
        activeId={onDms ? dmId : channelId}
        onSelect={id => navigate(onDms || serverId === null ? { name: 'dm', channelId: id } : { name: 'channel', communityId: serverId, channelId: id })}
        emptyLabel={onDms ? t('shell.dms.empty') : channels === undefined ? t('shell.channels.loading') : t('shell.channels.empty')}
        rowLabel={badgeLabel}
        content={content}
        // Product walk M12: opening the picker reads the server's members again (a removal, a newcomer since the load).
        // Fix round 3 (m4): a background read: a failure keeps the cached list and raises no banner.
        footer={onDms ? <Button variant="ghost" onClick={() => {
          if (community !== null) client.call({ m: 'selectCommunity', communityId: community.id }).catch(() => undefined);
          setPickerOpen(true);
        }}>{t('shell.dms.new')}</Button>
          : voiceHere && voiceRows.length > 0 ? <VoiceSection rows={voiceRows} onOpen={openVoice}
            onJoin={id => { openVoice(id); call.join(id); }} /> : undefined} />
      <Dock v={voiceCtx} where={call.channelId === null ? '' : callWhere(call.channelId)}
        stageShown={call.channelId !== null && call.channelId === (voiceChannel?.id ?? dm?.id)} />
    </div>);
  }

  // A validated Remove of a changed leaf unblocked sending here only; the contact stays changed elsewhere (Flow 05).
  const removedHere = targetId !== null && (trust ?? []).some(row => isChanged(row) && row.removedIn?.includes(targetId) === true);
  // Flow 05 "changed": a member of this conversation whose identity changed stands as an alert with no dismiss, until the
  // new key is verified or a validated Remove restored sending here. Names come from the worker's trust slice only.
  const audience = new Set(channel !== null ? (members ?? []).map(member => member.userId) : dm?.members ?? []);
  const changedMembers = targetId === null ? [] : (trust ?? []).filter(row => isChanged(row) && audience.has(row.userId)
    && row.removedIn?.includes(targetId) !== true);
  // L-CORE-40, W-01: the core's send gate of this conversation (sendBlocks) blocks the composer until the key is verified or
  // a validated Remove; the composer says why instead of letting a send fail. Before the worker first publishes the gate,
  // a changed member of this conversation blocks it (fail closed). A trust refusal of a send stands until the next gate.
  // A refused send or the fail-closed guess does not say whose leaf holds the block: it is the own account's only when no
  // changed contact is in the conversation and the worker reports an own key under another identity.
  const guess = (code: TrustBlock): SendBlock =>
    ({ code, own: code === 'E_UMK_CHANGED' && changedMembers.length === 0 && account?.ownTrust === 'changed' });
  const gate = sendBlocks === undefined ? (changedMembers.length > 0 ? guess('E_UMK_CHANGED') : undefined)
    : targetId === null ? undefined : sendBlocks[targetId];
  const refused = refusedSend !== null && refusedSend.channelId === targetId && refusedSend.gate === sendBlocks ? guess(refusedSend.code) : undefined;
  const block = gate ?? refused;
  const reasonKey: StringKey | null = openError !== null ? 'shell.composer.openFailed'
    : composerBlock(group) ?? (block !== undefined ? blockReason(block, changedMembers) : null);
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

  const header = voiceChannel !== null ? null : channel !== null
    ? <ChannelHeader name={channel.name} topic={channel.topic === '' ? undefined : channel.topic}
      readable={channel.mode === 1} readableLabel={t('shell.readable')}
      actions={<>
        {openId !== null ? <PinsButton onOpen={() => dispatch({ type: 'pins', open: true })} /> : null}
        <Button data-members-toggle="" pressed={membersOpen} onClick={() => setMembersOpen(open => !open)}>{t('members.toggle')}</Button>
      </>} />
    : dm !== null ? <ChannelHeader kind="dm" name={dm.name}
      actions={openId !== null ? <PinsButton onOpen={() => dispatch({ type: 'pins', open: true })} /> : undefined} /> : null;
  // While Settings covers the conversation, its Privacy section carries the alert and the action instead.
  const changedHere = overlay ? [] : changedMembers;

  const searchHits: SearchHitView[] = (search?.hits ?? []).map(hit => {
    const location = hit.communityId === null ? dms?.find(row => row.id === hit.channelId)?.name
      : (railSlices.flat() as ChannelSummary[]).find(row => row.id === hit.channelId)?.name;
    return { ...hit, id: `${hit.channelId}:${hit.seq}`, location: location ?? hit.channelId };
  });
  const pickSearchHit = async (hit: SearchHitView): Promise<boolean> => {
    const known = hit.communityId === null ? dms?.some(row => row.id === hit.channelId)
      : (railSlices.flat() as ChannelSummary[]).some(row => row.id === hit.channelId && row.communityId === hit.communityId);
    if (!known) return false;
    const name = `timeline:${hit.channelId}` as const;
    const available = () => client.get(name)?.items.some(item => item.seq === hit.seq && item.state === 'ok') === true;
    navigate(hit.communityId === null ? { name: 'dm', channelId: hit.channelId }
      : { name: 'channel', communityId: hit.communityId, channelId: hit.channelId });
    if (client.get(name) === undefined) {
      await new Promise<void>(resolve => {
        const timeout = setTimeout(() => { stop(); resolve(); }, 1000);
        const stop = client.subscribe(name, () => {
          const current = client.get(name);
          if (current === undefined) return;
          stop();
          clearTimeout(timeout);
          resolve();
        });
      });
    }
    if (client.get(name) === undefined) return false;
    while (!available() && client.get(name)?.hasEarlier) {
      const previous = client.get(name);
      await client.call({ m: 'loadEarlier', channelId: hit.channelId });
      if (client.get(name) === previous) break;
    }
    if (!available()) return false;
    await new Promise<void>(resolve => {
      const focus = () => {
        const row = document.querySelector<HTMLElement>(`.dw-conversation[data-channel-id="${hit.channelId}"] .d-message-row[data-seq="${hit.seq}"]`);
        if (!row) return false;
        leaveSearchLayer();
        row.focus();
        row.scrollIntoView?.({ block: 'center' });
        resolve();
        return true;
      };
      if (focus()) return;
      const observer = new MutationObserver(() => { if (focus()) { observer.disconnect(); clearTimeout(timeout); } });
      observer.observe(document.body, { childList: true, subtree: true });
      const timeout = setTimeout(() => {
        observer.disconnect();
        const heading = document.querySelector<HTMLElement>('.d-channel-header__name');
        leaveSearchLayer();
        heading?.setAttribute('tabindex', '-1');
        heading?.focus();
        resolve();
      }, 1000);
    });
    return true;
  };

  const pickerMembers = dmCandidates(members, self?.id ?? null);
  const status = connection?.status ?? 'connecting';
  const tone = status === 'online' ? 'ok' : status === 'connecting' ? 'warn' : 'danger';
  const offline = connection?.status === 'offline';
  // BACKUPS-RECOVERY-04: persistent, with no dismiss: it stands while the worker reports the mismatch.
  const rootMismatch = account?.rootMismatch === true;
  // Privacy lists no own row; what the core reports about the own key stands here, persistent, while the worker reports it.
  const ownTrust = account?.ownTrust ?? null;
  const removalNotices = (removals ?? []).filter(r => !dismissedRemovals.has(r.id));
  const banner = offline || removalNotices.length > 0 || commandError !== null || rootMismatch || ownTrust !== null || removedHere || changedHere.length > 0 ? (
    <>
      {rootMismatch ? (
        <Banner tone="danger">{t('devices.rootMismatch', { instance: account.instance?.name ?? t('shell.status.unknown') })}</Banner>
      ) : null}
      {ownTrust !== null ? (
        <Banner tone="danger" action={{ label: t('privacy.ownAction'), onAction: () => navigate({ name: 'settings', section: 'devices', from: null }) }}>
          {t(ownTrust === 'changed' ? 'privacy.ownChanged' : 'privacy.ownUnlisted')}
        </Banner>
      ) : null}
      {offline ? (
        <Banner tone="warn">{t(connection.reason === 'version' ? 'shell.banner.clientTooOld' : 'shell.banner.offline')}</Banner>
      ) : null}
      {removalNotices.map(r => (
        <Banner key={r.id} tone="warn" action={{ label: t('shell.banner.dismiss'), onAction: () => {
          focusComposer();
          setDismissedRemovals(done => new Set([...done, r.id]));
        } }}>{t('removed.notice', { server: r.name })}</Banner>
      ))}
      {removedHere ? <p className="dw-trust-removed" role="status">{t('privacy.removed')}</p> : null}
      {changedHere.length > 0 ? <div className="dw-trust-alerts" data-doc-state="trust-conversation">{changedHere.map(row => <TrustAlert key={row.userId} kind="changed" name={row.name}
        labels={{ changed: t(row.changedUmk === null ? 'privacy.changedNoKey' : 'privacy.changed'), unlisted: t('privacy.unlisted'),
          verify: t('privacy.compare', { name: row.name }) }}
        onVerify={row.changedUmk === null ? undefined : () => navigate({ name: 'settings', section: 'privacy', from: null })} />)}</div> : null}
      {commandError !== null ? (
        <Banner tone="danger" action={{ label: t('shell.banner.dismiss'), onAction: () => { focusComposer(); setCommandError(null); } }}>
          {TRUST_BLOCKS.has(commandError.code)
            ? t(blockReason(gate?.code === commandError.code ? gate : guess(commandError.code as TrustBlock), changedMembers))
            : t('shell.banner.commandError', { code: commandError.code })}
        </Banner>
      ) : null}
    </>
  ) : undefined;

  // The pane belongs to a server shown by a channel route; a DM route, voice stage or Settings has none beside it.
  const asideShown = membersOpen && base.name === 'channel' && community !== null && voiceChannel === null;
  return (
    <>
      <p className="d-sr-only" role="status" aria-live="polite" data-testid="shell-announcer">{announcement}</p>
      <AppShell
        skipLabel={t('shell.skip')}
        rail={<CommunityRail label={t('shell.rail.label')} items={railItems} activeId={communityId}
          onSelect={id => navigate({ name: 'channel', communityId: id, channelId: null })}
          joinLabel={t('shell.rail.join')} joinCaption={t('create.rail.join')} onJoin={() => setJoinOpen(true)}
          createLabel={t('create.rail.newLabel')} createCaption={t('create.rail.new')} onCreate={() => setCreateOpen(true)}
          settingsLabel={t('shell.rail.settings')} onSettings={() => navigate({ name: 'settings', section: 'devices', from: null })}
          itemLabel={railLabel} />}
        sidebar={sidebar}
        ring={rings !== undefined && rings.length > 0 ? ringFlow : undefined}
        header={<>
          {/* Outlives the dock: "You left {where}.", and a block or removal said while the stage is not on screen. */}
          <p className="d-sr-only dw-voice-lasting" role="status">{call.lasting}</p>
          {header}
        </>}
        composer={composer === null ? null : <>
          {/* One polite status above the composer, never while search covers the conversation (Flow 05). */}
          {typingNames.length > 0 && !searchOpen ? <TypingIndicator names={typingNames}
            labels={{ one: en['typing.one'], many: t('typing.many') }} /> : null}
          {composer}
        </>}
        statusBar={
          <StatusBar position="bottom" label={t('shell.status.label')}>
            <StatusChunk label={t('shell.status.node')}>{account?.instance?.name ?? t('shell.status.unknown')}</StatusChunk>
            <StatusChunk label={t('shell.status.link')} tone={tone}>{t(`shell.status.${status}`)}</StatusChunk>
            <StatusChunk label={t('shell.status.gen')}>{connection?.generation ?? t('shell.status.unknown')}</StatusChunk>
            <StatusChunk label={t('shell.status.devices')}>{devicesChunk(devices)}</StatusChunk>
          </StatusBar>
        }
        banner={banner}
        aside={asideShown && community !== null && self !== null ? <MemberPane communityId={community.id} selfId={self.id}
          onMessage={startDm} onCompare={userId => navigate({ name: 'settings', section: 'privacy', from: null, compare: userId })}
          announce={announce} /> : undefined}
        asideLabel={community === null ? undefined : t('members.region', { server: community.name })}
        asideOpen={asideShown} onAsideClose={() => setMembersOpen(false)} asideReturnRef={membersToggle}
      >
        {main}
      </AppShell>
      <Search open={searchOpen} query={searchQuery} scope={searchScope} loading={searchBusy}
        requestId={search?.requestId ?? 0} currentRequestId={searchRequest}
        hits={searchHits} onQuery={query => { setSearchQuery(query); issueSearch(query, searchScope, searchId); }}
        onScope={scope => { setSearchScope(scope); client.call({ m: 'setSetting', key: 'searchScope', value: scope }).catch(report);
          issueSearch(searchQuery, scope, scope === 'all' ? null : scope === 'community' ? communityId : targetId); }}
        onPick={async hit => { const opened = await pickSearchHit(hit); if (opened) searchOpener.current = null; return opened; }}
        onClose={() => { restoreSearchFocus.current = searchOpener.current; searchOpener.current = null; setSearchOpen(false); }} />
      <JoinCommunity open={joinOpen} initialInvite={joinInvite ?? undefined} initialError={joinError ?? undefined}
        onClose={closeJoin} onJoined={onJoined} />
      <UnsupportedVoice open={call.unsupported} labels={{ title: t('voice.unsupported.title'), body: t('voice.unsupported.body'),
        close: t('voice.unsupported.close') }} onClose={call.closeUnsupported} />
      <DmPicker open={pickerOpen} members={pickerMembers} busy={pickerBusy} error={pickerError}
        body={t(noServer ? 'shell.dms.noServer' : pickerMembers.length === 0 ? 'shell.dms.alone' : 'shell.dms.newBody')}
        onClose={closePicker} onPick={startDm} />
      <CreateServerFlow open={createOpen} onClose={() => setCreateOpen(false)}
        onServer={id => { setJoined(id); navigate({ name: 'channel', communityId: id, channelId: null }); }}
        onDone={({ communityId: id, channelId: general }) => {
          pendingFocus.current = { id: general, from: targetId };
          setCreateOpen(false);
          navigate({ name: 'channel', communityId: id, channelId: general }, true);
        }} />
      <CreateChannelFlow open={channelOpen} community={community} onClose={() => setChannelOpen(false)}
        onDone={(id, kind) => {
          if (kind === 'text') pendingFocus.current = { id, from: targetId };
          setChannelOpen(false);
          if (community !== null) navigate({ name: 'channel', communityId: community.id, channelId: id });
        }} />
      <InviteFlow open={inviteOpen} community={community} onClose={() => setInviteOpen(false)}
        onMoreOptions={() => { if (community !== null) { setAdminTab('invites'); setAdminFor(community.id); } }} />
      {adminFor !== null ? <ServerSettings communityId={adminFor} tab={adminTab} onTab={setAdminTab}
        onClose={() => setAdminFor(null)} announce={announce} /> : null}
    </>
  );
}

/** The DM picker (requirement 5): the server's members, one "message" button each, the refusal inside the dialog. */
function DmPicker(p: {
  open: boolean; members: readonly { userId: string; username: string; display: string }[]; busy: boolean; error: UiError | null;
  /** Who can be picked, or why no one can (flow 07: no server yet, or no one else in it). */
  body: string;
  onClose: () => void; onPick: (userId: string) => void;
}): React.JSX.Element {
  const idBase = useId();
  return (
    <Dialog open={p.open} title={t('shell.dms.newTitle')} closeLabel={t('dialog.close')} onClose={p.onClose}>
      {p.error !== null ? <Banner tone="danger">{t('shell.banner.commandError', { code: p.error.code })}</Banner> : null}
      <p>{p.body}</p>
      {p.members.length === 0 ? null : <ul className="dw-dm-picker">
        {p.members.map(m => {
          const nameId = `${idBase}-${m.userId}`;
          return (
            <li key={m.userId} className="dw-dm-picker__row">
              <span id={nameId} className="dw-dm-picker__name">{m.display || m.username}</span>
              <Button size="sm" aria-describedby={nameId} aria-disabled={p.busy ? true : undefined}
                onClick={() => { if (!p.busy) p.onPick(m.userId); }}>{t('shell.dms.open')}</Button>
            </li>
          );
        })}
      </ul>}
    </Dialog>
  );
}

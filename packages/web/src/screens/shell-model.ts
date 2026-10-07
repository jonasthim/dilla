// The shell's pure rules: which channels are listed and in what order, which one opens by default,
// what web-1 cannot open, who wrote a row, why the composer is blocked and how a row's time reads.
import { isMuted } from '@dilla/client-core';
import type { BadgeState, ChannelGroupState, ChannelSummary, DeviceSummary, MemberSummary, TimelineItem } from '@dilla/client-core';
import { baseRoute, type Route } from '../router.ts';
import { formatDay, formatTime, t, type StringKey } from '../strings/index.ts';

const CATEGORY = 2;

function byPosition(a: ChannelSummary, b: ChannelSummary): number {
  return a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * The listed channels in sidebar order: categories (kind 2) are never listed; channels with no parent,
 * or whose parent is not a category of the list, come first by (position, id); then each category by
 * (position, id) is followed by its children by (position, id). Returns a new array.
 */
export function orderChannels(channels: readonly ChannelSummary[]): ChannelSummary[] {
  const cats = channels.filter(c => c.kind === CATEGORY).sort(byPosition);
  const catIds = new Set(cats.map(c => c.id));
  const rows = channels.filter(c => c.kind !== CATEGORY);
  const top = rows.filter(c => c.parentId === null || !catIds.has(c.parentId)).sort(byPosition);
  const children = cats.flatMap(cat => rows.filter(c => c.parentId === cat.id).sort(byPosition));
  return [...top, ...children];
}

/** True for what web-1 cannot open: a voice or other non-text channel, a readable channel, or a group the worker marked so. */
export function isUnsupported(ch: Pick<ChannelSummary, 'kind' | 'mode' | 'group'>): boolean {
  return ch.group === 'unsupported' || ch.kind !== 0 || ch.mode !== 0;
}

/** The first listed text channel the server cannot read, else the first listed channel, else null. */
export function defaultChannel(ordered: readonly ChannelSummary[]): ChannelSummary | null {
  return ordered.find(c => c.kind === 0 && c.mode === 0) ?? ordered[0] ?? null;
}

/** The listed channel `delta` places from `currentId`, clamped at both ends; the first one when none is current. */
export function stepChannel(ordered: readonly ChannelSummary[], currentId: string | null, delta: -1 | 1): ChannelSummary | null {
  if (ordered.length === 0) return null;
  const i = currentId === null ? -1 : ordered.findIndex(c => c.id === currentId);
  if (i < 0) return ordered[0];
  return ordered[Math.min(Math.max(i + delta, 0), ordered.length - 1)];
}

/**
 * The name a row shows: the member's display name, else the member's username, else the account's own
 * username for its own user, else the first 8 hex characters of the user id; a row without a user
 * names its device.
 */
export function authorName(item: Pick<TimelineItem, 'senderUser' | 'senderDevice'>, members: readonly MemberSummary[] | undefined,
  self: { id: string; username: string } | null): string {
  const user = item.senderUser;
  if (user === null) return t('shell.message.unknownAuthor', { id: (item.senderDevice ?? '').slice(0, 8) });
  const member = members?.find(m => m.userId === user);
  if (member !== undefined) {
    if (member.display !== '') return member.display;
    if (member.username !== '') return member.username;
  }
  if (self !== null && self.id === user) return self.username;
  return user.slice(0, 8);
}

/** Why the composer is blocked in a group state, or null when it is open. */
export function composerBlock(group: ChannelGroupState): StringKey | null {
  switch (group) {
    case 'active': return null;
    case 'none': case 'joining': return 'shell.composer.joining';
    case 'resync': return 'shell.composer.resync';
    case 'not-member': return 'shell.composer.notMember';
    case 'unsupported': return 'shell.composer.unsupported';
  }
}

/** Why a channel web-1 cannot open does not open. */
export function unsupportedBody(ch: Pick<ChannelSummary, 'kind' | 'mode'>): StringKey {
  if (ch.kind === 1) return 'shell.unsupported.voice';
  if (ch.mode === 1) return 'shell.unsupported.readable';
  return 'shell.unsupported.other';
}

/** A row's local time (`ts` in unix seconds), with the day in front when it is not today's date at `nowMs`. */
export function messageTime(ts: number, nowMs: number): string {
  const at = new Date(ts * 1000);
  const now = new Date(nowMs);
  const today = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  return today ? formatTime(ts) : `${formatDay(ts)} ${formatTime(ts)}`;
}

/** What a channel or DM row shows: a muted row hides its unread count and keeps its mentions (ruling 15). */
export interface RowBadge { unread: number; mentions: number; muted: boolean; }

/** The row's shown counts from the badges slice (zero when absent) and its mute setting. */
export function rowBadge(badges: Readonly<Record<string, BadgeState>> | undefined, settings: Readonly<Record<string, string>> | undefined,
  channelId: string): RowBadge {
  const b = badges?.[channelId];
  const muted = settings !== undefined && isMuted(settings, channelId);
  return { unread: muted ? 0 : b?.unread ?? 0, mentions: b?.mentions ?? 0, muted };
}

/** The field-wise sum of what rows show (a rail item's or a tab's counts). */
export function sumBadges(rows: readonly RowBadge[]): { unread: number; mentions: number } {
  let unread = 0;
  let mentions = 0;
  for (const r of rows) {
    unread += r.unread;
    mentions += r.mentions;
  }
  return { unread, mentions };
}

/** A row's accessible name (ruling 34): a muted row says so, a quiet row is its bare name, else its counts in words. */
export function badgeLabel(row: { name: string; unread: number; mentions: number; muted: boolean }): string {
  if (row.muted) return t('shell.channels.rowLabelMuted', { name: row.name, mentions: row.mentions });
  if (row.unread === 0 && row.mentions === 0) return row.name;
  return t('shell.channels.rowLabel', { name: row.name, unread: row.unread, mentions: row.mentions });
}

/** A rail item's accessible name: the bare name when it has nothing to report, else its counts in words. */
export function railLabel(item: { name: string; unread: number; mentions: number }): string {
  if (item.unread === 0 && item.mentions === 0) return item.name;
  return t('shell.rail.itemLabel', { name: item.name, unread: item.unread, mentions: item.mentions });
}

/** The status bar's devices chunk: the account's devices not removed, unknown until the list is loaded (Q12). */
export function devicesChunk(devices: readonly DeviceSummary[] | undefined): string {
  if (devices === undefined) return t('shell.status.unknown');
  return String(devices.filter(d => d.revokedAt === null).length);
}

/** The people a DM can be started with: the server's human members other than oneself, by the name they show. */
export function dmCandidates(members: readonly MemberSummary[] | undefined, selfId: string | null): MemberSummary[] {
  const shown = (m: MemberSummary) => m.display || m.username;
  return (members ?? [])
    .filter(m => m.kind === 0 && m.userId !== selfId)
    .sort((a, b) => shown(a).localeCompare(shown(b), undefined, { sensitivity: 'base' }) || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
}

/** The channel or DM on screen for a route (the base route's), or null. */
export function visibleChannel(route: Route): string | null {
  const b = baseRoute(route);
  if (b.name === 'channel' || b.name === 'dm') return b.channelId;
  return null;
}

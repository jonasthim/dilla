// The shell's pure rules: which channels are listed and in what order, which one opens by default,
// what web-1 cannot open, who wrote a row, why the composer is blocked and how a row's time reads.
import { isMuted, roleHandle, splitMentions } from '@dilla/client-core';
import type { BadgeState, ChannelGroupState, ChannelSummary, DeviceSummary, MemberSummary, MentionMember, MentionRole, RoleSummary, TimelineItem, VoiceParticipant } from '@dilla/client-core';
import type { BodyPart, VoiceParticipantView, VoiceStateLabels } from '@dilla/ui';
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

/** A voice channel (kind 1) the voice view shows (web-3); a readable one stays unsupported. */
export function isVoice(ch: Pick<ChannelSummary, 'kind' | 'mode'>): boolean {
  return ch.kind === 1 && ch.mode === 0;
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
  channelId: string, communityId?: string): RowBadge {
  const b = badges?.[channelId];
  const muted = settings !== undefined && isMuted(settings, channelId, communityId);
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

export interface NameBook {
  self: { id: string; username: string } | null;
  members: readonly MemberSummary[];
  roles: ReadonlySet<string>;
  ownRoles: ReadonlySet<string>;
  /** The roles whose name and colour are known (the `roles:` slice); absent where only member rows were read. */
  roleInfo?: ReadonlyMap<string, { name: string; color: number }>;
}

export function nameBook(self: NameBook['self'], members: readonly MemberSummary[], roles: readonly RoleSummary[] = []): NameBook {
  return withRoles({
    self, members,
    roles: new Set(members.flatMap(m => m.roleIds)),
    ownRoles: new Set(members.find(m => m.userId === self?.id)?.roleIds ?? []),
  }, roles);
}

/** The book with the names and colours of `roles`; the same book while there are none. */
export function withRoles(book: NameBook, roles: readonly RoleSummary[]): NameBook {
  return roles.length === 0 ? book : { ...book, roleInfo: new Map(roles.map(r => [r.id, { name: r.name, color: r.color }])) };
}

/** The roles a person may mention here: the mentionable ones, or every role but @everyone (position 0) with the broadcast right. */
export function offeredRoles(roles: readonly RoleSummary[], broadcast: boolean): RoleSummary[] {
  return roles.filter(r => r.position > 0 && (broadcast || r.mentionable));
}

/** For an edit: the offered roles plus every role the message already mentions, so no token is lost by saving. */
export function editRoles(roles: readonly RoleSummary[], broadcast: boolean, body: string): RoleSummary[] {
  return roles.filter(r => r.position > 0 && (broadcast || r.mentionable || body.includes(`<@${r.id}>`)));
}

/** Roles in the order they are offered (position, highest first, then name), without any whose handle is already taken by
 *  @everyone, @here, a member (broadcast beats member beats role) or a role before it. */
function reachable(roles: readonly RoleSummary[], members: readonly { username: string }[]): { role: RoleSummary; handle: string }[] {
  const taken = new Set(['everyone', 'here', ...members.map(m => m.username.normalize('NFC').toLowerCase())]);
  const out: { role: RoleSummary; handle: string }[] = [];
  for (const role of [...roles].sort((a, b) => b.position - a.position || a.name.localeCompare(b.name))) {
    const handle = roleHandle(role.name);
    if (handle === '' || taken.has(handle)) continue;
    taken.add(handle);
    out.push({ role, handle });
  }
  return out;
}

export function mentionRoles(roles: readonly RoleSummary[], members: readonly { username: string }[] = []): MentionRole[] {
  return reachable(roles, members).map(({ role, handle }) => ({ roleId: role.id, handle }));
}

export function mergeMembers(lists: readonly (readonly MemberSummary[] | undefined)[]): MemberSummary[] {
  const seen = new Set<string>();
  const result: MemberSummary[] = [];
  for (const list of lists) for (const member of list ?? []) {
    if (seen.has(member.userId)) continue;
    seen.add(member.userId);
    result.push(member);
  }
  return result;
}

/**
 * A body as text and mention pills. `mentionsMe` is the row's mention flag from the core, which alone decides whether an
 * @everyone, @here or a token of one of my roles counted (the sender's right, the role's "anyone can mention"). Such a pill
 * is tinted as naming me only when it is set; otherwise it is a plain broadcast or role pill (W2a review 10). The core
 * flags the row, not each token, so a row that counts for any reason tints all of them.
 */
export function bodyParts(body: string, book: NameBook, mentionsMe: boolean): BodyPart[] {
  return splitMentions(body).map(part => {
    if (part.kind === 'text') return part;
    const id = part.target;
    if (id === 'everyone' || id === 'here') return { kind: 'mention', label: `@${id}`, me: mentionsMe, broadcast: true };
    const member = book.members.find(m => m.userId === id);
    if (member !== undefined) return { kind: 'mention', label: `@${member.display || member.username}`, me: id === book.self?.id, broadcast: false };
    if (id === book.self?.id) return { kind: 'mention', label: `@${book.self.username}`, me: true, broadcast: false };
    const known = book.roleInfo?.get(id);
    if (known !== undefined) return { kind: 'mention', label: t('mention.role', { name: known.name }), me: mentionsMe && book.ownRoles.has(id), broadcast: false, color: known.color };
    if (book.roles.has(id)) return { kind: 'mention', label: t('shell.message.mentionRole'), me: mentionsMe && book.ownRoles.has(id), broadcast: false };
    return { kind: 'mention', label: t('shell.message.mentionUnknown', { id: id.slice(0, 8) }), me: false, broadcast: false };
  });
}

export function plainBody(body: string, book: NameBook): string {
  return bodyParts(body, book, false).map(part => part.kind === 'text' ? part.text : part.label).join('');
}

export function editableText(body: string, book: NameBook): string {
  return splitMentions(body).map(part => {
    if (part.kind === 'text') return part.text;
    if (part.target === 'everyone' || part.target === 'here') return `@${part.target}`;
    const member = book.members.find(m => m.userId === part.target && m.username !== '');
    if (member !== undefined) return `@${member.username}`;
    if (book.self?.id === part.target) return `@${book.self.username}`;
    const role = book.roleInfo?.get(part.target);
    if (role !== undefined) return `@${roleHandle(role.name)}`;
    return `<@${part.target}>`;
  }).join('');
}

export function excerpt(value: string, max = 120): string {
  return Array.from(value.replace(/[\r\n]/g, ' ')).slice(0, max).join('');
}

export function mentionCandidates(members: readonly MemberSummary[], selfId: string | null): MemberSummary[] {
  return members.filter(m => m.userId !== selfId);
}

export function mentionMembers(members: readonly MemberSummary[]): MentionMember[] {
  return members.filter(m => m.username !== '').map(({ userId, username }) => ({ userId, username }));
}

export interface MentionOption { id: string; primary: string; secondary: string; insert: string }
export function mentionOptions(query: string, candidates: readonly MemberSummary[], broadcast: boolean, roles: readonly RoleSummary[] = []): MentionOption[] {
  const q = query.normalize('NFC').toLowerCase();
  const by = (key: 'username' | 'display') => (a: MemberSummary, b: MemberSummary) =>
    a[key].localeCompare(b[key], undefined, { sensitivity: 'base' });
  const username = candidates.filter(m => m.username.toLowerCase().startsWith(q)).sort(by('username'));
  const display = candidates.filter(m => !m.username.toLowerCase().startsWith(q) && m.display.toLowerCase().startsWith(q)).sort(by('display'));
  const result = [...username, ...display].slice(0, 8).map(m => ({
    id: `m-${m.userId}`, primary: m.display || m.username, secondary: `@${m.username}`, insert: `@${m.username} `,
  }));
  // Roles follow the members and fill what is left of the eight; @everyone comes last.
  for (const { role: r, handle } of reachable(roles, candidates).filter(x => x.handle.startsWith(q)).slice(0, 8 - result.length)) {
    result.push({ id: `r-${r.id}`, primary: t('mention.role', { name: r.name }), secondary: t('mention.role.secondary'), insert: `@${handle} ` });
  }
  if (broadcast && 'everyone'.startsWith(q)) result.push({ id: 'b-everyone', primary: '@everyone', secondary: t('shell.composer.mentionEveryone'), insert: '@everyone ' });
  return result;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return t('shell.attachment.bytes', { n: bytes });
  const mb = bytes >= 1_048_576;
  const value = bytes / (mb ? 1_048_576 : 1024);
  return t(mb ? 'shell.attachment.mb' : 'shell.attachment.kb', { n: value < 10 ? value.toFixed(1) : Math.round(value) });
}

// web-3 (flow 06): voice_state flags (protocol/02 § Gateway frames): bit 0 in_call, 1 self_mute, 2 self_deaf, 3 video, 4 screen.
const FLAG_MUTE = 1 << 1;
const FLAG_DEAF = 1 << 2;
const FLAG_VIDEO = 1 << 3;
const FLAG_SCREEN = 1 << 4;

/** A voice participant as the rows and tiles show it; `state` is the tile's stream state ('ok' outside the call). */
export function participantView(p: VoiceParticipant, state: VoiceParticipantView['state'] = 'ok', speaking = false): VoiceParticipantView {
  return {
    deviceId: p.deviceId, userId: p.userId, name: p.name, state, speaking,
    muted: (p.flags & FLAG_MUTE) !== 0, deafened: (p.flags & FLAG_DEAF) !== 0,
    // Product walk M13: the client tag is shown on no participant (the worker knows only its own device is web), so the
    // tags never differ between people who use the same client; the bot tag stays.
    video: (p.flags & FLAG_VIDEO) !== 0, screen: (p.flags & FLAG_SCREEN) !== 0, web: false, bot: p.bot,
  };
}

/** The participant state words (L-UI-60) from the flow-06 copy. */
export function voiceStateLabels(): VoiceStateLabels {
  return {
    speaking: t('voice.state.speaking'), muted: t('voice.state.muted'), deafened: t('voice.state.deafened'),
    notHeard: t('voice.state.notHeard'), unverified: t('voice.state.unverified'), connecting: t('voice.state.connecting'),
    video: t('voice.state.video'), screen: t('voice.state.screen'), web: t('voice.tag.web'), bot: t('voice.tag.bot'),
  };
}

/**
 * The name of a user for the voice copy ({name} of voice.paused and voice.blockedChanged): the member's display name, else
 * the username, else the trust row's name, else the first 8 hex characters of the id.
 */
export function userName(userId: string, members: readonly MemberSummary[], trust: readonly { userId: string; name: string }[] | undefined): string {
  const member = members.find(m => m.userId === userId);
  if (member !== undefined && (member.display !== '' || member.username !== '')) return member.display || member.username;
  const row = trust?.find(r => r.userId === userId);
  if (row !== undefined && row.name !== '') return row.name;
  return userId.slice(0, 8);
}

/** The flow-06 notice for a refused or failed start, by code only; null when the call slice already says why (or nothing is said). */
export function joinFailureKey(code: string): StringKey | null {
  switch (code) {
    case 'E_CALL_FULL': return 'voice.full';
    case 'E_CALL_SHARERS_FULL': return 'voice.sharersFull';
    case 'E_CALL_IN_OTHER_TAB': return 'voice.otherTab';
    // The page is gone (pagehide during the start): nobody reads it.
    case 'E_ABORTED': return null;
    // A trust refusal sets the call phase blocked, whose notice says why (flow 06).
    case 'E_UMK_CHANGED': case 'E_CREDENTIAL': case 'E_DEVICE_UNLISTED': case 'E_TIER_MISMATCH': case 'E_BINDING': return null;
    default: return 'voice.failed';
  }
}

/** The notice for the page call's microphone outcome (listen-only), or null when the microphone is on. */
export function micNoticeKey(mic: 'ok' | 'denied' | 'missing' | 'failed'): StringKey | null {
  return mic === 'denied' ? 'voice.micDenied' : mic === 'missing' ? 'voice.micMissing' : mic === 'failed' ? 'voice.micFailed' : null;
}

// Pure derivations of what the page renders from what the core holds (L-TS-08, L-TS-36).
import { BROWSER_ATTACHMENT_CAP } from '../attachments/crypto';
import { safeName } from '../attachments/name';
import { RENDERABLE_IMAGE } from '../attachments/thumb';
import type { GroupInfo, Id, OutboxRow, ReplyInfo, TimelineRow } from '../core-port';
import { toHex } from '../hex';
import type { AttachmentSummary, ChannelGroupState, PendingAction, ReplyRef, TimelineItem, TimelineState } from './types';

export interface TimelineInput { channelId: string; group: ChannelGroupState; rows: readonly TimelineRow[]; outbox: readonly OutboxRow[];
  ownUser: Id; ownDevice: Id; limit: number; }

const STORED_STATE = ['ok', 'cannot-read', 'deleted'] as const;
const REPLY_STATE = ['ok', 'missing', 'deleted'] as const;
const EXCERPT_MAX = 120;                       // Unicode scalar values (L-CORE-34)

/** What the page may know of an attachment (Q16, ruling 15): never its key, nonce or blob id. */
function summary(a: { index: number; size: number; mime: string; name: string; w: number | null; h: number | null; thumb: boolean }): AttachmentSummary {
  return {
    index: a.index, size: a.size, mime: a.mime, name: safeName(a.name, ''), w: a.w, h: a.h, thumb: a.thumb,
    kind: RENDERABLE_IMAGE.includes(a.mime) ? 'image' : 'file', tooLarge: a.size > BROWSER_ATTACHMENT_CAP,
  };
}

/** L-CORE-34's excerpt rule: the first 120 scalar values, every line break a space. */
function excerptOf(body: string): string {
  return Array.from(body.replace(/[\r\n]/g, ' ')).slice(0, EXCERPT_MAX).join('');
}

/** A stored row's reply, as the core resolved it. */
function replyOf(info: ReplyInfo): ReplyRef {
  return {
    msgId: toHex(info.replyTo), state: REPLY_STATE[info.state],
    senderUser: info.targetUser === null ? null : toHex(info.targetUser), excerpt: info.excerpt,
    seq: info.targetSeq === null ? null : info.targetSeq.toString(),
  };
}

/** An outbox row's reply, resolved against the stored rows the page holds (the core resolves it only once stored). */
function outboxReply(replyTo: Id, rows: readonly TimelineRow[]): ReplyRef {
  const msgId = toHex(replyTo);
  const target = rows.find((r) => r.msgId !== null && toHex(r.msgId) === msgId && (r.type === 0 || r.type === null));
  if (target === undefined || target.status === 1) return { msgId, state: 'missing', senderUser: null, excerpt: '', seq: null };
  const senderUser = target.senderUser === null ? null : toHex(target.senderUser);
  const seq = target.seq.toString();
  if (target.status === 2) return { msgId, state: 'deleted', senderUser, excerpt: '', seq };
  return { msgId, state: 'ok', senderUser, excerpt: excerptOf(target.body), seq };
}

export function buildTimeline(input: TimelineInput): TimelineState {
  const ownDevice = toHex(input.ownDevice);
  const ownUser = toHex(input.ownUser);
  const items: TimelineItem[] = [];
  const stored = new Set<string>();
  for (const row of input.rows) {
    const msgId = row.msgId === null ? null : toHex(row.msgId);
    if (msgId !== null) stored.add(msgId);
    // The core returns displayable rows only (ruling 9); a stored fold row is still never an item (defensive).
    if (row.type !== 0 && row.type !== null) continue;
    const senderDevice = toHex(row.senderDevice);
    const own = senderDevice === ownDevice;
    items.push({
      key: own && msgId !== null ? `o${msgId}` : `s${row.seq}`,
      state: STORED_STATE[row.status],
      reason: row.status === 1 ? row.reason : '',
      senderUser: row.senderUser === null ? null : toHex(row.senderUser),
      senderDevice,
      own,
      web: row.senderTier === 1,
      bot: row.senderKind === 1,
      ts: Number(row.recvTs),
      body: row.status === 0 ? row.body : '',
      msgId,
      seq: row.seq.toString(),
      edited: row.editedSeq > 0n,
      reply: row.reply === null ? null : replyOf(row.reply),
      reactions: row.reactions.map((r) => ({ emoji: r.emoji, count: r.count, mine: r.mine })),
      pinned: row.pinned,
      attachments: row.attachments.map((a) => summary({ index: a.index, size: a.size, mime: a.mime, name: a.name, w: a.w, h: a.h, thumb: a.hasThumb })),
      mention: row.mention,
      actions: [],
    });
  }
  const folds: OutboxRow[] = [];
  for (const row of input.outbox) {
    // An edit, delete, reaction or pin is never an item of its own: it shows on its target (Global Constraints "Never written").
    if (row.type !== 0) { folds.push(row); continue; }
    const msgId = toHex(row.msgId);
    if (stored.has(msgId)) continue;
    const failed = row.state === 2;
    items.push({
      key: `o${msgId}`,
      state: failed ? 'failed' : 'pending',
      reason: failed ? row.error : '',
      senderUser: ownUser,
      senderDevice: ownDevice,
      own: true,
      web: true,
      bot: false,
      ts: Number(row.created),
      body: row.body,
      msgId,
      seq: null,
      edited: false,
      reply: row.replyTo === null ? null : outboxReply(row.replyTo, input.rows),
      reactions: [],
      pinned: false,
      attachments: row.attachments.map((a, index) => summary({ index, size: a.size, mime: a.mime, name: a.name, w: null, h: null, thumb: false })),
      mention: false,
      actions: [],
    });
  }
  const byMsgId = new Map<string, TimelineItem>();
  for (const item of items) if (item.msgId !== null && !byMsgId.has(item.msgId)) byMsgId.set(item.msgId, item);
  for (const row of folds) {
    if (row.replyTo === null) continue;
    const target = byMsgId.get(toHex(row.replyTo));
    if (target === undefined) continue;
    const action: PendingAction = {
      msgId: toHex(row.msgId), type: row.type as PendingAction['type'],
      state: row.state === 2 ? 'failed' : 'pending', reason: row.state === 2 ? row.error : '',
    };
    target.actions.push(action);
  }
  return { channelId: input.channelId, group: input.group, items, hasEarlier: input.rows.length >= input.limit };
}

/** What the controller knows beyond the group rows: a 403 on opening this channel, and what onMembership last
 *  reported per group (sets of group id hex). */
export interface GroupMembership { refusedChannel: boolean; notMember: ReadonlySet<string>; resyncing: ReadonlySet<string>; }

/** The local text group of a channel: the first live one (state other than 4), else the first gone one. */
export function channelGroup(channelId: Id, groups: readonly GroupInfo[]): GroupInfo | undefined {
  const target = toHex(channelId);
  const mine = groups.filter((g) => g.kind === 0 && toHex(g.targetId) === target);
  return mine.find((g) => g.state !== 4) ?? mine.find((g) => g.state === 4);
}

export function channelGroupState(channel: { id: Id; kind: number; mode: number }, groups: readonly GroupInfo[], membership: GroupMembership): ChannelGroupState {
  if (channel.kind !== 0 || channel.mode !== 0) return 'unsupported';
  const group = channelGroup(channel.id, groups);
  if (group === undefined) return membership.refusedChannel ? 'not-member' : 'none';
  const g = toHex(group.groupId);
  switch (group.state) {
    case 0:
    case 1:
      return 'joining';
    case 2:
      // A resync refused before the join leaves the row in state 2 (a kicked device): notMember holds it
      // until the next state-2 report from the engine (a successful rejoin) clears it.
      return membership.resyncing.has(g) ? 'resync' : membership.notMember.has(g) ? 'not-member' : 'active';
    case 3:
      return membership.notMember.has(g) || membership.refusedChannel ? 'not-member' : 'resync';
    case 4:
      return 'not-member';
  }
}

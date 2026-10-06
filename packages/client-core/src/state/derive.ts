// Pure derivations of what the page renders from what the core holds (L-TS-08).
import type { GroupInfo, Id, OutboxRow, TimelineRow } from '../core-port';
import { toHex } from '../hex';
import type { ChannelGroupState, TimelineItem, TimelineState } from './types';

export interface TimelineInput { channelId: string; group: ChannelGroupState; rows: readonly TimelineRow[]; outbox: readonly OutboxRow[];
  ownUser: Id; ownDevice: Id; limit: number; }

const STORED_STATE = ['ok', 'cannot-read', 'deleted'] as const;

export function buildTimeline(input: TimelineInput): TimelineState {
  const ownDevice = toHex(input.ownDevice);
  const ownUser = toHex(input.ownUser);
  const items: TimelineItem[] = [];
  const stored = new Set<string>();
  for (const row of input.rows) {
    const msgId = row.msgId === null ? null : toHex(row.msgId);
    if (msgId !== null) stored.add(msgId);
    // Envelope types 1-6 stay in the database and are not shown in web-1 (ruling 17).
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
    });
  }
  for (const row of input.outbox) {
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
    });
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

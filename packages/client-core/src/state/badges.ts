// Badges and notices (L-TS-24): unread and mention counts keyed by channel, and the ring of notices the page
// turns into desktop notifications. Pure functions; the controller owns the state.
import type { ActivityRow, TimelineRow } from '../core-port';
import { toHex } from '../hex';
import type { BadgeState, Notice, NoticesState } from './types';

export const NOTICES_MAX = 32;
export const NOTICE_BODY_MAX = 200;      // code points
export const NOTICE_READ_MAX = 8;        // rows read per change
export type NoticeDraft = Omit<Notice, 'id'>;

/** The L-CORE-24 literal rule: the readable mention syntax for this user, @everyone or @here. */
export function mentionsMe(body: string, userHex: string): boolean {
  return body.includes(`<@${userHex}>`) || body.includes('<@everyone>') || body.includes('<@here>');
}

/** Sums the activity rows of every group bound to a known channel; a group bound to none contributes nothing. */
export function buildBadges(activity: readonly ActivityRow[], channelOf: ReadonlyMap<string, string>): Record<string, BadgeState> {
  const badges: Record<string, BadgeState> = {};
  for (const row of activity) {
    const channel = channelOf.get(toHex(row.groupId));
    if (channel === undefined) continue;
    const held = badges[channel] ?? { unread: 0, mentions: 0 };
    badges[channel] = { unread: held.unread + row.unread, mentions: held.mentions + row.mentions };
  }
  return badges;
}

export function noticeOf(input: { row: TimelineRow; channelId: string; communityId: string | null; dm: boolean; mention: boolean; senderName: string }): NoticeDraft {
  const { row } = input;
  return {
    channelId: input.channelId,
    communityId: input.communityId,
    kind: input.dm ? 'dm' : input.mention ? 'mention' : 'message',
    senderUser: row.senderUser === null ? null : toHex(row.senderUser),
    senderName: input.senderName,
    body: Array.from(row.body).slice(0, NOTICE_BODY_MAX).join(''),
    ts: Number(row.recvTs),
  };
}

/** Numbers the drafts from state.nextId and keeps the newest NOTICES_MAX items, oldest first. */
export function appendNotices(state: NoticesState, drafts: readonly NoticeDraft[]): NoticesState {
  if (drafts.length === 0) return state;
  const added = drafts.map((draft, i) => ({ id: state.nextId + i, ...draft }));
  const items = [...state.items, ...added];
  return { nextId: state.nextId + drafts.length, items: items.slice(Math.max(0, items.length - NOTICES_MAX)) };
}

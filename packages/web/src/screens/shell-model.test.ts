import { describe, it, expect } from 'vitest';
import type { ChannelSummary, DeviceSummary, MemberSummary } from '@dilla/client-core';
import { formatDay, formatTime } from '../strings/index.ts';
import {
  authorName, badgeLabel, composerBlock, defaultChannel, devicesChunk, dmCandidates, isUnsupported, messageTime, orderChannels, railLabel,
  rowBadge, stepChannel, sumBadges, unsupportedBody, visibleChannel,
} from './shell-model.ts';

const A = 'a1'.repeat(16);
function ch(id: string, name: string, over: Partial<ChannelSummary> = {}): ChannelSummary {
  return { id, communityId: A, kind: 0, mode: 0, name, topic: '', parentId: null, position: 0, group: 'none', ...over };
}
const id = (c: string) => c.repeat(32);
const LIST = [
  ch(id('2'), 'random', { parentId: id('9'), position: 0 }),
  ch(id('9'), 'more', { kind: 2, position: 2 }),
  ch(id('3'), 'lobby', { parentId: id('9'), position: 1, mode: 1, group: 'unsupported' }),
  ch(id('5'), 'general', { position: 1 }),
  ch(id('4'), 'lounge', { kind: 1, position: 0, group: 'unsupported' }),
  ch(id('6'), 'news', { position: 1 }),
  ch(id('7'), 'orphan', { parentId: id('8'), position: 5 }),
];

describe('orderChannels', () => {
  it('lists top level first, then each category with its children, and never a category', () => {
    expect(orderChannels(LIST).map(c => c.name)).toEqual(['lounge', 'general', 'news', 'orphan', 'random', 'lobby']);
  });
});

describe('defaultChannel and stepChannel', () => {
  const ordered = orderChannels(LIST);
  it('prefers the first readable text channel', () => {
    expect(defaultChannel(ordered)?.name).toBe('general');
    expect(defaultChannel(orderChannels([LIST[4]]))?.name).toBe('lounge');
    expect(defaultChannel([])).toBeNull();
  });
  it('steps and clamps', () => {
    expect(stepChannel(ordered, id('5'), 1)?.name).toBe('news');
    expect(stepChannel(ordered, id('5'), -1)?.name).toBe('lounge');
    expect(stepChannel(ordered, id('4'), -1)?.name).toBe('lounge');
    expect(stepChannel(ordered, id('3'), 1)?.name).toBe('lobby');
    expect(stepChannel(ordered, null, 1)?.name).toBe('lounge');
    expect(stepChannel([], null, 1)).toBeNull();
  });
});

describe('isUnsupported and unsupportedBody', () => {
  it('knows what web-1 cannot open', () => {
    expect(isUnsupported({ kind: 0, mode: 0, group: 'none' })).toBe(false);
    expect(isUnsupported({ kind: 1, mode: 0, group: 'none' })).toBe(true);
    expect(isUnsupported({ kind: 0, mode: 1, group: 'none' })).toBe(true);
    expect(isUnsupported({ kind: 0, mode: 0, group: 'unsupported' })).toBe(true);
    expect(unsupportedBody({ kind: 1, mode: 0 })).toBe('shell.unsupported.voice');
    expect(unsupportedBody({ kind: 0, mode: 1 })).toBe('shell.unsupported.readable');
    expect(unsupportedBody({ kind: 2, mode: 0 })).toBe('shell.unsupported.other');
  });
});

describe('authorName', () => {
  const members: MemberSummary[] = [
    { userId: id('a'), username: 'ada', display: 'Ada L', kind: 0 },
    { userId: id('b'), username: 'bob', display: '', kind: 0 },
  ];
  it('prefers the display name, then the username, then the id', () => {
    expect(authorName({ senderUser: id('a'), senderDevice: id('1') }, members, null)).toBe('Ada L');
    expect(authorName({ senderUser: id('b'), senderDevice: id('1') }, members, null)).toBe('bob');
    expect(authorName({ senderUser: id('c'), senderDevice: id('1') }, members, null)).toBe('cccccccc');
    expect(authorName({ senderUser: id('c'), senderDevice: id('1') }, undefined, { id: id('c'), username: 'me' })).toBe('me');
    expect(authorName({ senderUser: null, senderDevice: id('d') }, members, null)).toBe('device dddddddd');
  });
});

describe('composerBlock', () => {
  it('names the reason for every state but active', () => {
    expect(composerBlock('active')).toBeNull();
    expect(composerBlock('none')).toBe('shell.composer.joining');
    expect(composerBlock('joining')).toBe('shell.composer.joining');
    expect(composerBlock('resync')).toBe('shell.composer.resync');
    expect(composerBlock('not-member')).toBe('shell.composer.notMember');
    expect(composerBlock('unsupported')).toBe('shell.composer.unsupported');
  });
});

describe('messageTime', () => {
  it('shows the day only when it is not today', () => {
    const noon = new Date(2026, 9, 5, 12, 0, 0).getTime() / 1000;
    expect(messageTime(noon, noon * 1000 + 60_000)).toBe(formatTime(noon));
    expect(messageTime(noon, noon * 1000 + 2 * 86_400_000)).toBe(`${formatDay(noon)} ${formatTime(noon)}`);
  });
});

describe('badges', () => {
  const BADGES = { [id('5')]: { unread: 3, mentions: 0 }, [id('6')]: { unread: 2, mentions: 1 } };
  it('shows a channel’s counts, hides a muted channel’s unread and keeps its mentions', () => {
    expect(rowBadge(BADGES, {}, id('5'))).toEqual({ unread: 3, mentions: 0, muted: false });
    expect(rowBadge(BADGES, { [`mute.channel.${id('6')}`]: '1' }, id('6'))).toEqual({ unread: 0, mentions: 1, muted: true });
    expect(rowBadge(BADGES, {}, id('7'))).toEqual({ unread: 0, mentions: 0, muted: false });
    expect(rowBadge(undefined, undefined, id('5'))).toEqual({ unread: 0, mentions: 0, muted: false });
  });
  it('sums what is shown', () => {
    expect(sumBadges([{ unread: 3, mentions: 0, muted: false }, { unread: 0, mentions: 1, muted: true }, { unread: 2, mentions: 2, muted: false }]))
      .toEqual({ unread: 5, mentions: 3 });
    expect(sumBadges([])).toEqual({ unread: 0, mentions: 0 });
  });
  it('names a row by its counts only when it has some, and a muted row always', () => {
    expect(badgeLabel({ name: 'general', unread: 0, mentions: 0, muted: false })).toBe('general');
    expect(badgeLabel({ name: 'general', unread: 3, mentions: 1, muted: false })).toBe('general, unread 3, mentions 1');
    expect(badgeLabel({ name: 'general', unread: 0, mentions: 2, muted: false })).toBe('general, unread 0, mentions 2');
    expect(badgeLabel({ name: 'general', unread: 0, mentions: 0, muted: true })).toBe('general, muted, mentions 0');
    expect(railLabel({ name: 'Midgard', unread: 0, mentions: 0 })).toBe('Midgard');
    expect(railLabel({ name: 'Midgard', unread: 4, mentions: 2 })).toBe('Midgard, unread 4, mentions 2');
  });
});

describe('devicesChunk', () => {
  const dev = (revokedAt: number | null): DeviceSummary =>
    ({ id: id('c'), tier: 1, signerTier: 1, lastSeen: 1, revokedAt, listed: true, own: false });
  it('counts the devices not removed, and is unknown until loaded', () => {
    expect(devicesChunk(undefined)).toBe('–');
    expect(devicesChunk([])).toBe('0');
    expect(devicesChunk([dev(null), dev(1_790_000_000), dev(null)])).toBe('2');
  });
});

describe('dmCandidates', () => {
  const m = (userId: string, username: string, display: string, kind: 0 | 1 = 0): MemberSummary => ({ userId, username, display, kind });
  it('offers people other than oneself, by the name they show', () => {
    const members = [m(id('a'), 'ada', 'Ada L'), m(id('b'), 'zed', ''), m(id('c'), 'helper', 'Helper', 1), m(id('d'), 'bob', 'Bob')];
    expect(dmCandidates(members, id('a')).map(x => x.username)).toEqual(['bob', 'zed']);
    expect(dmCandidates(undefined, id('a'))).toEqual([]);
  });
});

describe('visibleChannel', () => {
  it('names what the route shows, through settings too', () => {
    expect(visibleChannel({ name: 'channel', communityId: A, channelId: id('5') })).toBe(id('5'));
    expect(visibleChannel({ name: 'channel', communityId: A, channelId: null })).toBeNull();
    expect(visibleChannel({ name: 'dm', channelId: id('9') })).toBe(id('9'));
    expect(visibleChannel({ name: 'settings', section: 'devices', from: `/c/${A}/${id('5')}` })).toBe(id('5'));
    expect(visibleChannel({ name: 'settings', section: 'devices', from: null })).toBeNull();
    expect(visibleChannel({ name: 'root' })).toBeNull();
  });
});

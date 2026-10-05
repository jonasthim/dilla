import { describe, it, expect } from 'vitest';
import type { ChannelSummary, MemberSummary } from '@dilla/client-core';
import { formatDay, formatTime } from '../strings/index.ts';
import { authorName, composerBlock, defaultChannel, isUnsupported, messageTime, orderChannels, stepChannel, unsupportedBody } from './shell-model.ts';

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

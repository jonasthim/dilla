import { describe, it, expect } from 'vitest';
import type { ChannelSummary, DeviceSummary, MemberSummary, RoleSummary } from '@dilla/client-core';
import { formatDay, formatTime } from '../strings/index.ts';
import {
  authorName, knownName, badgeLabel, bodyParts, withSenders, composerBlock, defaultChannel, devicesChunk, dmCandidates, editableText, excerpt, formatSize, isUnsupported,
  mentionCandidates, mentionMembers, mentionOptions, mentionRoles, offeredRoles, mergeMembers, messageTime, nameBook, orderChannels, plainBody, railLabel, rowBadge,
  stepChannel, sumBadges, unsupportedBody, visibleChannel, participantView, selfName, userName, joinFailureKey, micNoticeKey, isVoice,
} from './shell-model.ts';

const A = 'a1'.repeat(16);
function ch(id: string, name: string, over: Partial<ChannelSummary> = {}): ChannelSummary {
  return { id, communityId: A, kind: 0, mode: 0, name, topic: '', parentId: null, position: 0, slowmode: 0, announcement: false, group: 'none', ...over };
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

describe('orderChannels with an AFK channel (MP6)', () => {
  const afk = ch(id('a'), 'AFK', { kind: 1, parentId: id('9'), position: 1 << 30 });
  const list = [...LIST, afk, ch(id('b'), 'later', { kind: 2, position: 3 }), ch(id('c'), 'late', { parentId: id('b'), position: 0 })];
  it('puts the AFK channel last, below every category, and Alt+Down reaches it as the last stop', () => {
    const ordered = orderChannels(list, new Set([id('a')]));
    expect(ordered.map(c => c.name)).toEqual(['lounge', 'general', 'news', 'orphan', 'random', 'lobby', 'late', 'AFK']);
    expect(stepChannel(ordered, id('c'), 1)?.name).toBe('AFK');
    expect(stepChannel(ordered, id('a'), 1)?.name).toBe('AFK');
    expect(stepChannel(ordered, id('a'), -1)?.name).toBe('late');
  });
  it('is unchanged without an AFK set', () => {
    expect(orderChannels(list).map(c => c.name).at(-1)).toBe('late');
    expect(orderChannels(LIST, new Set()).map(c => c.name)).toEqual(['lounge', 'general', 'news', 'orphan', 'random', 'lobby']);
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
    { userId: id('a'), username: 'ada', display: 'Ada L', kind: 0, roleIds: [] },
    { userId: id('b'), username: 'bob', display: '', kind: 0, roleIds: [] },
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
    // a muted server mutes its channels (web3.5 WA5), and its row label says so
    const server = id('a');
    expect(rowBadge(BADGES, { [`mute.community.${server}`]: '1' }, id('6'), server)).toEqual({ unread: 0, mentions: 1, muted: true });
    expect(rowBadge(BADGES, { [`mute.community.${server}`]: '1' }, id('5'), server)).toEqual({ unread: 0, mentions: 0, muted: true });
    expect(rowBadge(BADGES, { [`mute.community.${server}`]: '1' }, id('5'))).toEqual({ unread: 3, mentions: 0, muted: false });
    expect(badgeLabel({ name: 'general', unread: 0, mentions: 1, muted: true })).toBe('general, muted, mentions 1');
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
  const m = (userId: string, username: string, display: string, kind: 0 | 1 = 0): MemberSummary => ({ userId, username, display, kind, roleIds: [] });
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
describe('names in bodies (L-TS-37)', () => {
  const SELF = { id: 'bb'.repeat(16), username: 'ada' };
  const BOB = '28'.repeat(16);
  const MO = '5c'.repeat(16);
  const ROLE = '7e'.repeat(16);
  const OTHER = '7f'.repeat(16);
  const UNKNOWN = 'ee'.repeat(16);
  const members: MemberSummary[] = [
    { userId: SELF.id, username: 'ada', display: 'Ada L', kind: 0, roleIds: [ROLE] },
    { userId: BOB, username: 'bob', display: '', kind: 0, roleIds: [] },
    { userId: MO, username: 'mo', display: 'Mo', kind: 0, roleIds: [OTHER] },
  ];
  const book = nameBook(SELF, members);
  it('collects every role and the own ones', () => {
    expect([...book.roles].sort()).toEqual([ROLE, OTHER].sort());
    expect([...book.ownRoles]).toEqual([ROLE]);
    expect(nameBook(null, members).ownRoles.size).toBe(0);
  });
  it('names users, the own user, roles, broadcasts and unknown ids, and keeps the rest as text', () => {
    const body = `hi <@${BOB}> and <@${SELF.id}>, <@everyone> <@here> <@${ROLE}> <@${OTHER}> <@${UNKNOWN}> <@NOPE>`;
    expect(bodyParts(body, book, true)).toEqual([
      { kind: 'text', text: 'hi ' },
      { kind: 'mention', label: '@bob', me: false, broadcast: false, userId: BOB },
      { kind: 'text', text: ' and ' },
      { kind: 'mention', label: '@Ada L', me: true, broadcast: false, userId: SELF.id },
      { kind: 'text', text: ', ' },
      { kind: 'mention', label: '@everyone', me: true, broadcast: true },
      { kind: 'text', text: ' ' },
      { kind: 'mention', label: '@here', me: true, broadcast: true },
      { kind: 'text', text: ' ' },
      { kind: 'mention', label: '@role', me: true, broadcast: false },
      { kind: 'text', text: ' ' },
      { kind: 'mention', label: '@role', me: false, broadcast: false },
      { kind: 'text', text: ' ' },
      { kind: 'mention', label: '@eeeeeeee', me: false, broadcast: false },
      { kind: 'text', text: ' <@NOPE>' },
    ]);
    expect(plainBody(body, book)).toBe('hi @bob and @Ada L, @everyone @here @role @role @eeeeeeee <@NOPE>');
  });
  // Review 10 (widened): the core decides whether a broadcast or a role token counts; when the row's mention flag is off,
  // they stay pills of their kind but never tinted as "you".
  it('tints broadcasts and my roles as me only when the row mentions me', () => {
    const body = `<@everyone> <@here> <@${ROLE}>`;
    const parts = bodyParts(body, book, false);
    expect(parts).toEqual([
      { kind: 'mention', label: '@everyone', me: false, broadcast: true },
      { kind: 'text', text: ' ' },
      { kind: 'mention', label: '@here', me: false, broadcast: true },
      { kind: 'text', text: ' ' },
      { kind: 'mention', label: '@role', me: false, broadcast: false },
    ]);
    expect(bodyParts(`<@${SELF.id}>`, book, false)).toEqual([{ kind: 'mention', label: '@Ada L', me: true, broadcast: false, userId: SELF.id }]);
  });
  it('names the own user by username when no member row holds it', () => {
    expect(bodyParts(`<@${SELF.id}>`, nameBook(SELF, []), true)).toEqual([{ kind: 'mention', label: '@ada', me: true, broadcast: false, userId: SELF.id }]);
  });
  it('MP7: an id is a user pill only when it is known to be a user: a member, self, or a sender we hold', () => {
    expect(bodyParts(`<@${UNKNOWN}>`, book, false)).toEqual([{ kind: 'mention', label: '@eeeeeeee', me: false, broadcast: false }]);
    expect(bodyParts(`<@${UNKNOWN}>`, withSenders(book, [{ senderUser: UNKNOWN }]), false))
      .toEqual([{ kind: 'mention', label: '@eeeeeeee', me: false, broadcast: false, userId: UNKNOWN }]);
    expect(bodyParts(`<@${UNKNOWN}>`, withSenders(book, [{ senderUser: null }, { senderUser: BOB }]), false))
      .toEqual([{ kind: 'mention', label: '@eeeeeeee', me: false, broadcast: false }]);
  });
  it('L4: knownName gives a shown name only when it is not the 8-character id fallback', () => {
    expect(knownName('eeeeeeee', UNKNOWN)).toBe('');
    expect(knownName('Bob', UNKNOWN)).toBe('Bob');
  });
  it('turns tokens back into what a person types for an edit', () => {
    expect(editableText(`hi <@${BOB}> <@${MO}> <@${SELF.id}> <@everyone> <@here> <@${UNKNOWN}>`, book))
      .toBe(`hi @bob @mo @ada @everyone @here <@${UNKNOWN}>`);
  });
  it('cuts an excerpt at 120 scalar values and flattens line breaks', () => {
    expect(excerpt('a\nb\rc')).toBe('a b c');
    expect(excerpt('x'.repeat(130))).toBe('x'.repeat(120));
    expect(excerpt('\u{1F44D}'.repeat(121))).toBe('\u{1F44D}'.repeat(120));
    expect(excerpt('abcdef', 3)).toBe('abc');
  });
  it('merges member lists, the first row of a user winning', () => {
    const bob2 = { ...members[1], display: 'Robert' };
    expect(mergeMembers([members.slice(0, 2), undefined, [bob2, members[2]]])).toEqual(members);
  });
});

describe('the mention list (L-TS-37)', () => {
  const m = (userId: string, username: string, display = ''): MemberSummary => ({ userId, username, display, kind: 0, roleIds: [] });
  const SELF = 'bb'.repeat(16);
  const bob = m('28'.repeat(16), 'bob');
  const mo = m('5c'.repeat(16), 'mo', 'Mo');
  const bobby = m('6d'.repeat(16), 'zz9', 'Bobby');
  it('offers everyone but the own user', () => {
    expect(mentionCandidates([m(SELF, 'ada'), bob, mo], SELF)).toEqual([bob, mo]);
    expect(mentionMembers([m(SELF, 'ada'), bob, m('77'.repeat(16), '')])).toEqual([{ userId: SELF, username: 'ada' }, { userId: bob.userId, username: 'bob' }]);
  });
  it('lists username prefixes first, then display prefixes, then @everyone in a channel (no @here entry)', () => {
    expect(mentionOptions('', [bob, mo], true)).toEqual([
      { id: `m-${bob.userId}`, primary: 'bob', secondary: '@bob', insert: '@bob ' },
      { id: `m-${mo.userId}`, primary: 'Mo', secondary: '@mo', insert: '@mo ' },
      { id: 'b-everyone', primary: '@everyone', secondary: 'everyone in this channel', insert: '@everyone ' },
    ]);
    expect(mentionOptions('BO', [bobby, mo, bob], true).map(o => o.id)).toEqual([`m-${bob.userId}`, `m-${bobby.userId}`]);
    expect(mentionOptions('M', [bob, mo], false).map(o => o.id)).toEqual([`m-${mo.userId}`]);
    expect(mentionOptions('e', [], true).map(o => o.id)).toEqual(['b-everyone']);
    expect(mentionOptions('h', [], true)).toEqual([]);
    expect(mentionOptions('e', [], false)).toEqual([]);
    expect(mentionOptions('x', [bob], true)).toEqual([]);
  });
  it('offers at most eight members', () => {
    const many = Array.from({ length: 10 }, (_, i) => m(String(i).repeat(32), `u${i}`));
    expect(mentionOptions('u', many, false).map(o => o.primary)).toEqual(['u0', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7']);
  });
});

describe('formatSize (L-COPY-03)', () => {
  it.each([
    [0, '0 B'], [1023, '1023 B'], [1024, '1.0 KB'], [1234, '1.2 KB'], [10_240, '10 KB'], [70_000, '68 KB'],
    [1_048_576, '1.0 MB'], [26_214_400, '25 MB'],
  ])('%d bytes read as %s', (bytes, text) => {
    expect(formatSize(bytes)).toBe(text);
  });
});

describe('voice (flow 06)', () => {
  const p = { userId: 'aa'.repeat(16), deviceId: 'bb'.repeat(16), name: 'bo', flags: 0, own: false, web: true, bot: false };
  it('reads the voice_state flag bits', () => {
    expect(participantView({ ...p, flags: 1 })).toMatchObject({ muted: false, deafened: false, video: false, screen: false, web: false, state: 'ok' });
    expect(participantView({ ...p, flags: 1 | 2 | 4 | 8 | 16 }, 'not-heard', true))
      .toMatchObject({ muted: true, deafened: true, video: true, screen: true, state: 'not-heard', speaking: true });
  });
  it('names a user by member, then trust row, then id', () => {
    const id = 'cd'.repeat(16);
    expect(userName(id, [{ userId: id, username: 'bob', display: 'Bob B', kind: 0, roleIds: [] }], [])).toBe('Bob B');
    expect(userName(id, [], [{ userId: id, name: 'bob' }])).toBe('bob');
    expect(userName(id, [], undefined)).toBe('cdcdcdcd');
  });
  it('maps refusals to copy by code only', () => {
    expect(joinFailureKey('E_CALL_FULL')).toBe('voice.full');
    expect(joinFailureKey('E_CALL_IN_OTHER_TAB')).toBe('voice.otherTab');
    expect(joinFailureKey('E_ABORTED')).toBeNull();
    expect(joinFailureKey('E_UMK_CHANGED')).toBeNull();
    expect(joinFailureKey('E_NETWORK')).toBe('voice.failed');
    expect(micNoticeKey('failed')).toBe('voice.micFailed');
    expect(micNoticeKey('ok')).toBeNull();
  });
  it('opens a voice channel but not a readable one', () => {
    expect(isVoice({ kind: 1, mode: 0 })).toBe(true);
    expect(isVoice({ kind: 1, mode: 1 })).toBe(false);
    expect(isVoice({ kind: 0, mode: 0 })).toBe(false);
  });
});

describe('role mentions (flow 09)', () => {
  const role = (id: string, name: string, over: Partial<RoleSummary> = {}): RoleSummary =>
    ({ id, name, color: 0, position: 3, hoist: false, mentionable: true, allow: 0, deny: 0, members: 0, ...over });
  const GAME = '71'.repeat(16);
  const MODS = '72'.repeat(16);
  const HIDDEN = '73'.repeat(16);
  const EVERYONE = '70'.repeat(16);
  const SELF = { id: 'bb'.repeat(16), username: 'ada' };
  const roles = [role(EVERYONE, '@everyone', { position: 0, mentionable: true }), role(GAME, 'Game Night', { color: 0x336699 }),
    role(MODS, 'Modérateurs', { mentionable: false }), role(HIDDEN, 'Quiet', { mentionable: false })];
  const m = (userId: string, username: string): MemberSummary => ({ userId, username, display: '', kind: 0, roleIds: [] });

  it('offers the mentionable roles, or every role but @everyone with the broadcast right', () => {
    expect(offeredRoles(roles, false).map(r => r.name)).toEqual(['Game Night']);
    expect(offeredRoles(roles, true).map(r => r.name)).toEqual(['Game Night', 'Modérateurs', 'Quiet']);
    expect(mentionRoles(offeredRoles(roles, true))[1]).toEqual({ roleId: MODS, handle: 'modérateurs' });
  });
  it('lists role options after the members and before @everyone, within the eight', () => {
    const offered = offeredRoles(roles, true);
    expect(mentionOptions('mod', [], true, offered)).toEqual([
      { id: `r-${MODS}`, primary: '@Modérateurs', secondary: 'role', insert: '@modérateurs ' },
    ]);
    const all = mentionOptions('', [m('28'.repeat(16), 'bob')], true, offered).map(o => o.id);
    expect(all).toEqual([`m-${'28'.repeat(16)}`, `r-${GAME}`, `r-${MODS}`, `r-${HIDDEN}`, 'b-everyone']);
    const many = Array.from({ length: 8 }, (_, i) => m(String(i).repeat(32), `u${i}`));
    expect(mentionOptions('', many, false, offered).map(o => o.id.slice(0, 2))).toEqual(['m-', 'm-', 'm-', 'm-', 'm-', 'm-', 'm-', 'm-']);
    expect(mentionOptions('g', [], false, offeredRoles(roles, false)).map(o => o.id)).toEqual([`r-${GAME}`]);
  });
  it('shows a known role with its name and colour, and keeps the generic label for an unknown one', () => {
    const book = nameBook(SELF, [{ ...m(SELF.id, 'ada'), roleIds: [GAME, '99'.repeat(16)] }], roles);
    expect(bodyParts(`<@${GAME}> <@${'99'.repeat(16)}>`, book, true)).toEqual([
      { kind: 'mention', label: '@Game Night', me: true, broadcast: false, color: 0x336699 },
      { kind: 'text', text: ' ' },
      { kind: 'mention', label: '@role', me: true, broadcast: false },
    ]);
    expect(plainBody(`<@${GAME}>`, book)).toBe('@Game Night');
    expect(editableText(`<@${GAME}>`, book)).toBe('@game-night');
  });
  it('matches a decomposed query against a composed handle', () => {
    expect(mentionOptions('mode\u0301', [], false, [role(MODS, 'Modérateurs')]).map(o => o.id)).toEqual([`r-${MODS}`]);
  });
  it('sorts roles by position, highest first, then by name', () => {
    const rs = [role('a1'.repeat(16), 'Beta', { position: 2 }), role('a2'.repeat(16), 'Alpha', { position: 2 }), role('a3'.repeat(16), 'Zed', { position: 7 })];
    expect(mentionOptions('', [], false, rs).map(o => o.primary)).toEqual(['@Zed', '@Alpha', '@Beta']);
  });
  it('leaves out a role whose handle a member, @everyone, @here or an earlier role already takes', () => {
    const bob = m('28'.repeat(16), 'bob');
    const rs = [role('a1'.repeat(16), 'Bob', { position: 9 }), role('a2'.repeat(16), 'Everyone', { position: 8 }), role('a3'.repeat(16), 'here', { position: 7 }),
      role('a4'.repeat(16), 'Staff', { position: 6 }), role('a5'.repeat(16), 'staff', { position: 5 })];
    expect(mentionOptions('', [bob], false, rs).map(o => o.id)).toEqual([`m-${bob.userId}`, `r-${'a4'.repeat(16)}`]);
    expect(mentionRoles(rs, [bob]).map(r => r.roleId)).toEqual(['a4'.repeat(16)]);
  });
});

describe('selfName', () => {
  const me = { id: 'bb'.repeat(16), username: 'ada' };
  const member = (display: string): MemberSummary => ({ userId: me.id, username: 'ada', display, kind: 0, roleIds: [] });
  it('names the person by the member row, then by the account display name, then by the username', () => {
    expect(selfName({ ...me, display: 'Account Ada' }, [member('Server Ada')])).toBe('Server Ada');
    expect(selfName({ ...me, display: 'Account Ada' }, [])).toBe('Account Ada');
    expect(selfName({ ...me, display: '' }, [member('')])).toBe('ada');
    expect(selfName(me, [])).toBe('ada');
    expect(selfName(null, [])).toBe('–');
  });
});

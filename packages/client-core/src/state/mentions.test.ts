import { describe, expect, it } from 'vitest';
import { encodeMentions, mentionQuery, mentionsMe, splitMentions, type MentionMember } from './mentions';

const A = 'a1'.repeat(16);
const B = 'b2'.repeat(16);
const C = 'c3'.repeat(16);
const ROLE = '40'.repeat(16);
const MEMBERS: MentionMember[] = [{ userId: A, username: 'ada' }, { userId: B, username: 'bob.smith' }, { userId: C, username: 'c_3-po' }];

describe('splitMentions (C23)', () => {
  it('splits the three token forms out of the text', () => {
    expect(splitMentions(`hi <@everyone> and <@${A}>!`)).toEqual([
      { kind: 'text', text: 'hi ' }, { kind: 'mention', target: 'everyone' }, { kind: 'text', text: ' and ' },
      { kind: 'mention', target: A }, { kind: 'text', text: '!' }]);
    expect(splitMentions('<@here><@here>')).toEqual([{ kind: 'mention', target: 'here' }, { kind: 'mention', target: 'here' }]);
    expect(splitMentions('<@<@everyone>>')).toEqual([{ kind: 'text', text: '<@' }, { kind: 'mention', target: 'everyone' }, { kind: 'text', text: '>' }]);
  });

  it('leaves anything that is not a literal lower-case token as text', () => {
    expect(splitMentions(`<@${A.toUpperCase()}>`)).toEqual([{ kind: 'text', text: `<@${A.toUpperCase()}>` }]);
    expect(splitMentions(`<@${A.slice(1)}>`)).toEqual([{ kind: 'text', text: `<@${A.slice(1)}>` }]);
    expect(splitMentions('<@Everyone>')).toEqual([{ kind: 'text', text: '<@Everyone>' }]);
    expect(splitMentions('')).toEqual([]);
  });
});

describe('encodeMentions (ruling 11)', () => {
  it.each([
    ['@ada hi', `<@${A}> hi`],
    ['hi @Ada.', `hi <@${A}>.`],
    ['(@bob.smith)', `(<@${B}>)`],
    ['"@c_3-po"', `"<@${C}>"`],
    ['@ada@bob.smith', `<@${A}>@bob.smith`],
    ['mail ada@example.com', 'mail ada@example.com'],
    ['@nobody', '@nobody'],
    [`<@${A}>`, `<@${A}>`],
    ['line\n@ada', `line\n<@${A}>`],
  ])('%j becomes %j', (input, want) => {
    expect(encodeMentions(input, MEMBERS, true)).toBe(want);
  });

  it('writes @everyone and @here as tokens only when broadcast is allowed', () => {
    expect(encodeMentions('@everyone look, @here too', MEMBERS, true)).toBe('<@everyone> look, <@here> too');
    expect(encodeMentions('@everyone look, @here too', MEMBERS, false)).toBe('@everyone look, @here too');
  });
});

describe('mentionQuery', () => {
  it.each([
    ['hi @ad', 6, { start: 3, query: 'ad' }],
    ['@', 1, { start: 0, query: '' }],
    ['(@bo', 4, { start: 1, query: 'bo' }],
    ['@ada', 2, { start: 0, query: 'a' }],
    ['mail a@b', 8, null],
    ['@ada hi', 7, null],
    ['no at sign', 10, null],
    [`@${'a'.repeat(32)}`, 33, { start: 0, query: 'a'.repeat(32) }],
    [`@${'a'.repeat(33)}`, 34, null],
  ] as const)('%j at %i', (text, caret, want) => {
    expect(mentionQuery(text, caret)).toEqual(want);
  });
});

describe('mentionsMe (L-CORE-35 over hex)', () => {
  it('counts the own user, everyone, here and own roles, literally', () => {
    expect(mentionsMe(`hey <@${A}>`, A, [])).toBe(true);
    expect(mentionsMe('<@everyone>', A, [])).toBe(true);
    expect(mentionsMe('<@here>', A, [])).toBe(true);
    expect(mentionsMe(`<@${ROLE}> look`, A, [ROLE])).toBe(true);
    expect(mentionsMe(`<@${ROLE}> look`, A, [])).toBe(false);
    expect(mentionsMe(`<@${B}>`, A, [ROLE])).toBe(false);
    expect(mentionsMe(`<@${A.toUpperCase()}>`, A, [])).toBe(false);
    expect(mentionsMe('@ada', A, [])).toBe(false);
  });
});

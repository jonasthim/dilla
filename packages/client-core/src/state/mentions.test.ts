import { describe, expect, it } from 'vitest';
import { encodeMentions, mentionQuery, mentionsDirectly, mentionsMe, roleHandle, splitMentions, type MentionMember } from './mentions';

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

describe('mentionsDirectly (web3.5)', () => {
  it('ignores the broadcast tokens', () => {
    expect(mentionsDirectly('<@everyone>', A, [])).toBe(false);
    expect(mentionsDirectly('<@here>', A, [])).toBe(false);
    expect(mentionsDirectly(`<@${A}>`, A, [])).toBe(true);
    expect(mentionsDirectly(`<@${ROLE}>`, A, [ROLE])).toBe(true);
    expect(mentionsDirectly(`<@${ROLE}>`, A, [])).toBe(false);
  });
});

describe('roleHandle', () => {
  it('lower-cases, collapses whitespace to dashes and normalises to NFC', () => {
    expect(roleHandle('Game  Night')).toBe('game-night');
    expect(roleHandle(' Mods ')).toBe('mods');
    expect(roleHandle('Modérateurs')).toBe('modérateurs');
    expect(roleHandle('Modérateurs')).toBe('modérateurs');
  });
});

describe('encodeMentions with roles (web3.5)', () => {
  const R1 = '51'.repeat(16);
  const R2 = '52'.repeat(16);
  it('writes a role token for its handle', () => {
    expect(encodeMentions('hi @game-night', MEMBERS, true, [{ roleId: R1, handle: 'game-night' }])).toBe(`hi <@${R1}>`);
    expect(encodeMentions('@Modérateurs.', MEMBERS, true, [{ roleId: R1, handle: 'modérateurs' }])).toBe(`<@${R1}>.`);
  });
  it('leaves @everyone alone without broadcast, and an unknown handle', () => {
    expect(encodeMentions('@everyone', MEMBERS, false)).toBe('@everyone');
    expect(encodeMentions('@everyone', MEMBERS, false, [{ roleId: R1, handle: 'crew' }])).toBe('@everyone');
    expect(encodeMentions('@game-nights', MEMBERS, true, [{ roleId: R1, handle: 'game-night' }])).toBe('@game-nights');
  });
  it('the longest match wins', () => {
    const roles = [{ roleId: R1, handle: 'game' }, { roleId: R2, handle: 'game-night' }];
    expect(encodeMentions('@game-night', MEMBERS, true, roles)).toBe(`<@${R2}>`);
    expect(encodeMentions('@game ok', MEMBERS, true, roles)).toBe(`<@${R1}> ok`);
  });
  it('breaks ties broadcast > member > role', () => {
    expect(encodeMentions('@crew', [{ userId: A, username: 'crew' }], true, [{ roleId: R1, handle: 'crew' }])).toBe(`<@${A}>`);
    expect(encodeMentions('@here', MEMBERS, true, [{ roleId: R1, handle: 'here' }])).toBe('<@here>');
    expect(encodeMentions('@here', [{ userId: A, username: 'here' }], true)).toBe('<@here>');
    expect(encodeMentions('@here', MEMBERS, false, [{ roleId: R1, handle: 'here' }])).toBe(`<@${R1}>`);
  });
  it('a longer member beats a shorter role', () => {
    expect(encodeMentions('@bob.smith', MEMBERS, true, [{ roleId: R1, handle: 'bob' }])).toBe(`<@${B}>`);
  });
});

describe('mentionQuery with Unicode (web3.5)', () => {
  it('keeps letters beyond ASCII in the query', () => {
    expect(mentionQuery('hi @modé', 8)).toEqual({ start: 3, query: 'modé' });
  });
});

describe('encodeMentions edge cases (fix round 1)', () => {
  const R1 = '51'.repeat(16);
  const role = (handle: string) => [{ roleId: R1, handle }];
  it('ends a mention before CJK text', () => {
    expect(encodeMentions('@ada你好', MEMBERS, true)).toBe(`<@${A}>你好`);
    expect(encodeMentions('@ada こんにちは', MEMBERS, true)).toBe(`<@${A}> こんにちは`);
    expect(encodeMentions('@adaカタカナ', MEMBERS, true)).toBe(`<@${A}>カタカナ`);
    expect(encodeMentions('@ada안녕', MEMBERS, true)).toBe(`<@${A}>안녕`);
    expect(encodeMentions('@王小明你好', [{ userId: A, username: '王小明' }], true)).toBe(`<@${A}>你好`);
    expect(encodeMentions('@ada\u{20000}', MEMBERS, true)).toBe(`<@${A}>\u{20000}`);
  });
  it('treats combining marks as part of the name', () => {
    expect(encodeMentions('@ab\u0301', MEMBERS, true, role('ab'))).toBe('@ab\u0301');
    expect(encodeMentions('@ab\u0301', MEMBERS, true, role('ab\u0301'))).toBe(`<@${R1}>`);
    expect(encodeMentions('@mode\u0301', MEMBERS, true, role('mode'))).toBe('@modé');
  });
  it('matches NFD text against NFC handles and names', () => {
    expect(encodeMentions('@Mode\u0301rateurs', MEMBERS, true, role('modérateurs'))).toBe(`<@${R1}>`);
    expect(encodeMentions('@Jose\u0301', [{ userId: A, username: 'José' }], true)).toBe(`<@${A}>`);
    expect(encodeMentions('@Josée', [{ userId: A, username: 'Jose\u0301e' }], true)).toBe(`<@${A}>`);
    expect(encodeMentions('@Modérateurs', MEMBERS, true, role('Mode\u0301rateurs'))).toBe(`<@${R1}>`);
    expect(encodeMentions('@ada\u{1D4B3}', MEMBERS, true)).toBe('@ada\u{1D4B3}');
    expect(encodeMentions('@ada.你好', MEMBERS, true)).toBe(`<@${A}>.你好`);
    expect(encodeMentions('@MODÉRATEURS', MEMBERS, true, role('Modérateurs'))).toBe(`<@${R1}>`);
  });
  it('does not split a longer name', () => {
    expect(encodeMentions('@bob.smith', MEMBERS, true, [{ roleId: R1, handle: 'bob' }])).toBe(`<@${B}>`);
    expect(encodeMentions('@bob.smith', [{ userId: A, username: 'bob' }], true)).toBe('@bob.smith');
    expect(encodeMentions('@bob..x', [{ userId: A, username: 'bob' }], true)).toBe('@bob..x');
    expect(encodeMentions('@game-night', MEMBERS, true, [{ roleId: R1, handle: 'game' }, { roleId: R1, handle: 'game-nights' }])).toBe('@game-night');
    expect(encodeMentions('@modé', MEMBERS, true, role('mod'))).toBe('@modé');
  });
});

describe('mentionQuery with combining marks', () => {
  it('stays open on NFD text', () => {
    expect(mentionQuery('@mode\u0301', 6)).toEqual({ start: 0, query: 'mode\u0301' });
  });
});

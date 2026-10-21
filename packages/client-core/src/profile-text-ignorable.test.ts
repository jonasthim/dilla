// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { profileTextProblem, profileTextValue } from './profile-text';
import { UNICODE_TABLES_VERSION } from './profile-tables';

// The client half of internal/auth/profile_text_ignorable_test.go: the same cases, the same answers. The characters are
// code points, never literals.
const str = (...cps: number[]): string => String.fromCodePoint(...cps);
const problem = (s: string, multiline = false) => profileTextProblem(s, 190, multiline);
const chars = (...cps: number[]) => { expect(problem(str(...cps)), cps.map((c) => c.toString(16)).join(' ')).toBe('chars'); };
const accepted = (...cps: number[]) => { expect(problem(str(...cps)), cps.map((c) => c.toString(16)).join(' ')).toBeNull(); };

describe('Default_Ignorable_Code_Point', () => {
  const cps = [
    0x2065, 0xfff0, 0xfff8, 0x1d173, 0x1d17a, 0xe0001, 0xe0000, 0xe0002, 0xe001f, 0xe0080, 0xe00ff, 0xe01f0, 0xe0fff,
    0x1bca0, 0x1bca3, 0x17b4, 0x17b5, 0x180b, 0x180c, 0x180d, 0x180f, 0x00ad, 0x034f, 0x061c, 0x115f, 0x1160, 0x180e,
    0x200b, 0x2060, 0x2064, 0x206a, 0x206f, 0x3164, 0xfeff, 0xffa0,
  ];
  it('are refused between letters and alone (never an invisible name that is not blank)', () => {
    for (const cp of cps) { chars(97, cp, 98); chars(cp); }
  });
});

describe('unassigned, noncharacter, private use and surrogate code points', () => {
  it('are refused; U+FFFD is assigned and visible', () => {
    for (const cp of [0x378, 0x40000, 0xffff, 0xfffe, 0xfdd0, 0x1fffe, 0x10ffff, 0xe000, 0xf0000, 0x10fffd]) chars(97, cp, 98);
    accepted(97, 0xfffd, 98);
  });
  it('refuses a lone surrogate, as the server refuses what is not valid UTF-8', () => {
    expect(problem('a\ud800b')).toBe('chars');
    expect(problem('a\udc00')).toBe('chars');
    expect(problem('\ud800')).toBe('chars');
    accepted(97, 0x1f642); // a surrogate pair is one character
  });
});

describe('Mongolian free variation selectors', () => {
  const a = 0x1820;
  it('follow a Mongolian letter, one per letter', () => {
    accepted(a, 0x180b);
    accepted(a, 0x180c);
    accepted(a, 0x180d);
    accepted(a, 0x180f);
    accepted(a, 0x180b, a, 0x180c);
    chars(97, 0x180b);
    chars(0x180b);
    chars(a, 0x180b, 0x180c);
    chars(a, 0x20, 0x180b);
    chars(a, 0x180e);
  });
});

describe('a stack of combining marks', () => {
  const marks = (n: number) => str(97) + str(0x301).repeat(n);
  it('may be 8 marks on a base and not 9, though NFC composes the first into the base', () => {
    for (const n of [1, 3, 8]) expect(problem(marks(n)), String(n)).toBeNull();
    for (const n of [9, 10, 30, 31, 100]) expect(problem(marks(n)), String(n)).toBe('chars');
    expect(problem(marks(8) + marks(8) + marks(8))).toBeNull();
  });
  it('lets Vietnamese and Hebrew with points through', () => {
    accepted(101, 0x302, 0x323);
    accepted(0x5e9, 0x5bc, 0x5c1, 0x5b8);
  });
});

describe('white space', () => {
  it('is the White_Space property: a figure space is trimmed and a text of spaces is blank', () => {
    expect(profileTextValue(str(0x2007, 97, 0x3000))).toBe('a');
    expect(problem(str(0x2007, 0x2009, 32))).toBe('blank');
    expect(problem(str(0x301))).toBe('blank');
  });
});

describe('the tables', () => {
  it('are the version the server uses', () => {
    expect(UNICODE_TABLES_VERSION).toBe('17.0.0');
  });
});

describe('marks and joiners alone', () => {
  it('are blank: a virama and a ZWNJ show nothing', () => {
    expect(problem(str(0xa4d, 0x200c))).toBe('blank');
    expect(problem(str(0x94d, 0x200d))).toBe('blank');
    expect(problem(str(0x301, 0x200d, 0x302))).toBe('chars'); // a ZWJ after a non-virama mark is refused outright
    accepted(0x915, 0x94d, 0x200d);
  });
});

describe('the mark cap is per base character', () => {
  // U+0941 is Mn with combining class 0: NFC cannot reorder it, so the virama stays next to the joiner.
  const marks = (n: number, cp = 0x941) => str(...Array<number>(n).fill(cp));
  it('is not reset by a joiner or an ignorable between marks', () => {
    expect(problem(`${str(0x915)}${marks(7)}${str(0x94d, 0x200c)}${marks(8)}`)).toBe('chars');
    expect(problem(`${str(0x915)}${marks(7)}${str(0x94d, 0x200d)}${marks(8)}`)).toBe('chars');
    expect(problem(`${str(0x1f642, 0xfe0f)}${marks(8, 0x301)}${marks(8, 0x301)}`)).toBe('chars');
  });
  it('is reset by a new base, and leaves Sinhala and Persian alone', () => {
    expect(problem(`${str(0x915)}${marks(8)}b${marks(8)}c${marks(8)}`)).toBeNull();
    accepted(0xdc1, 0xdca, 0x200d, 0xdbb, 0xdd3);
    accepted(0x645, 0x6cc, 0x200c, 0x62e, 0x648, 0x627, 0x647, 0x645);
  });
});

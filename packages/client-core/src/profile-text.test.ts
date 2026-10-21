// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { profileTextProblem, profileTextValue } from './profile-text';

// The mirror of internal/auth NormalizeUserText (profile_text_scripts_test.go has the Go side of every case). The
// characters are code points, never literals.
const str = (...cps: number[]): string => String.fromCodePoint(...cps);
const ZWNJ = 0x200c;
const ZWJ = 0x200d;
const problem = (s: string, multiline = false) => profileTextProblem(s, 190, multiline);

describe('joiners keep Persian, Kurdish and Sinhala text working (RFC 5892 A.1, A.2)', () => {
  const accepted: Record<string, string> = {
    'persian mikhaham': str(0x645, 0x6cc, ZWNJ, 0x62e, 0x648, 0x627, 0x647, 0x645),
    'persian mohammadi nejad': str(0x645, 0x62d, 0x645, 0x62f, 0x6cc, ZWNJ, 0x646, 0x698, 0x627, 0x62f),
    'persian ketabha': str(0x6a9, 0x62a, 0x627, 0x628, ZWNJ, 0x647, 0x627),
    'sinhala shri': str(0xdc1, 0xdca, ZWJ, 0xdbb, 0xdd3),
    'devanagari zwnj': str(0x915, 0x94d, ZWNJ, 0x937),
    'devanagari zwj': str(0x915, 0x94d, ZWJ, 0x937),
    'malayalam chillu by zwj': str(0xd23, 0xd4d, ZWJ),
    'zwnj across a mark': str(0x628, 0x64e, ZWNJ, 0x647),
  };
  for (const [name, text] of Object.entries(accepted)) it(`accepts ${name}`, () => { expect(problem(text)).toBeNull(); });
  const refused: Record<string, string> = {
    'leading zwnj': str(ZWNJ, 0x645),
    'trailing zwnj': str(0x645, ZWNJ),
    'bare zwnj between latin': str(97, ZWNJ, 98),
    'zwnj after a right joiner': str(0x627, ZWNJ, 0x628),
    'zwnj before a letter that does not join': str(0x628, ZWNJ, 0x621),
    'doubled zwnj': str(0x628, ZWNJ, ZWNJ, 0x647),
    'leading zwj': str(ZWJ, 0x645),
    'zwj between persian letters': str(0x645, ZWJ, 0x6cc),
    'zwj after a latin letter': str(97, ZWJ, 98),
    'doubled zwj after a virama': str(97, 0x94d, ZWJ, ZWJ, 98),
  };
  for (const [name, text] of Object.entries(refused)) it(`refuses ${name}`, () => { expect(problem(text)).toBe('chars'); });
});

describe('emoji joiners need pictographs', () => {
  it('refuses two copyright signs, a caret and braille joined', () => {
    expect(problem(str(0xa9, ZWJ, 0xa9))).toBe('chars');
    expect(problem(str(94, ZWJ, 0xa9))).toBe('chars');
    expect(problem(str(0x2800, ZWJ, 0x2801))).toBe('chars');
  });
  it('accepts head shaking horizontally and a family, refuses a trailing and a doubled joiner', () => {
    expect(problem(str(0x1f642, ZWJ, 0x2194, 0xfe0f))).toBeNull();
    expect(problem(str(0x1f468, ZWJ, 0x1f469, ZWJ, 0x1f467))).toBeNull();
    expect(problem(str(0x1f642, ZWJ))).toBe('chars');
    expect(problem(str(0x1f642, ZWJ, ZWJ, 0x1f642))).toBe('chars');
  });
  it('accepts every RGI emoji ZWJ sequence of the Unicode version the tables come from', () => {
    const file = fileURLToPath(new URL('../../../internal/auth/testdata/rgi-zwj-sequences.txt', import.meta.url));
    const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#'));
    expect(lines.length).toBeGreaterThan(1000);
    const bad = lines.filter((l) => problem(str(...l.trim().split(/\s+/).map((h) => parseInt(h, 16)))) !== null);
    expect(bad).toEqual([]);
  });
});

describe('invisible characters', () => {
  it('accepts the England flag tag sequence and refuses every other tag character', () => {
    expect(problem(str(0x1f3f4, 0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067, 0xe007f))).toBeNull();
    for (const text of [str(97, 0xe0041, 98), str(0xe007f), str(97, 0xe0067, 0xe007f), str(0x1f3f4, 0xe0067, 0xe0062), str(0x1f642, 0xe0068, 0xe0069, 0xe007f)]) {
      expect(problem(text), text).toBe('chars');
    }
  });
  it('refuses soft hyphen, the grapheme joiner, the Hangul fillers, braille blank and the invisible operators', () => {
    for (const cp of [0xad, 0x34f, 0x115f, 0x1160, 0x3164, 0xffa0, 0x2800, 0x2061, 0x2064, 0x180e, 0x206a, 0xfff9, 0x200b, 0x2060, 0xfeff, 0x61c, 0x2028, 0x2029]) {
      expect(problem(str(97, cp, 98)), cp.toString(16)).toBe('chars');
    }
  });
  it('calls a text of nothing visible blank', () => {
    expect(problem(str(0x301))).toBe('blank');
    expect(problem(str(0xfe0f))).toBe('blank');
    expect(problem(str(32, 0x301, 32, 0xfe0e))).toBe('blank');
    expect(problem(str(101, 0x301))).toBeNull();
  });
});

describe('profileTextValue', () => {
  it('trims and normalises', () => {
    expect(profileTextValue('  é  ')).toBe('é');
  });
});

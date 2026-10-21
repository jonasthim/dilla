// Generates the Unicode tables the shared profile-text rule needs and the two runtimes lack or disagree on:
//   internal/auth/profile_tables.go
//   packages/client-core/src/profile-tables.ts
//   internal/auth/testdata/rgi-zwj-sequences.txt   (one sequence per line, hex code points)
// from the Unicode Character Database of ONE pinned version, so the server and the client agree and a runtime upgrade
// cannot change what is accepted.
//
//   node scripts/gen-profile-text-tables.mjs [--download] [--check] <dir>
//
//   <dir>       holds the input files (named as in INPUTS below)
//   --download  fetch the inputs missing from <dir> from their versioned unicode.org URLs
//   --check     write nothing: exit 1 when the checked-in files differ from what the inputs generate (CI runs this)
//
// Every input is verified against the sha256 kept below; a file that does not match stops the run.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '17.0.0';
const BASE = `https://www.unicode.org/Public/${VERSION}`;
/** name -> [versioned URL, sha256] */
const INPUTS = {
  'DerivedCombiningClass.txt': [`${BASE}/ucd/extracted/DerivedCombiningClass.txt`, '191463abfbd202703c6fd6776a92a23ac44ec65e0476a7f95aa91ca492cef29b'],
  'DerivedCoreProperties.txt': [`${BASE}/ucd/DerivedCoreProperties.txt`, '24c7fed1195c482faaefd5c1e7eb821c5ee1fb6de07ecdbaa64b56a99da22c08'],
  'DerivedGeneralCategory.txt': [`${BASE}/ucd/extracted/DerivedGeneralCategory.txt`, 'd62e5bab70ca74f099343f71224fa051cb1fdd61a1ab45c0488c44cfc0b6102e'],
  'DerivedJoiningType.txt': [`${BASE}/ucd/extracted/DerivedJoiningType.txt`, 'f39ebe974825d6736aee15582250307aa532b2cfab3caf3f86bd23fddc9c5c4d'],
  'PropList.txt': [`${BASE}/ucd/PropList.txt`, '130dcddcaadaf071008bdfce1e7743e04fdfbc910886f017d9f9ac931d8c64dd'],
  'Scripts.txt': [`${BASE}/ucd/Scripts.txt`, '9f5e50d3abaee7d6ce09480f325c706f485ae3240912527e651954d2d6b035bf'],
  'emoji-data.txt': [`${BASE}/ucd/emoji/emoji-data.txt`, '2cb2bb9455cda83e8481541ecf5b6dfda66a3bb89efa3fa7c5297eccf607b72b'],
  'emoji-sequences.txt': [`${BASE}/emoji/emoji-sequences.txt`, '12cc8267dc33cbd11ed32bcf6fc5dc2ad9c7a77bae1bdfba2f41b1b9b3ead8dd'],
  'emoji-zwj-sequences.txt': [`${BASE}/emoji/emoji-zwj-sequences.txt`, '5b25441daed2322b068c5e70cda522946a4f0274df864445a1965a92e5fc5cad'],
};

const args = process.argv.slice(2);
const download = args.includes('--download');
const check = args.includes('--check');
const dir = args.find((a) => !a.startsWith('--'));
if (!dir) throw new Error('usage: gen-profile-text-tables.mjs [--download] [--check] <dir>');
const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
mkdirSync(dir, { recursive: true });
const files = {};
for (const [name, [url, want]] of Object.entries(INPUTS)) {
  const path = join(dir, name);
  if (!existsSync(path)) {
    if (!download) throw new Error(`${name} is missing from ${dir} (use --download)`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  }
  const buf = readFileSync(path);
  if (sha(buf) !== want) throw new Error(`${name}: sha256 ${sha(buf)} is not the pinned ${want}`);
  files[name] = buf.toString('utf8');
}

const hex = (n) => '0x' + n.toString(16).toUpperCase().padStart(4, '0');

/** Sorted, merged [lo, hi] ranges. */
function merge(pairs) {
  pairs.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [lo, hi] of pairs) {
    const last = out[out.length - 1];
    if (last && last[1] + 1 >= lo) last[1] = Math.max(last[1], hi); else out.push([lo, hi]);
  }
  return out;
}
/** Lines of "XXXX[..YYYY] ; value ..." as [lo, hi, value]. */
function rows(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^([0-9A-F]+)(?:\.\.([0-9A-F]+))?\s*;\s*([A-Za-z_0-9]+)/.exec(line);
    if (m) out.push([parseInt(m[1], 16), parseInt(m[2] ?? m[1], 16), m[3]]);
  }
  return out;
}
const rangesOf = (text, ...values) => merge(rows(text).filter((r) => values.includes(r[2])).map(([lo, hi]) => [lo, hi]));

// Canonical_Combining_Class 9 (virama): "0 ; 9 # Mn ..." lines of DerivedCombiningClass.txt.
const viramas = merge(rows(files['DerivedCombiningClass.txt']).filter((r) => r[2] === '9').map(([lo, hi]) => [lo, hi]));
const defaultIgnorable = rangesOf(files['DerivedCoreProperties.txt'], 'Default_Ignorable_Code_Point');
const whiteSpace = rangesOf(files['PropList.txt'], 'White_Space');
const emojiData = files['emoji-data.txt'];
const extPict = rangesOf(emojiData, 'Extended_Pictographic');
const emojiPres = rangesOf(emojiData, 'Emoji_Presentation');
const emoji = rangesOf(emojiData, 'Emoji');

// General_Category: marks (Mn, Me), and the code points no text may carry: unassigned (Cn, which includes the
// noncharacters), private use (Co) and surrogates (Cs).
const gc = files['DerivedGeneralCategory.txt'];
const marks = rangesOf(gc, 'Mn', 'Me');
const unusable = rangesOf(gc, 'Cn', 'Co', 'Cs');
const lo = rangesOf(gc, 'Lo');

// Joining_Type: DerivedJoiningType.txt lists L, R, D, C and T; everything else is U.
const joiningRows = [];
for (const [from, to, type] of rows(files['DerivedJoiningType.txt'])) if (type.length === 1 && 'LRDCT'.includes(type)) joiningRows.push([from, to, type]);
joiningRows.sort((a, b) => a[0] - b[0]);
const joining = [];
for (const [from, to, type] of joiningRows) {
  const last = joining[joining.length - 1];
  if (last && last[2] === type && last[1] + 1 === from) last[1] = to; else joining.push([from, to, type]);
}

// A Mongolian letter: Script=Mongolian and General_Category=Lo. A free variation selector (U+180B-180D, U+180F) may follow one.
const mongolianAll = rangesOf(files['Scripts.txt'], 'Mongolian');
const mongolianLetters = merge(lo.flatMap(([a, b]) => mongolianAll.flatMap(([c, d]) => (a <= d && c <= b ? [[Math.max(a, c), Math.min(b, d)]] : []))));

// RGI_Emoji_Tag_Sequence: the only runs of tag characters a text may carry.
const tagSeqs = [];
for (const line of files['emoji-sequences.txt'].split('\n')) {
  const m = /^([0-9A-F ]+);\s*RGI_Emoji_Tag_Sequence/.exec(line);
  if (m) tagSeqs.push(m[1].trim().split(/\s+/).map((h) => parseInt(h, 16)));
}
// RGI_Emoji_ZWJ_Sequence, to test that every one of them is accepted.
const zwjSeqs = [];
for (const line of files['emoji-zwj-sequences.txt'].split('\n')) {
  const m = /^([0-9A-F ]+);\s*RGI_Emoji_ZWJ_Sequence/.exec(line);
  if (m) zwjSeqs.push(m[1].trim().replace(/\s+/g, ' '));
}

const goPairs = (rs) => rs.map(([a, b]) => `{${hex(a)}, ${hex(b)}}`).join(', ');
const go = `// Code generated by scripts/gen-profile-text-tables.mjs from Unicode ${VERSION}; DO NOT EDIT.

package auth

// unicodeTablesVersion is the Unicode version the tables below were generated from.
const unicodeTablesVersion = "${VERSION}"

type runeRange struct{ lo, hi rune }

type joinRange struct {
	lo, hi rune
	typ    byte
}

// viramaRanges are the code points with Canonical_Combining_Class 9.
var viramaRanges = []runeRange{${goPairs(viramas)}}

// defaultIgnorableRanges are the code points with Default_Ignorable_Code_Point=Yes.
var defaultIgnorableRanges = []runeRange{${goPairs(defaultIgnorable)}}

// whiteSpaceRanges are the code points with White_Space=Yes.
var whiteSpaceRanges = []runeRange{${goPairs(whiteSpace)}}

// markRanges are the code points of General_Category Mn and Me.
var markRanges = []runeRange{${goPairs(marks)}}

// unusableRanges are the code points of General_Category Cn (with the noncharacters), Co and Cs.
var unusableRanges = []runeRange{${goPairs(unusable)}}

// extPictRanges are the code points with Extended_Pictographic=Yes.
var extPictRanges = []runeRange{${goPairs(extPict)}}

// emojiPresentationRanges are the code points with Emoji_Presentation=Yes.
var emojiPresentationRanges = []runeRange{${goPairs(emojiPres)}}

// emojiRanges are the code points with Emoji=Yes: the bases a variation selector U+FE0E or U+FE0F may follow.
var emojiRanges = []runeRange{${goPairs(emoji)}}

// mongolianLetterRanges are the Mongolian letters (Script=Mongolian, General_Category=Lo): the bases a free variation
// selector U+180B-180D or U+180F may follow.
var mongolianLetterRanges = []runeRange{${goPairs(mongolianLetters)}}

// tagSequences are the RGI_Emoji_Tag_Sequence: the only runs of tag characters a text may carry.
var tagSequences = [][]rune{${tagSeqs.map((q) => `{${q.map(hex).join(', ')}}`).join(', ')}}

// joiningRanges are the code points with Joining_Type L, R, D, C or T (every other code point is U).
var joiningRanges = []joinRange{${joining.map(([a, b, t]) => `{${hex(a)}, ${hex(b)}, '${t}'}`).join(', ')}}
`;

const tsPairs = (rs) => `[${rs.map(([a, b]) => `[${hex(a)}, ${hex(b)}]`).join(', ')}]`;
const ts = `// Generated by scripts/gen-profile-text-tables.mjs from Unicode ${VERSION}; do not edit.
// The tables the shared profile-text rule needs (internal/auth/profile_tables.go has the same ones).

export const UNICODE_TABLES_VERSION = '${VERSION}';
export type RuneRange = readonly [number, number];
/** Canonical_Combining_Class 9 (virama). */
export const VIRAMA: readonly RuneRange[] = ${tsPairs(viramas)};
/** Default_Ignorable_Code_Point=Yes. */
export const DEFAULT_IGNORABLE: readonly RuneRange[] = ${tsPairs(defaultIgnorable)};
/** White_Space=Yes. */
export const WHITE_SPACE: readonly RuneRange[] = ${tsPairs(whiteSpace)};
/** General_Category Mn and Me. */
export const MARKS: readonly RuneRange[] = ${tsPairs(marks)};
/** General_Category Cn (with the noncharacters), Co and Cs. */
export const UNUSABLE: readonly RuneRange[] = ${tsPairs(unusable)};
/** Extended_Pictographic=Yes. */
export const EXT_PICT: readonly RuneRange[] = ${tsPairs(extPict)};
/** Emoji_Presentation=Yes. */
export const EMOJI_PRESENTATION: readonly RuneRange[] = ${tsPairs(emojiPres)};
/** Emoji=Yes: the bases a variation selector U+FE0E or U+FE0F may follow. */
export const EMOJI: readonly RuneRange[] = ${tsPairs(emoji)};
/** Mongolian letters (Script=Mongolian, General_Category=Lo): the bases a free variation selector may follow. */
export const MONGOLIAN_LETTERS: readonly RuneRange[] = ${tsPairs(mongolianLetters)};
/** RGI_Emoji_Tag_Sequence: the only runs of tag characters a text may carry. */
export const TAG_SEQUENCES: readonly (readonly number[])[] = [${tagSeqs.map((q) => `[${q.map(hex).join(', ')}]`).join(', ')}];
/** Joining_Type L, R, D, C and T: [from, to, type]; every other code point is U. */
export const JOINING: readonly (readonly [number, number, string])[] = [${joining.map(([a, b, t]) => `[${hex(a)}, ${hex(b)}, '${t}']`).join(', ')}];
`;

const rgi = `# RGI_Emoji_ZWJ_Sequence of Unicode ${VERSION}: one sequence per line, hex code points.\n${zwjSeqs.join('\n')}\n`;

const outputs = {
  'internal/auth/profile_tables.go': go,
  'packages/client-core/src/profile-tables.ts': ts,
  'internal/auth/testdata/rgi-zwj-sequences.txt': rgi,
};
let stale = false;
for (const [rel, content] of Object.entries(outputs)) {
  const path = join(root, rel);
  if (check) {
    const have = existsSync(path) ? readFileSync(path, 'utf8') : null;
    // The Go file is gofmt-formatted when checked in: compare it with the white space undone.
    const norm = (s) => (rel.endsWith('.go') ? s?.replace(/\s+/g, '') : s);
    if (norm(have) !== norm(content)) { console.error(`${rel} is not what the pinned inputs generate`); stale = true; }
  } else {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
}
if (check) {
  if (stale) process.exit(1);
  console.log(`profile-text tables are current (Unicode ${VERSION})`);
} else {
  console.log({ version: VERSION, viramas: viramas.length, defaultIgnorable: defaultIgnorable.length, whiteSpace: whiteSpace.length, marks: marks.length,
    unusable: unusable.length, extPict: extPict.length, emojiPres: emojiPres.length, emoji: emoji.length, mongolian: mongolianLetters.length,
    tagSeqs: tagSeqs.length, joining: joining.length, rgi: zwjSeqs.length });
}

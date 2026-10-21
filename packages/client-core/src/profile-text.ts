// Profile text (a display name, a status message, a bio, a device label): the client's mirror of internal/auth
// NormalizeUserText (internal/auth/profile_text.go has the rule in words). Pure, so the worker, the routes and the page share
// one rule. The tables are generated from the same Unicode version as the server's (scripts/gen-profile-text-tables.mjs).
import { EMOJI, EMOJI_PRESENTATION, EXT_PICT, JOINING, TAG_SEQUENCES, VIRAMA, type RuneRange } from './profile-tables';

const CONTROL = /\p{Cc}/u;
const TRANSPARENT = /^[\p{Mn}\p{Me}\p{Cf}]$/u;
const MARK_OR_SPACE = /^[\s\p{Mn}\p{Me}︀-️]*$/u;

export const DISPLAY_MAX_CHARS = 64;
export const STATUS_MAX_CHARS = 190;
export const BIO_MAX_CHARS = 500;

/** Why profile text is refused: more characters than the field allows, characters that cannot be shown, or nothing visible. */
export type ProfileTextProblem = 'long' | 'chars' | 'blank';

/** The characters refused wherever they stand: bidi controls, U+061C, line and paragraph separators and the invisible ones. */
function refused(cp: number): boolean {
  switch (cp) {
    case 0x00ad: case 0x034f: case 0x061c: case 0x115f: case 0x1160: case 0x180e: case 0x200b: case 0x200e: case 0x200f:
    case 0x2028: case 0x2029: case 0x2800: case 0x3164: case 0xfeff: case 0xffa0: return true;
    default: return (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2060 && cp <= 0x2064) || (cp >= 0x2066 && cp <= 0x206f) || (cp >= 0xfff9 && cp <= 0xfffb);
  }
}
function inRanges(cp: number, ranges: readonly RuneRange[]): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [from, to] = ranges[mid];
    if (cp < from) hi = mid - 1; else if (cp > to) lo = mid + 1; else return true;
  }
  return false;
}
/** Joining_Type: L, R, D, C or U from ArabicShaping.txt, T for the rest of Mn, Me and Cf. */
function joinType(cp: number): string {
  let lo = 0;
  let hi = JOINING.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [from, to, type] = JOINING[mid];
    if (cp < from) hi = mid - 1; else if (cp > to) lo = mid + 1; else return type;
  }
  return TRANSPARENT.test(String.fromCodePoint(cp)) ? 'T' : 'U';
}
const isVirama = (cp: number) => inRanges(cp, VIRAMA);

/** RFC 5892 Appendix A.1: (L|D) T* ZWNJ T* (R|D). */
function zwnjJoins(cps: readonly number[], i: number): boolean {
  let j = i - 1;
  while (j >= 0 && joinType(cps[j]) === 'T') j--;
  if (j < 0 || !'LD'.includes(joinType(cps[j]))) return false;
  let k = i + 1;
  while (k < cps.length && joinType(cps[k]) === 'T') k++;
  return k < cps.length && 'RD'.includes(joinType(cps[k]));
}
/** A ZWJ between two pictographs (see joinsEmoji in profile_text.go). */
function joinsEmoji(cps: readonly number[], i: number): boolean {
  if (i === 0 || i + 1 >= cps.length) return false;
  const b = cps[i - 1];
  const a = cps[i + 1];
  const before = (b >= 0x1f3fb && b <= 0x1f3ff) || inRanges(b, EMOJI_PRESENTATION) || (b === 0xfe0f && i >= 2 && inRanges(cps[i - 2], EXT_PICT));
  const after = inRanges(a, EMOJI_PRESENTATION) || (inRanges(a, EXT_PICT) && i + 2 < cps.length && cps[i + 2] === 0xfe0f);
  return before && after;
}

function isVariationSelector(cp: number): boolean { return (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef); }
/** The length of the RGI tag sequence that starts at cps[i], 0 when none does. */
function tagSequenceAt(cps: readonly number[], i: number): number {
  for (const seq of TAG_SEQUENCES) {
    if (i + seq.length <= cps.length && seq.every((cp, k) => cps[i + k] === cp)) return seq.length;
  }
  return 0;
}

function charsOk(cps: readonly number[], multiline: boolean): boolean {
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];
    if (cp === 0x0a) { if (!multiline) return false; continue; }
    if (CONTROL.test(String.fromCodePoint(cp)) || refused(cp) || (cp >= 0xe0020 && cp <= 0xe007f)) return false;
    if (cp === 0x1f3f4) {
      // A flag tag sequence from the RGI list (England, Scotland, Wales) is kept whole. Any other tag character is
      // refused above, so a run of tags cannot carry hidden text.
      const n = tagSequenceAt(cps, i);
      if (n > 0) i += n - 1;
    } else if (isVariationSelector(cp)) {
      // Only U+FE0E or U+FE0F, one per base, right after an Emoji code point; a stacked selector has no emoji before it.
      if ((cp !== 0xfe0e && cp !== 0xfe0f) || i === 0 || !inRanges(cps[i - 1], EMOJI)) return false;
    } else if (cp === 0x200c) {
      if (!(i > 0 && isVirama(cps[i - 1])) && !zwnjJoins(cps, i)) return false;
    } else if (cp === 0x200d) {
      if (!(i > 0 && isVirama(cps[i - 1])) && !joinsEmoji(cps, i)) return false;
    }
  }
  return true;
}

/** The text as it is sent and stored: NFC, CRLF as LF, trimmed. */
export function profileTextValue(v: string, multiline = false): string {
  return (multiline ? v.replace(/\r\n/gu, '\n') : v).normalize('NFC').trim();
}

/** Profile text as the instance checks it (the mirror of NormalizeUserText): at most `maxChars` characters (code points,
 *  after NFC), none of the refused characters, not nothing-visible; a bio (`multiline`) keeps its line breaks. null when it
 *  passes; "" passes and clears the field. */
export function profileTextProblem(v: unknown, maxChars: number, multiline = false): ProfileTextProblem | null {
  if (typeof v !== 'string') return 'chars';
  const text = (multiline ? v.replace(/\r\n/gu, '\n') : v).normalize('NFC');
  const cps = Array.from(text, (ch) => ch.codePointAt(0) ?? 0);
  if (cps.length > maxChars) return 'long';
  if (!charsOk(cps, multiline)) return 'chars';
  if (text !== '' && MARK_OR_SPACE.test(text.trim())) return 'blank';
  return null;
}

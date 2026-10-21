// Profile text (a display name, a status message, a bio): the client's mirror of internal/auth NormalizeUserText
// (internal/auth/profile_text.go has the rule in words). Pure, so the worker, the routes and the page share one rule.
// Every character property comes from the generated tables of one pinned Unicode version
// (scripts/gen-profile-text-tables.mjs), the server's too, not from the browser, so the two agree whatever the
// browser's Unicode version.
import {
  DEFAULT_IGNORABLE, EMOJI, EMOJI_PRESENTATION, EXT_PICT, JOINING, MARKS, MONGOLIAN_LETTERS, TAG_SEQUENCES, UNUSABLE, VIRAMA, WHITE_SPACE,
  type RuneRange,
} from './profile-tables';

export const DISPLAY_MAX_CHARS = 64;
export const STATUS_MAX_CHARS = 190;
export const BIO_MAX_CHARS = 500;
/** The most combining marks one base may carry; more is overlay ("zalgo") text. */
const MAX_MARK_RUN = 8;

/** Why profile text is refused: more characters than the field allows, characters that cannot be shown, or nothing visible. */
export type ProfileTextProblem = 'long' | 'chars' | 'blank';

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
/** Joining_Type: L, R, D, C or T from the generated table, U for every other code point. */
function joinType(cp: number): string {
  let lo = 0;
  let hi = JOINING.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [from, to, type] = JOINING[mid];
    if (cp < from) hi = mid - 1; else if (cp > to) lo = mid + 1; else return type;
  }
  return 'U';
}
const isVirama = (cp: number) => inRanges(cp, VIRAMA);
const isWhiteSpace = (cp: number) => inRanges(cp, WHITE_SPACE);
const codePoints = (s: string): number[] => Array.from(s, (ch) => ch.codePointAt(0) ?? 0);

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
/** The Default_Ignorable code points that may stand where they are, by context. */
function ignorableAllowed(cps: readonly number[], i: number): boolean {
  const cp = cps[i];
  const afterVirama = i > 0 && isVirama(cps[i - 1]);
  if (cp === 0x200c) return afterVirama || zwnjJoins(cps, i);
  if (cp === 0x200d) return afterVirama || joinsEmoji(cps, i);
  if (cp === 0xfe0e || cp === 0xfe0f) return i > 0 && inRanges(cps[i - 1], EMOJI); // one per base: a stack has no emoji before it
  if (cp === 0x180b || cp === 0x180c || cp === 0x180d || cp === 0x180f) return i > 0 && inRanges(cps[i - 1], MONGOLIAN_LETTERS);
  return false;
}
/** The length of the RGI tag sequence that starts at cps[i], 0 when none does. */
function tagSequenceAt(cps: readonly number[], i: number): number {
  for (const seq of TAG_SEQUENCES) {
    if (i + seq.length <= cps.length && seq.every((cp, k) => cps[i + k] === cp)) return seq.length;
  }
  return 0;
}
/** More than MAX_MARK_RUN combining marks in a row. */
function markRunTooLong(cps: readonly number[]): boolean {
  let run = 0;
  for (const cp of cps) {
    if (!inRanges(cp, MARKS)) run = 0;
    else if (++run > MAX_MARK_RUN) return true;
  }
  return false;
}

function charsOk(cps: readonly number[], multiline: boolean): boolean {
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];
    if (cp === 0x0a) { if (!multiline) return false; continue; }
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return false; // Cc
    if (inRanges(cp, UNUSABLE)) return false;
    if (cp === 0x2028 || cp === 0x2029 || cp === 0x2800 || (cp >= 0xfff9 && cp <= 0xfffb)) return false;
    if (cp === 0x1f3f4) {
      // A flag tag sequence from the RGI list (England, Scotland, Wales) is kept whole. Any other tag character is
      // Default_Ignorable and refused below, so a run of tags cannot carry hidden text.
      const n = tagSequenceAt(cps, i);
      if (n > 0) i += n - 1;
    } else if (inRanges(cp, DEFAULT_IGNORABLE) && !ignorableAllowed(cps, i)) return false;
  }
  return true;
}

function trimWhiteSpace(cps: number[]): number[] {
  let from = 0;
  let to = cps.length;
  while (from < to && isWhiteSpace(cps[from])) from++;
  while (to > from && isWhiteSpace(cps[to - 1])) to--;
  return cps.slice(from, to);
}
const hasLoneSurrogate = (s: string): boolean => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(s);

/** The text as it is sent and stored: NFC, CRLF as LF, trimmed (White_Space). */
export function profileTextValue(v: string, multiline = false): string {
  const text = (multiline ? v.replace(/\r\n/gu, '\n') : v).normalize('NFC');
  return String.fromCodePoint(...trimWhiteSpace(codePoints(text)));
}

/** Profile text as the instance checks it (the mirror of NormalizeUserText): valid UTF-16 (no lone surrogate), at most
 *  `maxChars` characters (code points, after NFC), none of the refused characters, not nothing-visible; a bio (`multiline`)
 *  keeps its line breaks. null when it passes; "" passes and clears the field. */
export function profileTextProblem(v: unknown, maxChars: number, multiline = false): ProfileTextProblem | null {
  if (typeof v !== 'string' || hasLoneSurrogate(v)) return 'chars';
  const typed = multiline ? v.replace(/\r\n/gu, '\n') : v;
  // The marks are counted as typed as well: NFC composes the first one into the base.
  if (markRunTooLong(codePoints(typed))) return 'chars';
  const cps = codePoints(typed.normalize('NFC'));
  if (cps.length > maxChars) return 'long';
  if (markRunTooLong(cps) || !charsOk(cps, multiline)) return 'chars';
  if (cps.length > 0 && !trimWhiteSpace(cps).some((cp) => !isWhiteSpace(cp) && !inRanges(cp, MARKS) && !inRanges(cp, DEFAULT_IGNORABLE))) return 'blank';
  return null;
}

// Profile text (a status message, a bio, a display name): the client's mirror of internal/auth NormalizeUserText. Pure, so
// the worker, the routes and the page share one rule.
const CONTROL = /\p{Cc}/u;
export const DISPLAY_MAX_CHARS = 64;
export const STATUS_MAX_CHARS = 190;
export const BIO_MAX_CHARS = 500;
// The characters the instance refuses in profile text (internal/auth NormalizeUserText), by code point: the bidi
// controls, U+061C, the zero-width characters (a U+200D joiner inside an emoji sequence is kept) and U+2028/2029.
const INVISIBLE = new Set([0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x061c,
  0x200b, 0x200c, 0x2060, 0xfeff, 0x2028, 0x2029]);
const PICTO_BEFORE = /^[\p{So}\p{Sk}\uFE0F]$/u;
const PICTO_AFTER = /^\p{So}$/u;
/** Why profile text is refused: more characters than the field allows, characters that cannot be shown, or only whitespace. */
export type ProfileTextProblem = 'long' | 'chars' | 'blank';
/** The text as it is sent and stored: NFC, CRLF as LF, trimmed. */
export function profileTextValue(v: string, multiline = false): string {
  return (multiline ? v.replace(/\r\n/gu, '\n') : v).normalize('NFC').trim();
}
/** Profile text as the instance checks it (the mirror of NormalizeUserText): at most `maxChars` characters (code points,
 *  after NFC), no control, bidi, zero-width or line-separator character, not only whitespace; a bio (`multiline`) keeps
 *  its line breaks. null when it passes; "" passes and clears the field. */
export function profileTextProblem(v: unknown, maxChars: number, multiline = false): ProfileTextProblem | null {
  if (typeof v !== 'string') return 'chars';
  const text = (multiline ? v.replace(/\r\n/gu, '\n') : v).normalize('NFC');
  const cps = [...text];
  if (cps.length > maxChars) return 'long';
  for (const [i, ch] of cps.entries()) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x200d) {
      if (i === 0 || i === cps.length - 1 || !PICTO_BEFORE.test(cps[i - 1]) || !PICTO_AFTER.test(cps[i + 1])) return 'chars';
    } else if (INVISIBLE.has(cp)) return 'chars';
    else if (CONTROL.test(ch) && !(multiline && ch === '\n')) return 'chars';
  }
  if (text !== '' && text.trim() === '') return 'blank';
  return null;
}

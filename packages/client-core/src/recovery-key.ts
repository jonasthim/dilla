/** Rust's recovery_key_normalise is authoritative; this copy supports the page's live count. */
export function normaliseRecoveryKey(text: string): string {
  let result = '';
  for (let i = 0; i < text.length; i++) {
    let character = text[i] ?? '';
    if (character === ' ' || character === '\t' || character === '\n' || character === '\r' ||
      character === '-' || character === '–' || character === '—') continue;
    const code = character.charCodeAt(0);
    if (code >= 0x61 && code <= 0x7a) character = String.fromCharCode(code - 0x20);
    if (character === 'I' || character === 'L') character = '1';
    else if (character === 'O') character = '0';
    result += character;
  }
  return result;
}

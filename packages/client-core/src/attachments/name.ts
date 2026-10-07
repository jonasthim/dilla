// A display name for a downloaded file, without path and bidi control characters.
export function safeName(name: string, fallback: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '')
    .replace(/[/\\]/g, '_').trim();
  const encoder = new TextEncoder();
  let out = '';
  let bytes = 0;
  for (const scalar of clean) {
    const size = encoder.encode(scalar).length;
    if (bytes + size > 255) break;
    out += scalar;
    bytes += size;
  }
  return out || fallback;
}

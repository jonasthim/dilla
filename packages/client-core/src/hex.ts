// Strict lower-case hex for ids in paths and state slices.
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new RangeError('E_HEX: odd length ' + hex.length);
  if (!/^[0-9a-f]*$/.test(hex)) throw new RangeError('E_HEX: not lower-case hex');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

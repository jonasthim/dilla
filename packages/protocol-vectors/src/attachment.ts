import { fromHex, hex, utf8 } from './bytes.ts';
import { sha256 } from './hmac.ts';

export const AAD_BLOB = 'dilla attachment v1';
export const AAD_THUMB = 'dilla thumb v1';
export const TAG_LEN = 16;
export const MAX_THUMB_PLAINTEXT = 8176;

export class AttachmentVectorError extends Error {
  readonly code: 'E_BLOB_HASH' | 'E_BLOB_OPEN' | 'E_ENVELOPE_LIMIT';
  constructor(code: AttachmentVectorError['code'], detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'AttachmentVectorError'; this.code = code;
  }
}

export function thumbNonce(nonce: Uint8Array): Uint8Array {
  if (nonce.length !== 12) throw new Error('nonce must be 12 bytes');
  const out = nonce.slice(); out[11]! ^= 0x01; return out;
}

async function gcm(key: Uint8Array, nonce: Uint8Array, aad: string, plaintext: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt']);
  return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: utf8(aad), tagLength: 128 }, k, plaintext));
}

async function ungcm(key: Uint8Array, nonce: Uint8Array, aad: string, data: Uint8Array): Promise<Uint8Array> {
  try {
    const k = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: utf8(aad), tagLength: 128 }, k, data));
  } catch { throw new AttachmentVectorError('E_BLOB_OPEN'); }
}

export function sealBlob(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  return gcm(key, nonce, AAD_BLOB, plaintext);
}
export function sealThumb(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  if (plaintext.length > MAX_THUMB_PLAINTEXT) return Promise.reject(new AttachmentVectorError('E_ENVELOPE_LIMIT', 'thumbnail plaintext over 8176 bytes'));
  return gcm(key, thumbNonce(nonce), AAD_THUMB, plaintext);
}
export async function openBlob(key: Uint8Array, nonce: Uint8Array, blobId: Uint8Array, size: number, stored: Uint8Array): Promise<Uint8Array> {
  if (hex(await sha256(stored)) !== hex(blobId)) throw new AttachmentVectorError('E_BLOB_HASH');
  if (stored.length < TAG_LEN) throw new AttachmentVectorError('E_BLOB_OPEN');
  const plain = await ungcm(key, nonce, AAD_BLOB, stored);
  if (plain.length !== size) throw new AttachmentVectorError('E_BLOB_OPEN');
  return plain;
}
export async function openThumb(key: Uint8Array, nonce: Uint8Array, thumb: Uint8Array): Promise<Uint8Array> {
  if (thumb.length < TAG_LEN) throw new AttachmentVectorError('E_BLOB_OPEN');
  return ungcm(key, thumbNonce(nonce), AAD_THUMB, thumb);
}

export interface AttachmentCase {
  name: string; key: Uint8Array; nonce: Uint8Array; plaintext: Uint8Array; size: number;
  stored: Uint8Array; blob_id: Uint8Array; thumb_nonce: Uint8Array;
  thumb_plaintext: Uint8Array | null; thumb: Uint8Array | null;
}

export async function attachmentVectors(): Promise<{ version: 1; description: string; aad_blob: Uint8Array; aad_thumb: Uint8Array; cases: AttachmentCase[]; rejects: Record<string, unknown>[] }> {
  const fill = (n: number, b: number) => new Uint8Array(n).fill(b);
  const inputs = [
    { name: 'empty file', key: fill(32, 0x51), nonce: fill(12, 0x52), plaintext: new Uint8Array(0), thumb_plaintext: null },
    { name: 'one byte', key: fill(32, 0x53), nonce: fill(12, 0x54), plaintext: new Uint8Array([0x2a]), thumb_plaintext: null },
    { name: 'a 1000-byte file with a thumbnail', key: fill(32, 0x55), nonce: fromHex('000102030405060708090a0b'), plaintext: Uint8Array.from({ length: 1000 }, (_, i) => i % 251), thumb_plaintext: fromHex('524946461200000057454250' + '00'.repeat(14)) },
    { name: 'a 300-byte file', key: fill(32, 0x57), nonce: fill(12, 0x58), plaintext: Uint8Array.from({ length: 300 }, (_, i) => (i * 7) % 256), thumb_plaintext: null },
  ];
  const cases: AttachmentCase[] = [];
  for (const input of inputs) {
    const { name, key, nonce, plaintext, thumb_plaintext } = input;
    const stored = await sealBlob(key, nonce, plaintext);
    cases.push({ name, key, nonce, plaintext, size: plaintext.length, stored, blob_id: await sha256(stored), thumb_nonce: thumbNonce(nonce), thumb_plaintext, thumb: thumb_plaintext === null ? null : await sealThumb(key, nonce, thumb_plaintext) });
  }
  const [, one, thousand] = cases as [AttachmentCase, AttachmentCase, AttachmentCase];
  const flipped = one.stored.slice(); flipped[flipped.length - 1]! ^= 0x01;
  const wrongId = one.blob_id.slice(); wrongId[0]! ^= 0x01;
  const wrongAad = await gcm(one.key, one.nonce, AAD_THUMB, one.plaintext);
  const wrongNonceThumb = await gcm(thousand.key, thousand.nonce, AAD_THUMB, thousand.thumb_plaintext!);
  const short = one.stored.slice(0, 15);
  const rejects: Record<string, unknown>[] = [
    { name: 'blob_id does not match', kind: 'blob', key: one.key, nonce: one.nonce, blob_id: wrongId, size: 1, data: one.stored, error: 'E_BLOB_HASH' },
    { name: 'tag bit flipped', kind: 'blob', key: one.key, nonce: one.nonce, blob_id: await sha256(flipped), size: 1, data: flipped, error: 'E_BLOB_OPEN' },
    { name: 'sealed under the thumbnail AAD', kind: 'blob', key: one.key, nonce: one.nonce, blob_id: await sha256(wrongAad), size: 1, data: wrongAad, error: 'E_BLOB_OPEN' },
    { name: 'size disagrees', kind: 'blob', key: one.key, nonce: one.nonce, blob_id: one.blob_id, size: 2, data: one.stored, error: 'E_BLOB_OPEN' },
    { name: "thumbnail sealed under the file's own nonce", kind: 'thumb', key: thousand.key, nonce: thousand.nonce, data: wrongNonceThumb, error: 'E_BLOB_OPEN' },
    { name: 'truncated below the tag', kind: 'blob', key: one.key, nonce: one.nonce, blob_id: await sha256(short), size: 1, data: short, error: 'E_BLOB_OPEN' },
  ];
  return { version: 1, description: 'protocol/04 § Attachments: AES-256-GCM, stored = ciphertext || 16-byte tag, blob_id = SHA-256(stored); thumb under the same key with nonce byte 11 XOR 0x01', aad_blob: utf8(AAD_BLOB), aad_thumb: utf8(AAD_THUMB), cases, rejects };
}

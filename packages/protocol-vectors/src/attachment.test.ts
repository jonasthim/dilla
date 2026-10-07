import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AAD_BLOB, AAD_THUMB, AttachmentVectorError, attachmentVectors, openBlob, openThumb, sealBlob, sealThumb, thumbNonce } from './attachment.ts';
import { sha256 } from './hmac.ts';
import { fromHex, hex, utf8 } from './bytes.ts';
import { VECTORS_DIR } from './generate.ts';

type Case = { name: string; key: string; nonce: string; plaintext: string; size: number; stored: string; blob_id: string;
  thumb_nonce: string; thumb_plaintext: string | null; thumb: string | null };
type Reject = { name: string; kind: 'blob' | 'thumb'; key: string; nonce: string; blob_id?: string; size?: number; data: string; error: string };
const file = JSON.parse(readFileSync(join(VECTORS_DIR, 'attachment.json'), 'utf8')) as {
  version: number; description: string; aad_blob: string; aad_thumb: string; cases: Case[]; rejects: Reject[];
};

async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; return 'accepted'; } catch (e) { if (e instanceof AttachmentVectorError) return e.code; throw e; }
}

describe('protocol/04 § Attachments (protocol/vectors/attachment.json)', () => {
  it('names the two AADs and the thumbnail nonce', () => {
    expect(AAD_BLOB).toBe('dilla attachment v1');
    expect(AAD_THUMB).toBe('dilla thumb v1');
    expect(file.aad_blob).toBe(hex(utf8('dilla attachment v1')));
    expect(file.aad_thumb).toBe(hex(utf8('dilla thumb v1')));
    expect(hex(thumbNonce(fromHex('000102030405060708090a0b')))).toBe('000102030405060708090a0a');
  });

  it('carries the four cases with their fixed inputs', () => {
    expect(file.version).toBe(1);
    expect(file.cases.map((c) => c.name)).toEqual(['empty file', 'one byte', 'a 1000-byte file with a thumbnail', 'a 300-byte file']);
    const [empty, one, thousand, last] = file.cases as [Case, Case, Case, Case];
    expect([empty.key, empty.nonce, empty.plaintext, empty.size]).toEqual(['51'.repeat(32), '52'.repeat(12), '', 0]);
    expect([one.key, one.nonce, one.plaintext, one.size]).toEqual(['53'.repeat(32), '54'.repeat(12), '2a', 1]);
    expect([thousand.key, thousand.nonce, thousand.size]).toEqual(['55'.repeat(32), '000102030405060708090a0b', 1000]);
    expect(thousand.plaintext).toBe(hex(Uint8Array.from({ length: 1000 }, (_, i) => i % 251)));
    expect(thousand.thumb_plaintext).toBe('52494646' + '12000000' + '57454250' + '00'.repeat(14));
    expect([last.key, last.nonce, last.size]).toEqual(['57'.repeat(32), '58'.repeat(12), 300]);
    expect(last.plaintext).toBe(hex(Uint8Array.from({ length: 300 }, (_, i) => (i * 7) % 256)));
    for (const c of [empty, one, last]) expect([c.thumb_plaintext, c.thumb], c.name).toEqual([null, null]);
  });

  it('reproduces every case: stored = ct || tag, blob_id = SHA-256(stored), both openings', async () => {
    for (const c of file.cases) {
      const key = fromHex(c.key); const nonce = fromHex(c.nonce); const plain = fromHex(c.plaintext);
      const stored = await sealBlob(key, nonce, plain);
      expect(hex(stored), c.name).toBe(c.stored);
      expect(stored.length, c.name).toBe(plain.length + 16);
      expect(hex(await sha256(stored)), c.name).toBe(c.blob_id);
      expect(hex(await openBlob(key, nonce, fromHex(c.blob_id), c.size, fromHex(c.stored))), c.name).toBe(c.plaintext);
      expect(c.thumb_nonce, c.name).toBe(hex(thumbNonce(nonce)));
      if (c.thumb_plaintext !== null && c.thumb !== null) {
        expect(hex(await sealThumb(key, nonce, fromHex(c.thumb_plaintext))), c.name).toBe(c.thumb);
        expect(hex(await openThumb(key, nonce, fromHex(c.thumb))), c.name).toBe(c.thumb_plaintext);
      }
    }
  });

  it('refuses every reject with its code', async () => {
    expect(file.rejects.map((r) => [r.name, r.kind, r.error])).toEqual([
      ['blob_id does not match', 'blob', 'E_BLOB_HASH'],
      ['tag bit flipped', 'blob', 'E_BLOB_OPEN'],
      ['sealed under the thumbnail AAD', 'blob', 'E_BLOB_OPEN'],
      ['size disagrees', 'blob', 'E_BLOB_OPEN'],
      ["thumbnail sealed under the file's own nonce", 'thumb', 'E_BLOB_OPEN'],
      ['truncated below the tag', 'blob', 'E_BLOB_OPEN'],
    ]);
    for (const r of file.rejects) {
      const key = fromHex(r.key); const nonce = fromHex(r.nonce); const data = fromHex(r.data);
      const got = r.kind === 'blob'
        ? await codeOf(openBlob(key, nonce, fromHex(r.blob_id ?? ''), r.size ?? -1, data))
        : await codeOf(openThumb(key, nonce, data));
      expect(got, r.name).toBe(r.error);
      expect('blob_id' in r && 'size' in r, r.name).toBe(r.kind === 'blob');
    }
  });

  it('bounds the thumbnail plaintext so the sealed thumbnail fits the envelope', async () => {
    const key = new Uint8Array(32).fill(7); const nonce = new Uint8Array(12).fill(9);
    expect((await sealThumb(key, nonce, new Uint8Array(8176))).length).toBe(8192);
    await expect(sealThumb(key, nonce, new Uint8Array(8177))).rejects.toThrowError(/E_ENVELOPE_LIMIT/);
  });

  it('is deterministic', async () => {
    const j = (o: unknown) => JSON.stringify(o, (_, v) => v instanceof Uint8Array ? hex(v) : v);
    expect(j(await attachmentVectors())).toBe(j(await attachmentVectors()));
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { AttachmentDescriptor } from '../core-port';
import { DillaHttpError } from '../http/errors';
import { BROWSER_ATTACHMENT_CAP, sealBlob, sealThumb } from './crypto';
import { fetchAttachment, thumbnailBlob } from './download';

const CHANNEL = new Uint8Array(16).fill(0xc1);
const KEY = new Uint8Array(32).fill(0x71);
const NONCE = new Uint8Array(12).fill(0x72);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x12, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1, 2]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9]);

async function sealed(plain: Uint8Array, mime: string): Promise<{ d: AttachmentDescriptor; stored: Uint8Array }> {
  const { stored, blobId } = await sealBlob(KEY, NONCE, plain);
  return { d: { blobId, key: KEY, nonce: NONCE, size: plain.length, mime, w: null, h: null, thumb: null, name: 'f' }, stored };
}

describe('fetchAttachment and thumbnailBlob (L-TS-32)', () => {
  it('opens the stored bytes into a Blob typed by an allowed image MIME', async () => {
    const { d, stored } = await sealed(new Uint8Array([1, 2, 3]), 'image/png');
    const getBlob = vi.fn(() => Promise.resolve(stored));
    const blob = await fetchAttachment({ getBlob }, CHANNEL, d);
    expect(getBlob).toHaveBeenCalledWith(CHANNEL, d.blobId, d.size + 16);
    expect(blob.type).toBe('image/png');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('types anything else as application/octet-stream', async () => {
    const { d, stored } = await sealed(new Uint8Array([4]), 'image/svg+xml');
    expect((await fetchAttachment({ getBlob: () => Promise.resolve(stored) }, CHANNEL, d)).type).toBe('application/octet-stream');
  });

  it('answers E_ATTACHMENT_MISSING for a 404 and E_BLOB_HASH for bytes that are not the named ones', async () => {
    const { d, stored } = await sealed(new Uint8Array([5]), 'text/plain');
    await expect(fetchAttachment({ getBlob: () => Promise.resolve(null) }, CHANNEL, d)).rejects.toMatchObject({ code: 'E_ATTACHMENT_MISSING' });
    const tampered = stored.slice();
    tampered[0] ^= 1;
    await expect(fetchAttachment({ getBlob: () => Promise.resolve(tampered) }, CHANNEL, d)).rejects.toMatchObject({ code: 'E_BLOB_HASH' });
  });

  it('refuses a descriptor over the browser cap before any request', async () => {
    const { d } = await sealed(new Uint8Array([6]), 'text/plain');
    const getBlob = vi.fn(() => Promise.resolve(null));
    await expect(fetchAttachment({ getBlob }, CHANNEL, { ...d, size: BROWSER_ATTACHMENT_CAP + 1 })).rejects.toMatchObject({ code: 'E_ATTACHMENT_TOO_LARGE' });
    expect(getBlob).not.toHaveBeenCalled();
  });

  it('refuses a stored object longer than its descriptor before hashing (FACTS-SECURITY-13)', async () => {
    const { d } = await sealed(new Uint8Array([8]), 'text/plain');
    const getBlob = vi.fn(() => Promise.reject(new DillaHttpError({ status: 200, code: 'E_BODY_TOO_LARGE', detail: '', retryAfterMs: null, extra: [] })));
    await expect(fetchAttachment({ getBlob }, CHANNEL, d)).rejects.toMatchObject({ code: 'E_BLOB_OPEN' });
    expect(getBlob).toHaveBeenCalledWith(CHANNEL, d.blobId, d.size + 16);
  });

  it('types a thumbnail by its signature and refuses one with any other', async () => {
    const base = (await sealed(new Uint8Array([7]), 'image/png')).d;
    const webp = await thumbnailBlob({ ...base, thumb: await sealThumb(KEY, NONCE, WEBP) });
    expect(webp.type).toBe('image/webp');
    expect(new Uint8Array(await webp.arrayBuffer())).toEqual(WEBP);
    expect((await thumbnailBlob({ ...base, thumb: await sealThumb(KEY, NONCE, JPEG) })).type).toBe('image/jpeg');
    await expect(thumbnailBlob({ ...base, thumb: await sealThumb(KEY, NONCE, new Uint8Array([0x3c, 0x73, 0x76, 0x67])) })).rejects.toMatchObject({ code: 'E_BLOB_OPEN' });
    await expect(thumbnailBlob(base)).rejects.toMatchObject({ code: 'E_ATTACHMENT_MISSING' });
  });
});

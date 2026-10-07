// Attachment fetches remain bounded by the descriptor's sealed size.
import type { AttachmentDescriptor, Id } from '../core-port';
import type { Routes } from '../http/routes';
import { DillaHttpError } from '../http/errors';
import { AttachmentError, BROWSER_ATTACHMENT_CAP, openBlob, openThumb } from './crypto';
import { isThumbnailBytes, RENDERABLE_IMAGE } from './thumb';

export async function fetchAttachment(routes: Pick<Routes, 'getBlob'>, channelId: Id, d: AttachmentDescriptor): Promise<Blob> {
  if (d.size > BROWSER_ATTACHMENT_CAP) throw new AttachmentError('E_ATTACHMENT_TOO_LARGE');
  let stored: Uint8Array | null;
  try { stored = await routes.getBlob(channelId, d.blobId, d.size + 16); }
  catch (e) {
    if (e instanceof DillaHttpError && e.code === 'E_BODY_TOO_LARGE') {
      throw new AttachmentError('E_BLOB_OPEN', 'the stored object is larger than its descriptor');
    }
    throw e;
  }
  if (stored === null) throw new AttachmentError('E_ATTACHMENT_MISSING');
  // openBlob answers a fresh ArrayBuffer-backed view; the cast only names that, so the plaintext is not copied again.
  const plain = (await openBlob(d, stored)) as Uint8Array<ArrayBuffer>;
  return new Blob([plain], { type: RENDERABLE_IMAGE.includes(d.mime) ? d.mime : 'application/octet-stream' });
}
export async function thumbnailBlob(d: AttachmentDescriptor): Promise<Blob> {
  if (d.thumb === null) throw new AttachmentError('E_ATTACHMENT_MISSING');
  const plain = (await openThumb(d.key, d.nonce, d.thumb)) as Uint8Array<ArrayBuffer>;
  if (!isThumbnailBytes(plain)) throw new AttachmentError('E_BLOB_OPEN');
  const type = plain[0] === 0x52 ? 'image/webp' : 'image/jpeg';
  return new Blob([plain], { type });
}

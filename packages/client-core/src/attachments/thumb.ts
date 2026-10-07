// Bounded image preview creation with injected browser image APIs.
import { MAX_THUMB_PLAINTEXT } from './crypto';

export interface ThumbDeps { createImageBitmap(b: Blob): Promise<ImageBitmap>; offscreen(w: number, h: number): OffscreenCanvas; }
export interface Thumbnail { bytes: Uint8Array | null; type: 'image/webp' | 'image/jpeg' | null; w: number; h: number; }
export const RENDERABLE_IMAGE: readonly string[] = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const SIDES = [320, 240, 160, 120];
const QUALITIES = [0.8, 0.6, 0.4, 0.25];

export async function makeThumbnail(file: Blob, deps: ThumbDeps): Promise<Thumbnail | null> {
  let bitmap: ImageBitmap;
  try { bitmap = await deps.createImageBitmap(file); }
  catch { return null; }
  const w = bitmap.width;
  const h = bitmap.height;
  try {
    let webp = true;
    for (const side of SIDES) {
      const scale = Math.min(1, side / Math.max(w, h));
      const tw = Math.max(1, Math.round(w * scale));
      const th = Math.max(1, Math.round(h * scale));
      const canvas = deps.offscreen(tw, th);
      const ctx = canvas.getContext('2d');
      // No 2d context: no size can be drawn, so nothing fits.
      if (!ctx) break;
      ctx.drawImage(bitmap, 0, 0, tw, th);
      if (webp) {
        for (const quality of QUALITIES) {
          const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
          if (blob.type !== 'image/webp') { webp = false; break; }
          if (blob.size <= MAX_THUMB_PLAINTEXT) return { bytes: new Uint8Array(await blob.arrayBuffer()), type: 'image/webp', w, h };
        }
      }
      if (!webp) {
        for (const quality of QUALITIES) {
          const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
          if (blob.type === 'image/jpeg' && blob.size <= MAX_THUMB_PLAINTEXT) {
            return { bytes: new Uint8Array(await blob.arrayBuffer()), type: 'image/jpeg', w, h };
          }
        }
      }
    }
    return { bytes: null, type: null, w, h };
  } finally { bitmap.close(); }
}

export function isThumbnailBytes(b: Uint8Array): boolean {
  return (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) ||
    (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff);
}

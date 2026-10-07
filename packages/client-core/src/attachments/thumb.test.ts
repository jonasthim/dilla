import { describe, expect, it } from 'vitest';
import { RENDERABLE_IMAGE, isThumbnailBytes, makeThumbnail, type ThumbDeps } from './thumb';

interface Encoded { type: string; size: number; }
interface Call { w: number; h: number; type: string; quality: number; }

/** Injected decoders: a bitmap of the given size (or a decode failure), canvases that record every encode, an encoder script. */
function fake(opts: { width: number; height: number; fail?: boolean; encode(type: string, quality: number, w: number, h: number): Encoded }) {
  const calls: Call[] = [];
  const canvases: { w: number; h: number }[] = [];
  const state = { closed: 0 };
  const deps: ThumbDeps = {
    createImageBitmap: () => opts.fail === true
      ? Promise.reject(new DOMException('cannot decode', 'InvalidStateError'))
      : Promise.resolve({ width: opts.width, height: opts.height, close: () => { state.closed += 1; } } as unknown as ImageBitmap),
    offscreen: (w, h) => {
      canvases.push({ w, h });
      return {
        width: w, height: h,
        getContext: () => ({ drawImage: () => undefined }),
        convertToBlob: (o?: { type?: string; quality?: number }) => {
          const type = o?.type ?? 'image/png';
          const quality = o?.quality ?? 1;
          calls.push({ w, h, type, quality });
          const r = opts.encode(type, quality, w, h);
          return Promise.resolve(new Blob([new Uint8Array(r.size)], { type: r.type }));
        },
      } as unknown as OffscreenCanvas;
    },
  };
  return { deps, calls, canvases, state };
}
const FILE = new Blob([new Uint8Array(10)], { type: 'image/png' });

describe('makeThumbnail (Q17, ruling 16)', () => {
  it('scales the longest side to 320 and keeps the first WebP that fits', async () => {
    const f = fake({ width: 640, height: 480, encode: (type) => ({ type, size: 5000 }) });
    const t = await makeThumbnail(FILE, f.deps);
    expect(t).toMatchObject({ type: 'image/webp', w: 640, h: 480 });
    expect(t?.bytes?.length).toBe(5000);
    expect(f.canvases).toEqual([{ w: 320, h: 240 }]);
    expect(f.calls).toEqual([{ w: 320, h: 240, type: 'image/webp', quality: 0.8 }]);
    expect(f.state.closed).toBe(1);
  });

  it('never scales up and keeps a portrait within 320', async () => {
    const small = fake({ width: 100, height: 50, encode: (type) => ({ type, size: 100 }) });
    await makeThumbnail(FILE, small.deps);
    expect(small.canvases).toEqual([{ w: 100, h: 50 }]);
    const tall = fake({ width: 300, height: 1200, encode: (type) => ({ type, size: 100 }) });
    await makeThumbnail(FILE, tall.deps);
    expect(tall.canvases).toEqual([{ w: 80, h: 320 }]);
  });

  it('lowers the quality until the WebP fits 8 176 bytes, inclusive', async () => {
    const sizes = new Map([[0.8, 9000], [0.6, 8177], [0.4, 8176]]);
    const f = fake({ width: 640, height: 480, encode: (type, q) => ({ type, size: sizes.get(q) ?? 1 }) });
    const t = await makeThumbnail(FILE, f.deps);
    expect(t?.bytes?.length).toBe(8176);
    expect(f.calls.map((c) => c.quality)).toEqual([0.8, 0.6, 0.4]);
  });

  it('falls back to JPEG when the encoder silently answers PNG for WebP (X2)', async () => {
    const f = fake({ width: 640, height: 480, encode: (type) => ({ type: type === 'image/webp' ? 'image/png' : type, size: 3000 }) });
    const t = await makeThumbnail(FILE, f.deps);
    expect(t).toMatchObject({ type: 'image/jpeg', w: 640, h: 480 });
    expect(f.calls.map((c) => [c.type, c.quality])).toEqual([['image/webp', 0.8], ['image/jpeg', 0.8]]);
  });

  it('steps down 320, 240, 160 when no quality fits', async () => {
    const f = fake({ width: 640, height: 480, encode: (type, _q, w) => ({ type, size: w > 160 ? 9000 : 4000 }) });
    const t = await makeThumbnail(FILE, f.deps);
    expect(t?.bytes?.length).toBe(4000);
    expect(f.canvases).toEqual([{ w: 320, h: 240 }, { w: 240, h: 180 }, { w: 160, h: 120 }]);
    expect(f.calls).toHaveLength(9);
  });

  it('answers no bytes and the original size when nothing fits, and closes the bitmap', async () => {
    const f = fake({ width: 640, height: 480, encode: (type) => ({ type, size: 9000 }) });
    expect(await makeThumbnail(FILE, f.deps)).toEqual({ bytes: null, type: null, w: 640, h: 480 });
    expect(f.canvases.map((c) => c.w)).toEqual([320, 240, 160, 120]);
    expect(f.calls).toHaveLength(16);
    expect(f.state.closed).toBe(1);
  });

  it('answers null for a file that does not decode as an image', async () => {
    const f = fake({ width: 1, height: 1, fail: true, encode: (type) => ({ type, size: 1 }) });
    expect(await makeThumbnail(FILE, f.deps)).toBeNull();
    expect(f.canvases).toEqual([]);
  });
});

describe('thumbnail signatures and renderable types (ruling 15)', () => {
  it('recognises WebP and JPEG only', () => {
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x12, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    expect(isThumbnailBytes(webp)).toBe(true);
    expect(isThumbnailBytes(webp.slice(0, 11))).toBe(false);
    expect(isThumbnailBytes(new Uint8Array([0xff, 0xd8, 0xff]))).toBe(true);
    expect(isThumbnailBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))).toBe(false);
    expect(isThumbnailBytes(new Uint8Array([0x3c, 0x73, 0x76, 0x67]))).toBe(false);
  });

  it('renders four image types and nothing else', () => {
    expect(RENDERABLE_IMAGE).toEqual(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
    expect(RENDERABLE_IMAGE.includes('image/svg+xml')).toBe(false);
    expect(Object.isFrozen(RENDERABLE_IMAGE)).toBe(true);
  });
});

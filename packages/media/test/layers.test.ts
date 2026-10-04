import { describe, expect, it } from 'vitest';
import { LayerAllocator, MAX_LAYERS } from '../src/worker/layers';

describe('CTR layer allocation (G8)', () => {
  it('allocates first-seen layers 0..15 per (KID, slot) and keeps a key on its layer', () => {
    const a = new LayerAllocator();
    expect(a.layerFor(0x329n, 1, 1111, 0)).toBe(0);
    expect(a.layerFor(0x329n, 1, 2222, 0)).toBe(1);
    expect(a.layerFor(0x329n, 1, 3333, 0)).toBe(2);
    expect(a.layerFor(0x329n, 1, 2222, 0)).toBe(1);
  });

  it('tells SVC spatial layers on one SSRC apart', () => {
    const a = new LayerAllocator();
    expect([0, 1, 2].map((s) => a.layerFor(7n, 1, 9, s))).toEqual([0, 1, 2]);
  });

  it('refuses the 17th key and a frame without an SSRC', () => {
    const a = new LayerAllocator();
    for (let i = 0; i < MAX_LAYERS; i++) expect(a.layerFor(7n, 2, 100 + i, 0)).toBe(i);
    expect(a.layerFor(7n, 2, 999, 0)).toBeNull();
    expect(a.layerFor(7n, 2, undefined, 0)).toBeNull();
  });

  it('keeps scopes independent per KID and per slot', () => {
    const a = new LayerAllocator();
    expect(a.layerFor(7n, 1, 5, 0)).toBe(0);
    expect(a.layerFor(7n, 2, 6, 0)).toBe(0);
    expect(a.layerFor(8n, 1, 6, 0)).toBe(0);
  });
});

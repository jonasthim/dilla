import type { SlotId } from '../protocol';

// The 4-bit CTR layer (gap G8): getMetadata() has no rid. Simulcast encodings differ by synchronizationSource
// (spatialIndex is 0 on all of them); SVC layers share one SSRC and differ by spatialIndex. So the key
// `${ssrc}:${spatialIndex}` identifies a layer, allocated first-seen 0..15 per (KID, slot), never reused within
// a KID. A 17th key or a frame without an SSRC is dropped and an MLS Update is asked for instead of guessing.

export const MAX_LAYERS = 16;

export class LayerAllocator {
  private readonly scopes = new Map<string, Map<string, number>>();

  layerFor(kid: bigint, slot: SlotId, ssrc: number | undefined, spatialIndex: number | undefined): number | null {
    if (ssrc === undefined) return null;
    const scopeKey = `${kid.toString(16)}:${slot}`;
    let scope = this.scopes.get(scopeKey);
    if (scope === undefined) {
      scope = new Map();
      this.scopes.set(scopeKey, scope);
    }
    const key = `${ssrc}:${spatialIndex ?? 0}`;
    const have = scope.get(key);
    if (have !== undefined) return have;
    if (scope.size >= MAX_LAYERS) return null;
    const layer = scope.size;
    scope.set(key, layer);
    return layer;
  }
}

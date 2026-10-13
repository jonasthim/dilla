// L-WEB-51: the only way into the call code. The session imports @dilla/media, so livekit-client and RNNoise reach
// the page through this dynamic import alone and stay out of the entry chunk (scripts/check-entry-chunk.mjs gates
// every build). Nothing else may import the call code statically.
export type CallModule = typeof import('./session.ts');

export function loadCallModule(): Promise<CallModule> {
  return import('./session.ts');
}

// L-WEB-51: the only way into the call code. livekit-client and RNNoise reach the page through this dynamic import
// alone, so they stay out of the entry chunk (scripts/check-entry-chunk.mjs gates every build). Nothing else may
// import the call code statically.
// Task 8a loads @dilla/media itself; task 8b points this at ./session.ts, which imports it.
export type CallModule = typeof import('@dilla/media');

export function loadCallModule(): Promise<CallModule> {
  return import('@dilla/media');
}

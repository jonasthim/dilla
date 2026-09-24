import { probe_persistence } from '../pkg/dilla_core_wasm.js';

export interface Persistence {
  mode: 'opfs' | 'memory';
  reason: string;
  elapsedMs: number;
}

/**
 * gap-15 §6: a functional probe, run in the dedicated worker BEFORE install(), so a `memory` boot
 * never leaves a half-created pool behind. Presence checks are useless here — Firefox and Safari
 * private browsing expose the full API and only fail the call.
 */
export async function probePersistence(): Promise<Persistence> {
  const started = performance.now();
  const raw = JSON.parse(await probe_persistence()) as { mode: 'opfs' | 'memory'; reason?: string };
  return { mode: raw.mode, reason: raw.reason ?? '', elapsedMs: performance.now() - started };
}

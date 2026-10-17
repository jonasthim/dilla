import { noiseBuildMode } from './noise-preference';
import type { EnhancedOptions, InnerProcessor } from './microphone';
/** Vite removes the disabled branch, including its Worker and all model assets. */
export async function createEnhanced(options: EnhancedOptions): Promise<InnerProcessor | null> {
  if (noiseBuildMode === 'disabled') return null;
  const { DillaDeepFilterProcessor } = await import('./deepfilter');
  return new DillaDeepFilterProcessor(options);
}

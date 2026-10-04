import init, { MediaReceiver, MediaSender } from '../../wasm/dilla_core_wasm.js';
import type { CryptoFactory } from './pipeline';

/** One wasm-pack build carries the media classes (MD-4); the worker loads it once, from the URL `init` gave. */
export async function loadCrypto(wasmUrl: string): Promise<CryptoFactory> {
  await init({ module_or_path: wasmUrl });
  return {
    newSender: (baseKey, leafIndex, epoch, minEpoch) => new MediaSender(baseKey, leafIndex, epoch, minEpoch),
    newReceiver: () => new MediaReceiver(),
  };
}

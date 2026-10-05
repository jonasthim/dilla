/** Type-only checks of the generated WASM surface. The WASM build must precede typechecking. */
import type { CoreHandle as Generated } from '@dilla/core-wasm';
import type { CoreHandle, CoreWasmModule } from './core-port';
export const handleConforms: Generated extends CoreHandle ? true : never = true;
export const moduleConforms: typeof import('@dilla/core-wasm') extends CoreWasmModule ? true : never = true;

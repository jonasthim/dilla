declare const __DILLA_NOISE_MODE__: 'disabled' | 'evaluation' | 'qualified';
export const noiseBuildMode = typeof __DILLA_NOISE_MODE__ === 'undefined' ? 'disabled' : __DILLA_NOISE_MODE__;
export type NoisePreference = 'automatic' | 'lightweight' | 'off';
/** Preserve explicit choices; migrate the legacy default only in a qualified build. */
export function noisePreference(value: string | undefined): NoisePreference {
  if (value === 'automatic' || value === 'off' || value === 'lightweight') return value;
  return noiseBuildMode === 'qualified' ? 'automatic' : 'lightweight';
}

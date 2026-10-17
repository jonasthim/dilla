import {afterEach,expect,it,vi} from 'vitest';
afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();});
it.each(['disabled','evaluation','beta','qualified'])('%s preserves explicit Off and Lightweight preferences',async mode=>{
  vi.stubGlobal('__DILLA_NOISE_MODE__',mode);vi.resetModules();
  const {noisePreference}=await import('../src/audio/noise-preference');
  expect(noisePreference('off')).toBe('off');expect(noisePreference('lightweight')).toBe('lightweight');
  expect(noisePreference('automatic')).toBe('automatic');
  expect(noisePreference('on')).toBe(mode==='qualified'?'automatic':'lightweight');
  expect(noisePreference(undefined)).toBe(mode==='qualified'?'automatic':'lightweight');
});

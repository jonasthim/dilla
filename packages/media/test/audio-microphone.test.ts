import { expect, it, vi } from 'vitest';
import { Track, type AudioProcessorOptions } from 'livekit-client';
import { DillaMicrophoneProcessor, noisePreference, setBrowserSuppression } from '../src/audio/microphone';
function input() {
  let noise=true;
  return {enabled:true, clone:()=>({enabled:true,stop(){}}), getSettings:()=>({noiseSuppression:noise}), getConstraints:()=>({echoCancellation:true,autoGainControl:true}), applyConstraints:vi.fn(async (c:MediaTrackConstraints)=>{noise=c.noiseSuppression===true;})} as unknown as MediaStreamTrack;
}
it('preserves Off and keeps legacy On on lightweight until qualification', () => {
  expect(noisePreference('off')).toBe('off'); expect(noisePreference('on')).toBe('lightweight'); expect(noisePreference(undefined)).toBe('lightweight'); expect(noisePreference('automatic')).toBe('automatic');
});
it('disables browser suppression only after the neural processor is ready', async () => {
  const track=input(); let ready!:()=>void;
  const inner={name:'test', processedTrack:track, init:()=>new Promise<void>(r=>{ready=r;}),destroy:vi.fn(async()=>{}),restart:vi.fn(async()=>{}),setPttActive:vi.fn(),setCaptureAllowed:vi.fn(),setMode:vi.fn()};
  const p=new DillaMicrophoneProcessor({preference:'automatic',createLightweight:()=>inner});
  const init=p.init({track,kind:Track.Kind.Audio} as AudioProcessorOptions);
  expect(track.getSettings().noiseSuppression).toBe(true);
  ready(); await init;
  expect(track.getSettings().noiseSuppression).toBe(false);
  expect(p.status).toMatchObject({effective:'rnnoise',reason:'not-qualified'});
  p.setCaptureAllowed(false); expect(inner.setCaptureAllowed).toHaveBeenLastCalledWith(false);
  await p.destroy();
});
it('restores browser suppression and reports initialization failure', async () => {
  const track=input();
  const p=new DillaMicrophoneProcessor({preference:'lightweight',createLightweight:()=>({name:'test',init:async()=>{throw Error('failed')},restart:async()=>{},destroy:async()=>{},setPttActive:()=>{}})});
  await p.init({track,kind:Track.Kind.Audio} as AudioProcessorOptions);
  expect(p.status).toMatchObject({effective:'browser',reason:'initialization-failed',browserNoise:'on'});
  expect(track.getSettings().noiseSuppression).toBe(true);
});
it('Off requests no browser suppression and uses a detector without denoising', async () => {
  const track=input(); let denoise:boolean|undefined;
  const p=new DillaMicrophoneProcessor({preference:'off',createLightweight:o=>{denoise=o.denoise; return {name:'test',processedTrack:track,init:async()=>{},restart:async()=>{},destroy:async()=>{},setPttActive:()=>{}};}});
  await p.init({track,kind:Track.Kind.Audio} as AudioProcessorOptions);
  expect(denoise).toBe(false); expect(track.getSettings().noiseSuppression).toBe(false); expect(p.status.effective).toBe('off');
});
it('does not claim suppression was disabled when the browser ignores the constraint', async () => {
  const track=input(); track.applyConstraints=async()=>{};
  expect(await setBrowserSuppression(track,false)).toBe('on');
});
it('browser fallback gives LiveKit an owned clone, so replacing the processor cannot stop microphone capture', async () => {
  const track=input(), clone={enabled:true,stop:vi.fn()} as unknown as MediaStreamTrack;
  track.clone=()=>clone;
  const p=new DillaMicrophoneProcessor({preference:'lightweight',createLightweight:()=>({name:'test',init:async()=>{throw Error('failed')},restart:async()=>{},destroy:async()=>{},setPttActive:()=>{}})});
  await p.init({track,kind:Track.Kind.Audio} as AudioProcessorOptions);
  expect(p.processedTrack).toBe(clone);
  expect(p.processedTrack).not.toBe(track);
  await p.destroy();expect(clone.stop).toHaveBeenCalled();
});
it('reopens the same device when Chromium fixes suppression for the lifetime of a capture',async()=>{
  const track=input();track.applyConstraints=async()=>{};track.getSettings=()=>({noiseSuppression:true,deviceId:'chosen-mic'});
  const fresh=input();fresh.getSettings=()=>({noiseSuppression:false,deviceId:'chosen-mic'});fresh.stop=vi.fn();
  const getUserMedia=vi.fn(async()=>({getAudioTracks:()=>[fresh],getTracks:()=>[fresh]}));
  vi.stubGlobal('navigator',{mediaDevices:{getUserMedia}});
  const inner={name:'test',processedTrack:input(),init:async()=>{},restart:vi.fn(async()=>{}),destroy:async()=>{},setPttActive:()=>{}};
  try {
    const p=new DillaMicrophoneProcessor({preference:'lightweight',createLightweight:()=>inner});
    await p.init({track,kind:Track.Kind.Audio} as AudioProcessorOptions);
    expect(p.status).toMatchObject({effective:'rnnoise',browserNoise:'off'});
    expect(getUserMedia).toHaveBeenCalledWith({audio:expect.objectContaining({deviceId:{exact:'chosen-mic'},noiseSuppression:false,echoCancellation:true,autoGainControl:true})});
    expect(inner.restart).toHaveBeenCalledWith(expect.objectContaining({track:fresh}));
    p.setCaptureAllowed(false);expect(fresh.enabled).toBe(false);
    await p.destroy();expect(fresh.stop).toHaveBeenCalled();
  }finally{vi.unstubAllGlobals();}
});
it('disposes a late replacement capture after teardown',async()=>{
  const track=input();track.applyConstraints=async()=>{};track.getSettings=()=>({noiseSuppression:true,deviceId:'chosen'});
  const fresh=input();fresh.stop=vi.fn();let grant!:(s:unknown)=>void;
  vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:()=>new Promise(r=>{grant=r;})}});
  try {
    const p=new DillaMicrophoneProcessor({preference:'lightweight',createLightweight:()=>({name:'test',processedTrack:input(),init:async()=>{},restart:async()=>{},destroy:async()=>{},setPttActive:()=>{}})});
    const init=p.init({track,kind:Track.Kind.Audio} as AudioProcessorOptions);
    await vi.waitFor(()=>expect(grant).toBeTypeOf('function'));
    await p.destroy();grant({getAudioTracks:()=>[fresh],getTracks:()=>[fresh]});await init;
    expect(fresh.stop).toHaveBeenCalled();expect(p.processedTrack).toBeUndefined();
  }finally{vi.unstubAllGlobals();}
});

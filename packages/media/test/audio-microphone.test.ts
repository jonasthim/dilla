import { expect, it, vi } from 'vitest';
import { Track, type AudioProcessorOptions } from 'livekit-client';
import { DillaMicrophoneProcessor, noisePreference, setBrowserSuppression } from '../src/audio/microphone';
function input() {
  let noise=true;
  return {enabled:true, clone:()=>({enabled:true,stop(){}}), getSettings:()=>({noiseSuppression:noise}), getConstraints:()=>({echoCancellation:true,autoGainControl:true}), applyConstraints:vi.fn(async (c:MediaTrackConstraints)=>{noise=c.noiseSuppression===true;})} as unknown as MediaStreamTrack;
}
it('shares teardown when the application and LiveKit stop the same processor', async () => {
  const track = input();
  let finish!: () => void;
  const closing = new Promise<void>(resolve => { finish = resolve; });
  const inner = { name: 'test', processedTrack: input(), init: async () => {}, restart: async () => {}, destroy: vi.fn(() => closing), setPttActive: vi.fn(), setCaptureAllowed: vi.fn() };
  const p = new DillaMicrophoneProcessor({ preference: 'lightweight', allowed: true, createLightweight: () => inner });
  await p.init({track, kind: Track.Kind.Audio} as AudioProcessorOptions);
  const first = p.destroy(), second = p.destroy();
  expect(track.enabled).toBe(false);
  expect(inner.processedTrack.enabled).toBe(false);
  finish();
  await Promise.all([first, second]);
  expect(inner.destroy).toHaveBeenCalledTimes(1);
  expect(p.processedTrack).toBeUndefined();
});
it('ignores a late device restart after teardown without opening a fallback capture', async () => {
  const inner = {name: 'test', processedTrack: input(), init: async () => {}, restart: vi.fn(async () => {}), destroy: async () => {}, setPttActive: () => {}};
  const p = new DillaMicrophoneProcessor({preference: 'lightweight', createLightweight: () => inner});
  await p.init({track: input(), kind: Track.Kind.Audio} as AudioProcessorOptions);
  await p.destroy();
  const late = input();
  late.clone = vi.fn(late.clone);
  await p.restart({track: late, kind: Track.Kind.Audio} as AudioProcessorOptions);
  await p.destroy();
  expect(late.applyConstraints).not.toHaveBeenCalled();
  expect(late.clone).not.toHaveBeenCalled();
  expect(inner.restart).not.toHaveBeenCalled();
  expect(p.processedTrack).toBeUndefined();
});
it('does not create browser fallback after teardown interrupts a refused-constraint transition', async () => {
  const track = input();
  track.applyConstraints = async () => {};
  track.clone = vi.fn(track.clone);
  let finish!: () => void;
  const closing = new Promise<void>(resolve => { finish = resolve; });
  const inner = {name: 'test', processedTrack: input(), init: async () => {}, restart: async () => {}, destroy: vi.fn(() => closing), setPttActive: () => {}};
  const p = new DillaMicrophoneProcessor({preference: 'lightweight', createLightweight: () => inner});
  const init = p.init({track, kind: Track.Kind.Audio} as AudioProcessorOptions);
  await vi.waitFor(() => expect(inner.destroy).toHaveBeenCalledTimes(1));
  const destroyed = p.destroy();
  finish();
  await Promise.all([init, destroyed]);
  await p.destroy();
  expect(track.clone).not.toHaveBeenCalled();
  expect(p.processedTrack).toBeUndefined();
});
it('preserves Off and keeps legacy On on lightweight until qualification', () => {
  expect(noisePreference('off')).toBe('off'); expect(noisePreference('on')).toBe('lightweight'); expect(noisePreference(undefined)).toBe('lightweight'); expect(noisePreference('automatic')).toBe('automatic');
});
it('disables browser suppression only after the neural processor is ready', async () => {
  const track=input(); let ready!:()=>void;
  const inner={name:'test', processedTrack:track, init:()=>new Promise<void>(r=>{ready=r;}),destroy:vi.fn(async()=>{}),restart:vi.fn(async()=>{}),setPttActive:vi.fn(),setCaptureAllowed:vi.fn(),setMode:vi.fn()};
  const p=new DillaMicrophoneProcessor({preference:'automatic',createLightweight:()=>inner});
  const init=p.init({track,kind:Track.Kind.Audio} as AudioProcessorOptions);
  expect(track.getSettings().noiseSuppression).toBe(true);
  await vi.waitFor(()=>expect(ready).toBeTypeOf('function')); ready(); await init;
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
it('Automatic uses the enabled enhanced processor and reports its effective engine',async()=>{
  const track=input();
  const enhanced={name:'enhanced',processedTrack:input(),init:vi.fn(async()=>{}),restart:async()=>{},destroy:async()=>{},setPttActive:vi.fn(),setMode:vi.fn()};
  const light=vi.fn();
  const p=new DillaMicrophoneProcessor({preference:'automatic',createEnhanced:async()=>enhanced,createLightweight:light});
  await p.init({track,kind:Track.Kind.Audio} as AudioProcessorOptions);
  expect(enhanced.init).toHaveBeenCalled();expect(light).not.toHaveBeenCalled();
  expect(p.status).toMatchObject({effective:'deepfilter',engineName:'DeepFilterNet3',browserNoise:'off'});
  p.setMode('ptt');p.setPttActive(true);expect(enhanced.setPttActive).toHaveBeenLastCalledWith(true);
  await p.destroy();
});
it('Automatic tries lightweight after enhanced startup fails; Lightweight and Off never load enhanced assets',async()=>{
  const track=input();
  const createEnhanced=vi.fn(async()=>({name:'enhanced',init:async()=>{throw Error('bad model')},restart:async()=>{},destroy:vi.fn(async()=>{}),setPttActive:()=>{}}));
  const createLightweight=vi.fn(()=>({name:'light',processedTrack:input(),init:async()=>{},restart:async()=>{},destroy:async()=>{},setPttActive:()=>{}}));
  const p=new DillaMicrophoneProcessor({preference:'automatic',createEnhanced,createLightweight});
  await p.init({track,kind:Track.Kind.Audio} as AudioProcessorOptions);
  expect(createEnhanced).toHaveBeenCalledOnce();expect(createLightweight).toHaveBeenCalledOnce();
  expect(p.status).toMatchObject({effective:'rnnoise',reason:'enhanced-failed'});await p.destroy();
  createEnhanced.mockClear();
  for(const preference of ['lightweight','off'] as const){const p=new DillaMicrophoneProcessor({preference,createEnhanced,createLightweight});await p.init({track,kind:Track.Kind.Audio} as AudioProcessorOptions);await p.destroy();}
  expect(createEnhanced).not.toHaveBeenCalled();
});
it('closes the published fallback track while PTT is released, including before initialization',async()=>{
  const track=input();
  const p=new DillaMicrophoneProcessor({preference:'lightweight',mode:'ptt',allowed:true,createLightweight:()=>({name:'failed',init:async()=>{throw Error('failed')},restart:async()=>{},destroy:async()=>{},setPttActive:()=>{}})});
  await p.init({track,kind:Track.Kind.Audio} as AudioProcessorOptions);
  expect(p.processedTrack!.enabled).toBe(false);
  p.setPttActive(true);expect(p.processedTrack!.enabled).toBe(true);
  p.setPttActive(false);expect(p.processedTrack!.enabled).toBe(false);await p.destroy();
});
it('bypasses a failed neural graph before restarting into browser fallback',async()=>{
  const track=input();let fail!:(reason:string)=>void,bypassed=false;
  const inner={name:'neural',processedTrack:input(),init:async()=>{},restart:vi.fn(async()=>{if(!bypassed)throw Error('failed neural graph');}),destroy:async()=>{},setPttActive:()=>{},useBrowserFallback:()=>{bypassed=true;}};
  const p=new DillaMicrophoneProcessor({preference:'lightweight',createLightweight:o=>{fail=o.onFailure!;return inner;}});
  await p.init({track,kind:Track.Kind.Audio} as AudioProcessorOptions);fail('processor-error');
  await vi.waitFor(()=>expect(p.status.effective).toBe('browser'));expect(bypassed).toBe(true);await p.destroy();
});
it('carries a requested browser downgrade across a concurrent device restart',async()=>{
  const track=input();track.getSettings=()=>({deviceId:'old',noiseSuppression:false});
  const next=input();
  let grant!:(stream:unknown)=>void,fail!:(reason:string)=>void;
  const late=input();late.stop=vi.fn();late.getSettings=()=>({deviceId:'old',noiseSuppression:true});
  vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:()=>new Promise(r=>{grant=r;})}});
  const inner={name:'failed',processedTrack:input(),init:async()=>{},restart:vi.fn(async()=>{}),destroy:async()=>{},setPttActive:()=>{},useBrowserFallback:vi.fn()};
  try{
    const p=new DillaMicrophoneProcessor({preference:'lightweight',createLightweight:o=>{fail=o.onFailure!;return inner;}});
    await p.init({track,kind:Track.Kind.Audio} as AudioProcessorOptions);fail('processor-error');
    await vi.waitFor(()=>expect(grant).toBeTypeOf('function'));
    await p.restart({track:next,kind:Track.Kind.Audio} as AudioProcessorOptions);
    grant({getAudioTracks:()=>[late],getTracks:()=>[late]});
    await vi.waitFor(()=>expect(p.status.effective).toBe('browser'));
    expect(inner.useBrowserFallback).toHaveBeenCalled();expect(late.stop).toHaveBeenCalled();await p.destroy();
  }finally{vi.unstubAllGlobals();}
});
it('reports a failed browser transition and permits retry instead of leaving a poisoned downgrade flag',async()=>{
  let fail!:(reason:string)=>void,reject=true;
  const inner={name:'failed',processedTrack:input(),init:async()=>{},restart:async()=>{if(reject)throw Error('source failed');},destroy:async()=>{},setPttActive:()=>{},useBrowserFallback:()=>{}};
  const p=new DillaMicrophoneProcessor({preference:'lightweight',createLightweight:o=>{fail=o.onFailure!;return inner;}});
  await p.init({track:input(),kind:Track.Kind.Audio} as AudioProcessorOptions);fail('processor-error');
  await vi.waitFor(()=>expect(p.status.effective).toBe('failed'));
  expect(p.processedTrack!.enabled).toBe(false);
  p.setCaptureAllowed(true);expect(p.processedTrack!.enabled).toBe(false);
  reject=false;fail('processor-error');await vi.waitFor(()=>expect(p.status.effective).toBe('browser'));await p.destroy();
});
it('serializes fallback capture behind an active device restart',async()=>{
  let fail!:(reason:string)=>void,finish!:()=>void,noise=false;
  const track=input(),next=input();next.getSettings=()=>({noiseSuppression:noise});
  next.applyConstraints=async (c={})=>{if(c.noiseSuppression===false)await new Promise<void>(r=>{finish=r;});noise=c.noiseSuppression===true;};
  const inner={name:'test',processedTrack:input(),init:async()=>{},restart:async()=>{},destroy:async()=>{},setPttActive:()=>{},useBrowserFallback:vi.fn()};
  const p=new DillaMicrophoneProcessor({preference:'lightweight',createLightweight:o=>{fail=o.onFailure!;return inner;}});
  await p.init({track,kind:Track.Kind.Audio} as AudioProcessorOptions);
  const restarting=p.restart({track:next,kind:Track.Kind.Audio} as AudioProcessorOptions);
  await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));fail('processor-error');await new Promise(r=>setTimeout(r,10));
  expect(inner.useBrowserFallback).not.toHaveBeenCalled();
  finish();await restarting;expect(p.status.effective).toBe('browser');await p.destroy();
});

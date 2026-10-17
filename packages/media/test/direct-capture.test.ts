import {it,expect,vi} from 'vitest';
import {TrackCapture,CaptureController,trackCaptureFactory} from '../src/audio/track-capture';
import {PlaybackBridge} from '../src/audio/playback-bridge';
import type {AudioFrame} from '../src/audio/frame-bridge';
const tick=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};
const fakeTrack=()=>({clone:()=>({enabled:true,stop:vi.fn()}),stop:vi.fn()}) as unknown as MediaStreamTrack;
function setup(){
  const sources:Array<ReadableStreamDefaultController<any>>=[],sent:AudioFrame[]=[],reset=vi.fn(),fail=vi.fn(),dropped=vi.fn();
  const processor=new TrackCapture(f=>sent.push(structuredClone(f,{transfer:[f.pcm.buffer]})),reset,dropped,fail);
  const control=new CaptureController(fakeTrack(),()=>new ReadableStream({start:c=>sources.push(c)}),c=>{void processor.apply(c).then(()=>control.acknowledge(c.epoch));},fail);
  const capture={setGate:control.setGate.bind(control),restart:()=>control.restart(fakeTrack()),recycle:processor.recycle.bind(processor),
    destroy:async()=>{await control.destroy();await processor.destroy();}};
  const chunk=(timestamp:number)=>({timestamp,sampleRate:48000,numberOfFrames:480,numberOfChannels:1,copyTo:(pcm:Float32Array)=>pcm.fill(.5),close:vi.fn()});
  return {capture,sources,sent,reset,fail,dropped,chunk};
}
it('replaces the capture reader at privacy boundaries and closes stale AudioData before resuming',async()=>{
  const s=setup();expect(s.sources).toHaveLength(0);
  s.capture.setGate(true,'ptt');const stale=s.chunk(0);s.sources[0].enqueue(stale);
  s.capture.setGate(false,'ptt');s.capture.setGate(true,'ptt');await tick();
  expect(stale.close).toHaveBeenCalledOnce();expect(s.sent).toHaveLength(0);expect(s.sources).toHaveLength(2);
  const fresh=s.chunk(10000);s.sources[1].enqueue(fresh);await tick();
  expect(s.sent).toHaveLength(1);expect(s.sent[0].epoch).toBe(3);expect(fresh.close).toHaveBeenCalledOnce();
  s.capture.destroy();await tick();expect(s.fail).not.toHaveBeenCalled();
});
it('bounds capture ownership and clears recycled private PCM across device changes',async()=>{
  const s=setup();s.capture.setGate(true,'vad');
  for(let i=0;i<8;i++){s.sources[0].enqueue(s.chunk(i*10000));await tick();}
  expect(s.sent).toHaveLength(6);expect(s.dropped).toHaveBeenCalledTimes(2);
  s.capture.restart();s.capture.setGate(false,'vad');
  const returned=s.sent[0];s.capture.recycle(returned);expect(returned.pcm.every(x=>x===0)).toBe(true);
  s.capture.destroy();await tick();expect(s.fail).not.toHaveBeenCalled();
});
it('reports missing capture frames and unsupported formats without retaining AudioData',async()=>{
  const s=setup();s.capture.setGate(true,'vad');
  s.sources[0].enqueue(s.chunk(10000));await tick();s.sources[0].enqueue(s.chunk(40000));await tick();
  expect(s.dropped).toHaveBeenCalledWith(2);expect(s.sent[1].start).toBe(1440);
  const bad={...s.chunk(50000),sampleRate:16000};s.sources[0].enqueue(bad);await tick();
  expect(bad.close).toHaveBeenCalledOnce();expect(s.fail).toHaveBeenCalledOnce();s.capture.destroy();
});
const frame=(start:number,epoch=1):AudioFrame=>({id:start/480,epoch,start,pcm:Float32Array.from({length:480},(_,i)=>start+i+1),processingMs:1});
it('plays direct frames continuously across 480/128 boundaries and rejects a prior privacy epoch',()=>{
  const returned:AudioFrame[]=[],b=new PlaybackBridge(f=>returned.push(f));b.reset(1,true);
  b.accept(frame(0));b.accept(frame(480));b.accept(frame(960));
  for(let i=0;i<2;i++){const out=new Float32Array(128);b.render(out);expect(out.every(x=>x===0)).toBe(true);}
  let next=1440;
  for(let q=0;q<100;q++){
    if(q*128>=next-960){b.accept(frame(next));next+=480;}
    const out=new Float32Array(128);b.render(out);
    for(let i=0;i<128;i++)expect(out[i]).toBe(q*128+i+1);
  }
  expect(b.stats.underruns).toBe(0);
  b.reset(2,false);const old=frame(0);b.accept(old);expect(old.pcm.every(x=>x===0)).toBe(true);
  b.reset(3,true);const out=new Float32Array(128);b.render(out);expect(out.every(x=>x===0)).toBe(true);
  expect(returned.every(f=>f.pcm.every(x=>x===0)||f.epoch===1)).toBe(true);
});
it('bounds backlog after a render stall instead of retaining older speech indefinitely',()=>{
  const returned:AudioFrame[]=[],b=new PlaybackBridge(f=>returned.push(f));b.reset(1,true);
  b.accept(frame(0));b.accept(frame(480));b.accept(frame(960));b.accept(frame(1440));for(let i=0;i<6;i++)b.render(new Float32Array(128));
  b.accept(frame(1920));b.accept(frame(2400));b.accept(frame(2880));b.accept(frame(3360));
  const out=new Float32Array(128);b.render(out);
  expect(out[0]).toBeGreaterThanOrEqual(1921);expect(b.stats.dropped).toBeGreaterThan(0);
  b.reset(2,false);expect(returned.every(f=>f.pcm.every(x=>x===0)||f.start!<1920)).toBe(true);
});

it('ignores capture-loss notices from a closed privacy epoch',()=>{
  const b=new PlaybackBridge(vi.fn());b.reset(1,true);b.reset(2,false);
  b.captureDropped(1,5);b.captureDropped(2,1);b.reset(3,true);b.captureDropped(1,2);
  expect(b.stats.dropped).toBe(0);expect(b.stats.captureDropped).toBe(0);
  b.captureDropped(3,2);expect(b.stats.dropped).toBe(2);expect(b.stats.captureDropped).toBe(2);
});

it('adapts variable capture blocks without losing samples and clears a partial block on mute',async()=>{
  const s=setup();s.capture.setGate(true,'vad');let offset=0;
  for(const size of [128,960,352]){
    const start=offset;const value={...s.chunk(start/48000*1e6),numberOfFrames:size,
      copyTo:(pcm:Float32Array,options:{frameOffset:number})=>pcm.forEach((_,i)=>{pcm[i]=start+options.frameOffset+i+1;})};
    s.sources[0].enqueue(value);await tick();offset+=size;expect(value.close).toHaveBeenCalledOnce();
  }
  expect(s.sent).toHaveLength(3);expect(s.sent.flatMap(f=>Array.from(f.pcm))).toEqual(Array.from({length:1440},(_,i)=>i+1));
  s.sources[0].enqueue({...s.chunk(30000),numberOfFrames:128});await tick();
  s.capture.setGate(false,'vad');s.capture.setGate(true,'vad');
  s.sources[1].enqueue(s.chunk(40000));await tick();
  expect(Array.from(s.sent[3].pcm)).toEqual(Array(480).fill(.5));s.capture.destroy();
});
it('reports an unexpected active EOF, but not cancellation or superseded readers',async()=>{
  const s=setup();s.capture.setGate(true,'ptt');s.sources[0].close();await tick();
  expect(s.fail).toHaveBeenCalledOnce();s.capture.destroy();await tick();expect(s.fail).toHaveBeenCalledOnce();
});
it('marks discontinuities so delayed model history is discarded before processing post-gap speech',async()=>{
  const s=setup();s.capture.setGate(true,'vad');
  for(const timestamp of [0,10000,20000,30000,100000,110000]){s.sources[0].enqueue(s.chunk(timestamp));await tick();}
  const history:number[]=[],played:number[]=[];
  for(const f of s.sent){
    if(f.discontinuity)history.length=0;
    history.push(f.start!);if(history.length>3)played.push(history.shift()!);
  }
  expect(s.sent[4].discontinuity).toBe(true);expect(played).toEqual([0]);s.capture.destroy();
});
it('probes actual audio support and closes probe data after reading its metadata',async()=>{
  const track={stop:vi.fn()} as unknown as MediaStreamTrack;
  for(const size of [128,960]){
    let closed=false;
    const value={timestamp:0,get sampleRate(){return closed?0:48000;},numberOfChannels:1,numberOfFrames:size,copyTo:vi.fn(),close:vi.fn(()=>{closed=true;})};
    vi.stubGlobal('MediaStreamTrackProcessor',class {readable=new ReadableStream({start:c=>c.enqueue(value)});});
    try{expect(await trackCaptureFactory(track)).toBeTypeOf('function');expect(value.close).toHaveBeenCalledOnce();expect(track.stop).not.toHaveBeenCalled();}
    finally{vi.unstubAllGlobals();}
  }
  vi.stubGlobal('MediaStreamTrackProcessor',class {constructor(){throw Error('Video only');}});
  try{expect(await trackCaptureFactory(track)).toBeUndefined();}finally{vi.unstubAllGlobals();}
});

it('preserves sample timestamps across small gaps and discards incomplete pre-gap audio',async()=>{
  for(const [size,next] of [[480,608],[128,384]]){
    const s=setup();s.capture.setGate(true,'vad');
    s.sources[0].enqueue({...s.chunk(0),numberOfFrames:size});await tick();
    s.sources[0].enqueue(s.chunk(next/48000*1e6));await tick();
    expect(s.sent.at(-1)?.start).toBe(next);expect(s.sent.at(-1)?.discontinuity).toBe(true);
    expect(s.dropped).toHaveBeenCalledWith(1);s.capture.destroy();
  }
});
it('keeps large capture blocks on the AudioWorklet path instead of guaranteeing pool exhaustion',async()=>{
  const s=setup(),value={...s.chunk(0),numberOfFrames:4800};
  vi.stubGlobal('MediaStreamTrackProcessor',class {readable=new ReadableStream({start:c=>c.enqueue(value)});});
  try{expect(await trackCaptureFactory({} as MediaStreamTrack)).toBeUndefined();expect(value.close).toHaveBeenCalledOnce();}
  finally{vi.unstubAllGlobals();s.capture.destroy();}
});

it('tolerates browser timestamp precision without resetting continuous audio',async()=>{
  const s=setup();s.capture.setGate(true,'vad');
  for(const timestamp of [0,9900,20000,29900]){s.sources[0].enqueue(s.chunk(timestamp));await tick();}
  expect(s.sent.map(f=>f.start)).toEqual([0,480,960,1440]);expect(s.sent.some(f=>f.discontinuity)).toBe(false);
  expect(s.fail).not.toHaveBeenCalled();expect(s.dropped).not.toHaveBeenCalled();s.capture.destroy();
});

it('resets retained speech when the capture clock rebases after resuming a muted source',async()=>{
  const s=setup();s.capture.setGate(true,'ptt');
  for(const timestamp of [11_400_000,11_410_000,6_020_000]){s.sources[0].enqueue(s.chunk(timestamp));await tick();}
  expect(s.fail).not.toHaveBeenCalled();
  s.sources[0].enqueue(s.chunk(6_030_000));await tick();
  expect(s.sent.map(f=>f.start)).toEqual([0,480,960,1440]);
  expect(s.sent.map(f=>f.discontinuity)).toEqual([false,false,true,false]);
  expect(s.dropped).not.toHaveBeenCalled();await s.capture.destroy();
});

it('acknowledges cancellation of a genuinely transferred stream before shutdown',async()=>{
  const cancel=vi.fn(),stream=new ReadableStream({cancel}),transferred=structuredClone(stream,{transfer:[stream]});
  const processor=new TrackCapture(vi.fn(),vi.fn(),vi.fn(),vi.fn());
  await processor.apply({kind:'capture',epoch:1,allowed:true,mode:'vad',stream:transferred});
  await processor.apply({kind:'capture',epoch:2,allowed:false,mode:'vad'});
  await vi.waitFor(()=>expect(cancel).toHaveBeenCalledOnce());await processor.destroy();
});
it('stops only its owned capture clone after acknowledgement or a bounded hung-worker timeout',async()=>{
  for(const responsive of [true,false]){
    const owned={enabled:true,stop:vi.fn()},track={clone:()=>owned,stop:vi.fn()} as unknown as MediaStreamTrack;
    const send=vi.fn(),control=new CaptureController(track,()=>new ReadableStream(),send,vi.fn());
    control.setGate(true,'vad');const done=control.destroy();expect(owned.enabled).toBe(false);
    expect(owned.stop).not.toHaveBeenCalled();
    if(responsive)control.acknowledge(send.mock.calls.at(-1)![0].epoch);
    await done;expect(owned.stop).toHaveBeenCalledOnce();expect(track.stop).not.toHaveBeenCalled();
    for(const [c] of send.mock.calls)await c.stream?.cancel();
  }
});

it('uses a fresh source clone after PTT release instead of reusing the disabled silence clock',async()=>{
  const clones:Array<{enabled:boolean;stop:ReturnType<typeof vi.fn>}>=[],send=vi.fn(),factory=vi.fn(()=>new ReadableStream());
  const track={clone:()=>{const clone={enabled:true,stop:vi.fn()};clones.push(clone);return clone;}} as unknown as MediaStreamTrack;
  const control=new CaptureController(track,factory,send,vi.fn());
  control.setGate(true,'ptt');control.setGate(false,'ptt');control.setGate(true,'ptt');
  expect(clones).toHaveLength(2);expect(clones[0].enabled).toBe(false);expect(clones[1].enabled).toBe(true);
  control.acknowledge(2);expect(clones[0].stop).toHaveBeenCalledOnce();expect(clones[1].stop).not.toHaveBeenCalled();
  const done=control.destroy();control.acknowledge(4);await done;expect(clones[1].stop).toHaveBeenCalledOnce();
  for(const [c] of send.mock.calls)await c.stream?.cancel();
});

it('disables a retired device immediately and stops it even when replacement and mute are never acknowledged',async()=>{
  const old={enabled:true,stop:vi.fn()},next={enabled:true,stop:vi.fn()},send=vi.fn();
  const control=new CaptureController({clone:()=>old} as unknown as MediaStreamTrack,()=>new ReadableStream(),send,vi.fn());
  control.setGate(true,'vad');control.restart({clone:()=>next} as unknown as MediaStreamTrack);control.setGate(false,'vad');
  expect(old.enabled).toBe(false);expect(next.enabled).toBe(false);
  await vi.waitFor(()=>expect(old.stop).toHaveBeenCalledOnce(),{timeout:300});
  const done=control.destroy();control.acknowledge(send.mock.calls.at(-1)![0].epoch);await done;
  expect(old.stop).toHaveBeenCalledOnce();expect(next.stop).toHaveBeenCalledOnce();
  for(const [c] of send.mock.calls)await c.stream?.cancel();
});

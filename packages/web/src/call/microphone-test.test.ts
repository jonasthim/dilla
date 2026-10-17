import { afterEach, expect, it, vi } from 'vitest';
import { LocalMicrophoneTest } from './microphone-test';
vi.mock('@dilla/media',()=>({DillaMicrophoneProcessor:class {processedTrack={stop(){}};async init(){} async destroy(){}}}));
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
function audio() {
  let closed=false, stopped=false;
  const stream={getTracks:()=>[{stop:()=>{stopped=true;}}],getAudioTracks:()=>[{}]};
  const nodes:Array<{port:{onmessage:((e:unknown)=>void)|null;postMessage:(m:unknown)=>void}}> = [];
  vi.stubGlobal('AudioContext',class {
    state='running';destination={};audioWorklet={addModule:async()=>{}};
    resume=async()=>{};close=()=>{closed=true;this.state='closed';return Promise.resolve();};
    createMediaStreamSource(){return {connect(){},disconnect(){}};}
  });
  vi.stubGlobal('AudioWorkletNode',class {port={onmessage:null,postMessage:()=>{}};constructor(){nodes.push(this);}connect(){}disconnect(){}});
  vi.stubGlobal('MediaStream',class{});
  return {stream,nodes,closed:()=>closed,stopped:()=>stopped};
}
it('stops capture and closes the context before offering playback, then revokes the recording on close',async()=>{
  const a=audio();vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:()=>Promise.resolve(a.stream)}});
  const revoke=vi.fn();vi.stubGlobal('URL',Object.assign(class{}, {createObjectURL:()=>{expect(a.stopped()).toBe(true);expect(a.closed()).toBe(true);return 'blob:local';},revokeObjectURL:revoke}));
  const result=vi.fn(),test=new LocalMicrophoneTest(result,()=>{});
  await test.start('','off');a.nodes[0].port.onmessage!({data:new Float32Array([0.5])});
  await vi.waitFor(()=>expect(result).toHaveBeenCalledWith('blob:local'));
  await test.close();expect(revoke).toHaveBeenCalledWith('blob:local');
});
it('closing during a permission prompt releases a late microphone and never offers playback',async()=>{
  const a=audio();let grant!:(s:unknown)=>void;
  vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:()=>new Promise(r=>{grant=r;})}});
  const result=vi.fn(),test=new LocalMicrophoneTest(result,()=>{});
  const start=test.start('','off');await test.close();grant(a.stream);await start;
  expect(a.stopped()).toBe(true);expect(a.nodes).toHaveLength(0);expect(result).not.toHaveBeenCalled();
});

it('Stop releases capture synchronously and discards an unresponsive recorder',async()=>{
  vi.useFakeTimers();const a=audio();vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:()=>Promise.resolve(a.stream)}});
  const result=vi.fn(),test=new LocalMicrophoneTest(result,()=>{});
  await test.start('','off');test.stop();expect(a.stopped()).toBe(true);
  await vi.advanceTimersByTimeAsync(1000);expect(a.closed()).toBe(true);expect(result).not.toHaveBeenCalled();
});
it('the ten-second deadline stops capture even when the recorder never replies',async()=>{
  vi.useFakeTimers();const a=audio();vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:()=>Promise.resolve(a.stream)}});
  const result=vi.fn(),test=new LocalMicrophoneTest(result,()=>{});
  await test.start('','off');await vi.advanceTimersByTimeAsync(10000);expect(a.stopped()).toBe(true);
  await vi.advanceTimersByTimeAsync(1000);expect(a.closed()).toBe(true);expect(result).not.toHaveBeenCalled();
});
it('bounds stalled setup and releases capture independently of a pending module load',async()=>{
  vi.useFakeTimers();const a=audio();vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:()=>Promise.resolve(a.stream)}});
  const Original=AudioContext;vi.stubGlobal('AudioContext',class extends Original {audioWorklet={addModule:()=>new Promise<void>(()=>{})} as AudioWorklet;});
  const test=new LocalMicrophoneTest(vi.fn(),()=>{}),start=test.start('','off');
  const rejected=expect(start).rejects.toThrow(/timed out/);
  await vi.advanceTimersByTimeAsync(15000);await rejected;
  expect(a.stopped()).toBe(true);expect(a.closed()).toBe(true);
});

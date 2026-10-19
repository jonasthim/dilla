import {afterEach,expect,it,vi} from 'vitest';
import {ProcessorHealth} from '../src/audio/processor-health';
import type {AudioFrame} from '../src/audio/frame-bridge';
let Ctor:new()=>{port:{onmessage:(event:unknown)=>void};process(i:Float32Array[][],o:Float32Array[][]):boolean};
afterEach(()=>vi.unstubAllGlobals());
it('a past scheduling glitch cannot poison healthy windows into a permanent downgrade',()=>{
  const h=new ProcessorHealth();
  expect(h.observe({buffers:375,underruns:1,dropped:0})).toBe(false);
  expect(h.observe({buffers:750,underruns:1,dropped:0})).toBe(false);
  expect(h.observe({buffers:1125,underruns:1,dropped:0})).toBe(false);
  expect(h.observe({buffers:1500,underruns:2,dropped:0})).toBe(false);
  expect(h.observe({buffers:1875,underruns:3,dropped:0})).toBe(false);
  expect(h.observe({buffers:2250,underruns:4,dropped:0})).toBe(true);
});
it('the enhanced transport independently enforces mute and PTT, rejecting old worker output',async()=>{
  vi.stubGlobal('AudioWorkletProcessor',class{port={onmessage:null,postMessage:()=>{}}});
  vi.stubGlobal('registerProcessor',(_:string,c:typeof Ctor)=>{Ctor=c;});vi.stubGlobal('sampleRate',48000);
  vi.resetModules();await import('../src/audio/deepfilter-worklet');
  const pending:AudioFrame[]=[],controls:Array<Partial<AudioFrame>&{kind?:string}>=[];
  const worker={onmessage:(_:unknown)=>{},postMessage:(frame:AudioFrame)=>{if(frame.pcm)pending.push({...frame,pcm:frame.pcm.slice()});else controls.push(frame);},start(){},close(){}};
  const p=new Ctor(),out=new Float32Array(128),input=new Float32Array(128).fill(.75);
  const message=(data:unknown)=>p.port.onmessage({data});
  message({kind:'connect',port:worker});message({kind:'mode',mode:'ptt'});message({kind:'capture',allowed:true});
  for(let i=0;i<20;i++)p.process([[input]],[[out]]);
  expect(pending).toHaveLength(0);expect(out.every(x=>x===0)).toBe(true);
  message({kind:'ptt',active:true});for(let i=0;i<16;i++)p.process([[input]],[[out]]);
  expect(pending.length).toBeGreaterThan(0);
  message({kind:'ptt',active:false});for(const frame of pending.splice(0))worker.onmessage({data:frame});
  message({kind:'ptt',active:true});input.fill(0);
  for(let i=0;i<30;i++){p.process([[input]],[[out]]);for(const frame of pending.splice(0))worker.onmessage({data:frame});expect(out.every(x=>x===0)).toBe(true);}
  controls.length=0;message({kind:'capture',allowed:false});input.fill(.9);
  expect(controls.some(c=>c.kind==='reset')).toBe(true);
  for(let i=0;i<20;i++)p.process([[input]],[[out]]);
  expect(pending).toHaveLength(0);expect(out.every(x=>x===0)).toBe(true);
});
it('uses existing model lookahead for 20 ms of VAD onset audio without adding another delay',async()=>{
  const {LookaheadGate}=await import('../src/audio/lookahead-gate');
  const g=new LookaheadGate('vad');
  const frame=(n:number)=>new Float32Array(480).fill(n);
  // Model output at step 4 belongs to raw input step 1. The VAD decision for step 3
  // arrives one step later, opening exactly two frames before the detected onset.
  expect(g.process(frame(1),0,10)[0]).toBe(0);
  expect(g.process(frame(2),0,20)[0]).toBe(0);
  expect(g.process(frame(3),1,30)[0]).toBe(0);
  expect(g.process(frame(4),1,40)[0]).toBe(4);
  g.reset();expect(g.process(frame(5),0,50)[0]).toBe(0);
});

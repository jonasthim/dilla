import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
let Ctor: new (o: unknown) => { port: { onmessage: (e: unknown) => void }; process(i: Float32Array[][], o: Float32Array[][]): boolean };
afterEach(() => vi.unstubAllGlobals());
async function make(mode: string, denoise = true) {
  const reports: Array<{compiled?:boolean}> = [];
  vi.stubGlobal('AudioWorkletProcessor', class { port = { onmessage: null, postMessage: (m: {compiled?:boolean}) => reports.push(m) }; });
  vi.stubGlobal('registerProcessor', (_n: string, c: typeof Ctor) => {Ctor=c;});
  vi.stubGlobal('sampleRate',48000); vi.stubGlobal('currentTime',0);
  vi.resetModules(); await import('../src/audio/rnnoise-worklet');
  const p = new Ctor({processorOptions:{mode,denoise}});
  const bytes=readFileSync(new URL('../src/audio/generated/rnnoise.wasm',import.meta.url));
  p.port.onmessage({data:{kind:'module',module:await WebAssembly.compile(bytes)}});
  expect(reports.some(r=>r.compiled)).toBe(true);
  return p;
}
it('mute flushes processed and partial frames and rejects capture until reopened', async () => {
  const p=await make('open',false), out=new Float32Array(128);
  for(let i=0;i<4;i++)p.process([[new Float32Array(128).fill(0.7)]],[[out]]);
  p.port.onmessage({data:{kind:'capture',allowed:false}});
  p.process([[new Float32Array(128).fill(0.9)]],[[out]]);
  expect([...out].every(x=>x===0)).toBe(true);
  p.port.onmessage({data:{kind:'capture',allowed:true}});
  for(let i=0;i<8;i++){p.process([[new Float32Array(128)]],[[out]]);expect([...out].every(x=>x===0)).toBe(true);}
});
it('Off can detect voice without denoising the transmitted waveform', async () => {
  const p=await make('open',false), out=new Float32Array(128), heard:number[]=[];
  for(let i=0;i<20;i++){p.process([[new Float32Array(128).fill(0.25)]],[[out]]);heard.push(...out);}
  expect(heard.some(x=>x===0.25)).toBe(true);
  expect(heard.every(x=>x===0||x===0.25)).toBe(true);
});
it('PTT release flushes audio already queued for output', async () => {
  const p=await make('ptt',false), out=new Float32Array(128);
  p.port.onmessage({data:{kind:'ptt',active:true}});
  for(let i=0;i<4;i++)p.process([[new Float32Array(128).fill(0.5)]],[[out]]);
  p.port.onmessage({data:{kind:'ptt',active:false}});
  p.process([[new Float32Array(128).fill(0.5)]],[[out]]);
  expect([...out].every(x=>x===0)).toBe(true);
});

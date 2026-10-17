import { FrameBridge } from './frame-bridge';
import { PlaybackBridge } from './playback-bridge';
import type { GateMode } from './gate';
declare const sampleRate:number;
declare function registerProcessor(name:string, ctor:unknown):void;
declare abstract class AudioWorkletProcessor { readonly port:MessagePort; }
class NoiseTransport extends AudioWorkletProcessor {
  private worker:MessagePort|null=null;
  private bridge=new FrameBridge(frame=>this.worker?.postMessage(frame,[frame.pcm.buffer]),480,epoch=>this.worker?.postMessage({kind:'reset',epoch}));
  private playback?:PlaybackBridge;
  private stopped=false;
  private ticks=0;
  private allowed=false;
  private ptt=false;
  private mode:GateMode='vad';
  constructor(options?:{processorOptions?:{directCapture?:boolean}}) {
    super();
    if(options?.processorOptions?.directCapture)this.playback=new PlaybackBridge(frame=>this.worker?.postMessage({kind:'recycle',frame},[frame.pcm.buffer]));
    this.port.onmessage=e=>{
      const d=e.data;
      if(d.kind==='connect') {this.worker=d.port; this.worker!.onmessage=message=>{if(message.data.kind==='capture-drop'&&this.playback)this.playback.captureDropped(message.data.epoch,message.data.count);else (this.playback??this.bridge).accept(message.data);}; this.worker!.start();}
      if(this.playback){
        if(d.kind==='capture')this.playback.reset(d.epoch,d.allowed);
        if(d.kind==='destroy'){this.playback.reset(-1,false);this.worker?.close();this.stopped=true;}
        return;
      }
      if(d.kind==='capture') this.allowed=d.allowed===true;
      if(d.kind==='ptt') this.ptt=d.active===true;
      if(d.kind==='mode') {this.mode=d.mode;this.bridge.flush();this.worker?.postMessage({kind:'mode',mode:this.mode});}
      this.bridge.setAllowed(this.allowed&&(this.mode!=='ptt'||this.ptt));
      if(d.kind==='flush') this.bridge.flush();
      if(d.kind==='destroy') {this.bridge.setAllowed(false); this.worker?.close(); this.stopped=true;}
    };
  }
  process(inputs:Float32Array[][],outputs:Float32Array[][]):boolean {
    const out=outputs[0]?.[0]; if(!out) return !this.stopped;
    if(this.stopped||sampleRate!==48000) {out.fill(0); return !this.stopped;}
    if(this.playback)this.playback.render(out);else this.bridge.render(inputs[0]?.[0],out);
    if(++this.ticks%375===0)this.port.postMessage({kind:'metrics',...(this.playback??this.bridge).stats});
    return true;
  }
}
registerProcessor('dilla-deepfilter-transport',NoiseTransport);

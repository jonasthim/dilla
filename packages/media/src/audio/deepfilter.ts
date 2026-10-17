/// <reference path="./noise-assets.d.ts" />
import type { AudioProcessorOptions } from 'livekit-client';
import assets from 'virtual:dilla-noise-assets';
import { DillaRnnoiseProcessor } from './rnnoise';
import { ProcessorHealth } from './processor-health';
import type { EnhancedOptions, InnerProcessor, ProcessorStatus } from './microphone';
import type { GateMode } from './gate';
import { CaptureController,trackCaptureFactory } from './track-capture';
/** A stable output track survives device changes and a one-way downgrade to Lightweight. */
export class DillaDeepFilterProcessor implements InnerProcessor {
  readonly name='dilla-deepfilter';
  processedTrack?:MediaStreamTrack;
  private ctx?:AudioContext;
  private node?:AudioWorkletNode;
  private source?:MediaStreamAudioSourceNode;
  private dest?:MediaStreamAudioDestinationNode;
  private worker?:Worker;
  private capture?:CaptureController;
  private fallback?:DillaRnnoiseProcessor;
  private track?:MediaStreamTrack;
  private allowed:boolean;
  private ptt=false;
  private mode:GateMode;
  private generation=0;
  private fallingBack=false;
  private bypass=false;
  private fallbackReady=false;
  private cancelStartup?:()=>void;
  constructor(private readonly options:EnhancedOptions={}){this.allowed=options.allowed??false;this.mode=options.mode??'vad';}
  async init(opts:AudioProcessorOptions):Promise<void>{
    const generation=++this.generation;
    this.track=opts.track;
    // Keep the output clock tied to the audio device. Timer-driven silent sinks can retain
    // clock drift after scheduling stalls, even when our own queue stays bounded.
    const ctx=this.ctx=new AudioContext({sampleRate:48000,latencyHint:128/48000});
    const current=()=>{if(generation!==this.generation)throw Error('Processor cancelled');};
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const startup=new Promise<never>((_,reject)=>{this.cancelStartup=()=>reject(Error('Processor cancelled'));timer=setTimeout(()=>reject(Error('Processor startup timeout')),15000);});
      await Promise.race([(async()=>{
        await ctx.resume();current();
        if(ctx.sampleRate!==48000)throw Error('Expected 48 kHz');
        await ctx.audioWorklet.addModule((await import('./deepfilter-worklet.ts?worker&url')).default);current();
        const captureFactory=await trackCaptureFactory(opts.track);current();
        const node=this.node=new AudioWorkletNode(ctx,'dilla-deepfilter-transport',{channelCount:1,channelCountMode:'explicit',outputChannelCount:[1],processorOptions:{directCapture:!!captureFactory}});
        const worker=this.worker=new Worker(new URL('./deepfilter-worker.ts',import.meta.url),{type:'module'});
        const channel=new MessageChannel();
        let workerCapture:CaptureController|undefined;
        const ready=new Promise<void>((resolve,reject)=>{
          worker.onerror=()=>{reject(Error('Worker failed'));void this.downgrade('processor-error');};
          worker.onmessage=e=>{if(e.data.kind==='capture-closed'){workerCapture?.acknowledge(e.data.epoch);return;}if(e.data.kind==='ready')resolve();if(e.data.kind==='error'){this.options.onMetrics?.(e.data);reject(Error(`${e.data.reason}: ${e.data.detail??''}`));void this.downgrade(e.data.reason);}};
        });
        const health=new ProcessorHealth();
        node.port.onmessage=e=>{this.options.onMetrics?.(e.data);if(e.data.kind==='metrics'&&health.observe(e.data))void this.downgrade('repeated-underruns');};
        node.onprocessorerror=()=>{void this.downgrade('processor-error');};
        worker.postMessage({port:channel.port1,assets,mode:this.mode},[channel.port1]);
        node.port.postMessage({kind:'connect',port:channel.port2},[channel.port2]);
        await ready;current();
        this.options.onMetrics?.({kind:'clock',baseLatency:ctx.baseLatency,outputLatency:ctx.outputLatency});
        this.dest=ctx.createMediaStreamDestination();this.dest.channelCount=1;node.connect(this.dest);
        this.processedTrack=this.dest.stream.getAudioTracks()[0];
        if(captureFactory)workerCapture=this.capture=new CaptureController(opts.track,captureFactory,control=>{
          // Close output immediately, independently of the Worker queue. Its frames carry this epoch.
          node.port.postMessage({kind:'capture',epoch:control.epoch,allowed:control.allowed});
          worker.postMessage(control,control.stream?[control.stream]:[]);
        },()=>{void this.downgrade('processor-error');});
        else this.connect(opts.track);
        this.updateGate();
        ctx.onstatechange=()=>{if(ctx.state==='suspended'){this.flush();this.options.onFailure?.('audio-suspended');void ctx.resume().catch(()=>undefined);}};
      })(),startup]);
    }catch(error){await this.destroy();throw error;}finally{clearTimeout(timer);this.cancelStartup=undefined;}
  }
  private connect(track:MediaStreamTrack):void{
    this.source?.disconnect();
    this.source=this.ctx!.createMediaStreamSource(new MediaStream([track]));
    this.source.connect(this.bypass?this.dest!:this.node!);
  }
  private updateGate():void{
    const allowed=this.allowed&&(this.mode!=='ptt'||this.ptt);
    if(this.capture)this.capture.setGate(allowed&&!this.fallingBack&&!this.bypass,this.mode);
    else{
      this.node?.port.postMessage({kind:'mode',mode:this.mode});
      this.node?.port.postMessage({kind:'ptt',active:this.ptt});
      this.node?.port.postMessage({kind:'capture',allowed:this.allowed});
    }
    this.fallback?.setMode(this.mode);this.fallback?.setPttActive(this.ptt);this.fallback?.setCaptureAllowed(this.allowed);
    if(this.processedTrack)this.processedTrack.enabled=allowed;
  }
  private async downgrade(reason:ProcessorStatus['reason']):Promise<void>{
    if(this.fallingBack||!this.dest||!this.track||!this.ctx||this.bypass)return;
    this.fallingBack=true;const generation=this.generation;
    this.capture?.setGate(false,this.mode);
    if(!this.capture)this.node?.port.postMessage({kind:'capture',allowed:false});
    await this.stopWorker();
    if(generation!==this.generation||this.bypass||!this.ctx||!this.dest)return;
    const fallback=this.fallback=new DillaRnnoiseProcessor({mode:this.mode,allowed:false,onFailure:this.options.onFailure});
    try{
      await fallback.init({track:this.track,kind:'audio'} as AudioProcessorOptions);
      if(generation!==this.generation||this.bypass){await fallback.destroy();return;}
      await fallback.restart({track:this.track,kind:'audio'} as AudioProcessorOptions);
      if(generation!==this.generation||this.bypass){await fallback.destroy();return;}
      this.fallbackReady=true;
      this.source?.disconnect();this.node?.disconnect();this.source=this.ctx.createMediaStreamSource(new MediaStream([fallback.processedTrack!]));this.source.connect(this.dest);
      this.updateGate();this.options.onEffective?.('rnnoise',reason);
    }catch{if(generation===this.generation)this.options.onFailure?.('processor-error');}
  }
  private async stopWorker():Promise<void>{
    const worker=this.worker;this.worker=undefined;
    try{await this.capture?.destroy();}finally{worker?.terminate();}
  }
  setCaptureAllowed(allowed:boolean):void{if(allowed===this.allowed)return;this.allowed=allowed;this.updateGate();}
  setPttActive(active:boolean):void{if(active===this.ptt)return;this.ptt=active;this.updateGate();}
  setMode(mode:GateMode):void{if(mode===this.mode)return;this.mode=mode;this.updateGate();}
  flush():void{if(this.capture)this.capture.flush();else this.node?.port.postMessage({kind:'flush'});this.fallback?.flush();}
  async restart(opts:AudioProcessorOptions):Promise<void>{
    this.flush();this.track=opts.track;
    if(this.fallback&&!this.bypass){if(this.fallbackReady)await this.fallback.restart(opts);}else if(this.capture&&!this.bypass)this.capture.restart(opts.track);else this.connect(opts.track);
  }
  useBrowserFallback():void{
    this.bypass=true;void this.stopWorker();this.node?.port.postMessage({kind:'destroy'});this.node?.disconnect();
    void this.fallback?.destroy();this.fallback=undefined;
    if(this.track&&this.ctx)this.connect(this.track);
    this.updateGate();
  }
  async destroy():Promise<void>{
    ++this.generation;this.cancelStartup?.();this.allowed=false;
    if(this.processedTrack){this.processedTrack.enabled=false;this.processedTrack.stop();}
    await this.stopWorker();this.capture=undefined;this.node?.port.postMessage({kind:'destroy'});this.source?.disconnect();this.node?.disconnect();
    await this.fallback?.destroy();this.fallback=undefined;
    const ctx=this.ctx;this.ctx=undefined;this.dest=undefined;
    if(ctx){ctx.onstatechange=null;if(ctx.state!=='closed')await ctx.close();}
  }
}

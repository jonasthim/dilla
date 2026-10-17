import type { AudioProcessorOptions, Track, TrackProcessor } from 'livekit-client';
import { DillaRnnoiseProcessor } from '../../packages/media/src/audio/rnnoise';
/** Only the experimental harness imports this module. No production model or feature flag. */
export class ExperimentalDeepFilterProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name='dilla-experimental-deepfilter'; processedTrack?:MediaStreamTrack;
  private ctx?:AudioContext; private node?:AudioWorkletNode; private source?:MediaStreamAudioSourceNode; private dest?:MediaStreamAudioDestinationNode;
  private worker?:Worker; private fallback?:DillaRnnoiseProcessor; private track?:MediaStreamTrack; private allowed=false; private stopped=false; private failures=0; private fallingBack=false;
  constructor(private readonly report:(event:Record<string,unknown>)=>void=()=>{}, private readonly mode:'open'|'vad'='vad'){}
  async init(opts:AudioProcessorOptions):Promise<void>{
    this.track=opts.track;
    const ctx=this.ctx=new AudioContext({sampleRate:48000,latencyHint:'interactive'});
    if(ctx.sampleRate!==48000)throw Error('Expected 48 kHz');
    try {
      await ctx.resume();
      await ctx.audioWorklet.addModule((await import('./stream-worklet.ts?worker&url')).default);
      if(this.stopped)throw Error('Cancelled');
      const node=this.node=new AudioWorkletNode(ctx,'dilla-experimental-noise-transport',{channelCount:1,channelCountMode:'explicit',outputChannelCount:[1]});
      const worker=this.worker=new Worker(new URL('./stream-worker.ts',import.meta.url),{type:'module'});
      const channel=new MessageChannel();
      const ready=new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>reject(Error('Processor startup timeout')),15000);
        worker.onerror=()=>{clearTimeout(timer);reject(Error('Worker failed'));void this.downgrade('worker-error');};
        worker.onmessage=e=>{this.report(e.data);if(e.data.kind==='ready'){clearTimeout(timer);resolve();}if(e.data.kind==='error'){clearTimeout(timer);reject(Error(`${e.data.reason}: ${e.data.detail ?? ''}`));void this.downgrade(e.data.reason);}};
      });
      node.port.onmessage=e=>{
        this.report(e.data);
        if(e.data.kind==='metrics') {
          if(e.data.buffers>375 && (e.data.underruns/e.data.buffers>=0.001 || e.data.dropped>3))this.failures++;else this.failures=0;
          if(this.failures>=3)void this.downgrade('repeated-underruns');
        }
      };
      worker.postMessage({port:channel.port1,engine:'deepfilter',mode:this.mode},[channel.port1]);
      node.port.postMessage({kind:'connect',port:channel.port2},[channel.port2]);
      await ready; if(this.stopped)throw Error('Cancelled');
      this.dest=ctx.createMediaStreamDestination(); this.dest.channelCount=1; node.connect(this.dest);
      this.processedTrack=this.dest.stream.getAudioTracks()[0];
      this.source=ctx.createMediaStreamSource(new MediaStream([opts.track])); this.source.connect(node);this.setCaptureAllowed(this.allowed);
    } catch(error){await this.destroy();throw error;}
  }
  private async downgrade(reason:string):Promise<void>{
    if(this.fallingBack||this.stopped||!this.dest||!this.track||!this.ctx)return;
    this.fallingBack=true;this.node?.port.postMessage({kind:'capture',allowed:false});this.worker?.terminate();
    const fallback=this.fallback=new DillaRnnoiseProcessor({mode:this.mode,allowed:false});
    try {await fallback.init({track:this.track,kind:'audio'} as AudioProcessorOptions);if(this.stopped){await fallback.destroy();return;}
      this.source?.disconnect();this.node?.disconnect();this.source=this.ctx.createMediaStreamSource(new MediaStream([fallback.processedTrack!]));this.source.connect(this.dest);
      this.setCaptureAllowed(this.allowed);this.report({kind:'fallback',effective:'rnnoise',reason});
    }catch {this.report({kind:'error',reason:'fallback-failed'});await this.destroy();}
  }
  setCaptureAllowed(allowed:boolean):void{this.allowed=allowed;this.node?.port.postMessage({kind:'capture',allowed});this.fallback?.setCaptureAllowed(allowed);if(this.processedTrack)this.processedTrack.enabled=allowed;}
  setPttActive(active:boolean):void{this.setCaptureAllowed(active);}
  flush():void{this.node?.port.postMessage({kind:'flush'});this.fallback?.flush();}
  async restart(opts:AudioProcessorOptions):Promise<void>{this.flush();this.track=opts.track;this.source?.disconnect();if(this.fallback){await this.fallback.restart(opts);this.source=this.ctx!.createMediaStreamSource(new MediaStream([this.fallback.processedTrack!]));this.source.connect(this.dest!);}else{this.source=this.ctx!.createMediaStreamSource(new MediaStream([opts.track]));this.source.connect(this.node!);}}
  async destroy():Promise<void>{this.stopped=true;this.setCaptureAllowed(false);this.worker?.terminate();this.node?.port.postMessage({kind:'destroy'});this.source?.disconnect();this.node?.disconnect();await this.fallback?.destroy();this.processedTrack?.stop();const ctx=this.ctx;this.ctx=undefined;if(ctx&&ctx.state!=='closed')await ctx.close();}
}

import type { AudioFrame } from './frame-bridge';
import type { GateMode } from './gate';
interface AudioChunk {
  readonly timestamp:number;
  readonly sampleRate:number;
  readonly numberOfFrames:number;
  readonly numberOfChannels:number;
  copyTo(destination:Float32Array,options:{planeIndex:number;format:'f32-planar';frameOffset?:number;frameCount?:number}):void;
  close():void;
}
export type CaptureReader=ReadableStreamDefaultReader<AudioChunk>;
type CaptureFactory=(track:MediaStreamTrack)=>ReadableStream<AudioChunk>;
export interface CaptureControl {kind:'capture';epoch:number;allowed:boolean;mode:GateMode;stream?:ReadableStream<AudioChunk>}
/** Audio-track processing is optional. Browsers without it keep the AudioWorklet capture path. */
export async function trackCaptureFactory(track:MediaStreamTrack):Promise<CaptureFactory|undefined> {
  const ctor=(globalThis as unknown as {MediaStreamTrackProcessor?:new(options:{track:MediaStreamTrack;maxBufferSize:number})=>{readable:ReadableStream<AudioChunk>}}).MediaStreamTrackProcessor;
  if(!ctor)return;
  let reader:CaptureReader|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  try{
    const factory:CaptureFactory=track=>new ctor({track,maxBufferSize:2}).readable;
    // Transfer support is distinct from exposing audio tracks on the main thread.
    const probe=new ReadableStream({start:controller=>controller.close()});
    await structuredClone(probe,{transfer:[probe]}).cancel();
    reader=factory(track).getReader();
    // Presence alone may mean video-only support. Inspect before closing, even on a late read.
    const reading=reader.read().then(({value,done})=>{
      if(done)return false;
      try{return value.sampleRate===48000&&value.numberOfChannels===1&&value.numberOfFrames>0&&value.numberOfFrames<=960;}
      finally{value.close();}
    });
    const supported=await Promise.race([reading,new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),100);})]);
    if(supported)return factory;
  }catch{ /* Preserve the AudioWorklet input path when audio tracks are unsupported. */ }
  finally{clearTimeout(timer);if(reader){await reader.cancel().catch(()=>{});reader.releaseLock();}}
}
/** The main thread only replaces streams and privacy epochs; it never handles live PCM. */
export class CaptureController {
  private epoch=0;
  private allowed=false;
  private mode:GateMode='vad';
  private disposed=false;
  private owned?:MediaStreamTrack;
  private readonly retired=new Map<number,{track:MediaStreamTrack;timer:ReturnType<typeof setTimeout>}>();
  private acknowledged=0;
  private closed?:()=>void;
  private closing?:Promise<void>;
  constructor(private track:MediaStreamTrack,private readonly factory:CaptureFactory,private readonly send:(control:CaptureControl)=>void,private readonly fail:(error?:unknown)=>void){}
  setGate(allowed:boolean,mode:GateMode):void {
    if(this.disposed||this.allowed===allowed&&this.mode===mode)return;
    this.allowed=allowed;this.mode=mode;this.flush();
  }
  restart(track:MediaStreamTrack):void {
    this.track=track;this.flush();
  }
  flush():void {
    const control:CaptureControl={kind:'capture',epoch:++this.epoch,allowed:this.allowed&&!this.disposed,mode:this.mode};
    if(this.owned){
      const track=this.owned,retiredAt=control.epoch;track.enabled=false;
      const timer=setTimeout(()=>{track.stop();this.retired.delete(retiredAt);},200);
      this.retired.set(retiredAt,{track,timer});this.owned=undefined;
    }
    try{
      if(control.allowed){this.owned=this.track.clone();this.owned.enabled=true;control.stream=this.factory(this.owned);}
      this.send(control);
    }catch(error){void control.stream?.cancel().catch(()=>{});if(!this.disposed)this.fail(error);}
  }
  acknowledge(epoch:number):void {
    this.acknowledged=Math.max(epoch,this.acknowledged);
    for(const [retiredAt,{track,timer}] of this.retired)if(retiredAt<=epoch){clearTimeout(timer);track.stop();this.retired.delete(retiredAt);}
    if(this.disposed&&epoch>=this.epoch)this.closed?.();
  }
  destroy():Promise<void> {
    if(this.closing)return this.closing;
    this.disposed=true;this.allowed=false;this.flush();
    this.closing=new Promise(resolve=>{
      const finish=()=>{clearTimeout(timer);this.closed=undefined;this.owned?.stop();this.owned=undefined;for(const {track,timer} of this.retired.values()){clearTimeout(timer);track.stop();}this.retired.clear();resolve();};
      // A hung Worker cannot retain capture indefinitely: only this controller owns the clone.
      const timer=setTimeout(finish,200);this.closed=finish;
      if(this.acknowledged>=this.epoch)finish();
    });
    return this.closing;
  }
}
/** Worker-owned capture and six PCM buffers. Recycling also goes directly back to this Worker. */
export class TrackCapture {
  private epoch=0;
  private allowed=false;
  private mode:GateMode='vad';
  private disposed=false;
  private reader?:CaptureReader;
  private readonly pool:Array<{id:number;pcm:Float32Array}>=Array.from({length:6},(_,id)=>({id,pcm:new Float32Array(480)}));
  private readonly partial=new Float32Array(480);
  private partialLength=0;
  private readonly flight=new Set<number>();
  constructor(private readonly send:(frame:AudioFrame)=>void,private readonly reset:(epoch:number,allowed:boolean,mode:GateMode)=>void,
    private readonly dropped:(count:number)=>void,private readonly fail:(error?:unknown)=>void){}
  async apply(control:CaptureControl):Promise<void> {
    if(this.disposed||control.epoch<=this.epoch){void control.stream?.cancel().catch(()=>{});return;}
    this.epoch=control.epoch;this.allowed=control.allowed;this.mode=control.mode;
    const epoch=this.epoch,old=this.reader;this.reader=undefined;const cancelled=old?.cancel().catch(()=>{});
    for(const frame of this.pool)frame.pcm.fill(0);
    this.partial.fill(0);this.partialLength=0;
    this.reset(epoch,this.allowed,this.mode);
    if(!this.allowed){await Promise.all([cancelled,control.stream?.cancel().catch(()=>{})]);return;}
    try{
      if(!control.stream)throw Error('Missing capture stream');
      const reader=this.reader=control.stream.getReader();
      void this.read(reader,epoch).catch(error=>{if(epoch===this.epoch&&!this.disposed)this.fail(error);});
    }catch(error){this.fail(error);}
    await cancelled;
  }
  recycle(frame:AudioFrame):void {
    if(!this.flight.delete(frame.id)||frame.pcm.length!==480)return;
    frame.pcm.fill(0);if(!this.disposed)this.pool.push({id:frame.id,pcm:frame.pcm});
  }
  private async read(reader:CaptureReader,epoch:number):Promise<void> {
    let start=0,expectedTimestamp:number|undefined,discontinuity=false;
    try{
      while(epoch===this.epoch&&!this.disposed){
        const {value,done}=await reader.read();
        if(done){if(epoch===this.epoch&&this.allowed&&!this.disposed)throw Error('Microphone capture ended');return;}
        try{
          if(epoch!==this.epoch||!this.allowed||this.disposed)continue;
          if(value.sampleRate!==48000||value.numberOfChannels!==1||value.numberOfFrames<=0||value.numberOfFrames>960||!Number.isFinite(value.timestamp))throw Error('Unsupported microphone frame format');
          const gap=expectedTimestamp===undefined?0:Math.round((value.timestamp-expectedTimestamp)*.048);
          expectedTimestamp=value.timestamp+value.numberOfFrames/48000*1e6;
          // Chromium rounds these timestamps to 100 us (about five samples).
          if(gap < -5){
            // Resuming a disabled Chromium source can switch from the silence clock back
            // to its capture clock. Rebase timestamps without replaying retained history.
            start+=this.partialLength;if(this.partialLength)this.dropped(1);
            this.partial.fill(0);this.partialLength=0;discontinuity=true;
          }
          if(gap>5){
            const missing=gap+this.partialLength;start+=missing;this.dropped(Math.ceil(missing/480));
            this.partial.fill(0);this.partialLength=0;discontinuity=true;
          }
          for(let offset=0;offset<value.numberOfFrames;){
            const count=Math.min(480-this.partialLength,value.numberOfFrames-offset);
            value.copyTo(this.partial.subarray(this.partialLength,this.partialLength+count),{planeIndex:0,format:'f32-planar',frameOffset:offset,frameCount:count});
            this.partialLength+=count;offset+=count;
            if(this.partialLength!==480)continue;
            const frame=this.pool.pop();
            if(frame){frame.pcm.set(this.partial);this.flight.add(frame.id);this.send({...frame,epoch,start,discontinuity});discontinuity=false;}
            else {this.dropped(1);discontinuity=true;}
            this.partial.fill(0);this.partialLength=0;start+=480;
          }
        }finally{value.close();}
      }
    }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  }
  async destroy():Promise<void> {const closed=this.apply({kind:'capture',epoch:this.epoch+1,allowed:false,mode:this.mode});this.disposed=true;await closed;}
}

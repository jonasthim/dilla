import type { AudioFrame } from './frame-bridge';
/** Bounded output for directly captured frames. Capture runs independently of the render clock. */
export class PlaybackBridge {
  private epoch=0;
  private allowed=false;
  private readonly output:AudioFrame[]=[];
  private position:number|null=null;
  private startupQuanta=0;
  readonly stats={buffers:0,underruns:0,dropped:0,lateFrames:0,backlogDropped:0,captureDropped:0,privacyDiscarded:0,processingMs:0,frames:0,processingHistogram:Array<number>(32).fill(0)};
  constructor(private readonly recycle:(frame:AudioFrame)=>void){}
  reset(epoch:number,allowed:boolean):void {
    this.epoch=epoch;this.allowed=allowed;this.position=null;this.startupQuanta=0;
    for(const frame of this.output.splice(0)){frame.pcm.fill(0);this.recycle(frame);}
  }
  captureDropped(epoch:number,count:number):void {
    if(!this.allowed||epoch!==this.epoch)return;
    this.stats.dropped+=count;this.stats.captureDropped+=count;
  }
  accept(frame:AudioFrame):void {
    if(frame.pcm.length!==480||!Number.isInteger(frame.start)||frame.start! < 0)return;
    this.stats.processingMs+=frame.processingMs??0;this.stats.frames++;
    this.stats.processingHistogram[Math.min(31,Math.floor((frame.processingMs??0)*2))]++;
    if(!this.allowed||frame.epoch!==this.epoch){frame.pcm.fill(0);this.recycle(frame);this.stats.privacyDiscarded++;return;}
    if(this.position!==null&&frame.start! < this.position){
      this.stats.dropped++;this.stats.lateFrames++;
      if(frame.start!+480<=this.position){this.recycle(frame);return;}
    }
    this.output.push(frame);
    // Do not let a slow render clock retain an ever-growing delay. Allow device callbacks to arrive in bursts, but cap
    // queued lead at 50 ms and restore the normal 30 ms lead after a stall; every skipped frame remains visible in health metrics.
    if(this.position!==null&&frame.start!>this.position+2400){
      const next=frame.start!-1440,count=Math.ceil((next-this.position)/480);this.stats.dropped+=count;this.stats.backlogDropped+=count;this.position=next;
    }
  }
  render(out:Float32Array):void {
    out.fill(0);if(!this.allowed)return;
    this.stats.buffers++;
    if(this.position===null){
      if(this.output.length<3)return;
      // Three 10 ms frames plus two 128-sample quanta leave scheduling headroom without
      // waiting for an entire fourth frame (and potentially another device callback).
      if(this.startupQuanta++<2)return;
      this.position=this.output[0].start!;
    }
    let wrote=0,missing=false;
    while(wrote<out.length&&this.output.length){
      const frame=this.output[0],target=this.position+wrote,start=frame.start!;
      if(start+480<=target){this.output.shift();this.recycle(frame);continue;}
      if(start>target){wrote+=Math.min(out.length-wrote,start-target);missing=true;continue;}
      const offset=target-start,count=Math.min(out.length-wrote,480-offset);
      out.set(frame.pcm.subarray(offset,offset+count),wrote);wrote+=count;
      if(offset+count===480){this.output.shift();this.recycle(frame);}
    }
    if(missing||wrote<out.length)this.stats.underruns++;
    this.position+=out.length;
  }
}

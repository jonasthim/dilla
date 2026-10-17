import {VoiceGate,type GateMode} from './gate';
/** DF3 already delays the waveform by three 10 ms frames. A one-frame-delayed raw
 * VAD decision opens 20 ms before the corresponding enhanced speech, so no second
 * onset buffer or additional audio delay is needed. Privacy epochs reset both paths. */
export class LookaheadGate {
  private gate:VoiceGate;
  private probability=0;
  private readonly output=new Float32Array(480);
  constructor(private mode:GateMode){this.gate=new VoiceGate({mode:mode==='ptt'?'open':mode});}
  setMode(mode:GateMode):void{this.mode=mode;this.reset();}
  reset():void{this.gate=new VoiceGate({mode:this.mode==='ptt'?'open':this.mode});this.probability=0;this.output.fill(0);}
  process(enhanced:Float32Array,rawProbability:number,nowMs:number):Float32Array{
    if(this.gate.update(this.probability,nowMs))this.output.set(enhanced);else this.output.fill(0);
    this.probability=rawProbability;return this.output;
  }
}

import { SampleRecording } from './sample-recording';
declare function registerProcessor(name: string, ctor: unknown): void;
declare abstract class AudioWorkletProcessor { readonly port: MessagePort }
class LocalRecorder extends AudioWorkletProcessor {
  private recording = new SampleRecording();
  private done = false;
  constructor() {
    super();
    this.port.onmessage = e => {
      if (e.data === 'finish') this.finish();
      if (e.data === 'discard') { this.done = true; this.recording.discard(); }
    };
  }
  private finish(): void {
    if (this.done) return;
    this.done = true; const pcm = this.recording.finish(); this.port.postMessage(pcm, [pcm.buffer]);
  }
  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (!this.done && input && !this.recording.append(input)) this.finish();
    // Output stays zero: nothing is played while the microphone is open.
    return !this.done;
  }
}
registerProcessor('dilla-local-recorder', LocalRecorder);

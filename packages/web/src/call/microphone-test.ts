import { Track } from 'livekit-client';
import { DillaMicrophoneProcessor, type NoisePreference, type ProcessorStatus } from '@dilla/media';
import { recordingWav } from '../../../media/src/audio/sample-recording';
/** A local recording owns its capture until it is released; its only output is an in-memory object URL. */
export class LocalMicrophoneTest {
  private closed = false;
  private finishing = false;
  private stream?: MediaStream;
  private processor?: DillaMicrophoneProcessor;
  private ctx?: AudioContext;
  private node?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private url?: string;
  private deadline?: ReturnType<typeof setTimeout>;
  private finishDeadline?: ReturnType<typeof setTimeout>;
  constructor(private readonly result: (url: string) => void, private readonly status: (s: ProcessorStatus) => void, private readonly failed: () => void = () => {}) {}
  async start(input: string, preference: NoisePreference): Promise<void> {
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.setup(input, preference), new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => { void this.close(); reject(new Error('Microphone test setup timed out')); }, 15_000);
      })]);
    } finally { clearTimeout(watchdog); }
  }
  private async setup(input: string, preference: NoisePreference): Promise<void> {
    // Start/resume inside the explicit button press before awaiting microphone permission.
    const ctx = this.ctx = new AudioContext({sampleRate:48000,latencyHint:'interactive'});
    const resumed = ctx.resume();
    void resumed.catch(() => undefined);
    try {
      const stream = this.stream = await navigator.mediaDevices.getUserMedia({audio:{deviceId: input ? {exact:input} : undefined,echoCancellation:true,autoGainControl:true,noiseSuppression:false,channelCount:1,sampleRate:48000}});
      if (this.closed) { await this.release(); return; }
      await resumed;
      if (this.closed) { await this.release(); return; }
      const processor = this.processor = new DillaMicrophoneProcessor({preference,mode:'open',allowed:true,onStatus:this.status});
      await processor.init({track:stream.getAudioTracks()[0],kind:Track.Kind.Audio,audioContext:ctx});
      if (this.closed) { await this.release(); return; }
      await ctx.audioWorklet.addModule((await import('../../../media/src/audio/record-worklet.ts?worker&url')).default);
      if (this.closed) { await this.release(); return; }
      this.node = new AudioWorkletNode(ctx,'dilla-local-recorder',{channelCount:1,channelCountMode:'explicit',outputChannelCount:[1]});
      this.node.port.onmessage = e => { void this.complete(e.data as Float32Array); };
      this.node.onprocessorerror = () => { void this.close(); this.failed(); };
      this.source = ctx.createMediaStreamSource(new MediaStream([processor.processedTrack!]));
      this.source.connect(this.node); this.node.connect(ctx.destination);
      // Also stop a suspended/interrupted context; the audio thread independently caps recorded samples.
      this.deadline = setTimeout(() => this.stop(),10_000);
    } catch (error) { await this.close(); throw error; }
  }
  stop(): void {
    if (this.closed || this.finishing || this.finishDeadline) return;
    // Capture ends independently of the audio thread answering the final-buffer request.
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.processor?.processedTrack?.stop();
    this.source?.disconnect();
    clearTimeout(this.deadline);
    this.node?.port.postMessage('finish');
    this.finishDeadline = setTimeout(() => { void this.close(); this.failed(); }, 1000);
  }
  private async complete(pcm: Float32Array): Promise<void> {
    if (this.closed || this.finishing) { pcm.fill(0); return; }
    this.finishing = true;
    await this.release(); // All capture is stopped before exposing anything for playback.
    if (this.closed) { pcm.fill(0); return; }
    const bytes = recordingWav(pcm.subarray(0,480_000)); pcm.fill(0);
    this.url = URL.createObjectURL(new Blob([bytes],{type:'audio/wav'})); bytes.fill(0);
    this.result(this.url);
  }
  private async release(): Promise<void> {
    clearTimeout(this.deadline); clearTimeout(this.finishDeadline);
    const stream = this.stream, processor = this.processor, ctx = this.ctx, node = this.node, source = this.source;
    this.stream = undefined; this.processor = undefined; this.ctx = undefined; this.node = undefined; this.source = undefined;
    for (const track of stream?.getTracks() ?? []) track.stop();
    node?.port.postMessage('discard'); source?.disconnect(); node?.disconnect();
    await Promise.allSettled([processor?.destroy(), ctx?.state !== 'closed' ? ctx?.close() : undefined]);
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.url) URL.revokeObjectURL(this.url); this.url = undefined;
    await this.release();
  }
}

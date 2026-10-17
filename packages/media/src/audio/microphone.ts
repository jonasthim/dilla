import { Track, type AudioProcessorOptions, type TrackProcessor } from 'livekit-client';
import { DillaRnnoiseProcessor, type RnnoiseProcessorOptions } from './rnnoise';
import type { GateMode } from './gate';
export type NoisePreference = 'automatic' | 'lightweight' | 'off';
export type BrowserNoise = 'on' | 'off' | 'unsupported' | 'unknown';
export interface ProcessorStatus {
  requested: NoisePreference;
  engineName?: string;
  effective: 'initializing' | 'rnnoise' | 'browser' | 'off';
  reason: 'not-qualified' | 'initialization-failed' | 'browser-refused' | 'processor-error' | 'audio-suspended' | null;
  browserNoise: BrowserNoise;
  vad: 'rnnoise' | 'unavailable';
}
/** No automatic migration until the separately recorded qualification passes. */
export function noisePreference(value: string | undefined): NoisePreference {
  return value === 'automatic' || value === 'off' ? value : 'lightweight';
}
/** Never infer successful constraint application merely because its Promise resolved. */
export async function setBrowserSuppression(track: MediaStreamTrack, enabled: boolean): Promise<BrowserNoise> {
  const supported = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices?.getSupportedConstraints?.().noiseSuppression;
  if (supported === false) return 'unsupported';
  try { await track.applyConstraints({ ...track.getConstraints(), noiseSuppression: enabled, echoCancellation: true, autoGainControl: true }); } catch { /* inspect actual settings below */ }
  const actual = track.getSettings?.().noiseSuppression;
  return actual === true ? 'on' : actual === false ? 'off' : 'unknown';
}
interface InnerProcessor extends TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  setPttActive(active: boolean): void;
  setCaptureAllowed?(allowed: boolean): void;
  setMode?(mode: GateMode): void;
  flush?(): void;
  useBrowserFallback?(): void;
}
export interface MicrophoneOptions {
  preference: NoisePreference;
  mode?: GateMode;
  allowed?: boolean;
  onStatus?(status: ProcessorStatus): void;
  createLightweight?(options: RnnoiseProcessorOptions): InnerProcessor;
}
/** Production selection contains no imports of unqualified engines or their assets. */
export class DillaMicrophoneProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = 'dilla-microphone';
  processedTrack?: MediaStreamTrack;
  status: ProcessorStatus;
  private inner?: InnerProcessor;
  private track?: MediaStreamTrack;
  private fallbackTrack?: MediaStreamTrack;
  private replacement?: MediaStream;
  private allowed: boolean;
  private mode: GateMode;
  private generation = 0;
  private downgraded = false;
  constructor(private readonly options: MicrophoneOptions) {
    this.allowed = options.allowed ?? false; this.mode = options.mode ?? 'vad';
    this.status = { requested: options.preference, effective: 'initializing', reason: null, browserNoise: 'unknown', vad: 'unavailable' };
  }
  private report(patch: Partial<ProcessorStatus>): void { this.status = { ...this.status, ...patch }; this.options.onStatus?.(this.status); }
  /** Chromium can fix NS for a capture's lifetime. Reopen the same device only after the engine is ready. */
  private async capture(track: MediaStreamTrack, enabled: boolean, generation: number): Promise<{track: MediaStreamTrack; noise: BrowserNoise}> {
    const noise = await setBrowserSuppression(track, enabled);
    const deviceId = track.getSettings?.().deviceId;
    if (generation !== this.generation || noise === (enabled ? 'on' : 'off') || noise === 'unsupported' || !deviceId || typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return {track,noise};
    let abandoned = false, timer: ReturnType<typeof setTimeout> | undefined;
    const pending = navigator.mediaDevices.getUserMedia({audio:{...track.getConstraints(), deviceId:{exact:deviceId}, channelCount:1, sampleRate:48000, noiseSuppression:enabled, echoCancellation:true, autoGainControl:true}}).then(stream => {
      for (const t of stream.getTracks()) t.enabled = false;
      if (abandoned || generation !== this.generation) { for (const t of stream.getTracks()) t.stop(); throw Error('Capture cancelled'); }
      return stream;
    });
    try {
      const stream = await Promise.race([pending, new Promise<never>((_,reject) => {timer=setTimeout(()=>reject(Error('Capture timeout')),10_000);})]);
      const next = stream.getAudioTracks()[0];
      if (!next || next.getSettings().noiseSuppression !== enabled) { for (const t of stream.getTracks()) t.stop(); return {track,noise}; }
      this.releaseReplacement(); this.replacement = stream;
      return {track:next,noise:enabled?'on':'off'};
    } catch { return {track,noise}; }
    finally { abandoned=true;clearTimeout(timer); }
  }
  private releaseReplacement(): void { for (const track of this.replacement?.getTracks() ?? []) track.stop(); this.replacement=undefined; }
  async init(opts: AudioProcessorOptions): Promise<void> {
    const generation = ++this.generation; this.track = opts.track;
    const inner = (this.options.createLightweight ?? (o => new DillaRnnoiseProcessor(o)))({ mode: this.mode, allowed: this.allowed, denoise: this.options.preference !== 'off', onFailure: reason => { void this.fallback(reason === 'audio-suspended' ? reason : 'processor-error'); } });
    this.inner = inner;
    try {
      await inner.init(opts);
      if (generation !== this.generation) { await inner.destroy(); return; }
      const capture = await this.capture(opts.track, false, generation);
      if (generation !== this.generation) return;
      const browserNoise = capture.noise;
      if (capture.track !== opts.track) await inner.restart({...opts,track:capture.track});
      if (generation !== this.generation) return;
      if (this.options.preference !== 'off' && (browserNoise === 'on' || browserNoise === 'unknown')) {
        await inner.destroy(); this.inner = undefined; this.processedTrack = this.fallbackTrack = opts.track.clone();
        this.report({ effective: 'browser', reason: 'browser-refused', browserNoise: await setBrowserSuppression(opts.track, true), vad: 'unavailable' });
      } else {
        this.processedTrack = inner.processedTrack;
        this.report({ engineName: 'RNNoise', effective: this.options.preference === 'off' ? 'off' : 'rnnoise', browserNoise, vad: 'rnnoise', reason: this.options.preference === 'automatic' ? 'not-qualified' : browserNoise === 'on' || browserNoise === 'unknown' ? 'browser-refused' : null });
      }
    } catch {
      await inner.destroy().catch(() => undefined);
      if (generation !== this.generation) return;
      this.inner = undefined; this.releaseReplacement();
      const off = this.options.preference === 'off';
      const capture = await this.capture(opts.track, !off, generation);
      if (generation !== this.generation) return;
      const browserNoise = capture.noise;
      this.processedTrack = this.fallbackTrack = capture.track.clone();
      this.report({ effective: off ? 'off' : 'browser', reason: 'initialization-failed', browserNoise, vad: 'unavailable' });
    }
    this.setCaptureAllowed(this.allowed);
  }
  private async fallback(reason: ProcessorStatus['reason']): Promise<void> {
    if (this.downgraded || !this.track || this.status.effective === 'initializing') return;
    this.downgraded = true;
    const generation = this.generation;
    const off = this.options.preference === 'off';
    this.inner?.setCaptureAllowed?.(false); this.inner?.flush?.();
    const capture = await this.capture(this.track, !off, generation);
    if (generation !== this.generation) return;
    const browserNoise = capture.noise;
    await this.inner?.restart({track:capture.track,kind:Track.Kind.Audio} as AudioProcessorOptions);
    if (generation !== this.generation) return;
    if (capture.track === this.track) this.releaseReplacement();
    this.inner?.useBrowserFallback?.(); this.setCaptureAllowed(this.allowed);
    this.report({ effective: off ? 'off' : 'browser', browserNoise, reason, vad: 'unavailable' });
  }
  async restart(opts: AudioProcessorOptions): Promise<void> {
    const generation = ++this.generation;
    this.inner?.setCaptureAllowed?.(false); this.inner?.flush?.(); this.track = opts.track;
    const capture = await this.capture(opts.track, this.status.effective === 'browser', generation);
    if (generation !== this.generation) return;
    await this.inner?.restart({...opts,track:capture.track});
    if (generation !== this.generation) return;
    if (capture.track === opts.track) this.releaseReplacement();
    if (!this.inner) { this.fallbackTrack?.stop(); this.processedTrack = this.fallbackTrack = capture.track.clone(); }
    const browserNoise = capture.noise;
    this.report({ browserNoise }); this.setCaptureAllowed(this.allowed);
    if (this.status.effective === 'rnnoise' && (browserNoise === 'on' || browserNoise === 'unknown')) await this.fallback('browser-refused');
  }
  setCaptureAllowed(allowed: boolean): void {
    this.allowed = allowed;
    this.inner?.setCaptureAllowed?.(allowed);
    if (this.track) this.track.enabled = allowed;
    for (const track of this.replacement?.getTracks() ?? []) track.enabled = allowed;
    if (this.processedTrack) this.processedTrack.enabled = allowed;
  }
  setPttActive(active: boolean): void { this.inner?.setPttActive(active); }
  setMode(mode: GateMode): void { this.mode = mode; this.inner?.setMode?.(mode); }
  flush(): void { this.inner?.flush?.(); }
  async destroy(): Promise<void> {
    ++this.generation; this.setCaptureAllowed(false); this.releaseReplacement();
    await this.inner?.destroy(); this.fallbackTrack?.stop(); this.fallbackTrack = undefined; this.inner = undefined; this.track = undefined; this.processedTrack = undefined;
  }
}

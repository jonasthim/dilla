import { Track, type AudioProcessorOptions, type TrackProcessor } from 'livekit-client';
import { DillaRnnoiseProcessor, type RnnoiseProcessorOptions } from './rnnoise';
import type { GateMode } from './gate';
import { createEnhanced } from './enhanced-provider';
import { noiseBuildMode, type NoisePreference } from './noise-preference';
export { noisePreference, type NoisePreference } from './noise-preference';
export type BrowserNoise = 'on' | 'off' | 'unsupported' | 'unknown';
export interface ProcessorStatus {
  requested: NoisePreference;
  engineName?: string;
  effective: 'initializing' | 'failed' | 'deepfilter' | 'rnnoise' | 'browser' | 'off';
  reason: 'fallback-failed' | 'evaluation' | 'enhanced-failed' | 'sustained-overload' | 'repeated-underruns' | 'not-qualified' | 'initialization-failed' | 'browser-refused' | 'processor-error' | 'audio-suspended' | null;
  browserNoise: BrowserNoise;
  vad: 'rnnoise' | 'unavailable';
}
/** Never infer successful constraint application merely because its Promise resolved. */
export async function setBrowserSuppression(track: MediaStreamTrack, enabled: boolean): Promise<BrowserNoise> {
  const supported = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices?.getSupportedConstraints?.().noiseSuppression;
  if (supported === false) return 'unsupported';
  try { await track.applyConstraints({ ...track.getConstraints(), noiseSuppression: enabled, echoCancellation: true, autoGainControl: true }); } catch { /* inspect actual settings below */ }
  const actual = track.getSettings?.().noiseSuppression;
  return actual === true ? 'on' : actual === false ? 'off' : 'unknown';
}
export interface InnerProcessor extends TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  setPttActive(active: boolean): void;
  setCaptureAllowed?(allowed: boolean): void;
  setMode?(mode: GateMode): void;
  flush?(): void;
  useBrowserFallback?(): void;
}
export interface EnhancedOptions extends RnnoiseProcessorOptions {
  onMetrics?(metrics: Record<string, unknown>): void;
  onEffective?(effective: 'deepfilter' | 'rnnoise', reason: ProcessorStatus['reason']): void;
}
export interface MicrophoneOptions {
  preference: NoisePreference;
  mode?: GateMode;
  allowed?: boolean;
  onStatus?(status: ProcessorStatus): void;
  createEnhanced?(options: EnhancedOptions): Promise<InnerProcessor | null>;
  createLightweight?(options: RnnoiseProcessorOptions): InnerProcessor;
}
/** Shared by calls and the local microphone test; enhancement is enabled by the audited build gate. */
export class DillaMicrophoneProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = 'dilla-microphone';
  processedTrack?: MediaStreamTrack;
  status: ProcessorStatus;
  private inner?: InnerProcessor;
  private track?: MediaStreamTrack;
  private fallbackTrack?: MediaStreamTrack;
  private replacement?: MediaStream;
  private allowed: boolean;
  private ptt = false;
  private mode: GateMode;
  private generation = 0;
  private downgraded = false;
  private fallingBack = false;
  private restarting = 0;
  private pendingFallback: ProcessorStatus['reason'] | undefined;
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
    let effective: 'deepfilter' | 'rnnoise' = 'rnnoise';
    let reason: ProcessorStatus['reason'] = this.options.preference === 'automatic' ? 'not-qualified' : null;
    const innerOptions: EnhancedOptions = { mode: this.mode, allowed: this.allowed, denoise: this.options.preference !== 'off',
      onFailure: failure => { void this.fallback(failure === 'audio-suspended' ? failure : 'processor-error'); },
      onEffective: (next, why) => { effective = next; reason = why; if (this.status.effective !== 'initializing') this.report({effective:next, engineName: next === 'deepfilter' ? 'DeepFilterNet3' : 'RNNoise', reason:why}); },
    };
    let inner: InnerProcessor | undefined;
    try {
      if (this.options.preference === 'automatic') {
        try {
          inner = await (this.options.createEnhanced ?? createEnhanced)(innerOptions) ?? undefined;
          if (inner) {
            this.inner = inner;
            await inner.init(opts);
            effective = 'deepfilter'; reason = noiseBuildMode === 'evaluation' ? 'evaluation' : null;
          }
        } catch {
          await inner?.destroy().catch(() => undefined); inner = undefined; reason = 'enhanced-failed';
        }
      }
      if (generation !== this.generation) { await inner?.destroy(); return; }
      if (!inner) {
        inner = (this.options.createLightweight ?? (o => new DillaRnnoiseProcessor(o)))(innerOptions);
        this.inner = inner;
        await inner.init(opts);
      }
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
        this.report({ engineName: effective === 'deepfilter' ? 'DeepFilterNet3' : 'RNNoise', effective: this.options.preference === 'off' ? 'off' : effective, browserNoise, vad: 'rnnoise', reason: browserNoise === 'on' || browserNoise === 'unknown' ? 'browser-refused' : reason });
      }
    } catch {
      await inner?.destroy().catch(() => undefined);
      if (generation !== this.generation) return;
      this.inner = undefined; this.releaseReplacement();
      const off = this.options.preference === 'off';
      const capture = await this.capture(opts.track, !off, generation);
      if (generation !== this.generation) return;
      const browserNoise = capture.noise;
      this.processedTrack = this.fallbackTrack = capture.track.clone();
      this.report({ effective: off ? 'off' : 'browser', reason: 'initialization-failed', browserNoise, vad: 'unavailable' });
    }
    this.inner?.setMode?.(this.mode); this.inner?.setPttActive(this.ptt);
    this.setCaptureAllowed(this.allowed);
  }
  private async fallback(reason: ProcessorStatus['reason']): Promise<void> {
    if (this.downgraded || !this.track || this.status.effective === 'initializing') return;
    this.pendingFallback = reason;
    if (this.fallingBack || this.restarting > 0) return;
    this.fallingBack = true;
    const generation = this.generation;
    try {
      const off = this.options.preference === 'off';
      this.inner?.setCaptureAllowed?.(false); this.inner?.flush?.();
      if (this.processedTrack) this.processedTrack.enabled = false;
      const capture = await this.capture(this.track, !off, generation);
      if (generation !== this.generation) return;
      this.inner?.useBrowserFallback?.();
      await this.inner?.restart({track:capture.track,kind:Track.Kind.Audio} as AudioProcessorOptions);
      if (generation !== this.generation) return;
      if (capture.track === this.track) this.releaseReplacement();
      this.downgraded = true; this.pendingFallback = undefined;
      this.report({ effective: off ? 'off' : 'browser', browserNoise: capture.noise, reason, vad: 'unavailable' });
      this.setCaptureAllowed(this.allowed);
    } catch {
      if (generation === this.generation) {
        this.inner?.setCaptureAllowed?.(false);
        if (this.processedTrack) this.processedTrack.enabled = false;
        this.report({effective:'failed',reason:'fallback-failed',vad:'unavailable'});
      }
    } finally {
      this.fallingBack = false;
      // A device change supersedes capture, not the requested one-way downgrade.
      if (generation !== this.generation && this.track && this.pendingFallback !== undefined) void this.fallback(this.pendingFallback);
    }
  }
  async restart(opts: AudioProcessorOptions): Promise<void> {
    const generation = ++this.generation;
    this.restarting++;
    try {
    this.inner?.setCaptureAllowed?.(false); this.inner?.flush?.(); this.track = opts.track;
    const capture = await this.capture(opts.track, this.status.effective === 'browser', generation);
    if (generation !== this.generation) return;
    await this.inner?.restart({...opts,track:capture.track});
    if (generation !== this.generation) return;
    if (capture.track === opts.track) this.releaseReplacement();
    if (!this.inner) { this.fallbackTrack?.stop(); this.processedTrack = this.fallbackTrack = capture.track.clone(); }
    const browserNoise = capture.noise;
    this.report({ browserNoise }); this.setCaptureAllowed(this.allowed);
    if (this.pendingFallback !== undefined) await this.fallback(this.pendingFallback);
    if ((this.status.effective === 'rnnoise' || this.status.effective === 'deepfilter') && (browserNoise === 'on' || browserNoise === 'unknown')) await this.fallback('browser-refused');
    } finally {
      this.restarting--;
      if (this.restarting === 0 && this.track && this.pendingFallback !== undefined) await this.fallback(this.pendingFallback);
    }
  }
  setCaptureAllowed(allowed: boolean): void {
    this.allowed = allowed;
    const send = allowed && this.status.effective !== 'failed' && (this.mode !== 'ptt' || this.ptt);
    this.inner?.setCaptureAllowed?.(send);
    if (this.track) this.track.enabled = send;
    for (const track of this.replacement?.getTracks() ?? []) track.enabled = send;
    if (this.processedTrack) this.processedTrack.enabled = send;
  }
  setPttActive(active: boolean): void { this.ptt = active; this.inner?.setPttActive(active); this.setCaptureAllowed(this.allowed); }
  setMode(mode: GateMode): void { this.mode = mode; this.inner?.setMode?.(mode); this.setCaptureAllowed(this.allowed); }
  flush(): void { this.inner?.flush?.(); }
  async destroy(): Promise<void> {
    ++this.generation; this.pendingFallback = undefined; this.setCaptureAllowed(false); this.releaseReplacement();
    await this.inner?.destroy(); this.fallbackTrack?.stop(); this.fallbackTrack = undefined; this.inner = undefined; this.track = undefined; this.processedTrack = undefined;
  }
}

// The Playwright media harness: one livekit-client 2.22.3 Room per page, driven through
// window.harness by e2e/media and e2e/spikes. e2ee 'stub' wires StubE2EEManager and the stub
// worker; task 17 adds 'dilla' (the real manager).
import {
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  createLocalAudioTrack,
  createLocalVideoTrack,
  type RemoteTrack,
  type RoomOptions,
} from 'livekit-client';
import { StubE2EEManager, type AttachPath } from './stub-manager.ts';

export type StubMode =
  | { kind: 'pass' }
  | { kind: 'xor'; keyPrefix: number; deltaPrefix: number; sframeLayout: boolean }
  | { kind: 'drop'; ms: number }
  | { kind: 'log-h264' }
  | { kind: 'count-sif' };

export interface RemoteTrackStats {
  participantIdentity: string; kind: 'audio' | 'video'; source: string; framesDecoded: number; keyFramesDecoded: number;
  packetsReceived: number; totalSamplesReceived: number; pliCount: number;
}
export interface RenderProbe { participantIdentity: string; kind: 'audio' | 'video'; frames: number; rms: number }
export interface HarnessApi {
  connect(url: string, token: string, opts: { e2ee: 'none' | 'stub'; attach?: AttachPath; stub?: StubMode; iceServers?: RTCIceServer[] }): Promise<void>;
  publish(what: { mic?: boolean; camera?: boolean; screen?: boolean; canvasScreen?: boolean; videoCodec?: 'vp8' | 'h264' | 'vp9'; simulcast?: boolean }): Promise<void>;
  remoteStats(): Promise<RemoteTrackStats[]>;
  renderProbe(ms: number): Promise<RenderProbe[]>;
  stubStats(): Promise<Record<string, number>>;
  disconnect(): Promise<void>;
}

const worker = new Worker(new URL('./stub-worker.ts', import.meta.url), { type: 'module', name: 'dilla-stub-worker' });
let room: Room | undefined;
let statsId = 0;
const pendingStats = new Map<number, (s: Record<string, number>) => void>();
worker.onmessage = (ev: MessageEvent<{ kind: string; id: number; stats: Record<string, number> }>) => {
  if (ev.data.kind === 'stats') { pendingStats.get(ev.data.id)?.(ev.data.stats); pendingStats.delete(ev.data.id); }
};

const elements = new Map<RemoteTrack, HTMLMediaElement>();

function mustRoom(): Room {
  if (!room) throw new Error('harness: connect first');
  return room;
}

/** Chromium has createEncodedStreams and livekit-client uses it there (DEV-28 a); Firefox does not. */
function defaultAttach(): AttachPath {
  return 'createEncodedStreams' in RTCRtpSender.prototype ? 'streams' : 'script';
}

const harness: HarnessApi = {
  async connect(url, token, opts) {
    const options: RoomOptions = { adaptiveStream: false, dynacast: false };
    if (opts.e2ee === 'stub') {
      options.e2ee = { e2eeManager: new StubE2EEManager(worker, opts.attach ?? defaultAttach()) };
      worker.postMessage({ kind: 'mode', mode: opts.stub ?? { kind: 'pass' } });
    }
    const r = new Room(options);
    r.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      const el = track.attach();
      el.muted = track.kind === Track.Kind.Video;
      el.autoplay = true;
      document.getElementById('media')?.append(el);
      elements.set(track, el);
    });
    if (opts.e2ee === 'stub') await r.setE2EEEnabled(true);
    // iceServers always set: [] replaces LiveKit's server list, so no browser asks a public STUN
    // server anything (DEV-52); max-bundle gives one transport from the first offer (DEV-54).
    await r.connect(url, token, { rtcConfig: { iceServers: opts.iceServers ?? [], bundlePolicy: 'max-bundle' } });
    room = r;
  },

  async publish(what) {
    const r = mustRoom();
    const video = { videoCodec: what.videoCodec ?? 'vp8', simulcast: what.simulcast ?? false } as const;
    if (what.mic) {
      const mic = await createLocalAudioTrack({ echoCancellation: false, noiseSuppression: false, autoGainControl: false });
      await r.localParticipant.publishTrack(mic, { source: Track.Source.Microphone });
    }
    if (what.camera) {
      const cam = await createLocalVideoTrack({ resolution: VideoPresets.h360.resolution });
      await r.localParticipant.publishTrack(cam, { source: Track.Source.Camera, ...video });
    }
    if (what.screen) {
      // getDisplayMedia needs transient activation: the spec calls activate(page) first.
      if (navigator.userActivation && !navigator.userActivation.isActive) {
        throw new Error('publish({screen}) without transient user activation: call activate(page) from e2e/media/support/lk.ts first');
      }
      await r.localParticipant.setScreenShareEnabled(true, { audio: false, contentHint: 'detail' }, video);
    }
    if (what.canvasScreen) {
      // Firefox headless never resolves getDisplayMedia (G35 Q2): a moving canvas stands in for the
      // screen-share slot.
      const canvas = document.createElement('canvas');
      canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext('2d');
      let n = 0;
      setInterval(() => { if (ctx) { ctx.fillStyle = `hsl(${(n++ * 7) % 360} 60% 50%)`; ctx.fillRect(0, 0, 640, 360); } }, 50);
      const track = canvas.captureStream(20).getVideoTracks()[0];
      await r.localParticipant.publishTrack(track, { source: Track.Source.ScreenShare, ...video });
    }
  },

  async remoteStats() {
    const out: RemoteTrackStats[] = [];
    for (const p of mustRoom().remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) {
        const track = pub.track;
        if (!track) continue;
        const report = await track.getRTCStatsReport();
        let s: Record<string, number> = {};
        report?.forEach((v: { type: string } & Record<string, number>) => { if (v.type === 'inbound-rtp') s = v; });
        out.push({
          participantIdentity: p.identity, kind: track.kind === Track.Kind.Audio ? 'audio' : 'video', source: pub.source,
          framesDecoded: s.framesDecoded ?? 0, keyFramesDecoded: s.keyFramesDecoded ?? 0, packetsReceived: s.packetsReceived ?? 0,
          totalSamplesReceived: s.totalSamplesReceived ?? 0, pliCount: s.pliCount ?? 0,
        });
      }
    }
    return out;
  },

  // Firefox resets a receiver's inbound-rtp when a transform is assigned, so the Firefox-safe
  // observables are rendered output: requestVideoFrameCallback counts and AnalyserNode RMS (DEV-63).
  async renderProbe(ms) {
    const ctx = new AudioContext();
    await ctx.resume();
    const probes = [...elements.entries()].map(([track, el]) => {
      const participant = [...mustRoom().remoteParticipants.values()].find((p) => [...p.trackPublications.values()].some((pub) => pub.track === track));
      const probe: RenderProbe = { participantIdentity: participant?.identity ?? '', kind: track.kind === Track.Kind.Audio ? 'audio' : 'video', frames: 0, rms: 0 };
      let stop = () => {};
      if (track.kind === Track.Kind.Video) {
        const v = el as HTMLVideoElement;
        let live = true;
        const tick = () => { if (!live) return; probe.frames++; v.requestVideoFrameCallback(tick); };
        v.requestVideoFrameCallback(tick);
        stop = () => { live = false; };
      } else {
        const analyser = ctx.createAnalyser();
        ctx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack])).connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        const timer = setInterval(() => {
          analyser.getFloatTimeDomainData(buf);
          const rms = Math.sqrt(buf.reduce((a, x) => a + x * x, 0) / buf.length);
          probe.rms = Math.max(probe.rms, rms);
        }, 20);
        stop = () => clearInterval(timer);
      }
      return { probe, stop };
    });
    await new Promise((r) => setTimeout(r, ms));
    for (const p of probes) p.stop();
    await ctx.close();
    return probes.map((p) => p.probe);
  },

  stubStats() {
    const id = ++statsId;
    return new Promise((resolve) => { pendingStats.set(id, resolve); worker.postMessage({ kind: 'stats', id }); });
  },

  async disconnect() {
    await room?.disconnect();
    room = undefined;
  },
};

(window as unknown as { harness: HarnessApi }).harness = harness;
document.getElementById('ready')?.removeAttribute('hidden');

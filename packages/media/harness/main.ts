// The Playwright media harness: one livekit-client 2.22.3 Room per page, driven through
// window.harness by e2e/media and e2e/spikes. e2ee 'stub' wires StubE2EEManager and the stub
// worker; 'dilla' runs the real DillaE2EEManager and dilla-media worker through joinCall (task 17).
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
import { runFailClosed, type FailClosedResult, type FailClosedScenario } from './failclosed.ts';
import { joinCall, type CallSession, type IceServerTuple, type JoinCallOptions } from '../src/connect';
import type { EpochKeys } from '../src/manager';
import type { DillaMediaStats } from '../src/protocol';
import { hexToBytes, isDeviceIdentity } from '../src/slots';

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
  connect(url: string, token: string, opts: { e2ee: 'none' | 'stub' | 'dilla'; attach?: AttachPath; stub?: StubMode; iceServers?: RTCIceServer[]; dilla?: DillaConnectOptions }): Promise<void>;
  publish(what: { mic?: boolean; camera?: boolean; screen?: boolean; canvasScreen?: boolean; videoCodec?: 'vp8' | 'h264' | 'vp9'; simulcast?: boolean }): Promise<void>;
  remoteStats(): Promise<RemoteTrackStats[]>;
  renderProbe(ms: number): Promise<RenderProbe[]>;
  stubStats(): Promise<Record<string, number>>;
  disconnect(): Promise<void>;
  installEpoch(k: EpochKeysWire): Promise<void>;
  mediaStats(): Promise<DillaMediaStats>;
  session(): CallSession | null;
  /** Task 17 fix round 1: the real manager and worker on a loopback PeerConnection pair (harness/failclosed.ts). */
  failClosed(sc: FailClosedScenario): Promise<FailClosedResult>;
}

const worker = new Worker(new URL('./stub-worker.ts', import.meta.url), { type: 'module', name: 'dilla-stub-worker' });
let room: Room | undefined;
let statsId = 0;
const pendingStats = new Map<number, (s: Record<string, number>) => void>();
worker.onmessage = (ev: MessageEvent<{ kind: string; id: number; stats: Record<string, number> }>) => {
  if (ev.data.kind === 'stats') { pendingStats.get(ev.data.id)?.(ev.data.stats); pendingStats.delete(ev.data.id); }
};

const elements = new Map<RemoteTrack, HTMLMediaElement>();

function attachElement(track: RemoteTrack): void {
  const el = track.attach();
  el.muted = track.kind === Track.Kind.Video;
  el.autoplay = true;
  document.getElementById('media')?.append(el);
  elements.set(track, el);
}

function mustRoom(): Room {
  if (!room) throw new Error('harness: connect first');
  return room;
}

/** Chromium has createEncodedStreams and livekit-client uses it there (DEV-28 a); Firefox does not. */
function defaultAttach(): AttachPath {
  return 'createEncodedStreams' in RTCRtpSender.prototype ? 'streams' : 'script';
}

// ---- task 17: e2ee 'dilla', the real DillaE2EEManager through joinCall (MD-20: decimal epochs and hex keys on the
// Playwright boundary, because page.evaluate cannot carry bigint) -------------------------------------------------
export interface EpochKeysWire { groupId: string; epoch: string; baseKey: string; selfLeaf: number; minEpoch: string; roster: Array<{ leaf: number; deviceId: string }> }
export interface DillaConnectOptions { epoch: EpochKeysWire; lock: { instanceId: string; callGroupId: string }; roomOptions?: JoinCallOptions['roomOptions'] }

export function epochFromWire(w: EpochKeysWire): EpochKeys {
  if (!/^[0-9a-f]{32}$/.test(w.baseKey) || !w.roster.every((r) => isDeviceIdentity(r.deviceId))) throw new Error('E_BAD_OPTIONS: epoch keys');
  return {
    groupId: w.groupId, epoch: BigInt(w.epoch), baseKey: hexToBytes(w.baseKey), selfLeaf: w.selfLeaf, minEpoch: BigInt(w.minEpoch),
    roster: w.roster.map((r) => ({ leaf: r.leaf, deviceId: r.deviceId })),
  };
}

function iceTuples(list: RTCIceServer[] = []): IceServerTuple[] {
  return list.map((s) => [Array.isArray(s.urls) ? s.urls : [s.urls], s.username ?? '', typeof s.credential === 'string' ? s.credential : '']);
}

let dillaSession: CallSession | null = null;

async function connectDilla(url: string, token: string, iceServers: RTCIceServer[] | undefined, dilla: DillaConnectOptions | undefined): Promise<CallSession> {
  if (dilla === undefined) throw new Error("E_BAD_OPTIONS: e2ee 'dilla' needs opts.dilla");
  dillaSession = await joinCall({ livekitUrl: url, token, iceServers: iceTuples(iceServers), epoch: epochFromWire(dilla.epoch), lock: dilla.lock, roomOptions: dilla.roomOptions });
  return dillaSession;
}

async function installEpochWire(w: EpochKeysWire): Promise<void> {
  if (dillaSession === null) throw new Error('E_NO_EPOCH: no dilla session');
  await dillaSession.manager.installEpoch(epochFromWire(w));
}

async function mediaStats(): Promise<DillaMediaStats> {
  if (dillaSession === null) throw new Error('E_NO_EPOCH: no dilla session');
  return dillaSession.manager.stats();
}

const harness: HarnessApi = {
  async connect(url, token, opts) {
    if (opts.e2ee === 'dilla') {
      // joinCall builds and connects the Room itself, so the element wiring runs after it and also picks up the
      // tracks subscribed while joinCall waited for the local participant to become encrypted.
      const r = (await connectDilla(url, token, opts.iceServers, opts.dilla)).room;
      r.on(RoomEvent.TrackSubscribed, attachElement);
      for (const p of r.remoteParticipants.values()) {
        for (const pub of p.trackPublications.values()) if (pub.track !== undefined && !elements.has(pub.track)) attachElement(pub.track);
      }
      room = r;
      return;
    }
    const options: RoomOptions = { adaptiveStream: false, dynacast: false };
    if (opts.e2ee === 'stub') {
      options.e2ee = { e2eeManager: new StubE2EEManager(worker, opts.attach ?? defaultAttach()) };
      worker.postMessage({ kind: 'mode', mode: opts.stub ?? { kind: 'pass' } });
    }
    const r = new Room(options);
    r.on(RoomEvent.TrackSubscribed, attachElement);
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
    if (dillaSession !== null) {
      const s = dillaSession;
      dillaSession = null;
      room = undefined;
      await s.release();
      return;
    }
    await room?.disconnect();
    room = undefined;
  },

  installEpoch: installEpochWire,
  mediaStats,
  session: () => dillaSession,
  failClosed: runFailClosed,
};

(window as unknown as { harness: HarnessApi }).harness = harness;
document.getElementById('ready')?.removeAttribute('hidden');

// ---- task 19: adapters over the single task 17 dilla join path (task 21 extends this block) ----
import * as dillaLk from 'livekit-client';
import { MIC as DILLA_MIC, MIC_CAPTURE as DILLA_MIC_CAPTURE, decodeCaps as dillaDecodeCaps, publishDefaults as dillaPublishDefaults } from '../src/audio/presets';
import { DillaRnnoiseProcessor, type RnnoiseProbe as DillaRnnoiseProbe } from '../src/audio/rnnoise';

export type EpochWire = EpochKeysWire;

export interface DillaHarness {
  dillaJoin(o: { livekitUrl: string; token: string; iceServers: Array<[string[], string, string]>; epoch: EpochWire; caps?: [number, number, number] }): Promise<void>;
  dillaInstall(k: EpochWire): Promise<void>;
  dillaStats(): Promise<DillaMediaStats>;
  dillaPublishMic(): Promise<void>;
  dillaSetProcessor(): Promise<{ processedTrackId: string; senderIsProcessed: boolean }>;
  dillaRestartMic(): Promise<{ processedTrackId: string; senderIsProcessed: boolean }>;
  rnnoiseProbe(): Promise<DillaRnnoiseProbe & { lostQuanta: number }>;
  selectedPairs(): Promise<string[]>;
  dillaLeave(): Promise<void>;
}

const dillaPcs: RTCPeerConnection[] = [];
{
  const Native = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends Native {
    constructor(config?: RTCConfiguration) {
      super(config);
      dillaPcs.push(this);
    }
  } as typeof RTCPeerConnection;
}

let dillaMic: dillaLk.LocalAudioTrack | null = null;
let dillaProcessor: DillaRnnoiseProcessor | null = null;

function dillaBase(): HarnessApi {
  return (window as unknown as { harness: HarnessApi }).harness;
}

function dillaRoom(): dillaLk.Room {
  if (!dillaSession) throw new Error('dillaJoin first');
  return dillaSession.room;
}

function dillaMicState(): { processedTrackId: string; senderIsProcessed: boolean } {
  const processed = dillaProcessor?.processedTrack;
  if (!dillaMic || !processed) throw new Error('no processed mic');
  return { processedTrackId: processed.id, senderIsProcessed: dillaMic.sender?.track === processed };
}

const dillaHarness: DillaHarness = {
  async dillaJoin(o) {
    const caps = dillaDecodeCaps(o.caps ?? [64_000, 2_500_000, 0]);
    await dillaBase().connect(o.livekitUrl, o.token, {
      e2ee: 'dilla',
      iceServers: o.iceServers.map(([urls, username, credential]) => ({ urls, username, credential })),
      dilla: {
        epoch: o.epoch,
        lock: { instanceId: 'dilla-e2e', callGroupId: o.epoch.groupId },
        roomOptions: { publishDefaults: dillaPublishDefaults(caps), adaptiveStream: false, dynacast: false },
      },
    });
  },
  async dillaInstall(k) {
    await dillaBase().installEpoch(k);
  },
  async dillaStats() {
    return dillaBase().mediaStats();
  },
  async dillaPublishMic() {
    const room = dillaRoom();
    const [track] = await room.localParticipant.createTracks({ audio: DILLA_MIC_CAPTURE });
    dillaMic = track as dillaLk.LocalAudioTrack;
    await room.localParticipant.publishTrack(dillaMic, DILLA_MIC);
  },
  async dillaSetProcessor() {
    if (!dillaMic) throw new Error('dillaPublishMic first');
    dillaProcessor = new DillaRnnoiseProcessor();
    await dillaMic.setProcessor(dillaProcessor);
    return dillaMicState();
  },
  async dillaRestartMic() {
    if (!dillaMic) throw new Error('dillaPublishMic first');
    await dillaMic.restartTrack(DILLA_MIC_CAPTURE);
    return dillaMicState();
  },
  async rnnoiseProbe() {
    const ctx = new AudioContext({ sampleRate: 48_000 });
    const osc = ctx.createOscillator();
    const dest = ctx.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    const p = new DillaRnnoiseProcessor();
    await p.init({ kind: dillaLk.Track.Kind.Audio, track: dest.stream.getAudioTracks()[0], audioContext: ctx });
    const probe = await p.probe();
    await p.destroy();
    await ctx.close();
    const quantumMs = (128 / 48_000) * 1000;
    return { ...probe, lostQuanta: Math.ceil(probe.ctorMs / quantumMs) };
  },
  async selectedPairs() {
    const out: string[] = [];
    for (const pc of dillaPcs) {
      const stats = await pc.getStats();
      const byId = new Map<string, Record<string, unknown>>();
      stats.forEach((s: Record<string, unknown>) => byId.set(s.id as string, s));
      for (const s of byId.values()) {
        if (s.type !== 'candidate-pair' || s.state !== 'succeeded' || s.nominated !== true) continue;
        const l = byId.get(s.localCandidateId as string);
        const r = byId.get(s.remoteCandidateId as string);
        out.push(`local ${l?.candidateType} ${l?.address}:${l?.port} -> remote ${r?.candidateType} ${r?.address}:${r?.port}`);
      }
    }
    return out;
  },
  async dillaLeave() {
    await dillaBase().disconnect();
    dillaMic = null;
    dillaProcessor = null;
  },
};

Object.assign((window as unknown as { harness: object }).harness, dillaHarness);

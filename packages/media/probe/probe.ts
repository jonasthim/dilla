// L-PROBE-1: the network probe page. It loads one start JSON (`dilla-testkit netprobe start`), joins the call through
// @dilla/media's joinCall on a button press, publishes a synthetic 440 Hz tone (no microphone), samples getStats() and
// the media worker's counters every second, and offers the report as a JSON download.
import { RoomEvent, Track, type LocalAudioTrack } from 'livekit-client';
import { joinCall, type CallSession, type IceServerTuple } from '../src/connect';
import type { EpochKeys } from '../src/manager';
import { decodeCaps, micOptions, publishDefaults } from '../src/audio/presets';
import { hexToBytes, isDeviceIdentity } from '../src/slots';
import {
  candidatesFromStats, pairFromStats, rtpFromStats, summariseRun, total,
  type ProbeEvent, type ProbePair, type ProbeReport, type ProbeSample, type RtpTotals,
} from './report';

/** What `netprobe start` writes. */
interface StartJson {
  v: 1;
  livekitUrl: string;
  token: string;
  iceServers: IceServerTuple[];
  callId: string;
  groupId: string;
  keys: { epoch: string; baseKeyHex: string; selfLeaf: number; roster: { leaf: number; deviceId: string }[] };
}

const AFTER_SILENCE_MS = 15_000;
const params = new URLSearchParams(location.search);
function seconds(name: string, min: number, max: number, fallback: number): number {
  const n = Number(params.get(name));
  return Number.isInteger(n) && n >= min && n <= max ? n * 1000 : fallback * 1000;
}
// 60 s of samples and a 45 s silence by default; ?seconds=N and ?silence=N shorten them for the automated check.
const RUN_MS = seconds('seconds', 5, 600, 60);
const SILENCE_MS = seconds('silence', 1, 120, 45);

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (e === null) throw new Error(`#${id} is missing`);
  return e as T;
}

const fileInput = el<HTMLInputElement>('file');
const labelInput = el<HTMLInputElement>('label');
const startButton = el<HTMLButtonElement>('start');
const silenceButton = el<HTMLButtonElement>('silence');
const downloadButton = el<HTMLButtonElement>('download');
const statusLine = el<HTMLParagraphElement>('status');
const pairLine = el<HTMLParagraphElement>('pair');
const tableBody = el<HTMLTableSectionElement>('rows');

// Every RTCPeerConnection LiveKit opens (publisher and subscriber), for getStats() and the ICE state.
const pcs: RTCPeerConnection[] = [];
const events: ProbeEvent[] = [];
let t0 = 0;
function now(): number {
  return Math.round(performance.now() - t0);
}
function note(what: string): void {
  if (t0 !== 0) events.push({ t: now(), what });
}
{
  const Native = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends Native {
    constructor(config?: RTCConfiguration) {
      super(config);
      const index = pcs.push(this) - 1;
      this.addEventListener('iceconnectionstatechange', () => note(`pc${index} ice ${this.iceConnectionState}`));
    }
  } as typeof RTCPeerConnection;
}

// Made at load so the automated check can read its state before Start; resumed by the Start press (user activation).
const audio = new AudioContext({ sampleRate: 48_000 });

let start: StartJson | null = null;
let running = false;
let report: ProbeReport | null = null;
let failure: string | null = null;
let micTrack: LocalAudioTrack | null = null;
let endAt = 0;

function status(text: string): void {
  statusLine.textContent = text;
}

function parseStart(text: string): StartJson {
  const j = JSON.parse(text) as StartJson;
  const ok = j?.v === 1 && typeof j.livekitUrl === 'string' && typeof j.token === 'string' && Array.isArray(j.iceServers)
    && /^[0-9a-f]{32}$/.test(j.groupId) && /^[0-9]+$/.test(j.keys?.epoch ?? '') && /^[0-9a-f]{32}$/.test(j.keys?.baseKeyHex ?? '')
    && Number.isInteger(j.keys.selfLeaf) && Array.isArray(j.keys.roster)
    && j.keys.roster.every((r) => Number.isInteger(r.leaf) && isDeviceIdentity(r.deviceId));
  if (!ok) throw new Error('this is not a netprobe start JSON');
  return j;
}

function epochKeys(j: StartJson): EpochKeys {
  const epoch = BigInt(j.keys.epoch);
  return {
    groupId: j.groupId, epoch, baseKey: hexToBytes(j.keys.baseKeyHex), selfLeaf: j.keys.selfLeaf, minEpoch: epoch,
    roster: j.keys.roster.map((r) => ({ leaf: r.leaf, deviceId: r.deviceId })),
  };
}

fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f === undefined) return;
  void f.text().then((text) => {
    try {
      start = parseStart(text);
      status(`loaded ${f.name}: press Start within 30 s of netprobe start`);
    } catch (err) {
      start = null;
      status(`${f.name}: ${(err as Error).message}`);
    }
  });
});

function iceState(): string {
  const states = pcs.map((pc) => pc.iceConnectionState);
  if (states.includes('failed')) return 'failed';
  if (states.some((s) => s === 'connected' || s === 'completed')) return 'connected';
  return states.at(-1) ?? 'new';
}

/** The PC that carries the received audio (LiveKit's subscriber), else any. */
async function mediaStats(): Promise<{ media: RTCStatsReport | null; all: RTCStatsReport[] }> {
  const all = await Promise.all(pcs.map((pc) => pc.getStats()));
  let media: RTCStatsReport | null = null;
  for (const s of all) {
    let inbound = false;
    s.forEach((r: { type?: string; kind?: string }) => { if (r.type === 'inbound-rtp' && r.kind === 'audio') inbound = true; });
    if (inbound) media = s;
  }
  return { media: media ?? all.find((s) => pairFromStats(s) !== null) ?? null, all };
}

function cell(row: HTMLTableRowElement, text: string): void {
  const td = document.createElement('td');
  td.textContent = text;
  row.append(td);
}

function showSample(s: ProbeSample): void {
  const row = document.createElement('tr');
  for (const v of [String(s.t / 1000), s.rttMs?.toFixed(1) ?? '-', String(s.packetsReceived), String(s.packetsLost),
    s.jitterMs?.toFixed(1) ?? '-', String(s.verifiedRemote), String(s.decryptDrops)]) cell(row, v);
  tableBody.append(row);
}

function showPair(p: ProbePair | null): void {
  // The address stays in the downloaded JSON only: the screen shows types, protocol and port.
  pairLine.textContent = p === null ? 'pair: none' : `pair: local ${p.local} → remote ${p.remote} over ${p.protocol}`
    + `${p.relayProtocol === null ? '' : `, relay over ${p.relayProtocol}`}, remote port ${p.remotePort}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function run(j: StartJson): Promise<void> {
  running = true;
  report = null;
  failure = null;
  events.length = 0;
  tableBody.replaceChildren();
  t0 = performance.now();
  const startedAt = new Date().toISOString();
  note('start pressed');
  await audio.resume();
  note(`audio ${audio.state}`);
  const osc = audio.createOscillator();
  osc.frequency.value = 440;
  const gain = audio.createGain();
  gain.gain.value = 0.2;
  const dest = audio.createMediaStreamDestination();
  osc.connect(gain).connect(dest);
  osc.start();

  let session: CallSession | null = null;
  // null when the join failed: the `join failed` event carries when it gave up.
  let connected: number | null = null;
  let firstVerified: number | null = null;
  const samples: ProbeSample[] = [];
  const totals: RtpTotals = new Map();
  let pair: ProbePair | null = null;
  let candidates: { type: string; protocol: string }[] = [];
  let joined = false;
  try {
    status('joining');
    const caps = decodeCaps([64_000, 2_500_000, 0]);
    session = await joinCall({
      livekitUrl: j.livekitUrl, token: j.token, iceServers: j.iceServers, epoch: epochKeys(j),
      // Per leaf, not per origin: pair O puts both sides in two windows of one browser on the laptop.
      lock: { instanceId: `netprobe-leaf-${j.keys.selfLeaf}`, callGroupId: j.groupId },
      roomOptions: { publishDefaults: publishDefaults(caps), adaptiveStream: false },
      initTimeoutMs: 60_000,
    });
    const connectedAt = now();
    connected = connectedAt;
    joined = true;
    note('connected');
    const room = session.room;
    room.on(RoomEvent.Reconnecting, () => note('room reconnecting'));
    room.on(RoomEvent.Reconnected, () => note('room reconnected'));
    room.on(RoomEvent.SignalReconnecting, () => note('signal reconnecting'));
    room.on(RoomEvent.Disconnected, () => note('room disconnected'));
    const pub = await room.localParticipant.publishTrack(dest.stream.getAudioTracks()[0], { ...micOptions(caps), source: Track.Source.Microphone });
    micTrack = (pub.track as LocalAudioTrack | undefined) ?? null;
    note('tone published');
    silenceButton.disabled = false;
    endAt = connectedAt + RUN_MS;
    status(`measuring for ${RUN_MS / 1000} s`);
    let nextSample = now();
    while (now() < endAt) {
      if (firstVerified === null) {
        const m = await session.manager.stats();
        if (total(m.verified) > 0) {
          firstVerified = now();
          note('first verified remote frame');
        }
      }
      if (now() >= nextSample) {
        nextSample += 1000;
        const [{ media, all }, m] = await Promise.all([mediaStats(), session.manager.stats()]);
        const rtp = rtpFromStats(media ?? (new Map() as unknown as RTCStatsReport), totals);
        const s: ProbeSample = { t: now(), ...rtp, verifiedRemote: total(m.verified), decryptDrops: total(m.dropped) };
        samples.push(s);
        showSample(s);
        pair = (media === null ? null : pairFromStats(media)) ?? pair;
        candidates = all.flatMap((r) => candidatesFromStats(r));
        showPair(pair);
      }
      await sleep(firstVerified === null ? 200 : 250);
    }
  } catch (err) {
    failure = (err as Error).message ?? String(err);
    note(`join failed: ${failure}`);
    const all = await Promise.all(pcs.map((pc) => pc.getStats())).catch(() => []);
    candidates = all.flatMap((r) => candidatesFromStats(r));
  } finally {
    silenceButton.disabled = true;
    micTrack = null;
    // A joinCall that never connected counts as failed ICE: LiveKit gives up (peerConnectionTimeout) before
    // Chromium reports `failed`, and either way nothing carried media.
    const ice = joined ? iceState() : 'failed';
    if (session !== null) {
      // Which reasons the decrypt drops had, for the spike document's notes.
      const m = await session.manager.stats().catch(() => null);
      const reasons = Object.entries(m?.dropped ?? {}).filter(([, n]) => n > 0);
      if (reasons.length > 0) note(`drops ${reasons.map(([r, n]) => `${r} ${n}`).join(', ')}`);
    }
    await session?.release().catch(() => undefined);
    osc.stop();
    pcs.length = 0;
    const measured = summariseRun({ iceState: ice, candidates, samples, pair });
    report = {
      v: 1, label: labelInput.value || 'probe', ua: navigator.userAgent, startedAt,
      joinMs: { connected, firstVerifiedRemote: firstVerified },
      ...measured,
      events: [...events],
    };
    const s = report.summary;
    status(`done${failure === null ? '' : ` (join failed: ${failure})`}: loss ${s.lossPct.toFixed(2)} %, rtt p50 ${s.rttP50Ms ?? '-'} ms, `
      + `jitter p50 ${s.jitterP50Ms ?? '-'} ms, relay unavailable ${s.relayUnavailable ? 'yes' : 'no'}`);
    downloadButton.disabled = false;
    running = false;
  }
}

startButton.addEventListener('click', () => {
  if (running) return;
  if (start === null) {
    status('load a start JSON first');
    return;
  }
  downloadButton.disabled = true;
  void run(start);
});

silenceButton.addEventListener('click', () => {
  const track = micTrack;
  if (track === null) return;
  silenceButton.disabled = true;
  // No RTP at all for 45 s (DTX alone still sends comfort noise): leg 3's idle path through the UDP forward.
  void track.pauseUpstream().then(() => {
    note('silence start');
    endAt = Math.max(endAt, now() + SILENCE_MS + AFTER_SILENCE_MS);
    status(`silent for ${SILENCE_MS / 1000} s`);
    setTimeout(() => {
      void track.resumeUpstream().then(() => {
        note('silence end');
        status('tone resumed');
      });
    }, SILENCE_MS);
  });
});

downloadButton.addEventListener('click', () => {
  if (report === null) return;
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `netprobe-${report.label}-${report.startedAt.replace(/[:.]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// For the automated check (e2e/probe/probe.spec.ts).
(window as unknown as { __probe: object }).__probe = {
  audioState: (): string => audio.state,
  report: (): ProbeReport | null => report,
  failure: (): string | null => failure,
};

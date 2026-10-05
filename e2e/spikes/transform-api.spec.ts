// SP-01 (task 14): which transform API the dilla media worker uses on Chromium under livekit-client's
// forced encodedInsertableStreams flag, and where a receiver transform must be attached on Firefox.
// Spike code (MD-17): runs only under the spike-chromium / spike-firefox projects, never in CI.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { _electron, chromium, expect, firefox, test, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activate, debugToken } from '../media/support/lk.ts';

const CONTROL = 'http://127.0.0.1:8444';
// The harness Vite server's root is packages/media/harness, so its page is served at "/".
const HARNESS = 'http://127.0.0.1:5179/';
const UMD = fileURLToPath(new URL('../../node_modules/livekit-client/dist/livekit-client.umd.js', import.meta.url));
const RESULTS = fileURLToPath(new URL('../test-results/spikes/', import.meta.url));
const ELECTRON = '/usr/bin/electron44';
const CHROMIUM_ARGS = ['--use-fake-device-for-media-stream=fps=30', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
const FIREFOX_PREFS = {
  'media.navigator.streams.fake': true,
  'media.navigator.permission.disabled': true,
  'media.devices.unfocused.enabled': true,
  'media.autoplay.default': 0,
  'media.autoplay.block-webaudio': false,
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function record(name: string, data: unknown): void {
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(joinPath(RESULTS, `${name}.json`), JSON.stringify(data, null, 2));
  console.log(`SPIKE ${name} ${JSON.stringify(data)}`);
}

// ---- the spike rig (identical in transform-api, keyframe-recovery and sfu-injected) ----------------

// Runs inside a dedicated worker created from a Blob. Toy cipher: clear prefix (Opus 0, VP8 key 10,
// VP8 delta 1), every other byte XORed with a keystream seeded by a random per-frame nonce, then
// nonce(4) || "DLA1". The SIF trailer is tested before anything else (DEV-13 order).
function spikeWorker(): void {
  const MARK = [0x44, 0x4c, 0x41, 0x31];
  const S: any = {
    enc: 0, dec: 0, frames: 0, dropNoMarker: 0, dropMode: 0, held: 0, released: 0, keyIn: 0,
    sif: 0, sifAudio: 0, sifVideo: 0, sifVideoKey: 0, sifLen: 0, plainOpusSilence: 0, retargets: 0,
    kfr: [] as any[], pipeErrors: [] as string[], byTrack: {} as Record<string, any>,
  };
  (globalThis as any).__spikeStats = S;
  let mode: any = { kind: 'normal', media: 'video', until: 0 };
  let sif = new Uint8Array(0);
  const decoders: any[] = [];
  const ks = (i: number, seed: number): number => {
    let x = (seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0;
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5;
    return (x >>> 0) & 0xff;
  };
  const tailEq = (d: Uint8Array, t: ArrayLike<number>): boolean => {
    if (t.length === 0 || d.length < t.length) return false;
    const o = d.length - t.length;
    for (let i = 0; i < t.length; i++) if (d[o + i] !== t[i]) return false;
    return true;
  };
  const clear = (kind: string, type: string | undefined, n: number): number => (kind === 'audio' ? 0 : Math.min(n, type === 'key' ? 10 : 1));
  const track = (id: string): any => (S.byTrack[id] ??= { frames: 0, dec: 0, sif: 0, noMarker: 0, plainSilence: 0 });
  function encode(frame: any, c: any, st: any): void {
    const d = new Uint8Array(frame.data);
    const p = clear(st.opts.kind, frame.type, d.length);
    const nonce = (Math.random() * 0x100000000) >>> 0;
    const out = new Uint8Array(d.length + 8);
    out.set(d.subarray(0, p));
    for (let i = p; i < d.length; i++) out[i] = d[i] ^ ks(i, nonce);
    out[d.length] = nonce >>> 24; out[d.length + 1] = (nonce >>> 16) & 0xff;
    out[d.length + 2] = (nonce >>> 8) & 0xff; out[d.length + 3] = nonce & 0xff;
    out.set(MARK, d.length + 4);
    frame.data = out.buffer;
    S.enc++;
    c.enqueue(frame);
  }
  function flush(st: any): void {
    while (st.queue.length > 0) { st.controller.enqueue(st.queue.shift()); S.released++; S.dec++; }
  }
  function decode(frame: any, c: any, st: any): void {
    const d = new Uint8Array(frame.data);
    const kind = st.opts.kind;
    const t = track(st.opts.trackId);
    S.frames++; t.frames++;
    if (kind === 'video' && frame.type === 'key') S.keyIn++;
    if (tailEq(d, sif)) {
      S.sif++; t.sif++;
      if (kind === 'audio') S.sifAudio++; else { S.sifVideo++; if (frame.type === 'key') S.sifVideoKey++; }
      return;
    }
    if (d.length < 8 || !tailEq(d, MARK)) {
      S.dropNoMarker++; t.noMarker++;
      if (kind === 'audio' && d[0] === 0xf8 && d[1] === 0xff && d[2] === 0xfe) { S.plainOpusSilence++; t.plainSilence++; }
      return;
    }
    const n = d.length - 8;
    const nonce = ((d[n] << 24) | (d[n + 1] << 16) | (d[n + 2] << 8) | d[n + 3]) >>> 0;
    const p = clear(kind, frame.type, n);
    const out = new Uint8Array(n);
    out.set(d.subarray(0, p));
    for (let i = p; i < n; i++) out[i] = d[i] ^ ks(i, nonce);
    frame.data = out.buffer;
    const applies = mode.media === kind && Date.now() < mode.until;
    if (applies && mode.kind === 'drop') { S.dropMode++; return; }
    if (applies && mode.kind === 'hold') { st.queue.push(frame); S.held++; return; }
    flush(st);
    S.dec++; t.dec++;
    c.enqueue(frame);
  }
  function setup(opts: any, readable: ReadableStream, writable: WritableStream, transformer: any): void {
    const st: any = { opts, transformer, controller: null, queue: [] };
    if (opts.side === 'decode') decoders.push(st);
    readable
      .pipeThrough(new TransformStream({
        start(c) { st.controller = c; },
        transform(frame, c) { if (opts.side === 'encode') encode(frame, c, st); else decode(frame, c, st); },
      }))
      .pipeTo(writable)
      .catch((e) => { S.pipeErrors.push(String(e)); });
  }
  setInterval(() => { if (mode.kind === 'hold' && Date.now() >= mode.until) for (const st of decoders) flush(st); }, 5);
  (self as any).onmessage = (e: MessageEvent) => {
    const m = e.data;
    if (m.kind === 'attach') setup(m.opts, m.readable, m.writable, null);
    else if (m.kind === 'retarget') S.retargets++;
    else if (m.kind === 'sif') { sif = new Uint8Array(m.trailer); S.sifLen = sif.length; }
    else if (m.kind === 'mode') mode = { kind: m.mode.kind, media: m.mode.media ?? 'video', until: Date.now() + m.mode.ms };
    else if (m.kind === 'kfr') {
      for (const st of decoders) {
        if (st.opts.kind !== 'video' || st.transformer === null) continue;
        const at = Date.now();
        st.transformer.sendKeyFrameRequest().then(
          () => S.kfr.push({ trackId: st.opts.trackId, ok: true, at, ms: Date.now() - at }),
          (err: any) => S.kfr.push({ trackId: st.opts.trackId, ok: false, at, name: err?.name, message: err?.message }),
        );
      }
    } else if (m.kind === 'stats') (self as any).postMessage({ kind: 'stats', stats: S });
  };
  if ((self as any).RTCTransformEvent) {
    (self as any).onrtctransform = (e: any) => { const t = e.transformer; setup(t.options, t.readable, t.writable, t); };
  }
}

// Runs in the page (after the UMD bundle). Defines window.rig.
function installRig(workerSrc: string): void {
  const LK = (window as any).LivekitClient;
  const workerUrl = URL.createObjectURL(new Blob([`(${workerSrc})()`], { type: 'text/javascript' }));
  const rig: any = { owners: {}, attachLog: [], observers: [], room: null, mgr: null, worker: null, actx: null };
  // Plain objects, no classes: Playwright's Babel transform may turn class fields into helper calls,
  // and a function serialised by page.evaluate cannot reach helpers defined in the spec module.
  const emitter = (): any => {
    const l = new Map<string, Array<(...a: any[]) => void>>();
    return {
      on(e: string, f: (...a: any[]) => void): any { const a = l.get(e) ?? []; a.push(f); l.set(e, a); return this; },
      off(e: string, f: (...a: any[]) => void): any { l.set(e, (l.get(e) ?? []).filter((x) => x !== f)); return this; },
      emit(e: string, ...a: any[]): boolean { for (const f of l.get(e) ?? []) f(...a); return true; },
      removeAllListeners(): any { l.clear(); return this; },
    };
  };
  const spikeManager = (worker: Worker, cfg: { api: 'streams' | 'script'; attachAt: 'mediaTrackAdded' | 'trackSubscribed' }): any => {
    const attached = new WeakMap<object, string>();
    const engines = new WeakSet<object>();
    const m: any = emitter();
    m.isEnabled = false;
    m.errors = [] as string[];
    m.room = null;
    Object.defineProperty(m, 'isDataChannelEncryptionEnabled', {
      get: (): boolean => false,
      set: (v: boolean): void => { if (v) throw new Error('spike: no data-channel encryption'); },
    });
    m.attach = (side: 'encode' | 'decode', rtp: any, trackId: string, kind: string): void => {
      const opts = { side, trackId, kind };
      try {
        if (cfg.api === 'streams') {
          if (attached.has(rtp)) worker.postMessage({ kind: 'retarget', opts });
          else {
            const { readable, writable } = rtp.createEncodedStreams();
            worker.postMessage({ kind: 'attach', opts, readable, writable }, [readable, writable]);
          }
        } else {
          rtp.transform = new (window as any).RTCRtpScriptTransform(worker, opts);
        }
        attached.set(rtp, trackId);
        rig.attachLog.push({ side, kind, trackId, at: Date.now() });
      } catch (e: any) {
        m.errors.push(`${side} ${e?.name}: ${e?.message}`);
      }
    };
    m.setParticipantCryptorEnabled = (enabled: boolean, id: string): void => {
      if (enabled && !m.isEnabled && m.room !== null && id === m.room.localParticipant.identity) {
        m.isEnabled = true;
        m.emit('participantEncryptionStatusChanged', true, m.room.localParticipant);
      }
    };
    m.setup = (room: any): void => {
      m.room = room;
      room.on(LK.RoomEvent.SignalConnected, () => m.setParticipantCryptorEnabled(true, room.localParticipant.identity));
      room.on(LK.RoomEvent.TrackSubscribed, (track: any, _pub: any, p: any) => {
        rig.owners[track.mediaStreamID] = p.identity;
        if (cfg.attachAt === 'trackSubscribed') m.attach('decode', track.receiver, track.mediaStreamID, track.kind);
      });
      room.localParticipant.on(LK.ParticipantEvent.LocalSenderCreated, (sender: any, track: any) =>
        m.attach('encode', sender, track.mediaStreamID, track.kind));
    };
    m.setupEngine = (engine: any): void => {
      if (engines.has(engine)) return;
      engines.add(engine);
      engine.on(LK.EngineEvent.MediaTrackAdded, (track: MediaStreamTrack, _stream: MediaStream, receiver: any) => {
        if (cfg.attachAt === 'mediaTrackAdded') m.attach('decode', receiver, track.id, track.kind);
      });
    };
    m.setSifTrailer = (t: Uint8Array): void => { if (t && t.length > 0) worker.postMessage({ kind: 'sif', trailer: t.slice() }); };
    m.encryptData = async (): Promise<never> => { throw new Error('spike: no data encryption'); };
    m.handleEncryptedData = async (): Promise<never> => { throw new Error('spike: no data encryption'); };
    return m;
  };
  rig.observe = (track: MediaStreamTrack): void => {
    const o: any = { id: track.id, kind: track.kind, t0: Date.now(), frames: 0, firstAt: null, loud: 0, firstLoudAt: null, samples: [] };
    rig.observers.push(o);
    if (track.kind === 'video') {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.autoplay = true;
      v.srcObject = new MediaStream([track]);
      document.body.append(v);
      void v.play().catch(() => undefined);
      const cb = (): void => { o.frames++; if (o.firstAt === null) o.firstAt = Date.now() - o.t0; v.requestVideoFrameCallback(cb); };
      v.requestVideoFrameCallback(cb);
    } else {
      const a = document.createElement('audio');
      a.autoplay = true;
      a.srcObject = new MediaStream([track]);
      document.body.append(a);
      void a.play().catch(() => undefined);
      rig.actx ??= new AudioContext();
      const an = rig.actx.createAnalyser();
      an.fftSize = 1024;
      rig.actx.createMediaStreamSource(new MediaStream([track])).connect(an);
      const buf = new Float32Array(an.fftSize);
      setInterval(() => {
        an.getFloatTimeDomainData(buf);
        let s = 0;
        for (const x of buf) s += x * x;
        if (Math.sqrt(s / buf.length) > 0.01) { o.loud++; if (o.firstLoudAt === null) o.firstLoudAt = Date.now() - o.t0; }
      }, 20);
    }
    setInterval(() => o.samples.push([Date.now() - o.t0, o.frames, o.loud]), 250);
  };
  rig.join = async (o: any): Promise<string> => {
    const opts: any = { adaptiveStream: false, dynacast: false };
    if (o.e2ee) {
      rig.worker = new Worker(workerUrl);
      rig.mgr = spikeManager(rig.worker, { api: o.api ?? 'streams', attachAt: o.attachAt ?? 'mediaTrackAdded' });
      opts.e2ee = { e2eeManager: rig.mgr };
    }
    const room = new LK.Room(opts);
    rig.room = room;
    room.engine.on(LK.EngineEvent.MediaTrackAdded, (track: MediaStreamTrack) => rig.observe(track));
    if (o.e2ee) await room.setE2EEEnabled(true);
    await room.connect(o.url, o.token, { rtcConfig: { iceServers: [], bundlePolicy: 'max-bundle' } });
    if (o.mic) await room.localParticipant.setMicrophoneEnabled(true, { echoCancellation: false, noiseSuppression: false, autoGainControl: false });
    if (o.camera) {
      await room.localParticipant.setCameraEnabled(true, { resolution: { width: 320, height: 240, frameRate: 30 } }, { videoCodec: o.codec ?? 'vp8', simulcast: false });
    }
    return room.localParticipant.identity;
  };
  rig.leave = async (): Promise<void> => {
    await rig.room?.disconnect();
    rig.worker?.terminate();
    rig.room = null; rig.mgr = null; rig.worker = null;
  };
  rig.mode = (m: any): void => rig.worker.postMessage({ kind: 'mode', mode: m });
  rig.kfr = (): void => rig.worker.postMessage({ kind: 'kfr' });
  rig.workerStats = (): Promise<any> => new Promise((resolve) => {
    const h = (e: MessageEvent): void => {
      if (e.data?.kind === 'stats') { rig.worker.removeEventListener('message', h); resolve(e.data.stats); }
    };
    rig.worker.addEventListener('message', h);
    rig.worker.postMessage({ kind: 'stats' });
  });
  rig.rtc = async (): Promise<any> => {
    const out: any = { t: Date.now(), remotes: [], local: [] };
    if (rig.room === null) return out;
    for (const p of rig.room.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) {
        const t = pub.track;
        if (!t) continue;
        const rep = await t.getRTCStatsReport();
        let inb: any = null;
        rep?.forEach((s: any) => { if (s.type === 'inbound-rtp') inb = s; });
        out.remotes.push({
          from: p.identity, kind: t.kind, source: pub.source, id: t.mediaStreamID,
          framesDecoded: inb?.framesDecoded ?? 0, keyFramesDecoded: inb?.keyFramesDecoded ?? 0, pliCount: inb?.pliCount ?? 0,
          totalSamplesReceived: inb?.totalSamplesReceived ?? 0, packetsReceived: inb?.packetsReceived ?? 0, freezeCount: inb?.freezeCount ?? 0,
        });
      }
    }
    for (const pub of rig.room.localParticipant.trackPublications.values()) {
      const t = pub.track;
      if (!t) continue;
      const rep = await t.getRTCStatsReport();
      rep?.forEach((s: any) => {
        if (s.type === 'outbound-rtp') {
          out.local.push({ kind: t.kind, source: pub.source, rid: s.rid ?? null, pliCount: s.pliCount ?? 0,
            keyFramesEncoded: s.keyFramesEncoded ?? 0, framesEncoded: s.framesEncoded ?? 0, packetsSent: s.packetsSent ?? 0 });
        }
      });
    }
    return out;
  };
  rig.sample = async (ms: number, every: number): Promise<any[]> => {
    const out: any[] = [];
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { out.push(await rig.rtc()); await new Promise((r) => setTimeout(r, every)); }
    return out;
  };
  rig.stats = async (): Promise<any> => ({
    ...(await rig.rtc()),
    worker: rig.worker === null ? null : await rig.workerStats(),
    errors: rig.mgr?.errors ?? [],
    attachLog: rig.attachLog,
    owners: rig.owners,
    observers: rig.observers.map((o: any) => ({ id: o.id, kind: o.kind, frames: o.frames, firstAt: o.firstAt, loud: o.loud, firstLoudAt: o.firstLoudAt, samples: o.samples })),
  });
  (window as any).rig = rig;
}

async function openRig(page: Page): Promise<void> {
  await page.goto(HARNESS);
  await page.addScriptTag({ path: UMD });
  await page.evaluate(installRig, spikeWorker.toString());
}

async function join(page: Page, room: string, identity: string, o: Record<string, unknown>): Promise<void> {
  const { url, token } = await debugToken(CONTROL, room, identity, true);
  await page.evaluate((a) => (window as any).rig.join(a), { url, token, ...o });
}

// ---- end of the rig ------------------------------------------------------------------------------

interface Row {
  phase: string;
  pairsDecoding: string;      // "<ok>/<expected>" encrypted member→member tracks whose counters rose in the phase
  canaryRendered: number;     // framesDecoded + totalSamplesReceived of the canary's tracks, summed over the members
  canaryDropped: number;      // worker dropNoMarker summed over the members
  invalidState: number;       // InvalidStateError seen in the pages or caught by the rig manager
  errors: string[];
  screenDecoding?: string;
}

type Pages = Record<'A' | 'B' | 'C' | 'D', Page>;
const MEMBERS = ['A', 'B', 'C'] as const;

async function snapshot(pages: Pages, phase: string, prev: Map<string, number>, pageErrors: string[]): Promise<Row> {
  let ok = 0;
  let expected = 0;
  let canaryRendered = 0;
  let canaryDropped = 0;
  const errors: string[] = [];
  for (const m of MEMBERS) {
    const s = await pages[m].evaluate(() => (window as any).rig.stats());
    canaryDropped += s.worker?.dropNoMarker ?? 0;
    errors.push(...s.errors.map((e: string) => `${m}: ${e}`), ...(s.worker?.pipeErrors ?? []).map((e: string) => `${m} pipe: ${e}`));
    for (const r of s.remotes) {
      if (r.from === 'D') { canaryRendered += r.framesDecoded + r.totalSamplesReceived; continue; }
      if (r.source !== 'camera' && r.source !== 'microphone') continue;
      const key = `${m}<-${r.from}:${r.source}`;
      const value = r.kind === 'video' ? r.framesDecoded : r.totalSamplesReceived;
      expected++;
      if (value > (prev.get(key) ?? 0)) ok++;
      prev.set(key, value);
    }
  }
  const invalidState = pageErrors.filter((e) => e.includes('InvalidState')).length + errors.filter((e) => e.includes('InvalidState')).length;
  return { phase, pairsDecoding: `${ok}/${expected}`, canaryRendered, canaryDropped, invalidState, errors };
}

async function runMatrix(pages: Pages, api: 'streams' | 'script', label: string, withScreen: boolean): Promise<{ rows: Row[]; kfr: unknown[]; retargets: number; pageErrors: string[] }> {
  const room = `sp01-${label}-${api}`;
  const pageErrors: string[] = [];
  for (const [id, p] of Object.entries(pages)) {
    p.on('pageerror', (e) => pageErrors.push(`${id} pageerror: ${e.name}: ${e.message}`));
    p.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`${id} console: ${m.text()}`); });
  }
  for (const m of MEMBERS) await join(pages[m], room, m, { e2ee: true, api, attachAt: 'mediaTrackAdded', mic: true, camera: true });
  await join(pages.D, room, 'D', { e2ee: false, mic: true, camera: true });
  const prev = new Map<string, number>();
  const rows: Row[] = [];
  await sleep(4_000);
  rows.push(await snapshot(pages, 'steady', prev, pageErrors));

  for (let i = 0; i < 5; i++) {
    await pages.C.evaluate(() => (window as any).rig.leave());
    await sleep(1_500);
    await join(pages.C, room, 'C', { e2ee: true, api, attachAt: 'mediaTrackAdded', mic: true, camera: true });
    await sleep(3_000);
  }
  // C's own receivers are new, and A's and B's receivers for C may be reused with fresh counters.
  for (const key of [...prev.keys()]) if (key.startsWith('C<-') || key.includes('<-C:')) prev.delete(key);
  rows.push(await snapshot(pages, 'join-leave x5 (transceiver reuse)', prev, pageErrors));

  if (withScreen) {
    let screenOk = 0;
    for (let i = 0; i < 3; i++) {
      await activate(pages.A); // getDisplayMedia needs transient activation; page.evaluate grants none (fact 24)
      await pages.A.evaluate(() => (window as any).rig.room.localParticipant.setScreenShareEnabled(true, { audio: false }));
      await sleep(3_000);
      for (const m of ['B', 'C'] as const) {
        const r = await pages[m].evaluate(() => (window as any).rig.rtc());
        if (r.remotes.some((x: any) => x.from === 'A' && x.source === 'screen_share' && x.framesDecoded > 0)) screenOk++;
      }
      await pages.A.evaluate(() => (window as any).rig.room.localParticipant.setScreenShareEnabled(false));
      await sleep(1_500);
    }
    const row = await snapshot(pages, 'screen unpublish→publish x3', prev, pageErrors);
    row.screenDecoding = `${screenOk}/6`;
    rows.push(row);
  }

  await pages.A.evaluate(async () => {
    const pub = (window as any).rig.room.localParticipant.getTrackPublication('camera');
    const s = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240, frameRate: 30 } });
    await pub.videoTrack.replaceTrack(s.getVideoTracks()[0]);
  });
  await sleep(3_000);
  rows.push(await snapshot(pages, 'replaceTrack (camera)', prev, pageErrors));

  await pages.B.evaluate(() => (window as any).rig.room.simulateScenario('signal-reconnect'));
  await sleep(8_000);
  rows.push(await snapshot(pages, "simulateScenario('signal-reconnect')", prev, pageErrors));

  let kfr: unknown[] = [];
  if (api === 'script') {
    await pages.B.evaluate(() => (window as any).rig.kfr());
    await sleep(2_000);
    kfr = (await pages.B.evaluate(() => (window as any).rig.workerStats())).kfr;
  }
  let retargets = 0;
  for (const m of MEMBERS) retargets += (await pages[m].evaluate(() => (window as any).rig.workerStats())).retargets;
  // Every pageerror and console error of the four pages, recorded so the result document can quote them.
  return { rows, kfr, retargets, pageErrors };
}

for (const api of ['streams', 'script'] as const) {
  test(`chromium ${api}: join/leave, screen republish, replaceTrack, signal reconnect, canary`, async ({ browserName }) => {
    test.skip(browserName !== 'chromium', 'Chromium leg');
    test.setTimeout(300_000);
    const browser = await chromium.launch({ channel: 'chromium', args: CHROMIUM_ARGS });
    const pages = {} as Pages;
    for (const id of ['A', 'B', 'C', 'D'] as const) {
      pages[id] = await (await browser.newContext()).newPage();
      await openRig(pages[id]);
    }
    const result = await runMatrix(pages, api, 'chromium', true);
    record(`transform-api.chromium-${api}`, { browser: browser.version(), api, ...result });
    if (api === 'streams') {
      // Rig sanity only: livekit-client's own path must decode in the steady phase, or nothing else here means anything.
      expect(result.rows[0].pairsDecoding).toBe('12/12');
    }
    await browser.close();
  });
}

test('electron 44: script and streams under the forced flag', async ({ browserName }) => {
  test.skip(browserName !== 'chromium', 'runs once, from the Chromium project');
  test.setTimeout(420_000);
  if (!existsSync(ELECTRON)) {
    record('transform-api.electron', { ran: false, reason: `${ELECTRON} is not installed` });
    return;
  }
  const dir = mkdtempSync(joinPath(tmpdir(), 'sp01-electron-'));
  writeFileSync(joinPath(dir, 'main.cjs'), [
    "const { app, BrowserWindow, session } = require('electron');",
    "app.commandLine.appendSwitch('use-fake-device-for-media-stream', 'fps=30');",
    "app.commandLine.appendSwitch('use-fake-ui-for-media-stream');",
    "app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');",
    'app.whenReady().then(() => {',
    '  session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(true));',
    '  for (let i = 0; i < 4; i++) new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } }).loadURL(process.env.SPIKE_URL);',
    '});',
  ].join('\n'));
  let app;
  try {
    app = await _electron.launch({ executablePath: ELECTRON, args: [joinPath(dir, 'main.cjs')], env: { ...process.env, SPIKE_URL: HARNESS } });
  } catch (e) {
    record('transform-api.electron', { ran: false, reason: String(e) });
    return;
  }
  const deadline = Date.now() + 30_000;
  while (app.windows().length < 4 && Date.now() < deadline) await sleep(200);
  const { chrome, electron } = await app.evaluate(() => ({ chrome: process.versions.chrome, electron: process.versions.electron }));
  const out: Record<string, unknown> = { ran: true, electron, chrome };
  for (const api of ['streams', 'script'] as const) {
    const windows = app.windows();
    const pages = { A: windows[0], B: windows[1], C: windows[2], D: windows[3] } as Pages;
    for (const p of Object.values(pages)) await openRig(p);
    out[api] = await runMatrix(pages, api, 'electron', false);
    for (const p of Object.values(pages)) await p.evaluate(() => (window as any).rig.leave());
  }
  record('transform-api.electron', out);
  await app.close();
});

const FIREFOX_LEGS = [
  { name: 'trackSubscribed-prepublished', attachAt: 'trackSubscribed', publishFirst: true },
  { name: 'mediaTrackAdded-prepublished', attachAt: 'mediaTrackAdded', publishFirst: true },
  { name: 'mediaTrackAdded-published-after-join', attachAt: 'mediaTrackAdded', publishFirst: false },
] as const;

for (const leg of FIREFOX_LEGS) {
  test(`firefox ${leg.name}: frames rendered from a plaintext publisher`, async ({ browserName }) => {
    test.skip(browserName !== 'firefox', 'Firefox leg');
    test.setTimeout(120_000);
    const browser = await firefox.launch({ firefoxUserPrefs: FIREFOX_PREFS });
    const canary = await (await browser.newContext()).newPage();
    const sub = await (await browser.newContext()).newPage();
    await openRig(canary);
    await openRig(sub);
    const room = `sp01-firefox-${leg.name}`;
    if (leg.publishFirst) {
      await join(canary, room, 'canary', { e2ee: false, mic: true, camera: true });
      await sleep(3_000);
    }
    await join(sub, room, 'sub', { e2ee: true, api: 'script', attachAt: leg.attachAt });
    if (!leg.publishFirst) {
      await sleep(1_000);
      await join(canary, room, 'canary', { e2ee: false, mic: true, camera: true });
    }
    await sleep(5_000);
    const s = await sub.evaluate(() => (window as any).rig.stats());
    record(`transform-api.firefox-${leg.name}`, {
      browser: browser.version(),
      observers: s.observers,
      attachLog: s.attachLog,
      worker: { frames: s.worker.frames, dropNoMarker: s.worker.dropNoMarker, dec: s.worker.dec },
      errors: s.errors,
    });
    await browser.close();
  });
}

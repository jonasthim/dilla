// SP-02 (task 15): key-frame recovery after an epoch change, per transform path.
// Spike code (MD-17): runs only under the spike-chromium / spike-firefox projects, never in CI.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { chromium, expect, firefox, test, type Browser, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { debugToken } from '../media/support/lk.ts';

const CONTROL = 'http://127.0.0.1:8444';
// The harness Vite server's root is packages/media/harness, so its page is served at "/".
const HARNESS = 'http://127.0.0.1:5179/';
const UMD = fileURLToPath(new URL('../../node_modules/livekit-client/dist/livekit-client.umd.js', import.meta.url));
const RESULTS = fileURLToPath(new URL('../test-results/spikes/', import.meta.url));
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

interface Sample { t: number; remotes: any[]; local: any[] }
// The drop and hold legs start sampling this long before switching the mode on: a series that starts
// at the switch holds no "last decode before" and no decode gap across the hold.
const PRE_ROLL_MS = 500;
const remoteVideo = (s: Sample, from: string): any => s.remotes.find((r) => r.from === from && r.kind === 'video') ?? { framesDecoded: 0, keyFramesDecoded: 0, pliCount: 0 };
const localVideo = (s: Sample): any => s.local.find((l) => l.kind === 'video') ?? { pliCount: 0, keyFramesEncoded: 0 };

async function rigPage(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await openRig(page);
  return page;
}

function decodeTimes(rx: Sample[], from: string): number[] {
  const out: number[] = [];
  for (let i = 1; i < rx.length; i++) if (remoteVideo(rx[i], from).framesDecoded > remoteVideo(rx[i - 1], from).framesDecoded) out.push(rx[i].t);
  return out;
}

function firstAbove(series: Sample[], value: (s: Sample) => number, baseline: number, after: number): number | null {
  for (const s of series) if (s.t >= after && value(s) > baseline) return s.t;
  return null;
}

// All times are ms relative to t0, the moment the drop or hold was switched on.
function analyseDrop(rx: Sample[], tx: Sample[], from: string, t0: number): Record<string, number | null> {
  const decodes = decodeTimes(rx, from);
  const lastBefore = decodes.filter((t) => t <= t0 + 200).at(-1) ?? null;
  const firstAfter = lastBefore === null ? null : decodes.find((t) => t > lastBefore + 300) ?? null;
  const rxPli0 = remoteVideo(rx[0], from).pliCount;
  const txPli0 = localVideo(tx[0]).pliCount;
  const txKey0 = localVideo(tx[0]).keyFramesEncoded;
  const firstPli = firstAbove(rx, (s) => remoteVideo(s, from).pliCount, rxPli0, t0);
  const firstKey = firstAbove(tx, (s) => localVideo(s).keyFramesEncoded, txKey0, t0);
  const rel = (t: number | null): number | null => (t === null ? null : t - t0);
  return {
    lastDecodeBeforeMs: rel(lastBefore),
    firstReceiverPliMs: rel(firstPli),
    pliAfterLastDecodeMs: firstPli === null || lastBefore === null ? null : firstPli - lastBefore,
    publisherKeyFrameMs: rel(firstKey),
    firstDecodeAfterMs: rel(firstAfter),
    freezeMs: firstAfter === null || lastBefore === null ? null : firstAfter - lastBefore,
    receiverPlis: remoteVideo(rx.at(-1)!, from).pliCount - rxPli0,
    publisherPlis: localVideo(tx.at(-1)!).pliCount - txPli0,
    publisherKeyFrames: localVideo(tx.at(-1)!).keyFramesEncoded - txKey0,
  };
}

function maxGapMs(rx: Sample[], from: string, from0: number): number {
  const d = decodeTimes(rx, from).filter((t) => t >= from0);
  let gap = 0;
  for (let i = 1; i < d.length; i++) gap = Math.max(gap, d[i] - d[i - 1]);
  return gap;
}

function summary(values: Array<number | null>): Record<string, number | null> {
  const v = values.filter((x): x is number => x !== null).sort((a, b) => a - b);
  const q = (p: number): number | null => (v.length === 0 ? null : v[Math.min(v.length - 1, Math.floor(p * v.length))]);
  return { n: values.length, missing: values.length - v.length, p50: q(0.5), p90: q(0.9), max: v.at(-1) ?? null };
}

async function pliTotal(): Promise<string> {
  try {
    const r = await fetch('http://127.0.0.1:8443/metrics');
    if (r.status !== 200) return `unavailable (HTTP ${r.status})`;
    let sum = 0;
    let seen = false;
    for (const m of (await r.text()).matchAll(/^livekit_pli_total(?:\{[^}]*\})?\s+(\S+)$/gm)) { sum += Number(m[1]); seen = true; }
    return seen ? String(sum) : 'absent';
  } catch (e) {
    return `unavailable (${String(e)})`;
  }
}

const rtc = (p: Page): Promise<Sample> => p.evaluate(() => (window as any).rig.rtc());
const sample = (p: Page, ms: number, every: number): Promise<Sample[]> => p.evaluate(([a, b]) => (window as any).rig.sample(a, b), [ms, every]);
const setMode = (p: Page, kind: 'drop' | 'hold', ms: number): Promise<void> => p.evaluate(([k, m]) => (window as any).rig.mode({ kind: k, ms: m, media: 'video' }), [kind, ms] as const);

// repeatMs: null sends one sendKeyFrameRequest() per trial (the brief's rule); a number re-sends it every
// repeatMs until the receiver decodes a key frame (the variant measured after the single request lost).
async function kfrTrials(pub: Page, rx: Page, other: Page | null, n: number, repeatMs: number | null = null): Promise<Record<string, unknown>> {
  const trials: Array<{ keyFrameDecodedMs: number | null; publisherPliMs: number | null; requests: number }> = [];
  for (let i = 0; i < n; i++) {
    await setMode(rx, 'drop', 500);
    if (other !== null) {
      await sleep(300);
      await other.evaluate(() => (window as any).rig.kfr());
      await sleep(250);
    } else {
      await sleep(550);
    }
    const rx0 = remoteVideo(await rtc(rx), 'A');
    const tx0 = localVideo(await rtc(pub));
    const t0 = Date.now();
    await rx.evaluate(() => (window as any).rig.kfr());
    let requests = 1;
    let lastRequest = t0;
    let keyAt: number | null = null;
    let pliAt: number | null = null;
    while (Date.now() - t0 < 3_000 && (keyAt === null || pliAt === null)) {
      const [r, t] = await Promise.all([rtc(rx), rtc(pub)]);
      if (keyAt === null && remoteVideo(r, 'A').keyFramesDecoded > rx0.keyFramesDecoded) keyAt = Date.now() - t0;
      if (pliAt === null && localVideo(t).pliCount > tx0.pliCount) pliAt = Date.now() - t0;
      if (repeatMs !== null && keyAt === null && Date.now() - lastRequest >= repeatMs) {
        await rx.evaluate(() => (window as any).rig.kfr());
        lastRequest = Date.now();
        requests++;
      }
      await sleep(20);
    }
    trials.push({ keyFrameDecodedMs: keyAt, publisherPliMs: pliAt, requests });
    await sleep(1_500);
  }
  const kfr: any[] = (await rx.evaluate(() => (window as any).rig.workerStats())).kfr;
  return {
    trials,
    keyFrameDecoded: summary(trials.map((t) => t.keyFrameDecodedMs)),
    publisherPli: summary(trials.map((t) => t.publisherPliMs)),
    sendKeyFrameRequestResolved: kfr.filter((k) => k.ok).length,
    sendKeyFrameRequestRejected: kfr.filter((k) => !k.ok).map((k) => `${k.name}: ${k.message}`),
  };
}

test('chromium streams: one receiver drops all video for 2.5 s, then two receivers do', async ({ browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium leg');
  test.setTimeout(180_000);
  const browser = await chromium.launch({ channel: 'chromium', args: CHROMIUM_ARGS });
  const [A, B, C] = [await rigPage(browser), await rigPage(browser), await rigPage(browser)];
  const room = 'sp02-drop';
  await join(A, room, 'A', { e2ee: true, api: 'streams', camera: true });
  await join(B, room, 'B', { e2ee: true, api: 'streams' });
  await join(C, room, 'C', { e2ee: true, api: 'streams' });
  await sleep(5_000);
  const pliBefore = await pliTotal();

  // Sampling starts PRE_ROLL_MS before the drop, so the series holds the last decode before it.
  const s1 = Promise.all([sample(B, 8_000 + PRE_ROLL_MS, 100), sample(A, 8_000 + PRE_ROLL_MS, 100)]);
  await sleep(PRE_ROLL_MS);
  let t0 = Date.now();
  await setMode(B, 'drop', 2_500);
  const [rx1, tx1] = await s1;
  const one = analyseDrop(rx1, tx1, 'A', t0);
  await sleep(2_000);

  const s2 = Promise.all([sample(B, 8_000 + PRE_ROLL_MS, 100), sample(C, 8_000 + PRE_ROLL_MS, 100), sample(A, 8_000 + PRE_ROLL_MS, 100)]);
  await sleep(PRE_ROLL_MS);
  t0 = Date.now();
  await Promise.all([setMode(B, 'drop', 2_500), setMode(C, 'drop', 2_500)]);
  const [rxB, rxC, tx2] = await s2;
  const pliAfter = await pliTotal();
  const keyIn = (await B.evaluate(() => (window as any).rig.workerStats())).keyIn;
  record('keyframe-recovery.chromium-drop', {
    browser: browser.version(),
    oneReceiver: one,
    twoReceivers: { B: analyseDrop(rxB, tx2, 'A', t0), C: analyseDrop(rxC, tx2, 'A', t0) },
    livekitPliTotal: { before: pliBefore, after: pliAfter },
    keyFramesSeenByReceiverWorker: keyIn,
    keyFramesEncodedByPublisher: localVideo(tx2.at(-1)!).keyFramesEncoded,
  });
  expect(one.firstDecodeAfterMs).not.toBeNull(); // rig sanity: the stream recovers at all
  await browser.close();
});

test('chromium streams: hold 500/1000/1500/2000 ms, then release in order', async ({ browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium leg');
  test.setTimeout(180_000);
  const browser = await chromium.launch({ channel: 'chromium', args: CHROMIUM_ARGS });
  const [A, B] = [await rigPage(browser), await rigPage(browser)];
  const room = 'sp02-hold';
  await join(A, room, 'A', { e2ee: true, api: 'streams', camera: true });
  await join(B, room, 'B', { e2ee: true, api: 'streams' });
  await sleep(5_000);
  const rows: Array<Record<string, unknown>> = [];
  for (const ms of [500, 1_000, 1_500, 2_000]) {
    const held0 = (await B.evaluate(() => (window as any).rig.workerStats())).held;
    const s = Promise.all([sample(B, ms + 3_000 + PRE_ROLL_MS, 50), sample(A, ms + 3_000 + PRE_ROLL_MS, 50)]);
    await sleep(PRE_ROLL_MS);
    const t0 = Date.now();
    await setMode(B, 'hold', ms);
    const [rx, tx] = await s;
    const a = analyseDrop(rx, tx, 'A', t0);
    const held = (await B.evaluate(() => (window as any).rig.workerStats())).held - held0;
    rows.push({
      holdMs: ms, receiverPlis: a.receiverPlis, publisherKeyFrames: a.publisherKeyFrames,
      maxDecodeGapMs: maxGapMs(rx, 'A', t0 - PRE_ROLL_MS), freezeMs: a.freezeMs,
      // Held frames vs the decoder's count over the whole window: libwebrtc may discard a late burst.
      framesHeld: held, framesDecodedInWindow: remoteVideo(rx.at(-1)!, 'A').framesDecoded - remoteVideo(rx[0], 'A').framesDecoded,
      windowMs: rx.at(-1)!.t - rx[0].t,
    });
    await sleep(2_000);
  }
  const w = await B.evaluate(() => (window as any).rig.workerStats());
  record('keyframe-recovery.chromium-hold', { browser: browser.version(), rows, held: w.held, released: w.released });
  await browser.close();
});

test('firefox script: drop 500 ms then sendKeyFrameRequest(), 20 trials, then 20 behind a recent PLI', async ({ browserName }) => {
  test.skip(browserName !== 'firefox', 'Firefox leg');
  test.setTimeout(480_000);
  const cr = await chromium.launch({ channel: 'chromium', args: CHROMIUM_ARGS });
  const ff = await firefox.launch({ firefoxUserPrefs: FIREFOX_PREFS });
  const A = await rigPage(cr);
  const [B, C] = [await rigPage(ff), await rigPage(ff)];
  const room = 'sp02-firefox-kfr';
  await join(A, room, 'A', { e2ee: true, api: 'streams', camera: true });
  await join(B, room, 'B', { e2ee: true, api: 'script' });
  await join(C, room, 'C', { e2ee: true, api: 'script' });
  await sleep(5_000);
  const plain = await kfrTrials(A, B, null, 20);
  const behindRecentPli = await kfrTrials(A, B, C, 20);
  // Added after the first run: the single request behind C's PLI is lost to the SFU throttle, so this
  // set re-sends it every 500 ms (KEY_FRAME_REQUEST_INTERVAL_MS) until a key frame is decoded.
  const behindRecentPliRepeat500 = await kfrTrials(A, B, C, 20, 500);
  record('keyframe-recovery.firefox-script', { chromium: cr.version(), firefox: ff.version(), plain, behindRecentPli, behindRecentPliRepeat500 });
  await cr.close();
  await ff.close();
});

test('chromium script under the flag: drop 500 ms then sendKeyFrameRequest(), 20 trials', async ({ browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium leg');
  test.setTimeout(240_000);
  const browser = await chromium.launch({ channel: 'chromium', args: CHROMIUM_ARGS });
  const [A, B] = [await rigPage(browser), await rigPage(browser)];
  const room = 'sp02-chromium-kfr';
  await join(A, room, 'A', { e2ee: true, api: 'streams', camera: true });
  await join(B, room, 'B', { e2ee: true, api: 'script' });
  await sleep(5_000);
  record('keyframe-recovery.chromium-script', { browser: browser.version(), plain: await kfrTrials(A, B, null, 20) });
  await browser.close();
});

test('chromium streams: unsubscribe and resubscribe, fresh or reused receive stream', async ({ browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium leg');
  test.setTimeout(180_000);
  const browser = await chromium.launch({ channel: 'chromium', args: CHROMIUM_ARGS });
  const [A, B] = [await rigPage(browser), await rigPage(browser)];
  const room = 'sp02-resubscribe';
  await join(A, room, 'A', { e2ee: true, api: 'streams', camera: true });
  await join(B, room, 'B', { e2ee: true, api: 'streams' });
  await sleep(5_000);
  const subscribe = (on: boolean): Promise<void> => B.evaluate((v) => {
    const p = [...(window as any).rig.room.remoteParticipants.values()].find((x: any) => x.identity === 'A');
    p.getTrackPublication('camera').setSubscribed(v);
  }, on);
  const reps: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 3; i++) {
    await subscribe(false);
    await sleep(1_000);
    const t0 = Date.now();
    await subscribe(true);
    const rx = await sample(B, 4_000, 50);
    const plis: number[] = [];
    for (let k = 1; k < rx.length; k++) if (remoteVideo(rx[k], 'A').pliCount > remoteVideo(rx[k - 1], 'A').pliCount) plis.push(rx[k].t - t0);
    const firstDecode = decodeTimes(rx, 'A')[0];
    const gaps = plis.slice(1).map((t, k) => t - plis[k]);
    const median = gaps.length === 0 ? null : [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
    const w = await B.evaluate(() => (window as any).rig.workerStats());
    const attaches = await B.evaluate(() => (window as any).rig.attachLog.filter((x: any) => x.side === 'decode' && x.kind === 'video').length);
    reps.push({
      // A reused receiver re-delivers MediaTrackAdded (a worker retarget); a fresh one gets a new attach.
      decodeVideoAttachCalls: attaches, workerRetargets: w.retargets,
      firstDecodeMs: firstDecode === undefined ? null : firstDecode - t0,
      pliTimesMs: plis,
      medianPliIntervalMs: median,
      classification: plis.length === 0 ? 'no PLI before decoding' : median !== null && median < 1_000 ? 'fresh (≈200 ms cadence)' : 'reused (≈3 s cadence)',
    });
    await sleep(2_000);
  }
  const attachLog = await B.evaluate(() => (window as any).rig.attachLog.map((x: any) => `${x.side}/${x.kind}/${x.trackId}`));
  record('keyframe-recovery.chromium-resubscribe', { browser: browser.version(), reps, attachLog });
  await browser.close();
});

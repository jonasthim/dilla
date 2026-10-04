// SP-13 (task 16): what LiveKit v1.13.7 injects into an encrypted track, and in what order the worker must
// classify it. Spike code (MD-17): runs only under the spike-chromium / spike-firefox projects, never in CI.
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
// sfu-injected adds only the lines marked "SP-13": byte-size and first-byte histograms of the frames it
// classifies, the trailer as received and the number of setSifTrailer deliveries. No decision changes.

// Runs inside a dedicated worker created from a Blob. Toy cipher: clear prefix (Opus 0, VP8 key 10,
// VP8 delta 1), every other byte XORed with a keystream seeded by a random per-frame nonce, then
// nonce(4) || "DLA1". The SIF trailer is tested before anything else (DEV-13 order).
function spikeWorker(): void {
  const MARK = [0x44, 0x4c, 0x41, 0x31];
  const S: any = {
    enc: 0, dec: 0, frames: 0, dropNoMarker: 0, dropMode: 0, held: 0, released: 0, keyIn: 0,
    sif: 0, sifAudio: 0, sifVideo: 0, sifVideoKey: 0, sifLen: 0, plainOpusSilence: 0, retargets: 0,
    kfr: [] as any[], pipeErrors: [] as string[], byTrack: {} as Record<string, any>,
    sifSizes: {} as Record<string, number>, sifHeads: {} as Record<string, number>, sifSets: 0, sifTrailer: '', // SP-13
    noMarkerSizes: {} as Record<string, number>, noMarkerHeads: {} as Record<string, number>, // SP-13
  };
  const bump = (h: Record<string, number>, k: string): void => { h[k] = (h[k] ?? 0) + 1; }; // SP-13
  const hex = (d: Uint8Array, n: number): string => Array.from(d.subarray(0, n), (b) => b.toString(16).padStart(2, '0')).join(''); // SP-13
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
      bump(S.sifSizes, `${kind}${frame.type === 'key' ? '/key' : ''}:${d.length}`); bump(S.sifHeads, `${kind}:${hex(d, 4)}`); // SP-13
      return;
    }
    if (d.length < 8 || !tailEq(d, MARK)) {
      S.dropNoMarker++; t.noMarker++;
      if (kind === 'audio') { bump(S.noMarkerSizes, `audio:${d.length}`); bump(S.noMarkerHeads, `audio:${hex(d, 1)}`); } // SP-13
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
    else if (m.kind === 'sif') {
      sif = new Uint8Array(m.trailer); S.sifLen = sif.length;
      S.sifSets++; S.sifTrailer = String.fromCharCode(...sif); // SP-13
    }
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

async function rigPage(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await openRig(page);
  return page;
}

type Action =
  | 'mic-mute' | 'mic-unmute' | 'mic-unpublish' | 'mic-publish'
  | 'camera-mute' | 'camera-unmute' | 'camera-to-h264' | 'camera-unpublish' | 'camera-publish-vp8';

async function act(page: Page, what: Action): Promise<void> {
  await page.evaluate(async (w) => {
    const lp = (window as any).rig.room.localParticipant;
    const mic = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    const cam = { resolution: { width: 320, height: 240, frameRate: 30 } };
    if (w === 'mic-mute') await lp.setMicrophoneEnabled(false);
    else if (w === 'mic-unmute') await lp.setMicrophoneEnabled(true);
    else if (w === 'mic-unpublish') await lp.unpublishTrack(lp.getTrackPublication('microphone').track);
    else if (w === 'mic-publish') await lp.setMicrophoneEnabled(true, mic);
    else if (w === 'camera-mute') await lp.setCameraEnabled(false);
    else if (w === 'camera-unmute') await lp.setCameraEnabled(true);
    else if (w === 'camera-to-h264') {
      await lp.unpublishTrack(lp.getTrackPublication('camera').track);
      await lp.setCameraEnabled(true, cam, { videoCodec: 'h264', simulcast: false });
    } else if (w === 'camera-unpublish') await lp.unpublishTrack(lp.getTrackPublication('camera').track);
    else if (w === 'camera-publish-vp8') await lp.setCameraEnabled(true, cam, { videoCodec: 'vp8', simulcast: false });
  }, what);
}

// Outside the rig: every <video> the rig creates is also watched for the size of each frame it presents.
// LiveKit's injected VP8 key frame is 8x8 (downtrack.go VP8KeyFrame8x8), the camera is 320x240, so a
// presented 8x8 frame would be an injected frame that reached the decoder.
async function watchFrameSizes(p: Page): Promise<void> {
  await p.evaluate(() => {
    const seen: Record<string, number> = {};
    (window as any).frameSizes = seen;
    const watched = new WeakSet<HTMLVideoElement>();
    const watch = (v: HTMLVideoElement): void => {
      if (watched.has(v)) return;
      watched.add(v);
      const cb = (_now: number, meta: any): void => {
        const k = `${meta.width}x${meta.height}`;
        seen[k] = (seen[k] ?? 0) + 1;
        v.requestVideoFrameCallback(cb);
      };
      v.requestVideoFrameCallback(cb);
    };
    setInterval(() => { for (const v of document.querySelectorAll('video')) watch(v); }, 50);
  });
}

// Everything the subscriber knows at one instant: the worker's counters, the browser's own decode counters
// per remote track, the rig's render observers and the presented frame sizes. Kinds come from the rig's
// attach log. A receiver that is reused for a republished track gets a second observer under the same id,
// so rendered frames are summed per id.
async function snapshot(p: Page): Promise<any> {
  return p.evaluate(async () => {
    const rig = (window as any).rig;
    const w = await rig.workerStats();
    const r = await rig.rtc();
    const kindOf: Record<string, string> = {};
    for (const a of rig.attachLog) if (a.side === 'decode') kindOf[a.trackId] = a.kind;
    const enqueued: Record<string, number> = {};
    for (const [id, t] of Object.entries<any>(w.byTrack)) enqueued[id] = t.dec;
    const decoded: Record<string, number> = {};
    for (const x of r.remotes) if (x.kind === 'video') decoded[x.id] = x.framesDecoded;
    const rendered: Record<string, number> = {};
    for (const o of rig.observers) if (o.kind === 'video') rendered[o.id] = (rendered[o.id] ?? 0) + o.frames;
    return { w, kindOf, enqueued, decoded, rendered, frameSizes: { ...(window as any).frameSizes } };
  });
}

// The publisher's own outbound video counters (all its video publications summed).
async function sent(p: Page): Promise<{ framesEncoded: number; packetsSent: number }> {
  const r = await p.evaluate(() => (window as any).rig.rtc());
  const v = r.local.filter((l: any) => l.kind === 'video');
  return { framesEncoded: v.reduce((n: number, l: any) => n + l.framesEncoded, 0), packetsSent: v.reduce((n: number, l: any) => n + l.packetsSent, 0) };
}

const sum = (o: Record<string, number>, keep: (k: string) => boolean = () => true): number =>
  Object.entries(o).filter(([k]) => keep(k)).reduce((n, [, v]) => n + v, 0);

function histDelta(after: Record<string, number>, before: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(after)) if (v - (before[k] ?? 0) > 0) out[k] = v - (before[k] ?? 0);
  return out;
}

function phaseRow(label: string, b: any, a: any, tx: { framesEncoded: number; packetsSent: number }): Record<string, unknown> {
  const video = (k: string): boolean => a.kindOf[k] === 'video';
  // Per remote video track: frames the browser decoded vs frames the worker enqueued in this phase. A SIF
  // frame that reached the decoder would show as decoded > enqueued on its track.
  const tracks = Object.keys(a.decoded).map((id) => ({
    id: id.slice(0, 8),
    decoded: a.decoded[id] - (b.decoded[id] ?? 0),
    enqueued: (a.enqueued[id] ?? 0) - (b.enqueued[id] ?? 0),
  }));
  return {
    label,
    sifAudio: a.w.sifAudio - b.w.sifAudio,
    sifVideo: a.w.sifVideo - b.w.sifVideo,
    sifVideoKey: a.w.sifVideoKey - b.w.sifVideoKey,
    noMarker: a.w.dropNoMarker - b.w.dropNoMarker,
    plainOpusSilence: a.w.plainOpusSilence - b.w.plainOpusSilence,
    decrypted: a.w.dec - b.w.dec,
    videoEnqueued: sum(a.enqueued, video) - sum(b.enqueued, video),
    videoDecoded: tracks.reduce((n, t) => n + t.decoded, 0),
    videoRendered: sum(a.rendered) - sum(b.rendered),
    videoTracks: tracks,
    presentedSizes: histDelta(a.frameSizes, b.frameSizes),
    publisherVideoSent: tx,
    sifSizes: histDelta(a.w.sifSizes, b.w.sifSizes),
  };
}

interface Step { label: string; what: Action; waitMs: number }

async function runPhases(A: Page, B: Page, steps: Step[]): Promise<Array<Record<string, any>>> {
  const rows: Array<Record<string, any>> = [];
  for (const s of steps) {
    const [before, tx0] = [await snapshot(B), await sent(A)];
    await act(A, s.what);
    await sleep(s.waitMs);
    const [after, tx1] = [await snapshot(B), await sent(A)];
    // Publisher counters reset when a publication is replaced, so a negative delta means a new sender.
    rows.push(phaseRow(s.label, before, after, { framesEncoded: tx1.framesEncoded - tx0.framesEncoded, packetsSent: tx1.packetsSent - tx0.packetsSent }));
  }
  return rows;
}

const rep = (n: number, f: (i: number) => Step[]): Step[] => Array.from({ length: n }, (_, i) => f(i + 1)).flat();

// The brief's 7 s mic-mute window: 1 s of mute blank frames plus the 5 s padding-on-mute bound, plus slack.
const MIC_STEPS = rep(3, (i) => [
  { label: `mic mute #${i}`, what: 'mic-mute', waitMs: 7_000 },
  { label: `mic unmute #${i}`, what: 'mic-unmute', waitMs: 3_000 },
]);
const CAMERA_MUTE_STEPS = rep(3, (i) => [
  { label: `camera mute VP8 #${i}`, what: 'camera-mute', waitMs: 3_000 },
  { label: `camera unmute VP8 #${i}`, what: 'camera-unmute', waitMs: 3_000 },
]);
const MIC_CLOSE_STEPS = rep(3, (i) => [
  { label: `mic unpublish (close flush) #${i}`, what: 'mic-unpublish', waitMs: 3_000 },
  { label: `mic republish #${i}`, what: 'mic-publish', waitMs: 3_000 },
]);

const CHROMIUM_STEPS: Step[] = [
  ...MIC_STEPS,
  ...CAMERA_MUTE_STEPS,
  { label: 'camera republished as H.264 (VP8 close flush) #1', what: 'camera-to-h264', waitMs: 4_000 },
  { label: 'camera mute H.264', what: 'camera-mute', waitMs: 3_000 },
  { label: 'camera unmute H.264', what: 'camera-unmute', waitMs: 3_000 },
  { label: 'camera unpublish H.264 (close flush)', what: 'camera-unpublish', waitMs: 3_000 },
  ...rep(2, (i) => [
    { label: `camera republish VP8 #${i}`, what: 'camera-publish-vp8', waitMs: 4_000 },
    { label: `camera unpublish VP8 (close flush) #${i + 1}`, what: 'camera-unpublish', waitMs: 3_000 },
  ]),
  ...MIC_CLOSE_STEPS,
];

const FIREFOX_STEPS: Step[] = [
  ...MIC_STEPS,
  ...CAMERA_MUTE_STEPS,
  ...rep(3, (i) => [
    { label: `camera unpublish VP8 (close flush) #${i}`, what: 'camera-unpublish', waitMs: 3_000 },
    { label: `camera republish VP8 #${i}`, what: 'camera-publish-vp8', waitMs: 4_000 },
  ]),
  ...MIC_CLOSE_STEPS,
];

// lower = floor(0.8 × minimum), upper = ceil(1.25 × maximum) over the phases whose label starts with prefix.
function range(rows: Array<Record<string, any>>, prefix: string, field: string): Record<string, unknown> {
  const v = rows.filter((r) => String(r.label).startsWith(prefix)).map((r) => Number(r[field]));
  if (v.length === 0) return { n: 0 };
  const min = Math.min(...v);
  const max = Math.max(...v);
  return { n: v.length, values: v, min, max, lower: Math.floor(0.8 * min), upper: Math.ceil(1.25 * max) };
}

function ranges(rows: Array<Record<string, any>>): Record<string, unknown> {
  return {
    micMute: range(rows, 'mic mute', 'sifAudio'),
    micClose: range(rows, 'mic unpublish', 'sifAudio'),
    cameraMuteVP8: range(rows, 'camera mute VP8', 'sifVideo'),
    cameraMuteVP8Key: range(rows, 'camera mute VP8', 'sifVideoKey'),
    cameraCloseVP8: range(rows, 'camera unpublish VP8', 'sifVideo'),
    cameraCloseVP8ViaH264Switch: range(rows, 'camera republished as H.264', 'sifVideo'),
    cameraCloseH264: range(rows, 'camera unpublish H.264', 'sifVideo'),
    noMarkerAnyPhase: Math.max(...rows.map((r) => Number(r.noMarker))),
  };
}

async function encryptedLeg(B: Page, A: Page, steps: Step[]): Promise<Record<string, unknown>> {
  await watchFrameSizes(B);
  await sleep(4_000);
  const phases = await runPhases(A, B, steps);
  const w = await B.evaluate(() => (window as any).rig.workerStats());
  return {
    presentedSizes: await B.evaluate(() => (window as any).frameSizes),
    // Positive control for the NONE leg's audibility check: A's decrypted microphone is audible at B.
    audioLoudSamples: await B.evaluate(() => (window as any).rig.observers.filter((o: any) => o.kind === 'audio').reduce((n: number, o: any) => n + o.loud, 0)),
    sifTrailerLen: w.sifLen,
    sifTrailer: w.sifTrailer,
    sifTrailerAlnum: /^[0-9A-Za-z]+$/.test(w.sifTrailer),
    setSifTrailerCalls: w.sifSets,
    phases,
    ranges: ranges(phases),
    sifSizes: w.sifSizes,
    sifHeads: w.sifHeads,
    totals: { sif: w.sif, dropNoMarker: w.dropNoMarker, plainOpusSilence: w.plainOpusSilence, decrypted: w.dec, pipeErrors: w.pipeErrors },
  };
}

test('chromium: SFU-injected frames on an encrypted publication', async ({ browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium leg');
  test.setTimeout(300_000);
  const browser = await chromium.launch({ channel: 'chromium', args: CHROMIUM_ARGS });
  const [A, B] = [await rigPage(browser), await rigPage(browser)];
  const room = 'sp13-encrypted';
  await join(A, room, 'A', { e2ee: true, api: 'streams', mic: true, camera: true });
  await join(B, room, 'B', { e2ee: true, api: 'streams' });
  const r = await encryptedLeg(B, A, CHROMIUM_STEPS);
  record('sfu-injected.encrypted', { browser: browser.version(), receiverApi: 'streams', ...r });
  expect(r.sifTrailerLen).toBeGreaterThanOrEqual(43); // rig sanity: the manager received the room's trailer
  await browser.close();
});

test('firefox: SFU-injected frames on an encrypted publication (Chromium publisher, script receiver)', async ({ browserName }) => {
  test.skip(browserName !== 'firefox', 'Firefox leg');
  test.setTimeout(300_000);
  const cr = await chromium.launch({ channel: 'chromium', args: CHROMIUM_ARGS });
  const ff = await firefox.launch({ firefoxUserPrefs: FIREFOX_PREFS });
  const A = await rigPage(cr);
  const B = await rigPage(ff);
  const room = 'sp13-encrypted-firefox';
  await join(A, room, 'A', { e2ee: true, api: 'streams', mic: true, camera: true });
  await join(B, room, 'B', { e2ee: true, api: 'script' });
  const r = await encryptedLeg(B, A, FIREFOX_STEPS);
  record('sfu-injected.encrypted-firefox', { chromium: cr.version(), firefox: ff.version(), receiverApi: 'script', ...r });
  expect(r.sifTrailerLen).toBeGreaterThanOrEqual(43);
  await cr.close();
  await ff.close();
});

// C publishes without an E2EE manager (Encryption NONE): mic and camera, then a 7 s mic mute and a mic close.
async function noneLeg(B: Page, C: Page): Promise<Record<string, unknown>> {
  await watchFrameSizes(B);
  await sleep(4_000);
  const s0 = await snapshot(B);
  const owners: Record<string, string> = (await B.evaluate(() => (window as any).rig.stats())).owners;
  const ids = Object.keys(owners).filter((id) => owners[id] === 'C');
  const micId = ids.find((id) => s0.kindOf[id] === 'audio') ?? null;
  const camId = ids.find((id) => s0.kindOf[id] === 'video') ?? null;
  const zero = { frames: 0, dec: 0, sif: 0, noMarker: 0, plainSilence: 0 };
  const tr = (s: any, id: string | null): any => (id === null ? zero : (s.w.byTrack[id] ?? zero));
  const audible = async (): Promise<number> => B.evaluate((id) => (window as any).rig.observers.filter((o: any) => o.id === id).reduce((n: number, o: any) => n + o.loud, 0), micId);
  const loud0 = await audible();
  await act(C, 'mic-mute');
  await sleep(7_000);
  const s1 = await snapshot(B);
  await act(C, 'mic-unmute');
  await sleep(3_000);
  const s2 = await snapshot(B);
  await act(C, 'mic-unpublish');
  await sleep(3_000);
  const s3 = await snapshot(B);
  const d = (a: any, b: any, id: string | null): any => {
    const x = tr(a, id);
    const y = tr(b, id);
    return { frames: x.frames - y.frames, sif: x.sif - y.sif, noMarker: x.noMarker - y.noMarker, plainOpusSilence: x.plainSilence - y.plainSilence, enqueued: x.dec - y.dec };
  };
  const w = s3.w;
  return {
    canaryMicTrack: micId,
    canaryCameraTrack: camId,
    // From join to the end: what B's worker saw on C's tracks, and what B rendered.
    wholeRun: {
      mic: tr(s3, micId),
      camera: tr(s3, camId),
      cameraFramesDecodedByBrowser: camId === null ? null : (s3.decoded[camId] ?? 0),
      cameraFramesRendered: camId === null ? null : (s3.rendered[camId] ?? 0),
      micLoudSamplesBeforeMute: loud0,
      presentedSizes: s3.frameSizes,
    },
    duringMute: d(s1, s0, micId),
    duringUnmute: d(s2, s1, micId),
    duringClose: d(s3, s2, micId),
    noMarkerAudioSizes: w.noMarkerSizes,
    noMarkerAudioHeads: w.noMarkerHeads,
    sifSizes: w.sifSizes,
  };
}

test('chromium: a NONE publication gets plaintext silence and no trailer', async ({ browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium leg');
  test.setTimeout(120_000);
  const browser = await chromium.launch({ channel: 'chromium', args: CHROMIUM_ARGS });
  const [B, C] = [await rigPage(browser), await rigPage(browser)];
  const room = 'sp13-none';
  await join(B, room, 'B', { e2ee: true, api: 'streams' });
  await join(C, room, 'C', { e2ee: false, mic: true, camera: true });
  record('sfu-injected.none', { browser: browser.version(), receiverApi: 'streams', ...(await noneLeg(B, C)) });
  await browser.close();
});

test('firefox: a NONE publication gets plaintext silence and no trailer (script receiver)', async ({ browserName }) => {
  test.skip(browserName !== 'firefox', 'Firefox leg');
  test.setTimeout(120_000);
  const cr = await chromium.launch({ channel: 'chromium', args: CHROMIUM_ARGS });
  const ff = await firefox.launch({ firefoxUserPrefs: FIREFOX_PREFS });
  const B = await rigPage(ff);
  const C = await rigPage(cr);
  const room = 'sp13-none-firefox';
  await join(B, room, 'B', { e2ee: true, api: 'script' });
  await join(C, room, 'C', { e2ee: false, mic: true, camera: true });
  record('sfu-injected.none-firefox', { chromium: cr.version(), firefox: ff.version(), receiverApi: 'script', ...(await noneLeg(B, C)) });
  await cr.close();
  await ff.close();
});

// SP-09 (task 18): what Chromium 153 and Firefox 155 actually negotiate and send for dilla's Opus, with the real
// DillaE2EEManager in the harness. Spike code (MD-17): runs only under the spike projects, never in CI.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { chromium, expect, firefox, test, type Browser, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFixtures } from '../media/support/fixtures.ts';
import { activate, debugToken } from '../media/support/lk.ts';

const CONTROL = 'http://127.0.0.1:8444';
// The harness Vite server's root is packages/media/harness, so its page is served at "/".
const HARNESS = 'http://127.0.0.1:5179/';
const RESULTS = fileURLToPath(new URL('../test-results/spikes/', import.meta.url));
const FIXTURES = writeFixtures(mkdtempSync(joinPath(tmpdir(), 'sp09-')));
const CHROMIUM_ARGS = [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  `--use-file-for-fake-audio-capture=${FIXTURES.wav}`,
  '--autoplay-policy=no-user-gesture-required',
];
const FIREFOX_PREFS = {
  'media.navigator.streams.fake': true,
  'media.navigator.permission.disabled': true,
  'media.devices.unfocused.enabled': true,
  'media.autoplay.default': 0,
  'media.autoplay.block-webaudio': false,
};
const DEV_A = 'a1'.repeat(16);
const DEV_B = 'b2'.repeat(16);
const GROUP = 'c3'.repeat(16);
// The constants under test (gap G40 e, ruling F2); task 19 writes the confirmed values into presets.ts.
const MIC_OPTIONS = { audioPreset: { maxBitrate: 64_000, priority: 'high' }, dtx: true, red: false, forceStereo: false };
const SCREEN_AUDIO_OPTIONS = { audioPreset: { maxBitrate: 96_000 }, forceStereo: true, dtx: false, red: false };
const CAPTURE = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
// Task 19's capture options (processing on), used in the extra trap rows and the DTX-on-the-wire leg.
const MIC_CAPTURE = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function record(name: string, data: unknown): void {
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(joinPath(RESULTS, `${name}.json`), JSON.stringify(data, null, 2));
  console.log(`SPIKE ${name} ${JSON.stringify(data)}`);
}

// Runs before any page script: keeps every RTCPeerConnection the page creates.
function capturePeerConnections(): void {
  const Original = window.RTCPeerConnection;
  const pcs: RTCPeerConnection[] = [];
  (window as any).__pcs = pcs;
  class Captured extends Original {
    constructor(config?: RTCConfiguration) {
      super(config);
      pcs.push(this);
    }
  }
  (window as any).RTCPeerConnection = Captured;
}

async function harnessPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  await context.addInitScript(capturePeerConnections);
  const page = await context.newPage();
  await page.goto(HARNESS);
  await page.waitForFunction(() => 'harness' in window);
  return page;
}

async function connectDilla(page: Page, room: string, identity: string, selfLeaf: number): Promise<void> {
  const { url, token } = await debugToken(CONTROL, room, identity, true);
  const epoch = { groupId: GROUP, epoch: '1', baseKey: '0a'.repeat(16), selfLeaf, minEpoch: '1', roster: [{ leaf: 0, deviceId: DEV_A }, { leaf: 1, deviceId: DEV_B }] };
  await page.evaluate(
    ([u, t, e, instance]) => (window as any).harness.connect(u, t, { e2ee: 'dilla', iceServers: [], dilla: { epoch: e, lock: { instanceId: instance, callGroupId: e.groupId } } }),
    [url, token, epoch, identity] as const,
  );
}

/** The publisher-side view of one publication: its m-section in the remote and local SDP and its encoding. */
async function inspect(page: Page, source: string): Promise<any> {
  return page.evaluate(async (src) => {
    const lp = (window as any).harness.session().room.localParticipant;
    const sender: RTCRtpSender | undefined = lp.getTrackPublication(src)?.track?.sender;
    if (sender === undefined) return null;
    const opusFmtp = (section: string): string => {
      const pt = /a=rtpmap:(\d+) opus\/48000\/2/.exec(section)?.[1];
      return pt === undefined ? '' : (new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`).exec(section)?.[1] ?? '');
    };
    for (const pc of (window as any).__pcs as RTCPeerConnection[]) {
      if (pc.connectionState === 'closed' || pc.signalingState === 'closed') continue; // an earlier row's connection
      const t = pc.getTransceivers().find((x) => x.sender === sender);
      if (t === undefined || t.mid === null) continue;
      const midLine = new RegExp(`(^|\\r\\n)a=mid:${t.mid}(\\r\\n|$)`);
      const section = (sdp: string | undefined): string => (sdp ?? '').split(/\r\n(?=m=)/).find((p) => midLine.test(p)) ?? '';
      const remote = section(pc.remoteDescription?.sdp);
      const local = section(pc.localDescription?.sdp);
      return {
        mid: t.mid,
        remoteFmtp: opusFmtp(remote),
        localFmtp: opusFmtp(local),
        red: /a=rtpmap:\d+ red\/48000/i.test(remote),
        ptime: /a=ptime:/.test(remote) || /a=ptime:/.test(local),
        maxptime: /a=maxptime:/.test(remote) || /a=maxptime:/.test(local),
        maxBitrate: sender.getParameters().encodings?.[0]?.maxBitrate ?? null,
      };
    }
    return null;
  }, source);
}

/** Packets and payload bytes per second of one publication's outbound-rtp over a window. */
async function sendRate(page: Page, source: string, ms: number): Promise<{ packetsPerSecond: number; bitsPerSecond: number }> {
  const sent = (): Promise<[number, number]> => page.evaluate(async (src) => {
    const t = (window as any).harness.session().room.localParticipant.getTrackPublication(src).track;
    let n = 0;
    let b = 0;
    (await t.getRTCStatsReport())?.forEach((s: any) => { if (s.type === 'outbound-rtp') { n = s.packetsSent; b = s.bytesSent; } });
    return [n, b];
  }, source);
  const a = await sent();
  await sleep(ms);
  const z = await sent();
  return { packetsPerSecond: (z[0] - a[0]) / (ms / 1_000), bitsPerSecond: ((z[1] - a[1]) * 8) / (ms / 1_000) };
}

function verdictMic(i: any): Record<string, boolean> {
  return {
    usedtx: i.remoteFmtp.includes('usedtx=1'),
    useinbandfec: i.remoteFmtp.includes('useinbandfec=1'),
    noStereo: !/(^|;)stereo=1/.test(i.remoteFmtp),
    noRed: !i.red,
    noPtime: !i.ptime,
  };
}

function verdictScreen(i: any): Record<string, boolean> | null {
  if (i === null) return null;
  return {
    stereo: /(^|;)stereo=1/.test(i.remoteFmtp),
    maxaveragebitrate510000: i.remoteFmtp.includes('maxaveragebitrate=510000'),
    noUsedtx: !i.remoteFmtp.includes('usedtx=1'),
    noRed: !i.red,
  };
}

async function encryptedTotal(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const s = await (window as any).harness.mediaStats();
    let n = 0;
    for (const row of Object.values(s.encrypted as Record<string, Record<string, number>>)) for (const v of Object.values(row)) n += v;
    return n;
  });
}

async function decryptedTotal(page: Page): Promise<number> {
  return page.evaluate(async () => Object.values((await (window as any).harness.mediaStats()).decrypted as Record<string, number>).reduce((x, y) => x + y, 0));
}

/**
 * Screen-share audio without getDisplayMedia: a 2-channel 1 kHz MediaStreamAudioDestinationNode track published
 * with source ScreenShareAudio and SCREEN_AUDIO. The answer fmtp depends only on the AddTrackRequest (stereo,
 * disableDtx, TF_STEREO from the source's channelCount), so this checks the same options on the same path; it is
 * labelled synthetic wherever it is reported.
 */
async function publishSyntheticScreenAudio(page: Page): Promise<any> {
  await activate(page);
  const source = await page.evaluate(async (opts) => {
    const lp = (window as any).harness.session().room.localParticipant;
    const ctx = new AudioContext({ sampleRate: 48_000 });
    const dest = ctx.createMediaStreamDestination();
    const osc = ctx.createOscillator();
    osc.frequency.value = 1_000;
    osc.connect(dest);
    osc.start();
    const track = dest.stream.getAudioTracks()[0];
    (window as any).__sp09screenCtx = ctx;
    await lp.publishTrack(track, { ...opts, source: 'screen_share_audio' });
    return { channelCount: track.getSettings().channelCount ?? null };
  }, SCREEN_AUDIO_OPTIONS);
  await sleep(4_000);
  return { source, wire: await inspect(page, 'screen_share_audio') };
}

/**
 * A page-local loopback pair with LiveKit's answer fmtp; a sender transform counts frame sizes. `pad` > 0 makes the
 * counting transform append that many zero bytes to every frame (counted before the append), which stands in for
 * the dilla worker's per-frame SFrame overhead: it isolates whether a non-empty transform output for the encoder's
 * 0-byte DTX frames is what keeps the packet rate at 50/s.
 */
type ProbeInput = 'none' | 'zero' | 'tone';
async function dtxProbe(page: Page, ms: number, input: ProbeInput, pad = 0): Promise<any> {
  return page.evaluate(async ([duration, inp, padBytes]) => {
    const ctx = new AudioContext({ sampleRate: 48_000 });
    await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 2_000))]);
    const audioContextState = ctx.state;
    const audioClockStart = ctx.currentTime;
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 1;
    // 'none': the planned rig, a destination node with nothing connected. 'zero': a 1 kHz oscillator through a
    // GainNode at 0, so digital-zero samples keep flowing. 'tone': the oscillator at gain 1.
    if (inp !== 'none') {
      const osc = ctx.createOscillator();
      osc.frequency.value = 1_000;
      const gain = ctx.createGain();
      gain.gain.value = inp === 'tone' ? 1 : 0;
      osc.connect(gain).connect(dest);
      osc.start();
    }
    const track = dest.stream.getAudioTracks()[0];
    const src = [
      `const PAD = ${padBytes};`,
      'const s = { total: 0, zero: 0, upTo2: 0, other: 0, bytes: 0, maxGapMs: 0, last: 0 };',
      'onrtctransform = (e) => { const t = e.transformer; t.readable.pipeThrough(new TransformStream({ transform(f, c) {',
      '  const n = f.data.byteLength; s.total++; s.bytes += n; if (n === 0) s.zero++; else if (n <= 2) s.upTo2++; else s.other++;',
      '  if (PAD > 0) { const out = new Uint8Array(n + PAD); out.set(new Uint8Array(f.data)); f.data = out.buffer; }',
      '  const now = performance.now(); if (s.last > 0) s.maxGapMs = Math.max(s.maxGapMs, now - s.last); s.last = now; c.enqueue(f);',
      '} })).pipeTo(t.writable); };',
      'onmessage = () => postMessage(s);',
    ].join('\n');
    const worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    const a = new RTCPeerConnection();
    const b = new RTCPeerConnection();
    a.onicecandidate = (e) => { if (e.candidate) void b.addIceCandidate(e.candidate); };
    b.onicecandidate = (e) => { if (e.candidate) void a.addIceCandidate(e.candidate); };
    const sender = a.addTrack(track, dest.stream);
    sender.transform = new RTCRtpScriptTransform(worker, {}); // same task as addTrack: never bypassed (gap G1)
    const withDtx = (sdp: string): string => {
      const pt = /a=rtpmap:(\d+) opus\/48000\/2/.exec(sdp)?.[1];
      if (pt === undefined) return sdp;
      return sdp.replace(new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`), (line: string, p: string) => (p.includes('usedtx=1') ? line : `a=fmtp:${pt} ${p};usedtx=1`));
    };
    const offer = await a.createOffer();
    await a.setLocalDescription(offer);
    await b.setRemoteDescription({ type: 'offer', sdp: withDtx(offer.sdp ?? '') });
    const answer = await b.createAnswer();
    await b.setLocalDescription(answer);
    await a.setRemoteDescription({ type: 'answer', sdp: withDtx(answer.sdp ?? '') });
    await new Promise((r) => setTimeout(r, duration));
    const sizes: any = await new Promise((r) => { worker.onmessage = (e) => r(e.data); worker.postMessage(null); });
    delete sizes.last;
    let packetsSent = 0;
    let bytesSent = 0;
    (await sender.getStats()).forEach((s: any) => { if (s.type === 'outbound-rtp') { packetsSent = s.packetsSent; bytesSent = s.bytesSent; } });
    const answerFmtp = /a=fmtp:\d+ ([^\r\n]*usedtx[^\r\n]*)/.exec(a.remoteDescription?.sdp ?? '')?.[1] ?? '';
    // A running context's clock advances by about the phase length; a suspended one stays put.
    const audioClockAdvancedS = ctx.currentTime - audioClockStart;
    const audioContextStateAtEnd = ctx.state;
    a.close();
    b.close();
    worker.terminate();
    await ctx.close();
    return {
      ms: duration, input: inp, pad: padBytes, audioContextState, audioContextStateAtEnd, audioClockAdvancedS, answerFmtp, sizes,
      packetsSent, bytesSent, framesPerSecond: sizes.total / (duration / 1_000), packetsPerSecond: packetsSent / (duration / 1_000),
    };
  }, [ms, input, pad] as const);
}

// The trap matrix. Deviation from the planned rig (module source wins): livekit-client 2.22.3 throws 'Audio context
// needs to be set on LocalAudioTrack in order to enable processors' for a processor passed at capture time
// (createLocalTracks calls setProcessor, create.ts:140-141, before LocalParticipant.createTracks sets the room
// context at LocalParticipant.ts:697; gap G40 a). The trap shape is therefore built as
// createTracks → setProcessor → publishTrack ('before': publishTrack reads the processed track's channelCount for
// isStereoInput, LocalParticipant.ts:903-909). 'after' is task 19's order (setMicrophoneEnabled, then setProcessor),
// where the SDP was settled before the processor existed. Publish options: MIC explicit; `{}` (the Room's
// ROOM_DEFAULTS.publishDefaults, which equal MIC); 'unset' (forceStereo and dtx set to undefined after the room
// defaults merge: what livekit-client does on its own).
// Every row runs in its own fresh room and connection, three times: the first run of this spike reused one room
// for the whole matrix, and there the SFU sometimes answered a new microphone m-section before it had the track's
// info (participant_sdp.go: `ti == nil` → no `usedtx`/`stereo` rewrite), which made rows look run-dependent. A
// separate reused-room pass measures how often that happens. `trackInfo` is the server's view of the publication
// (TF_STEREO = 0, TF_NO_DTX = 1); `answerConfigured` says whether the answer fmtp matches it.
const CAPTURES = {
  'CAPTURE (processing off)': CAPTURE,
  'CAPTURE + channelCount 1 (processing off)': { ...CAPTURE, channelCount: 1 },
  'MIC_CAPTURE (processing on)': MIC_CAPTURE,
} as const;
const TRAP_REPEATS = 3;
type CaptureName = keyof typeof CAPTURES;
type TrapOptions = 'explicit' | 'defaults' | 'unset';
type TrapRow = { order: 'before' | 'after'; capture: CaptureName; options: TrapOptions; mono: boolean };
const TRAP_LABEL: Record<TrapOptions, string> = {
  explicit: 'MIC (explicit)',
  defaults: '{} (ROOM_DEFAULTS)',
  unset: 'forceStereo and dtx unset',
};
const TRAP_ROWS: TrapRow[] = [
  // The planned matrix (processor in place at publish).
  { order: 'before', capture: 'CAPTURE (processing off)', options: 'explicit', mono: false },
  { order: 'before', capture: 'CAPTURE (processing off)', options: 'defaults', mono: false },
  { order: 'before', capture: 'CAPTURE (processing off)', options: 'explicit', mono: true },
  { order: 'before', capture: 'CAPTURE (processing off)', options: 'defaults', mono: true },
  // Is the trap live without dilla's explicit options?
  { order: 'before', capture: 'CAPTURE (processing off)', options: 'unset', mono: false },
  { order: 'before', capture: 'CAPTURE (processing off)', options: 'unset', mono: true },
  // Does a mono capture constraint alone remove the source-driven TF_STEREO?
  { order: 'before', capture: 'CAPTURE + channelCount 1 (processing off)', options: 'explicit', mono: false },
  // Task 19's capture options and order.
  { order: 'before', capture: 'MIC_CAPTURE (processing on)', options: 'explicit', mono: false },
  { order: 'after', capture: 'MIC_CAPTURE (processing on)', options: 'explicit', mono: false },
  { order: 'after', capture: 'MIC_CAPTURE (processing on)', options: 'explicit', mono: true },
];

/** Publishes the microphone with a destination-node processor (the RNNoise shape) and reads source, processed and wire. */
async function stereoTrap(page: Page, row: TrapRow): Promise<any> {
  const state = await page.evaluate(async ([order, opt, capture, mic, m]) => {
    const lp = (window as any).harness.session().room.localParticipant;
    const publish = opt === 'explicit' ? mic : opt === 'defaults' ? {} : { forceStereo: undefined, dtx: undefined };
    const processor = {
      name: 'sp09-destination',
      processedTrack: undefined as MediaStreamTrack | undefined,
      ctx: undefined as AudioContext | undefined,
      async init(opts: { track: MediaStreamTrack }): Promise<void> {
        this.ctx = new AudioContext({ sampleRate: 48_000 });
        const dest = this.ctx.createMediaStreamDestination();
        if (m) dest.channelCount = 1;
        this.ctx.createMediaStreamSource(new MediaStream([opts.track])).connect(dest);
        this.processedTrack = dest.stream.getAudioTracks()[0];
      },
      async restart(opts: { track: MediaStreamTrack }): Promise<void> { await this.destroy(); await this.init(opts); },
      async destroy(): Promise<void> { await this.ctx?.close(); },
    };
    let track: any;
    if (order === 'before') {
      [track] = await lp.createTracks({ audio: capture });
      await track.setProcessor(processor);
      await lp.publishTrack(track, publish);
    } else {
      await lp.setMicrophoneEnabled(true, capture, publish);
      track = lp.getTrackPublication('microphone').track;
      await track.setProcessor(processor);
    }
    await new Promise((r) => setTimeout(r, 2_500));
    const encrypted = async (): Promise<number> => {
      const s = await (window as any).harness.mediaStats();
      let n = 0;
      for (const r of Object.values(s.encrypted as Record<string, Record<string, number>>)) for (const v of Object.values(r)) n += v;
      return n;
    };
    const e0 = await encrypted();
    await new Promise((r) => setTimeout(r, 2_000));
    const e1 = await encrypted();
    return {
      sourceChannelCount: track.getSourceTrackSettings().channelCount ?? null,
      processedChannelCount: processor.processedTrack?.getSettings().channelCount ?? null,
      senderCarriesProcessed: track.sender?.track === processor.processedTrack,
      encryptedPerSecondWhileProcessed: (e1 - e0) / 2,
    };
  }, [row.order, row.options, CAPTURES[row.capture], MIC_OPTIONS, row.mono] as const);
  const wire = await inspect(page, 'microphone');
  const trackInfo = await page.evaluate(() => {
    const ti = (window as any).harness.session().room.localParticipant.getTrackPublication('microphone')?.trackInfo;
    return ti === undefined ? null : { stereo: ti.stereo ?? null, disableDtx: ti.disableDtx ?? null, audioFeatures: [...(ti.audioFeatures ?? [])] };
  });
  await page.evaluate(async () => {
    const lp = (window as any).harness.session().room.localParticipant;
    await lp.unpublishTrack(lp.getTrackPublication('microphone').track);
  });
  await sleep(1_000);
  const stereo = wire === null ? null : /(^|;)stereo=1/.test(wire.remoteFmtp);
  const usedtx = wire === null ? null : wire.remoteFmtp.includes('usedtx=1');
  const tfStereo = trackInfo === null ? null : trackInfo.audioFeatures.includes(0);
  const tfNoDtx = trackInfo === null ? null : trackInfo.audioFeatures.includes(1);
  return {
    order: row.order === 'before' ? 'processor, then publish' : 'publish, then processor (task 19)',
    capture: row.capture,
    publishOptions: TRAP_LABEL[row.options],
    destination: row.mono ? 'channelCount = 1' : 'default (2)',
    ...state,
    remoteFmtp: wire?.remoteFmtp ?? null,
    stereo,
    usedtx,
    trackInfo,
    tfStereo,
    tfNoDtx,
    answerConfigured: wire === null || trackInfo === null ? null : stereo === tfStereo && usedtx === !tfNoDtx,
    wire,
  };
}

/** Outbound counters of one publication plus the manager's encrypt count, for a delta over a window. */
async function wireCounters(page: Page, source: string): Promise<{ packets: number; bytes: number; encrypted: number; dropped: Record<string, number> }> {
  return page.evaluate(async (src) => {
    const t = (window as any).harness.session().room.localParticipant.getTrackPublication(src).track;
    let packets = 0;
    let bytes = 0;
    (await t.getRTCStatsReport())?.forEach((s: any) => { if (s.type === 'outbound-rtp') { packets = s.packetsSent; bytes = s.bytesSent; } });
    const st = await (window as any).harness.mediaStats();
    let encrypted = 0;
    for (const row of Object.values(st.encrypted as Record<string, Record<string, number>>)) for (const v of Object.values(row)) encrypted += v;
    return { packets, bytes, encrypted, dropped: st.dropped };
  }, source);
}

test('chromium: microphone and screen-share audio on the wire, with the real manager', async ({ browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium leg');
  test.setTimeout(180_000);
  const browser = await chromium.launch({ channel: 'chromium', args: CHROMIUM_ARGS });
  const [A, B] = [await harnessPage(browser), await harnessPage(browser)];
  const room = 'sp09-chromium';
  await connectDilla(A, room, DEV_A, 0);
  await connectDilla(B, room, DEV_B, 1);
  await A.evaluate(([capture, mic]) => (window as any).harness.session().room.localParticipant.setMicrophoneEnabled(true, capture, mic), [CAPTURE, MIC_OPTIONS] as const);
  await sleep(4_000);
  const mic = await inspect(A, 'microphone');
  const micSource = await A.evaluate(() => (window as any).harness.session().room.localParticipant.getTrackPublication('microphone').track.getSourceTrackSettings());
  const micRate = await sendRate(A, 'microphone', 10_000);
  let screenShareError: string | null = null;
  await activate(A); // getDisplayMedia needs transient activation; page.evaluate grants none (fact 24)
  try {
    await A.evaluate((screen) => (window as any).harness.session().room.localParticipant.setScreenShareEnabled(true, { audio: true, systemAudio: 'include' }, screen), SCREEN_AUDIO_OPTIONS);
  } catch (e) {
    screenShareError = String(e);
  }
  await sleep(4_000);
  const screenAudio = await inspect(A, 'screen_share_audio');
  const screenAudioSource = await A.evaluate(() => {
    const t = (window as any).harness.session().room.localParticipant.getTrackPublication('screen_share_audio')?.track;
    return t === undefined ? null : { channelCount: t.getSourceTrackSettings().channelCount ?? null, label: t.mediaStreamTrack.label };
  });
  // Fallback when the fake display capture carries no audio: the same options on a synthetic stereo track.
  const synthetic = screenAudio === null ? await publishSyntheticScreenAudio(A) : null;
  const statsAtB = await B.evaluate(async () => (window as any).harness.mediaStats());
  const decryptedAtB = Object.values(statsAtB.decrypted as Record<string, number>).reduce((x, y) => x + y, 0);
  record('opus-sdp.chromium-publish', {
    browser: browser.version(),
    mic, micSource, micVerdict: verdictMic(mic), micPacketsPerSecond: micRate.packetsPerSecond, micBitsPerSecond: micRate.bitsPerSecond,
    screenShareError,
    screenAudio, screenAudioSource, screenAudioVerdict: verdictScreen(screenAudio),
    syntheticScreenAudio: synthetic, syntheticScreenAudioVerdict: synthetic === null ? null : verdictScreen(synthetic.wire),
    decryptedAtB,
    verifiedAtB: statsAtB.verified,
    droppedAtB: statsAtB.dropped,
  });
  expect(decryptedAtB).toBeGreaterThan(0); // rig sanity: the real manager carried the call
  await A.evaluate(() => (window as any).harness.disconnect());
  await B.evaluate(() => (window as any).harness.disconnect());
  await browser.close();
});

test('firefox: microphone on the wire, with the real manager', async ({ browserName }) => {
  test.skip(browserName !== 'firefox', 'Firefox leg');
  test.setTimeout(120_000);
  const browser = await firefox.launch({ firefoxUserPrefs: FIREFOX_PREFS });
  const A = await harnessPage(browser);
  await connectDilla(A, 'sp09-firefox', DEV_A, 0);
  await A.evaluate(([capture, mic]) => (window as any).harness.session().room.localParticipant.setMicrophoneEnabled(true, capture, mic), [CAPTURE, MIC_OPTIONS] as const);
  await sleep(4_000);
  const mic = await inspect(A, 'microphone');
  const micSource = await A.evaluate(() => (window as any).harness.session().room.localParticipant.getTrackPublication('microphone').track.getSourceTrackSettings());
  const micRate = await sendRate(A, 'microphone', 10_000);
  // Firefox has no headless getDisplayMedia: SCREEN_AUDIO is checked on a synthetic stereo track only.
  const synthetic = await publishSyntheticScreenAudio(A);
  const encrypted = await encryptedTotal(A);
  record('opus-sdp.firefox-publish', {
    browser: browser.version(),
    mic, micSource, micVerdict: verdictMic(mic), micPacketsPerSecond: micRate.packetsPerSecond, micBitsPerSecond: micRate.bitsPerSecond,
    maxaveragebitrate64000: mic?.remoteFmtp.includes('maxaveragebitrate=64000') ?? false,
    syntheticScreenAudio: synthetic, syntheticScreenAudioVerdict: verdictScreen(synthetic.wire),
    syntheticScreenAudioMaxaveragebitrate96000: synthetic.wire?.remoteFmtp.includes('maxaveragebitrate=96000') ?? false,
    encryptedAtA: encrypted,
  });
  expect(encrypted).toBeGreaterThan(0); // rig sanity: the real manager encrypted the publication
  await A.evaluate(() => (window as any).harness.disconnect());
  await browser.close();
});

for (const engine of ['chromium', 'firefox'] as const) {
  const launch = (): Promise<Browser> => (engine === 'chromium' ? chromium.launch({ channel: 'chromium', args: CHROMIUM_ARGS }) : firefox.launch({ firefoxUserPrefs: FIREFOX_PREFS }));

  test(`${engine}: frame sizes in a sender transform over 60 s of DTX silence, and 10 s of tone`, async ({ browserName }) => {
    test.skip(browserName !== engine, `${engine} leg`);
    test.setTimeout(300_000);
    const browser = await launch();
    const page = await harnessPage(browser);
    await activate(page);
    const silenceNoInput = await dtxProbe(page, 60_000, 'none');
    await activate(page);
    const silence = await dtxProbe(page, 60_000, 'zero');
    await activate(page);
    // 19 bytes: the per-frame growth the real manager showed (about 960 payload B/s at 50 packets/s in silence).
    const silencePadded = await dtxProbe(page, 20_000, 'zero', 19);
    await activate(page);
    const tone = await dtxProbe(page, 10_000, 'tone');
    record(`opus-sdp.${engine}-dtx`, { browser: browser.version(), silenceNoInput, silence, silencePadded, tone });
    await browser.close();
  });

  test(`${engine}: destination-node channel count and the stereo trap`, async ({ browserName }) => {
    test.skip(browserName !== engine, `${engine} leg`);
    test.setTimeout(900_000);
    const browser = await launch();
    const A = await harnessPage(browser);
    const rows = [];
    for (let rep = 1; rep <= TRAP_REPEATS; rep++) {
      for (const [i, row] of TRAP_ROWS.entries()) {
        await connectDilla(A, `sp09-trap-${engine}-${rep}-${i}`, DEV_A, 0);
        rows.push({ rep, room: 'fresh', ...(await stereoTrap(A, row)) });
        await A.evaluate(() => (window as any).harness.disconnect());
      }
    }
    // The first run's shape: the whole matrix in one reused room, for the unconfigured-answer rate.
    await connectDilla(A, `sp09-trap-${engine}-reused`, DEV_A, 0);
    const reused = [];
    for (const row of TRAP_ROWS) reused.push({ room: 'reused', ...(await stereoTrap(A, row)) });
    await A.evaluate(() => (window as any).harness.disconnect());
    record(`opus-sdp.${engine}-trap`, { browser: browser.version(), rows, reused });
    await browser.close();
  });

  // Added by the implementer: DTX on the real wire. The publisher's microphone runs through a processor whose output
  // is a 1 kHz oscillator behind a GainNode (0 = digital silence, 1 = tone), so the real dilla worker sees what the
  // encoder emits in DTX; B decrypts. Counters are deltas over each phase.
  test(`${engine}: DTX silence through the real manager on the wire`, async ({ browserName }) => {
    test.skip(browserName !== engine, `${engine} leg`);
    test.setTimeout(180_000);
    const browser = await launch();
    const [A, B] = [await harnessPage(browser), await harnessPage(browser)];
    const room = `sp09-dtx-${engine}`;
    await connectDilla(A, room, DEV_A, 0);
    await connectDilla(B, room, DEV_B, 1);
    await activate(A);
    await A.evaluate(async ([cap, mic]) => {
      const lp = (window as any).harness.session().room.localParticipant;
      await lp.setMicrophoneEnabled(true, cap, mic);
      const track = lp.getTrackPublication('microphone').track;
      const ctx = new AudioContext({ sampleRate: 48_000 });
      await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 2_000))]);
      const dest = ctx.createMediaStreamDestination();
      dest.channelCount = 1;
      const osc = ctx.createOscillator();
      osc.frequency.value = 1_000;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain).connect(dest);
      osc.start();
      (window as any).__sp09gain = gain;
      (window as any).__sp09ctx = ctx;
      await track.setProcessor({
        name: 'sp09-silence',
        processedTrack: dest.stream.getAudioTracks()[0],
        async init(): Promise<void> {},
        async restart(): Promise<void> {},
        async destroy(): Promise<void> { await ctx.close(); },
      });
    }, [MIC_CAPTURE, MIC_OPTIONS] as const);
    await sleep(4_000);
    const wire = await inspect(A, 'microphone');
    const phase = async (gainValue: number, ms: number): Promise<any> => {
      await A.evaluate((g) => { (window as any).__sp09gain.gain.value = g; }, gainValue);
      await sleep(2_000); // settle into the phase before counting
      const clock0 = await A.evaluate(() => (window as any).__sp09ctx.currentTime as number);
      const [a0, b0] = [await wireCounters(A, 'microphone'), await decryptedTotal(B)];
      await sleep(ms);
      const [a1, b1] = [await wireCounters(A, 'microphone'), await decryptedTotal(B)];
      const ctxNow = await A.evaluate(() => ({ state: (window as any).__sp09ctx.state as string, t: (window as any).__sp09ctx.currentTime as number }));
      const s = ms / 1_000;
      const droppedDelta = Object.fromEntries(Object.entries(a1.dropped).map(([k, v]) => [k, v - (a0.dropped[k] ?? 0)]).filter(([, v]) => (v as number) > 0));
      return {
        gain: gainValue, ms,
        audioContextState: ctxNow.state,
        audioClockAdvancedS: ctxNow.t - clock0,
        packetsPerSecond: (a1.packets - a0.packets) / s,
        bytesPerSecond: (a1.bytes - a0.bytes) / s,
        bytesPerPacket: a1.packets === a0.packets ? null : (a1.bytes - a0.bytes) / (a1.packets - a0.packets),
        encryptedPerSecond: (a1.encrypted - a0.encrypted) / s,
        decryptedAtBPerSecond: (b1 - b0) / s,
        droppedAtA: droppedDelta,
      };
    };
    const silence = await phase(0, 20_000);
    const tone = await phase(1, 10_000);
    record(`opus-sdp.${engine}-dtx-wire`, { browser: browser.version(), capture: MIC_CAPTURE, wire, silence, tone });
    expect(tone.decryptedAtBPerSecond).toBeGreaterThan(0); // rig sanity
    await A.evaluate(() => (window as any).harness.disconnect());
    await B.evaluate(() => (window as any).harness.disconnect());
    await browser.close();
  });
}

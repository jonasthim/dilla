import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Room } from 'livekit-client';
import { DATA_CHANNEL_ERROR, DATA_ERROR, DillaE2EEManager, INIT_TIMEOUT_MS, type EpochKeys } from '../src/manager';
import type { DillaMediaStats, FromWorker } from '../src/protocol';
import { parseToWorker } from '../src/worker/messages';
import { kidHex } from '../src/worker/stats';

/* eslint-disable @typescript-eslint/no-explicit-any */
const DEV_LOCAL = 'a1'.repeat(16);
const DEV_B = 'b2'.repeat(16);

class FakeWorker extends EventTarget {
  posted: Array<{ msg: any; transfer: Transferable[] }> = [];
  postMessage(msg: unknown, transfer: Transferable[] = []): void { this.posted.push({ msg, transfer }); }
  terminate(): void {}
  reply(data: FromWorker): void { this.dispatchEvent(new MessageEvent('message', { data })); }
  last(kind: string): { msg: any; transfer: Transferable[] } | undefined { return [...this.posted].reverse().find((p) => p.msg.kind === kind); }
}

class Emitter {
  private l = new Map<string, Array<(...a: any[]) => void>>();
  on(e: string, f: (...a: any[]) => void): this { this.l.set(e, [...(this.l.get(e) ?? []), f]); return this; }
  prependListener(e: string, f: (...a: any[]) => void): this { this.l.set(e, [f, ...(this.l.get(e) ?? [])]); return this; }
  off(e: string, f: (...a: any[]) => void): this { this.l.set(e, (this.l.get(e) ?? []).filter((x) => x !== f)); return this; }
  emit(e: string, ...a: any[]): boolean { for (const f of this.l.get(e) ?? []) f(...a); return true; }
}

function setup(log?: (level: string, msg: string) => void): { w: FakeWorker; m: DillaE2EEManager; room: any; lp: any; engine: Emitter } {
  const w = new FakeWorker();
  const m = new DillaE2EEManager(w as unknown as Worker, { log });
  const lp = Object.assign(new Emitter(), { identity: DEV_LOCAL, isE2EEEnabled: true, unpublishTrack: vi.fn(async () => undefined) });
  const room = Object.assign(new Emitter(), { localParticipant: lp, remoteParticipants: new Map<string, any>() });
  const engine = new Emitter();
  m.setup(room as unknown as Room);
  m.setupEngine(engine);
  w.reply({ kind: 'initAck', v: 1, scriptTransform: false });
  return { w, m, room, lp, engine };
}

/** A LocalTrack as LocalSenderCreated hands it over; `media` is its MediaStreamTrack. */
function localTrack(source: string, kind: 'audio' | 'video', id: string, codec?: string): any {
  return { source, kind, mediaStreamID: id, codec, mediaStreamTrack: { kind, stop: vi.fn() } };
}

/** A remote MediaStreamTrack as MediaTrackAdded hands it over. */
function remoteTrack(id: string, kind: 'audio' | 'video'): any {
  return { id, kind, stop: vi.fn() };
}

const streamsRtp = (): { createEncodedStreams: ReturnType<typeof vi.fn> } => ({
  createEncodedStreams: vi.fn(() => ({ readable: new ReadableStream(), writable: new WritableStream() })),
});

class FakeScriptTransform {
  static throwWhen: (options: any) => boolean = () => false;
  constructor(public worker: unknown, public options: any) {
    if (FakeScriptTransform.throwWhen(options)) throw new DOMException('cannot', 'InvalidStateError');
  }
}

const microtasks = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

function keys(epoch = 5n, roster = [{ leaf: 0, deviceId: DEV_LOCAL }, { leaf: 1, deviceId: DEV_B }]): EpochKeys {
  return { groupId: 'call-group', epoch, baseKey: new Uint8Array(16).fill(7), selfLeaf: 0, minEpoch: epoch, roster };
}

async function install(w: FakeWorker, m: DillaE2EEManager, k: EpochKeys = keys()): Promise<void> {
  const p = m.installEpoch(k);
  await vi.waitFor(() => expect(w.last('installEpoch')?.msg.epoch).toBe(k.epoch));
  w.reply({ kind: 'epochInstalled', epoch: k.epoch });
  await p;
}

afterEach(() => vi.unstubAllGlobals());

describe('DillaE2EEManager (interfaces.md c.4)', () => {
  it('owns the worker and posts init with the wasm URL first', () => {
    const w = new FakeWorker();
    new DillaE2EEManager(w as unknown as Worker);
    expect(w.posted[0].msg).toMatchObject({ kind: 'init', v: 1, logLevel: 'warn' });
    expect(w.posted[0].msg.wasmUrl).toMatch(/\/wasm\/dilla_core_wasm_bg\.wasm$/);
  });

  it('installEpoch transfers a copy of the key, zeroes the caller’s key and resolves on epochInstalled', async () => {
    const { w, m } = setup();
    const k = keys();
    const p = m.installEpoch(k);
    await vi.waitFor(() => expect(w.last('installEpoch')).toBeDefined());
    const posted = w.last('installEpoch')!;
    expect(posted.msg).toMatchObject({ groupId: 'call-group', epoch: 5n, selfLeaf: 0, roster: k.roster });
    expect(posted.transfer).toEqual([posted.msg.baseKey.buffer]);
    expect([...posted.msg.baseKey]).toEqual(new Array(16).fill(7));
    expect([...k.baseKey]).toEqual(new Array(16).fill(0));
    w.reply({ kind: 'epochInstalled', epoch: 5n });
    await expect(p).resolves.toBeUndefined();
  });

  it('refuses a first epoch below minEpoch (N1), a short key and a roster entry that is not a device', async () => {
    const { m } = setup();
    await expect(m.installEpoch({ ...keys(4n), minEpoch: 5n })).rejects.toThrow('E_NO_EPOCH');
    await expect(m.installEpoch({ ...keys(), baseKey: new Uint8Array(15) })).rejects.toThrow('E_BAD_OPTIONS');
    await expect(m.installEpoch(keys(5n, [{ leaf: 0, deviceId: 'nope' }]))).rejects.toThrow('E_BAD_OPTIONS');
  });

  it('rejects a pending install when the worker reports E_WASM', async () => {
    const { w, m } = setup();
    const p = m.installEpoch(keys());
    await vi.waitFor(() => expect(w.last('installEpoch')).toBeDefined());
    w.reply({ kind: 'error', code: 'E_WASM' });
    await expect(p).rejects.toThrow('E_WASM');
  });

  it('attaches a receiver synchronously inside MediaTrackAdded on the createEncodedStreams path', () => {
    const { w, engine } = setup();
    const readable = new ReadableStream();
    const writable = new WritableStream();
    const createEncodedStreams = vi.fn(() => ({ readable, writable }));
    const receiver = { createEncodedStreams };
    engine.emit('mediaTrackAdded', { id: 'rx-1', kind: 'video' }, {}, receiver);
    const a = w.last('attach')!; // no await between the event and this read
    expect(a.msg.data).toMatchObject({ dilla: 1, side: 'decode', trackId: 'rx-1', participantIdentity: '', slot: 1, codec: 'vp8' });
    expect(a.transfer).toEqual([readable, writable]);
    engine.emit('mediaTrackAdded', { id: 'rx-2', kind: 'video' }, {}, receiver);
    expect(createEncodedStreams).toHaveBeenCalledTimes(1);
    expect(w.last('retarget')!.msg.data).toMatchObject({ previousTrackId: 'rx-1', trackId: 'rx-2', side: 'decode' });
  });

  it('attaches a receiver with RTCRtpScriptTransform where createEncodedStreams does not exist', () => {
    class FakeScriptTransform { constructor(public worker: unknown, public options: any) {} }
    vi.stubGlobal('RTCRtpScriptTransform', FakeScriptTransform);
    const { w, engine } = setup();
    const receiver: { transform?: unknown } = {};
    engine.emit('mediaTrackAdded', { id: 'rx-3', kind: 'audio' }, {}, receiver);
    expect(receiver.transform).toBeInstanceOf(FakeScriptTransform);
    const t = receiver.transform as FakeScriptTransform;
    expect(t.worker).toBe(w);
    expect(t.options).toMatchObject({ dilla: 1, side: 'decode', trackId: 'rx-3', slot: 0, codec: 'opus' });
  });

  it('attaches a sender synchronously in LocalSenderCreated with the slot of the track', () => {
    const { w, lp, m } = setup();
    const errors: Error[] = [];
    m.on('encryptionError', (e: Error) => errors.push(e));
    lp.emit('localSenderCreated', streamsRtp(), localTrack('microphone', 'audio', 'tx-mic'));
    expect(w.last('attach')!.msg.data).toMatchObject({ side: 'encode', trackId: 'tx-mic', participantIdentity: DEV_LOCAL, slot: 0, codec: 'opus' });
    lp.emit('localSenderCreated', streamsRtp(), localTrack('camera', 'video', 'tx-cam', 'h264'));
    expect(w.last('attach')!.msg.data).toMatchObject({ side: 'encode', trackId: 'tx-cam', slot: 1, codec: 'h264' });
    expect(errors).toEqual([]);
  });

  // Replaces the test that asserted the fail-open behaviour (no attach, one error) for an unknown source.
  it('blocks an unknown-source sender on the streams path, reports it and unpublishes it in a microtask', async () => {
    const { w, lp, m } = setup();
    const errors: Error[] = [];
    m.on('encryptionError', (e: Error) => errors.push(e));
    const rtp = streamsRtp();
    const track = localTrack('unknown', 'video', 'tx-x');
    lp.emit('localSenderCreated', rtp, track);
    expect(rtp.createEncodedStreams).toHaveBeenCalledTimes(1);
    expect(w.last('attach')!.msg.data).toMatchObject({ dilla: 1, side: 'encode', trackId: 'tx-x', block: true });
    expect(parseToWorker(w.last('attach')!.msg)).not.toBeNull();
    expect(errors.map((e) => e.message)).toEqual([expect.stringContaining('E_BAD_OPTIONS')]);
    expect(lp.unpublishTrack).not.toHaveBeenCalled(); // not from inside livekit's emit
    await microtasks();
    expect(lp.unpublishTrack).toHaveBeenCalledWith(track);
    // the same sender reused for a camera: the blocked handle is upgraded by retarget
    lp.emit('localSenderCreated', rtp, localTrack('camera', 'video', 'tx-cam'));
    expect(rtp.createEncodedStreams).toHaveBeenCalledTimes(1);
    expect(w.last('retarget')!.msg.data).toMatchObject({ previousTrackId: 'tx-x', trackId: 'tx-cam', side: 'encode', slot: 1 });
  });

  it('maps a subscribed track and detaches an unsubscribed one; an AV1 publication is never mapped', () => {
    const { w, room, m } = setup();
    const errors: Error[] = [];
    m.on('encryptionError', (e: Error) => errors.push(e));
    room.emit('trackSubscribed', { kind: 'video', mediaStreamID: 'rx-1' }, { source: 'camera', trackInfo: { mimeType: 'video/VP8', encryption: 1 } }, { identity: DEV_B });
    expect(w.last('mapTrack')!.msg).toEqual({ kind: 'mapTrack', trackId: 'rx-1', participantIdentity: DEV_B, slot: 1, codec: 'vp8', encryption: 1 });
    room.emit('trackUnsubscribed', { mediaStreamID: 'rx-1' });
    expect(w.last('detach')!.msg).toEqual({ kind: 'detach', trackId: 'rx-1' });
    const before = w.posted.length;
    room.emit('trackSubscribed', { kind: 'video', mediaStreamID: 'rx-9' }, { source: 'camera', trackInfo: { mimeType: 'video/AV1', encryption: 1 } }, { identity: DEV_B });
    expect(w.posted).toHaveLength(before);
    expect(errors.at(-1)?.message).toContain('E_BAD_OPTIONS');
  });

  it('forwards the SIF trailer as a copy and ignores an empty one', () => {
    const { w, m } = setup();
    const t = new TextEncoder().encode('x'.repeat(44));
    m.setSifTrailer(t);
    const p = w.last('setSifTrailer')!;
    expect(p.msg.trailer).toEqual(t);
    expect(p.msg.trailer).not.toBe(t);
    const before = w.posted.length;
    m.setSifTrailer(new Uint8Array(0));
    expect(w.posted).toHaveLength(before);
  });

  it('self-enables on SignalConnected only after an epoch is installed, exactly once', async () => {
    const { w, m, room, lp } = setup();
    const events: unknown[][] = [];
    m.on('participantEncryptionStatusChanged', (e: boolean, p: unknown) => events.push([e, p]));
    room.emit('signalConnected');
    expect(events).toEqual([]);
    expect(m.isEnabled).toBe(false);
    await install(w, m);
    expect(events).toEqual([[true, lp]]);
    expect(m.isEnabled).toBe(true);
    room.emit('signalConnected');
    m.setParticipantCryptorEnabled(true, DEV_LOCAL);
    expect(events).toHaveLength(1);
  });

  it('a signal connect without setE2EEEnabled(true) reports E_E2EE_REQUIRED and does not throw into livekit', () => {
    const { m, room, lp } = setup();
    lp.isE2EEEnabled = false;
    const errors: Error[] = [];
    m.on('encryptionError', (e: Error) => errors.push(e));
    expect(() => room.emit('signalConnected')).not.toThrow();
    expect(errors.map((e) => e.message)).toEqual(['E_E2EE_REQUIRED']);
  });

  it('refuses setParticipantCryptorEnabled(false): emits encryptionError, throws, posts nothing (DEV-14)', () => {
    const { w, m } = setup();
    const errors: unknown[][] = [];
    m.on('encryptionError', (e: Error, id: string) => errors.push([e.message, id]));
    const before = w.posted.length;
    expect(() => m.setParticipantCryptorEnabled(false, DEV_LOCAL)).toThrow('E_E2EE_REQUIRED');
    expect(errors).toEqual([['E_E2EE_REQUIRED', DEV_LOCAL]]);
    expect(w.posted).toHaveLength(before);
  });

  it('reports remote status from the rosters of held epochs, deduped per identity', async () => {
    const { w, m, room } = setup();
    const pB = { identity: DEV_B };
    const pX = { identity: 'not-a-device' };
    room.remoteParticipants.set('PA_b', pB);
    room.remoteParticipants.set('PA_x', pX);
    const events: unknown[][] = [];
    m.on('participantEncryptionStatusChanged', (e: boolean, p: { identity: string }) => events.push([e, p.identity]));
    await install(w, m);
    expect(events).toEqual(expect.arrayContaining([[true, DEV_B], [false, 'not-a-device']]));
    const n = events.length;
    room.emit('participantConnected', pB);
    room.emit('trackPublished', {}, pB);
    expect(events).toHaveLength(n);
    w.reply({ kind: 'epochRetired', epoch: 5n });
    expect(events.at(-1)).toEqual([false, DEV_B]);
  });

  it('has no data-channel encryption: the setter throws on true, both data methods reject (G11)', async () => {
    const { m } = setup();
    expect(m.isDataChannelEncryptionEnabled).toBe(false);
    m.isDataChannelEncryptionEnabled = false;
    expect(() => { m.isDataChannelEncryptionEnabled = true; }).toThrow(DATA_CHANNEL_ERROR);
    await expect(m.encryptData(new Uint8Array(4))).rejects.toThrow(DATA_ERROR);
    await expect(m.handleEncryptedData(new Uint8Array(4), new Uint8Array(12), DEV_B, 0)).rejects.toThrow('E_DATA_E2EE_UNSUPPORTED');
  });

  it('answers stats() from the worker reply with the same id', async () => {
    const { w, m } = setup();
    const p = m.stats();
    const req = w.last('stats')!;
    const data = { passedThrough: 0, currentEpoch: '5' } as unknown as DillaMediaStats;
    w.reply({ kind: 'stats', id: req.msg.id, data });
    await expect(p).resolves.toBe(data);
  });

  it('dispose posts clearKeys and removes every listener', () => {
    const { w, m, room } = setup();
    m.on('participantEncryptionStatusChanged', () => undefined);
    m.dispose();
    expect(w.last('clearKeys')).toBeDefined();
    room.emit('trackUnsubscribed', { mediaStreamID: 'rx-1' });
    expect(w.last('detach')).toBeUndefined();
    expect(m.listenerCount('participantEncryptionStatusChanged')).toBe(0);
  });

  it('posts only dilla-media/1 messages: never enable, setKey or ratchetRequest (DEV-12, DEV-14)', async () => {
    const { w, m, room, lp, engine } = setup();
    await install(w, m);
    room.emit('signalConnected');
    m.setSifTrailer(new TextEncoder().encode('t'.repeat(43)));
    engine.emit('mediaTrackAdded', { id: 'rx-1', kind: 'video' }, {}, { createEncodedStreams: () => ({ readable: new ReadableStream(), writable: new WritableStream() }) });
    lp.emit('localSenderCreated', streamsRtp(), localTrack('microphone', 'audio', 'tx-mic'));
    lp.emit('localSenderCreated', streamsRtp(), localTrack('unknown', 'video', 'tx-x'));
    room.emit('trackSubscribed', { kind: 'video', mediaStreamID: 'rx-1' }, { source: 'camera', trackInfo: { mimeType: 'video/VP8', encryption: 1 } }, { identity: DEV_B });
    m.stats().catch(() => undefined); // dispose below rejects it (M2)
    expect(() => m.setParticipantCryptorEnabled(false, DEV_LOCAL)).toThrow('E_E2EE_REQUIRED');
    m.dispose();
    const kinds = w.posted.map((p) => p.msg.kind);
    expect(kinds).not.toContain('enable');
    expect(kinds).not.toContain('setKey');
    expect(kinds).not.toContain('ratchetRequest');
    for (const p of w.posted) expect(parseToWorker(p.msg), `posted ${p.msg.kind}`).not.toBeNull();
  });

  it('nothing in packages/media calls setE2EEEnabled(false) (DEV-14)', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const offenders: string[] = [];
    for (const dir of ['src', 'harness']) {
      for (const f of readdirSync(join(root, dir), { recursive: true }) as string[]) {
        if (!/\.(?:ts|js|mjs)$/.test(f)) continue;
        if (/setE2EEEnabled\(\s*false\s*\)/.test(readFileSync(join(root, dir, f), 'utf8'))) offenders.push(`${dir}/${f}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// C1 (task 17 review, fix round 1): no sender or receiver the manager has seen is ever left without a transform that
// drops by default, on either browser path, whatever the SFU sends and whatever fails.
describe('fail closed on the script-transform path (Firefox, Safari)', () => {
  afterEach(() => { FakeScriptTransform.throwWhen = () => false; });

  function scriptSetup(): ReturnType<typeof setup> & { errors: Error[] } {
    vi.stubGlobal('RTCRtpScriptTransform', FakeScriptTransform);
    const s = setup();
    const errors: Error[] = [];
    s.m.on('encryptionError', (e: Error) => errors.push(e));
    return { ...s, errors };
  }

  it('gives every sender a transform: each source, an unknown source and a server-forced codec label', async () => {
    const { lp, errors } = scriptSetup();
    const cases: Array<[string, 'audio' | 'video', string | undefined, Record<string, unknown>]> = [
      ['microphone', 'audio', undefined, { side: 'encode', slot: 0, participantIdentity: DEV_LOCAL }],
      ['camera', 'video', 'vp8', { side: 'encode', slot: 1 }],
      ['screen_share', 'video', 'vp9', { side: 'encode', slot: 2 }],
      ['screen_share_audio', 'audio', undefined, { side: 'encode', slot: 3 }],
      ['camera', 'video', 'av1', { side: 'encode', slot: 1, participantIdentity: DEV_LOCAL }], // label from JoinResponse.enabledPublishCodecs
      ['camera', 'video', 'h265', { side: 'encode', slot: 1 }],
      ['unknown', 'video', 'vp8', { side: 'encode', block: true }],
      ['camera', 'audio', undefined, { side: 'encode', block: true }], // kind does not match the source
    ];
    const senders = cases.map(([source, kind, codec], i) => {
      const sender: { transform?: FakeScriptTransform } = {};
      lp.emit('localSenderCreated', sender, localTrack(source, kind, `tx-${i}`, codec));
      return sender;
    });
    senders.forEach((s, i) => {
      expect(s.transform, `sender ${i}`).toBeInstanceOf(FakeScriptTransform);
      expect(s.transform!.options).toMatchObject({ dilla: 1, trackId: `tx-${i}`, ...cases[i][3] });
    });
    expect(errors).toHaveLength(2); // only the two blocked senders
    await microtasks();
    expect(lp.unpublishTrack).toHaveBeenCalledTimes(2);
  });

  it('assigns a blocking transform when the RTCRtpScriptTransform constructor refuses the options', async () => {
    const { lp, engine, errors } = scriptSetup();
    FakeScriptTransform.throwWhen = (o) => o.block !== true;
    const sender: { transform?: FakeScriptTransform } = {};
    const track = localTrack('camera', 'video', 'tx-cam', 'vp8');
    lp.emit('localSenderCreated', sender, track);
    expect(sender.transform?.options).toEqual({ dilla: 1, side: 'encode', trackId: 'tx-cam', block: true });
    expect(track.mediaStreamTrack.stop).not.toHaveBeenCalled();
    const receiver: { transform?: FakeScriptTransform } = {};
    const rx = remoteTrack('rx-1', 'video');
    engine.emit('mediaTrackAdded', rx, {}, receiver);
    expect(receiver.transform?.options).toEqual({ dilla: 1, side: 'decode', trackId: 'rx-1', block: true });
    expect(rx.stop).not.toHaveBeenCalled();
    expect(errors).toHaveLength(2);
    await microtasks();
    expect(lp.unpublishTrack).toHaveBeenCalledWith(track);
  });

  it('stops the track when no transform at all can be constructed', async () => {
    const { lp, engine, errors } = scriptSetup();
    FakeScriptTransform.throwWhen = () => true;
    const sender: { transform?: unknown } = {};
    const track = localTrack('microphone', 'audio', 'tx-mic');
    lp.emit('localSenderCreated', sender, track);
    expect(sender.transform).toBeUndefined();
    expect(track.mediaStreamTrack.stop).toHaveBeenCalled();
    const rx = remoteTrack('rx-1', 'audio');
    expect(() => engine.emit('mediaTrackAdded', rx, {}, {})).not.toThrow();
    expect(rx.stop).toHaveBeenCalled();
    expect(errors).toHaveLength(2);
    await microtasks();
    expect(lp.unpublishTrack).toHaveBeenCalledWith(track);
  });

  it('stops the track when assigning the transform throws (a setter that refuses)', () => {
    const { engine } = scriptSetup();
    const rx = remoteTrack('rx-1', 'video');
    const receiver = Object.defineProperty({}, 'transform', { set() { throw new DOMException('no', 'InvalidStateError'); } });
    engine.emit('mediaTrackAdded', rx, {}, receiver);
    expect(rx.stop).toHaveBeenCalled();
  });
});

describe('fail closed on the createEncodedStreams path (Chromium, Electron)', () => {
  it('a server-forced codec label still attaches the encoder: the worker decides per frame', () => {
    const { w, lp, m } = setup();
    const errors: Error[] = [];
    m.on('encryptionError', (e: Error) => errors.push(e));
    lp.emit('localSenderCreated', streamsRtp(), localTrack('camera', 'video', 'tx-cam', 'av1'));
    expect(w.last('attach')!.msg.data).toMatchObject({ side: 'encode', trackId: 'tx-cam', slot: 1, participantIdentity: DEV_LOCAL });
    expect(w.last('attach')!.msg.data.block).toBeUndefined();
    expect(errors).toEqual([]);
  });

  it('a sender whose createEncodedStreams throws is stopped, reported and unpublished, and stays dead', async () => {
    const { w, lp, m } = setup();
    const errors: Error[] = [];
    m.on('encryptionError', (e: Error) => errors.push(e));
    const rtp = { createEncodedStreams: vi.fn(() => { throw new DOMException('Encoded streams already created', 'InvalidStateError'); }) };
    const track = localTrack('camera', 'video', 'tx-cam', 'vp8');
    expect(() => lp.emit('localSenderCreated', rtp, track)).not.toThrow();
    expect(w.last('attach')).toBeUndefined();
    expect(track.mediaStreamTrack.stop).toHaveBeenCalled();
    expect(errors).toHaveLength(1);
    await microtasks();
    expect(lp.unpublishTrack).toHaveBeenCalledWith(track);
    const again = localTrack('camera', 'video', 'tx-cam-2', 'vp8');
    lp.emit('localSenderCreated', rtp, again);
    expect(rtp.createEncodedStreams).toHaveBeenCalledTimes(1);
    expect(w.last('retarget')).toBeUndefined();
    expect(again.mediaStreamTrack.stop).toHaveBeenCalled();
  });

  it('a receiver whose createEncodedStreams throws is stopped and reported, never left bare', () => {
    const { w, engine, m } = setup();
    const errors: Error[] = [];
    m.on('encryptionError', (e: Error) => errors.push(e));
    const rx = remoteTrack('rx-1', 'video');
    expect(() => engine.emit('mediaTrackAdded', rx, {}, { createEncodedStreams: () => { throw new TypeError('boom'); } })).not.toThrow();
    expect(rx.stop).toHaveBeenCalled();
    expect(w.last('attach')).toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it('a pair that cannot be posted to the worker is stopped and its frames discarded on the main thread', () => {
    const { w, engine } = setup();
    w.postMessage = (msg: any): void => { if (msg.kind === 'attach') throw new DOMException('not transferable', 'DataCloneError'); };
    const rx = remoteTrack('rx-1', 'audio');
    const readable = new ReadableStream();
    engine.emit('mediaTrackAdded', rx, {}, { createEncodedStreams: () => ({ readable, writable: new WritableStream() }) });
    expect(rx.stop).toHaveBeenCalled();
    expect(readable.locked).toBe(true); // piped to a discarding sink
  });
});

// N1 (task 17 re-review): livekit-client's pre-connect buffer records the microphone with a MediaRecorder and, once
// the SFU echoes TF_PRECONNECT_BUFFER, streams the recording over the (unencrypted) data channel after negotiation
// (LocalParticipant.ts:1385-1444). LocalSenderCreated (:1244) runs before that read (:1389), so the manager stops the
// recorder there, discards what it buffered, blocks the sender and unpublishes the track.
describe('pre-connect buffer and frame metadata requested per publish (N1)', () => {
  function recordingTrack(): any {
    const buffer = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1, 2, 3])); } });
    const t = localTrack('microphone', 'audio', 'tx-mic');
    let recorder = true;
    Object.defineProperty(t, 'hasPreConnectBuffer', { get: () => recorder });
    t.getPreConnectBuffer = vi.fn(() => (recorder ? buffer : undefined));
    t.stopPreConnectBuffer = vi.fn(() => { recorder = false; });
    t.buffer = buffer;
    return t;
  }

  for (const path of ['streams', 'script'] as const) {
    it(`stops an active recorder, discards its buffer, blocks the sender and unpublishes it (${path} path)`, async () => {
      if (path === 'script') vi.stubGlobal('RTCRtpScriptTransform', FakeScriptTransform);
      const { w, lp, m } = setup();
      const errors: Error[] = [];
      m.on('encryptionError', (e: Error) => errors.push(e));
      const t = recordingTrack();
      const sender: any = path === 'streams' ? streamsRtp() : {};
      lp.emit('localSenderCreated', sender, t);
      expect(t.stopPreConnectBuffer).toHaveBeenCalled();
      expect(t.hasPreConnectBuffer).toBe(false);
      expect(t.getPreConnectBuffer()).toBeUndefined(); // what LocalParticipant.ts:1389 reads next
      await expect(t.buffer.getReader().read()).resolves.toMatchObject({ done: true }); // the recording is discarded
      const opts = path === 'streams' ? w.last('attach')!.msg.data : sender.transform.options;
      expect(opts).toMatchObject({ dilla: 1, side: 'encode', trackId: 'tx-mic', block: true });
      expect(errors.map((e) => e.message)).toEqual([expect.stringContaining('pre-connect')]);
      await microtasks();
      expect(lp.unpublishTrack).toHaveBeenCalledWith(t);
    });
  }

  it('blocks a track whose publish options or the live room defaults request a pre-connect buffer or frame metadata', async () => {
    const { w, lp, m } = setup();
    const errors: Error[] = [];
    m.on('encryptionError', (e: Error) => errors.push(e));
    const cam = { ...localTrack('camera', 'video', 'tx-cam'), publishOptions: { frameMetadata: { userTimestamp: true } } };
    lp.emit('localSenderCreated', streamsRtp(), cam);
    expect(w.last('attach')!.msg.data).toMatchObject({ trackId: 'tx-cam', block: true });
    lp.roomOptions = { publishDefaults: { preConnectBuffer: true } }; // mutated after joinCall built the Room
    lp.emit('localSenderCreated', streamsRtp(), localTrack('microphone', 'audio', 'tx-mic'));
    expect(w.last('attach')!.msg.data).toMatchObject({ trackId: 'tx-mic', block: true });
    expect(errors).toHaveLength(2);
    await microtasks();
    expect(lp.unpublishTrack).toHaveBeenCalledTimes(2);
  });

  it('a track without a recorder and with clean options is not affected', () => {
    const { w, lp, m } = setup();
    const errors: Error[] = [];
    m.on('encryptionError', (e: Error) => errors.push(e));
    lp.roomOptions = { publishDefaults: { preConnectBuffer: false } };
    const mic = { ...localTrack('microphone', 'audio', 'tx-mic'), hasPreConnectBuffer: false, getPreConnectBuffer: () => undefined, stopPreConnectBuffer: vi.fn() };
    lp.emit('localSenderCreated', streamsRtp(), mic);
    expect(w.last('attach')!.msg.data.block).toBeUndefined();
    expect(errors).toEqual([]);
  });
});

describe('no transform API at all (a manager used without joinCall’s gate)', () => {
  it('stops every sender and receiver track and unpublishes the sender', async () => {
    const { lp, engine, m } = setup();
    const errors: Error[] = [];
    m.on('encryptionError', (e: Error) => errors.push(e));
    const track = localTrack('microphone', 'audio', 'tx-mic');
    lp.emit('localSenderCreated', {}, track);
    const rx = remoteTrack('rx-1', 'video');
    engine.emit('mediaTrackAdded', rx, {}, {});
    expect(track.mediaStreamTrack.stop).toHaveBeenCalled();
    expect(rx.stop).toHaveBeenCalled();
    expect(errors).toHaveLength(2);
    await microtasks();
    expect(lp.unpublishTrack).toHaveBeenCalledWith(track);
  });

  it('stops the sender track itself when unpublishing fails', async () => {
    const { lp } = setup();
    lp.unpublishTrack = vi.fn(async () => { throw new Error('not published'); });
    const track = localTrack('unknown', 'audio', 'tx-x');
    lp.emit('localSenderCreated', streamsRtp(), track);
    await microtasks();
    await vi.waitFor(() => expect(track.mediaStreamTrack.stop).toHaveBeenCalled());
  });
});

describe('receive attach order (C1 step 4)', () => {
  it('attaches before a MediaTrackAdded listener that was registered earlier (Room’s own, which emits TrackSubscribed)', () => {
    vi.stubGlobal('RTCRtpScriptTransform', FakeScriptTransform);
    const w = new FakeWorker();
    const m = new DillaE2EEManager(w as unknown as Worker);
    const engine = new EventEmitter();
    const seen: unknown[] = [];
    engine.on('mediaTrackAdded', (_t: unknown, _s: unknown, receiver: { transform?: unknown }) => seen.push(receiver.transform));
    m.setupEngine(engine);
    const receiver: { transform?: unknown } = {};
    engine.emit('mediaTrackAdded', remoteTrack('rx-1', 'video'), {}, receiver);
    expect(seen).toEqual([receiver.transform]);
    expect(seen[0]).toBeInstanceOf(FakeScriptTransform);
  });
});

// I2: a worker that errors or never answers init must not hang joinCall (and its Web Lock) forever.
describe('worker failure (I2)', () => {
  it('a worker error rejects ready, every pending install and stats request with E_WASM and emits encryptionError', async () => {
    const w = new FakeWorker();
    const m = new DillaE2EEManager(w as unknown as Worker);
    const errors: Error[] = [];
    m.on('encryptionError', (e: Error) => errors.push(e));
    const install = m.installEpoch(keys());
    const stats = m.stats();
    w.dispatchEvent(new Event('error'));
    await expect(install).rejects.toThrow('E_WASM');
    await expect(stats).rejects.toThrow('E_WASM');
    expect(errors.map((e) => e.message)).toEqual([expect.stringContaining('E_WASM')]);
    await expect(m.installEpoch(keys(6n))).rejects.toThrow('E_WASM');
    await expect(m.stats()).rejects.toThrow('E_WASM');
  });

  it('a messageerror fails the worker too, also after init', async () => {
    const { w, m } = setup();
    const p = m.installEpoch(keys());
    await vi.waitFor(() => expect(w.last('installEpoch')).toBeDefined());
    w.dispatchEvent(new Event('messageerror'));
    await expect(p).rejects.toThrow('E_WASM');
  });

  it('a worker that never answers init fails after INIT_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    try {
      const w = new FakeWorker();
      const m = new DillaE2EEManager(w as unknown as Worker);
      const install = m.installEpoch(keys());
      const assertion = expect(install).rejects.toThrow('E_WASM');
      await vi.advanceTimersByTimeAsync(INIT_TIMEOUT_MS - 1);
      expect(w.last('installEpoch')).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
      expect(w.last('installEpoch')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('an initAck in time cancels the timeout', async () => {
    vi.useFakeTimers();
    try {
      const { w, m } = setup();
      await vi.advanceTimersByTimeAsync(INIT_TIMEOUT_MS * 2);
      const p = m.installEpoch(keys());
      await vi.waitFor(() => expect(w.last('installEpoch')).toBeDefined());
      w.reply({ kind: 'epochInstalled', epoch: 5n });
      await expect(p).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a worker-wide E_WASM (the wasm never loaded) fails the manager and the local status goes false', async () => {
    const { w, m, room, lp } = setup();
    await install(w, m);
    room.emit('signalConnected');
    expect(m.isEnabled).toBe(true);
    const events: unknown[][] = [];
    m.on('participantEncryptionStatusChanged', (e: boolean, p: unknown) => events.push([e, p]));
    w.reply({ kind: 'error', code: 'E_WASM' });
    expect(m.isEnabled).toBe(false);
    expect(events).toEqual([[false, lp]]);
    await expect(m.stats()).rejects.toThrow('E_WASM');
  });
});

describe('install and dispose bookkeeping (M1, M2)', () => {
  it('M1: until the worker confirms an install, nothing below the highest minEpoch seen is installed', async () => {
    const { w, m } = setup();
    const first = m.installEpoch(keys(5n));
    await vi.waitFor(() => expect(w.last('installEpoch')?.msg.epoch).toBe(5n));
    w.reply({ kind: 'error', code: 'E_WASM', epoch: 5n });
    await expect(first).rejects.toThrow('E_WASM');
    await expect(m.installEpoch({ ...keys(4n), minEpoch: 4n })).rejects.toThrow('E_NO_EPOCH');
    await install(w, m, keys(6n));
    await install(w, m, { ...keys(4n), minEpoch: 4n }); // confirmed: an older retained epoch may be installed now
  });

  it('M2: an install failure that names its epoch rejects only that install; a per-track E_WASM rejects none', async () => {
    const { w, m } = setup();
    const a = m.installEpoch(keys(5n));
    const b = m.installEpoch({ ...keys(6n), minEpoch: 5n });
    await vi.waitFor(() => expect(w.posted.filter((p) => p.msg.kind === 'installEpoch')).toHaveLength(2));
    w.reply({ kind: 'error', code: 'E_WASM', trackId: 'rx-1' });
    w.reply({ kind: 'error', code: 'E_WASM', epoch: 6n });
    await expect(b).rejects.toThrow('E_WASM');
    w.reply({ kind: 'epochInstalled', epoch: 5n });
    await expect(a).resolves.toBeUndefined();
  });

  it('M2: dispose rejects every pending install and stats request, and stats() after dispose rejects at once', async () => {
    const { w, m } = setup();
    const p = m.installEpoch(keys());
    await vi.waitFor(() => expect(w.last('installEpoch')).toBeDefined());
    const s = m.stats();
    m.dispose();
    await expect(p).rejects.toThrow('E_NO_EPOCH');
    await expect(s).rejects.toThrow('E_NO_EPOCH');
    await expect(m.stats()).rejects.toThrow('E_NO_EPOCH');
  });

  it('M2: dispose before initAck rejects an install waiting for the worker', async () => {
    const w = new FakeWorker();
    const m = new DillaE2EEManager(w as unknown as Worker);
    const p = m.installEpoch(keys());
    m.dispose();
    await expect(p).rejects.toThrow('E_NO_EPOCH');
  });
});

describe('participant status (M3)', () => {
  it('the local status goes false on dispose', async () => {
    const { w, m, room, lp } = setup();
    await install(w, m);
    room.emit('signalConnected');
    const events: unknown[][] = [];
    m.on('participantEncryptionStatusChanged', (e: boolean, p: unknown) => events.push([e, p]));
    m.dispose();
    expect(events).toEqual([[false, lp]]);
    expect(m.isEnabled).toBe(false);
  });

  it('a disconnected participant is forgotten, so a reconnect reports its roster status again', async () => {
    const { w, m, room } = setup();
    const pB = { identity: DEV_B };
    room.remoteParticipants.set('PA_b', pB);
    await install(w, m);
    const events: unknown[][] = [];
    m.on('participantEncryptionStatusChanged', (e: boolean, p: { identity: string }) => events.push([e, p.identity]));
    room.emit('participantConnected', pB);
    expect(events).toEqual([]);
    room.emit('participantDisconnected', pB);
    room.emit('participantConnected', pB);
    expect(events).toEqual([[true, DEV_B]]);
  });

  it('a failed install puts nobody in a roster', async () => {
    const { w, m, room } = setup();
    room.remoteParticipants.set('PA_b', { identity: DEV_B });
    const events: unknown[][] = [];
    m.on('participantEncryptionStatusChanged', (e: boolean, p: { identity: string }) => events.push([e, p.identity]));
    const p = m.installEpoch(keys());
    await vi.waitFor(() => expect(w.last('installEpoch')).toBeDefined());
    w.reply({ kind: 'error', code: 'E_WASM', epoch: 5n });
    await expect(p).rejects.toThrow('E_WASM');
    room.emit('participantConnected', { identity: DEV_B });
    expect(events).toEqual([[false, DEV_B]]);
  });

  it('verifiedIdentities() names only the devices whose frames the worker authenticated', async () => {
    const { w, m } = setup();
    await install(w, m);
    const p = m.verifiedIdentities();
    await vi.waitFor(() => expect(w.last('stats')).toBeDefined());
    const data = { decrypted: { [kidHex(1, 5n)]: 3, [kidHex(7, 5n)]: 1 }, passedThrough: 0 } as unknown as DillaMediaStats;
    w.reply({ kind: 'stats', id: w.last('stats')!.msg.id, data });
    expect([...(await p)]).toEqual([DEV_B]);
  });

  it('a local track whose frames have no prefix rule is reported through encryptionError', () => {
    const { w, lp, m } = setup();
    const errors: Array<[string, string | undefined]> = [];
    m.on('encryptionError', (e: Error, id?: string) => errors.push([e.message, id]));
    lp.emit('localSenderCreated', streamsRtp(), localTrack('camera', 'video', 'tx-cam', 'av1'));
    w.reply({ kind: 'error', code: 'unsupportedCodec', trackId: 'tx-cam', participantIdentity: DEV_LOCAL });
    w.reply({ kind: 'error', code: 'unsupportedCodec', trackId: 'rx-remote', participantIdentity: DEV_B });
    expect(errors).toEqual([['unsupportedCodec', DEV_LOCAL]]);
  });
});

// N2, N3 (task 17 re-review): Room forwards the manager's events synchronously to application listeners
// (Room.ts:519-533), so an application listener that throws must never abort the manager's own work.
describe('a throwing application listener cannot abort the manager (N2, N3)', () => {
  it('P2: dispose posts clearKeys and unsubscribes before it emits, and completes when a status listener throws', async () => {
    const logs: string[] = [];
    const { w, m, room, engine } = setup((_l, msg) => logs.push(msg));
    await install(w, m);
    room.emit('signalConnected');
    const seen: Array<{ clearKeys: boolean; detachAfterEmit: boolean }> = [];
    const second = vi.fn();
    m.on('participantEncryptionStatusChanged', () => {
      const before = w.posted.length;
      room.emit('trackUnsubscribed', { mediaStreamID: 'rx-late' }); // a room listener still attached would post detach
      seen.push({ clearKeys: w.last('clearKeys') !== undefined, detachAfterEmit: w.posted.length !== before });
      throw new Error('app listener bug');
    });
    m.on('participantEncryptionStatusChanged', second);
    expect(() => m.dispose()).not.toThrow();
    expect(seen).toEqual([{ clearKeys: true, detachAfterEmit: false }]);
    expect(second).toHaveBeenCalledWith(false, expect.anything()); // the next listener still runs
    expect(m.listenerCount('participantEncryptionStatusChanged')).toBe(0);
    expect(m.isEnabled).toBe(false);
    const n = w.posted.length;
    engine.emit('mediaTrackAdded', remoteTrack('rx-9', 'video'), {}, streamsRtp());
    expect(w.posted).toHaveLength(n);
    expect(logs).toContainEqual(expect.stringContaining('app listener bug'));
  });

  it('P1: a throwing encryptionError listener cannot skip the unpublish of a blocked sender', async () => {
    const logs: string[] = [];
    const { lp, m } = setup((_l, msg) => logs.push(msg));
    m.on('encryptionError', () => { throw new Error('app listener bug'); });
    const track = localTrack('unknown', 'video', 'tx-x');
    expect(() => lp.emit('localSenderCreated', streamsRtp(), track)).not.toThrow();
    await microtasks();
    expect(lp.unpublishTrack).toHaveBeenCalledWith(track);
    expect(logs).toContainEqual(expect.stringContaining('app listener bug'));
  });

  it('a throwing listener cannot abort a worker failure or a receiver attach', async () => {
    const { w, m, engine } = setup();
    m.on('encryptionError', () => { throw new Error('app listener bug'); });
    const rx = remoteTrack('rx-1', 'video');
    expect(() => engine.emit('mediaTrackAdded', rx, {}, { createEncodedStreams: () => { throw new TypeError('boom'); } })).not.toThrow();
    expect(rx.stop).toHaveBeenCalled();
    const p = m.installEpoch(keys());
    await vi.waitFor(() => expect(w.last('installEpoch')).toBeDefined());
    expect(() => w.dispatchEvent(new Event('error'))).not.toThrow();
    await expect(p).rejects.toThrow('E_WASM');
  });
});

describe('a sender stopped for want of a transform stays dead (N3)', () => {
  afterEach(() => { FakeScriptTransform.throwWhen = () => false; });

  it('restartTrack, unmute or a device switch (sender.replaceTrack) cannot re-arm it, nor a later LocalSenderCreated', async () => {
    vi.stubGlobal('RTCRtpScriptTransform', FakeScriptTransform);
    const { lp, m } = setup();
    const errors: Error[] = [];
    m.on('encryptionError', (e: Error) => errors.push(e));
    FakeScriptTransform.throwWhen = () => true;
    const original = vi.fn(async (_t: unknown) => undefined);
    const sender: any = { replaceTrack: original };
    const track = localTrack('camera', 'video', 'tx-cam', 'vp8');
    lp.emit('localSenderCreated', sender, track);
    expect(sender.transform).toBeUndefined();
    expect(track.mediaStreamTrack.stop).toHaveBeenCalled();
    await microtasks();
    expect(lp.unpublishTrack).toHaveBeenCalledTimes(1);
    // LocalTrack.setMediaStreamTrack → sender.replaceTrack (LocalTrack.ts:201-202), from restartTrack, unmute
    // (LocalVideoTrack.ts:180-183), visibility (LocalTrack.ts:425-434), resumeUpstream (:518) or a processor (:600).
    const fresh = { kind: 'video', stop: vi.fn() };
    await expect(sender.replaceTrack(fresh)).resolves.toBeUndefined();
    expect(original).not.toHaveBeenCalledWith(fresh);
    expect(fresh.stop).toHaveBeenCalled();
    await microtasks();
    expect(lp.unpublishTrack).toHaveBeenCalledTimes(2);
    await sender.replaceTrack(null); // detaching stays possible
    expect(original).toHaveBeenCalledWith(null);
    FakeScriptTransform.throwWhen = () => false; // even if a transform could be built now
    const again = localTrack('camera', 'video', 'tx-cam-2', 'vp8');
    lp.emit('localSenderCreated', sender, again);
    expect(sender.transform).toBeUndefined();
    expect(again.mediaStreamTrack.stop).toHaveBeenCalled();
    await microtasks();
    expect(lp.unpublishTrack).toHaveBeenCalledWith(again);
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});

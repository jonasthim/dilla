import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Room } from 'livekit-client';
import { DATA_CHANNEL_ERROR, DATA_ERROR, DillaE2EEManager, type EpochKeys } from '../src/manager';
import type { DillaMediaStats, FromWorker } from '../src/protocol';
import { parseToWorker } from '../src/worker/messages';

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
  off(e: string, f: (...a: any[]) => void): this { this.l.set(e, (this.l.get(e) ?? []).filter((x) => x !== f)); return this; }
  emit(e: string, ...a: any[]): boolean { for (const f of this.l.get(e) ?? []) f(...a); return true; }
}

function setup(): { w: FakeWorker; m: DillaE2EEManager; room: any; lp: any; engine: Emitter } {
  const w = new FakeWorker();
  const m = new DillaE2EEManager(w as unknown as Worker);
  const lp = Object.assign(new Emitter(), { identity: DEV_LOCAL, isE2EEEnabled: true });
  const room = Object.assign(new Emitter(), { localParticipant: lp, remoteParticipants: new Map<string, any>() });
  const engine = new Emitter();
  m.setup(room as unknown as Room);
  m.setupEngine(engine);
  w.reply({ kind: 'initAck', v: 1, scriptTransform: false });
  return { w, m, room, lp, engine };
}

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

  it('attaches a sender synchronously in LocalSenderCreated with the slot and codec of the track', () => {
    const { w, lp, m } = setup();
    const errors: Error[] = [];
    m.on('encryptionError', (e: Error) => errors.push(e));
    const streams = (): { createEncodedStreams: () => { readable: ReadableStream; writable: WritableStream } } => ({
      createEncodedStreams: () => ({ readable: new ReadableStream(), writable: new WritableStream() }),
    });
    lp.emit('localSenderCreated', streams(), { source: 'microphone', kind: 'audio', mediaStreamID: 'tx-mic' });
    expect(w.last('attach')!.msg.data).toMatchObject({ side: 'encode', trackId: 'tx-mic', participantIdentity: DEV_LOCAL, slot: 0, codec: 'opus' });
    lp.emit('localSenderCreated', streams(), { source: 'camera', kind: 'video', mediaStreamID: 'tx-cam', codec: 'h264' });
    expect(w.last('attach')!.msg.data).toMatchObject({ side: 'encode', trackId: 'tx-cam', slot: 1, codec: 'h264' });
    const before = w.posted.length;
    lp.emit('localSenderCreated', streams(), { source: 'unknown', kind: 'video', mediaStreamID: 'tx-x' });
    expect(w.posted).toHaveLength(before);
    expect(errors.map((e) => e.message)).toEqual([expect.stringContaining('E_BAD_OPTIONS')]);
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
    lp.emit('localSenderCreated', { createEncodedStreams: () => ({ readable: new ReadableStream(), writable: new WritableStream() }) }, { source: 'microphone', kind: 'audio', mediaStreamID: 'tx-mic' });
    room.emit('trackSubscribed', { kind: 'video', mediaStreamID: 'rx-1' }, { source: 'camera', trackInfo: { mimeType: 'video/VP8', encryption: 1 } }, { identity: DEV_B });
    void m.stats();
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

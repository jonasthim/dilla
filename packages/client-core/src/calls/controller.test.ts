// The worker's call controller (L-TS-56, L-TS-57) over the whole worker: the Controller with ModelCore holding call
// groups, ModelDs answering the delivery-service and call routes (L-HTTP-100..105), the real sync engine, and a scripted
// gateway. Every FromWorker message is recorded in order with its transfer list; a transferred buffer is detached as a
// structured clone with a transfer list detaches it.
import { describe, expect, it } from 'vitest';
import type { BootOutcome } from '../account/boot';
import type { Enrol } from '../account/enrol';
import type { Session } from '../account/session';
import type { Signup } from '../account/signup';
import type { CallKeys, CallJoinResult, CallState, RingsState, SendBlocksState, VoiceState, DmSummary } from '../state/types';
import type { CborValue } from '../cbor';
import type { Id } from '../core-port';
import type { Frame } from '../gateway/frames';
import type { Gateway } from '../gateway/gateway';
import { fromHex, toHex } from '../hex';
import type { Routes } from '../http/routes';
import { DillaHttpError } from '../http/errors';
import { INSTANCE, readyInfo } from '../sync/testing/harness';
import { COMMUNITY, FakeGateway, ManualClock, ME, ModelCore, ModelDs, PEER, THIRD, FOURTH, idOf, settle, type Peer } from '../sync/testing/model';
import { Controller, type ControllerParts } from '../worker/controller';
import type { FromWorker } from '../worker/protocol';

export const VOICE = idOf(0xc5, 1);
export const DM = idOf(0xd5, 1);
const NAMES = new Map<string, string>([[toHex(ME.user), 'Me'], [toHex(PEER.user), 'bob'], [toHex(THIRD.user), 'carol'], [toHex(FOURTH.user), 'dave']]);

/** The route labels the call tests read; the engine's own catch-up reads (messages, handshakes, cursors) are not listed. */
const LABELS: Record<string, string> = {
  getChannelCall: 'GET channel call', getCommunityCalls: 'GET community calls', postGroup: 'POST group', getGroupInfo: 'GET group info',
  getGroupTree: 'GET group tree', postResync: 'POST resync', startCall: 'POST calls', postProposal: 'POST proposal', postCommit: 'POST commit',
  declineCall: 'POST decline', getDeviceList: 'GET device list', shareCall: 'POST share', unshareCall: 'DELETE share', postCallStats: 'POST stats',
};

interface Posted { message: FromWorker; transfer: Transferable[] }
interface Answer { label: string; error: DillaHttpError }
interface Hold { label: string; gate: Promise<void>; reached: () => void }

export interface HarnessOptions {
  voiceChannel?: boolean;
  callGroupBy?: 'peer';
  /** A DM with bob ('dm' / true), or a group DM with bob and carol ('group'). */
  dm?: boolean | 'group';
  /** More DMs with bob, carol and dave in turn (for the ring bound). */
  extraDms?: number;
}

export async function harness(opts: HarnessOptions = {}) {
  const clock = new ManualClock();
  const ds = new ModelDs();
  const model = new ModelCore(ME);
  for (const p of [ME, PEER, THIRD, FOURTH]) ds.own(p.user, p.device);
  for (const p of [ME, PEER, THIRD, FOURTH]) ds.publishList(p.user, [{ device: p.device }]);
  const seed = (p: Peer): void => { const row = ds.listRow(p.user); if (row !== undefined) model.trustList(p.user, row.version, row.blob); };
  for (const p of [PEER, THIRD]) seed(p);
  ds.addVoiceChannel(COMMUNITY, VOICE);
  let callGroup: Id = new Uint8Array(16);
  if (opts.callGroupBy === 'peer') {
    callGroup = ds.peerCreateCall(PEER, VOICE);
    model.setCallTree(callGroup, [{ leafIndex: 0, user: PEER.user, device: PEER.device }]);
  }
  // DMs: the channel at the instance, its text group held by this device (joined earlier).
  const dms: { channel: Id; text: Id; members: Peer[] }[] = [];
  const addDm = (channel: Id, members: Peer[]): void => {
    ds.addDm(channel, [ME, ...members]);
    const text = ds.peerCreate(members[0], channel);
    ds.join(text, ME.device);
    for (const m of members.slice(1)) ds.join(text, m.device);
    model.seedGroup(text, 0, null, channel, 0n);
    dms.push({ channel, text, members });
  };
  if (opts.dm !== undefined && opts.dm !== false) addDm(DM, opts.dm === 'group' ? [PEER, THIRD] : [PEER]);
  for (let i = 0; i < (opts.extraDms ?? 0); i++) addDm(idOf(0xd6, i + 1), [[PEER, THIRD, FOURTH][i % 3]]);

  // The gateway: ModelDs fans out to it; a test pushes frames of its own.
  const fake = new FakeGateway();
  ds.attach(ME.device, (f) => { fake.frame(f); });
  const gatewayPart = {
    status: 'ready', start: (): void => {}, stop: (): void => {}, subscribe: fake.subscribe, commitAck: fake.commitAck,
    sendTyping: (): void => {}, sendVoiceSelf: (): void => {},
  };

  // The routes: ModelDs for the delivery service and the calls, stubs for the account half, every call recorded by label.
  const base = ds.routesFor(ME.device) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const channelRows = [{ id: VOICE, kind: 1, mode: 0, visibility: 0, parentId: null, name: 'lounge', topic: '', position: 0, seq: 1n, textGroupId: null }];
  const stubs: Record<string, (...a: unknown[]) => Promise<unknown>> = {
    getInstance: () => Promise.resolve(INSTANCE),
    getLimits: () => Promise.resolve({ maxCiphertextBytes: 131_072, keypackagesPerDevice: 32, keypackageRefillThreshold: 0, heartbeatMs: 30_000, maxFrameBytes: 131_584 }),
    listCommunities: () => Promise.resolve([{ id: COMMUNITY, name: 'friends', owner: PEER.user, policyVersion: 1n }]),
    listChannels: () => Promise.resolve(opts.voiceChannel === true ? channelRows : []),
    listMembers: () => Promise.resolve([ME, PEER, THIRD, FOURTH].map((p) => ({ userId: p.user, username: NAMES.get(toHex(p.user)) ?? '',
      display: NAMES.get(toHex(p.user)) ?? '', kind: 0 as const, nick: '', roleIds: [] }))),
    postTicket: () => Promise.resolve({ ticket: 'ticket', expires: 1_700_000_030n }),
    postKeyPackages: () => Promise.resolve(0),
    getAccountMe: () => Promise.resolve({ userId: ME.user, username: 'me', display: 'Me', kind: 0, flags: 0n }),
  };
  const requests: { route: string; args: unknown[] }[] = [];
  const answers: Answer[] = [];
  const holds: Hold[] = [];
  const names = new Set([...Object.keys(base), ...Object.keys(stubs)]);
  const routes: Record<string, (...a: unknown[]) => Promise<unknown>> = {};
  for (const name of names) {
    routes[name] = async (...args: unknown[]): Promise<unknown> => {
      const label = LABELS[name];
      if (label !== undefined) {
        requests.push({ route: label, args });
        const h = holds.findIndex((x) => x.label === label);
        if (h >= 0) { const [hold] = holds.splice(h, 1); hold.reached(); await hold.gate; }
        const a = answers.findIndex((x) => x.label === label);
        if (a >= 0) { const [answer] = answers.splice(a, 1); throw answer.error; }
      }
      return (stubs[name] ?? base[name])(...args);
    };
  }
  const server = {
    requests,
    /** The next request of `label` is refused with this status and code. */
    answer(label: string, status: number, code = status === 404 ? 'E_NOT_FOUND' : status === 409 ? 'E_COMMIT_CONFLICT' : 'E_UNAVAILABLE',
      retryAfterMs: number | null = null): void {
      answers.push({ label, error: new DillaHttpError({ status, code, detail: '', retryAfterMs, extra: [] }) });
    },
    /** The next request of `label` waits until release(); `reached` resolves once it is waiting. */
    hold(label: string): { release: () => void; reached: Promise<void> } {
      let release = (): void => {};
      let reached = (): void => {};
      const gate = new Promise<void>((r) => { release = r; });
      const reachedP = new Promise<void>((r) => { reached = r; });
      holds.push({ label, gate, reached });
      return { release, reached: reachedP };
    },
    routes(): string[] { return requests.map((r) => r.route); },
    reset(): void { requests.length = 0; },
  };

  const posted: Posted[] = [];
  const session = { token: (): string => 'token', ensure: (): Promise<boolean> => Promise.resolve(true), establish: (): Promise<boolean> => Promise.resolve(true) };
  const parts: Partial<ControllerParts> = {
    routes: () => routes as unknown as Routes,
    session: () => session as unknown as Session,
    signup: () => ({}) as unknown as Signup,
    enrol: () => ({}) as unknown as Enrol,
    gateway: () => gatewayPart as unknown as Gateway,
    publishDeviceList: () => Promise.resolve(),
    ensureBackups: () => Promise.resolve(),
    refreshOwnDeviceList: () => Promise.resolve({ version: 1n, listed: true }),
    repairBackupState: () => Promise.resolve(false),
  };
  let released = 0;
  const controller = new Controller({
    origin: 'http://127.0.0.1:8453', fetch: (() => Promise.reject(new Error('no fetch'))),
    WebSocket: class {} as unknown as typeof WebSocket,
    locks: { request: async (name, _o, cb) => { await cb({ name }); } },
    now: clock.now, random: () => 0.5, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, sleep: () => Promise.resolve(),
    boot: (instance): Promise<BootOutcome> => Promise.resolve({ kind: 'opened', core: model, instance }),
    resetDevice: () => Promise.resolve(),
    post: (message, transfer = []) => {
      posted.push({ message, transfer });
      if (message.t === 'released') released += 1;
      // What postMessage does with a transfer list: the receiver gets the buffer, the sender's copy is detached.
      structuredClone(message, { transfer });
    },
    testHooks: false,
    parts,
  });
  let nextId = 1;
  const ret = (id: number): Extract<FromWorker, { t: 'ret' }> | undefined =>
    posted.map((p) => p.message).find((m): m is Extract<FromWorker, { t: 'ret' }> => m.t === 'ret' && m.id === id);
  const send = (command: unknown): number => { const id = nextId++; controller.handle({ t: 'call', id, command }); return id; };
  async function call(command: unknown): Promise<unknown> {
    const id = send(command);
    for (let i = 0; i < 400; i++) {
      const r = ret(id);
      if (r !== undefined) {
        if (r.ok) return r.value;
        throw Object.assign(new Error(r.error.code), r.error);
      }
      await settle();
    }
    throw new Error(`no answer to ${JSON.stringify(command)}`);
  }
  const slices = (): Extract<FromWorker, { t: 'slice' }>[] =>
    posted.map((p) => p.message).filter((m): m is Extract<FromWorker, { t: 'slice' }> => m.t === 'slice');
  function slice(name: 'call'): CallState;
  function slice(name: 'voice'): VoiceState;
  function slice(name: 'rings'): RingsState;
  function slice(name: 'sendBlocks'): SendBlocksState;
  function slice(name: 'dms'): DmSummary[];
  function slice(name: string): unknown;
  function slice(name: string): unknown { return slices().filter((s) => s.name === name).at(-1)?.value; }

  await call({ m: 'start' });
  for (let i = 0; i < 100 && (slice('account') as { phase?: string } | undefined)?.phase !== 'ready'; i++) await settle();
  fake.ready(readyInfo(ME));
  await settle();
  await clock.advance(0);

  return {
    controller, model, ds, clock, server, call, send, ret, slice,
    callGroup, voice: toHex(VOICE), dm: toHex(DM), dms, gateway: { push: (f: Frame): void => { fake.frame(f); } },
    posted: (): Posted[] => [...posted],
    pushes: (t: FromWorker['t']): Posted[] => posted.filter((p) => p.message.t === t),
    clearPosted: (): void => { posted.length = 0; },
    released: (): number => released,
    slices: { all: (): unknown[] => slices().map((s) => s.value) },
    /** A commit by bob in the group (a self-update), fanned out to this device: the engine applies it. */
    async deliverHandshakes(group: Id, by: Peer = PEER): Promise<void> {
      ds.peerCommit(group, by);
      await settle();
      await clock.advance(0);
    },
  };
}
export type World = Awaited<ReturnType<typeof harness>>;

/** A voice_state frame as the gateway hands it over (op 50). */
export function voiceFrame(peer: Peer, call: Id, flags: number): Frame {
  return { op: 50, n: 0n, groupId: null, payload: [peer.user, peer.device, call, BigInt(flags)] as CborValue[] };
}

export const CALL_KEYS = (p: Posted): CallKeys => (p.message as { keys: CallKeys }).keys;
export type { CallJoinResult };

describe('voice presence (L-GW-32, L-TS-56 step 7)', () => {
  it('loadVoice applies frames received during the snapshot read after it, in order', async () => {
    const w = await harness({ voiceChannel: true, callGroupBy: 'peer' });
    // A live call in the lounge with X (bob's device) in it.
    await w.ds.routesFor(PEER.device).startCall(VOICE, '');
    w.ds.voice(VOICE, PEER, 1);
    await w.call({ m: 'loadVoice', communityId: null, channelId: w.voice });
    expect(w.slice('voice')[w.voice]?.participants.map((p) => [p.deviceId, p.flags])).toEqual([[toHex(PEER.device), 1]]);
    // The next snapshot read is held; meanwhile X joins again (1), leaves (0) and Y (carol) joins with flags 3.
    const held = w.server.hold('GET channel call');
    const id = w.send({ m: 'loadVoice', communityId: null, channelId: w.voice });
    await held.reached;
    w.gateway.push(voiceFrame(PEER, VOICE, 1));
    w.gateway.push(voiceFrame(PEER, VOICE, 0));
    w.gateway.push(voiceFrame(THIRD, VOICE, 3));
    // The snapshot answered names X only ([.., [[X, 1]]]): it was taken before the frames.
    held.release();
    for (let i = 0; i < 20 && w.ret(id) === undefined; i++) await settle();
    expect(w.ret(id)).toMatchObject({ ok: true });
    const call = w.slice('voice')[w.voice];
    expect(call?.participants.map((p) => [p.userId, p.deviceId, p.flags, p.name])).toEqual([[toHex(THIRD.user), toHex(THIRD.device), 3, 'carol']]);
  });

  it('loadVoice of a community lists each live call and drops a channel whose call ended; own device is marked', async () => {
    const w = await harness({ voiceChannel: true, callGroupBy: 'peer' });
    await w.ds.routesFor(PEER.device).startCall(VOICE, '');
    w.ds.voice(VOICE, PEER, 1);
    w.gateway.push(voiceFrame(ME, VOICE, 1));
    await w.call({ m: 'loadVoice', communityId: toHex(COMMUNITY), channelId: null });
    expect(w.slice('voice')[w.voice]?.participants.map((p) => [p.name, p.own, p.web, p.bot])).toEqual([['bob', false, false, false]]);
    w.gateway.push(voiceFrame(ME, VOICE, 1));
    expect(w.slice('voice')[w.voice]?.participants.find((p) => p.own)).toMatchObject({ userId: toHex(ME.user), web: true });
    w.ds.endCall(VOICE);
    await w.call({ m: 'loadVoice', communityId: toHex(COMMUNITY), channelId: null });
    expect(w.slice('voice')[w.voice]).toBeUndefined();
  });

  it('refuses loadVoice of a channel or community it does not know, and drops a frame of an unknown call', async () => {
    const w = await harness({ voiceChannel: true });
    await expect(w.call({ m: 'loadVoice', communityId: null, channelId: 'ab'.repeat(16) })).rejects.toMatchObject({ code: 'E_BAD_INPUT' });
    await expect(w.call({ m: 'loadVoice', communityId: 'ab'.repeat(16), channelId: null })).rejects.toMatchObject({ code: 'E_BAD_INPUT' });
    w.gateway.push(voiceFrame(PEER, idOf(0x77, 1), 1));
    expect(w.slice('voice')).toEqual({});
  });
});

describe('sendBlocks stays a text-group map (L-TS-57)', () => {
  // Attacker: the instance or a member poisons a DM's call group (it shares the DM text group's target id). The block
  // must stay with the call: the DM's composer is not paused by it, nor does the call group pass as the DM's text group.
  it('a call group never enters sendBlocks, even in a DM sharing its target id', async () => {
    const w = await harness({ dm: true });
    const dmCall = idOf(0x9e, 1);
    w.model.seedGroup(dmCall, 1, null, DM);
    const before = w.slice('dms').find((d) => d.id === w.dm);
    expect(before?.group).toBe('active');
    w.model.blockGroup(dmCall, 'E_DEVICE_UNLISTED');
    await w.call({ m: 'refreshTrust' });
    expect(w.slice('sendBlocks')).toEqual({});
    expect(w.slice('dms').find((d) => d.id === w.dm)).toEqual(before);
    // The control: the DM's text group blocked is in the map, under the DM's channel id.
    w.model.blockGroup(w.dms[0].text, 'E_UMK_CHANGED');
    await w.call({ m: 'refreshTrust' });
    expect(w.slice('sendBlocks')).toEqual({ [w.dm]: { code: 'E_UMK_CHANGED', own: false } });
  });
});

export { fromHex };

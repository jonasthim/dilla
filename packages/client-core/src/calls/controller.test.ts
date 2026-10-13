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
import { CoreError, type Id } from '../core-port';
import { fakeDskPub } from '../testing/fake-list';
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
  seed(PEER);   // carol's list is not cached: her leaves are pending until a refresh reads it
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
  const voiceSelfSent: { callId: string; flags: number }[] = [];
  const gatewayPart = {
    status: 'ready', start: (): void => {}, stop: (): void => {}, subscribe: fake.subscribe, commitAck: fake.commitAck,
    sendTyping: (): void => {}, sendVoiceSelf: (call: Uint8Array, flags: number): void => { voiceSelfSent.push({ callId: toHex(call), flags }); },
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
  const replies: { label: string; value: unknown }[] = [];
  const names =new Set([...Object.keys(base), ...Object.keys(stubs)]);
  const routes: Record<string, (...a: unknown[]) => Promise<unknown>> = {};
  for (const name of names) {
    routes[name] = async (...args: unknown[]): Promise<unknown> => {
      // An unlabelled hold (the engine's own reads): waits, unrecorded.
      const raw = holds.findIndex((x) => x.label === `raw:${name}`);
      if (raw >= 0) { const [hold] = holds.splice(raw, 1); hold.reached(); await hold.gate; }
      const label = LABELS[name];
      if (label !== undefined) {
        requests.push({ route: label, args });
        const h = holds.findIndex((x) => x.label === label);
        if (h >= 0) { const [hold] = holds.splice(h, 1); hold.reached(); await hold.gate; }
        const a = answers.findIndex((x) => x.label === label);
        if (a >= 0) { const [answer] = answers.splice(a, 1); throw answer.error; }
        const r = replies.findIndex((x) => x.label === label);
        if (r >= 0) { const [value] = replies.splice(r, 1); return value.value; }
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
    /** The next request of `label` is answered with `value` instead of the model's answer. */
    reply(label: string, value: unknown): void { replies.push({ label, value }); },
    /** The next call of a route method by name (labelled or not) waits until release(), unrecorded. */
    holdRaw(method: string): { release: () => void; reached: Promise<void> } { return server.hold(`raw:${method}`); },
    routes(): string[] { return requests.map((r) => r.route); },
    reset(): void { requests.length = 0; },
  };

  const posted: Posted[] = [];
  /** Whether a session can be established again (false: a revoked socket ends in the revoked phase). */
  const sessionState = { ok: true };
  const session = { token: (): string => 'token', ensure: (): Promise<boolean> => Promise.resolve(true),
    establish: (): Promise<boolean> => Promise.resolve(sessionState.ok) };
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
  fake.emit({ type: 'status', status: 'ready', closeCode: null });
  fake.ready(readyInfo(ME));
  await settle();
  await clock.advance(0);

  return {
    controller, model, ds, clock, server, call, send, ret, slice, voiceSelfSent, sessionState,
    /** The gateway reports a revoked socket (the worker re-establishes its session, or ends in revoked). */
    revokeSocket: (): void => { fake.emit({ type: 'revoked' }); },
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

// ---------------------------------------------------------------------------------------------
// Task 6b: the worker joins, keys, leaves, pauses and rings calls (L-TS-56).
// ---------------------------------------------------------------------------------------------

const settled = async (w: World, n = 4): Promise<void> => { for (let i = 0; i < n; i++) { await settle(); await w.clock.advance(0); } };
const JOIN = (w: World): { m: 'callJoin'; channelId: string; vdec: string } => ({ m: 'callJoin', channelId: w.voice, vdec: 'vp8' });
const codeOf = async (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: { code?: string }) => e.code ?? 'thrown');
/** A ring frame (op 53) as the gateway hands it over. */
function ring(state: 0 | 1 | 2, o: { call?: Id; channel?: Id; user?: Peer; expires?: number } = {}): Frame {
  return { op: 53, n: 0n, groupId: null,
    payload: [o.call ?? o.channel ?? DM, o.channel ?? DM, (o.user ?? PEER).user, BigInt(state), BigInt(o.expires ?? 1_700_000_030)] as CborValue[] };
}
/** In the lounge's call: bob's call group joined, the log and the posts cleared. */
async function joined(opts: HarnessOptions = {}): Promise<World & { result: CallJoinResult }> {
  const w = await harness({ voiceChannel: true, callGroupBy: 'peer', ...opts });
  const result = await w.call(JOIN(w)) as CallJoinResult;
  await settled(w);
  w.clearPosted();
  w.server.reset();
  return Object.assign(w, { result });
}
const keysPosted = (w: World): CallKeys[] => w.pushes('callKeys').map(CALL_KEYS);
/** The last call-path request; the worker's trust refresh reads lists at its own times beside it. */
const lastCallRoute = (w: World): string | undefined => w.server.routes().filter((r) => r !== 'GET device list').at(-1);

describe('callJoin (L-TS-56 step 1)', () => {
  it('joins an existing call group and pushes the join epoch key once, before the ret, never in a slice or a ret', async () => {
    const w = await harness({ voiceChannel: true, callGroupBy: 'peer' });
    w.server.reset();
    const r = await w.call({ m: 'callJoin', channelId: w.voice, vdec: 'vp8' }) as CallJoinResult;
    const posted = w.posted();                                   // every FromWorker message in order, with its transfer list
    const k = posted.findIndex((m) => m.message.t === 'callKeys');
    const ret = posted.findIndex((m) => m.message.t === 'ret' && m.message.ok && (m.message.value as CallJoinResult | null)?.callId === r.callId);
    expect(k).toBeGreaterThanOrEqual(0); expect(k).toBeLessThan(ret);
    expect(posted[k].transfer).toEqual([ (posted[k].message as { keys: CallKeys }).keys.baseKey ]);
    expect(posted.filter((m) => m.message.t === 'callKeys')).toHaveLength(1);
    expect(JSON.stringify(r)).not.toMatch(/baseKey/);
    expect(w.server.requests.map((q) => q.route)).toEqual(['GET channel call', 'GET group info', 'GET group tree', 'POST resync', 'POST calls']);
    expect(JSON.stringify(w.slices.all())).not.toContain(w.model.lastBaseKeyHex(w.callGroup));
    expect(w.model.lastEpochBytes(w.callGroup).every((b) => b === 0)).toBe(true);   // the adapter zero-filled the decoded bytes
    expect(w.slice('call')).toMatchObject({ phase: 'in', epoch: r.epoch, code: expect.stringMatching(/^(\d{5} ){5}\d{5}$/) as string });
    // The key the page receives is the core's, for the join epoch, with the roster of the tree.
    const keys = CALL_KEYS(posted[k]);
    expect(keys).toMatchObject({ groupId: toHex(w.callGroup), epoch: r.epoch, selfLeaf: 1 });
    expect(keys.roster.map((x) => x.userId)).toEqual([toHex(PEER.user), toHex(ME.user)]);
    expect(r).toMatchObject({ groupId: toHex(w.callGroup), callId: w.voice, token: expect.any(String) as string });
  });

  // RV-1 (progress note of task 5): the core cannot stop a worker that posts a staged join without call_join_check, so the
  // worker must never do so. The double's join accepts anything the gate tolerates; its check refuses.
  it('never posts a staged join without call_join_check first', async () => {
    const w = await harness({ voiceChannel: true, callGroupBy: 'peer' });
    w.server.reset();
    w.model.callJoinCheck = (): void => { throw new CoreError('E_CREDENTIAL', ''); };
    expect(await codeOf(w.call(JOIN(w)))).toBe('E_CREDENTIAL');
    expect(w.server.routes()).toEqual(['GET channel call', 'GET group info', 'GET group tree']);
    expect(w.slice('call')).toMatchObject({ phase: 'blocked', error: { code: 'E_CREDENTIAL' } });
    expect(w.model.group(w.callGroup)).toBeUndefined();
    expect(w.pushes('callKeys')).toHaveLength(0);
  });

  it('registers the call group when none is open and re-reads once on E_GROUP_EXISTS', async () => {
    const w = await harness({ voiceChannel: true, callGroupBy: 'peer' });
    w.server.reset();
    // The first read finds no open group (the peer registered meanwhile): POST group meets theirs.
    w.server.reply('GET channel call', { groupId: null, callId: null, participants: [] });
    w.server.answer('POST group', 409, 'E_GROUP_EXISTS');
    await w.call(JOIN(w));
    expect(w.server.routes()).toEqual(['GET channel call', 'POST group', 'GET channel call', 'GET group info', 'GET group tree', 'POST resync', 'POST calls']);
    expect(w.slice('call').phase).toBe('in');
    expect(w.model.groups().filter((g) => g.kind === 1 && g.state === 2).map((g) => toHex(g.groupId))).toEqual([toHex(w.callGroup)]);
  });

  it('a call it opens in a voice channel with no group registers one and keys its only leaf', async () => {
    const w = await harness({ voiceChannel: true });
    w.server.reset();
    const r = await w.call(JOIN(w)) as CallJoinResult;
    expect(w.server.routes()).toEqual(['GET channel call', 'POST group', 'POST calls']);
    expect(CALL_KEYS(w.pushes('callKeys')[0]).roster).toEqual([{ leaf: 0, deviceId: toHex(ME.device), userId: toHex(ME.user) }]);
    expect(w.slice('call')).toMatchObject({ phase: 'in', outgoing: null, callId: r.callId });
  });

  it('after the instance closed an idle call group, the next join registers a fresh one', async () => {
    const w = await joined();
    await w.call({ m: 'callLeave', reason: 'user' });
    w.ds.closeCallGroup(w.callGroup);
    // An old group row of the channel this device still holds active (it joined, the instance closed it).
    const stale = idOf(0x9c, 200);
    w.model.seedGroup(stale, 1, COMMUNITY, VOICE);
    w.server.reset();
    await w.call(JOIN(w));
    const fresh = w.model.groups().filter((g) => g.kind === 1 && g.state === 2);
    expect(fresh).toHaveLength(1);
    expect(toHex(fresh[0].groupId)).not.toBe(toHex(w.callGroup));
    expect(toHex(fresh[0].groupId)).not.toBe(toHex(stale));
    expect(w.server.routes()).toEqual(['GET channel call', 'POST group', 'POST calls']);
    expect(w.slice('call').phase).toBe('in');
  });

  it('a POST calls answered 503 (the start raced the idle close) re-reads once, then registers afresh; no third attempt', async () => {
    const w = await harness({ voiceChannel: true, callGroupBy: 'peer' });
    w.server.reset();
    w.server.answer('POST calls', 503, 'E_UNAVAILABLE', 5);
    // The close the 503 reports: L-HTTP-100 no longer names the group.
    const held = w.server.hold('POST calls');
    const id = w.send(JOIN(w));
    await held.reached;
    w.ds.closeCallGroup(w.callGroup);
    held.release();
    for (let i = 0; i < 40 && w.ret(id) === undefined; i++) await settle();
    expect(w.ret(id)).toMatchObject({ ok: true });
    expect(w.server.routes()).toEqual(['GET channel call', 'GET group info', 'GET group tree', 'POST resync', 'POST calls',
      'GET channel call', 'POST group', 'POST calls']);
    expect(w.model.group(w.callGroup)?.state).toBe(4);
    expect(w.pushes('callKeys')).toHaveLength(1);
    // Twice: the second 503 fails the join.
    const v = await harness({ voiceChannel: true, callGroupBy: 'peer' });
    v.server.answer('POST calls', 503, 'E_UNAVAILABLE', 5);
    v.server.answer('POST calls', 503, 'E_UNAVAILABLE', 5);
    v.server.reset();
    expect(await codeOf(v.call(JOIN(v)))).toBe('E_UNAVAILABLE');
    expect(v.server.routes().filter((r) => r === 'POST calls')).toHaveLength(2);
    expect(v.slice('call').phase).toBe('failed');
    expect(v.pushes('callKeys')).toHaveLength(0);
  });

  // Attacker: the instance (or a member) adds a forged device to the call group before this device joins. Nothing is
  // posted for that tree, and no state of the refused join is left behind.
  it('a block present at join time posts nothing and leaves no call group behind', async () => {
    const w = await harness({ voiceChannel: true, callGroupBy: 'peer' });
    w.model.addFailedLeaf(w.callGroup, 'E_DEVICE_UNLISTED');
    w.server.reset();
    expect(await codeOf(w.call(JOIN(w)))).toBe('E_DEVICE_UNLISTED');
    expect(w.server.routes()).toEqual(['GET channel call', 'GET group info', 'GET group tree']);
    expect(w.model.group(w.callGroup)).toBeUndefined();
    expect(w.slice('call')).toMatchObject({ phase: 'blocked', error: { code: 'E_DEVICE_UNLISTED' }, changedUser: null });
    expect(w.pushes('callKeys')).toHaveLength(0);
  });

  // Attacker: the instance adds a device whose user's list this device never read, hoping the pending verdict lets audio
  // reach it (RV-1). The list is read first; if it cannot be read, nothing is posted.
  it('a pending leaf is settled by a list refresh before the join commit is posted', async () => {
    const w = await harness({ voiceChannel: true, callGroupBy: 'peer' });
    w.model.setCallTree(w.callGroup, [{ leafIndex: 0, user: PEER.user, device: PEER.device }, { leafIndex: 1, user: THIRD.user, device: THIRD.device }]);
    w.server.reset();
    await w.call(JOIN(w));
    const routes = w.server.routes();
    const list = w.server.requests.findIndex((q) => q.route === 'GET device list' && toHex(q.args[0] as Id) === toHex(THIRD.user));
    expect(list).toBeGreaterThanOrEqual(0);
    expect(list).toBeGreaterThan(routes.indexOf('GET group tree'));
    expect(list).toBeLessThan(routes.indexOf('POST resync'));
    expect(w.slice('call').phase).toBe('in');

    const v = await harness({ voiceChannel: true, callGroupBy: 'peer' });
    v.model.setCallTree(v.callGroup, [{ leafIndex: 0, user: PEER.user, device: PEER.device }, { leafIndex: 1, user: THIRD.user, device: THIRD.device }]);
    v.server.reset();
    v.server.answer('GET device list', 503);
    v.server.answer('GET device list', 503);   // bob's list too: the refresh reads every leaf of the group
    expect(await codeOf(v.call(JOIN(v)))).toBe('E_DEVICE_LIST_STALE');
    expect(v.slice('call')).toMatchObject({ phase: 'failed', error: { code: 'E_DEVICE_LIST_STALE' } });
    expect(v.server.routes()).not.toContain('POST resync');
    expect(v.model.group(v.callGroup)).toBeUndefined();
  });

  // Decision 4: a DM call is refused while the DM's text group is send-blocked; the refusal names the changed contact
  // (ruling I2), and nothing reaches the instance.
  it('a DM call refuses while the DM text group is send-blocked', async () => {
    const w = await harness({ dm: true });
    const text = w.dms[0].text;
    w.model.addPendingLeaf(text, 1, PEER.user, PEER.device, fakeDskPub(PEER.device), 1);
    w.model.changeIdentity(PEER.user);
    w.server.reset();
    expect(await codeOf(w.call({ m: 'callJoin', channelId: w.dm, vdec: '' }))).toBe('E_UMK_CHANGED');
    expect(w.server.routes()).toEqual([]);
    expect(w.slice('call')).toMatchObject({ phase: 'blocked', error: { code: 'E_UMK_CHANGED' }, changedUser: toHex(PEER.user) });
  });

  it('refuses a second join while in a call, and a channel that is neither a voice channel nor a DM', async () => {
    const w = await joined();
    expect(await codeOf(w.call(JOIN(w)))).toBe('E_CALL_ACTIVE');
    expect(await codeOf(w.call({ m: 'callJoin', channelId: 'ab'.repeat(16), vdec: '' }))).toBe('E_BAD_INPUT');
  });

  it('E_CALL_FULL leaves the joined group with a self-Remove and forgets it', async () => {
    const w = await harness({ voiceChannel: true, callGroupBy: 'peer' });
    w.server.reset();
    w.server.answer('POST calls', 409, 'E_CALL_FULL');
    expect(await codeOf(w.call(JOIN(w)))).toBe('E_CALL_FULL');
    expect(lastCallRoute(w)).toBe('POST proposal');
    expect(w.model.group(w.callGroup)?.state).toBe(4);
    expect(w.slice('call')).toMatchObject({ phase: 'failed', error: { code: 'E_CALL_FULL' } });
    expect(w.pushes('callKeys')).toHaveLength(0);
  });
});

describe('keys after the join (L-TS-56 step 2)', () => {
  it('pushes callKeys once per changed epoch and leaves no key bytes in the worker after posting', async () => {
    const w = await joined();
    await w.deliverHandshakes(w.callGroup);
    await settled(w);
    const pushes = w.pushes('callKeys');
    expect(pushes).toHaveLength(1);
    expect(CALL_KEYS(pushes[0]).epoch).toBe((BigInt(w.result.epoch) + 1n).toString());
    expect(CALL_KEYS(pushes[0]).baseKey.byteLength).toBe(0);          // detached by the transfer
    expect(pushes[0].transfer).toEqual([CALL_KEYS(pushes[0]).baseKey]);
    expect(w.model.lastEpochBytes(w.callGroup).every((b) => b === 0)).toBe(true);
    expect(w.slice('call').epoch).toBe(CALL_KEYS(pushes[0]).epoch);
    // A batch that changes no epoch (an application message, skipped in a call group) and a trust refresh post nothing.
    w.ds.peerSend(w.callGroup, PEER, 'not media');
    await settled(w);
    await w.call({ m: 'refreshTrust' });
    await settled(w);
    expect(w.pushes('callKeys')).toHaveLength(1);
  });

  // Attacker: the instance adds a forged leaf mid-call. No key for the new epoch; the device leaves and says why.
  it('a blocking leaf after the join stops every later key and leaves', async () => {
    const w = await joined();
    // The leave's proposal is held in flight, so a later epoch arrives while this device is leaving.
    const held = w.server.hold('POST proposal');
    w.model.addFailedLeaf(w.callGroup, 'E_DEVICE_UNLISTED');
    await w.deliverHandshakes(w.callGroup);
    await held.reached;
    expect(w.pushes('callKeys')).toHaveLength(0);
    expect(w.slice('call')).toMatchObject({ phase: 'blocked', error: { code: 'E_DEVICE_UNLISTED' } });
    expect(lastCallRoute(w)).toBe('POST proposal');
    // The forged leaf is swept and one more epoch arrives before the leave completes: a blocked device posts no key.
    w.model.setCallTree(w.callGroup, [{ leafIndex: 0, user: PEER.user, device: PEER.device }]);
    w.model.removeLeaf(w.callGroup, 2);
    await w.deliverHandshakes(w.callGroup);
    expect(w.pushes('callKeys')).toHaveLength(0);
    held.release();
    await settled(w);
    expect(w.pushes('callKeys')).toHaveLength(0);
    expect(w.slice('call').phase).toBe('blocked');
    expect(w.model.group(w.callGroup)?.state).toBe(4);
  });

  it('an unlisted leaf mid-call still leaves (only an identity change pauses)', async () => {
    const w = await joined();
    w.model.addFailedLeaf(w.callGroup, 'E_DEVICE_UNLISTED');
    await w.deliverHandshakes(w.callGroup);
    await settled(w);
    expect(w.slice('call')).toMatchObject({ phase: 'blocked', changedUser: null });
    expect(lastCallRoute(w)).toBe('POST proposal');
    expect(w.model.group(w.callGroup)?.state).toBe(4);
  });

  // RV-3 (Jonas). Attacker question: can a member trigger the pause against an honest party? Yes: any member whose
  // identity changes (honestly or not) pauses everyone who has not verified them, but only on their own devices and
  // without ending the call; no key reaches the changed device either way, which is the property.
  it('a mid-call identity change pauses without leaving and resumes after verification or when that member leaves', async () => {
    // A change a trust refresh finds within the current epoch pauses too; verified, the call resumes on the key the page
    // already holds: no key is posted while paused, nor again for that epoch.
    {
      const w = await joined();
      w.model.changeIdentity(PEER.user);
      await w.call({ m: 'refreshTrust' });
      await settled(w);
      expect(w.slice('call')).toMatchObject({ phase: 'paused', epoch: w.result.epoch, changedUser: toHex(PEER.user) });
      await w.call({ m: 'verifyContact', userId: toHex(PEER.user), umk: 'c4'.repeat(32) });
      await settled(w, 8);
      expect(w.slice('call')).toMatchObject({ phase: 'in', epoch: w.result.epoch, changedUser: null });
      expect(w.pushes('callKeys')).toHaveLength(0);
    }
    for (const resume of ['verify', 'leaves'] as const) {
      const w = await joined();
      w.gateway.push(voiceFrame(ME, VOICE, 1));
      const e = BigInt(w.result.epoch);
      w.model.changeIdentity(PEER.user);
      await w.deliverHandshakes(w.callGroup, THIRD);
      await settled(w);
      expect(w.pushes('callKeys')).toHaveLength(0);
      expect(w.slice('call')).toMatchObject({ phase: 'paused', error: { code: 'E_UMK_CHANGED' }, changedUser: toHex(PEER.user) });
      expect(w.server.routes()).not.toContain('POST proposal');
      expect(w.model.calls.some((c) => c.m === 'callGroupForget')).toBe(false);
      expect(w.slice('voice')[w.voice]?.participants.some((p) => p.own)).toBe(true);
      // While paused: no rotation commit, and no share.
      await w.clock.advance(3_600_000);
      await settled(w);
      expect(w.server.routes()).not.toContain('POST commit');
      expect(await codeOf(w.call({ m: 'callShare', on: true }))).toBe('E_UNAVAILABLE');
      expect(await codeOf(w.call({ m: 'callShare', on: false }))).toBe('ok');
      if (resume === 'verify') {
        await w.call({ m: 'verifyContact', userId: toHex(PEER.user), umk: 'c4'.repeat(32) });
        await settled(w, 8);
        expect(keysPosted(w).map((k) => k.epoch)).toEqual([(e + 1n).toString()]);
      } else {
        w.model.removeLeaf(w.callGroup, 0);
        await w.deliverHandshakes(w.callGroup, THIRD);
        await settled(w);
        expect(keysPosted(w).map((k) => k.epoch)).toEqual([(e + 2n).toString()]);
      }
      expect(w.slice('call')).toMatchObject({ phase: 'in', error: null, changedUser: null });
    }
  });

  it('the own leaf removed by another member sets phase removed', async () => {
    const w = await joined();
    w.ds.propose(w.callGroup, 'remove', ME.device);
    await w.deliverHandshakes(w.callGroup);
    await settled(w);
    expect(w.slice('call').phase).toBe('removed');
    expect(w.pushes('callKeys')).toHaveLength(0);
  });
});

describe('leave and rotation (L-TS-56 steps 4 and 5)', () => {
  it('callLeave posts the self-Remove, forgets the group and goes idle', async () => {
    const w = await joined();
    expect(await w.call({ m: 'callLeave', reason: 'user' })).toBeNull();
    expect(w.server.routes()).toEqual(['POST proposal']);
    expect(w.model.group(w.callGroup)?.state).toBe(4);
    expect(w.slice('call')).toEqual(expect.objectContaining({ phase: 'idle', callId: null, epoch: null, code: null, roster: [] }));
    // A leave already pending at the instance is fine (409 E_REMOVE_PENDING), and a leave with no call is a no-op.
    expect(await w.call({ m: 'callLeave', reason: 'pagehide' })).toBeNull();
  });

  it('rotates the leaf after CALL_ROTATE_MS and retries after a conflict at the next tick', async () => {
    const w = await joined();
    await w.clock.advance(3_600_000);
    await settled(w);
    expect(w.server.routes()).toContain('POST commit');
    expect(w.model.calls.filter((c) => c.m === 'commitConfirm' && c.g === toHex(w.callGroup))).toHaveLength(1);
    expect(keysPosted(w)).toHaveLength(1);                                  // the rotation's own new epoch
    w.server.reset();
    w.server.answer('POST commit', 409, 'E_COMMIT_CONFLICT');
    await w.clock.advance(3_600_000);
    await settled(w);
    expect(w.model.calls.filter((c) => c.m === 'commitAbort' && c.g === toHex(w.callGroup))).toHaveLength(1);
    await w.clock.advance(60_000);
    await settled(w);
    expect(w.server.routes().filter((r) => r === 'POST commit')).toHaveLength(2);
  });

  // Progress note of task 5: call_rotate cancels a pending leave, so a worker that has posted its self-Remove must
  // never rotate (it forgets instead).
  it('never rotates after callLeave has posted its self-Remove', async () => {
    const w = await joined();
    const held = w.server.hold('POST proposal');
    const id = w.send({ m: 'callLeave', reason: 'user' });
    await held.reached;
    await w.clock.advance(3_600_000);
    await settled(w);
    expect(w.model.calls.some((c) => c.m === 'callRotate')).toBe(false);
    held.release();
    for (let i = 0; i < 20 && w.ret(id) === undefined; i++) await settle();
    await w.clock.advance(7_200_000);
    await settled(w);
    expect(w.model.calls.some((c) => c.m === 'callRotate')).toBe(false);
    expect(w.server.routes()).not.toContain('POST commit');
  });

  it('share, refresh and stats map onto their routes; a 429 on stats is swallowed; no call is E_NO_CALL', async () => {
    const w = await joined();
    await w.call({ m: 'callShare', on: true });
    await w.call({ m: 'callShare', on: false });
    const fresh = await w.call({ m: 'callRefresh' }) as { token: string; iceServers: unknown[] };
    expect(fresh).toEqual({ token: expect.any(String) as string, iceServers: expect.any(Array) as unknown[] });
    w.server.answer('POST stats', 429, 'E_RATE_LIMITED', 4000);
    expect(await w.call({ m: 'callStats', report: [1, null, 40, 0, 0, 10] })).toBeNull();
    await w.call({ m: 'callStats', report: [1, null, 40, 0, 0, 10] });
    expect(w.server.routes()).toEqual(['POST share', 'DELETE share', 'POST calls', 'POST stats', 'POST stats']);
    await w.call({ m: 'callLeave', reason: 'user' });
    for (const command of [{ m: 'callShare', on: true }, { m: 'callRefresh' }, { m: 'callStats', report: [0, null, 0, 0, 0, 0] }]) {
      expect(await codeOf(w.call(command))).toBe('E_NO_CALL');
    }
  });

  it('resign leaves the call and clears rings before it releases the store', async () => {
    const w = await joined({ dm: true });
    w.gateway.push(ring(1));
    expect(w.slice('rings')).toHaveLength(1);
    await w.call({ m: 'resign', nonce: 'ab'.repeat(16) });
    await settled(w);
    expect(w.server.routes()).toContain('POST proposal');
    const posted = w.posted().map((p) => p.message);
    const released = posted.findIndex((m) => m.t === 'released');
    expect(released).toBeGreaterThan(0);
    const before = posted.slice(0, released);
    const lastCall = before.filter((m): m is Extract<FromWorker, { t: 'slice' }> => m.t === 'slice' && m.name === 'call').at(-1);
    const lastRings = before.filter((m): m is Extract<FromWorker, { t: 'slice' }> => m.t === 'slice' && m.name === 'rings').at(-1);
    expect((lastCall?.value as CallState).phase).toBe('idle');
    expect(lastRings?.value).toEqual([]);
    const proposal = w.server.routes().indexOf('POST proposal');
    expect(proposal).toBeGreaterThanOrEqual(0);
  });

  // Task 3 review (controller ruling): the instance keeps a device's own mute/deafen flags only once it is in the call's
  // room, so a voice_self sent before the join webhook is lost. The worker re-sends the last one once per join, when it
  // sees its own voice_state join for that call.
  it('re-sends the own voice_self once when its own voice_state join arrives, and once more per later join', async () => {
    const w = await joined();
    await w.call({ m: 'voiceSelf', callId: w.voice, flags: 1 });
    expect(w.voiceSelfSent).toEqual([{ callId: w.voice, flags: 1 }]);
    w.gateway.push(voiceFrame(ME, VOICE, 1));
    expect(w.voiceSelfSent).toEqual([{ callId: w.voice, flags: 1 }, { callId: w.voice, flags: 1 }]);
    w.gateway.push(voiceFrame(ME, VOICE, 3));
    w.gateway.push(voiceFrame(PEER, VOICE, 1));
    expect(w.voiceSelfSent).toHaveLength(2);
    w.gateway.push(voiceFrame(ME, VOICE, 0));
    w.gateway.push(voiceFrame(ME, VOICE, 1));
    expect(w.voiceSelfSent).toHaveLength(3);
  });
});

describe('rings (L-TS-56 step 8)', () => {
  it('a ring for a DM shows once, busy while in a call, quiet when the DM is muted, and ends on state 0', async () => {
    const w = await harness({ dm: true });
    w.gateway.push(ring(1));
    expect(w.slice('rings')).toEqual([expect.objectContaining({ callId: w.dm, busy: false, quiet: false })]);
    expect(w.slice('rings')[0]).toMatchObject({ channelId: w.dm, callerUser: toHex(PEER.user), callerName: 'bob', ringTs: 1_700_000_030 });
    w.gateway.push(ring(0));
    expect(w.slice('rings')).toEqual([]);
    await w.call({ m: 'setSetting', key: `mute.channel.${w.dm}`, value: '1' });
    w.gateway.push(ring(1));
    expect(w.slice('rings')).toEqual([expect.objectContaining({ quiet: true, busy: false })]);
    w.gateway.push(ring(0));
    // In a call elsewhere, a ring is busy.
    const v = await joined({ dm: true });
    v.gateway.push(ring(1));
    expect(v.slice('rings')).toEqual([expect.objectContaining({ busy: true })]);
  });

  // Attacker: a contact whose identity changed calls; the ring must not tempt a join the core would refuse.
  // (Can the attacker turn this refusal on an honest party? Only the instance could, by poisoning the DM's text group,
  // which already pauses that DM's composer; it can withhold op 53 anyway.)
  it('no ring entry at all for a DM whose text or call group is send-blocked', async () => {
    const w = await harness({ dm: true });
    const text = w.dms[0].text;
    w.model.blockGroup(text, 'E_UMK_CHANGED');
    w.gateway.push(ring(1));
    expect(w.slice('rings')).toEqual([]);
    w.model.unblockGroup(text);
    const dmCall = idOf(0x9e, 3);
    w.model.seedGroup(dmCall, 1, null, DM);
    w.model.blockGroup(dmCall, 'E_DEVICE_UNLISTED');
    w.gateway.push(ring(1));
    expect(w.slice('rings')).toEqual([]);
    // The control: unblocked, the same ring shows.
    w.model.unblockGroup(dmCall);
    w.gateway.push(ring(1));
    expect(w.slice('rings')).toHaveLength(1);
  });

  // Attacker: the instance rings in the name of a channel the person does not share with the caller, or as themself.
  it('drops a ring whose caller is not another participant of a known DM, and one for an unknown channel', async () => {
    const w = await harness({ dm: true });
    w.gateway.push(ring(1, { user: THIRD }));
    w.gateway.push(ring(1, { user: ME }));
    w.gateway.push(ring(1, { channel: idOf(0x77, 7) }));
    expect(w.slice('rings')).toEqual([]);
    w.gateway.push(ring(1));
    expect(w.slice('rings')).toHaveLength(1);
  });

  it('keeps one ring per channel and at most eight in total', async () => {
    const w = await harness({ dm: true, extraDms: 9 });
    w.gateway.push(ring(1, { expires: 100 }));
    w.gateway.push(ring(1, { expires: 130 }));
    expect(w.slice('rings')).toEqual([expect.objectContaining({ channelId: w.dm, ringTs: 130 })]);
    for (const dm of w.dms.slice(1)) w.gateway.push(ring(1, { channel: dm.channel, user: dm.members[0] }));
    expect(w.slice('rings')).toHaveLength(8);
    expect(w.slice('rings').map((r) => r.channelId)).not.toContain(toHex(w.dms.at(-1)!.channel));
  });

  it('callDecline posts the decline with the ring timestamp and drops the ring even when the answer is 404', async () => {
    const w = await harness({ dm: true });
    w.gateway.push(ring(1, { expires: 130 }));
    w.server.reset();
    w.server.answer('POST decline', 404);
    expect(await w.call({ m: 'callDecline', callId: w.dm, ringTs: 130 })).toBeNull();
    expect(w.server.requests).toEqual([{ route: 'POST decline', args: [DM, 130] }]);
    expect(w.slice('rings')).toEqual([]);
  });

  it('an outgoing DM call lists who is ringing and appends decliners from state 2', async () => {
    const w = await harness({ dm: 'group' });
    await w.call({ m: 'callJoin', channelId: w.dm, vdec: '' });
    expect(w.slice('call').outgoing).toEqual({ ringing: ['bob', 'carol'], declined: [] });
    w.gateway.push(voiceFrame(THIRD, DM, 1));
    expect(w.slice('call').outgoing).toEqual({ ringing: ['bob'], declined: [] });
    w.gateway.push(ring(2, { user: PEER }));
    expect(w.slice('call').outgoing).toEqual({ ringing: [], declined: ['bob'] });
  });

  it('a ring expires locally at expiresAt when no state 0 arrives', async () => {
    const w = await harness({ dm: true });
    const receivedAt = w.clock.now();
    // A lying instance: five minutes. The ring ends 30 s after it arrived.
    w.gateway.push(ring(1, { expires: Math.floor(receivedAt / 1000) + 300 }));
    expect(w.slice('rings')[0]?.expiresAt).toBe(receivedAt + 30_000);
    await w.clock.advance(29_999);
    expect(w.slice('rings')).toHaveLength(1);
    await w.clock.advance(1);
    expect(w.slice('rings')).toEqual([]);
  });

  it('joining the DM call clears its ring', async () => {
    const w = await harness({ dm: true });
    w.gateway.push(ring(1));
    await w.call({ m: 'callJoin', channelId: w.dm, vdec: '' });
    expect(w.slice('rings')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Task 6 review, fix round 1 (task-6-review.md I1, M1-M6).
// ---------------------------------------------------------------------------------------------

const waitRet = async (w: World, id: number): Promise<void> => {
  for (let i = 0; i < 60 && w.ret(id) === undefined; i++) { await settle(); await w.clock.advance(0); }
};
const keyZeroed = (w: World): boolean => {
  const m = w.model.lastMedia(w.callGroup);
  return m !== undefined && m.baseKey.byteLength === 16 && new Uint8Array(m.baseKey).every((b) => b === 0);
};

// I1. Attacker question: none (a race of the person's own commands). The property: after a leave, a sign-out, a forget or
// a revocation, no key reaches the page, the joined key is zero-filled in the worker, and the device does not stay a leaf
// of the call group without its self-Remove (except a revoked device, which can send nothing and forgets locally).
describe('a join cancelled while it runs (review I1)', () => {
  async function joining(): Promise<{ w: World; join: number; release: () => void }> {
    const w = await harness({ voiceChannel: true, callGroupBy: 'peer' });
    w.server.reset();
    const held = w.server.hold('POST calls');
    const join = w.send(JOIN(w));
    await held.reached;
    return { w, join, release: held.release };
  }
  async function cancelledBy(w: World, join: number, release: () => void, entry: number | null, proposal: boolean): Promise<void> {
    release();
    await waitRet(w, join);
    if (entry !== null) await waitRet(w, entry);
    await settled(w);
    expect(w.ret(join)).toMatchObject({ ok: false, error: { code: 'E_NO_CALL' } });
    expect(w.pushes('callKeys')).toHaveLength(0);
    expect(keyZeroed(w)).toBe(true);
    expect(w.server.routes().includes('POST proposal')).toBe(proposal);
    expect(w.model.group(w.callGroup)?.state).toBe(4);
    expect(w.slice('call').phase).toBe('idle');
    // Nothing is armed for the call it left: an hour later no rotation runs.
    await w.clock.advance(3_600_000);
    await settled(w);
    expect(w.server.routes()).not.toContain('POST commit');
  }

  it('callLeave while joining answers after the self-Remove, and the join posts no key', async () => {
    const { w, join, release } = await joining();
    const leave = w.send({ m: 'callLeave', reason: 'user' });
    await settled(w);
    expect(w.ret(leave)).toBeUndefined();                 // it waits for the join's teardown
    await cancelledBy(w, join, release, leave, true);
    expect(w.ret(leave)).toMatchObject({ ok: true, value: null });
    expect(w.server.routes().indexOf('POST proposal')).toBeGreaterThan(w.server.routes().indexOf('POST calls'));
  });

  it('forgetBrowser while joining sends the self-Remove first', async () => {
    const { w, join, release } = await joining();
    const forget = w.send({ m: 'forgetBrowser' });
    await settled(w);
    await cancelledBy(w, join, release, forget, true);
  });

  it('signOutRevoke while joining sends the self-Remove first', async () => {
    const { w, join, release } = await joining();
    const out = w.send({ m: 'signOutRevoke', recoveryKey: 'QRST'.repeat(13) });
    await settled(w);
    await cancelledBy(w, join, release, out, true);
  });

  it('a revoked socket while joining forgets the group locally and sends nothing (reset)', async () => {
    const { w, join, release } = await joining();
    w.sessionState.ok = false;
    w.revokeSocket();
    await settled(w);
    expect((w.slice('account') as { phase: string }).phase).toBe('revoked');
    await cancelledBy(w, join, release, null, false);
  });
});

describe('the rotation and the leave share the group lane (review M1, M7)', () => {
  it('a leave waits for a rotation in flight; its self-Remove is built after the rotation committed', async () => {
    const w = await joined();
    const held = w.server.hold('POST commit');
    await w.clock.advance(3_600_000);
    await held.reached;
    const leave = w.send({ m: 'callLeave', reason: 'user' });
    await settled(w);
    expect(w.server.routes()).not.toContain('POST proposal');
    held.release();
    await waitRet(w, leave);
    expect(w.server.routes().filter((r) => r !== 'GET device list')).toEqual(['POST commit', 'POST proposal']);
    const calls = w.model.calls.filter((c) => c.g === toHex(w.callGroup)).map((c) => c.m);
    expect(calls.indexOf('callLeaveProposal')).toBeGreaterThan(calls.indexOf('commitConfirm'));
  });

  it('a pause that lands while the rotation waits on the lane commits nothing', async () => {
    const w = await joined();
    // The engine's catch-up holds the lane: a frame is lost, the next one shows the gap.
    const held = w.server.holdRaw('getHandshakes');
    w.ds.dropNext(ME.device, 1);
    w.ds.peerSend(w.callGroup, PEER, 'a');
    w.ds.peerSend(w.callGroup, PEER, 'b');
    await held.reached;
    await w.clock.advance(3_600_000);                    // the rotation passes its first check and waits for the lane
    w.model.changeIdentity(PEER.user);
    await w.call({ m: 'refreshTrust' });
    expect(w.slice('call').phase).toBe('paused');
    held.release();
    await settled(w, 8);
    expect(w.server.routes()).not.toContain('POST commit');
    expect(w.model.calls.some((c) => c.m === 'callRotate')).toBe(false);
  });
});

describe('review M2-M6', () => {
  // M2. Attacker question: none; a stale decline (L-HTTP-104 acts only on the matching expires_ts) must not hide the ring
  // the instance still runs.
  it('a decline of an older ring keeps the newer ring of the same DM', async () => {
    const w = await harness({ dm: true });
    w.gateway.push(ring(1, { expires: 130 }));
    w.gateway.push(ring(1, { expires: 160 }));
    await w.call({ m: 'callDecline', callId: w.dm, ringTs: 130 });
    expect(w.slice('rings')).toEqual([expect.objectContaining({ channelId: w.dm, ringTs: 160 })]);
    expect(w.server.requests.filter((q) => q.route === 'POST decline').map((q) => q.args[1])).toEqual([130]);
    await w.call({ m: 'callDecline', callId: w.dm, ringTs: 160 });
    expect(w.slice('rings')).toEqual([]);
  });

  it('the last voice_self belongs to its call: after a leave a later join does not re-send it (M3)', async () => {
    const w = await joined();
    await w.call({ m: 'voiceSelf', callId: w.voice, flags: 1 });
    w.gateway.push(voiceFrame(ME, VOICE, 1));
    expect(w.voiceSelfSent).toHaveLength(2);
    await w.call({ m: 'callLeave', reason: 'user' });
    w.gateway.push(voiceFrame(ME, VOICE, 0));
    await w.call(JOIN(w));
    w.gateway.push(voiceFrame(ME, VOICE, 1));
    expect(w.voiceSelfSent).toHaveLength(2);
  });

  // M4. Attacker question: none; the banner must name a member of this call, never an unrelated contact.
  it('changedUser after a refused voice join names only a participant of that call, else null', async () => {
    const w = await harness({ voiceChannel: true, callGroupBy: 'peer', dm: true });
    // Dave changed his identity somewhere else entirely (a DM text group).
    w.model.addPendingLeaf(w.dms[0].text, 2, FOURTH.user, FOURTH.device, fakeDskPub(FOURTH.device), 1);
    const row = w.ds.listRow(FOURTH.user)!;
    w.model.trustList(FOURTH.user, row.version, row.blob);
    w.model.changeIdentity(FOURTH.user);
    // Bob's identity changed too (seen in the DM): his leaf in the lounge's call group now refuses the join.
    w.model.addPendingLeaf(w.dms[0].text, 1, PEER.user, PEER.device, fakeDskPub(PEER.device), 1);
    w.model.changeIdentity(PEER.user);
    expect(await codeOf(w.call(JOIN(w)))).toBe('E_UMK_CHANGED');
    expect(w.slice('call')).toMatchObject({ phase: 'blocked', changedUser: null });
    // With bob in the live call, the refusal names him.
    await w.ds.routesFor(PEER.device).startCall(VOICE, '');
    w.ds.voice(VOICE, PEER, 1);
    expect(await codeOf(w.call(JOIN(w)))).toBe('E_UMK_CHANGED');
    expect(w.slice('call')).toMatchObject({ phase: 'blocked', changedUser: toHex(PEER.user) });
  });

  // M5. Attacker: the instance, the only source of voice_state, floods a call with devices.
  it('a call lists at most 1,024 devices, and a read flooded past 1,024 frames keeps the live state', async () => {
    const w = await harness({ voiceChannel: true, callGroupBy: 'peer' });
    const many = (n: number): Peer[] => Array.from({ length: n }, (_, i) => ({ user: idOf(0xe7, i + 1), device: idOf(0xd7, i + 1) }));
    for (const p of many(1025)) w.gateway.push(voiceFrame(p, VOICE, 1));
    expect(w.slice('voice')[w.voice]?.participants).toHaveLength(1024);
    const v = await harness({ voiceChannel: true, callGroupBy: 'peer' });
    // The snapshot (taken before the flood) names bob only; no frame ever named him.
    const held = v.server.hold('GET channel call');
    v.server.reply('GET channel call', { groupId: v.callGroup, callId: VOICE, participants: [{ userId: PEER.user, deviceId: PEER.device, flags: 1 }] });
    const id = v.send({ m: 'loadVoice', communityId: null, channelId: v.voice });
    await held.reached;
    for (const p of many(1100)) v.gateway.push(voiceFrame(p, VOICE, 1));
    held.release();
    await waitRet(v, id);
    const rows = v.slice('voice')[v.voice]?.participants ?? [];
    expect(rows).toHaveLength(1024);
    expect(rows.some((p) => p.deviceId === toHex(PEER.device))).toBe(false);
  });

  // M6. Attacker question: can the instance turn a lost call-group state into a commit? No: a call group is never
  // re-joined by the engine's text resync; the call ends here as removed and the group is forgotten.
  it('a call group whose state is lost is never resynced by the engine; the call is removed', async () => {
    const w = await joined();
    w.ds.garbageCommit(w.callGroup);
    await settled(w, 8);
    expect(w.server.routes()).not.toContain('GET group info');
    expect(w.server.routes()).not.toContain('POST resync');
    expect((w.slice('call') as CallState | undefined)?.phase).toBe('removed');
    expect(w.model.group(w.callGroup)?.state).toBe(4);
    expect(w.pushes('callKeys')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Task 6 re-review hardening (note 1 and the two unpinned guards).
// ---------------------------------------------------------------------------------------------

describe('re-review hardening', () => {
  // Re-review note 1 (probe P5): a re-join during a blocked leave would race the old leave's self-Remove and forget, which
  // could overtake the new join. A join is refused while a leave is in flight.
  it('refuses a callJoin while a leave is in flight, and allows it once the leave is done', async () => {
    const w = await joined();
    const held = w.server.hold('POST proposal');
    w.model.addFailedLeaf(w.callGroup, 'E_DEVICE_UNLISTED');
    await w.deliverHandshakes(w.callGroup);
    await held.reached;
    expect(w.slice('call').phase).toBe('blocked');
    const before = w.server.routes().filter((r) => r !== 'GET device list');
    expect(await codeOf(w.call(JOIN(w)))).toBe('E_CALL_ACTIVE');
    expect(w.server.routes().filter((r) => r !== 'GET device list')).toEqual(before);
    held.release();
    await settled(w);
    expect(w.model.group(w.callGroup)?.state).toBe(4);
    expect(w.slice('call').phase).toBe('blocked');
    // Done leaving, a join may run again (the forged leaf keeps refusing it: no key either way).
    expect(await codeOf(w.call(JOIN(w)))).toBe('E_DEVICE_UNLISTED');
    expect(w.pushes('callKeys')).toHaveLength(0);
  });

  // The in-lane guard: a rotation that waited for the group lane while a leave was posted never commits (call_rotate would
  // cancel the posted self-Remove).
  it('a rotation waiting on the lane when a leave starts commits nothing', async () => {
    const w = await joined();
    const held = w.server.holdRaw('getHandshakes');
    w.ds.dropNext(ME.device, 1);
    w.ds.peerSend(w.callGroup, PEER, 'a');
    w.ds.peerSend(w.callGroup, PEER, 'b');
    await held.reached;
    await w.clock.advance(3_600_000);                    // the rotation passes its first checks and waits for the lane
    const leave = w.send({ m: 'callLeave', reason: 'user' });
    held.release();
    await waitRet(w, leave);
    await settled(w);
    expect(w.model.calls.some((c) => c.m === 'callRotate')).toBe(false);
    expect(w.server.routes()).not.toContain('POST commit');
    expect(w.server.routes()).toContain('POST proposal');
  });

  // Ruling I2 and review M4 on the pause path of a voice channel: the candidates are the keyed roster's users. Carol's leaf
  // turns up under another key (a stored verdict, no pending key change); dave changed elsewhere and is not in the call.
  it('a pause in a voice channel names a changed member of the keyed roster', async () => {
    const w = await harness({ voiceChannel: true, callGroupBy: 'peer', dm: true });
    const carol = w.ds.listRow(THIRD.user)!;
    w.model.trustList(THIRD.user, carol.version, carol.blob);
    w.model.setCallTree(w.callGroup, [{ leafIndex: 0, user: PEER.user, device: PEER.device }, { leafIndex: 2, user: THIRD.user, device: THIRD.device }]);
    w.model.addPendingLeaf(w.dms[0].text, 2, FOURTH.user, FOURTH.device, fakeDskPub(FOURTH.device), 1);
    const dave = w.ds.listRow(FOURTH.user)!;
    w.model.trustList(FOURTH.user, dave.version, dave.blob);
    w.model.changeIdentity(FOURTH.user);
    await w.call(JOIN(w));
    expect(w.slice('call').roster.map((r) => r.userId)).toContain(toHex(THIRD.user));
    w.model.forceVerdict(w.callGroup, 2, 'E_UMK_CHANGED');
    await w.deliverHandshakes(w.callGroup);
    await settled(w);
    expect(w.slice('call')).toMatchObject({ phase: 'paused', changedUser: toHex(THIRD.user) });
  });
});

export { fromHex };

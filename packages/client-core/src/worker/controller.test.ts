import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BootOutcome } from '../account/boot';
import { Enrol } from '../account/enrol';
import { Session } from '../account/session';
import type { Signup } from '../account/signup';
import { encode, type CborInput } from '../cbor';
import { sealBlob, sealThumb, BROWSER_ATTACHMENT_CAP } from '../attachments/crypto';
import {
  CoreError, type ActivityRow, type ApplyResult, type AttachmentDescriptor, type CorePort, type GroupInfo, type IdentityInfo,
  type OutboxRow, type OwnDeviceList, type PinRow, type PurgeRow, type SealedObjects, type SendRequest, type SessionRecord,
  type SignedLists, type TimelineRow,
} from '../core-port';
import { CLIENT_CLOSE, type Gateway, type GatewayDeps, type GatewayEvent, type ReadyInfo } from '../gateway/gateway';
import { toHex } from '../hex';
import { DillaHttpError } from '../http/errors';
import type { Instance, Routes } from '../http/routes';
import type {
  AccountState, BadgeState, ChannelSummary, CommunitySummary, ConnectionState, DeviceSummary, DmSummary, MemberSummary, NoticesState,
  PinnedItem, TimelineState, TrayItem,
} from '../state/types';
import type { SyncDeps, SyncEngine } from '../sync/engine';
import { SyncError } from '../sync/errors';
import { Controller, type ControllerDeps, type ControllerParts } from './controller';
import type { LockLike, LockManagerLike } from './leader';
import { LEADER } from './leader';
import type { FromWorker } from './protocol';

/** tsc does not narrow a find or filter callback, so the slice messages are named by a type predicate. */
type SliceMessage = Extract<FromWorker, { t: 'slice' }>;

const INSTANCE_ID = new Uint8Array(16).fill(0x42);
const INSTANCE_HEX = '42'.repeat(16);
const LOCK = `dilla-core:${INSTANCE_HEX}`;
// GET /v1/instance: [wire, e2ee, media, instance_id, generation, name, registration_mode, auth_methods,
// policy_version, external_sender_key_id, external_sender_pub] (interfaces.md A3, protocol/09).
const INSTANCE_DOC: CborInput = [[1], [1], [1], INSTANCE_ID, 7, 'dilla.test', 0, [0], 1, new Uint8Array(16).fill(1), new Uint8Array(32).fill(2)];
// GET /v1/instance/limits, eleven elements.
const LIMITS: CborInput = [131_072, 104_857_600, 4, 2, 32, 8, 10_737_418_240, 30_000, 131_584, 30, 30];

function cbor(value: CborInput, status = 200): Response {
  return new Response(encode(value).slice(), { status, headers: { 'content-type': 'application/cbor' } });
}

function fakeFetch(paths: string[]): typeof fetch {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/require-await -- the brief's double, kept as written
  return (async (input: RequestInfo | URL) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    paths.push(path);
    if (path === '/v1/instance') return cbor(INSTANCE_DOC);
    if (path === '/v1/instance/limits') return cbor(LIMITS);
    return cbor(['E_NOT_FOUND', 'not modelled by this test', null], 404);
  }) as typeof fetch;
}

/** Web Locks as one origin sees them: another tab may hold a lock; a plain request waits for it. */
class FakeLocks implements LockManagerLike {
  readonly requests: { name: string; ifAvailable: boolean }[] = [];
  private readonly held = new Set<string>();
  private readonly waiting = new Map<string, (() => void)[]>();

  holdElsewhere(name: string): () => void {
    this.held.add(name);
    return () => {
      this.held.delete(name);
      this.waiting.get(name)?.shift()?.();
    };
  }

  async request(name: string, options: { ifAvailable?: boolean }, callback: (lock: LockLike | null) => Promise<void>): Promise<void> {
    this.requests.push({ name, ifAvailable: options.ifAvailable === true });
    if (this.held.has(name)) {
      if (options.ifAvailable === true) return callback(null);
      await new Promise<void>((resolve) => {
        const queue = this.waiting.get(name) ?? [];
        queue.push(resolve);
        this.waiting.set(name, queue);
      });
    }
    this.held.add(name);
    return callback({ name });
  }
}

/** Only what boot, the signup phases and the reset path call; nothing else is reached in these tests. */
function stubCore(): { core: CorePort; resets: () => number } {
  let phase: IdentityInfo['phase'] = 0;
  let resets = 0;
  const core = {
    identity: (): IdentityInfo => ({
      phase, instanceId: phase === 0 ? null : INSTANCE_ID, userId: null,
      deviceId: phase === 0 ? null : new Uint8Array(16).fill(9), username: '', listPublished: false,
    }),
    signupBegin: (): string => { phase = 1; return 'ABCD'.repeat(13); },
    signupReset: (): void => { phase = 0; resets += 1; },
    close: (): void => {},
  };
  return { core: core as unknown as CorePort, resets: () => resets };
}

function harness(over: Partial<ControllerDeps> = {}) {
  const posted: FromWorker[] = [];
  const paths: string[] = [];
  const locks = new FakeLocks();
  const deps: ControllerDeps = {
    origin: 'http://127.0.0.1:8453',
    fetch: fakeFetch(paths),
    WebSocket: class {} as unknown as typeof WebSocket,
    locks,
    now: () => 1_700_000_000_000,
    random: () => 0,
    setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
    clearTimeout: (handle) => clearTimeout(handle),
    sleep: () => Promise.resolve(),
    boot: () => Promise.resolve({ kind: 'unsupported', reason: 'not set by this test' }),
    resetDevice: () => Promise.resolve(),
    post: (m) => { posted.push(m); },
    testHooks: false,
    ...over,
  };
  const controller = new Controller(deps);
  const last = <T>(name: string): T | undefined =>
    [...posted].reverse().find((m): m is SliceMessage => m.t === 'slice' && m.name === name)?.value as T | undefined;
  return {
    controller, posted, paths, locks, last,
    account: () => last<AccountState>('account'),
    connection: () => last<ConnectionState>('connection'),
    ret: (id: number) => posted.find((m) => m.t === 'ret' && m.id === id),
    call: (id: number, command: unknown) => controller.handle({ t: 'call', id, command }),
  };
}

const opened = (core: CorePort) => (instance: Instance): Promise<BootOutcome> =>
  Promise.resolve({ kind: 'opened', core, instance });

describe('Controller', () => {
  it('start reads the instance, waits as other-tab while another tab holds the lock, and boots when it is released', async () => {
    const h = harness({ boot: () => Promise.resolve({ kind: 'unsupported', reason: 'no OPFS in this test' }) });
    const release = h.locks.holdElsewhere(LOCK);
    h.call(1, { m: 'start' });
    // Pre-flight ruling 4: other-tab is published only once the lock is still held LEADER.otherTabGraceMs
    // after the failed attempt, so this wait outlasts the grace (vi.waitFor's default is 1000 ms).
    await vi.waitFor(() => expect(h.account()?.phase).toBe('other-tab'), { timeout: LEADER.otherTabGraceMs + 3_000 });
    expect(h.ret(1)).toEqual({ t: 'ret', id: 1, ok: true, value: null });
    expect(h.account()?.instance).toEqual({ id: INSTANCE_HEX, name: 'dilla.test', registrationMode: 0, passwordSignup: true });
    expect(h.connection()).toEqual({ status: 'offline', generation: null });
    release();
    await vi.waitFor(() => expect(h.account()?.phase).toBe('unsupported'));
    expect(h.account()?.error).toEqual({ code: 'E_UNSUPPORTED', detail: 'no OPFS in this test', status: 0, retryAfterMs: null });
    expect(h.locks.requests).toEqual([{ name: LOCK, ifAvailable: true }, { name: LOCK, ifAvailable: false }]);
  });

  it('start is idempotent', async () => {
    const h = harness();
    h.call(1, { m: 'start' });
    h.call(2, { m: 'start' });
    await vi.waitFor(() => expect(h.account()?.phase).toBe('unsupported'));
    expect(h.ret(1)).toEqual({ t: 'ret', id: 1, ok: true, value: null });
    expect(h.ret(2)).toEqual({ t: 'ret', id: 2, ok: true, value: null });
    expect(h.paths.filter((p) => p === '/v1/instance')).toHaveLength(1);
    expect(h.locks.requests).toEqual([{ name: LOCK, ifAvailable: true }]);
  });

  it('a failed instance read is the start error and the account error', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- the brief's double, kept as written
    const h = harness({ fetch: (() => Promise.resolve(new Response('proxy says no', { status: 502 }))) as typeof fetch });
    h.call(1, { m: 'start' });
    await vi.waitFor(() => expect(h.ret(1)).toBeDefined());
    expect(h.ret(1)).toEqual({ t: 'ret', id: 1, ok: false, error: { code: 'E_HTTP', detail: '', status: 502, retryAfterMs: null } });
    expect(h.account()).toMatchObject({ phase: 'error', error: { code: 'E_HTTP', detail: '', status: 502, retryAfterMs: null } });
    expect(h.locks.requests).toEqual([]);
  });

  it('a store without an identity asks for signup; signupBegin shows the key and signupReset withdraws it', async () => {
    const { core, resets } = stubCore();
    const h = harness({ boot: opened(core) });
    h.call(1, { m: 'start' });
    await vi.waitFor(() => expect(h.account()?.phase).toBe('needs-signup'));
    expect(h.account()?.recoveryKey).toBeNull();
    h.call(2, { m: 'signupBegin' });
    await vi.waitFor(() => expect(h.ret(2)).toEqual({ t: 'ret', id: 2, ok: true, value: null }));
    expect(h.account()).toMatchObject({ phase: 'signup-keys', recoveryKey: Array.from({ length: 13 }, () => 'ABCD'), error: null });
    h.call(3, { m: 'signupReset' });
    await vi.waitFor(() => expect(h.ret(3)).toEqual({ t: 'ret', id: 3, ok: true, value: null }));
    expect(h.account()).toMatchObject({ phase: 'needs-signup', recoveryKey: null });
    expect(resets()).toBe(1);
  });

  it('refuses a command its phase does not accept', async () => {
    const { core } = stubCore();
    const h = harness({ boot: opened(core) });
    h.call(1, { m: 'send', channelId: 'a'.repeat(32), text: 'too early' });
    h.call(2, { m: 'start' });
    await vi.waitFor(() => expect(h.account()?.phase).toBe('needs-signup'));
    h.call(3, { m: 'joinCommunity', invite: 'code' });
    h.call(4, { m: 'openChannel', channelId: 'a'.repeat(32) });
    h.call(5, { m: 'signupSubmit', invite: 'code', username: 'web', display: 'Web', password: null, recoveryKeyAcknowledged: true });
    h.call(6, { m: 'resetDevice' });
    await vi.waitFor(() => expect(h.ret(6)).toBeDefined());
    for (const id of [1, 3, 4, 5, 6]) {
      expect(h.ret(id)).toMatchObject({ t: 'ret', id, ok: false, error: { code: 'E_NOT_READY' } });
    }
    expect(h.ret(1)).toMatchObject({ error: { detail: 'the phase is loading' } });
    expect(h.ret(3)).toMatchObject({ error: { detail: 'the phase is needs-signup' } });
  });

  it('refuses malformed input before anything runs, and answers nothing to a message that is not a call', async () => {
    const h = harness();
    h.call(1, { m: 'selectCommunity', communityId: 'XYZ' });
    h.call(2, { m: 'send', channelId: 'a'.repeat(32), text: ' \n ' });
    h.call(3, { m: 'nope' });
    h.call(4, { m: 'openChannel', channelId: 'A'.repeat(32) });
    h.call(5, { m: 'joinCommunity', invite: '   ' });
    h.controller.handle({ t: 'hello' });
    h.controller.handle({ t: 'call', id: 'x', command: { m: 'start' } });
    h.controller.handle({ t: 'test', op: 'gateway-stop' });
    await vi.waitFor(() => expect(h.ret(5)).toBeDefined());
    for (const id of [1, 2, 3, 4, 5]) expect(h.ret(id)).toMatchObject({ ok: false, error: { code: 'E_BAD_INPUT' } });
    expect(h.ret(1)).toMatchObject({ error: { detail: 'communityId is not 32 lowercase hex' } });
    expect(h.ret(3)).toMatchObject({ error: { detail: 'unknown command nope' } });
    expect(h.posted.filter((m) => m.t === 'ret')).toHaveLength(5);
    expect(h.paths).toEqual([]);
  });

  it("a lost store offers resetDevice, which wipes this browser's device and boots again", async () => {
    const { core } = stubCore();
    const wiped: string[] = [];
    let boots = 0;
    const h = harness({
      boot: (instance) => {
        boots += 1;
        return Promise.resolve(boots === 1 ? { kind: 'store-lost' } : { kind: 'opened', core, instance });
      },
      resetDevice: (instance) => { wiped.push(toHex(instance.instanceId)); return Promise.resolve(); },
    });
    h.call(1, { m: 'start' });
    await vi.waitFor(() => expect(h.account()?.phase).toBe('store-lost'));
    h.call(2, { m: 'resetDevice' });
    await vi.waitFor(() => expect(h.ret(2)).toEqual({ t: 'ret', id: 2, ok: true, value: null }));
    expect(h.account()?.phase).toBe('needs-signup');
    expect(wiped).toEqual([INSTANCE_HEX]);
    expect(boots).toBe(2);
  });
});

// ---- The ready phase, with the five composed parts (ControllerParts) replaced by doubles. ----

const USER = new Uint8Array(16).fill(0x0a);
const DEVICE = new Uint8Array(16).fill(0x0b);
const COMMUNITY = new Uint8Array(16).fill(0xc0);
const CHANNEL = new Uint8Array(16).fill(0xc1);
const GROUP = new Uint8Array(16).fill(0xc2);
const STRANGER = new Uint8Array(16).fill(0x5a);
const INSTANCE: Instance = {
  instanceId: INSTANCE_ID, generation: 7n, name: 'dilla.test', registrationMode: 0, authMethods: [0],
  policyVersion: 1n, externalSenderPub: new Uint8Array(32).fill(2),
};
const READY_INFO: ReadyInfo = {
  deviceId: DEVICE, userId: USER, generation: 7n, keypackagesRemaining: 32, groups: [],
  heartbeatMs: 30_000, maxFrameBytes: 131_584, backoffMs: 1_000, backoffJitterMs: 500,
};
const refusal = (status: number, code: string, retryAfterMs: number | null = null): DillaHttpError =>
  new DillaHttpError({ status, code, detail: '', retryAfterMs, extra: [] });
const SUBMIT = {
  m: 'signupSubmit', invite: 'friends-code', username: 'web', display: 'Web', password: null, recoveryKeyAcknowledged: true,
} as const;

function textGroup(state: 0 | 1 | 2 | 3 | 4): GroupInfo {
  return { groupId: GROUP, kind: 0, communityId: COMMUNITY, targetId: CHANNEL, state, epoch: 1n, nextSeq: 1n, proposalsPending: 0, pendingCommit: false };
}

function applied(state: 0 | 1 | 2 | 3 | 4): ApplyResult {
  return { state, epoch: 2n, nextSeq: 5n, newSeqs: [], proposalsPending: 0, epochChanged: true, ownAdopted: false };
}

function strangerRow(seq: number): TimelineRow {
  return {
    seq: BigInt(seq), epoch: 1n, recvTs: 1_700_000_000n, status: 0, reason: '', senderUser: STRANGER,
    senderDevice: new Uint8Array(16).fill(0x5b), senderKind: 0, senderTier: 0, msgId: new Uint8Array(16).fill(0x30 + seq),
    type: 0, body: `from a stranger ${seq}`, editedSeq: 0n, reply: null, reactions: [], pinned: false, attachments: [], mention: false,
  };
}

class GatewayDouble {
  starts = 0;
  stops = 0;
  readonly status = 'idle';
  private readonly listeners: ((e: GatewayEvent) => void)[] = [];
  constructor(private readonly log: string[] = []) {}
  start(): void { this.starts += 1; this.log.push('gateway.start'); }
  stop(): void { this.stops += 1; this.log.push('gateway.stop'); }
  subscribe(listener: (e: GatewayEvent) => void): () => void { this.listeners.push(listener); return () => {}; }
  commitAck(): void {}
  emit(e: GatewayEvent): void { for (const l of this.listeners) l(e); }
}

const DM_CHANNEL = new Uint8Array(16).fill(0xd1);
const DM_GROUP = new Uint8Array(16).fill(0xd2);
const OTHER_DEVICE = new Uint8Array(16).fill(0x0c);
const ORPHAN_GROUP = new Uint8Array(16).fill(0xe2);
const ORPHAN_CHANNEL = new Uint8Array(16).fill(0xe1);
const RECOVERY_KEY = 'QRST'.repeat(13);
const PASSWORD = 'correct horse battery staple';
const ROOT = new Uint8Array([1, 2, 3]);
const STATE_OBJECT = new Uint8Array([4, 5, 6]);
const LOCAL_STATE = new Uint8Array([4, 5, 7]);
const LIST_RAW = new Uint8Array([0x84, 0x01, 0x41, 0x09]);
const FETCHED = { root: ROOT, state: STATE_OBJECT, listBody: LIST_RAW };
const NOW_S = 1_700_000_000n;

// `now` is an addition to the brief's double (pre-flight ruling (a)): a test of the notice floor moves the clock.
// `realAccount` (WORKER-WEB-01) composes the real Session and Enrol over these doubles, so the session record the
// core keeps decides what ensure() does.
function world(opts: {
  phase?: 0 | 1 | 2 | 3; enrolUser?: boolean; realRoutes?: boolean; realAccount?: boolean; fetch?: typeof fetch; now?: () => number;
} = {}) {
  // An account that is already registered (phase 2) is already a member of the community, so that a
  // selectCommunity of it passes pre-flight ruling 1(v); a signup or sign-in world starts outside it.
  const calls: string[] = [];
  const state = {
    phase: opts.phase ?? 2, enrolUser: opts.enrolUser === true ? USER : null as Uint8Array | null, username: 'web',
    groups: [] as GroupInfo[], rows: [] as TimelineRow[], activity: [] as ActivityRow[], settings: {} as Record<string, string>,
    ownList: { version: 1n, published: true, entries: [{ deviceId: DEVICE, dskPub: new Uint8Array(32), tier: 1, addedAt: 1n, revokedAt: null }] } as OwnDeviceList,
    resets: 0, joined: (opts.phase ?? 2) === 2,
    dms: [] as { channelId: Uint8Array; kind: 3 | 4; members: Uint8Array[] }[],
    session: null as SessionRecord | null, listPublished: null as boolean | null,
    outbox: [] as OutboxRow[], pins: [] as PinRow[], purges: [] as PurgeRow[], roleIds: [] as Uint8Array[],
    descriptors: new Map<string, AttachmentDescriptor>(), blobs: new Map<string, Uint8Array>(),
  };
  /* eslint-disable @typescript-eslint/no-unused-vars -- the typed parameters give the doubles their call signatures */
  const core = {
    identity: (): IdentityInfo => ({
      phase: state.phase, instanceId: INSTANCE_ID,
      userId: state.phase === 2 ? USER : state.phase === 3 ? state.enrolUser : null,
      deviceId: DEVICE, username: state.phase === 2 ? state.username : '', listPublished: state.listPublished ?? state.phase === 2,
    }),
    signupBegin: (): string => { state.phase = 1; return 'ABCD'.repeat(13); },
    signupReset: (): void => { state.phase = 0; state.resets += 1; },
    groups: (): GroupInfo[] => state.groups,
    groupRow: (g: Uint8Array): GroupInfo | null => state.groups.find((x) => toHex(x.groupId) === toHex(g)) ?? null,
    timeline: (): TimelineRow[] => state.rows,
    outbox: (): OutboxRow[] => state.outbox,
    activity: (): ActivityRow[] => state.activity,
    markRead: vi.fn((_g: Uint8Array, _seq: bigint, _now: bigint): void => { calls.push('core.markRead'); }),
    settings: (): Record<string, string> => ({ ...state.settings }),
    settingPut: vi.fn((k: string, v: string): void => { state.settings[k] = v; }),
    settingDelete: vi.fn((k: string): void => { state.settings = Object.fromEntries(Object.entries(state.settings).filter(([key]) => key !== k)); }),
    ownDeviceList: (): OwnDeviceList => state.ownList,
    deviceListRevoke: vi.fn((_input: unknown): SignedLists => {
      calls.push('core.deviceListRevoke'); return { deviceListBody: new Uint8Array([7]), stateSealed: new Uint8Array([8]), interrupted: null };
    }),
    deviceListDrop: vi.fn((): void => { calls.push('core.deviceListDrop'); state.listPublished = false; }),
    stateSealedUploaded: vi.fn((): void => { calls.push('core.stateSealedUploaded'); }),
    // An addition to the brief's double (task-14 fix round 1): the state object this device sealed, as the core keeps it.
    sealedObjects: vi.fn((): SealedObjects => ({ root: ROOT, state: LOCAL_STATE, stateUploaded: true })),
    deviceListPublished: vi.fn((): void => { calls.push('core.deviceListPublished'); state.listPublished = true; }),
    deviceListBody: (): Uint8Array => new Uint8Array([7]),
    enrolComplete: vi.fn((_input: unknown): SignedLists => {
      calls.push('core.enrolComplete'); state.phase = 2; state.listPublished = false;
      return { deviceListBody: new Uint8Array([7]), stateSealed: new Uint8Array([8]), interrupted: null };
    }),
    session: (): SessionRecord | null => state.session,
    sessionStore: vi.fn((s: SessionRecord): void => { state.session = s; }),
    sessionClear: vi.fn((): void => { calls.push('core.sessionClear'); state.session = null; }),
    sessionSign: (_nonce: Uint8Array, _purpose: 0 | 1): Uint8Array => new Uint8Array([0x5e]),
    recoveryKeyCheck: vi.fn((_key: string): void => { calls.push('core.recoveryKeyCheck'); }),
    pins: vi.fn((_g: Uint8Array): PinRow[] => state.pins),
    purges: vi.fn((): PurgeRow[] => state.purges),
    purgeDone: vi.fn((_g: Uint8Array, seq: bigint): void => {
      calls.push(`core.purgeDone(${String(seq)})`); state.purges = state.purges.filter((p) => p.seq !== seq);
    }),
    ownRolesSet: vi.fn((_c: Uint8Array, _ids: Uint8Array[]): void => {}),
    attachmentGet: vi.fn((_g: Uint8Array, seq: bigint, index: number): AttachmentDescriptor => {
      const d = state.descriptors.get(`${String(seq)}:${String(index)}`);
      if (d === undefined) throw new CoreError('E_CORE_NOT_FOUND', 'no such attachment');
      return d;
    }),
    pause: vi.fn((): void => { calls.push('core.pause'); }),
    close: (): void => {},
  };
  const routes = {
    getInstance: vi.fn(() => Promise.resolve(INSTANCE)),
    getLimits: vi.fn(() => Promise.resolve({
      maxCiphertextBytes: 131_072, keypackagesPerDevice: 32, keypackageRefillThreshold: 8, heartbeatMs: 30_000, maxFrameBytes: 131_584,
    })),
    getInvite: vi.fn((_code: string) => Promise.resolve({ communityId: null as Uint8Array | null, communityName: null as string | null, expires: 0n })),
    joinCommunity: vi.fn((_id: Uint8Array, _invite: string) => { state.joined = true; return Promise.resolve(); }),
    listCommunities: vi.fn(() => { calls.push('listCommunities'); return Promise.resolve(state.joined ? [{ id: COMMUNITY, name: 'friends', owner: USER, policyVersion: 1n }] : []); }),
    listChannels: vi.fn((_id: Uint8Array) => { calls.push('listChannels'); return Promise.resolve([{
      id: CHANNEL, kind: 0, mode: 0, visibility: 0, parentId: null, name: 'general', topic: '', position: 0, seq: 1n, textGroupId: GROUP,
    }]); }),
    listMembers: vi.fn((_id: Uint8Array) => {
      calls.push('listMembers');
      return Promise.resolve([{ userId: USER, username: 'web', display: 'Web', kind: 0 as const, nick: '', roleIds: state.roleIds }]);
    }),
    putBlob: vi.fn((_c: Uint8Array, blobId: Uint8Array, stored: Uint8Array) => {
      calls.push(`putBlob(${toHex(blobId).slice(0, 8)})`); state.blobs.set(toHex(blobId), stored);
      return Promise.resolve({ created: true, size: stored.length });
    }),
    confirmBlob: vi.fn((_c: Uint8Array, blobId: Uint8Array) => { calls.push(`confirmBlob(${toHex(blobId).slice(0, 8)})`); return Promise.resolve(); }),
    getBlob: vi.fn((_c: Uint8Array, blobId: Uint8Array): Promise<Uint8Array | null> => Promise.resolve(state.blobs.get(toHex(blobId)) ?? null)),
    deleteBlob: vi.fn((_c: Uint8Array, blobId: Uint8Array) => { calls.push(`deleteBlob(${toHex(blobId).slice(0, 8)})`); return Promise.resolve(); }),
    deleteGroupMessage: vi.fn((_g: Uint8Array, seq: bigint): Promise<'deleted' | 'gone'> => {
      calls.push(`deleteGroupMessage(${String(seq)})`); return Promise.resolve('deleted');
    }),
    postTicket: vi.fn(() => Promise.resolve({ ticket: 'ticket', expires: 0n })),
    getAccountMe: vi.fn(() => Promise.resolve({ userId: USER, username: 'web', display: 'Web', kind: 0, flags: 0n })),
    listDms: vi.fn(() => { calls.push('listDms'); return Promise.resolve(state.dms); }),
    getChannel: vi.fn((_id: Uint8Array) => Promise.resolve({
      id: DM_CHANNEL, kind: 3, mode: 0, visibility: 0, parentId: null, name: '', topic: '', position: 0, seq: 1n, textGroupId: DM_GROUP,
    })),
    postDm: vi.fn((_recipients: Uint8Array[]) => {
      state.dms = [{ channelId: DM_CHANNEL, kind: 3, members: [USER, STRANGER] }];
      return Promise.resolve({ channelId: DM_CHANNEL, created: true });
    }),
    listDevices: vi.fn(() => { calls.push('listDevices'); return Promise.resolve([
      { id: OTHER_DEVICE, tier: 1 as const, signerTier: 1 as const, verifiedAt: null, revokedAt: null, lastSeen: 1_699_999_000n },
      { id: DEVICE, tier: 1 as const, signerTier: 1 as const, verifiedAt: null, revokedAt: null, lastSeen: 1_700_000_000n },
    ]); }),
    deleteSessions: vi.fn((_id: Uint8Array) => { calls.push('deleteSessions'); return Promise.resolve(); }),
    deleteDevice: vi.fn((_id: Uint8Array) => { calls.push('deleteDevice'); return Promise.resolve(); }),
    // The return type is spelled out so the tests' replacements (null, or another Uint8Array) typecheck.
    getBackup: vi.fn((kind: 0 | 1): Promise<{ object: Uint8Array; created: bigint } | null> => {
      calls.push(`getBackup(${kind})`); return Promise.resolve({ object: kind === 0 ? ROOT : STATE_OBJECT, created: 1n });
    }),
    putBackup: vi.fn((kind: 0 | 1, _object: Uint8Array) => { calls.push(`putBackup(${kind})`); return Promise.resolve({ blobId: new Uint8Array(32), size: 3, created: false }); }),
    getDeviceList: vi.fn((_user: Uint8Array) => { calls.push('getDeviceList'); return Promise.resolve({ version: 1n, blob: new Uint8Array([9]), raw: LIST_RAW }); }),
    putDeviceList: vi.fn((_user: Uint8Array, _body: Uint8Array) => { calls.push('putDeviceList'); return Promise.resolve(); }),
    postChallenge: vi.fn((_device: Uint8Array) => Promise.resolve({ nonce: new Uint8Array(32), expires: NOW_S + 60n })),
    postSession: vi.fn((_device: Uint8Array, _body: Uint8Array) => {
      calls.push('postSession');
      return Promise.resolve({
        token: 'enrolled', scope: 0, userId: USER, deviceId: DEVICE, expires: NOW_S + 604_800n,
        idleExpires: NOW_S + 43_200n, generation: 7n,
      });
    }),
  };
  const session = {
    token: (): string => 'session-token',
    ensure: vi.fn(() => { calls.push('session.ensure'); return Promise.resolve(true); }),
    establish: vi.fn(() => { calls.push('session.establish'); return Promise.resolve(true); }),
  };
  const signup = {
    begin: (_instanceId: Uint8Array): string[] => { core.signupBegin(); return Array.from({ length: 13 }, () => 'ABCD'); },
    submit: vi.fn((_input: unknown) => { state.phase = 2; return Promise.resolve(); }),
    resume: vi.fn((): Promise<0 | 2 | 'revoked'> => Promise.resolve(2)),
  };
  const enrol = {
    login: vi.fn((_username: string, _password: string) => { calls.push('enrol.login'); return Promise.resolve({ needsTotp: false }); }),
    totp: vi.fn((_code: string) => { calls.push('enrol.totp'); return Promise.resolve(); }),
    register: vi.fn((_instanceId: Uint8Array) => { calls.push('enrol.register'); state.phase = 3; state.enrolUser = USER; return Promise.resolve({ userId: USER }); }),
    fetch: vi.fn((_userId: Uint8Array) => { calls.push('enrol.fetch'); return Promise.resolve(FETCHED); }),
    complete: vi.fn((_key: string, _fetched: unknown, _username: string) => { calls.push('enrol.complete'); state.phase = 2; return Promise.resolve(); }),
    reset: vi.fn((): void => { calls.push('enrol.reset'); state.phase = 0; state.enrolUser = null; }),
  };
  const account = {
    publishDeviceList: vi.fn((_core: CorePort, _routes: Routes) => { calls.push('publishDeviceList'); return Promise.resolve(); }),
    ensureBackups: vi.fn((_core: CorePort, _routes: Routes) => { calls.push('ensureBackups'); return Promise.resolve(); }),
    refreshOwnDeviceList: vi.fn((_core: CorePort, _routes: Routes, _user: Uint8Array) => {
      calls.push('refreshOwnDeviceList'); return Promise.resolve({ version: 1n, listed: true });
    }),
    repairBackupState: vi.fn((_core: CorePort, _routes: Routes) => { calls.push('repairBackupState'); return Promise.resolve(false); }),
  };
  const gateway = new GatewayDouble(calls);
  // An addition to the brief's double (pre-flight ruling (a)): a test mints a ticket through the deps the controller passed.
  const gatewayDeps: { value: GatewayDeps | null } = { value: null };
  const sync = {
    deps: null as SyncDeps | null,
    builds: 0,                                   // parts.sync calls: 1 at ready, +1 for each resume() after a refused wipe call
    start: vi.fn(() => { calls.push('sync.start'); }), stop: vi.fn(() => { calls.push('sync.stop'); }),
    setChannels: vi.fn(), setExpected: vi.fn((_groups: unknown) => {}), send: vi.fn(), retry: vi.fn(), discard: vi.fn(),
    sendRequest: vi.fn((_g: Uint8Array, _r: SendRequest): Uint8Array => new Uint8Array(16).fill(0x77)),
    openChannel: vi.fn((_c: unknown) => Promise.resolve({ groupId: GROUP, state: 2 as const })),
  };
  /* eslint-enable @typescript-eslint/no-unused-vars */
  const wiped: string[] = [];
  const parts: Partial<ControllerParts> = {
    ...(opts.realRoutes === true ? {} : { routes: () => routes as unknown as Routes }),
    session: opts.realAccount === true ? (d) => new Session(d) : () => session as unknown as Session,
    signup: () => signup as unknown as Signup,
    enrol: opts.realAccount === true ? (d) => new Enrol(d) : () => enrol as unknown as Enrol,
    gateway: (deps) => { gatewayDeps.value = deps; return gateway as unknown as Gateway; },
    sync: (deps) => { sync.deps = deps; sync.builds += 1; return sync as unknown as SyncEngine; },
    publishDeviceList: account.publishDeviceList,
    ensureBackups: account.ensureBackups,
    refreshOwnDeviceList: account.refreshOwnDeviceList,
    repairBackupState: account.repairBackupState,
  };
  const h = harness({
    boot: (instance) => Promise.resolve({ kind: 'opened', core: core as unknown as CorePort, instance }),
    resetDevice: (instance) => { calls.push('resetDevice'); wiped.push(toHex(instance.instanceId)); return Promise.resolve(); },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    parts,
  });
  // The brief's literal put `account` (the three account-part doubles) after `...h`, which shadowed h.account()
  // (the account slice) that the same tests call; one callable object serves both spellings.
  const accountView = Object.assign((): AccountState | undefined => h.account(), account);
  return {
    ...h, state, calls, core, routes, session, signup, enrol, account: accountView, gateway, gatewayDeps, sync, wiped, parts,
    channels: () => h.last<ChannelSummary[]>(`channels:${toHex(COMMUNITY)}`),
    timeline: () => h.last<TimelineState>(`timeline:${toHex(CHANNEL)}`),
    badges: () => h.last<Record<string, BadgeState>>('badges'),
    notices: () => h.last<NoticesState>('notices'),
  };
}
type World = ReturnType<typeof world>;

async function toReady(w: World): Promise<void> {
  w.call(1, { m: 'start' });
  await vi.waitFor(() => expect(w.account()?.phase).toBe('ready'));
}

async function toKeys(w: World): Promise<void> {
  w.call(1, { m: 'start' });
  await vi.waitFor(() => expect(w.account()?.phase).toBe('needs-signup'));
  w.call(2, { m: 'signupBegin' });
  await vi.waitFor(() => expect(w.ret(2)).toEqual({ t: 'ret', id: 2, ok: true, value: null }));
}

/** Selects the community and opens #general, whose text group is active (commands 2 and 3). */
async function openGeneral(w: World): Promise<void> {
  w.state.groups = [textGroup(2)];
  w.call(2, { m: 'selectCommunity', communityId: toHex(COMMUNITY) });
  await vi.waitFor(() => expect(w.ret(2)).toEqual({ t: 'ret', id: 2, ok: true, value: null }));
  w.call(3, { m: 'openChannel', channelId: toHex(CHANNEL) });
  await vi.waitFor(() => expect(w.ret(3)).toEqual({ t: 'ret', id: 3, ok: true, value: null }));
  expect(w.channels()?.[0]?.group).toBe('active');
}

/** Lets every queued promise job and the next timer turn run, so a late publish would be seen. */
const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

describe('Controller in the ready phase', () => {
  it('an HTTP refusal crosses with its status and wait', async () => {
    const w = world({ phase: 0 });
    // Signup.submit propagates postAccount's DillaHttpError unchanged (L-TS-06); the double throws what it would.
    w.signup.submit.mockImplementationOnce(() => Promise.reject(refusal(429, 'E_RATE_LIMITED', 4200)));
    await toKeys(w);
    w.call(3, SUBMIT);
    await vi.waitFor(() => expect(w.ret(3)).toBeDefined());
    const want = { code: 'E_RATE_LIMITED', detail: '', status: 429, retryAfterMs: 4200 };
    expect(w.ret(3)).toEqual({ t: 'ret', id: 3, ok: false, error: want });
    expect(w.account()?.error).toEqual(want);
    expect(w.account()?.phase).toBe('signup-keys');
    expect(w.account()?.recoveryKey).toHaveLength(13);
  });

  it('a sync error keeps its code', async () => {
    const w = world();
    await toReady(w);
    w.sync.openChannel.mockImplementationOnce(() => Promise.reject(new SyncError('E_REGISTER_RACE')));
    w.call(2, { m: 'selectCommunity', communityId: toHex(COMMUNITY) });
    await vi.waitFor(() => expect(w.ret(2)).toBeDefined());
    w.call(3, { m: 'openChannel', channelId: toHex(CHANNEL) });
    await vi.waitFor(() => expect(w.ret(3)).toBeDefined());
    expect(w.ret(3)).toEqual({ t: 'ret', id: 3, ok: false, error: { code: 'E_REGISTER_RACE', detail: '', status: 0, retryAfterMs: null } });
  });

  it('a refused resync shows not-member', async () => {
    const w = world();
    await toReady(w);
    await openGeneral(w);
    w.sync.deps!.onMembership(GROUP, 'resyncing');
    expect(w.channels()?.[0]?.group).toBe('resync');
    expect(w.timeline()?.group).toBe('resync');
    w.state.groups = [textGroup(3)];
    w.sync.deps!.onMembership(GROUP, 'not-member');
    expect(w.channels()?.[0]?.group).toBe('not-member');
    expect(w.timeline()?.group).toBe('not-member');
  });

  it('a refused resync of an active row shows not-member until a state-2 report clears it', async () => {
    const w = world();
    await toReady(w);
    await openGeneral(w);
    w.state.groups = [textGroup(2)];
    // The engine's order on a refusal before the join: resyncing, the row's snapshot (still state 2), not-member.
    w.sync.deps!.onMembership(GROUP, 'resyncing');
    w.sync.deps!.onGroupChanged(GROUP, applied(2));
    w.sync.deps!.onMembership(GROUP, 'not-member');
    expect(w.channels()?.[0]?.group).toBe('not-member');
    expect(w.timeline()?.group).toBe('not-member');
    w.sync.deps!.onGroupChanged(GROUP, applied(2));
    expect(w.channels()?.[0]?.group).toBe('active');
    expect(w.timeline()?.group).toBe('active');
  });

  it('a successful resync clears it', async () => {
    const w = world();
    await toReady(w);
    await openGeneral(w);
    w.state.groups = [textGroup(3)];
    w.sync.deps!.onMembership(GROUP, 'resyncing');
    w.sync.deps!.onMembership(GROUP, 'not-member');
    expect(w.channels()?.[0]?.group).toBe('not-member');
    w.state.groups = [textGroup(2)];
    w.sync.deps!.onGroupChanged(GROUP, applied(2));
    expect(w.channels()?.[0]?.group).toBe('active');
    expect(w.timeline()?.group).toBe('active');
    // The old refusal is forgotten: the group falling back to state 3 reads as a resync, not as not-member.
    w.state.groups = [textGroup(3)];
    w.sync.deps!.onGroupChanged(GROUP, applied(3));
    expect(w.channels()?.[0]?.group).toBe('resync');
  });

  it('the first connect shows connecting', async () => {
    const w = world();
    await toReady(w);
    expect(w.gateway.starts).toBe(1);
    expect(w.connection()?.status).toBe('offline');
    w.gateway.emit({ type: 'status', status: 'connecting', closeCode: null });
    expect(w.connection()?.status).toBe('connecting');
  });

  it('ready → waiting → connecting → ready publishes online, offline, offline, online', async () => {
    const w = world();
    await toReady(w);
    const published = (): number => w.posted.filter((m) => m.t === 'slice' && m.name === 'connection').length;
    const before = published();
    const seen: (string | undefined)[] = [];
    for (const status of ['ready', 'waiting', 'connecting', 'ready'] as const) {
      w.gateway.emit({ type: 'status', status, closeCode: status === 'waiting' ? 1006 : null });
      seen.push(w.connection()?.status);
    }
    expect(seen).toEqual(['online', 'offline', 'offline', 'online']);
    // The unchanged third value is not published again.
    expect(published() - before).toBe(3);
  });

  it("a version refusal publishes connection reason 'version' and no reconnect", async () => {
    const w = world();
    await toReady(w);
    w.gateway.emit({ type: 'status', status: 'ready', closeCode: null });
    w.gateway.emit({ type: 'ready', info: READY_INFO });
    expect(w.connection()).toEqual({ status: 'online', generation: '7' });
    const starts = w.gateway.starts;
    w.gateway.emit({ type: 'status', status: 'idle', closeCode: CLIENT_CLOSE.version });
    expect(w.connection()).toStrictEqual({ status: 'offline', generation: '7', reason: 'version' });
    await settle();
    // The controller does not start the gateway again: the refusal stands until the page is reloaded.
    expect(w.gateway.starts).toBe(starts);
    // The next connecting or online clears the reason; a plain idle never carries one.
    w.gateway.emit({ type: 'status', status: 'connecting', closeCode: null });
    expect(w.connection()).toStrictEqual({ status: 'connecting', generation: '7' });
    w.gateway.emit({ type: 'status', status: 'idle', closeCode: CLIENT_CLOSE.version });
    w.gateway.emit({ type: 'status', status: 'ready', closeCode: null });
    expect(w.connection()).toStrictEqual({ status: 'online', generation: '7' });
    w.gateway.emit({ type: 'status', status: 'idle', closeCode: null });
    expect(w.connection()).toStrictEqual({ status: 'offline', generation: '7' });
  });

  it('a request that cannot re-authenticate ends in revoked', async () => {
    const paths: string[] = [];
    const instanceAndLimits = fakeFetch(paths);
    const fetch401 = ((input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path === '/v1/communities') {
        paths.push(path);
        return Promise.resolve(cbor(['E_UNAUTHENTICATED', '', null], 401));
      }
      return instanceAndLimits(input, init);
    }) as typeof fetch;
    const w = world({ realRoutes: true, fetch: fetch401 });
    w.session.establish.mockImplementation(() => Promise.resolve(false));
    w.call(1, { m: 'start' });
    await vi.waitFor(() => expect(w.account()?.phase).toBe('revoked'));
    await settle();
    expect(paths).toContain('/v1/communities');
    expect(w.session.establish).toHaveBeenCalledTimes(1);
    expect(w.gateway.stops).toBe(1);
    expect(w.sync.stop).toHaveBeenCalledTimes(1);
    // The 401 that ended enter-ready is the revocation's consequence: no 'error' and no 'ready' after it.
    expect(w.account()?.phase).toBe('revoked');
    const phases = w.posted.filter((m): m is SliceMessage => m.t === 'slice' && m.name === 'account').map((m) => (m.value as AccountState).phase);
    expect(phases).not.toContain('ready');
    expect(phases).not.toContain('error');
  });

  it('a resumed signup whose device is refused shows revoked and deletes nothing', async () => {
    const w = world({ phase: 1 });
    w.signup.resume.mockImplementationOnce(() => Promise.resolve('revoked' as const));
    w.call(1, { m: 'start' });
    await vi.waitFor(() => expect(w.account()?.phase).toBe('revoked'));
    expect(w.signup.resume).toHaveBeenCalledTimes(1);
    expect(w.state.resets).toBe(0);
    expect(w.state.phase).toBe(1);
    expect(w.gateway.starts).toBe(0);
  });

  it('a revoked socket is re-established, or ends in revoked', async () => {
    const w = world();
    await toReady(w);
    w.gateway.emit({ type: 'revoked' });
    await vi.waitFor(() => expect(w.gateway.starts).toBe(2));
    expect(w.account()?.phase).toBe('ready');
    w.session.establish.mockImplementationOnce(() => Promise.resolve(false));
    w.gateway.emit({ type: 'revoked' });
    await vi.waitFor(() => expect(w.account()?.phase).toBe('revoked'));
    expect(w.gateway.stops).toBe(1);
    expect(w.sync.stop).toHaveBeenCalledTimes(1);
  });

  it('a spent invite is refused before anything is registered', async () => {
    const w = world({ phase: 0 });
    w.routes.getInvite.mockImplementationOnce(() => Promise.reject(refusal(410, 'E_INVITE_INVALID')));
    await toKeys(w);
    w.call(3, SUBMIT);
    await vi.waitFor(() => expect(w.ret(3)).toBeDefined());
    const want = { code: 'E_INVITE_INVALID', detail: '', status: 410, retryAfterMs: null };
    expect(w.ret(3)).toEqual({ t: 'ret', id: 3, ok: false, error: want });
    expect(w.routes.getInvite).toHaveBeenCalledWith('friends-code');
    // Signup.submit is the only caller of postAccount (L-TS-06): nothing was registered.
    expect(w.signup.submit).not.toHaveBeenCalled();
    expect(w.account()).toMatchObject({ phase: 'signup-keys', error: want });
    expect(w.account()?.recoveryKey).toHaveLength(13);
  });

  it('a server invite lands in the server', async () => {
    const w = world({ phase: 0 });
    w.routes.getInvite.mockImplementationOnce(() => Promise.resolve({ communityId: COMMUNITY, communityName: 'friends', expires: 0n }));
    await toKeys(w);
    w.call(3, SUBMIT);
    await vi.waitFor(() => expect(w.ret(3)).toBeDefined());
    expect(w.ret(3)).toEqual({ t: 'ret', id: 3, ok: true, value: { communityId: toHex(COMMUNITY), joinError: null } });
    expect(w.signup.submit).toHaveBeenCalledWith({ invite: 'friends-code', username: 'web', display: 'Web', password: null });
    expect(w.routes.joinCommunity).toHaveBeenCalledWith(COMMUNITY, 'friends-code');
    expect(w.account()?.phase).toBe('ready');
    const retAt = w.posted.findIndex((m) => m.t === 'ret' && m.id === 3);
    const listedAt = w.posted.findIndex((m) => m.t === 'slice' && m.name === 'communities' && (m.value as CommunitySummary[]).length === 1);
    expect(listedAt).toBeGreaterThan(-1);
    expect(listedAt).toBeLessThan(retAt);
    expect(w.last<CommunitySummary[]>('communities')).toEqual([{ id: toHex(COMMUNITY), name: 'friends' }]);
  });

  it('a refused join is not a failed signup', async () => {
    const w = world({ phase: 0 });
    w.routes.getInvite.mockImplementationOnce(() => Promise.resolve({ communityId: COMMUNITY, communityName: 'friends', expires: 0n }));
    w.routes.joinCommunity.mockImplementationOnce(() => Promise.reject(refusal(410, 'E_INVITE_INVALID')));
    await toKeys(w);
    w.call(3, SUBMIT);
    await vi.waitFor(() => expect(w.ret(3)).toBeDefined());
    expect(w.ret(3)).toEqual({
      t: 'ret', id: 3, ok: true,
      value: { communityId: null, joinError: { code: 'E_INVITE_INVALID', detail: '', status: 410, retryAfterMs: null } },
    });
    expect(w.account()).toMatchObject({ phase: 'ready', error: null });
  });

  it('a publish failure after registration does not return to the keys', async () => {
    const w = world({ phase: 0 });
    await toKeys(w);
    const from = w.posted.length;
    // The account exists (the core reached phase 2), then publishing the device list failed.
    w.signup.submit.mockImplementationOnce(() => { w.state.phase = 2; return Promise.reject(refusal(503, 'E_UNAVAILABLE', 1000)); });
    w.call(3, SUBMIT);
    await vi.waitFor(() => expect(w.ret(3)).toBeDefined());
    expect(w.account()?.phase).toBe('ready');
    expect(w.ret(3)).toEqual({ t: 'ret', id: 3, ok: true, value: { communityId: null, joinError: null } });
    const phases = w.posted.slice(from).filter((m): m is SliceMessage => m.t === 'slice' && m.name === 'account').map((m) => (m.value as AccountState).phase);
    expect(phases).not.toContain('signup-keys');
  });

  it('a ready after a reconnect refreshes the lists', async () => {
    const w = world();
    await toReady(w);
    await openGeneral(w);
    expect(w.routes.listCommunities).toHaveBeenCalledTimes(1);
    expect(w.routes.listChannels).toHaveBeenCalledTimes(2);
    expect(w.routes.listMembers).toHaveBeenCalledTimes(2);
    w.gateway.emit({ type: 'ready', info: READY_INFO });
    await vi.waitFor(() => expect(w.routes.listMembers).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(w.routes.listChannels).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(w.routes.listDms).toHaveBeenCalledTimes(2));
    expect(w.routes.listCommunities).toHaveBeenCalledTimes(2);
    expect(w.routes.listChannels).toHaveBeenLastCalledWith(COMMUNITY);
    expect(w.connection()?.generation).toBe('7');
  });

  it('a member who joined later gets a name', async () => {
    const w = world();
    await toReady(w);
    await openGeneral(w);
    expect(w.routes.listMembers).toHaveBeenCalledTimes(2);
    w.state.rows = [strangerRow(1)];
    w.sync.deps!.onGroupChanged(GROUP, applied(2));
    await vi.waitFor(() => expect(w.routes.listMembers).toHaveBeenCalledTimes(3));
    expect(w.routes.listMembers).toHaveBeenLastCalledWith(COMMUNITY);
    w.state.rows = [strangerRow(1), strangerRow(2)];
    w.sync.deps!.onGroupChanged(GROUP, applied(2));
    await settle();
    expect(w.routes.listMembers).toHaveBeenCalledTimes(3);
    expect(w.timeline()?.items.map((i) => i.body)).toEqual(['from a stranger 1', 'from a stranger 2']);
  });
});

// ---- Pre-flight ruling 1: the command edge cases, one test each. ----

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function selectFriends(w: World, id: number): Promise<void> {
  w.call(id, { m: 'selectCommunity', communityId: toHex(COMMUNITY) });
  await vi.waitFor(() => expect(w.ret(id)).toEqual({ t: 'ret', id, ok: true, value: null }));
}

describe('Controller command edge cases', () => {
  it('(i) a second openChannel of a channel whose open is in flight awaits the first', async () => {
    const w = world();
    await toReady(w);
    await selectFriends(w, 2);
    const join = deferred<{ groupId: typeof GROUP; state: 2 }>();
    w.sync.openChannel.mockImplementationOnce(() => join.promise);
    w.call(3, { m: 'openChannel', channelId: toHex(CHANNEL) });
    w.call(4, { m: 'openChannel', channelId: toHex(CHANNEL) });
    await settle();
    expect(w.sync.openChannel).toHaveBeenCalledTimes(1);
    expect(w.ret(3)).toBeUndefined();
    expect(w.ret(4)).toBeUndefined();
    w.state.groups = [textGroup(2)];
    join.resolve({ groupId: GROUP, state: 2 });
    await vi.waitFor(() => expect(w.ret(4)).toEqual({ t: 'ret', id: 4, ok: true, value: null }));
    expect(w.ret(3)).toEqual({ t: 'ret', id: 3, ok: true, value: null });
    expect(w.sync.openChannel).toHaveBeenCalledTimes(1);
    expect(w.timeline()?.group).toBe('active');
  });

  it('(ii) closeChannel during an open refreshes the slices when the join resolves but does not re-open the channel', async () => {
    const w = world();
    await toReady(w);
    await selectFriends(w, 2);
    const join = deferred<{ groupId: typeof GROUP; state: 2 }>();
    w.sync.openChannel.mockImplementationOnce(() => join.promise);
    w.call(3, { m: 'openChannel', channelId: toHex(CHANNEL) });
    await vi.waitFor(() => expect(w.sync.openChannel).toHaveBeenCalledTimes(1));
    expect(w.timeline()?.group).toBe('none');
    w.call(4, { m: 'closeChannel', channelId: toHex(CHANNEL) });
    await vi.waitFor(() => expect(w.ret(4)).toEqual({ t: 'ret', id: 4, ok: true, value: null }));
    w.state.groups = [textGroup(2)];
    w.state.rows = [strangerRow(1)];
    join.resolve({ groupId: GROUP, state: 2 });
    await vi.waitFor(() => expect(w.ret(3)).toEqual({ t: 'ret', id: 3, ok: true, value: null }));
    expect(w.channels()?.[0]?.group).toBe('active');
    expect(w.timeline()).toMatchObject({ group: 'active', items: [{ body: 'from a stranger 1' }] });
    // Not open: a later change of the group leaves the timeline as it was, and sending is refused.
    w.state.rows = [strangerRow(1), strangerRow(2)];
    w.sync.deps!.onGroupChanged(GROUP, applied(2));
    expect(w.timeline()?.items).toHaveLength(1);
    w.call(5, { m: 'send', channelId: toHex(CHANNEL), text: 'hello' });
    await vi.waitFor(() => expect(w.ret(5)).toBeDefined());
    expect(w.ret(5)).toMatchObject({ ok: false, error: { code: 'E_NOT_READY' } });
    expect(w.sync.sendRequest).not.toHaveBeenCalled();
  });

  it('(i)+(ii) an open, a close and a reopen while the join is in flight leave the channel open', async () => {
    const w = world();
    await toReady(w);
    await selectFriends(w, 2);
    const join = deferred<{ groupId: typeof GROUP; state: 2 }>();
    w.sync.openChannel.mockImplementationOnce(() => join.promise);
    w.call(3, { m: 'openChannel', channelId: toHex(CHANNEL) });
    await vi.waitFor(() => expect(w.sync.openChannel).toHaveBeenCalledTimes(1));
    w.call(4, { m: 'closeChannel', channelId: toHex(CHANNEL) });
    await vi.waitFor(() => expect(w.ret(4)).toEqual({ t: 'ret', id: 4, ok: true, value: null }));
    w.call(5, { m: 'openChannel', channelId: toHex(CHANNEL) });
    await settle();
    expect(w.ret(5)).toBeUndefined();
    w.state.groups = [textGroup(2)];
    w.state.rows = [strangerRow(1)];
    join.resolve({ groupId: GROUP, state: 2 });
    await vi.waitFor(() => expect(w.ret(5)).toEqual({ t: 'ret', id: 5, ok: true, value: null }));
    expect(w.ret(3)).toEqual({ t: 'ret', id: 3, ok: true, value: null });
    expect(w.sync.openChannel).toHaveBeenCalledTimes(1);
    expect(w.timeline()).toMatchObject({ group: 'active', items: [{ body: 'from a stranger 1' }] });
    // Open again: a later change of the group refreshes the timeline, and sending is accepted.
    w.state.rows = [strangerRow(1), strangerRow(2)];
    w.sync.deps!.onGroupChanged(GROUP, applied(2));
    expect(w.timeline()?.items.map((i) => i.body)).toEqual(['from a stranger 1', 'from a stranger 2']);
    w.sync.sendRequest.mockReturnValueOnce(new Uint8Array(16).fill(0x77));
    w.call(6, { m: 'send', channelId: toHex(CHANNEL), text: 'hello' });
    await vi.waitFor(() => expect(w.ret(6)).toBeDefined());
    expect(w.ret(6)).toEqual({ t: 'ret', id: 6, ok: true, value: { msgId: '77'.repeat(16) } });
    expect(w.sync.sendRequest).toHaveBeenCalledWith(GROUP, { type: 0, replyTo: null, body: 'hello', attachments: [] });
  });

  it('(i)+(ii) a reopen while the join is in flight leaves the channel closed when the join fails', async () => {
    const w = world();
    await toReady(w);
    await selectFriends(w, 2);
    const join = deferred<{ groupId: typeof GROUP; state: 2 }>();
    w.sync.openChannel.mockImplementationOnce(() => join.promise);
    w.call(3, { m: 'openChannel', channelId: toHex(CHANNEL) });
    await vi.waitFor(() => expect(w.sync.openChannel).toHaveBeenCalledTimes(1));
    w.call(4, { m: 'closeChannel', channelId: toHex(CHANNEL) });
    await vi.waitFor(() => expect(w.ret(4)).toEqual({ t: 'ret', id: 4, ok: true, value: null }));
    w.call(5, { m: 'openChannel', channelId: toHex(CHANNEL) });
    await settle();
    // The group is active locally, so only the missing open mark can refuse the send below.
    w.state.groups = [textGroup(2)];
    join.reject(new SyncError('E_REGISTER_RACE'));
    const failed = { code: 'E_REGISTER_RACE', detail: '', status: 0, retryAfterMs: null };
    await vi.waitFor(() => expect(w.ret(5)).toEqual({ t: 'ret', id: 5, ok: false, error: failed }));
    expect(w.ret(3)).toEqual({ t: 'ret', id: 3, ok: false, error: failed });
    w.call(6, { m: 'send', channelId: toHex(CHANNEL), text: 'hello' });
    await vi.waitFor(() => expect(w.ret(6)).toBeDefined());
    expect(w.ret(6)).toMatchObject({ ok: false, error: { code: 'E_NOT_READY', detail: 'the channel is not open' } });
    expect(w.sync.sendRequest).not.toHaveBeenCalled();
  });

  it('(iii) loadEarlier and closeChannel of a channel that is not open resolve null and publish nothing', async () => {
    const w = world();
    await toReady(w);
    await selectFriends(w, 2);
    const from = w.posted.length;
    w.call(3, { m: 'loadEarlier', channelId: toHex(CHANNEL) });
    w.call(4, { m: 'closeChannel', channelId: toHex(CHANNEL) });
    w.call(5, { m: 'loadEarlier', channelId: 'e'.repeat(32) });
    await vi.waitFor(() => expect(w.ret(5)).toBeDefined());
    for (const id of [3, 4, 5]) expect(w.ret(id)).toEqual({ t: 'ret', id, ok: true, value: null });
    expect(w.posted.slice(from).filter((m) => m.t === 'slice')).toEqual([]);
  });

  it('(iv) retrySend and discardSend of an unknown message resolve null and touch nothing', async () => {
    const w = world();
    await toReady(w);
    await openGeneral(w);
    w.call(4, { m: 'retrySend', msgId: 'd'.repeat(32) });
    w.call(5, { m: 'discardSend', msgId: 'd'.repeat(32) });
    await vi.waitFor(() => expect(w.ret(5)).toBeDefined());
    expect(w.ret(4)).toEqual({ t: 'ret', id: 4, ok: true, value: null });
    expect(w.ret(5)).toEqual({ t: 'ret', id: 5, ok: true, value: null });
    expect(w.sync.retry).not.toHaveBeenCalled();
    expect(w.sync.discard).not.toHaveBeenCalled();
  });

  it('(v) selectCommunity of a community that is not listed is refused', async () => {
    const w = world();
    await toReady(w);
    w.call(2, { m: 'selectCommunity', communityId: 'e'.repeat(32) });
    await vi.waitFor(() => expect(w.ret(2)).toBeDefined());
    expect(w.ret(2)).toEqual({ t: 'ret', id: 2, ok: false, error: { code: 'E_BAD_INPUT', detail: 'unknown community', status: 0, retryAfterMs: null } });
    expect(w.routes.listChannels).toHaveBeenCalledTimes(1);
    expect(w.routes.listMembers).toHaveBeenCalledTimes(1);
  });

  it('(vi) a selected community that is no longer listed is dropped with its slices', async () => {
    const w = world();
    await toReady(w);
    await openGeneral(w);
    const members = () => w.last<MemberSummary[]>(`members:${toHex(COMMUNITY)}`);
    expect(members()).toHaveLength(1);
    w.state.joined = false;
    w.gateway.emit({ type: 'ready', info: READY_INFO });
    await vi.waitFor(() => expect(w.last<CommunitySummary[]>('communities')).toEqual([]));
    await settle();
    expect(w.channels()).toEqual([]);
    expect(members()).toEqual([]);
    expect(w.sync.setExpected).toHaveBeenLastCalledWith([]);
    expect(w.routes.listChannels).toHaveBeenCalledTimes(2);
    // Nothing is selected any more: the next ready reads no channel list, and a send to its channel is refused.
    w.gateway.emit({ type: 'ready', info: READY_INFO });
    await vi.waitFor(() => expect(w.routes.listCommunities).toHaveBeenCalledTimes(3));
    await settle();
    expect(w.routes.listChannels).toHaveBeenCalledTimes(2);
    w.call(4, { m: 'send', channelId: toHex(CHANNEL), text: 'hello' });
    await vi.waitFor(() => expect(w.ret(4)).toBeDefined());
    expect(w.ret(4)).toMatchObject({ ok: false, error: { code: 'E_NOT_READY' } });
  });

  it('(vii) a join whose community list refresh fails still resolves the community', async () => {
    const w = world();
    await toReady(w);
    w.routes.getInvite.mockImplementationOnce(() => Promise.resolve({ communityId: COMMUNITY, communityName: 'friends', expires: 0n }));
    w.routes.listCommunities.mockImplementationOnce(() => Promise.reject(refusal(503, 'E_UNAVAILABLE', 1000)));
    w.call(2, { m: 'joinCommunity', invite: '  friends-code  ' });
    await vi.waitFor(() => expect(w.ret(2)).toBeDefined());
    expect(w.ret(2)).toEqual({ t: 'ret', id: 2, ok: true, value: { communityId: toHex(COMMUNITY) } });
    expect(w.routes.getInvite).toHaveBeenCalledWith('friends-code');
    expect(w.routes.joinCommunity).toHaveBeenCalledWith(COMMUNITY, 'friends-code');
  });

  it('(viii) a network failure while entering ready at boot is the error phase', async () => {
    const w = world();
    const down = new DillaHttpError({ status: 0, code: 'E_NETWORK', detail: 'fetch failed', retryAfterMs: null, extra: [] });
    w.session.ensure.mockImplementationOnce(() => Promise.reject(down));
    w.call(1, { m: 'start' });
    await vi.waitFor(() => expect(w.account()?.phase).toBe('error'));
    expect(w.account()?.error).toEqual({ code: 'E_NETWORK', detail: 'fetch failed', status: 0, retryAfterMs: null });
    expect(w.gateway.starts).toBe(0);
    w.call(2, { m: 'selectCommunity', communityId: toHex(COMMUNITY) });
    await vi.waitFor(() => expect(w.ret(2)).toBeDefined());
    expect(w.ret(2)).toMatchObject({ ok: false, error: { code: 'E_NOT_READY', detail: 'the phase is error' } });
  });
});

const act = (g: Uint8Array, unread: number, mentions: number): ActivityRow =>
  ({ groupId: g, unread, mentions, lastSeq: BigInt(unread), lastTs: NOW_S, lastReadSeq: 0n });
const appliedSeqs = (seqs: bigint[]): ApplyResult =>
  ({ state: 2, epoch: 2n, nextSeq: (seqs.at(-1) ?? 0n) + 1n, newSeqs: seqs, proposalsPending: 0, epochChanged: false, ownAdopted: false });
const phasesOf = (w: World): string[] =>
  w.posted.filter((m): m is SliceMessage => m.t === 'slice' && m.name === 'account').map((m) => (m.value as AccountState).phase);

/** The login as the page sends it: the recovery key, entered first, travels with it (coordinator ruling on
 *  REGISTRATION-DEVICES-02's concern 3). */
const LOGIN = { m: 'signInLogin', username: ' web ', password: PASSWORD, recoveryKey: RECOVERY_KEY } as const;

/** From needs-signup through signInBegin (id 2) to signin-login, nothing sent to the instance yet. */
async function toLoginStep(w: World): Promise<void> {
  w.call(1, { m: 'start' });
  await vi.waitFor(() => expect(w.account()?.phase).toBe('needs-signup'));
  w.call(2, { m: 'signInBegin' });
  await vi.waitFor(() => expect(w.ret(2)).toEqual({ t: 'ret', id: 2, ok: true, value: null }));
}

/** toLoginStep, then the login with the key (id 3), answered. */
async function toKeyStep(w: World): Promise<void> {
  await toLoginStep(w);
  w.call(3, LOGIN);
  await vi.waitFor(() => expect(w.ret(3)).toBeDefined());
}

// Attacker statements (lesson e) for the refusals these blocks test, from the brief's requirements:
// - E_BAD_INPUT / E_NOT_READY are raised only for the owning page's own malformed or mistimed command; the worker
//   answers only its own page (deps.post), so no other party can trigger or observe them.
// - A refused TOTP or E_NO_ASSERTION: only the instance (it can always refuse service) or a password holder racing
//   the login (one assertion per login) can cause it; the person logs in again with the username kept, nothing stored.
// - A refused registration (403 device cap, a short meter 429): past the cap or rate the instance replaces the oldest
//   unlisted row, so a password holder cannot keep the owner out; the 403 only the owner's own list produces.
// - E_SESSION_SCOPE / E_DEVICE_UNLISTED in phase 2: a hostile or broken instance; the worst is this browser showing
//   revoked with its store untouched.
// - E_NO_BACKUP / E_LIST_RACE on a revocation: an instance withholding objects (denial of service it can always do)
//   or a concurrent publication by another device of the same user, cured by repeating the command; a missing state
//   object is no refusal (ruling 28). The key-less DELETE removes only a row no unrevoked entry names, decided from a
//   freshly refreshed own list (pre-flight ruling b); another user's row answers 404.
// - wiping/storeCleared are set only by this page's own signOutRevoke/forgetBrowser or E_LIST_RACE during its own
//   enrolment; a refused server call clears wiping before the command rejects.
// - E_SETTING_KEY: only the owning page reaches it; it keeps the settings table from becoming a general store.
// - Pre-flight rulings (c) and (e): an older served list or an unusable state object is the instance serving stale or
//   withheld backups; the client retries once (a list PUT racing the read), then shows the conflict or the missing
//   backup and signs nothing.

describe('Controller sign-in (L-TS-23)', () => {
  // REGISTRATION-DEVICES-02 and the coordinator's ruling on its concern 3: the key is entered first and its form
  // checked before the login is sent; the login's assertion is then spent at once by the registration, the fetch,
  // the enrolment and the list PUT, back to back.
  it('signs in without a second factor: the key\'s form, then the login, register, fetch and enrol back to back, then ready', async () => {
    const w = world({ phase: 0 });
    await toLoginStep(w);
    expect(w.account()).toMatchObject({ phase: 'signin-login', signIn: { username: null, needsTotp: false }, error: null });
    expect(w.calls.filter((c) => c.startsWith('enrol.'))).toEqual([]);
    w.call(3, LOGIN);
    await vi.waitFor(() => expect(w.ret(3)).toEqual({ t: 'ret', id: 3, ok: true, value: { needsTotp: false } }));
    expect(w.core.recoveryKeyCheck).toHaveBeenCalledWith(RECOVERY_KEY);
    expect(w.enrol.login).toHaveBeenCalledWith('web', PASSWORD);
    expect(w.enrol.register).toHaveBeenCalledWith(INSTANCE_ID);
    expect(w.enrol.fetch).toHaveBeenCalledWith(USER);
    expect(w.calls.filter((c) => c.startsWith('enrol.') || c === 'core.recoveryKeyCheck')).toEqual([
      'core.recoveryKeyCheck', 'enrol.login', 'enrol.register', 'enrol.fetch', 'enrol.complete',
    ]);
    expect(w.enrol.complete).toHaveBeenCalledWith(RECOVERY_KEY, FETCHED, 'web');
    expect(w.account()).toMatchObject({ phase: 'ready', user: { id: toHex(USER), username: 'web' }, deviceId: toHex(DEVICE), signIn: null, error: null });
    const phases = phasesOf(w);
    expect(phases).not.toContain('signin-key');
    expect(phases.indexOf('ready')).toBeGreaterThan(phases.indexOf('enrolling'));
  });

  it('asks for the second factor when the login needs one', async () => {
    const w = world({ phase: 0 });
    w.enrol.login.mockImplementationOnce(() => { w.calls.push('enrol.login'); return Promise.resolve({ needsTotp: true }); });
    await toKeyStep(w);
    expect(w.ret(3)).toEqual({ t: 'ret', id: 3, ok: true, value: { needsTotp: true } });
    expect(w.account()).toMatchObject({ phase: 'signin-totp', signIn: { username: 'web', needsTotp: true } });
    expect(w.enrol.register).not.toHaveBeenCalled();
    w.call(4, { m: 'signInTotp', code: '12345', recoveryKey: RECOVERY_KEY });
    await vi.waitFor(() => expect(w.ret(4)).toBeDefined());
    expect(w.ret(4)).toMatchObject({ ok: false, error: { code: 'E_BAD_INPUT', detail: 'code is not six digits' } });
    w.call(5, { m: 'signInTotp', code: '123456', recoveryKey: '' });
    await vi.waitFor(() => expect(w.ret(5)).toBeDefined());
    expect(w.ret(5)).toMatchObject({ ok: false, error: { code: 'E_BAD_INPUT', detail: 'the recovery key is empty' } });
    w.call(6, { m: 'signInTotp', code: '123456', recoveryKey: RECOVERY_KEY });
    await vi.waitFor(() => expect(w.ret(6)).toEqual({ t: 'ret', id: 6, ok: true, value: null }));
    expect(w.enrol.totp).toHaveBeenCalledWith('123456');
    expect(w.calls.filter((c) => c.startsWith('enrol.'))).toEqual(['enrol.login', 'enrol.totp', 'enrol.register', 'enrol.fetch', 'enrol.complete']);
    expect(w.account()?.phase).toBe('ready');
  });

  it('a refused login stays at the login step with the error', async () => {
    const w = world({ phase: 0 });
    w.enrol.login.mockImplementationOnce(() => Promise.reject(refusal(401, 'E_UNAUTHENTICATED')));
    await toKeyStep(w);
    const want = { code: 'E_UNAUTHENTICATED', detail: '', status: 401, retryAfterMs: null };
    expect(w.ret(3)).toEqual({ t: 'ret', id: 3, ok: false, error: want });
    expect(w.account()).toMatchObject({ phase: 'signin-login', error: want });
    expect(w.enrol.register).not.toHaveBeenCalled();
  });

  it('a 429 from the login stays E_RATE_LIMITED', async () => {
    const w = world({ phase: 0 });
    w.enrol.login.mockImplementationOnce(() => Promise.reject(refusal(429, 'E_RATE_LIMITED', 5_000)));
    await toKeyStep(w);
    expect(w.ret(3)).toEqual({ t: 'ret', id: 3, ok: false, error: { code: 'E_RATE_LIMITED', detail: '', status: 429, retryAfterMs: 5_000 } });
    expect(w.account()).toMatchObject({ phase: 'signin-login', error: { code: 'E_RATE_LIMITED' } });
  });

  it('a register refused at the device cap keeps the enrol record and returns to the login step with the 403', async () => {
    const w = world({ phase: 0 });
    w.enrol.register.mockImplementationOnce(() => { w.state.phase = 3; return Promise.reject(refusal(403, 'E_FORBIDDEN')); });
    await toLoginStep(w);
    w.call(4, LOGIN);
    await vi.waitFor(() => expect(w.ret(4)).toBeDefined());
    expect(w.ret(4)).toEqual({ t: 'ret', id: 4, ok: false, error: { code: 'E_FORBIDDEN', detail: '', status: 403, retryAfterMs: null } });
    expect(w.enrol.fetch).not.toHaveBeenCalled();
    expect(w.enrol.reset).not.toHaveBeenCalled();
    expect(w.core.identity().phase).toBe(3);
    expect(w.account()).toMatchObject({ phase: 'signin-login', signIn: { username: 'web', needsTotp: false }, error: { code: 'E_FORBIDDEN', status: 403 } });
    // Once a device was removed elsewhere, the next login (with the key) registers the kept enrolment again.
    w.call(5, LOGIN);
    await vi.waitFor(() => expect(w.ret(5)).toEqual({ t: 'ret', id: 5, ok: true, value: { needsTotp: false } }));
    expect(w.enrol.register).toHaveBeenCalledTimes(2);
    expect(w.account()?.phase).toBe('ready');
  });

  // Head ruling 38 as amended: registration answers no per-user 429, so there is no E_ENROL_RATE; the establish
  // meter's short 429 crosses as E_RATE_LIMITED like the login's.
  it('a 429 from register crosses as E_RATE_LIMITED with its retry and keeps the enrol record', async () => {
    const w = world({ phase: 0 });
    w.enrol.register.mockImplementationOnce(() => { w.state.phase = 3; return Promise.reject(refusal(429, 'E_RATE_LIMITED', 1_000)); });
    await toLoginStep(w);
    w.call(4, LOGIN);
    await vi.waitFor(() => expect(w.ret(4)).toBeDefined());
    const want = { code: 'E_RATE_LIMITED', detail: '', status: 429, retryAfterMs: 1_000 };
    expect(w.ret(4)).toEqual({ t: 'ret', id: 4, ok: false, error: want });
    expect(w.account()).toMatchObject({ phase: 'signin-login', error: want });
    expect(w.enrol.reset).not.toHaveBeenCalled();
    expect(w.core.identity().phase).toBe(3);
  });

  it('a refused TOTP returns to signin-login with the username kept', async () => {
    const w = world({ phase: 0 });
    w.enrol.login.mockImplementationOnce(() => { w.calls.push('enrol.login'); return Promise.resolve({ needsTotp: true }); });
    w.enrol.totp.mockImplementationOnce(() => Promise.reject(refusal(401, 'E_UNAUTHENTICATED')));
    await toKeyStep(w);
    expect(w.account()?.phase).toBe('signin-totp');
    w.call(4, { m: 'signInTotp', code: '123456', recoveryKey: RECOVERY_KEY });
    await vi.waitFor(() => expect(w.ret(4)).toBeDefined());
    const want = { code: 'E_UNAUTHENTICATED', detail: '', status: 401, retryAfterMs: null };
    expect(w.ret(4)).toEqual({ t: 'ret', id: 4, ok: false, error: want });
    expect(w.account()).toMatchObject({ phase: 'signin-login', signIn: { username: 'web', needsTotp: false }, error: want });
    expect(w.enrol.register).not.toHaveBeenCalled();
    w.call(5, { m: 'signInTotp', code: '123456', recoveryKey: RECOVERY_KEY });
    await vi.waitFor(() => expect(w.ret(5)).toBeDefined());
    expect(w.ret(5)).toMatchObject({ ok: false, error: { code: 'E_NOT_READY', detail: 'the phase is signin-login' } });
    expect(w.enrol.totp).toHaveBeenCalledTimes(1);
  });

  it('a second factor without a held assertion crosses as E_NO_ASSERTION and returns to signin-login', async () => {
    const w = world({ phase: 0 });
    w.enrol.login.mockImplementationOnce(() => { w.calls.push('enrol.login'); return Promise.resolve({ needsTotp: true }); });
    w.enrol.totp.mockImplementationOnce(() => Promise.reject(new Error('E_NO_ASSERTION')));
    await toKeyStep(w);
    w.call(4, { m: 'signInTotp', code: '123456', recoveryKey: RECOVERY_KEY });
    await vi.waitFor(() => expect(w.ret(4)).toBeDefined());
    const want = { code: 'E_NO_ASSERTION', detail: '', status: 0, retryAfterMs: null };
    expect(w.ret(4)).toEqual({ t: 'ret', id: 4, ok: false, error: want });
    expect(w.account()).toMatchObject({ phase: 'signin-login', signIn: { username: 'web', needsTotp: false }, error: want });
  });

  it('a boot in phase 3 whose backup is missing publishes signin-key with E_NO_BACKUP', async () => {
    const w = world({ phase: 3, enrolUser: true });
    w.enrol.fetch.mockImplementationOnce(() => Promise.reject(new Error('E_NO_BACKUP')));
    w.call(1, { m: 'start' });
    await vi.waitFor(() => expect(w.account()?.phase).toBe('signin-key'));
    expect(w.account()?.error).toEqual({ code: 'E_NO_BACKUP', detail: '', status: 0, retryAfterMs: null });
    expect(w.enrol.reset).not.toHaveBeenCalled();
  });

  it('a missing backup keeps the key step with the error, and the key reads the backups again without registering again', async () => {
    const w = world({ phase: 0 });
    w.enrol.fetch.mockImplementationOnce(() => Promise.reject(new Error('E_NO_BACKUP')));
    await toLoginStep(w);
    w.call(4, LOGIN);
    await vi.waitFor(() => expect(w.ret(4)).toBeDefined());
    expect(w.ret(4)).toEqual({ t: 'ret', id: 4, ok: false, error: { code: 'E_NO_BACKUP', detail: '', status: 0, retryAfterMs: null } });
    expect(w.account()).toMatchObject({ phase: 'signin-key', error: { code: 'E_NO_BACKUP' } });
    w.call(5, { m: 'signInKey', recoveryKey: RECOVERY_KEY });
    await vi.waitFor(() => expect(w.ret(5)).toEqual({ t: 'ret', id: 5, ok: true, value: null }));
    expect(w.enrol.register).toHaveBeenCalledTimes(1);
    expect(w.enrol.fetch).toHaveBeenCalledTimes(2);
    expect(w.calls.filter((c) => c.startsWith('enrol.')).slice(-2)).toEqual(['enrol.fetch', 'enrol.complete']);
    expect(w.account()?.phase).toBe('ready');
  });

  it('a wrong recovery key returns to the key step and keeps the enrolment', async () => {
    const w = world({ phase: 0 });
    w.enrol.complete.mockImplementationOnce(() => Promise.reject(new CoreError('E_RECOVERY_KEY', '')));
    await toLoginStep(w);
    w.call(4, LOGIN);
    await vi.waitFor(() => expect(w.ret(4)).toBeDefined());
    expect(w.ret(4)).toEqual({ t: 'ret', id: 4, ok: false, error: { code: 'E_RECOVERY_KEY', detail: '', status: 0, retryAfterMs: null } });
    expect(w.account()).toMatchObject({ phase: 'signin-key', error: { code: 'E_RECOVERY_KEY' } });
    expect(w.enrol.reset).not.toHaveBeenCalled();
    expect(w.state.phase).toBe(3);
    w.call(5, { m: 'signInKey', recoveryKey: RECOVERY_KEY });
    await vi.waitFor(() => expect(w.ret(5)).toEqual({ t: 'ret', id: 5, ok: true, value: null }));
    expect(w.enrol.register).toHaveBeenCalledTimes(1);
    expect(w.enrol.fetch).toHaveBeenCalledTimes(1);
  });

  it('the login is sent only once the key is held: a malformed key is refused before the login, which then mints its assertion seconds before the registration', async () => {
    const w = world({ phase: 0 });
    w.enrol.login.mockImplementationOnce(() => { w.calls.push('enrol.login'); return Promise.resolve({ needsTotp: true }); });
    await toLoginStep(w);
    w.core.recoveryKeyCheck.mockImplementationOnce(() => { w.calls.push('core.recoveryKeyCheck'); throw new CoreError('E_RECOVERY_KEY', ''); });
    w.call(3, { ...LOGIN, recoveryKey: 'Z'.repeat(52) });
    await vi.waitFor(() => expect(w.ret(3)).toBeDefined());
    expect(w.ret(3)).toEqual({ t: 'ret', id: 3, ok: false, error: { code: 'E_RECOVERY_KEY', detail: '', status: 0, retryAfterMs: null } });
    expect(w.account()).toMatchObject({ phase: 'signin-login', error: { code: 'E_RECOVERY_KEY' } });
    expect(w.enrol.login).not.toHaveBeenCalled();
    w.call(4, LOGIN);
    await vi.waitFor(() => expect(w.ret(4)).toEqual({ t: 'ret', id: 4, ok: true, value: { needsTotp: true } }));
    expect(w.enrol.register).not.toHaveBeenCalled();
    w.call(5, { m: 'signInTotp', code: '123456', recoveryKey: RECOVERY_KEY });
    await vi.waitFor(() => expect(w.ret(5)).toEqual({ t: 'ret', id: 5, ok: true, value: null }));
    expect(w.calls.filter((c) => c.startsWith('enrol.') || c === 'core.recoveryKeyCheck')).toEqual([
      'core.recoveryKeyCheck', 'core.recoveryKeyCheck', 'enrol.login', 'core.recoveryKeyCheck', 'enrol.totp',
      'enrol.register', 'enrol.fetch', 'enrol.complete',
    ]);
  });

  it('a row evicted before the enrolment was written: the fetch answers 401, the enrolment is dropped and step 1 says why', async () => {
    const w = world({ phase: 0 });
    w.enrol.fetch.mockImplementationOnce(() => Promise.reject(refusal(401, 'E_UNAUTHENTICATED')));
    await toLoginStep(w);
    w.call(4, LOGIN);
    await vi.waitFor(() => expect(w.ret(4)).toBeDefined());
    const want = { code: 'E_SIGNIN_EVICTED', detail: '', status: 0, retryAfterMs: null };
    expect(w.ret(4)).toEqual({ t: 'ret', id: 4, ok: false, error: want });
    expect(w.enrol.reset).toHaveBeenCalledTimes(1);
    expect(w.account()).toMatchObject({ phase: 'signin-login', signIn: { username: 'web', needsTotp: false }, error: want });
    expect(phasesOf(w)).not.toContain('revoked');
  });

  it('a row evicted after the enrolment was written: the store is wiped to cleared with E_SIGNIN_EVICTED, never revoked', async () => {
    const w = world({ phase: 0 });
    w.enrol.complete.mockImplementationOnce(() => { w.state.phase = 2; return Promise.reject(new Error('E_SIGNIN_EVICTED')); });
    await toLoginStep(w);
    w.call(4, LOGIN);
    await vi.waitFor(() => expect(w.ret(4)).toBeDefined());
    const want = { code: 'E_SIGNIN_EVICTED', detail: '', status: 0, retryAfterMs: null };
    expect(w.ret(4)).toEqual({ t: 'ret', id: 4, ok: false, error: want });
    expect(w.wiped).toEqual([INSTANCE_HEX]);
    expect(w.account()).toMatchObject({ phase: 'cleared', error: want });
    expect(phasesOf(w)).not.toContain('revoked');
  });

  it('a 401 on the list PUT and on its re-establish during the enrolment is the eviction, not a revocation', async () => {
    const paths: string[] = [];
    const base = fakeFetch(paths);
    const user = toHex(USER);
    const evicting = ((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      paths.push(`${request.method} ${path}`);
      if (path === '/v1/backups/0/0') return Promise.resolve(cbor([ROOT, 1]));
      if (path === '/v1/backups/1/0') return Promise.resolve(cbor([STATE_OBJECT, 1]));
      if (path === `/v1/users/${user}/device-list` && request.method === 'GET') return Promise.resolve(cbor([1, new Uint8Array([9]), new Uint8Array(64), new Uint8Array(32)]));
      if (path.endsWith('/sessions/challenge')) return Promise.resolve(cbor([new Uint8Array(32), 1_700_000_060], 201));
      if (path === `/v1/users/${user}/device-list` || path.endsWith('/sessions')) return Promise.resolve(cbor(['E_UNAUTHENTICATED', '', null], 401));
      return base(input, init);
    }) as typeof fetch;
    const w = world({ phase: 3, enrolUser: true, realRoutes: true, realAccount: true, fetch: evicting });
    w.state.session = { token: 'pending', expires: NOW_S + 604_800n, idleExpires: NOW_S + 43_200n };
    w.call(1, { m: 'start' });
    await vi.waitFor(() => expect(w.account()?.phase).toBe('signin-key'));
    w.call(2, { m: 'signInKey', recoveryKey: RECOVERY_KEY });
    await vi.waitFor(() => expect(w.ret(2)).toBeDefined());
    const want = { code: 'E_SIGNIN_EVICTED', detail: '', status: 0, retryAfterMs: null };
    expect(w.ret(2)).toEqual({ t: 'ret', id: 2, ok: false, error: want });
    expect(paths).toContain(`PUT /v1/users/${user}/device-list`);
    expect(paths.filter((p) => p.endsWith('/sessions') && p.startsWith('POST')).length).toBeGreaterThanOrEqual(1);
    expect(w.account()).toMatchObject({ phase: 'cleared', error: want });
    expect(phasesOf(w)).not.toContain('revoked');
  });

  /** Fix-wave review NEW-1: another enrolled session cuts this browser's pending session after enrolComplete, before
   *  the list PUT. The row is live and unlisted, so the re-establish answers a pending scope; while the own list is
   *  unpublished that is this enrolment's own session, never a revocation. `cuts` is how many list PUTs answer 401. */
  function cutDuringEnrolment(cuts: number) {
    const paths: string[] = [];
    const base = fakeFetch(paths);
    const user = toHex(USER);
    let left = cuts;
    let published = false;
    const cutting = ((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      paths.push(`${request.method} ${path}`);
      const list = `/v1/users/${user}/device-list`;
      if (path === '/v1/backups/0/0') return Promise.resolve(cbor([ROOT, 1]));
      if (path === '/v1/backups/1/0' && request.method === 'GET') return Promise.resolve(cbor([STATE_OBJECT, 1]));
      if (path === '/v1/backups/1/0') return Promise.resolve(cbor([new Uint8Array(32), 3]));
      if (path === list && request.method === 'GET') return Promise.resolve(cbor([1, new Uint8Array([9]), new Uint8Array(64), new Uint8Array(32)]));
      if (path === list) {
        if (left > 0) { left -= 1; return Promise.resolve(cbor(['E_UNAUTHENTICATED', '', null], 401)); }
        published = true;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (path.endsWith('/sessions/challenge')) return Promise.resolve(cbor([new Uint8Array(32), 1_700_000_060], 201));
      if (path.endsWith('/sessions')) {
        // The instance enrols the session only once the list names this device; before that the row is pending.
        return Promise.resolve(cbor([published ? 'enrolled' : 'pending-again', published ? 0 : 1, USER, DEVICE,
          1_700_604_800, 1_700_043_200, 7], 201));
      }
      if (path === '/v1/accounts/me') return Promise.resolve(cbor([USER, 'web', 'Web', 0, 0]));
      if (path === '/v1/communities' || path === '/v1/dms') return Promise.resolve(cbor([]));
      return base(input, init);
    }) as typeof fetch;
    const w = world({ phase: 3, enrolUser: true, realRoutes: true, realAccount: true, fetch: cutting });
    w.state.session = { token: 'pending', expires: NOW_S + 604_800n, idleExpires: NOW_S + 43_200n };
    return { w, paths, user };
  }

  it('a pending session cut once during the enrolment re-establishes pending, publishes and reaches ready, never revoked', async () => {
    const { w, paths, user } = cutDuringEnrolment(1);
    w.call(1, { m: 'start' });
    await vi.waitFor(() => expect(w.account()?.phase).toBe('signin-key'));
    w.call(2, { m: 'signInKey', recoveryKey: RECOVERY_KEY });
    await vi.waitFor(() => expect(w.ret(2)).toBeDefined());
    expect(w.ret(2)).toEqual({ t: 'ret', id: 2, ok: true, value: null });
    expect(paths.filter((p) => p === `PUT /v1/users/${user}/device-list`)).toHaveLength(2);
    expect(w.state.session?.token).toBe('enrolled');
    expect(w.account()?.phase).toBe('ready');
    expect(phasesOf(w)).not.toContain('revoked');
  });

  it('a pending session cut again after its pending re-establish is the eviction (E_SIGNIN_EVICTED), never revoked', async () => {
    const { w, paths, user } = cutDuringEnrolment(5);
    w.call(1, { m: 'start' });
    await vi.waitFor(() => expect(w.account()?.phase).toBe('signin-key'));
    w.call(2, { m: 'signInKey', recoveryKey: RECOVERY_KEY });
    await vi.waitFor(() => expect(w.ret(2)).toBeDefined());
    const want = { code: 'E_SIGNIN_EVICTED', detail: '', status: 0, retryAfterMs: null };
    expect(w.ret(2)).toEqual({ t: 'ret', id: 2, ok: false, error: want });
    // One re-establish, one retried PUT: the second 401 is not chased further.
    expect(paths.filter((p) => p === `PUT /v1/users/${user}/device-list`)).toHaveLength(2);
    expect(paths.filter((p) => p.endsWith('/sessions') && p.startsWith('POST'))).toHaveLength(1);
    expect(w.account()).toMatchObject({ phase: 'cleared', error: want });
    expect(phasesOf(w)).not.toContain('revoked');
  });

  it('a list race wipes the store and ends in cleared; nothing reopens it in this worker', async () => {
    const w = world({ phase: 0 });
    w.enrol.complete.mockImplementationOnce(() => { w.state.phase = 2; return Promise.reject(new Error('E_LIST_RACE')); });
    await toLoginStep(w);
    w.call(4, LOGIN);
    await vi.waitFor(() => expect(w.ret(4)).toBeDefined());
    const want = { code: 'E_LIST_RACE', detail: '', status: 0, retryAfterMs: null };
    expect(w.ret(4)).toEqual({ t: 'ret', id: 4, ok: false, error: want });
    expect(w.core.pause).toHaveBeenCalledTimes(1);
    expect(w.wiped).toEqual([INSTANCE_HEX]);
    expect(w.calls.indexOf('core.pause')).toBeLessThan(w.calls.indexOf('resetDevice'));
    expect(w.account()).toMatchObject({ phase: 'cleared', user: null, deviceId: null, recoveryKey: null, signIn: null, error: want });
    w.call(5, { m: 'signInBegin' });
    w.call(6, { m: 'signupBegin' });
    await vi.waitFor(() => expect(w.ret(6)).toBeDefined());
    expect(w.ret(5)).toMatchObject({ ok: false, error: { code: 'E_NOT_READY', detail: 'the phase is cleared' } });
    expect(w.ret(6)).toMatchObject({ ok: false, error: { code: 'E_NOT_READY', detail: 'the phase is cleared' } });
  });

  it('signInCancel resets the enrolment and returns to needs-signup', async () => {
    const w = world({ phase: 0 });
    w.enrol.login.mockImplementationOnce(() => { w.calls.push('enrol.login'); return Promise.resolve({ needsTotp: true }); });
    await toKeyStep(w);
    w.call(4, { m: 'signInCancel' });
    await vi.waitFor(() => expect(w.ret(4)).toEqual({ t: 'ret', id: 4, ok: true, value: null }));
    expect(w.enrol.reset).toHaveBeenCalledTimes(1);
    expect(w.account()).toMatchObject({ phase: 'needs-signup', signIn: null, error: null });
  });

  it('a sign-in step in flight refuses a second one', async () => {
    const w = world({ phase: 0 });
    let release!: () => void;
    w.enrol.login.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ needsTotp: false }); }));
    w.call(1, { m: 'start' });
    await vi.waitFor(() => expect(w.account()?.phase).toBe('needs-signup'));
    w.call(2, { m: 'signInBegin' });
    await vi.waitFor(() => expect(w.ret(2)).toBeDefined());
    w.call(3, LOGIN);
    w.call(4, LOGIN);
    await vi.waitFor(() => expect(w.ret(4)).toBeDefined());
    expect(w.ret(4)).toMatchObject({ ok: false, error: { code: 'E_NOT_READY', detail: 'a sign-in step is running' } });
    release();
    await vi.waitFor(() => expect(w.ret(3)).toEqual({ t: 'ret', id: 3, ok: true, value: { needsTotp: false } }));
  });

  it('a boot in phase 3 with a recorded user resumes at the key step and takes the username from the account', async () => {
    const w = world({ phase: 3, enrolUser: true });
    w.state.username = '';
    w.call(1, { m: 'start' });
    await vi.waitFor(() => expect(w.account()?.phase).toBe('signin-key'));
    expect(w.enrol.fetch).toHaveBeenCalledWith(USER);
    expect(w.account()?.signIn).toEqual({ username: null, needsTotp: false });
    w.call(2, { m: 'signInKey', recoveryKey: RECOVERY_KEY });
    await vi.waitFor(() => expect(w.ret(2)).toEqual({ t: 'ret', id: 2, ok: true, value: null }));
    expect(w.enrol.complete).toHaveBeenCalledWith(RECOVERY_KEY, FETCHED, '');
    expect(w.routes.getAccountMe).toHaveBeenCalledTimes(1);
    expect(w.account()).toMatchObject({ phase: 'ready', user: { id: toHex(USER), username: 'web' } });
  });

  it('a boot in phase 3 without a recorded user resets to needs-signup', async () => {
    const w = world({ phase: 3 });
    w.call(1, { m: 'start' });
    await vi.waitFor(() => expect(w.account()?.phase).toBe('needs-signup'));
    expect(w.enrol.reset).toHaveBeenCalledTimes(1);
    expect(w.enrol.fetch).not.toHaveBeenCalled();
  });

  it('the password and the recovery key reach no slice, ret or error', async () => {
    const w = world({ phase: 0 });
    w.enrol.complete.mockImplementationOnce(() => Promise.reject(new CoreError('E_RECOVERY_KEY', '')));
    await toLoginStep(w);
    w.call(4, LOGIN);
    await vi.waitFor(() => expect(w.ret(4)).toBeDefined());
    w.call(5, { m: 'signInKey', recoveryKey: RECOVERY_KEY });
    await vi.waitFor(() => expect(w.ret(5)).toEqual({ t: 'ret', id: 5, ok: true, value: null }));
    const everything = JSON.stringify(w.posted);
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain(RECOVERY_KEY);
    expect(everything).not.toContain(RECOVERY_KEY.slice(0, 13));
  });
});

describe('Controller ready (L-TS-23, L-TS-24)', () => {
  it('enters ready in order: session, list, backups, own list, engine, gateway, every community, then the DMs', async () => {
    const w = world();
    await toReady(w);
    expect(w.calls.slice(0, 11)).toEqual([
      'session.ensure', 'publishDeviceList', 'ensureBackups', 'refreshOwnDeviceList', 'repairBackupState', 'sync.start', 'gateway.start',
      'listCommunities', 'listChannels', 'listMembers', 'listDms',
    ]);
    expect(w.session.establish).not.toHaveBeenCalled();
    expect(w.channels()).toHaveLength(1);
    expect(w.last('settings')).toEqual({});
    expect(w.notices()).toEqual({ nextId: 1, items: [] });
    expect(w.badges()).toEqual({});
  });

  it('a list unpublished at entry is followed by a fresh session', async () => {
    const w = world();
    const identity = w.core.identity;
    let published = false;
    w.core.identity = (): IdentityInfo => ({ ...identity(), listPublished: published });
    w.account.publishDeviceList.mockImplementationOnce(() => { w.calls.push('publishDeviceList'); published = true; return Promise.resolve(); });
    await toReady(w);
    expect(w.calls.slice(0, 3)).toEqual(['session.ensure', 'publishDeviceList', 'session.establish']);
  });

  it('an own list that no longer names this device ends in revoked', async () => {
    const w = world();
    w.account.refreshOwnDeviceList.mockImplementationOnce(() => Promise.resolve({ version: 3n, listed: false }));
    w.call(1, { m: 'start' });
    await vi.waitFor(() => expect(w.account()?.phase).toBe('revoked'));
    expect(w.gateway.starts).toBe(0);
    expect(phasesOf(w)).not.toContain('ready');
  });

  it('a pending scope in phase 2 is a revocation, not an error', async () => {
    const w = world();
    w.session.ensure.mockImplementationOnce(() => Promise.reject(new Error('E_SESSION_SCOPE')));
    w.call(1, { m: 'start' });
    await vi.waitFor(() => expect(w.account()?.phase).toBe('revoked'));
    expect(phasesOf(w)).not.toContain('error');
  });

  it('an unlisted answer to the list publication is a revocation', async () => {
    const w = world();
    w.account.publishDeviceList.mockImplementationOnce(() => Promise.reject(new Error('E_DEVICE_UNLISTED')));
    w.call(1, { m: 'start' });
    await vi.waitFor(() => expect(w.account()?.phase).toBe('revoked'));
  });

  it('a revoked socket whose re-establish answers a pending scope ends in revoked', async () => {
    const w = world();
    await toReady(w);
    w.session.establish.mockImplementationOnce(() => Promise.reject(new Error('E_SESSION_SCOPE')));
    w.gateway.emit({ type: 'revoked' });
    await vi.waitFor(() => expect(w.account()?.phase).toBe('revoked'));
    expect(w.sync.stop).toHaveBeenCalledTimes(1);
  });

  it('expects every channel group first, then every DM group with a null community', async () => {
    const w = world();
    w.state.dms = [{ channelId: DM_CHANNEL, kind: 3, members: [USER, STRANGER] }];
    await toReady(w);
    expect(w.sync.setExpected).toHaveBeenLastCalledWith([
      { groupId: GROUP, communityId: COMMUNITY, channelId: CHANNEL, policyVersion: 1n },
      { groupId: DM_GROUP, communityId: null, channelId: DM_CHANNEL, policyVersion: 1n },
    ]);
    expect(w.routes.getChannel).toHaveBeenCalledWith(DM_CHANNEL);
    expect(w.last<DmSummary[]>('dms')).toEqual([{
      id: toHex(DM_CHANNEL), kind: 3, members: [toHex(USER), toHex(STRANGER)], name: '5a5a5a5a', group: 'none',
    }]);
  });

  it('a ready reloads every community and the DMs and refetches the own list and the backups', async () => {
    const w = world();
    await toReady(w);
    w.gateway.emit({ type: 'ready', info: READY_INFO });
    await vi.waitFor(() => expect(w.routes.listDms).toHaveBeenCalledTimes(2));
    expect(w.routes.listChannels).toHaveBeenCalledTimes(2);
    expect(w.account.ensureBackups).toHaveBeenCalledTimes(2);
    expect(w.account.refreshOwnDeviceList).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(w.account.repairBackupState).toHaveBeenCalledTimes(2));
  });

  // BACKUPS-RECOVERY-03: the repair needs the refreshed own list, so it runs after it; a refusal waits for the next ready.
  it('repairs the state object after the own list at each ready, and a failed repair is not an error', async () => {
    const w = world();
    w.account.repairBackupState.mockImplementationOnce(() => { w.calls.push('repairBackupState'); return Promise.reject(refusal(429, 'E_RATE_LIMITED', 3_000)); });
    await toReady(w);
    const from = w.calls.length;
    w.gateway.emit({ type: 'ready', info: READY_INFO });
    await vi.waitFor(() => expect(w.account.repairBackupState).toHaveBeenCalledTimes(2));
    const after = w.calls.slice(from);
    expect(after.indexOf('refreshOwnDeviceList')).toBeLessThan(after.indexOf('repairBackupState'));
    w.account.refreshOwnDeviceList.mockImplementationOnce(() => Promise.resolve({ version: 2n, listed: false }));
    w.gateway.emit({ type: 'ready', info: READY_INFO });
    await vi.waitFor(() => expect(w.account()?.phase).toBe('revoked'));
    expect(w.account.repairBackupState).toHaveBeenCalledTimes(2);
  });

  it('badges: a group bound to no known channel contributes nothing', async () => {
    const w = world();
    await toReady(w);
    w.state.groups = [textGroup(2), { ...textGroup(2), groupId: ORPHAN_GROUP, targetId: ORPHAN_CHANNEL }];
    w.state.activity = [act(GROUP, 2, 1), act(ORPHAN_GROUP, 7, 3)];
    w.sync.deps!.onGroupChanged(GROUP, applied(2));
    expect(w.badges()).toEqual({ [toHex(CHANNEL)]: { unread: 2, mentions: 1 } });
  });

  it('notices: one per new message from another device; a counted mention is a mention', async () => {
    const w = world();
    await toReady(w);
    w.state.groups = [textGroup(2)];
    w.state.rows = [strangerRow(1)];
    w.state.activity = [act(GROUP, 1, 0)];
    w.sync.deps!.onGroupChanged(GROUP, appliedSeqs([1n]));
    expect(w.notices()).toEqual({ nextId: 2, items: [{
      id: 1, channelId: toHex(CHANNEL), communityId: toHex(COMMUNITY), kind: 'message', senderUser: toHex(STRANGER),
      senderName: '5a5a5a5a', body: 'from a stranger 1', ts: 1_700_000_000,
    }] });
    const mention: TimelineRow = { ...strangerRow(2), body: `<@${toHex(USER)}> look`, mention: true };
    const own: TimelineRow = { ...strangerRow(3), senderUser: USER, senderDevice: DEVICE, body: 'mine' };
    w.state.rows = [strangerRow(1), mention, own];
    w.state.activity = [act(GROUP, 2, 1)];
    w.sync.deps!.onGroupChanged(GROUP, appliedSeqs([2n, 3n]));
    expect(w.notices()?.items.map((n) => [n.id, n.kind, n.body])).toEqual([[1, 'message', 'from a stranger 1'], [2, 'mention', `<@${toHex(USER)}> look`]]);
    expect(w.notices()?.nextId).toBe(3);
    expect(w.badges()).toEqual({ [toHex(CHANNEL)]: { unread: 2, mentions: 1 } });
  });

  it("a message from this user's other device raises no notice and no badge", async () => {
    const w = world();
    await toReady(w);
    w.state.groups = [textGroup(2)];
    w.state.rows = [{ ...strangerRow(1), senderUser: USER, senderDevice: OTHER_DEVICE, body: 'typed in the other browser' }];
    w.state.activity = [act(GROUP, 0, 0)];   // L-CORE-24's counts exclude the own user's rows (task 1); the stub core answers as the real one
    w.sync.deps!.onGroupChanged(GROUP, appliedSeqs([1n]));
    expect(w.notices()).toEqual({ nextId: 1, items: [] });
    expect(w.badges()).toEqual({ [toHex(CHANNEL)]: { unread: 0, mentions: 0 } });
  });

  it('a group change posts badges, then notices, before it returns to the engine', async () => {
    const w = world();
    await toReady(w);
    w.state.groups = [textGroup(2)];
    w.state.rows = [strangerRow(1)];
    w.state.activity = [act(GROUP, 1, 0)];
    const from = w.posted.length;
    w.sync.deps!.onGroupChanged(GROUP, appliedSeqs([1n]));
    // No await between the report and the read: both slices were posted inside the synchronous handler.
    const names = w.posted.slice(from).filter((m): m is SliceMessage => m.t === 'slice').map((m) => m.name);
    expect(names.filter((n) => n === 'badges' || n === 'notices')).toEqual(['badges', 'notices']);
  });

  it('an unexpected Welcome reloads the DMs, coalesced, and expects the new DM group', async () => {
    const w = world();
    await toReady(w);
    const before = w.routes.listDms.mock.calls.length;
    let release!: () => void;
    w.routes.listDms.mockImplementationOnce(() => {
      w.calls.push('listDms');
      return new Promise<typeof w.state.dms>((resolve) => { release = () => resolve([]); });
    });
    w.sync.deps!.onUnexpectedWelcome(DM_GROUP);
    w.sync.deps!.onUnexpectedWelcome(DM_GROUP);
    w.sync.deps!.onUnexpectedWelcome(DM_GROUP);
    expect(w.routes.listDms).toHaveBeenCalledTimes(before + 1);
    w.state.dms = [{ channelId: DM_CHANNEL, kind: 3, members: [USER, STRANGER] }];
    release();
    await vi.waitFor(() => expect(w.routes.listDms).toHaveBeenCalledTimes(before + 2));
    await vi.waitFor(() => expect(w.sync.setExpected).toHaveBeenLastCalledWith(expect.arrayContaining([
      { groupId: DM_GROUP, communityId: null, channelId: DM_CHANNEL, policyVersion: 1n },
    ])));
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(w.routes.listDms).toHaveBeenCalledTimes(before + 2);
  });

  it('notices: the ring keeps the newest 32', async () => {
    const w = world();
    await toReady(w);
    w.state.groups = [textGroup(2)];
    for (let batch = 0; batch < 5; batch++) {
      const seqs = Array.from({ length: 8 }, (_, i) => batch * 8 + i + 1);
      w.state.rows = seqs.map((s) => strangerRow(s));
      w.state.activity = [act(GROUP, seqs.at(-1)!, 0)];
      w.sync.deps!.onGroupChanged(GROUP, appliedSeqs(seqs.map(BigInt)));
    }
    const notices = w.notices()!;
    expect(notices.nextId).toBe(41);
    expect(notices.items).toHaveLength(32);
    expect(notices.items[0]).toMatchObject({ id: 9, body: 'from a stranger 9' });
    expect(notices.items.at(-1)).toMatchObject({ id: 40, body: 'from a stranger 40' });
  });

  it('markRead marks the newest stored seq and republishes the badges', async () => {
    const w = world();
    await toReady(w);
    await openGeneral(w);
    w.state.rows = [strangerRow(1), strangerRow(3)];
    w.state.activity = [act(GROUP, 2, 0)];
    w.sync.deps!.onGroupChanged(GROUP, applied(2));
    expect(w.badges()).toEqual({ [toHex(CHANNEL)]: { unread: 2, mentions: 0 } });
    w.core.markRead.mockImplementationOnce(() => { w.state.activity = [act(GROUP, 0, 0)]; });
    w.call(4, { m: 'markRead', channelId: toHex(CHANNEL) });
    await vi.waitFor(() => expect(w.ret(4)).toEqual({ t: 'ret', id: 4, ok: true, value: null }));
    expect(w.core.markRead).toHaveBeenCalledWith(GROUP, 3n, NOW_S);
    expect(w.badges()).toEqual({ [toHex(CHANNEL)]: { unread: 0, mentions: 0 } });
    w.call(5, { m: 'markRead', channelId: 'e'.repeat(32) });
    await vi.waitFor(() => expect(w.ret(5)).toBeDefined());
    expect(w.ret(5)).toMatchObject({ ok: false, error: { code: 'E_BAD_INPUT', detail: 'unknown channel' } });
  });

  it('setSetting stores a known key, deletes on null, and refuses everything else', async () => {
    const w = world();
    await toReady(w);
    w.call(2, { m: 'setSetting', key: 'notify.default', value: 'everything' });
    await vi.waitFor(() => expect(w.ret(2)).toEqual({ t: 'ret', id: 2, ok: true, value: null }));
    expect(w.last('settings')).toEqual({ 'notify.default': 'everything' });
    w.call(3, { m: 'setSetting', key: 'notify.default', value: null });
    await vi.waitFor(() => expect(w.ret(3)).toEqual({ t: 'ret', id: 3, ok: true, value: null }));
    expect(w.last('settings')).toEqual({});
    w.call(4, { m: 'setSetting', key: 'theme', value: 'mesh' });
    w.call(5, { m: 'setSetting', key: 'notify.default', value: 'loud' });
    w.call(6, { m: 'setSetting', key: 'notify.default', value: 3 });
    await vi.waitFor(() => expect(w.ret(6)).toBeDefined());
    await vi.waitFor(() => expect(w.ret(5)).toBeDefined());
    expect(w.ret(4)).toEqual({ t: 'ret', id: 4, ok: false, error: { code: 'E_SETTING_KEY', detail: '', status: 0, retryAfterMs: null } });
    expect(w.ret(5)).toMatchObject({ ok: false, error: { code: 'E_BAD_INPUT', detail: 'value is not allowed for notify.default' } });
    expect(w.ret(6)).toMatchObject({ ok: false, error: { code: 'E_BAD_INPUT', detail: 'value is not a string or null' } });
    expect(w.core.settingPut).toHaveBeenCalledTimes(1);
  });

  it('openDm registers the conversation, publishes it, expects its group and opens it like a channel', async () => {
    const w = world();
    await toReady(w);
    w.call(2, { m: 'openDm', userId: toHex(STRANGER) });
    await vi.waitFor(() => expect(w.ret(2)).toEqual({ t: 'ret', id: 2, ok: true, value: { channelId: toHex(DM_CHANNEL) } }));
    expect(w.routes.postDm).toHaveBeenCalledWith([STRANGER]);
    expect(w.last<DmSummary[]>('dms')?.map((d) => d.id)).toEqual([toHex(DM_CHANNEL)]);
    expect(w.sync.setExpected).toHaveBeenLastCalledWith(expect.arrayContaining([
      { groupId: DM_GROUP, communityId: null, channelId: DM_CHANNEL, policyVersion: 1n },
    ]));
    w.sync.openChannel.mockImplementationOnce(() => Promise.resolve({ groupId: DM_GROUP, state: 2 as const }));
    w.state.groups = [{ ...textGroup(2), groupId: DM_GROUP, communityId: null, targetId: DM_CHANNEL }];
    w.call(3, { m: 'openChannel', channelId: toHex(DM_CHANNEL) });
    await vi.waitFor(() => expect(w.ret(3)).toEqual({ t: 'ret', id: 3, ok: true, value: null }));
    expect(w.sync.openChannel).toHaveBeenLastCalledWith({ communityId: null, channelId: DM_CHANNEL, textGroupId: DM_GROUP });
    expect(w.last<TimelineState>(`timeline:${toHex(DM_CHANNEL)}`)).toMatchObject({ channelId: toHex(DM_CHANNEL), group: 'active' });
    expect(w.last<DmSummary[]>('dms')?.[0]?.group).toBe('active');
  });
});

describe('Controller devices (L-TS-23, Q13)', () => {
  const LISTED_BOTH: OwnDeviceList = { version: 2n, published: true, entries: [
    { deviceId: DEVICE, dskPub: new Uint8Array(32), tier: 1, addedAt: 1n, revokedAt: null },
    { deviceId: OTHER_DEVICE, dskPub: new Uint8Array(32), tier: 1, addedAt: 2n, revokedAt: null },
  ] };

  it('refreshDevices refetches the own list first and publishes the account devices, this browser first', async () => {
    const w = world();
    await toReady(w);
    const from = w.calls.length;
    w.call(2, { m: 'refreshDevices' });
    await vi.waitFor(() => expect(w.ret(2)).toEqual({ t: 'ret', id: 2, ok: true, value: null }));
    const after = w.calls.slice(from);
    expect(after.indexOf('refreshOwnDeviceList')).toBeGreaterThanOrEqual(0);
    expect(after.indexOf('refreshOwnDeviceList')).toBeLessThan(after.indexOf('listDevices'));
    expect(w.last<DeviceSummary[]>('devices')).toEqual([
      { id: toHex(DEVICE), tier: 1, signerTier: 1, lastSeen: 1_700_000_000, revokedAt: null, listed: true, own: true },
      { id: toHex(OTHER_DEVICE), tier: 1, signerTier: 1, lastSeen: 1_699_999_000, revokedAt: null, listed: false, own: false },
    ]);
  });

  it('signOutRevoke writes the state object, stops the engine and the gateway, publishes the list, then wipes to cleared', async () => {
    const w = world();
    await toReady(w);
    const from = w.calls.length;
    w.call(2, { m: 'signOutRevoke', recoveryKey: RECOVERY_KEY });
    await vi.waitFor(() => expect(w.ret(2)).toEqual({ t: 'ret', id: 2, ok: true, value: null }));
    expect(w.calls.slice(from)).toEqual([
      'getBackup(0)', 'getBackup(1)', 'getDeviceList', 'core.deviceListRevoke', 'putBackup(1)',
      'sync.stop', 'gateway.stop', 'putDeviceList', 'core.pause', 'resetDevice',
    ]);
    expect(w.core.deviceListRevoke).toHaveBeenCalledWith({
      recoveryKey: RECOVERY_KEY, rootSealed: ROOT, stateSealed: STATE_OBJECT, listBody: LIST_RAW, deviceIds: [DEVICE], now: NOW_S,
    });
    expect(w.routes.putBackup).toHaveBeenCalledWith(1, new Uint8Array([8]));
    expect(w.routes.putDeviceList).toHaveBeenCalledWith(USER, new Uint8Array([7]));
    expect(w.account()).toMatchObject({ phase: 'cleared', user: null, deviceId: null, recoveryKey: null, signIn: null, error: null });
    expect(w.last('communities')).toEqual([]);
    expect(w.channels()).toEqual([]);
    expect(w.badges()).toEqual({});
    expect(w.last('settings')).toEqual({});
    expect(w.last('dms')).toEqual([]);
    expect(w.notices()).toEqual({ nextId: 1, items: [] });
  });

  it('a missing state object is not a refusal: the revocation signs over empty bytes', async () => {
    const w = world();
    await toReady(w);
    w.routes.getBackup.mockImplementation((kind: 0 | 1) => {
      w.calls.push(`getBackup(${kind})`);
      return Promise.resolve(kind === 0 ? { object: ROOT, created: 1n } : null as unknown as { object: Uint8Array; created: bigint });
    });
    w.call(2, { m: 'signOutRevoke', recoveryKey: RECOVERY_KEY });
    await vi.waitFor(() => expect(w.ret(2)).toEqual({ t: 'ret', id: 2, ok: true, value: null }));
    expect(w.core.deviceListRevoke).toHaveBeenCalledWith(expect.objectContaining({ rootSealed: ROOT, stateSealed: new Uint8Array(0) }));
  });

  it('a missing root refuses a revocation before anything is signed or stopped', async () => {
    const w = world();
    await toReady(w);
    w.routes.getBackup.mockImplementationOnce(() => Promise.resolve(null as unknown as { object: Uint8Array; created: bigint }));
    w.call(2, { m: 'signOutRevoke', recoveryKey: RECOVERY_KEY });
    await vi.waitFor(() => expect(w.ret(2)).toBeDefined());
    expect(w.ret(2)).toEqual({ t: 'ret', id: 2, ok: false, error: { code: 'E_NO_BACKUP', detail: '', status: 0, retryAfterMs: null } });
    expect(w.core.deviceListRevoke).not.toHaveBeenCalled();
    expect(w.gateway.stops).toBe(0);
    expect(w.account()?.phase).toBe('ready');
  });

  it('a refused sign-out leaves a working client: the engine is rebuilt and the gateway restarted', async () => {
    const w = world();
    await toReady(w);
    expect(w.sync.builds).toBe(1);
    w.routes.putDeviceList.mockImplementationOnce(() => { w.calls.push('putDeviceList'); return Promise.reject(refusal(500, 'E_INTERNAL')); });
    const from = w.calls.length;
    w.call(2, { m: 'signOutRevoke', recoveryKey: RECOVERY_KEY });
    await vi.waitFor(() => expect(w.ret(2)).toBeDefined());
    expect(w.ret(2)).toEqual({ t: 'ret', id: 2, ok: false, error: { code: 'E_INTERNAL', detail: '', status: 500, retryAfterMs: null } });
    const after = w.calls.slice(from);
    // BACKUPS-RECOVERY-02: the self-revoking candidate is dropped, so no later ready publishes it silently.
    // Changed by fix-wave review NEW-2: the instance's state object from before the sign-out is put back.
    expect(after.slice(after.indexOf('putDeviceList'))).toEqual(['putDeviceList', 'core.deviceListDrop', 'putBackup(1)', 'sync.start', 'gateway.start']);
    expect(w.sync.builds).toBe(2);
    expect(w.sync.setExpected).toHaveBeenLastCalledWith([{ groupId: GROUP, communityId: COMMUNITY, channelId: CHANNEL, policyVersion: 1n }]);
    expect(w.core.pause).not.toHaveBeenCalled();
    expect(w.account()?.phase).toBe('ready');
    // wiping is false again: a later revoked socket re-establishes as in web-1.
    w.gateway.emit({ type: 'revoked' });
    await vi.waitFor(() => expect(w.session.establish).toHaveBeenCalledTimes(1));
  });

  it('a sign-out whose state object is refused sends nothing more and drops its candidate (BACKUPS-RECOVERY-02)', async () => {
    const w = world();
    await toReady(w);
    w.routes.putBackup.mockImplementationOnce(() => { w.calls.push('putBackup(1)'); return Promise.reject(refusal(429, 'E_RATE_LIMITED', 70_000)); });
    const from = w.calls.length;
    w.call(2, { m: 'signOutRevoke', recoveryKey: RECOVERY_KEY });
    await vi.waitFor(() => expect(w.ret(2)).toBeDefined());
    expect(w.ret(2)).toMatchObject({ ok: false, error: { code: 'E_RATE_LIMITED' } });
    expect(w.calls.slice(from)).toEqual(['getBackup(0)', 'getBackup(1)', 'getDeviceList', 'core.deviceListRevoke', 'putBackup(1)', 'core.deviceListDrop']);
    expect(w.routes.putDeviceList).not.toHaveBeenCalled();
    expect(w.gateway.stops).toBe(0);
    expect(w.account()?.phase).toBe('ready');
  });

  /** Fix-wave review NEW-2: the instance keeps one state object. A sign-out whose state PUT landed and whose list PUT
   *  failed left the self-revoking state there, the served list's successor, so this browser's next revocation read it
   *  back as an interrupted publication and revoked itself. The failed sign-out puts the previous object back. */
  it('a revoke of another device after a failed sign-out revokes the target and keeps this browser listed', async () => {
    const w = world();
    await toReady(w);
    w.state.ownList = LISTED_BOTH;
    let stored: Uint8Array = STATE_OBJECT;
    w.routes.getBackup.mockImplementation((kind: 0 | 1) => {
      w.calls.push(`getBackup(${kind})`); return Promise.resolve({ object: kind === 0 ? ROOT : stored, created: 1n });
    });
    w.routes.putBackup.mockImplementation((kind: 0 | 1, object: Uint8Array) => {
      w.calls.push(`putBackup(${kind})`); stored = object; return Promise.resolve({ blobId: new Uint8Array(32), size: object.length, created: false });
    });
    const SELF_REVOKING = new Uint8Array([0x5e]);
    w.core.deviceListRevoke.mockImplementationOnce(() => {
      w.calls.push('core.deviceListRevoke'); return { deviceListBody: new Uint8Array([7]), stateSealed: SELF_REVOKING, interrupted: null };
    });
    w.routes.putDeviceList.mockImplementationOnce(() => { w.calls.push('putDeviceList'); return Promise.reject(refusal(500, 'E_INTERNAL')); });
    w.call(2, { m: 'signOutRevoke', recoveryKey: RECOVERY_KEY });
    await vi.waitFor(() => expect(w.ret(2)).toBeDefined());
    expect(w.ret(2)).toMatchObject({ ok: false, error: { code: 'E_INTERNAL' } });
    expect(w.routes.putBackup.mock.calls.map((c) => c[1])).toEqual([SELF_REVOKING, STATE_OBJECT]);
    expect(stored).toEqual(STATE_OBJECT);
    expect(w.core.deviceListDrop).toHaveBeenCalledTimes(1);

    w.call(3, { m: 'revokeDevice', deviceId: toHex(OTHER_DEVICE), recoveryKey: RECOVERY_KEY });
    await vi.waitFor(() => expect(w.ret(3)).toEqual({ t: 'ret', id: 3, ok: true, value: null }));
    expect(w.core.deviceListRevoke).toHaveBeenLastCalledWith(expect.objectContaining({ stateSealed: STATE_OBJECT, deviceIds: [OTHER_DEVICE] }));
    expect(w.account()?.phase).toBe('ready');
    expect(phasesOf(w)).not.toContain('revoked');
  });

  it('an interrupted publication the core signed on is published first: on a revocation, then the list, then the state', async () => {
    const w = world();
    await toReady(w);
    w.state.ownList = LISTED_BOTH;
    const interrupted = new Uint8Array([6]);
    w.core.deviceListRevoke.mockImplementationOnce(() => {
      w.calls.push('core.deviceListRevoke'); return { deviceListBody: new Uint8Array([7]), stateSealed: new Uint8Array([8]), interrupted };
    });
    const from = w.calls.length;
    w.call(2, { m: 'revokeDevice', deviceId: toHex(OTHER_DEVICE), recoveryKey: RECOVERY_KEY });
    await vi.waitFor(() => expect(w.ret(2)).toEqual({ t: 'ret', id: 2, ok: true, value: null }));
    expect(w.calls.slice(from)).toEqual([
      'refreshOwnDeviceList', 'getBackup(0)', 'getBackup(1)', 'getDeviceList', 'core.deviceListRevoke',
      'putDeviceList', 'putDeviceList', 'core.deviceListPublished', 'putBackup(1)', 'core.stateSealedUploaded', 'refreshOwnDeviceList', 'listDevices',
    ]);
    expect(w.routes.putDeviceList.mock.calls.map((c) => c[1])).toEqual([interrupted, new Uint8Array([7])]);
  });

  it('an interrupted publication that another device published meanwhile (409) is not an error', async () => {
    const w = world();
    await toReady(w);
    w.state.ownList = LISTED_BOTH;
    w.core.deviceListRevoke.mockImplementationOnce(() => {
      w.calls.push('core.deviceListRevoke'); return { deviceListBody: new Uint8Array([7]), stateSealed: new Uint8Array([8]), interrupted: new Uint8Array([6]) };
    });
    w.routes.putDeviceList.mockImplementationOnce(() => { w.calls.push('putDeviceList'); return Promise.reject(refusal(409, 'E_INVALID_REQUEST')); });
    w.call(2, { m: 'revokeDevice', deviceId: toHex(OTHER_DEVICE), recoveryKey: RECOVERY_KEY });
    await vi.waitFor(() => expect(w.ret(2)).toEqual({ t: 'ret', id: 2, ok: true, value: null }));
    expect(w.routes.putDeviceList).toHaveBeenCalledTimes(2);
    expect(w.core.deviceListPublished).toHaveBeenCalledTimes(1);
  });

  it('an interrupted publication refused otherwise fails the revocation and drops the candidate to it', async () => {
    const w = world();
    await toReady(w);
    w.state.ownList = LISTED_BOTH;
    w.core.deviceListRevoke.mockImplementationOnce(() => {
      w.calls.push('core.deviceListRevoke'); return { deviceListBody: new Uint8Array([7]), stateSealed: new Uint8Array([8]), interrupted: new Uint8Array([6]) };
    });
    w.routes.putDeviceList.mockImplementationOnce(() => { w.calls.push('putDeviceList'); return Promise.reject(refusal(0, 'E_NETWORK')); });
    w.call(2, { m: 'revokeDevice', deviceId: toHex(OTHER_DEVICE), recoveryKey: RECOVERY_KEY });
    await vi.waitFor(() => expect(w.ret(2)).toBeDefined());
    expect(w.ret(2)).toMatchObject({ ok: false, error: { code: 'E_NETWORK' } });
    expect(w.routes.putDeviceList).toHaveBeenCalledTimes(1);
    expect(w.core.deviceListDrop).toHaveBeenCalledTimes(1);
    expect(w.routes.putBackup).not.toHaveBeenCalled();
  });

  it('a sign-out over an interrupted publication publishes it first, then the state object, then the self-revoking list', async () => {
    const w = world();
    await toReady(w);
    w.core.deviceListRevoke.mockImplementationOnce(() => {
      w.calls.push('core.deviceListRevoke'); return { deviceListBody: new Uint8Array([7]), stateSealed: new Uint8Array([8]), interrupted: new Uint8Array([6]) };
    });
    const from = w.calls.length;
    w.call(2, { m: 'signOutRevoke', recoveryKey: RECOVERY_KEY });
    await vi.waitFor(() => expect(w.ret(2)).toEqual({ t: 'ret', id: 2, ok: true, value: null }));
    expect(w.calls.slice(from)).toEqual([
      'getBackup(0)', 'getBackup(1)', 'getDeviceList', 'core.deviceListRevoke', 'putDeviceList', 'putBackup(1)',
      'sync.stop', 'gateway.stop', 'putDeviceList', 'core.pause', 'resetDevice',
    ]);
  });

  it('a revocation that loses the race reports E_LIST_RACE, restarts the gateway and keeps the store', async () => {
    const w = world();
    await toReady(w);
    w.routes.putDeviceList.mockImplementationOnce(() => Promise.reject(refusal(409, 'E_INVALID_REQUEST')));
    const refreshes = w.account.refreshOwnDeviceList.mock.calls.length;
    w.call(2, { m: 'signOutRevoke', recoveryKey: RECOVERY_KEY });
    await vi.waitFor(() => expect(w.ret(2)).toBeDefined());
    expect(w.ret(2)).toEqual({ t: 'ret', id: 2, ok: false, error: { code: 'E_LIST_RACE', detail: '', status: 0, retryAfterMs: null } });
    expect(w.account.refreshOwnDeviceList).toHaveBeenCalledTimes(refreshes + 1);
    expect(w.gateway.starts).toBe(2);
    expect(w.core.pause).not.toHaveBeenCalled();
    expect(w.account()?.phase).toBe('ready');
  });

  // Pre-flight ruling (b): revokeDevice refetches the own list before it decides listed or unlisted, so the
  // brief's two expected call lists below begin with that one refreshOwnDeviceList (pre-flight row 1.8).
  it('revokeDevice revokes another listed device with the key and refreshes the list without a wipe', async () => {
    const w = world();
    await toReady(w);
    w.state.ownList = LISTED_BOTH;
    w.call(2, { m: 'revokeDevice', deviceId: toHex(DEVICE), recoveryKey: RECOVERY_KEY });
    await vi.waitFor(() => expect(w.ret(2)).toBeDefined());
    expect(w.ret(2)).toMatchObject({ ok: false, error: { code: 'E_BAD_INPUT', detail: 'use signOutRevoke for this browser' } });
    expect(w.routes.getBackup).not.toHaveBeenCalled();
    const from = w.calls.length;
    w.call(3, { m: 'revokeDevice', deviceId: toHex(OTHER_DEVICE), recoveryKey: RECOVERY_KEY });
    await vi.waitFor(() => expect(w.ret(3)).toEqual({ t: 'ret', id: 3, ok: true, value: null }));
    // BACKUPS-RECOVERY-01: the revoking list goes first, so the shared upload meter or quota cannot hold it back.
    expect(w.calls.slice(from)).toEqual([
      'refreshOwnDeviceList',
      'getBackup(0)', 'getBackup(1)', 'getDeviceList', 'core.deviceListRevoke',
      'putDeviceList', 'core.deviceListPublished', 'putBackup(1)', 'core.stateSealedUploaded', 'refreshOwnDeviceList', 'listDevices',
    ]);
    expect(w.core.deviceListRevoke).toHaveBeenCalledWith(expect.objectContaining({ deviceIds: [OTHER_DEVICE] }));
    expect(w.routes.deleteDevice).not.toHaveBeenCalled();
    expect(w.core.pause).not.toHaveBeenCalled();
    expect(w.gateway.stops).toBe(0);
    expect(w.account()?.phase).toBe('ready');
  });

  it('a state object refused after the revoking list (a 429 on the shared meter, a 507 at the quota) still revokes; the next ready uploads it', async () => {
    const w = world();
    await toReady(w);
    w.state.ownList = LISTED_BOTH;
    for (const refused of [refusal(429, 'E_RATE_LIMITED', 3_000), refusal(507, 'E_STORAGE_FULL')]) {
      w.routes.putBackup.mockImplementationOnce(() => { w.calls.push('putBackup(1)'); return Promise.reject(refused); });
      w.core.stateSealedUploaded.mockClear();
      const id = w.posted.length + 10;
      const from = w.calls.length;
      w.call(id, { m: 'revokeDevice', deviceId: toHex(OTHER_DEVICE), recoveryKey: RECOVERY_KEY });
      await vi.waitFor(() => expect(w.ret(id)).toEqual({ t: 'ret', id, ok: true, value: null }));
      expect(w.calls.slice(from)).toEqual([
        'refreshOwnDeviceList', 'getBackup(0)', 'getBackup(1)', 'getDeviceList', 'core.deviceListRevoke',
        'putDeviceList', 'core.deviceListPublished', 'putBackup(1)', 'refreshOwnDeviceList', 'listDevices',
      ]);
      // Left unmarked: ensureBackups at the next ready uploads it (the floor accepts a state behind the list).
      expect(w.core.stateSealedUploaded).not.toHaveBeenCalled();
    }
    expect(w.account()?.phase).toBe('ready');
  });

  it('a revoking list refused before the state object: nothing is uploaded', async () => {
    const w = world();
    await toReady(w);
    w.state.ownList = LISTED_BOTH;
    w.routes.putDeviceList.mockImplementationOnce(() => { w.calls.push('putDeviceList'); return Promise.reject(refusal(0, 'E_NETWORK')); });
    w.call(2, { m: 'revokeDevice', deviceId: toHex(OTHER_DEVICE), recoveryKey: RECOVERY_KEY });
    await vi.waitFor(() => expect(w.ret(2)).toBeDefined());
    expect(w.ret(2)).toMatchObject({ ok: false, error: { code: 'E_NETWORK' } });
    expect(w.routes.putBackup).not.toHaveBeenCalled();
    expect(w.core.deviceListPublished).not.toHaveBeenCalled();
  });

  it('a listed device needs the key', async () => {
    const w = world();
    await toReady(w);
    w.state.ownList = LISTED_BOTH;
    w.call(2, { m: 'revokeDevice', deviceId: toHex(OTHER_DEVICE), recoveryKey: null });
    w.call(3, { m: 'revokeDevice', deviceId: toHex(OTHER_DEVICE), recoveryKey: '   ' });
    w.call(4, { m: 'revokeDevice', deviceId: toHex(OTHER_DEVICE), recoveryKey: 7 });
    await vi.waitFor(() => expect(w.ret(4)).toBeDefined());
    await vi.waitFor(() => expect(w.ret(3)).toBeDefined());
    await vi.waitFor(() => expect(w.ret(2)).toBeDefined());
    expect(w.ret(2)).toMatchObject({ ok: false, error: { code: 'E_BAD_INPUT', detail: 'the recovery key is empty' } });
    expect(w.ret(3)).toMatchObject({ ok: false, error: { code: 'E_BAD_INPUT', detail: 'the recovery key is empty' } });
    expect(w.ret(4)).toMatchObject({ ok: false, error: { code: 'E_BAD_INPUT', detail: 'the recovery key is not a string or null' } });
    expect(w.routes.getBackup).not.toHaveBeenCalled();
    expect(w.routes.deleteDevice).not.toHaveBeenCalled();
  });

  it('an unlisted row is removed with DELETE and no core method', async () => {
    const w = world();
    await toReady(w);
    const from = w.calls.length;
    w.call(2, { m: 'revokeDevice', deviceId: toHex(OTHER_DEVICE), recoveryKey: null });
    await vi.waitFor(() => expect(w.ret(2)).toEqual({ t: 'ret', id: 2, ok: true, value: null }));
    expect(w.routes.deleteDevice).toHaveBeenCalledWith(OTHER_DEVICE);
    expect(w.calls.slice(from)).toEqual(['refreshOwnDeviceList', 'deleteDevice', 'refreshOwnDeviceList', 'listDevices']);
    expect(w.core.deviceListRevoke).not.toHaveBeenCalled();
    expect(w.routes.putBackup).not.toHaveBeenCalled();
    expect(w.routes.putDeviceList).not.toHaveBeenCalled();
    w.routes.deleteDevice.mockImplementationOnce(() => Promise.reject(refusal(404, 'E_NOT_FOUND')));
    w.call(3, { m: 'revokeDevice', deviceId: toHex(OTHER_DEVICE), recoveryKey: RECOVERY_KEY });
    await vi.waitFor(() => expect(w.ret(3)).toBeDefined());
    expect(w.ret(3)).toEqual({ t: 'ret', id: 3, ok: false, error: { code: 'E_NOT_FOUND', detail: '', status: 404, retryAfterMs: null } });
    expect(w.core.deviceListRevoke).not.toHaveBeenCalled();
  });

  it('forgetBrowser stops the gateway first, ignores a 401 on the sessions delete and wipes to cleared', async () => {
    const w = world();
    await toReady(w);
    w.routes.deleteSessions.mockImplementationOnce(() => { w.calls.push('deleteSessions'); return Promise.reject(refusal(401, 'E_UNAUTHENTICATED')); });
    const from = w.calls.length;
    w.call(2, { m: 'forgetBrowser' });
    await vi.waitFor(() => expect(w.ret(2)).toEqual({ t: 'ret', id: 2, ok: true, value: null }));
    expect(w.calls.slice(from)).toEqual(['sync.stop', 'gateway.stop', 'deleteSessions', 'core.pause', 'resetDevice']);
    expect(w.routes.deleteSessions).toHaveBeenCalledWith(DEVICE);
    expect(w.wiped).toEqual([INSTANCE_HEX]);
    expect(w.account()).toMatchObject({ phase: 'cleared', user: null, deviceId: null, error: null });
    expect(w.routes.putDeviceList).not.toHaveBeenCalled();
  });

  it('forgetBrowser publishes an unpublished candidate before it deletes the sessions, and wipes even if that fails', async () => {
    for (const fails of [false, true]) {
      const w = world();
      await toReady(w);
      w.state.listPublished = false;
      if (fails) w.account.publishDeviceList.mockImplementationOnce(() => { w.calls.push('publishDeviceList'); return Promise.reject(refusal(0, 'E_NETWORK')); });
      const from = w.calls.length;
      w.call(2, { m: 'forgetBrowser' });
      await vi.waitFor(() => expect(w.ret(2)).toEqual({ t: 'ret', id: 2, ok: true, value: null }));
      expect(w.calls.slice(from)).toEqual(['sync.stop', 'gateway.stop', 'publishDeviceList', 'deleteSessions', 'core.pause', 'resetDevice']);
      expect(w.account()?.phase).toBe('cleared');
    }
  });

  it('a 4004 during forgetBrowser mints nothing', async () => {
    const w = world();
    await toReady(w);
    let release!: () => void;
    w.routes.deleteSessions.mockImplementationOnce(() => {
      w.calls.push('deleteSessions');
      return new Promise<void>((resolve) => { release = resolve; });
    });
    w.call(2, { m: 'forgetBrowser' });
    await vi.waitFor(() => expect(w.routes.deleteSessions).toHaveBeenCalledTimes(1));
    w.gateway.emit({ type: 'revoked' });     // the server's 4004 while the DELETE is in flight
    release();
    await vi.waitFor(() => expect(w.ret(2)).toEqual({ t: 'ret', id: 2, ok: true, value: null }));
    expect(w.session.establish).not.toHaveBeenCalled();
    expect(w.gateway.starts).toBe(1);
    expect(phasesOf(w)).not.toContain('revoked');
    expect(w.account()?.phase).toBe('cleared');
  });

  it('forgetBrowser wipes nothing when the delete fails otherwise, and restores the gateway', async () => {
    const w = world();
    await toReady(w);
    w.routes.deleteSessions.mockImplementationOnce(() => Promise.reject(refusal(503, 'E_UNAVAILABLE', 1000)));
    w.call(2, { m: 'forgetBrowser' });
    await vi.waitFor(() => expect(w.ret(2)).toBeDefined());
    expect(w.ret(2)).toEqual({ t: 'ret', id: 2, ok: false, error: { code: 'E_UNAVAILABLE', detail: '', status: 503, retryAfterMs: 1000 } });
    expect(w.core.pause).not.toHaveBeenCalled();
    expect(w.gateway.starts).toBe(2);
    expect(w.sync.builds).toBe(2);
    expect(w.account()?.phase).toBe('ready');
  });
});

// ---- The controller's pre-flight rulings for task 14, one test each (they add to the brief's tests). ----

describe('Controller pre-flight rulings (task 14)', () => {
  const OLDER_LIST = (): CoreError => new CoreError('E_CORE_INPUT', 'the instance served an older device list');

  it('(a) a row the server received before this session was ready badges but raises no notice', async () => {
    const w = world();
    await toReady(w);
    w.state.groups = [textGroup(2)];
    w.state.rows = [{ ...strangerRow(1), recvTs: NOW_S - 1n }];
    w.state.activity = [act(GROUP, 1, 0)];
    w.sync.deps!.onGroupChanged(GROUP, appliedSeqs([1n]));
    expect(w.badges()).toEqual({ [toHex(CHANNEL)]: { unread: 1, mentions: 0 } });
    expect(w.notices()).toEqual({ nextId: 1, items: [] });
  });

  it('(a) after a reconnect, rows caught up from before it raise no notice; a live row after it does', async () => {
    let nowMs = 1_700_000_000_000;
    const w = world({ now: () => nowMs });
    await toReady(w);
    nowMs += 60_000;                                          // the gateway was down for a minute
    w.gateway.emit({ type: 'ready', info: READY_INFO });
    w.state.groups = [textGroup(2)];
    w.state.rows = [{ ...strangerRow(1), recvTs: NOW_S + 30n }];
    w.state.activity = [act(GROUP, 1, 0)];
    w.sync.deps!.onGroupChanged(GROUP, appliedSeqs([1n]));     // the catch-up after the reconnect
    expect(w.notices()).toEqual({ nextId: 1, items: [] });
    expect(w.badges()).toEqual({ [toHex(CHANNEL)]: { unread: 1, mentions: 0 } });
    w.state.rows = [{ ...strangerRow(1), recvTs: NOW_S + 30n }, { ...strangerRow(2), recvTs: NOW_S + 61n }];
    w.state.activity = [act(GROUP, 2, 0)];
    w.sync.deps!.onGroupChanged(GROUP, appliedSeqs([2n]));     // a live frame
    expect(w.notices()?.items.map((n) => n.body)).toEqual(['from a stranger 2']);
  });

  it('(a) the floor is read on the instance clock (the ticket minted for the connection), not on this browser\'s', async () => {
    const w = world();
    await toReady(w);
    // The instance clock is ten minutes behind this browser: the ticket expires 30 s after the instance's now.
    w.routes.postTicket.mockImplementationOnce(() => Promise.resolve({ ticket: 'ticket', expires: NOW_S - 600n + 30n }));
    expect(await w.gatewayDeps.value!.mintTicket()).toBe('ticket');
    w.gateway.emit({ type: 'ready', info: READY_INFO });
    w.state.groups = [textGroup(2)];
    w.state.rows = [{ ...strangerRow(1), recvTs: NOW_S - 700n }, { ...strangerRow(2), recvTs: NOW_S - 500n }];
    w.state.activity = [act(GROUP, 2, 0)];
    w.sync.deps!.onGroupChanged(GROUP, appliedSeqs([1n, 2n]));
    expect(w.notices()?.items.map((n) => n.body)).toEqual(['from a stranger 2']);
  });

  it('(b) revokeDevice decides listed from the refreshed own list, never from a stale one', async () => {
    const w = world();
    await toReady(w);
    // The stored list names only this device; the instance's newer list (adopted by the refresh) names the other too.
    w.account.refreshOwnDeviceList.mockImplementationOnce(() => {
      w.calls.push('refreshOwnDeviceList');
      w.state.ownList = { version: 2n, published: true, entries: [
        { deviceId: DEVICE, dskPub: new Uint8Array(32), tier: 1, addedAt: 1n, revokedAt: null },
        { deviceId: OTHER_DEVICE, dskPub: new Uint8Array(32), tier: 1, addedAt: 2n, revokedAt: null },
      ] };
      return Promise.resolve({ version: 2n, listed: true });
    });
    w.call(2, { m: 'revokeDevice', deviceId: toHex(OTHER_DEVICE), recoveryKey: null });
    await vi.waitFor(() => expect(w.ret(2)).toBeDefined());
    expect(w.ret(2)).toMatchObject({ ok: false, error: { code: 'E_BAD_INPUT', detail: 'the recovery key is empty' } });
    expect(w.routes.deleteDevice).not.toHaveBeenCalled();
  });

  it('(c) a revocation refused for an older served list refreshes the own list, reads the objects again and retries once', async () => {
    const w = world();
    await toReady(w);
    w.core.deviceListRevoke.mockImplementationOnce(() => { w.calls.push('core.deviceListRevoke'); throw OLDER_LIST(); });
    const from = w.calls.length;
    w.call(2, { m: 'signOutRevoke', recoveryKey: RECOVERY_KEY });
    await vi.waitFor(() => expect(w.ret(2)).toEqual({ t: 'ret', id: 2, ok: true, value: null }));
    expect(w.calls.slice(from)).toEqual([
      'getBackup(0)', 'getBackup(1)', 'getDeviceList', 'core.deviceListRevoke', 'refreshOwnDeviceList',
      'getBackup(0)', 'getBackup(1)', 'getDeviceList', 'core.deviceListRevoke', 'putBackup(1)',
      'sync.stop', 'gateway.stop', 'putDeviceList', 'core.pause', 'resetDevice',
    ]);
  });

  it('(c) a second older-list refusal is the list conflict, with nothing uploaded or stopped', async () => {
    const w = world();
    await toReady(w);
    w.state.ownList = { version: 2n, published: true, entries: [
      { deviceId: DEVICE, dskPub: new Uint8Array(32), tier: 1, addedAt: 1n, revokedAt: null },
      { deviceId: OTHER_DEVICE, dskPub: new Uint8Array(32), tier: 1, addedAt: 2n, revokedAt: null },
    ] };
    w.core.deviceListRevoke.mockImplementation(() => { throw OLDER_LIST(); });
    w.call(2, { m: 'revokeDevice', deviceId: toHex(OTHER_DEVICE), recoveryKey: RECOVERY_KEY });
    await vi.waitFor(() => expect(w.ret(2)).toBeDefined());
    expect(w.ret(2)).toEqual({ t: 'ret', id: 2, ok: false, error: { code: 'E_LIST_RACE', detail: '', status: 0, retryAfterMs: null } });
    expect(w.core.deviceListRevoke).toHaveBeenCalledTimes(2);
    expect(w.routes.putBackup).not.toHaveBeenCalled();
    expect(w.routes.putDeviceList).not.toHaveBeenCalled();
    expect(w.gateway.stops).toBe(0);
    expect(w.account()?.phase).toBe('ready');
  });

  it('(c) an enrolment refused for an older served list reads the backups again and completes', async () => {
    const w = world({ phase: 0 });
    w.enrol.complete.mockImplementationOnce(() => { w.calls.push('enrol.complete'); return Promise.reject(OLDER_LIST()); });
    await toLoginStep(w);
    w.call(4, LOGIN);
    await vi.waitFor(() => expect(w.ret(4)).toEqual({ t: 'ret', id: 4, ok: true, value: { needsTotp: false } }));
    expect(w.calls.filter((c) => c.startsWith('enrol.'))).toEqual([
      'enrol.login', 'enrol.register', 'enrol.fetch', 'enrol.complete', 'enrol.fetch', 'enrol.complete',
    ]);
    expect(w.account()?.phase).toBe('ready');
  });

  it('(c) a second older-list refusal at enrolment is the list race: the store is wiped to cleared', async () => {
    const w = world({ phase: 0 });
    w.enrol.complete.mockImplementation(() => Promise.reject(OLDER_LIST()));
    await toLoginStep(w);
    w.call(4, LOGIN);
    await vi.waitFor(() => expect(w.ret(4)).toBeDefined());
    const want = { code: 'E_LIST_RACE', detail: '', status: 0, retryAfterMs: null };
    expect(w.ret(4)).toEqual({ t: 'ret', id: 4, ok: false, error: want });
    expect(w.enrol.complete).toHaveBeenCalledTimes(2);
    expect(w.account()).toMatchObject({ phase: 'cleared', error: want });
    expect(w.wiped).toEqual([INSTANCE_HEX]);
  });

  it('(e) an enrolment whose backup state is missing or unreadable is E_NO_BACKUP at the key step, without a retry', async () => {
    for (const detail of ['the backup state is missing', 'the backup state could not be read']) {
      const w = world({ phase: 0 });
      w.enrol.complete.mockImplementationOnce(() => Promise.reject(new CoreError('E_CORE_INPUT', detail)));
      await toLoginStep(w);
      w.call(4, LOGIN);
      await vi.waitFor(() => expect(w.ret(4)).toBeDefined());
      const want = { code: 'E_NO_BACKUP', detail: '', status: 0, retryAfterMs: null };
      expect(w.ret(4)).toEqual({ t: 'ret', id: 4, ok: false, error: want });
      expect(w.account()).toMatchObject({ phase: 'signin-key', error: want });
      expect(w.enrol.complete).toHaveBeenCalledTimes(1);
      expect(w.state.phase).toBe(3);
      // The next key reads the backups again: another device may have uploaded the state meanwhile.
      w.call(5, { m: 'signInKey', recoveryKey: RECOVERY_KEY });
      await vi.waitFor(() => expect(w.ret(5)).toEqual({ t: 'ret', id: 5, ok: true, value: null }));
      expect(w.enrol.fetch).toHaveBeenCalledTimes(2);
    }
  });

  it('(d) a revoked browser can forget itself: sessions deleted, store wiped, cleared', async () => {
    const w = world();
    w.account.refreshOwnDeviceList.mockImplementationOnce(() => Promise.resolve({ version: 3n, listed: false }));
    w.call(1, { m: 'start' });
    await vi.waitFor(() => expect(w.account()?.phase).toBe('revoked'));
    const from = w.calls.length;
    w.call(2, { m: 'forgetBrowser' });
    await vi.waitFor(() => expect(w.ret(2)).toEqual({ t: 'ret', id: 2, ok: true, value: null }));
    expect(w.calls.slice(from)).toEqual(['deleteSessions', 'core.pause', 'resetDevice']);
    expect(w.routes.deleteSessions).toHaveBeenCalledWith(DEVICE);
    expect(w.account()).toMatchObject({ phase: 'cleared', user: null, deviceId: null, error: null });
    expect(w.sync.builds).toBe(0);
    expect(w.gateway.starts).toBe(0);
  });

  it('(d) a revoked browser whose sessions delete fails stays revoked and starts nothing', async () => {
    const w = world();
    w.account.refreshOwnDeviceList.mockImplementationOnce(() => Promise.resolve({ version: 3n, listed: false }));
    w.call(1, { m: 'start' });
    await vi.waitFor(() => expect(w.account()?.phase).toBe('revoked'));
    w.routes.deleteSessions.mockImplementationOnce(() => Promise.reject(refusal(503, 'E_UNAVAILABLE', 1000)));
    w.call(2, { m: 'forgetBrowser' });
    await vi.waitFor(() => expect(w.ret(2)).toBeDefined());
    expect(w.ret(2)).toMatchObject({ ok: false, error: { code: 'E_UNAVAILABLE', status: 503 } });
    expect(w.core.pause).not.toHaveBeenCalled();
    expect(w.account()?.phase).toBe('revoked');
    expect(w.sync.builds).toBe(0);
    expect(w.gateway.starts).toBe(0);
  });

  it('pre-flight row 2.14(d): a failed first DM load still publishes an empty DM list', async () => {
    const w = world();
    w.routes.listDms.mockImplementationOnce(() => Promise.reject(refusal(503, 'E_UNAVAILABLE', 1000)));
    await toReady(w);
    expect(w.last<DmSummary[]>('dms')).toEqual([]);
  });
});

// ---- Task-14 fix round 1: a root mismatch is not dropped; an unusable served state object cannot block a revocation. ----

describe('Controller task-14 fix round 1', () => {
  /** BACKUPS-RECOVERY-04: a root mismatch reaches the page on the account slice. */
  const rootMismatch = (w: World): unknown => w.account()?.rootMismatch;
  const STATE_MISSING = 'the backup state is missing';
  const STATE_UNREADABLE = 'the backup state could not be read';
  const listedBoth = (w: World): void => {
    w.state.ownList = { version: 2n, published: true, entries: [
      { deviceId: DEVICE, dskPub: new Uint8Array(32), tier: 1, addedAt: 1n, revokedAt: null },
      { deviceId: OTHER_DEVICE, dskPub: new Uint8Array(32), tier: 1, addedAt: 2n, revokedAt: null },
    ] };
  };

  it('a root mismatch from ensureBackups at ready is recorded, the client still reaches ready, and the wipe drops it', async () => {
    const w = world();
    w.account.ensureBackups.mockImplementationOnce(() => { w.calls.push('ensureBackups'); return Promise.reject(new Error('E_ROOT_MISMATCH')); });
    await toReady(w);
    expect(rootMismatch(w)).toBe(true);
    w.call(2, { m: 'forgetBrowser' });
    await vi.waitFor(() => expect(w.ret(2)).toEqual({ t: 'ret', id: 2, ok: true, value: null }));
    expect(rootMismatch(w)).toBe(false);
  });

  it('every other ensureBackups rejection is still swallowed and records nothing; a gateway ready records a mismatch; a later success clears it', async () => {
    const w = world();
    w.account.ensureBackups.mockImplementationOnce(() => Promise.reject(refusal(503, 'E_UNAVAILABLE', 1000)));
    await toReady(w);
    expect(rootMismatch(w)).toBe(false);
    w.account.ensureBackups.mockImplementationOnce(() => Promise.reject(new Error('E_ROOT_MISMATCH')));
    w.gateway.emit({ type: 'ready', info: READY_INFO });
    await vi.waitFor(() => expect(rootMismatch(w)).toBe(true));
    w.account.ensureBackups.mockImplementationOnce(() => Promise.reject(refusal(503, 'E_UNAVAILABLE', 1000)));
    w.gateway.emit({ type: 'ready', info: READY_INFO });
    await settle();
    expect(rootMismatch(w)).toBe(true);
    w.gateway.emit({ type: 'ready', info: READY_INFO });         // the operator removed the planted root: the upload succeeds
    await vi.waitFor(() => expect(rootMismatch(w)).toBe(false));
  });

  it('a served state object the core refuses is replaced by this device\'s own sealed state, and the re-sealed one repairs the instance\'s copy', async () => {
    for (const detail of [STATE_MISSING, STATE_UNREADABLE]) {
      const w = world();
      await toReady(w);
      listedBoth(w);
      w.core.deviceListRevoke.mockImplementationOnce(() => { w.calls.push('core.deviceListRevoke'); throw new CoreError('E_CORE_INPUT', detail); });
      const from = w.calls.length;
      w.call(2, { m: 'revokeDevice', deviceId: toHex(OTHER_DEVICE), recoveryKey: RECOVERY_KEY });
      await vi.waitFor(() => expect(w.ret(2)).toEqual({ t: 'ret', id: 2, ok: true, value: null }));
      expect(w.calls.slice(from)).toEqual([
        'refreshOwnDeviceList', 'getBackup(0)', 'getBackup(1)', 'getDeviceList', 'core.deviceListRevoke', 'core.deviceListRevoke',
        // BACKUPS-RECOVERY-01: the list first, then the re-sealed state object.
        'putDeviceList', 'core.deviceListPublished', 'putBackup(1)', 'core.stateSealedUploaded', 'refreshOwnDeviceList', 'listDevices',
      ]);
      expect(w.core.deviceListRevoke).toHaveBeenNthCalledWith(1, expect.objectContaining({ stateSealed: STATE_OBJECT, deviceIds: [OTHER_DEVICE] }));
      expect(w.core.deviceListRevoke).toHaveBeenNthCalledWith(2, {
        recoveryKey: RECOVERY_KEY, rootSealed: ROOT, stateSealed: LOCAL_STATE, listBody: LIST_RAW, deviceIds: [OTHER_DEVICE], now: NOW_S,
      });
      expect(w.routes.putBackup).toHaveBeenCalledWith(1, new Uint8Array([8]));
    }
  });

  it('a sign-out over a refused served state object signs with this device\'s own state and wipes to cleared', async () => {
    const w = world();
    await toReady(w);
    w.core.deviceListRevoke.mockImplementationOnce(() => { w.calls.push('core.deviceListRevoke'); throw new CoreError('E_CORE_INPUT', STATE_MISSING); });
    const from = w.calls.length;
    w.call(2, { m: 'signOutRevoke', recoveryKey: RECOVERY_KEY });
    await vi.waitFor(() => expect(w.ret(2)).toEqual({ t: 'ret', id: 2, ok: true, value: null }));
    expect(w.calls.slice(from)).toEqual([
      'getBackup(0)', 'getBackup(1)', 'getDeviceList', 'core.deviceListRevoke', 'core.deviceListRevoke', 'putBackup(1)',
      'sync.stop', 'gateway.stop', 'putDeviceList', 'core.pause', 'resetDevice',
    ]);
    expect(w.core.deviceListRevoke).toHaveBeenLastCalledWith(expect.objectContaining({ stateSealed: LOCAL_STATE, deviceIds: [DEVICE] }));
    expect(w.account()?.phase).toBe('cleared');
  });

  it('when this device\'s own state is refused too, or there is none, the revocation is E_NO_BACKUP with nothing uploaded or stopped', async () => {
    const want = { code: 'E_NO_BACKUP', detail: '', status: 0, retryAfterMs: null };
    // (i) the own state is refused as well: two core calls, then E_NO_BACKUP.
    const w = world();
    await toReady(w);
    listedBoth(w);
    w.core.deviceListRevoke.mockImplementation(() => { throw new CoreError('E_CORE_INPUT', STATE_UNREADABLE); });
    w.call(2, { m: 'revokeDevice', deviceId: toHex(OTHER_DEVICE), recoveryKey: RECOVERY_KEY });
    await vi.waitFor(() => expect(w.ret(2)).toBeDefined());
    expect(w.ret(2)).toEqual({ t: 'ret', id: 2, ok: false, error: want });
    expect(w.core.deviceListRevoke).toHaveBeenCalledTimes(2);
    expect(w.routes.putBackup).not.toHaveBeenCalled();
    expect(w.routes.putDeviceList).not.toHaveBeenCalled();
    expect(w.account()?.phase).toBe('ready');
    // (ii) this device holds no state object: one core call, then E_NO_BACKUP; a sign-out stops nothing.
    const v = world();
    await toReady(v);
    v.core.sealedObjects.mockImplementation(() => ({ root: ROOT, state: null, stateUploaded: false }));
    v.core.deviceListRevoke.mockImplementation(() => { throw new CoreError('E_CORE_INPUT', STATE_MISSING); });
    v.call(2, { m: 'signOutRevoke', recoveryKey: RECOVERY_KEY });
    await vi.waitFor(() => expect(v.ret(2)).toBeDefined());
    expect(v.ret(2)).toEqual({ t: 'ret', id: 2, ok: false, error: want });
    expect(v.core.deviceListRevoke).toHaveBeenCalledTimes(1);
    expect(v.routes.putBackup).not.toHaveBeenCalled();
    expect(v.gateway.stops).toBe(0);
    expect(v.account()?.phase).toBe('ready');
  });

  it('any other core refusal of the revocation is not retried with the own state', async () => {
    const w = world();
    await toReady(w);
    w.core.deviceListRevoke.mockImplementationOnce(() => { throw new CoreError('E_RECOVERY_KEY', ''); });
    w.call(2, { m: 'signOutRevoke', recoveryKey: RECOVERY_KEY });
    await vi.waitFor(() => expect(w.ret(2)).toBeDefined());
    expect(w.ret(2)).toEqual({ t: 'ret', id: 2, ok: false, error: { code: 'E_RECOVERY_KEY', detail: '', status: 0, retryAfterMs: null } });
    expect(w.core.deviceListRevoke).toHaveBeenCalledTimes(1);
    expect(w.core.sealedObjects).not.toHaveBeenCalled();
  });
});

// ---- WORKER-WEB-01: an enrolment interrupted after the list publish must not keep the pending session. ----

describe('Controller enrolment interrupted after the list publish (WORKER-WEB-01)', () => {
  const PENDING: SessionRecord = { token: 'pending', expires: NOW_S + 604_800n, idleExpires: NOW_S + 43_200n };
  const order = (w: World): string[] =>
    w.calls.filter((c) => ['putDeviceList', 'core.sessionClear', 'postSession', 'gateway.start'].includes(c));

  it('an establish that fails after the publish: the same tab establishes an enrolled session before the gateway starts', async () => {
    const w = world({ phase: 3, enrolUser: true, realAccount: true });
    w.state.session = PENDING;
    w.routes.postSession.mockImplementationOnce(() => { w.calls.push('postSession'); return Promise.reject(refusal(0, 'E_NETWORK')); });
    w.call(1, { m: 'start' });
    await vi.waitFor(() => expect(w.account()?.phase).toBe('signin-key'));
    w.call(2, { m: 'signInKey', recoveryKey: RECOVERY_KEY });
    await vi.waitFor(() => expect(w.ret(2)).toEqual({ t: 'ret', id: 2, ok: true, value: null }));
    expect(w.account()?.phase).toBe('ready');
    expect(order(w)).toEqual(['putDeviceList', 'core.sessionClear', 'postSession', 'postSession', 'gateway.start']);
    expect(w.state.session?.token).toBe('enrolled');
  });

  it('a reload before the establish answered: the next boot establishes an enrolled session before the gateway starts', async () => {
    const w = world({ phase: 3, enrolUser: true, realAccount: true });
    w.state.session = PENDING;
    // The tab goes away while the establish after the publish is in flight: it never answers.
    w.routes.postSession.mockImplementationOnce(() => { w.calls.push('postSession'); return new Promise(() => {}); });
    w.call(1, { m: 'start' });
    await vi.waitFor(() => expect(w.account()?.phase).toBe('signin-key'));
    w.call(2, { m: 'signInKey', recoveryKey: RECOVERY_KEY });
    await vi.waitFor(() => expect(w.calls).toContain('postSession'));
    expect(w.state).toMatchObject({ phase: 2, listPublished: true });
    w.calls.length = 0;
    // The reload: a new worker over the same store.
    const again = harness({
      boot: (instance) => Promise.resolve({ kind: 'opened', core: w.core as unknown as CorePort, instance }),
      parts: w.parts,
    });
    again.call(1, { m: 'start' });
    await vi.waitFor(() => expect(again.account()?.phase).toBe('ready'));
    expect(order(w)).toEqual(['postSession', 'gateway.start']);
    expect(w.state.session?.token).toBe('enrolled');
  });
});

// ---- Pre-flight ruling 4: other-tab only after a grace, so an in-place reload does not flash it. ----

describe('Controller other-tab grace', () => {
  // The ruled grace is 1500 ms (LEADER.otherTabGraceMs); the times below are written out so a changed grace fails here.
  afterEach(() => { vi.useRealTimers(); });

  const phases = (w: World): string[] =>
    w.posted.filter((m): m is SliceMessage => m.t === 'slice' && m.name === 'account').map((m) => (m.value as AccountState).phase);

  it('a lock granted within the grace never publishes other-tab', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const w = world({ phase: 0 });
    const release = w.locks.holdElsewhere(LOCK);
    w.call(1, { m: 'start' });
    await vi.advanceTimersByTimeAsync(0);
    expect(w.locks.requests).toEqual([{ name: LOCK, ifAvailable: true }, { name: LOCK, ifAvailable: false }]);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(w.account()?.phase).toBe('loading');
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.account()?.phase).toBe('needs-signup');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(phases(w)).not.toContain('other-tab');
    expect(w.account()?.phase).toBe('needs-signup');
  });

  it('a lock still held after the grace publishes other-tab', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const w = world({ phase: 0 });
    w.locks.holdElsewhere(LOCK);
    w.call(1, { m: 'start' });
    await vi.advanceTimersByTimeAsync(1_499);
    expect(w.account()?.phase).toBe('loading');
    await vi.advanceTimersByTimeAsync(1);
    expect(w.account()?.phase).toBe('other-tab');
  });

  it('a lock granted after the grace moves on to boot', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const w = world({ phase: 0 });
    const release = w.locks.holdElsewhere(LOCK);
    w.call(1, { m: 'start' });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(w.account()?.phase).toBe('other-tab');
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.account()?.phase).toBe('needs-signup');
    expect(phases(w).slice(phases(w).indexOf('other-tab'))).toEqual(['other-tab', 'loading', 'needs-signup']);
  });
});

// ---- web-2b: say more (L-TS-34, L-TS-35, L-TS-36) ----

const MSG = new Uint8Array(16).fill(0x31);
const MSG_HEX = toHex(MSG);
const ROLE = new Uint8Array(16).fill(0x7a);
const CH_HEX = toHex(CHANNEL);
/** The 26-byte WebP header stub of attachment.json case 3 (L-CORE-31). */
const WEBP_STUB = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x12, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, ...new Array<number>(14).fill(0)]);
type Ok = Extract<FromWorker, { t: 'ret'; ok: true }>;
type Refused = Extract<FromWorker, { t: 'ret'; ok: false }>;

function file(name: string, type: string, size: number): File {
  return new File([new Uint8Array(size).map((_, i) => (i * 7) & 0xff)], name, { type });
}
const trayOf = (w: World): TrayItem[] | undefined => w.last<TrayItem[]>(`tray:${CH_HEX}`);
const pinsOf = (w: World): PinnedItem[] | undefined => w.last<PinnedItem[]>(`pins:${CH_HEX}`);
const okValue = <T>(w: World, id: number): T => (w.ret(id) as Ok).value as T;
const purge = (seq: bigint, blobs: Uint8Array[]): PurgeRow => ({ groupId: GROUP, seq, channelId: CHANNEL, blobIds: blobs });
const B1 = new Uint8Array(32).fill(0xb1);
const B2 = new Uint8Array(32).fill(0xb2);

async function attachReady(w: World, id: number, files: File[]): Promise<string[]> {
  w.call(id, { m: 'attachFiles', channelId: CH_HEX, files });
  await vi.waitFor(() => expect(w.ret(id)).toBeDefined());
  expect(w.ret(id)).toMatchObject({ ok: true });
  await vi.waitFor(() => expect(trayOf(w)?.map((t) => t.phase)).toEqual(files.map(() => 'ready')));
  return okValue<{ trayIds: string[] }>(w, id).trayIds;
}

/** Every Uint8Array or ArrayBuffer anywhere inside a value. */
function bytesIn(value: unknown, found: Uint8Array[] = []): Uint8Array[] {
  if (value instanceof Uint8Array) { found.push(value); return found; }
  if (value instanceof ArrayBuffer) { found.push(new Uint8Array(value)); return found; }
  if (typeof value === 'object' && value !== null) for (const inner of Object.values(value)) bytesIn(inner, found);
  return found;
}

describe('Controller say more (L-TS-34, L-TS-35, L-TS-36)', () => {
  it('refuses malformed say-more commands before anything runs', async () => {
    const h = harness();
    h.call(1, { m: 'editMessage', channelId: CH_HEX, msgId: 'XYZ', text: 'x' });
    h.call(2, { m: 'editMessage', channelId: CH_HEX, msgId: MSG_HEX, text: '  ' });
    h.call(3, { m: 'react', channelId: CH_HEX, msgId: MSG_HEX, emoji: '', on: true });
    h.call(4, { m: 'react', channelId: CH_HEX, msgId: MSG_HEX, emoji: 'x'.repeat(33), on: true });
    h.call(5, { m: 'pin', channelId: CH_HEX, msgId: MSG_HEX, on: 'yes' });
    h.call(6, { m: 'attachFiles', channelId: CH_HEX, files: [] });
    h.call(7, { m: 'attachFiles', channelId: CH_HEX, files: ['not a file'] });
    h.call(8, { m: 'openAttachment', channelId: CH_HEX, seq: '01', index: 0, thumb: false });
    h.call(9, { m: 'openAttachment', channelId: CH_HEX, seq: '7', index: -1, thumb: false });
    h.call(10, { m: 'send', channelId: CH_HEX, text: 'x', replyTo: 'nope' });
    h.call(11, { m: 'send', channelId: CH_HEX, text: 'x', attachments: ['a', 'b', 'c', 'd', 'e'] });
    h.call(12, { m: 'discardAttachment', channelId: CH_HEX, trayId: '' });
    h.call(13, { m: 'react', channelId: CH_HEX, msgId: MSG_HEX, emoji: '👍', on: 1 });
    h.call(14, { m: 'openAttachment', channelId: CH_HEX, seq: '7', index: 0, thumb: 'no' });
    await vi.waitFor(() => expect(h.ret(14)).toBeDefined());
    const details = Array.from({ length: 14 }, (_, i) => (h.ret(i + 1) as Refused).error);
    expect(details.map((e) => e.code)).toEqual(new Array<string>(14).fill('E_BAD_INPUT'));
    expect(details.map((e) => e.detail)).toEqual([
      'msgId is not 32 lowercase hex', 'the message is empty', 'emoji must be 1..=32 bytes', 'emoji must be 1..=32 bytes',
      'on is not a boolean', 'files is not a non-empty list of files', 'files is not a non-empty list of files',
      'seq is not a decimal sequence number', 'index is not a non-negative integer', 'replyTo is not 32 lowercase hex',
      'attachments is not a list of at most 4 tray ids', 'trayId is empty', 'on is not a boolean', 'thumb is not a boolean',
    ]);
    expect(h.paths).toEqual([]);
  });

  it('attachFiles uploads into the channel tray and publishes the tray without descriptors', async () => {
    const w = world();
    await toReady(w);
    await openGeneral(w);
    const ids = await attachReady(w, 4, [file('notes.txt', 'text/plain', 5), file('data.bin', 'application/octet-stream', 70)]);
    expect(ids).toHaveLength(2);
    expect(trayOf(w)).toEqual([
      { id: ids[0], name: 'notes.txt', size: 5, mime: 'text/plain', image: false, phase: 'ready', reason: '' },
      { id: ids[1], name: 'data.bin', size: 70, mime: 'application/octet-stream', image: false, phase: 'ready', reason: '' },
    ]);
    expect(w.routes.putBlob).toHaveBeenCalledTimes(2);
    expect(w.routes.putBlob.mock.calls.map((c) => toHex(c[0]))).toEqual([CH_HEX, CH_HEX]);
    // The stored bytes are the file sealed: 16 bytes longer than the plaintext (L-CORE-31).
    expect(w.routes.putBlob.mock.calls.map((c) => c[2].length)).toEqual([5 + 16, 70 + 16]);
  });

  it('send takes the ready descriptors, sends one type-0 request, and no slice ever carries a key, a nonce or a blob id', async () => {
    const w = world();
    await toReady(w);
    await openGeneral(w);
    const ids = await attachReady(w, 4, [file('a.txt', 'text/plain', 3), file('b.txt', 'text/plain', 4)]);
    w.call(5, { m: 'send', channelId: CH_HEX, text: 'two files', attachments: ids });
    await vi.waitFor(() => expect(w.ret(5)).toBeDefined());
    expect(w.ret(5)).toEqual({ t: 'ret', id: 5, ok: true, value: { msgId: '77'.repeat(16) } });
    expect(w.sync.sendRequest).toHaveBeenCalledTimes(1);
    const [group, request] = w.sync.sendRequest.mock.calls[0];
    expect(toHex(group)).toBe(toHex(GROUP));
    expect(request).toMatchObject({ type: 0, replyTo: null, body: 'two files' });
    expect(request.attachments.map((a) => [a.name, a.size, a.mime])).toEqual([['a.txt', 3, 'text/plain'], ['b.txt', 4, 'text/plain']]);
    expect(request.attachments.map((a) => toHex(a.blobId))).toEqual(w.routes.putBlob.mock.calls.map((c) => toHex(c[1])));
    await vi.waitFor(() => expect(trayOf(w)).toEqual([]));
    // The queued row as the core would list it, so the timeline slice is built with its files too.
    w.state.outbox = [{ msgId: new Uint8Array(16).fill(0x77), state: 0, error: '', created: NOW_S, body: 'two files', type: 0, replyTo: null,
      attachments: request.attachments.map((a) => ({ blobId: a.blobId, size: a.size, mime: a.mime, name: a.name })) }];
    w.sync.deps!.onOutboxChanged(GROUP);
    expect(w.timeline()?.items.at(-1)?.attachments.map((a) => a.name)).toEqual(['a.txt', 'b.txt']);
    const slices = w.posted.filter((m) => m.t === 'slice').map((m) => m.value);
    expect(bytesIn(slices)).toEqual([]);
    const text = JSON.stringify(slices);
    for (const a of request.attachments) {
      for (const secret of [a.key, a.nonce, a.blobId]) {
        expect(text).not.toContain(toHex(secret));
        expect(text).not.toContain(Array.from(secret).join(','));
      }
    }
  });

  it('an attachment-only message is accepted; a blank text with no attachments is refused', async () => {
    const w = world();
    await toReady(w);
    await openGeneral(w);
    const ids = await attachReady(w, 4, [file('only.txt', 'text/plain', 2)]);
    w.call(5, { m: 'send', channelId: CH_HEX, text: '', attachments: ids });
    await vi.waitFor(() => expect(w.ret(5)).toBeDefined());
    expect(w.ret(5)).toMatchObject({ ok: true });
    expect(w.sync.sendRequest.mock.calls[0][1]).toMatchObject({ type: 0, body: '' });
    w.call(6, { m: 'send', channelId: CH_HEX, text: ' ', attachments: [] });
    await vi.waitFor(() => expect(w.ret(6)).toBeDefined());
    expect(w.ret(6)).toMatchObject({ ok: false, error: { code: 'E_BAD_INPUT', detail: 'the message is empty' } });
  });

  it('a tray id that is not ready refuses the send and sends nothing', async () => {
    const w = world();
    await toReady(w);
    await openGeneral(w);
    const gate = deferred<{ created: boolean; size: number }>();
    w.routes.putBlob.mockImplementationOnce(() => gate.promise);
    w.call(4, { m: 'attachFiles', channelId: CH_HEX, files: [file('slow.txt', 'text/plain', 3)] });
    await vi.waitFor(() => expect(trayOf(w)?.[0]?.phase).toBe('uploading'));
    const id = trayOf(w)![0].id;
    w.call(5, { m: 'send', channelId: CH_HEX, text: 'too soon', attachments: [id] });
    await vi.waitFor(() => expect(w.ret(5)).toBeDefined());
    expect(w.ret(5)).toEqual({ t: 'ret', id: 5, ok: false, error: { code: 'E_TRAY_NOT_READY', detail: '', status: 0, retryAfterMs: null } });
    expect(w.sync.sendRequest).not.toHaveBeenCalled();
    gate.resolve({ created: true, size: 19 });
    await vi.waitFor(() => expect(trayOf(w)?.[0]?.phase).toBe('ready'));
  });

  it('attachFiles refuses five files and an oversize file by code, before any upload', async () => {
    const w = world();
    await toReady(w);
    await openGeneral(w);
    w.call(4, { m: 'attachFiles', channelId: CH_HEX, files: [1, 2, 3, 4, 5].map((n) => file(`${String(n)}.txt`, 'text/plain', 1)) });
    w.call(5, { m: 'attachFiles', channelId: CH_HEX, files: [file('big.bin', 'application/octet-stream', BROWSER_ATTACHMENT_CAP + 1)] });
    w.call(6, { m: 'attachFiles', channelId: 'e'.repeat(32), files: [file('x.txt', 'text/plain', 1)] });
    await vi.waitFor(() => expect(w.ret(6)).toBeDefined());
    await vi.waitFor(() => expect(w.ret(5)).toBeDefined());
    expect((w.ret(4) as Refused).error).toMatchObject({ code: 'E_ATTACHMENT_COUNT', status: 0 });
    expect((w.ret(5) as Refused).error).toMatchObject({ code: 'E_ATTACHMENT_TOO_LARGE', status: 0 });
    expect((w.ret(6) as Refused).error).toEqual({ code: 'E_BAD_INPUT', detail: 'unknown channel', status: 0, retryAfterMs: null });
    expect(w.routes.putBlob).not.toHaveBeenCalled();
  });

  it('discardAttachment deletes an uploaded reference and drops the entry', async () => {
    const w = world();
    await toReady(w);
    await openGeneral(w);
    const [id] = await attachReady(w, 4, [file('oops.txt', 'text/plain', 4)]);
    w.call(5, { m: 'discardAttachment', channelId: CH_HEX, trayId: id });
    await vi.waitFor(() => expect(w.ret(5)).toEqual({ t: 'ret', id: 5, ok: true, value: null }));
    expect(w.routes.deleteBlob).toHaveBeenCalledTimes(1);
    expect(toHex(w.routes.deleteBlob.mock.calls[0][1])).toBe(toHex(w.routes.putBlob.mock.calls[0][1]));
    expect(trayOf(w)).toEqual([]);
  });

  it('beforeSend confirms each attachment of the row in order; onDiscarded deletes each and swallows failures', async () => {
    const w = world();
    await toReady(w);
    await openGeneral(w);
    const row: OutboxRow = { msgId: MSG, state: 0, error: '', created: NOW_S, body: '', type: 0, replyTo: null,
      attachments: [{ blobId: B1, size: 1, mime: 'text/plain', name: 'a' }, { blobId: B2, size: 2, mime: 'text/plain', name: 'b' }] };
    await w.sync.deps!.beforeSend(GROUP, row);
    expect(w.routes.confirmBlob.mock.calls.map((c) => [toHex(c[0]), toHex(c[1])])).toEqual([[CH_HEX, toHex(B1)], [CH_HEX, toHex(B2)]]);
    w.routes.confirmBlob.mockImplementationOnce(() => Promise.reject(refusal(404, 'E_NOT_FOUND')));
    await expect(w.sync.deps!.beforeSend(GROUP, row)).rejects.toMatchObject({ status: 404, code: 'E_NOT_FOUND' });
    w.routes.deleteBlob.mockImplementationOnce(() => Promise.reject(refusal(0, 'E_NETWORK')));
    w.sync.deps!.onDiscarded(GROUP, row);
    await vi.waitFor(() => expect(w.routes.deleteBlob).toHaveBeenCalledTimes(2));
    expect(w.routes.deleteBlob.mock.calls.map((c) => toHex(c[1]))).toEqual([toHex(B1), toHex(B2)]);
    await expect(w.sync.deps!.beforeSend(new Uint8Array(16).fill(0x99), row)).rejects.toMatchObject({ code: 'E_CORE_STATE', detail: 'unknown group' });
  });

  it('editMessage, deleteMessage, react and pin send the fold types aimed at the message', async () => {
    const w = world();
    await toReady(w);
    await openGeneral(w);
    w.call(4, { m: 'editMessage', channelId: CH_HEX, msgId: MSG_HEX, text: 'better words' });
    w.call(5, { m: 'deleteMessage', channelId: CH_HEX, msgId: MSG_HEX });
    w.call(6, { m: 'react', channelId: CH_HEX, msgId: MSG_HEX, emoji: '👍', on: true });
    w.call(7, { m: 'react', channelId: CH_HEX, msgId: MSG_HEX, emoji: '👍', on: false });
    w.call(8, { m: 'pin', channelId: CH_HEX, msgId: MSG_HEX, on: true });
    w.call(9, { m: 'pin', channelId: CH_HEX, msgId: MSG_HEX, on: false });
    await vi.waitFor(() => expect(w.ret(9)).toBeDefined());
    for (const id of [4, 5, 6, 7, 8, 9]) expect(w.ret(id)).toEqual({ t: 'ret', id, ok: true, value: null });
    expect(w.sync.sendRequest.mock.calls.map(([g, r]) => [toHex(g), r.type, toHex(r.replyTo!), r.body, r.attachments])).toEqual([
      [toHex(GROUP), 1, MSG_HEX, 'better words', []],
      [toHex(GROUP), 2, MSG_HEX, '', []],
      [toHex(GROUP), 3, MSG_HEX, '👍', []],
      [toHex(GROUP), 4, MSG_HEX, '👍', []],
      [toHex(GROUP), 5, MSG_HEX, '', []],
      [toHex(GROUP), 6, MSG_HEX, '', []],
    ]);
    expect(w.routes.deleteGroupMessage).not.toHaveBeenCalled();
  });

  it("a core refusal of a fold crosses with its code and detail; a reply's msg id reaches the core", async () => {
    const w = world();
    await toReady(w);
    await openGeneral(w);
    w.sync.sendRequest.mockImplementationOnce(() => { throw new CoreError('E_CORE_INPUT', 'only the author may edit or delete'); });
    w.call(4, { m: 'editMessage', channelId: CH_HEX, msgId: MSG_HEX, text: 'not mine' });
    await vi.waitFor(() => expect(w.ret(4)).toBeDefined());
    expect(w.ret(4)).toEqual({ t: 'ret', id: 4, ok: false,
      error: { code: 'E_CORE_INPUT', detail: 'only the author may edit or delete', status: 0, retryAfterMs: null } });
    w.call(5, { m: 'send', channelId: CH_HEX, text: 'answer', replyTo: MSG_HEX });
    await vi.waitFor(() => expect(w.ret(5)).toBeDefined());
    expect(w.sync.sendRequest.mock.calls.at(-1)![1]).toEqual({ type: 0, replyTo: MSG, body: 'answer', attachments: [] });
  });

  it('a recorded purge runs after the outbox changed: the message, then each reference, then done', async () => {
    const w = world();
    await toReady(w);
    await openGeneral(w);
    w.call(4, { m: 'deleteMessage', channelId: CH_HEX, msgId: MSG_HEX });
    await vi.waitFor(() => expect(w.ret(4)).toBeDefined());
    await settle();
    expect(w.routes.deleteGroupMessage).not.toHaveBeenCalled();
    // The core records the purge when the type-2 row's confirm folds it (L-CORE-33); the engine then reports the outbox.
    w.state.purges = [purge(5n, [B1, B2])];
    w.sync.deps!.onOutboxChanged(GROUP);
    await vi.waitFor(() => expect(w.core.purgeDone).toHaveBeenCalledTimes(1));
    expect(w.calls.filter((c) => /^(deleteGroupMessage|deleteBlob|core\.purgeDone)/.test(c))).toEqual([
      'deleteGroupMessage(5)', `deleteBlob(${toHex(B1).slice(0, 8)})`, `deleteBlob(${toHex(B2).slice(0, 8)})`, 'core.purgeDone(5)',
    ]);
    expect(w.routes.deleteGroupMessage.mock.calls.map((c) => [toHex(c[0]), c[1]])).toEqual([[toHex(GROUP), 5n]]);
    expect(w.routes.deleteBlob.mock.calls.map((c) => toHex(c[0]))).toEqual([CH_HEX, CH_HEX]);
  });

  it('a failed purge waits for the next trigger; a 403 on a reference and a gone message count as done', async () => {
    const w = world();
    await toReady(w);
    await openGeneral(w);
    w.state.purges = [purge(6n, [B1, B2])];
    w.routes.deleteGroupMessage.mockImplementationOnce(() => Promise.reject(refusal(0, 'E_NETWORK')));
    w.sync.deps!.onOutboxChanged(GROUP);
    await vi.waitFor(() => expect(w.routes.deleteGroupMessage).toHaveBeenCalledTimes(1));
    await settle();
    expect(w.core.purgeDone).not.toHaveBeenCalled();
    expect(w.state.purges).toHaveLength(1);
    w.routes.deleteGroupMessage.mockImplementationOnce(() => Promise.resolve('gone'));
    w.routes.deleteBlob.mockImplementationOnce(() => Promise.reject(refusal(403, 'E_NOT_UPLOADER')));
    w.gateway.emit({ type: 'ready', info: READY_INFO });
    await vi.waitFor(() => expect(w.core.purgeDone).toHaveBeenCalledTimes(1));
    expect(w.routes.deleteGroupMessage).toHaveBeenCalledTimes(2);
    expect(w.routes.deleteBlob).toHaveBeenCalledTimes(2);
    expect(w.state.purges).toEqual([]);
  });

  it('a purge that fails on a reference with a server error stays for the next trigger', async () => {
    const w = world();
    await toReady(w);
    await openGeneral(w);
    w.state.purges = [purge(7n, [B1])];
    w.routes.deleteBlob.mockImplementationOnce(() => Promise.reject(refusal(503, 'E_UNAVAILABLE', 1000)));
    w.sync.deps!.onOutboxChanged(GROUP);
    await vi.waitFor(() => expect(w.routes.deleteBlob).toHaveBeenCalledTimes(1));
    await settle();
    expect(w.core.purgeDone).not.toHaveBeenCalled();
    w.sync.deps!.onOutboxChanged(GROUP);
    await vi.waitFor(() => expect(w.core.purgeDone).toHaveBeenCalledTimes(1));
  });

  it('purges run one at a time: triggers during a run make it go once more', async () => {
    const w = world();
    await toReady(w);
    await openGeneral(w);
    w.state.purges = [purge(8n, [])];
    const gate = deferred<'deleted' | 'gone'>();
    w.routes.deleteGroupMessage.mockImplementationOnce(() => gate.promise);
    w.sync.deps!.onOutboxChanged(GROUP);
    w.sync.deps!.onOutboxChanged(GROUP);
    w.sync.deps!.onOutboxChanged(GROUP);
    await settle();
    expect(w.routes.deleteGroupMessage).toHaveBeenCalledTimes(1);
    gate.resolve('deleted');
    await vi.waitFor(() => expect(w.core.purgeDone).toHaveBeenCalledTimes(1));
    await settle();
    expect(w.routes.deleteGroupMessage).toHaveBeenCalledTimes(1);
    expect(w.core.purges.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('loadPins publishes the pins and keeps them fresh until closePins', async () => {
    const w = world();
    await toReady(w);
    await openGeneral(w);
    w.state.pins = [{ targetSeq: 4n, msgId: MSG, pinnedSeq: 9n, byUser: USER, author: STRANGER, excerpt: 'pin me', targetTs: 1700000005n }];
    w.call(4, { m: 'loadPins', channelId: CH_HEX });
    await vi.waitFor(() => expect(w.ret(4)).toEqual({ t: 'ret', id: 4, ok: true, value: null }));
    expect(pinsOf(w)).toEqual([{ msgId: MSG_HEX, seq: '4', senderUser: toHex(STRANGER), excerpt: 'pin me', pinnedBy: toHex(USER), pinnedSeq: '9', ts: 1700000005 }]);
    w.state.pins = [];
    w.sync.deps!.onGroupChanged(GROUP, applied(2));
    expect(pinsOf(w)).toEqual([]);
    w.call(5, { m: 'closePins', channelId: CH_HEX });
    await vi.waitFor(() => expect(w.ret(5)).toBeDefined());
    w.state.pins = [{ targetSeq: 4n, msgId: MSG, pinnedSeq: 10n, byUser: USER, author: null, excerpt: 'again', targetTs: 1700000005n }];
    w.sync.deps!.onGroupChanged(GROUP, applied(2));
    expect(pinsOf(w)).toEqual([]);
    w.call(6, { m: 'loadPins', channelId: 'e'.repeat(32) });
    await vi.waitFor(() => expect(w.ret(6)).toBeDefined());
    expect((w.ret(6) as Refused).error).toMatchObject({ code: 'E_BAD_INPUT', detail: 'unknown channel' });
  });

  it('openAttachment returns the decrypted file and its thumbnail as Blobs; a tampered file crosses E_BLOB_HASH', async () => {
    const w = world();
    await toReady(w);
    await openGeneral(w);
    const key = new Uint8Array(32).fill(0x55);
    const nonce = new Uint8Array(12).fill(0x56);
    const plain = new Uint8Array(1000).map((_, i) => i % 251);
    const { stored, blobId } = await sealBlob(key, nonce, plain);
    const thumb = await sealThumb(key, nonce, WEBP_STUB);
    w.state.descriptors.set('7:0', { blobId, key, nonce, size: 1000, mime: 'image/png', w: 640, h: 480, thumb, name: 'map\u0000.png' });
    w.state.descriptors.set('7:1', { blobId, key, nonce, size: 1000, mime: 'application/pdf', w: null, h: null, thumb: null, name: 'r/s.pdf' });
    w.state.blobs.set(toHex(blobId), stored);
    w.call(4, { m: 'openAttachment', channelId: CH_HEX, seq: '7', index: 0, thumb: false });
    w.call(5, { m: 'openAttachment', channelId: CH_HEX, seq: '7', index: 0, thumb: true });
    w.call(6, { m: 'openAttachment', channelId: CH_HEX, seq: '7', index: 1, thumb: false });
    w.call(7, { m: 'openAttachment', channelId: CH_HEX, seq: '7', index: 1, thumb: true });
    w.call(8, { m: 'openAttachment', channelId: CH_HEX, seq: '7', index: 2, thumb: false });
    await vi.waitFor(() => { for (const id of [4, 5, 6, 7, 8]) expect(w.ret(id)).toBeDefined(); });
    const full = okValue<{ blob: Blob; name: string; mime: string }>(w, 4);
    expect([full.name, full.mime, full.blob.type]).toEqual(['map.png', 'image/png', 'image/png']);
    expect(new Uint8Array(await full.blob.arrayBuffer())).toEqual(plain);
    const small = okValue<{ blob: Blob; name: string; mime: string }>(w, 5);
    expect(small.blob.type).toBe('image/webp');
    expect(new Uint8Array(await small.blob.arrayBuffer())).toEqual(WEBP_STUB);
    const doc = okValue<{ blob: Blob; name: string; mime: string }>(w, 6);
    expect([doc.name, doc.mime, doc.blob.type]).toEqual(['r_s.pdf', 'application/pdf', 'application/octet-stream']);
    expect((w.ret(7) as Refused).error).toMatchObject({ code: 'E_ATTACHMENT_MISSING' });
    expect((w.ret(8) as Refused).error).toMatchObject({ code: 'E_CORE_NOT_FOUND', detail: 'no such attachment' });
    expect(w.routes.getBlob).toHaveBeenCalledTimes(2);
    const tampered = stored.slice(); tampered[0] = (tampered[0] ?? 0) ^ 1;
    w.state.blobs.set(toHex(blobId), tampered);
    w.call(9, { m: 'openAttachment', channelId: CH_HEX, seq: '7', index: 0, thumb: false });
    await vi.waitFor(() => expect(w.ret(9)).toBeDefined());
    expect((w.ret(9) as Refused).error).toEqual({ code: 'E_BLOB_HASH', detail: '', status: 0, retryAfterMs: null });
  });

  it("roles: the own member row's roles reach the core once per change, and a role mention raises a mention notice", async () => {
    const w = world();
    w.state.roleIds = [ROLE];
    await toReady(w);
    await vi.waitFor(() => expect(w.core.ownRolesSet).toHaveBeenCalled());
    expect(w.core.ownRolesSet.mock.calls.map((c) => [toHex(c[0]), c[1].map(toHex)])).toEqual([[toHex(COMMUNITY), [toHex(ROLE)]]]);
    w.call(2, { m: 'selectCommunity', communityId: toHex(COMMUNITY) });
    await vi.waitFor(() => expect(w.ret(2)).toBeDefined());
    expect(w.core.ownRolesSet).toHaveBeenCalledTimes(1);
    w.state.groups = [textGroup(2)];
    w.state.rows = [{ ...strangerRow(1), body: `<@${toHex(ROLE)}> standup`, mention: true }];
    w.state.activity = [act(GROUP, 1, 1)];
    w.sync.deps!.onGroupChanged(GROUP, appliedSeqs([1n]));
    expect(w.notices()?.items.map((n) => [n.kind, n.body])).toEqual([['mention', `<@${toHex(ROLE)}> standup`]]);
    w.state.roleIds = [];
    w.gateway.emit({ type: 'ready', info: READY_INFO });
    await vi.waitFor(() => expect(w.core.ownRolesSet).toHaveBeenCalledTimes(2));
    expect(w.core.ownRolesSet.mock.calls[1][1]).toEqual([]);
  });

  it('publishes each member\'s role ids as hex on the members slice (INTERFACES-05)', async () => {
    const w = world();
    w.state.roleIds = [ROLE];
    await toReady(w);
    await vi.waitFor(() => expect(w.last<MemberSummary[]>(`members:${toHex(COMMUNITY)}`)).toBeDefined());
    const own = w.last<MemberSummary[]>(`members:${toHex(COMMUNITY)}`)!.find((m) => m.roleIds.length > 0);
    expect(own?.roleIds).toEqual([toHex(ROLE)]);
  });

  it('a notice is a mention only by the core\'s flag, never by a body an edit changed (FACTS-SECURITY-07)', async () => {
    const w = world();
    w.state.roleIds = [ROLE];
    await toReady(w);
    await vi.waitFor(() => expect(w.core.ownRolesSet).toHaveBeenCalled());
    w.state.groups = [textGroup(2)];
    w.state.rows = [{ ...strangerRow(1), body: `<@${toHex(ROLE)}> standup`, editedSeq: 2n, mention: false }];
    w.state.activity = [act(GROUP, 1, 1)];
    w.sync.deps!.onGroupChanged(GROUP, appliedSeqs([1n, 2n]));
    expect(w.notices()?.items.map((n) => n.kind)).toEqual(['message']);
  });

  it('a purge of a group this device is not a member of waits, and runs once the group is back (FACTS-SECURITY-08)', async () => {
    const w = world();
    await toReady(w);
    await openGeneral(w);
    w.state.groups = [textGroup(4)];
    w.state.purges = [purge(7n, [B1])];
    w.sync.deps!.onOutboxChanged(GROUP);
    await settle();
    expect(w.routes.deleteGroupMessage).not.toHaveBeenCalled();
    expect(w.state.purges).toHaveLength(1);
    w.state.groups = [textGroup(2)];
    w.gateway.emit({ type: 'ready', info: READY_INFO });
    await vi.waitFor(() => expect(w.core.purgeDone).toHaveBeenCalledTimes(1));
  });

  // Pre-flight ruling F6: a purge the core records while it adopts the own type-2 row in a catch-up (an apply, with no
  // outbox report of its own) runs after that group change, not only at the next outbox change or ready.
  it('a purge recorded by an apply runs after the group change (F6)', async () => {
    const w = world();
    await toReady(w);
    await openGeneral(w);
    w.state.purges = [purge(9n, [B1])];
    w.sync.deps!.onGroupChanged(GROUP, applied(2));
    await vi.waitFor(() => expect(w.core.purgeDone).toHaveBeenCalledTimes(1));
    expect(w.calls.filter((c) => /^(deleteGroupMessage|deleteBlob|core\.purgeDone)/.test(c))).toEqual([
      'deleteGroupMessage(9)', `deleteBlob(${toHex(B1).slice(0, 8)})`, 'core.purgeDone(9)',
    ]);
  });
});

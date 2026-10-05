import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BootOutcome } from '../account/boot';
import type { Session } from '../account/session';
import type { Signup } from '../account/signup';
import { encode, type CborInput } from '../cbor';
import type { ApplyResult, CorePort, GroupInfo, IdentityInfo, TimelineRow } from '../core-port';
import type { Gateway, GatewayEvent, ReadyInfo } from '../gateway/gateway';
import { toHex } from '../hex';
import { DillaHttpError } from '../http/errors';
import type { Instance, Routes } from '../http/routes';
import type { AccountState, ChannelSummary, CommunitySummary, ConnectionState, MemberSummary, TimelineState } from '../state/types';
import type { SyncDeps, SyncEngine } from '../sync/engine';
import { SyncError } from '../sync/errors';
import { Controller, type ControllerDeps } from './controller';
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
    type: 0, body: `from a stranger ${seq}`,
  };
}

class GatewayDouble {
  starts = 0;
  stops = 0;
  readonly status = 'idle';
  private readonly listeners: ((e: GatewayEvent) => void)[] = [];
  start(): void { this.starts += 1; }
  stop(): void { this.stops += 1; }
  subscribe(listener: (e: GatewayEvent) => void): () => void { this.listeners.push(listener); return () => {}; }
  commitAck(): void {}
  emit(e: GatewayEvent): void { for (const l of this.listeners) l(e); }
}

function world(opts: { phase?: 0 | 1 | 2; realRoutes?: boolean; fetch?: typeof fetch } = {}) {
  // An account that is already registered (phase 2) is already a member of the community, so that a
  // selectCommunity of it passes pre-flight ruling 1(v); a signup world (phase 0 or 1) starts outside it.
  const state = { phase: opts.phase ?? 2, groups: [] as GroupInfo[], rows: [] as TimelineRow[], resets: 0, joined: (opts.phase ?? 2) === 2 };
  const core = {
    identity: (): IdentityInfo => ({
      phase: state.phase, instanceId: INSTANCE_ID, userId: state.phase === 2 ? USER : null,
      deviceId: DEVICE, username: 'web', listPublished: true,
    }),
    signupBegin: (): string => { state.phase = 1; return 'ABCD'.repeat(13); },
    signupReset: (): void => { state.phase = 0; state.resets += 1; },
    groups: (): GroupInfo[] => state.groups,
    timeline: (): TimelineRow[] => state.rows,
    outbox: () => [],
    close: (): void => {},
  } as unknown as CorePort;
  /* eslint-disable @typescript-eslint/no-unused-vars -- the typed parameters give the brief's doubles their call signatures */
  const routes = {
    getInstance: vi.fn(() => Promise.resolve(INSTANCE)),
    getLimits: vi.fn(() => Promise.resolve({
      maxCiphertextBytes: 131_072, keypackagesPerDevice: 32, keypackageRefillThreshold: 8, heartbeatMs: 30_000, maxFrameBytes: 131_584,
    })),
    getInvite: vi.fn((_code: string) => Promise.resolve({ communityId: null as Uint8Array | null, communityName: null as string | null, expires: 0n })),
    joinCommunity: vi.fn((_id: Uint8Array, _invite: string) => { state.joined = true; return Promise.resolve(); }),
    listCommunities: vi.fn(() => Promise.resolve(state.joined ? [{ id: COMMUNITY, name: 'friends', owner: USER, policyVersion: 1n }] : [])),
    listChannels: vi.fn((_id: Uint8Array) => Promise.resolve([{
      id: CHANNEL, kind: 0, mode: 0, visibility: 0, parentId: null, name: 'general', topic: '', position: 0, seq: 1n, textGroupId: GROUP,
    }])),
    listMembers: vi.fn((_id: Uint8Array) => Promise.resolve([{ userId: USER, username: 'web', display: 'Web', kind: 0 as const, nick: '' }])),
    postTicket: vi.fn(() => Promise.resolve({ ticket: 'ticket', expires: 0n })),
  };
  const session = {
    token: (): string => 'session-token',
    ensure: vi.fn(() => Promise.resolve(true)),
    establish: vi.fn(() => Promise.resolve(true)),
  };
  const signup = {
    begin: (instanceId: Uint8Array): string[] => { core.signupBegin(instanceId); return Array.from({ length: 13 }, () => 'ABCD'); },
    submit: vi.fn((_input: unknown) => { state.phase = 2; return Promise.resolve(); }),
    resume: vi.fn((): Promise<0 | 2 | 'revoked'> => Promise.resolve(2)),
  };
  const gateway = new GatewayDouble();
  const sync = {
    deps: null as SyncDeps | null,
    start: vi.fn(), stop: vi.fn(), setChannels: vi.fn(), send: vi.fn(), retry: vi.fn(), discard: vi.fn(),
    openChannel: vi.fn((_c: unknown) => Promise.resolve({ groupId: GROUP, state: 2 as const })),
  };
  /* eslint-enable @typescript-eslint/no-unused-vars */
  const h = harness({
    boot: (instance) => Promise.resolve({ kind: 'opened', core, instance }),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    parts: {
      ...(opts.realRoutes === true ? {} : { routes: () => routes as unknown as Routes }),
      session: () => session as unknown as Session,
      signup: () => signup as unknown as Signup,
      gateway: () => gateway as unknown as Gateway,
      sync: (deps) => { sync.deps = deps; return sync as unknown as SyncEngine; },
    },
  });
  return {
    ...h, state, routes, session, signup, gateway, sync,
    channels: () => h.last<ChannelSummary[]>(`channels:${toHex(COMMUNITY)}`),
    timeline: () => h.last<TimelineState>(`timeline:${toHex(CHANNEL)}`),
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
    expect(w.routes.listChannels).toHaveBeenCalledTimes(1);
    expect(w.routes.listMembers).toHaveBeenCalledTimes(1);
    w.gateway.emit({ type: 'ready', info: READY_INFO });
    await vi.waitFor(() => expect(w.routes.listMembers).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(w.routes.listChannels).toHaveBeenCalledTimes(2));
    expect(w.routes.listCommunities).toHaveBeenCalledTimes(2);
    expect(w.routes.listChannels).toHaveBeenLastCalledWith(COMMUNITY);
    expect(w.connection()?.generation).toBe('7');
  });

  it('a member who joined later gets a name', async () => {
    const w = world();
    await toReady(w);
    await openGeneral(w);
    expect(w.routes.listMembers).toHaveBeenCalledTimes(1);
    w.state.rows = [strangerRow(1)];
    w.sync.deps!.onGroupChanged(GROUP, applied(2));
    await vi.waitFor(() => expect(w.routes.listMembers).toHaveBeenCalledTimes(2));
    expect(w.routes.listMembers).toHaveBeenLastCalledWith(COMMUNITY);
    w.state.rows = [strangerRow(1), strangerRow(2)];
    w.sync.deps!.onGroupChanged(GROUP, applied(2));
    await settle();
    expect(w.routes.listMembers).toHaveBeenCalledTimes(2);
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
    expect(w.sync.send).not.toHaveBeenCalled();
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
    expect(w.routes.listChannels).not.toHaveBeenCalled();
    expect(w.routes.listMembers).not.toHaveBeenCalled();
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
    expect(w.sync.setChannels).toHaveBeenLastCalledWith([]);
    expect(w.routes.listChannels).toHaveBeenCalledTimes(1);
    // Nothing is selected any more: the next ready reads no channel list, and a send to its channel is refused.
    w.gateway.emit({ type: 'ready', info: READY_INFO });
    await vi.waitFor(() => expect(w.routes.listCommunities).toHaveBeenCalledTimes(3));
    await settle();
    expect(w.routes.listChannels).toHaveBeenCalledTimes(1);
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

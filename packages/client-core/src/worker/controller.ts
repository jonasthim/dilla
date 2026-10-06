// The composition root inside the core worker (L-TS-09): it answers the page's commands, owns the boot
// phases, wires the HTTP client, the session, the gateway and the sync engine together, and publishes
// the state slices (L-TS-08). It posts only ret and slice messages, to its own page only.
import type { BootOutcome } from '../account/boot';
import { refillKeyPackages } from '../account/keypackages';
import { Session } from '../account/session';
import { Signup, publishDeviceList } from '../account/signup';
import { CborError } from '../cbor';
import { CoreError, type ApplyResult, type CorePort, type ExpectedGroup, type GroupInfo, type Id } from '../core-port';
import { CLIENT_CLOSE, GATEWAY, Gateway, type GatewayDeps, type GatewayEvent, type ReadyInfo } from '../gateway/gateway';
import { fromHex, toHex } from '../hex';
import { HttpClient } from '../http/client';
import { DillaHttpError } from '../http/errors';
import { Routes, type ChannelRow, type Instance, type Limits, type MemberRow } from '../http/routes';
import { buildTimeline, channelGroup, channelGroupState, type GroupMembership } from '../state/derive';
import { SliceStore } from '../state/store';
import {
  TIMELINE_PAGE, type AccountState, type BootPhase, type ChannelGroupState, type ChannelSummary, type ConnectionState,
  type TimelineItem, type WorkerError,
} from '../state/types';
import { SyncEngine, type SyncDeps } from '../sync/engine';
import { SyncError } from '../sync/errors';
import { LEADER, acquireLeadership, lockName, type LockManagerLike } from './leader';
import { isTestHook, isToWorker, type Command, type FromWorker } from './protocol';

export interface ControllerDeps {
  origin: string;                                  // the page origin, e.g. http://127.0.0.1:8453
  fetch: typeof fetch; WebSocket: typeof WebSocket; locks: LockManagerLike;
  now(): number;                                   // ms
  random(): number;
  setTimeout(fn: () => void, ms: number): number; clearTimeout(id: number): void;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  boot(instance: Instance): Promise<BootOutcome>;
  resetDevice(instance: Instance): Promise<void>;  // removes the KEK record and the OPFS directory dilla/<instance hex>
  post(message: FromWorker): void;
  testHooks: boolean;
  parts?: Partial<ControllerParts>;                // unit tests only; the runtime passes none
}

/** The composition seams. REAL_PARTS builds the real classes; a unit test replaces any of them with a double
 *  cast through unknown (a class with private members is not structurally satisfiable). */
export interface ControllerParts {
  routes(http: HttpClient): Routes;
  session(deps: { core: CorePort; routes: Routes; now(): number }): Session;
  signup(deps: { core: CorePort; routes: Routes; session: Session; now(): number }): Signup;
  gateway(deps: GatewayDeps): Gateway;
  sync(deps: SyncDeps): SyncEngine;
}

export const REAL_PARTS: ControllerParts = {
  routes: (h) => new Routes(h),
  session: (d) => new Session(d),
  signup: (d) => new Signup(d),
  gateway: (d) => new Gateway(d),
  sync: (d) => new SyncEngine(d),
};

/** A refusal of the controller's own (E_BAD_INPUT, E_NOT_READY, E_INVITE_NOT_COMMUNITY). */
class Refusal extends Error {
  constructor(readonly code: string, readonly detail: string) {
    super(detail === '' ? code : `${code}: ${detail}`);
    this.name = 'Refusal';
  }
}

const ACCOUNT_CODES = new Set(['E_KEK_EXISTS', 'E_KEK_UNWRAP', 'E_SESSION_SCOPE']);

/** The one mapping from a thrown value to what crosses to the page (L-TS-08 WorkerError, ruling 33). */
function errorOf(e: unknown): WorkerError {
  if (e instanceof DillaHttpError) return { code: e.code, detail: e.detail, status: e.status, retryAfterMs: e.retryAfterMs };
  if (e instanceof CoreError || e instanceof SyncError) return { code: e.code, detail: e.detail, status: 0, retryAfterMs: null };
  if (e instanceof CborError) return { code: e.code, detail: e.message, status: 0, retryAfterMs: null };
  if (e instanceof Error && ACCOUNT_CODES.has(e.message)) return { code: e.message, detail: '', status: 0, retryAfterMs: null };
  if (e instanceof Refusal) return { code: e.code, detail: e.detail, status: 0, retryAfterMs: null };
  return { code: 'E_INTERNAL', detail: e instanceof Error ? e.message : String(e), status: 0, retryAfterMs: null };
}

type Method = Command['m'];
const COMMANDS: ReadonlySet<string> = new Set<Method>([
  'start', 'signupBegin', 'signupSubmit', 'signupReset', 'resetDevice', 'joinCommunity', 'selectCommunity',
  'openChannel', 'closeChannel', 'loadEarlier', 'send', 'retrySend', 'discardSend',
]);
const ID = /^[0-9a-f]{32}$/;
const ID_FIELDS: Partial<Record<Method, readonly ('communityId' | 'channelId' | 'msgId')[]>> = {
  selectCommunity: ['communityId'], openChannel: ['channelId'], closeChannel: ['channelId'], loadEarlier: ['channelId'],
  send: ['channelId'], retrySend: ['msgId'], discardSend: ['msgId'],
};
/** The commands each phase accepts besides start, which every phase accepts (requirement 9). */
const ACCEPTS: Record<BootPhase, readonly Method[]> = {
  'loading': [], 'other-tab': [], 'unsupported': [], 'revoked': [], 'error': [], 'registering': [],
  'store-lost': ['resetDevice'],
  'needs-signup': ['signupBegin'],
  'signup-keys': ['signupSubmit', 'signupReset'],
  'ready': ['joinCommunity', 'selectCommunity', 'openChannel', 'closeChannel', 'loadEarlier', 'send', 'retrySend', 'discardSend'],
};

/** The synchronous input checks, in the order requirement 5 fixes; null when the command is well formed. */
function invalid(command: Record<string, unknown>): string | null {
  const m = command.m as string;
  if (!COMMANDS.has(m)) return `unknown command ${m}`;
  for (const field of ID_FIELDS[m as Method] ?? []) {
    const value = command[field];
    if (typeof value !== 'string' || !ID.test(value)) return `${field} is not 32 lowercase hex`;
  }
  if (m === 'joinCommunity' && (typeof command.invite !== 'string' || command.invite.trim() === '')) return 'invite is empty';
  if (m === 'send' && (typeof command.text !== 'string' || command.text.trim() === '')) return 'the message is empty';
  if (m === 'signupSubmit') {
    for (const field of ['invite', 'username', 'display'] as const) {
      if (typeof command[field] !== 'string') return `${field} is not a string`;
    }
    if (command.password !== null && typeof command.password !== 'string') return 'password is not a string';
    if (command.recoveryKeyAcknowledged !== true) return 'the recovery key is not acknowledged';
  }
  return null;
}

interface KnownChannel { communityId: string; row: ChannelRow }
interface OpenChannel { groupId: Id | null; limit: number }

export class Controller {
  private readonly parts: ControllerParts;
  private readonly slices: SliceStore;
  private readonly routes: Routes;
  private instance: Instance | null = null;
  private limits: Limits | null = null;
  private starting: Promise<null> | null = null;
  private resetting: Promise<null> | null = null;
  private graceTimer: number | null = null;
  private phase: BootPhase = 'loading';
  private accountState: AccountState = { phase: 'loading', instance: null, user: null, deviceId: null, recoveryKey: null, error: null };
  private connectionState: ConnectionState = { status: 'offline', generation: null };
  private core: CorePort | null = null;
  private me: { userId: Id; deviceId: Id } | null = null;
  private session: Session | null = null;
  private signup: Signup | null = null;
  private gateway: Gateway | null = null;
  private sync: SyncEngine | null = null;
  private wasDown = false;
  private selected: string | null = null;
  private readonly channels = new Map<string, KnownChannel>();
  private readonly refusedChannels = new Set<string>();
  private readonly notMember = new Set<string>();
  private readonly resyncing = new Set<string>();
  private readonly lookedUp = new Set<string>();
  private readonly open = new Map<string, OpenChannel>();
  private readonly opening = new Map<string, { run: Promise<null>; entry: OpenChannel | null }>();

  constructor(private readonly deps: ControllerDeps) {
    this.parts = { ...REAL_PARTS, ...deps.parts };
    this.slices = new SliceStore((name, rev, value) => { deps.post({ t: 'slice', name, rev, value }); });
    const http = new HttpClient({
      baseUrl: deps.origin,
      fetch: deps.fetch,
      now: () => deps.now(),
      sleep: (ms, signal) => deps.sleep(ms, signal),
      random: () => deps.random(),
      token: () => this.session?.token() ?? null,
      reauthenticate: async () => {
        const session = this.session;
        if (session === null) return false;
        const ok = await session.establish();
        if (!ok) this.enterRevoked();
        return ok;
      },
      onGeneration: (generation) => { this.setConnection({ generation: generation.toString() }); },
    });
    this.routes = this.parts.routes(http);
  }

  handle(data: unknown): void {
    if (isTestHook(data)) {
      if (!this.deps.testHooks || this.gateway === null) return;
      if (data.op === 'gateway-stop') this.gateway.stop();
      else this.gateway.start();
      return;
    }
    if (!isToWorker(data)) return;
    const { id } = data;
    const problem = invalid(data.command);
    if (problem !== null) { this.refuse(id, 'E_BAD_INPUT', problem); return; }
    const command = data.command;
    if (command.m !== 'start' && !ACCEPTS[this.phase].includes(command.m)) {
      this.refuse(id, 'E_NOT_READY', `the phase is ${this.phase}`);
      return;
    }
    this.answer(id, this.run(command));
  }

  // ---- answers ----

  private refuse(id: number, code: string, detail: string): void {
    this.deps.post({ t: 'ret', id, ok: false, error: { code, detail, status: 0, retryAfterMs: null } });
  }

  private answer(id: number, work: Promise<unknown>): void {
    void work.then(
      (value) => { this.deps.post({ t: 'ret', id, ok: true, value }); },
      (e: unknown) => { this.deps.post({ t: 'ret', id, ok: false, error: errorOf(e) }); },
    );
  }

  /** Every command answers through its promise, also when it throws before its first await. */
  private run(command: Command): Promise<unknown> {
    try { return this.dispatch(command); }
    catch (e) { return Promise.reject(e instanceof Error ? e : new Error(String(e))); }
  }

  private dispatch(command: Command): Promise<unknown> {
    switch (command.m) {
      case 'start': return this.start();
      case 'signupBegin': return this.signupBegin();
      case 'signupSubmit': return this.signupSubmit(command);
      case 'signupReset': return this.signupReset();
      case 'resetDevice': return this.resetDevice();
      case 'joinCommunity': return this.joinCommunity(command.invite);
      case 'selectCommunity': return this.selectCommunity(command.communityId);
      case 'openChannel': return this.openChannel(command.channelId);
      case 'closeChannel': return this.closeChannel(command.channelId);
      case 'loadEarlier': return this.loadEarlier(command.channelId);
      case 'send': return this.send(command.channelId, command.text);
      case 'retrySend': return this.retrySend(command.msgId);
      case 'discardSend': return this.discardSend(command.msgId);
    }
  }

  // ---- slices ----

  private setAccount(patch: Partial<AccountState>): void {
    this.accountState = { ...this.accountState, ...patch };
    this.phase = this.accountState.phase;
    this.slices.set('account', this.accountState);
  }

  private setConnection(patch: Partial<ConnectionState>): void {
    this.connectionState = { ...this.connectionState, ...patch };
    this.slices.set('connection', this.connectionState);
  }

  // ---- start, leadership and boot ----

  private start(): Promise<null> {
    this.starting ??= this.startOnce();
    return this.starting;
  }

  private async startOnce(): Promise<null> {
    this.setAccount({ phase: 'loading', instance: null, user: null, deviceId: null, recoveryKey: null, error: null });
    this.setConnection({ status: 'offline', generation: null });
    let instance: Instance;
    try {
      instance = await this.routes.getInstance();
      this.limits = await this.routes.getLimits();
    } catch (e) {
      this.setAccount({ phase: 'error', error: errorOf(e) });
      throw e;
    }
    this.instance = instance;
    this.setAccount({ instance: {
      id: toHex(instance.instanceId), name: instance.name, registrationMode: instance.registrationMode,
      passwordSignup: instance.authMethods.includes(0),
    } });
    void this.lead(instance);
    return null;
  }

  private async lead(instance: Instance): Promise<void> {
    try {
      await acquireLeadership(this.deps.locks, lockName(toHex(instance.instanceId)), () => {
        // Pre-flight ruling 4: the blocking request is already queued; other-tab shows only after the grace.
        this.graceTimer = this.deps.setTimeout(() => {
          this.graceTimer = null;
          if (this.phase === 'loading') this.setAccount({ phase: 'other-tab' });
        }, LEADER.otherTabGraceMs);
      });
    } catch (e) {
      this.setAccount({ phase: 'error', error: errorOf(e) });
      return;
    }
    if (this.graceTimer !== null) { this.deps.clearTimeout(this.graceTimer); this.graceTimer = null; }
    if (this.phase === 'other-tab') this.setAccount({ phase: 'loading' });
    await this.bootStore(instance);
  }

  /** deps.boot, then the phase the store's identity calls for (requirement 10). Never throws. */
  private async bootStore(instance: Instance): Promise<void> {
    try {
      const outcome = await this.deps.boot(instance);
      if (outcome.kind === 'unsupported') {
        this.setAccount({ phase: 'unsupported', error: { code: 'E_UNSUPPORTED', detail: outcome.reason, status: 0, retryAfterMs: null } });
        return;
      }
      if (outcome.kind === 'store-lost') { this.setAccount({ phase: 'store-lost' }); return; }
      const core = outcome.core;
      this.core = core;
      const now = (): number => this.deps.now();
      const session = this.parts.session({ core, routes: this.routes, now });
      this.session = session;
      const signup = this.parts.signup({ core, routes: this.routes, session, now });
      this.signup = signup;
      const phase = core.identity().phase;
      if (phase === 0) { this.setAccount({ phase: 'needs-signup' }); return; }
      if (phase === 1) {
        const resumed = await signup.resume();
        if (resumed === 0) this.setAccount({ phase: 'needs-signup' });
        else if (resumed === 2) await this.enterReady();
        // A refused device whose account exists: nothing is deleted, signupReset is never called here.
        else this.enterRevoked();
        return;
      }
      await this.enterReady();
    } catch (e) {
      // After a revocation the error is its consequence (a 401 that reauthenticate turned into revoked).
      if (!this.revoked()) this.setAccount({ phase: 'error', error: errorOf(e) });
    }
  }

  private resetDevice(): Promise<null> {
    this.resetting ??= this.resetOnce().finally(() => { this.resetting = null; });
    return this.resetting;
  }

  private async resetOnce(): Promise<null> {
    const instance = this.requireInstance();
    await this.deps.resetDevice(instance);
    await this.bootStore(instance);
    return null;
  }

  // ---- ready and revoked ----

  /** Requirement 13, in order; after every await a revocation that happened meanwhile ends it silently. */
  private async enterReady(): Promise<void> {
    const core = this.requireCore();
    const session = this.session;
    if (session === null) throw new CoreError('E_CORE_STATE', 'no session');
    const ok = await session.ensure();
    if (this.revoked()) return;
    if (!ok) { this.enterRevoked(); return; }
    await publishDeviceList(core, this.routes);
    if (this.revoked()) return;
    const identity = core.identity();
    if (identity.userId === null || identity.deviceId === null) throw new CoreError('E_CORE_NO_IDENTITY', '');
    const userId = identity.userId;
    const deviceId = identity.deviceId;
    this.me = { userId, deviceId };
    if (this.gateway === null) {
      const instance = this.requireInstance();
      const now = (): number => this.deps.now();
      const random = (): number => this.deps.random();
      const setTimeout = (fn: () => void, ms: number): number => this.deps.setTimeout(fn, ms);
      const clearTimeout = (handle: number): void => { this.deps.clearTimeout(handle); };
      const gateway = this.parts.gateway({
        url: this.deps.origin.replace(/^http/, 'ws') + '/gateway',
        mintTicket: async () => (await this.routes.postTicket()).ticket,
        WebSocket: this.deps.WebSocket, now, random, setTimeout, clearTimeout,
      });
      this.gateway = gateway;
      gateway.subscribe((e) => { this.onGateway(e); });
      const sync = this.parts.sync({
        core, routes: this.routes, gateway, instance, deviceId, now, random, setTimeout, clearTimeout,
        onGroupChanged: (g, result) => { this.onGroupChanged(g, result); },
        onOutboxChanged: (g) => { this.safely(() => { this.touchGroup(g); }); },
        onMembership: (g, status) => { this.onMembership(g, status); },
        onJoinAll: () => undefined,
        onUnexpectedWelcome: () => undefined,
      });
      this.sync = sync;
      // Pre-flight ruling 2: the engine subscribes before the gateway can report its first ready.
      sync.start();
      this.wasDown = false;
      gateway.start();
    }
    await this.refreshCommunities();
    if (this.revoked()) return;
    this.setAccount({
      phase: 'ready', user: { id: toHex(userId), username: identity.username }, deviceId: toHex(deviceId),
      recoveryKey: null, error: null,
    });
  }

  /** Read through a call: tsc keeps a narrowing of this.phase across awaits, but a revocation can land in any of them. */
  private revoked(): boolean { return this.phase === 'revoked'; }

  /** The one revoked path (ruling 29): idempotent. */
  private enterRevoked(): void {
    if (this.revoked()) return;
    this.sync?.stop();
    this.gateway?.stop();
    this.setAccount({ phase: 'revoked', recoveryKey: null });
  }

  private onGateway(e: GatewayEvent): void {
    if (e.type === 'status') {
      let status: ConnectionState['status'];
      switch (e.status) {
        case 'ready': this.wasDown = false; status = 'online'; break;
        case 'waiting': this.wasDown = true; status = 'offline'; break;
        case 'connecting': status = this.wasDown ? 'offline' : 'connecting'; break;
        case 'idle': status = 'offline'; break;
      }
      // A version refusal leaves the gateway idle for good, so the page is told why (L-TS-08 reason);
      // every other status change drops the reason.
      const { generation } = this.connectionState;
      this.connectionState = e.status === 'idle' && e.closeCode === CLIENT_CLOSE.version
        ? { status, generation, reason: 'version' }
        : { status, generation };
      this.slices.set('connection', this.connectionState);
    } else if (e.type === 'ready') {
      this.onReady(e.info);
    } else if (e.type === 'revoked') {
      void this.onRevokedSocket();
    }
  }

  private onReady(info: ReadyInfo): void {
    this.setConnection({ generation: info.generation.toString() });
    const core = this.core;
    const limits = this.limits;
    if (core !== null && limits !== null) {
      refillKeyPackages(core, this.routes, info.keypackagesRemaining,
        { perDevice: limits.keypackagesPerDevice, threshold: limits.keypackageRefillThreshold }).catch(() => undefined);
    }
    void this.refreshAfterReady();
  }

  /** Every ready refreshes the community list, then the selected community's two lists; a failure waits for the next ready. */
  private async refreshAfterReady(): Promise<void> {
    try { await this.refreshCommunities(); } catch { /* the next ready retries */ }
    const selected = this.selected;
    if (selected === null) return;
    try { await this.loadCommunity(selected); } catch { /* the next ready retries */ }
  }

  private async onRevokedSocket(): Promise<void> {
    const session = this.session;
    if (session === null || this.revoked()) return;
    try {
      const ok = await session.establish();
      if (this.revoked()) return;
      if (ok) this.gateway?.start();
      else this.enterRevoked();
    } catch {
      // Not a refusal (a network failure, a 5xx): try the socket again later; a refused ticket comes back here.
      if (this.revoked()) return;
      this.deps.setTimeout(() => { if (!this.revoked()) this.gateway?.start(); }, GATEWAY.reconnectCapMs);
    }
  }

  // ---- signup ----

  private signupBegin(): Promise<null> {
    const recoveryKey = this.requireSignup().begin(this.requireInstance().instanceId);
    this.setAccount({ phase: 'signup-keys', recoveryKey, error: null });
    return Promise.resolve(null);
  }

  private signupReset(): Promise<null> {
    this.requireCore().signupReset();
    this.setAccount({ phase: 'needs-signup', recoveryKey: null });
    return Promise.resolve(null);
  }

  /** Requirement 11 (ruling 34): the invite is read first, the account registered, ready entered, and the
   *  community the invite names joined; a refused join is a result, never a failed signup. */
  private async signupSubmit(c: Extract<Command, { m: 'signupSubmit' }>): Promise<{ communityId: string | null; joinError: WorkerError | null }> {
    const signup = this.requireSignup();
    const core = this.requireCore();
    const invite = c.invite.trim();
    this.setAccount({ phase: 'registering', error: null });
    let communityId: Id | null = null;
    if (invite !== '') {
      try {
        communityId = (await this.routes.getInvite(invite)).communityId;
      } catch (e) {
        if (e instanceof DillaHttpError && e.code === 'E_INVITE_INVALID') {
          this.setAccount({ phase: 'signup-keys', error: errorOf(e) });
          throw e;
        }
        // Any other failure of this read: the server stays the authority at registration.
        communityId = null;
      }
    }
    try {
      await signup.submit({ invite, username: c.username, display: c.display, password: c.password });
    } catch (e) {
      if (core.identity().phase !== 2) {
        if (!this.revoked()) this.setAccount({ phase: 'signup-keys', error: errorOf(e) });
        throw e;
      }
      // The account exists; entering ready publishes what the submit could not.
    }
    if (this.phase === 'registering') this.setAccount({ recoveryKey: null });
    try {
      await this.enterReady();
    } catch (e) {
      if (!this.revoked()) this.setAccount({ phase: 'error', error: errorOf(e), recoveryKey: null });
      throw e;
    }
    if (this.phase !== 'ready' || communityId === null) return { communityId: null, joinError: null };
    try {
      const joined = await this.joinPath(communityId, invite);
      return { communityId: joined.communityId, joinError: null };
    } catch (e) {
      return { communityId: null, joinError: errorOf(e) };
    }
  }

  // ---- communities ----

  private listed(communityId: string): boolean {
    return (this.slices.get('communities') ?? []).some((c) => c.id === communityId);
  }

  private async refreshCommunities(): Promise<void> {
    const rows = await this.routes.listCommunities();
    const list = rows.map((r) => ({ id: toHex(r.id), name: r.name }));
    this.slices.set('communities', list);
    // Pre-flight ruling 1(vi): a community that is no longer listed loses its selection and its slices.
    const gone = new Set<string>();
    for (const known of this.channels.values()) if (!this.listed(known.communityId)) gone.add(known.communityId);
    if (this.selected !== null && !this.listed(this.selected)) gone.add(this.selected);
    for (const communityId of gone) this.dropCommunity(communityId);
  }

  private dropCommunity(communityId: string): void {
    if (this.selected === communityId) this.selected = null;
    for (const [channelId, known] of this.channels) {
      if (known.communityId !== communityId) continue;
      this.channels.delete(channelId);
      this.open.delete(channelId);
    }
    this.slices.set(`channels:${communityId}`, []);
    this.slices.set(`members:${communityId}`, []);
    this.updateSyncChannels();
  }

  private async joinCommunity(rawInvite: string): Promise<{ communityId: string }> {
    const invite = rawInvite.trim();
    const info = await this.routes.getInvite(invite);
    if (info.communityId === null) throw new Refusal('E_INVITE_NOT_COMMUNITY', '');
    return this.joinPath(info.communityId, invite);
  }

  private async joinPath(communityId: Id, invite: string): Promise<{ communityId: string }> {
    await this.routes.joinCommunity(communityId, invite);
    // Pre-flight ruling 1(vii): the account joined; a failed refresh of the list does not undo that.
    try { await this.refreshCommunities(); } catch { /* the next ready refreshes it */ }
    return { communityId: toHex(communityId) };
  }

  private async selectCommunity(communityId: string): Promise<null> {
    if (!this.listed(communityId)) throw new Refusal('E_BAD_INPUT', 'unknown community');
    this.selected = communityId;
    await this.loadCommunity(communityId);
    return null;
  }

  /** The channel and member lists of one community (requirement 15). */
  private async loadCommunity(communityId: string): Promise<void> {
    const id = fromHex(communityId);
    const rows = await this.routes.listChannels(id);
    const members = await this.routes.listMembers(id);
    if (!this.listed(communityId)) return;
    for (const [channelId, known] of this.channels) if (known.communityId === communityId) this.channels.delete(channelId);
    for (const row of rows) this.channels.set(toHex(row.id), { communityId, row });
    this.publishChannels(communityId);
    this.publishMembers(communityId, members);
    this.updateSyncChannels();
  }

  private publishMembers(communityId: string, rows: readonly MemberRow[]): void {
    this.slices.set(`members:${communityId}`,
      rows.map((m) => ({ userId: toHex(m.userId), username: m.username, display: m.display, kind: m.kind })));
  }

  private publishChannels(communityId: string): void {
    const groups = this.core?.groups() ?? [];
    const list: ChannelSummary[] = [];
    for (const [channelId, known] of this.channels) {
      if (known.communityId !== communityId) continue;
      const row = known.row;
      list.push({
        id: channelId, communityId, kind: row.kind as ChannelSummary['kind'], mode: row.mode as ChannelSummary['mode'],
        name: row.name, topic: row.topic, parentId: row.parentId === null ? null : toHex(row.parentId), position: row.position,
        group: channelGroupState(row, groups, this.membership(channelId)),
      });
    }
    this.slices.set(`channels:${communityId}`, list);
  }

  private updateSyncChannels(): void {
    const policyVersion = this.instance?.policyVersion ?? 0n;
    const expected: ExpectedGroup[] = [];
    for (const [channelId, { communityId, row }] of this.channels) {
      if (row.kind !== 0 || row.mode !== 0 || row.textGroupId === null) continue;
      expected.push({ groupId: row.textGroupId, communityId: fromHex(communityId), channelId: fromHex(channelId), policyVersion });
    }
    this.sync?.setChannels(expected);
  }

  // ---- channels and timelines ----

  private membership(channelId: string): GroupMembership {
    return { refusedChannel: this.refusedChannels.has(channelId), notMember: this.notMember, resyncing: this.resyncing };
  }

  private groupState(channelId: string, groups: readonly GroupInfo[] = this.core?.groups() ?? []): ChannelGroupState {
    const known = this.channels.get(channelId);
    if (known === undefined) return 'none';
    return channelGroupState(known.row, groups, this.membership(channelId));
  }

  private openChannel(channelId: string): Promise<null> {
    // Pre-flight ruling 1(i): one open per channel in flight; a later call awaits it. A closeChannel
    // between the two (ruling 1(ii)) only cleared the open mark, so the later call marks the channel
    // open again with the in-flight open's own entry: the join's success then stores its group id in
    // it, and a failed join removes it as it would have without the close.
    const inFlight = this.opening.get(channelId);
    if (inFlight !== undefined) {
      if (inFlight.entry !== null && !this.open.has(channelId)) this.open.set(channelId, inFlight.entry);
      return inFlight.run;
    }
    const opening: { run: Promise<null>; entry: OpenChannel | null } = { run: Promise.resolve(null), entry: null };
    opening.run = this.openOnce(channelId, (entry) => { opening.entry = entry; })
      .finally(() => { this.opening.delete(channelId); });
    this.opening.set(channelId, opening);
    return opening.run;
  }

  private async openOnce(channelId: string, marked: (entry: OpenChannel) => void): Promise<null> {
    const known = this.channels.get(channelId);
    if (known === undefined) throw new Refusal('E_BAD_INPUT', 'unknown channel');
    const entry: OpenChannel = { groupId: this.open.get(channelId)?.groupId ?? null, limit: TIMELINE_PAGE };
    this.open.set(channelId, entry);
    marked(entry);
    if (this.groupState(channelId) === 'unsupported') {
      this.slices.set(`timeline:${channelId}`, { channelId, group: 'unsupported', items: [], hasEarlier: false });
      return null;
    }
    this.refreshTimeline(channelId);
    try {
      const result = await this.requireSync().openChannel({
        communityId: fromHex(known.communityId), channelId: fromHex(channelId), textGroupId: known.row.textGroupId,
      });
      this.refusedChannels.delete(channelId);
      // Pre-flight ruling 1(ii): a channel closed meanwhile gets fresh slices but is not opened again.
      const current = this.open.get(channelId);
      if (current !== undefined) current.groupId = result.groupId;
      this.refreshChannel(channelId);
      this.refreshTimeline(channelId, result.groupId);
      return null;
    } catch (e) {
      if (e instanceof DillaHttpError && e.status === 403) {
        this.refusedChannels.add(channelId);
        this.refreshChannel(channelId);
        this.refreshTimeline(channelId);
        return null;
      }
      if (this.open.get(channelId) === entry) this.open.delete(channelId);
      throw e;
    }
  }

  private closeChannel(channelId: string): Promise<null> {
    this.open.delete(channelId);
    return Promise.resolve(null);
  }

  private loadEarlier(channelId: string): Promise<null> {
    const entry = this.open.get(channelId);
    if (entry !== undefined) {
      entry.limit += TIMELINE_PAGE;
      this.refreshTimeline(channelId);
    }
    return Promise.resolve(null);
  }

  private refreshChannel(channelId: string): void {
    const known = this.channels.get(channelId);
    if (known !== undefined) this.publishChannels(known.communityId);
  }

  /** The group id a channel's timeline is read from: the one its open resolved to, else the local group. */
  private timelineGroup(channelId: string, groups: readonly GroupInfo[], hint?: Id): Id | null {
    return this.open.get(channelId)?.groupId ?? hint ?? channelGroup(fromHex(channelId), groups)?.groupId ?? null;
  }

  private refreshTimeline(channelId: string, hint?: Id): void {
    const known = this.channels.get(channelId);
    const core = this.core;
    const me = this.me;
    if (known === undefined || core === null || me === null) return;
    const groups = core.groups();
    const group = this.groupState(channelId, groups);
    if (group === 'unsupported') {
      this.slices.set(`timeline:${channelId}`, { channelId, group, items: [], hasEarlier: false });
      return;
    }
    const limit = this.open.get(channelId)?.limit ?? TIMELINE_PAGE;
    const groupId = this.timelineGroup(channelId, groups, hint);
    const timeline = buildTimeline({
      channelId, group, rows: groupId === null ? [] : core.timeline(groupId, 0n, limit),
      outbox: groupId === null ? [] : core.outbox(groupId), ownUser: me.userId, ownDevice: me.deviceId, limit,
    });
    this.slices.set(`timeline:${channelId}`, timeline);
    this.lookUpMembers(known.communityId, timeline.items);
  }

  /** A sender who is not in the loaded member list re-runs listMembers once per unknown user (L-TS-09). */
  private lookUpMembers(communityId: string, items: readonly TimelineItem[]): void {
    const known = new Set((this.slices.get(`members:${communityId}`) ?? []).map((m) => m.userId));
    let unknown = false;
    for (const item of items) {
      const user = item.senderUser;
      if (user === null || known.has(user) || this.lookedUp.has(user)) continue;
      this.lookedUp.add(user);
      unknown = true;
    }
    if (!unknown) return;
    void (async () => {
      const rows = await this.routes.listMembers(fromHex(communityId));
      if (this.listed(communityId)) this.publishMembers(communityId, rows);
    })().catch(() => undefined);
  }

  // ---- the sync engine's reports ----

  /** A report from the engine must never throw back into it. */
  private safely(fn: () => void): void {
    try { fn(); } catch { /* the next report or command refreshes the slices */ }
  }

  private onGroupChanged(groupId: Id, result: ApplyResult): void {
    const hex = toHex(groupId);
    if (result.state === 2) { this.resyncing.delete(hex); this.notMember.delete(hex); }
    this.safely(() => { this.touchGroup(groupId); });
  }

  private onMembership(groupId: Id, status: 'resyncing' | 'not-member'): void {
    const hex = toHex(groupId);
    if (status === 'resyncing') { this.resyncing.add(hex); this.notMember.delete(hex); }
    else { this.notMember.add(hex); this.resyncing.delete(hex); }
    this.safely(() => { this.touchGroup(groupId); });
  }

  /** Refreshes the channels: row of every known channel bound to the group and the timeline of every such open channel. */
  private touchGroup(groupId: Id): void {
    const hex = toHex(groupId);
    const groups = this.core?.groups() ?? [];
    const communities = new Set<string>();
    const timelines: string[] = [];
    for (const [channelId, { communityId, row }] of this.channels) {
      const openGroup = this.open.get(channelId)?.groupId ?? null;
      const local = channelGroup(fromHex(channelId), groups);
      const bound = (row.textGroupId !== null && toHex(row.textGroupId) === hex)
        || (openGroup !== null && toHex(openGroup) === hex)
        || (local !== undefined && toHex(local.groupId) === hex);
      if (!bound) continue;
      communities.add(communityId);
      if (this.open.has(channelId)) timelines.push(channelId);
    }
    for (const communityId of communities) this.publishChannels(communityId);
    for (const channelId of timelines) this.refreshTimeline(channelId);
  }

  // ---- sending ----

  private send(channelId: string, text: string): Promise<{ msgId: string }> {
    const entry = this.open.get(channelId);
    if (entry === undefined) return Promise.reject(new Refusal('E_NOT_READY', 'the channel is not open'));
    const groups = this.requireCore().groups();
    const state = this.groupState(channelId, groups);
    const groupId = this.timelineGroup(channelId, groups);
    if (state !== 'active' || groupId === null) return Promise.reject(new Refusal('E_NOT_READY', `the channel's group is ${state}`));
    // The core enforces the 4000-byte limit (E_ENVELOPE_LIMIT); the controller does not measure the text.
    const msgId = this.requireSync().send(groupId, text);
    this.refreshTimeline(channelId);
    return Promise.resolve({ msgId: toHex(msgId) });
  }

  /** Pre-flight ruling 1(iv): a message id that no outbox holds is an idempotent no-op. */
  private inOutbox(msgId: string): boolean {
    const core = this.requireCore();
    return core.groups().some((g) => core.outbox(g.groupId).some((row) => toHex(row.msgId) === msgId));
  }

  private retrySend(msgId: string): Promise<null> {
    if (this.inOutbox(msgId)) this.requireSync().retry(fromHex(msgId));
    return Promise.resolve(null);
  }

  private discardSend(msgId: string): Promise<null> {
    if (this.inOutbox(msgId)) this.requireSync().discard(fromHex(msgId));
    return Promise.resolve(null);
  }

  // ---- invariants ----

  private requireInstance(): Instance {
    if (this.instance === null) throw new CoreError('E_CORE_STATE', 'no instance');
    return this.instance;
  }

  private requireCore(): CorePort {
    if (this.core === null) throw new CoreError('E_CORE_STATE', 'no store');
    return this.core;
  }

  private requireSignup(): Signup {
    if (this.signup === null) throw new CoreError('E_CORE_STATE', 'no signup');
    return this.signup;
  }

  private requireSync(): SyncEngine {
    if (this.sync === null) throw new CoreError('E_CORE_STATE', 'no sync');
    return this.sync;
  }
}

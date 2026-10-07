// The composition root inside the core worker (L-TS-09, L-TS-23): it answers the page's commands, owns the boot
// and sign-in phases, wires the HTTP client, the session, the enrolment, the gateway and the sync engine
// together, and publishes the state slices (L-TS-08, L-TS-24). It posts only ret and slice messages, to its
// own page only.
import type { BootOutcome } from '../account/boot';
import { Enrol, ensureBackups, refreshOwnDeviceList, repairBackupState, type EnrolFetched } from '../account/enrol';
import { refillKeyPackages } from '../account/keypackages';
import { Session } from '../account/session';
import { Signup, publishDeviceList } from '../account/signup';
import { AttachmentError, MAX_ATTACHMENTS } from '../attachments/crypto';
import { fetchAttachment, thumbnailBlob } from '../attachments/download';
import { safeName } from '../attachments/name';
import type { ThumbDeps } from '../attachments/thumb';
import { Tray, type TrayEntry } from '../attachments/tray';
import { CborError } from '../cbor';
import {
  CoreError, type ActivityRow, type ApplyResult, type AttachmentDescriptor, type CorePort, type ExpectedGroup, type GroupInfo, type Id,
  type OutboxRow, type SendRequest, type SignedLists, type TimelineRow,
} from '../core-port';
import { CLIENT_CLOSE, GATEWAY, Gateway, type GatewayDeps, type GatewayEvent, type ReadyInfo } from '../gateway/gateway';
import { fromHex, toHex } from '../hex';
import { HttpClient } from '../http/client';
import { DillaHttpError } from '../http/errors';
import { Routes, type ChannelRow, type Instance, type Limits, type MemberRow } from '../http/routes';
import { NOTICE_READ_MAX, appendNotices, buildBadges, noticeOf, type NoticeDraft } from '../state/badges';
import { buildTimeline, channelGroup, channelGroupState, type GroupMembership } from '../state/derive';
import { isSettingKey, isSettingValue } from '../state/settings';
import { SliceStore } from '../state/store';
import {
  TIMELINE_PAGE, type AccountState, type BootPhase, type ChannelGroupState, type ChannelSummary, type ConnectionState,
  type DeviceSummary, type DmSummary, type NoticesState, type PinnedItem, type TimelineItem, type TrayItem, type WorkerError,
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
  parts?: Partial<ControllerParts>;                // unit tests and the core-worker harness only; src/worker/entry.ts passes none
  thumbs?: ThumbDeps | null;                       // unit tests only; absent: probed from the worker global (L-TS-35)
}

/** The composition seams. REAL_PARTS builds the real classes; a unit test replaces any of them with a double
 *  cast through unknown (a class with private members is not structurally satisfiable). */
export interface ControllerParts {
  routes(http: HttpClient): Routes;
  session(deps: { core: CorePort; routes: Routes; now(): number }): Session;
  signup(deps: { core: CorePort; routes: Routes; session: Session; now(): number }): Signup;
  gateway(deps: GatewayDeps): Gateway;
  sync(deps: SyncDeps): SyncEngine;
  enrol(deps: { core: CorePort; routes: Routes; session: Session; now(): number }): Enrol;
  publishDeviceList(core: CorePort, routes: Routes): Promise<void>;
  ensureBackups(core: CorePort, routes: Routes): Promise<void>;
  refreshOwnDeviceList(core: CorePort, routes: Routes, userId: Id): Promise<{ version: bigint; listed: boolean }>;
  repairBackupState(core: CorePort, routes: Routes): Promise<boolean>;
}
// No EnrolRate class and no E_ENROL_RATE code (head ruling 38 as amended): registration answers no per-user 429.

export const REAL_PARTS: ControllerParts = {
  routes: (h) => new Routes(h),
  session: (d) => new Session(d),
  signup: (d) => new Signup(d),
  gateway: (d) => new Gateway(d),
  sync: (d) => new SyncEngine(d),
  enrol: (d) => new Enrol(d),
  publishDeviceList,
  ensureBackups,
  refreshOwnDeviceList,
  repairBackupState,
};

/** A refusal of the controller's own (E_BAD_INPUT, E_NOT_READY, E_INVITE_NOT_COMMUNITY, E_SETTING_KEY). */
class Refusal extends Error {
  constructor(readonly code: string, readonly detail: string) {
    super(detail === '' ? code : `${code}: ${detail}`);
    this.name = 'Refusal';
  }
}

const ACCOUNT_CODES = new Set([
  'E_KEK_EXISTS', 'E_KEK_UNWRAP', 'E_SESSION_SCOPE', 'E_NO_BACKUP', 'E_LIST_RACE', 'E_DEVICE_UNLISTED', 'E_NO_ASSERTION',
  'E_SIGNIN_EVICTED',
]);

/** The one mapping from a thrown value to what crosses to the page (L-TS-08 WorkerError, ruling 33). */
function errorOf(e: unknown): WorkerError {
  if (e instanceof DillaHttpError) return { code: e.code, detail: e.detail, status: e.status, retryAfterMs: e.retryAfterMs };
  if (e instanceof CoreError || e instanceof SyncError) return { code: e.code, detail: e.detail, status: 0, retryAfterMs: null };
  if (e instanceof CborError) return { code: e.code, detail: e.message, status: 0, retryAfterMs: null };
  if (e instanceof Error && ACCOUNT_CODES.has(e.message)) return { code: e.message, detail: '', status: 0, retryAfterMs: null };
  // The tray's and the download's refusals cross by code alone: their detail may name a file (L-TS-35).
  if (e instanceof AttachmentError) return { code: e.code, detail: '', status: 0, retryAfterMs: null };
  if (e instanceof Refusal) return { code: e.code, detail: e.detail, status: 0, retryAfterMs: null };
  return { code: 'E_INTERNAL', detail: e instanceof Error ? e.message : String(e), status: 0, retryAfterMs: null };
}

/** An account code thrown as Error(code) by the account modules (enrol.ts, signup.ts, session.ts). */
function isCode(e: unknown, code: string): boolean {
  return e instanceof Error && e.message === code;
}

function isStatus(e: unknown, status: number): boolean {
  return e instanceof DillaHttpError && e.status === status;
}

// The core's own refusal details the controller acts on where it makes the call (pre-flight rulings (c) and (e)
// of task 14; core/dilla-core/src/client/identity.rs). They are matched only here, inside the worker, at the
// call site; the page never switches on a detail: what crosses is E_LIST_RACE or E_NO_BACKUP.
const LIST_CONFLICT: ReadonlySet<string> = new Set([
  'the instance served an older device list', 'the instance served a different device list at the stored version',
]);
const STATE_UNUSABLE: ReadonlySet<string> = new Set(['the backup state is missing', 'the backup state could not be read']);
function coreInput(e: unknown, details: ReadonlySet<string>): boolean {
  return e instanceof CoreError && e.code === 'E_CORE_INPUT' && details.has(e.detail);
}

type Method = Command['m'];
const COMMANDS: ReadonlySet<string> = new Set<Method>([
  'start', 'signupBegin', 'signupSubmit', 'signupReset', 'resetDevice', 'joinCommunity', 'selectCommunity',
  'openChannel', 'closeChannel', 'loadEarlier', 'send', 'retrySend', 'discardSend',
  'signInBegin', 'signInLogin', 'signInTotp', 'signInKey', 'signInCancel', 'refreshDevices', 'revokeDevice', 'signOutRevoke',
  'forgetBrowser', 'markRead', 'setSetting', 'openDm',
  'editMessage', 'deleteMessage', 'react', 'pin', 'loadPins', 'closePins', 'attachFiles', 'discardAttachment', 'openAttachment',
]);
const ID = /^[0-9a-f]{32}$/;
const TOTP = /^[0-9]{6}$/;
const SEQ = /^[1-9][0-9]{0,19}$/;
const TRAY_ID_MAX = 64;
const EMOJI_MAX_BYTES = 32;
const UTF8 = new TextEncoder();
const ID_FIELDS: Partial<Record<Method, readonly ('communityId' | 'channelId' | 'msgId' | 'deviceId' | 'userId')[]>> = {
  selectCommunity: ['communityId'], openChannel: ['channelId'], closeChannel: ['channelId'], loadEarlier: ['channelId'],
  send: ['channelId'], retrySend: ['msgId'], discardSend: ['msgId'],
  revokeDevice: ['deviceId'], markRead: ['channelId'], openDm: ['userId'],
  editMessage: ['channelId', 'msgId'], deleteMessage: ['channelId', 'msgId'], react: ['channelId', 'msgId'], pin: ['channelId', 'msgId'],
  loadPins: ['channelId'], closePins: ['channelId'], attachFiles: ['channelId'], discardAttachment: ['channelId'],
  openAttachment: ['channelId'],
};
/** The commands each phase accepts besides start, which every phase accepts (requirement 1). */
const ACCEPTS: Record<BootPhase, readonly Method[]> = {
  'loading': [], 'other-tab': [], 'unsupported': [], 'error': [], 'registering': [], 'enrolling': [], 'cleared': [],
  // Pre-flight ruling (d) of task 14: a revoked browser can start over (the splash's "forget this browser").
  'revoked': ['forgetBrowser'],
  'store-lost': ['resetDevice'],
  'needs-signup': ['signupBegin', 'signInBegin'],
  'signup-keys': ['signupSubmit', 'signupReset'],
  'signin-login': ['signInLogin', 'signInCancel'],
  'signin-totp': ['signInTotp', 'signInCancel'],
  'signin-key': ['signInKey', 'signInCancel'],
  'ready': [
    'joinCommunity', 'selectCommunity', 'openChannel', 'closeChannel', 'loadEarlier', 'send', 'retrySend', 'discardSend',
    'refreshDevices', 'revokeDevice', 'signOutRevoke', 'forgetBrowser', 'markRead', 'setSetting', 'openDm',
    'editMessage', 'deleteMessage', 'react', 'pin', 'loadPins', 'closePins', 'attachFiles', 'discardAttachment', 'openAttachment',
  ],
};

const blank = (value: unknown): boolean => typeof value !== 'string' || value.trim() === '';

/** The synchronous input checks, in the order requirement 2 fixes; null when the command is well formed.
 *  Every refusal here answers only the owning page's own malformed command (deps.post reaches only that page). */
function invalid(command: Record<string, unknown>): string | null {
  const m = command.m as string;
  if (!COMMANDS.has(m)) return `unknown command ${m}`;
  for (const field of ID_FIELDS[m as Method] ?? []) {
    const value = command[field];
    if (typeof value !== 'string' || !ID.test(value)) return `${field} is not 32 lowercase hex`;
  }
  if (m === 'joinCommunity' && blank(command.invite)) return 'invite is empty';
  if (m === 'send') {
    const { replyTo, attachments } = command;
    if (replyTo !== undefined && replyTo !== null && (typeof replyTo !== 'string' || !ID.test(replyTo))) return 'replyTo is not 32 lowercase hex';
    if (attachments !== undefined && !(Array.isArray(attachments) && attachments.length <= MAX_ATTACHMENTS
      && attachments.every((t) => typeof t === 'string' && t.length >= 1 && t.length <= TRAY_ID_MAX))) {
      return `attachments is not a list of at most ${String(MAX_ATTACHMENTS)} tray ids`;
    }
    // DEV-W2-60: a message of attachments alone is allowed.
    if (blank(command.text) && !(Array.isArray(attachments) && attachments.length > 0)) return 'the message is empty';
  }
  if (m === 'editMessage' && blank(command.text)) return 'the message is empty';
  if (m === 'react') {
    const { emoji } = command;
    if (typeof emoji !== 'string' || emoji === '' || UTF8.encode(emoji).length > EMOJI_MAX_BYTES) return 'emoji must be 1..=32 bytes';
  }
  if ((m === 'react' || m === 'pin') && typeof command.on !== 'boolean') return 'on is not a boolean';
  if (m === 'attachFiles') {
    const { files } = command;
    if (!Array.isArray(files) || files.length === 0 || !files.every((f) => typeof File !== 'undefined' && f instanceof File)) {
      return 'files is not a non-empty list of files';
    }
  }
  if (m === 'discardAttachment' && (typeof command.trayId !== 'string' || command.trayId === '')) return 'trayId is empty';
  if (m === 'openAttachment') {
    if (typeof command.seq !== 'string' || !SEQ.test(command.seq)) return 'seq is not a decimal sequence number';
    const { index } = command;
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) return 'index is not a non-negative integer';
    if (typeof command.thumb !== 'boolean') return 'thumb is not a boolean';
  }
  if (m === 'signupSubmit') {
    for (const field of ['invite', 'username', 'display'] as const) {
      if (typeof command[field] !== 'string') return `${field} is not a string`;
    }
    if (command.password !== null && typeof command.password !== 'string') return 'password is not a string';
    if (command.recoveryKeyAcknowledged !== true) return 'the recovery key is not acknowledged';
  }
  if (m === 'signInLogin') {
    if (blank(command.username)) return 'username is empty';
    if (typeof command.password !== 'string' || command.password === '') return 'password is empty';
  }
  if (m === 'signInTotp' && (typeof command.code !== 'string' || !TOTP.test(command.code))) return 'code is not six digits';
  if ((m === 'signInKey' || m === 'signInLogin' || m === 'signInTotp' || m === 'signOutRevoke') && blank(command.recoveryKey)) {
    return 'the recovery key is empty';
  }
  if (m === 'revokeDevice' && command.recoveryKey !== null && typeof command.recoveryKey !== 'string') {
    return 'the recovery key is not a string or null';
  }
  if (m === 'setSetting') {
    if (typeof command.key !== 'string') return 'key is not a string';
    if (command.value !== null && typeof command.value !== 'string') return 'value is not a string or null';
  }
  return null;
}

interface KnownChannel { communityId: string; row: ChannelRow }
interface KnownDm { kind: 3 | 4; members: Id[]; groupId: Id | null }
interface OpenChannel { groupId: Id | null; limit: number }
/** A channel or a DM as the channel paths see it (requirement 17): a DM's group is a text group targeted at it. */
interface Target { communityId: string | null; dm: boolean; channel: { id: Id; kind: number; mode: number }; textGroupId: Id | null }

const EMPTY_NOTICES: NoticesState = { nextId: 1, items: [] };
/** A gateway ticket is valid 30 seconds from its mint (protocol/02 § Gateway, 09 § Sessions endpoints). */
const TICKET_TTL_S = 30n;

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
  private accountState: AccountState = {
    phase: 'loading', instance: null, user: null, deviceId: null, recoveryKey: null, error: null, signIn: null, rootMismatch: false,
  };
  private connectionState: ConnectionState = { status: 'offline', generation: null };
  private core: CorePort | null = null;
  private me: { userId: Id; deviceId: Id } | null = null;
  private session: Session | null = null;
  private signup: Signup | null = null;
  private enrol: Enrol | null = null;
  private fetched: EnrolFetched | null = null;
  private signInRunning = false;
  private storeCleared = false;
  private wiping = false;
  private gateway: Gateway | null = null;
  private sync: SyncEngine | null = null;
  private wasDown = false;
  private selected: string | null = null;
  private readonly channels = new Map<string, KnownChannel>();
  private readonly dms = new Map<string, KnownDm>();
  private dmsLoading: Promise<void> | null = null;
  private dmsAgain = false;
  private lastActivity = new Map<string, ActivityRow>();
  private noticesState: NoticesState = EMPTY_NOTICES;
  /** Pre-flight ruling (a): rows the server received before this second (the session's first ready, then every
   *  gateway ready) were caught up, not delivered live; they badge but raise no notice. null before ready. */
  private noticeFloor: bigint | null = null;
  /** The instance clock when the last gateway ticket was minted (the connection that reports the next ready). */
  private ticketTime: bigint | null = null;
  private readonly refusedChannels = new Set<string>();
  private readonly notMember = new Set<string>();
  private readonly resyncing = new Set<string>();
  private readonly lookedUp = new Set<string>();
  private readonly open = new Map<string, OpenChannel>();
  private readonly opening = new Map<string, { run: Promise<null>; entry: OpenChannel | null }>();
  /** One attachment tray per channel hex (L-TS-35); its descriptors live in worker memory only. */
  private readonly trays = new Map<string, Tray>();
  /** Channels whose pins view is open: touchGroup keeps their pins slice fresh until closePins or closeChannel. */
  private readonly pinsOpen = new Set<string>();
  /** community hex → the own role hexes last applied to the core, used only to skip a redundant ownRolesSet. */
  private readonly roles = new Map<string, string[]>();
  private purging: Promise<void> | null = null;
  private purgeAgain = false;

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
      reauthenticate: () => this.reauthenticate(),
      onGeneration: (generation) => { this.setConnection({ generation: generation.toString() }); },
    });
    this.routes = this.parts.routes(http);
  }

  /** Requirement 12: a pending scope in phase 2 is a revocation; a wipe in progress mints nothing (head ruling 27).
   *  While signInKey runs (phase `enrolling`) a refused session is the sign-in's own error: the core may already be in
   *  phase 2 there, and a row replaced before its list PUT is E_SIGNIN_EVICTED, not the revoked splash
   *  (REGISTRATION-DEVICES-02). */
  private async reauthenticate(): Promise<boolean> {
    if (this.wiping || this.storeCleared) return false;
    const session = this.session;
    if (session === null) return false;
    const enrolling = this.phase === 'enrolling';
    let ok: boolean;
    try {
      ok = await session.establish();
    } catch (e) {
      if (isCode(e, 'E_SESSION_SCOPE') && this.core?.identity().phase === 2 && !enrolling) { this.enterRevoked(); return false; }
      throw e;
    }
    // In phase 3 a refused session is the sign-in step's own error, not a revocation.
    if (!ok && this.core?.identity().phase !== 3 && !enrolling) this.enterRevoked();
    return ok;
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
      case 'send': return this.send(command);
      case 'retrySend': return this.retrySend(command.msgId);
      case 'discardSend': return this.discardSend(command.msgId);
      case 'signInBegin': return this.signInBegin();
      case 'signInLogin': return this.step(() => this.signInLogin(command.username, command.password, command.recoveryKey));
      case 'signInTotp': return this.step(() => this.signInTotp(command.code, command.recoveryKey));
      case 'signInKey': return this.step(() => this.signInKey(command.recoveryKey));
      case 'signInCancel': return this.signInCancel();
      case 'refreshDevices': return this.refreshDevices();
      case 'revokeDevice': return this.revokeDevice(command.deviceId, command.recoveryKey);
      case 'signOutRevoke': return this.signOutRevoke(command.recoveryKey);
      case 'forgetBrowser': return this.forgetBrowser();
      case 'markRead': return this.markRead(command.channelId);
      case 'setSetting': return this.setSetting(command.key, command.value);
      case 'openDm': return this.openDm(command.userId);
      case 'editMessage': return this.editMessage(command.channelId, command.msgId, command.text);
      case 'deleteMessage': return this.deleteMessage(command.channelId, command.msgId);
      case 'react': return this.react(command.channelId, command.msgId, command.emoji, command.on);
      case 'pin': return this.pin(command.channelId, command.msgId, command.on);
      case 'loadPins': return this.loadPins(command.channelId);
      case 'closePins': return this.closePins(command.channelId);
      case 'attachFiles': return this.attachFiles(command.channelId, command.files);
      case 'discardAttachment': return this.discardAttachment(command.channelId, command.trayId);
      case 'openAttachment': return this.openAttachment(command.channelId, command.seq, command.index, command.thumb);
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

  private nowS(): bigint { return BigInt(Math.floor(this.deps.now() / 1000)); }

  /** The instance clock as the last ticket showed it, else this browser's (no socket has connected yet). */
  private serverNowS(): bigint { return this.ticketTime ?? this.nowS(); }

  // ---- start, leadership and boot ----

  private start(): Promise<null> {
    this.starting ??= this.startOnce();
    return this.starting;
  }

  private async startOnce(): Promise<null> {
    this.setAccount({ phase: 'loading', instance: null, user: null, deviceId: null, recoveryKey: null, error: null, signIn: null, rootMismatch: false });
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
      this.signup = this.parts.signup({ core, routes: this.routes, session, now });
      const enrol = this.parts.enrol({ core, routes: this.routes, session, now });
      this.enrol = enrol;
      const identity = core.identity();
      if (identity.phase === 0) { this.setAccount({ phase: 'needs-signup' }); return; }
      if (identity.phase === 1) {
        const resumed = await this.requireSignup().resume();
        if (resumed === 0) this.setAccount({ phase: 'needs-signup' });
        else if (resumed === 2) await this.enterReady();
        // A refused device whose account exists: nothing is deleted, signupReset is never called here.
        else this.enterRevoked();
        return;
      }
      if (identity.phase === 3) {
        // A reload mid-ceremony keeps its place: a registered enrolment resumes at the key step.
        if (identity.userId === null) { enrol.reset(); this.setAccount({ phase: 'needs-signup' }); return; }
        const signIn = { username: null, needsTotp: false };
        try {
          this.fetched = await enrol.fetch(identity.userId);
          this.setAccount({ phase: 'signin-key', signIn, error: null });
        } catch (e) {
          this.fetched = null;
          this.setAccount({ phase: 'signin-key', signIn, error: errorOf(e) });
        }
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
    this.dropTrays();
    await this.deps.resetDevice(instance);
    await this.bootStore(instance);
    return null;
  }

  // ---- ready and revoked ----

  /** Requirement 11, in order; after every await a revocation that happened meanwhile ends it silently. */
  private async enterReady(): Promise<void> {
    const core = this.requireCore();
    const session = this.session;
    if (session === null) throw new CoreError('E_CORE_STATE', 'no session');
    let userId: Id;
    let deviceId: Id;
    try {
      // (a) a list this device has not published yet: the session from before it may be pending.
      const unpublished = !core.identity().listPublished;
      // (b)
      const ok = await session.ensure();
      if (this.revoked()) return;
      if (!ok) { this.enterRevoked(); return; }
      // (c)
      await this.parts.publishDeviceList(core, this.routes);
      if (this.revoked()) return;
      // (d) the server enrols the session only once the list names this device; the gateway refuses a pending one.
      if (unpublished) {
        const fresh = await session.establish();
        if (this.revoked()) return;
        if (!fresh) { this.enterRevoked(); return; }
      }
      const identity = core.identity();
      if (identity.userId === null || identity.deviceId === null) throw new CoreError('E_CORE_NO_IDENTITY', '');
      userId = identity.userId;
      deviceId = identity.deviceId;
      this.me = { userId, deviceId };
      // (e) the next ready retries a failed upload; a root mismatch is recorded, never dropped.
      await this.ensureBackups(core);
      if (this.revoked()) return;
      // (f)
      const own = await this.parts.refreshOwnDeviceList(core, this.routes, userId);
      if (this.revoked()) return;
      if (!own.listed) { this.enterRevoked(); return; }
      // BACKUPS-RECOVERY-03: a stored state object behind the own list or junk is replaced; the next ready retries.
      await this.repairBackupState(core);
      if (this.revoked()) return;
    } catch (e) {
      // Requirement 12: a pending scope or an unlisted answer for a device the own list names is a revocation.
      if ((isCode(e, 'E_SESSION_SCOPE') || isCode(e, 'E_DEVICE_UNLISTED')) && core.identity().phase === 2) {
        this.enterRevoked();
        return;
      }
      throw e;
    }
    // (g) the engine subscribes before the gateway can report its first ready (pre-flight ruling 2).
    if (this.gateway === null) {
      const now = (): number => this.deps.now();
      const random = (): number => this.deps.random();
      const setTimeout = (fn: () => void, ms: number): number => this.deps.setTimeout(fn, ms);
      const clearTimeout = (handle: number): void => { this.deps.clearTimeout(handle); };
      const gateway = this.parts.gateway({
        url: this.deps.origin.replace(/^http/, 'ws') + '/gateway',
        mintTicket: async () => {
          const minted = await this.routes.postTicket();
          // The instance's clock at the mint (a ticket is valid TICKET_TTL_S seconds, protocol/09): the notice
          // floor compares server receive times with server time, never with this browser's clock.
          this.ticketTime = minted.expires - TICKET_TTL_S;
          return minted.ticket;
        },
        WebSocket: this.deps.WebSocket, now, random, setTimeout, clearTimeout,
      });
      this.gateway = gateway;
      gateway.subscribe((e) => { this.onGateway(e); });
      this.startEngine();
      this.wasDown = false;
      gateway.start();
    }
    // (h) every community's channels and members, then the DMs, so join-all expects every visible group.
    await this.refreshCommunities();
    if (this.revoked()) return;
    for (const community of this.slices.get('communities') ?? []) {
      try { await this.loadCommunity(community.id); } catch { /* the next ready retries */ }
      if (this.revoked()) return;
    }
    try { await this.reloadDms(); }
    catch {
      // Pre-flight row 2.14(d): a page waiting for the DM list must not wait for the next ready.
      if (this.slices.get('dms') === undefined) this.slices.set('dms', []);
    }
    if (this.revoked()) return;
    // (i)
    this.slices.set('settings', core.settings());
    this.publishBadges();
    if (this.slices.get('notices') === undefined) this.slices.set('notices', this.noticesState);
    // (j) after a reload mid-ceremony the store records no username (head ruling 42): the account names it.
    let username = core.identity().username;
    if (username === '') username = (await this.routes.getAccountMe()).username;
    if (this.revoked()) return;
    this.noticeFloor = this.serverNowS();
    this.setAccount({
      phase: 'ready', user: { id: toHex(userId), username }, deviceId: toHex(deviceId),
      recoveryKey: null, error: null, signIn: null,
    });
    this.publishDms();
    // The gateway's first ready can arrive before the phase is ready, when a purge run returns at once.
    this.runPurges();
  }

  /** The engine with the controller's report handlers; enterReady and resume() build it (requirement 23). */
  private startEngine(): void {
    const core = this.requireCore();
    const gateway = this.gateway;
    const me = this.me;
    if (gateway === null || me === null) throw new CoreError('E_CORE_STATE', 'no gateway');
    const sync = this.parts.sync({
      core, routes: this.routes, gateway, instance: this.requireInstance(), deviceId: me.deviceId,
      now: () => this.deps.now(),
      random: () => this.deps.random(),
      setTimeout: (fn, ms) => this.deps.setTimeout(fn, ms),
      clearTimeout: (handle) => { this.deps.clearTimeout(handle); },
      onGroupChanged: (g, result) => { this.onGroupChanged(g, result); },
      // Ruling 8: the core records a delete's purge when the type-2 row is confirmed, which the engine reports here.
      onOutboxChanged: (g) => { this.safely(() => { this.touchGroup(g); }); this.runPurges(); },
      onMembership: (g, status) => { this.onMembership(g, status); },
      onJoinAll: () => {},
      // Head ruling 37: a Welcome for a group this device does not expect is a DM another participant opened.
      onUnexpectedWelcome: () => { void this.reloadDms().catch(() => {}); },
      beforeSend: (g, row) => this.beforeSend(g, row),
      onDiscarded: (g, row) => { this.onDiscarded(g, row); },
    });
    this.sync = sync;
    sync.start();
  }

  /** Requirements 11(e) and 13: a rejection is swallowed (the next ready retries, L-TS-21), except that a root
   *  mismatch (task 11 ruling (b), pre-flight row 1.5: the instance holds a root this device did not seal, so every
   *  later recovery on it fails as a wrong key) is published on the account slice, where the page shows its alert
   *  (BACKUPS-RECOVERY-04, protocol/06 and 09 "raises E_ROOT_MISMATCH with an alert"); a later success clears it. */
  private async ensureBackups(core: CorePort): Promise<void> {
    let mismatch: boolean;
    try {
      await this.parts.ensureBackups(core, this.routes);
      mismatch = false;
    } catch (e) {
      if (!isCode(e, 'E_ROOT_MISMATCH')) return;
      mismatch = true;
    }
    if (this.storeCleared || this.accountState.rootMismatch === mismatch) return;
    this.setAccount({ rootMismatch: mismatch });
  }

  /** BACKUPS-RECOVERY-03: swallowed like ensureBackups; the next ready tries again. */
  private async repairBackupState(core: CorePort): Promise<void> {
    try { await this.parts.repairBackupState(core, this.routes); } catch { /* the next ready retries */ }
  }

  /** Read through a call: tsc keeps a narrowing of this.phase across awaits, but a revocation can land in any of them. */
  private revoked(): boolean { return this.phase === 'revoked'; }

  /** The one revoked path (ruling 29): idempotent; inert while this browser erases itself (head ruling 27). */
  private enterRevoked(): void {
    if (this.wiping || this.storeCleared) return;
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
    // Pre-flight ruling (a): what this ready catches up was not delivered live.
    if (this.phase === 'ready') this.noticeFloor = this.serverNowS();
    const core = this.core;
    const limits = this.limits;
    if (core !== null && limits !== null) {
      refillKeyPackages(core, this.routes, info.keypackagesRemaining,
        { perDevice: limits.keypackagesPerDevice, threshold: limits.keypackageRefillThreshold }).catch(() => undefined);
    }
    // Requirement 13 (Q27: clients refetch on ready), not awaited in the ready path.
    const me = this.me;
    if (core !== null && me !== null) {
      void this.ensureBackups(core);
      this.parts.refreshOwnDeviceList(core, this.routes, me.userId)
        .then((own) => (own.listed ? this.repairBackupState(core) : this.enterRevoked()), () => undefined);
    }
    void this.refreshAfterReady();
    this.runPurges();
  }

  /** Every ready refreshes the community list, every listed community and the DMs; a failure waits for the next ready. */
  private async refreshAfterReady(): Promise<void> {
    try { await this.refreshCommunities(); } catch { /* the next ready retries */ }
    for (const community of this.slices.get('communities') ?? []) {
      if (this.revoked() || this.storeCleared) return;
      try { await this.loadCommunity(community.id); } catch { /* the next ready retries */ }
    }
    if (this.revoked() || this.storeCleared) return;
    try { await this.reloadDms(); } catch { /* the next ready retries */ }
  }

  private async onRevokedSocket(): Promise<void> {
    if (this.wiping || this.storeCleared) return;
    const session = this.session;
    if (session === null || this.revoked()) return;
    try {
      const ok = await session.establish();
      if (this.revoked() || this.wiping) return;
      if (ok) this.gateway?.start();
      else this.enterRevoked();
    } catch (e) {
      if (isCode(e, 'E_SESSION_SCOPE') && this.core?.identity().phase === 2) { this.enterRevoked(); return; }
      // Not a refusal (a network failure, a 5xx): try the socket again later; a refused ticket comes back here.
      if (this.revoked() || this.wiping) return;
      this.deps.setTimeout(() => { if (!this.revoked() && !this.wiping) this.gateway?.start(); }, GATEWAY.reconnectCapMs);
    }
  }

  // ---- signup ----

  private signupBegin(): Promise<null> {
    if (this.storeCleared) return Promise.reject(new Refusal('E_NOT_READY', 'the store was cleared: reload'));
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

  // ---- sign-in (L-TS-23, requirements 3-9) ----

  /** One sign-in step at a time: the phase does not change while login or register run (requirement 3). */
  private step<T>(work: () => Promise<T>): Promise<T> {
    if (this.signInRunning) return Promise.reject(new Refusal('E_NOT_READY', 'a sign-in step is running'));
    this.signInRunning = true;
    return work().finally(() => { this.signInRunning = false; });
  }

  private signInBegin(): Promise<null> {
    if (this.storeCleared) return Promise.reject(new Refusal('E_NOT_READY', 'the store was cleared: reload'));
    this.fetched = null;
    this.setAccount({ phase: 'signin-login', signIn: { username: null, needsTotp: false }, error: null });
    return Promise.resolve(null);
  }

  /** The key's form, in the core, before anything that needs it; a refusal returns to `phase` with the error. */
  private checkKey(recoveryKey: string, phase: BootPhase): void {
    try {
      this.requireCore().recoveryKeyCheck(recoveryKey);
    } catch (e) {
      this.setAccount({ phase, error: errorOf(e) });
      throw e;
    }
  }

  /** The password is passed to Enrol.login and held in no field (L-TS-21). The page held the recovery key from the
   *  first step and sends it here: its form is checked before the login is sent (a mistyped key costs no login), and
   *  with no second factor owed the enrolment runs at once, so the assertion is spent seconds after it was minted
   *  (REGISTRATION-DEVICES-02, coordinator ruling on its concern 3). With a second factor the worker keeps no key:
   *  the page sends it again with the code. */
  private async signInLogin(rawUsername: string, password: string, recoveryKey: string): Promise<{ needsTotp: boolean }> {
    const enrol = this.requireEnrol();
    const username = rawUsername.trim();
    this.checkKey(recoveryKey, 'signin-login');
    let needsTotp: boolean;
    try {
      ({ needsTotp } = await enrol.login(username, password));
    } catch (e) {
      this.setAccount({ phase: 'signin-login', error: errorOf(e) });
      throw e;
    }
    if (needsTotp) {
      this.setAccount({ phase: 'signin-totp', signIn: { username, needsTotp: true }, error: null });
      return { needsTotp: true };
    }
    this.setAccount({ signIn: { username, needsTotp: false }, error: null });
    await this.enrolWithKey(recoveryKey);
    return { needsTotp: false };
  }

  /** A refused code spends the assertion (head ruling 39): the person logs in again, the username kept. */
  private async signInTotp(code: string, recoveryKey: string): Promise<null> {
    const enrol = this.requireEnrol();
    const username = this.accountState.signIn?.username ?? null;
    this.checkKey(recoveryKey, 'signin-totp');
    try {
      await enrol.totp(code);
    } catch (e) {
      this.setAccount({ phase: 'signin-login', signIn: { username, needsTotp: false }, error: errorOf(e) });
      throw e;
    }
    await this.enrolWithKey(recoveryKey);
    return null;
  }

  /** Requirement 7 as REGISTRATION-DEVICES-02 amends it: the registration runs inside signInKey, after the key's
   *  form passed. A refused registration keeps the phase-3 enrol record (its device id is reused) and returns to
   *  the login step. */
  private async register(): Promise<Id> {
    const enrol = this.requireEnrol();
    try {
      return (await enrol.register(this.requireInstance().instanceId)).userId;
    } catch (e) {
      const username = this.accountState.signIn?.username ?? null;
      this.setAccount({ phase: 'signin-login', signIn: { username, needsTotp: false }, error: errorOf(e) });
      throw e;
    }
  }

  /** enrol.fetch inside signInKey; a failure stays at the key step with the error. A 401 is a registered row the
   *  instance revoked (replaced by another registration): the enrolment is dropped and step 1 says so. */
  private async fetchForKey(): Promise<EnrolFetched> {
    const userId = this.requireCore().identity().userId;
    try {
      if (userId === null) throw new CoreError('E_CORE_STATE', 'no user recorded');
      this.fetched = await this.requireEnrol().fetch(userId);
      return this.fetched;
    } catch (e) {
      this.fetched = null;
      if (isStatus(e, 401) && this.requireCore().identity().phase === 3) throw this.evicted();
      this.setAccount({ phase: 'signin-key', error: errorOf(e) });
      throw e;
    }
  }

  /** REGISTRATION-DEVICES-02 before the core wrote the enrolment: drop it and return to step 1 with the reason. */
  private evicted(): Error {
    this.requireEnrol().reset();
    const username = this.accountState.signIn?.username ?? null;
    this.setAccount({ phase: 'signin-login', signIn: { username, needsTotp: false },
      error: { code: 'E_SIGNIN_EVICTED', detail: '', status: 0, retryAfterMs: null } });
    return new Error('E_SIGNIN_EVICTED');
  }

  /** Requirement 8 as REGISTRATION-DEVICES-02 amends it, for an enrolment already registered (a wrong key, a reload
   *  mid-ceremony): the key's form, then the fetch, the enrolment and the list PUT back to back. The recovery key is
   *  passed to the core and to Enrol.complete and held in no field, slice, ret or error. */
  private async signInKey(recoveryKey: string): Promise<null> {
    this.checkKey(recoveryKey, 'signin-key');
    await this.enrolWithKey(recoveryKey);
    return null;
  }

  /** The registration (when the enrolment holds none yet), the fetch, the enrolment and the list PUT, back to back. */
  private async enrolWithKey(recoveryKey: string): Promise<void> {
    const enrol = this.requireEnrol();
    const core = this.requireCore();
    this.setAccount({ phase: 'enrolling', error: null });
    // Phase 0, or an enrolment whose registration was refused (its record and device id are kept and reused).
    const before = core.identity();
    if (before.phase === 0 || (before.phase === 3 && before.userId === null)) await this.register();
    let fetched = this.fetched ?? await this.fetchForKey();
    const username = this.accountState.signIn?.username ?? '';
    let retried = false;
    for (;;) {
      try {
        await enrol.complete(recoveryKey, fetched, username);
        break;
      } catch (raw) {
        let e: unknown = raw;
        if (core.identity().phase === 3) {
          // Pre-flight ruling (c): an older served list may be a list PUT racing this read; read again once.
          if (coreInput(e, LIST_CONFLICT) && !retried) {
            retried = true;
            fetched = await this.fetchForKey();
            continue;
          }
          if (coreInput(e, LIST_CONFLICT)) e = new Error('E_LIST_RACE');
          // Pre-flight ruling (e): a state object missing or unreadable past list version 1 is a missing backup.
          else if (coreInput(e, STATE_UNUSABLE)) { this.fetched = null; e = new Error('E_NO_BACKUP'); }
        }
        if (isCode(e, 'E_LIST_RACE') || isCode(e, 'E_SIGNIN_EVICTED')) {
          // The core is in phase 2 with an unlisted identity (or the instance keeps serving a conflicting
          // list, or revoked the row before its list PUT): nothing returns it to phase 0 in this worker (head
          // ruling 26).
          if (isCode(e, 'E_SIGNIN_EVICTED') && core.identity().phase === 3) throw this.evicted();
          await this.wipe({ code: (e as Error).message, detail: '', status: 0, retryAfterMs: null });
          throw e;
        }
        if (core.identity().phase === 3) {
          this.setAccount({ phase: 'signin-key', error: errorOf(e) });
          throw e;
        }
        // The core wrote the enrolment and a later step failed: entering ready publishes and upgrades.
        break;
      }
    }
    this.fetched = null;
    try {
      await this.enterReady();
    } catch (e) {
      if (!this.revoked()) this.setAccount({ phase: 'error', error: errorOf(e) });
      throw e;
    }
  }

  /** Requirement 9; Enrol.reset also drops a held assertion, so it runs in every sign-in phase (it resets
   *  the core's enrolment only in phase 3). The pending session is left to expire. */
  private signInCancel(): Promise<null> {
    this.requireEnrol().reset();
    this.fetched = null;
    this.setAccount({ phase: 'needs-signup', signIn: null, error: null });
    return Promise.resolve(null);
  }

  // ---- communities ----

  private listed(communityId: string): boolean {
    return (this.slices.get('communities') ?? []).some((c) => c.id === communityId);
  }

  private async refreshCommunities(): Promise<void> {
    const rows = await this.routes.listCommunities();
    if (this.storeCleared) return;
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
    this.updateExpected();
    this.publishBadges();
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

  /** The channel and member lists of one community; join-all then expects its groups (requirement 18). */
  private async loadCommunity(communityId: string): Promise<void> {
    const id = fromHex(communityId);
    const rows = await this.routes.listChannels(id);
    const members = await this.routes.listMembers(id);
    if (this.storeCleared || !this.listed(communityId)) return;
    for (const [channelId, known] of this.channels) if (known.communityId === communityId) this.channels.delete(channelId);
    for (const row of rows) this.channels.set(toHex(row.id), { communityId, row });
    this.publishChannels(communityId);
    this.publishMembers(communityId, members);
    this.updateExpected();
    this.publishBadges();
    this.publishDms();                               // a DM's name comes from the member lists
  }

  private publishMembers(communityId: string, rows: readonly MemberRow[]): void {
    this.slices.set(`members:${communityId}`, rows.map((m) => ({
      userId: toHex(m.userId), username: m.username, display: m.display, kind: m.kind, roleIds: m.roleIds.map(toHex),
    })));
    // Ruling 12: the core's mention rule reads the own roles of the community (L-CORE-35); a change reaches it once.
    const core = this.core;
    const me = this.me;
    if (core === null || me === null) return;
    const ownUser = toHex(me.userId);
    const own = rows.find((m) => toHex(m.userId) === ownUser);
    if (own === undefined) return;
    const hexes = own.roleIds.map(toHex);
    const applied = this.roles.get(communityId);
    if (applied !== undefined && applied.length === hexes.length && applied.every((h, i) => h === hexes[i])) return;
    try {
      core.ownRolesSet(fromHex(communityId), own.roleIds);
      this.roles.set(communityId, hexes);
    } catch { /* the next member list tries again */ }
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

  /** Requirement 18: every known text channel first, then every DM whose group is known (communityId null). */
  private updateExpected(): void {
    const policyVersion = this.instance?.policyVersion ?? 0n;
    const expected: ExpectedGroup[] = [];
    for (const [channelId, { communityId, row }] of this.channels) {
      if (row.kind !== 0 || row.mode !== 0 || row.textGroupId === null) continue;
      expected.push({ groupId: row.textGroupId, communityId: fromHex(communityId), channelId: fromHex(channelId), policyVersion });
    }
    for (const [channelId, dm] of this.dms) {
      if (dm.groupId === null) continue;
      expected.push({ groupId: dm.groupId, communityId: null, channelId: fromHex(channelId), policyVersion });
    }
    this.sync?.setExpected(expected);
  }

  // ---- DMs (requirements 15-16) ----

  /** Coalesced: any number of requests during one load cause exactly one further load. */
  private reloadDms(): Promise<void> {
    if (this.dmsLoading !== null) { this.dmsAgain = true; return this.dmsLoading; }
    const run = (async () => {
      let failure: { error: unknown } | null = null;
      try {
        do {
          this.dmsAgain = false;
          try { await this.loadDms(); failure = null; }
          catch (e) { failure = { error: e }; }
        } while (this.dmsAgain);
      } finally {
        this.dmsLoading = null;
      }
      if (failure !== null) throw failure.error;
    })();
    this.dmsLoading = run;
    return run;
  }

  private async loadDms(): Promise<void> {
    const rows = await this.routes.listDms();
    if (this.storeCleared) return;
    const asked = new Map<string, Id | null>();
    for (const row of rows) {
      const id = toHex(row.channelId);
      if ((this.dms.get(id)?.groupId ?? null) !== null || asked.has(id)) continue;
      // A failed read leaves the group unknown; the next load asks again.
      try { asked.set(id, (await this.routes.getChannel(row.channelId)).textGroupId); }
      catch { asked.set(id, null); }
      if (this.storeCleared) return;
    }
    const next = new Map<string, KnownDm>();
    for (const row of rows) {
      const id = toHex(row.channelId);
      next.set(id, { kind: row.kind, members: row.members, groupId: this.dms.get(id)?.groupId ?? asked.get(id) ?? null });
    }
    for (const id of this.dms.keys()) {
      if (next.has(id)) continue;
      this.open.delete(id);
      if (this.slices.get(`timeline:${id}`) !== undefined) {
        this.slices.set(`timeline:${id}`, { channelId: id, group: 'none', items: [], hasEarlier: false });
      }
    }
    this.dms.clear();
    for (const [id, dm] of next) this.dms.set(id, dm);
    this.publishDms();
    this.updateExpected();
    this.publishBadges();
  }

  /** A member's name from the first loaded member list that has them, else the first 8 hex characters. */
  private nameOf(userHex: string): string {
    for (const community of this.slices.get('communities') ?? []) {
      const member = this.slices.get(`members:${community.id}`)?.find((m) => m.userId === userHex);
      if (member !== undefined) return member.display !== '' ? member.display : member.username;
    }
    return userHex.slice(0, 8);
  }

  private publishDms(): void {
    if (this.core === null) return;
    const groups = this.core.groups();
    const own = this.me === null ? null : toHex(this.me.userId);
    const list: DmSummary[] = [];
    for (const [id, dm] of this.dms) {
      const members = dm.members.map(toHex);
      const others = members.filter((m) => m !== own);
      const name = others.length === 0
        ? this.accountState.user?.username ?? this.core.identity().username
        : others.map((m) => this.nameOf(m)).join(', ');
      list.push({ id, kind: dm.kind, members, name, group: channelGroupState({ id: fromHex(id), kind: 0, mode: 0 }, groups, this.membership(id)) });
    }
    this.slices.set('dms', list);
  }

  private async openDm(userId: string): Promise<{ channelId: string }> {
    const { channelId } = await this.routes.postDm([fromHex(userId)]);
    await this.reloadDms();
    return { channelId: toHex(channelId) };
  }

  // ---- badges and notices (requirements 19-21) ----

  /** group hex → channel hex, for every text group bound to a known channel or DM. */
  private channelMap(groups: readonly GroupInfo[]): Map<string, string> {
    const channelOf = new Map<string, string>();
    for (const g of groups) {
      if (g.kind !== 0) continue;
      const target = toHex(g.targetId);
      if (this.channels.has(target) || this.dms.has(target)) channelOf.set(toHex(g.groupId), target);
    }
    return channelOf;
  }

  private publishBadges(): void {
    const core = this.core;
    if (core === null) return;
    const channelOf = this.channelMap(core.groups());
    const activity = core.activity();
    this.lastActivity = new Map(activity.map((row) => [toHex(row.groupId), row]));
    this.slices.set('badges', buildBadges(activity, channelOf));
  }

  /** Badges after every change; a notice for each new message from another user that arrived live (ruling (a)).
   *  Both slices are published synchronously, badges first, before the handler returns to the engine. */
  private reportActivity(groupId: Id, result: ApplyResult): void {
    const core = this.core;
    const me = this.me;
    const hex = toHex(groupId);
    const channelId = core === null ? undefined : this.channelMap(core.groups()).get(hex);
    if (core === null || me === null || result.newSeqs.length === 0 || channelId === undefined) { this.publishBadges(); return; }
    const before = this.lastActivity.get(hex)?.mentions ?? 0;
    this.publishBadges();
    const after = this.lastActivity.get(hex)?.mentions ?? 0;
    const floor = this.noticeFloor;
    if (floor === null) return;
    const ownUser = toHex(me.userId);
    const fresh = new Set(result.newSeqs.map((s) => s.toString()));
    const dm = this.dms.has(channelId);
    const communityId = dm ? null : this.channels.get(channelId)?.communityId ?? null;
    const drafts: NoticeDraft[] = [];
    const rows = core.timeline(groupId, 0n, Math.min(result.newSeqs.length, NOTICE_READ_MAX));
    for (const row of rows) {
      if (!this.noticeable(row, fresh, ownUser, floor)) continue;
      const senderName = this.nameOf(toHex(row.senderUser as Id));
      // FACTS-SECURITY-07: the core's flag, set once at apply on the row's original body; never the shown body, which may
      // hold another member's edit folded in the same apply (ruling 4, ruling 34).
      drafts.push(noticeOf({ row, channelId, communityId, dm, mention: after > before && row.mention, senderName }));
    }
    this.noticesState = appendNotices(this.noticesState, drafts);
    this.slices.set('notices', this.noticesState);
  }

  /** A new, readable message from another user (on any device: head ruling 29), received live. */
  private noticeable(row: TimelineRow, fresh: ReadonlySet<string>, ownUser: string, floor: bigint): boolean {
    return fresh.has(row.seq.toString()) && row.status === 0 && row.type === 0
      && row.senderUser !== null && toHex(row.senderUser) !== ownUser && row.recvTs >= floor;
  }

  private markRead(channelId: string): Promise<null> {
    const core = this.requireCore();
    if (this.target(channelId) === undefined) throw new Refusal('E_BAD_INPUT', 'unknown channel');
    const g = this.timelineGroup(channelId, core.groups());
    if (g === null) return Promise.resolve(null);
    const row = core.groupRow(g);
    if (row === null || row.state === 4) return Promise.resolve(null);
    const rows = core.timeline(g, 0n, 1);
    if (rows.length === 0) return Promise.resolve(null);
    const newest = rows.reduce((max, r) => (r.seq > max ? r.seq : max), rows[0]?.seq ?? 0n);
    core.markRead(g, newest, this.nowS());
    this.publishBadges();
    return Promise.resolve(null);
  }

  // ---- settings (requirement 27) ----

  private setSetting(key: string, value: string | null): Promise<null> {
    if (!isSettingKey(key)) throw new Refusal('E_SETTING_KEY', '');
    const core = this.requireCore();
    if (value === null) core.settingDelete(key);
    else {
      if (!isSettingValue(key, value)) throw new Refusal('E_BAD_INPUT', `value is not allowed for ${key}`);
      core.settingPut(key, value);
    }
    this.slices.set('settings', core.settings());
    return Promise.resolve(null);
  }

  // ---- devices (requirements 23-26) ----

  /** Requirement 25: the own list first, so a just-enrolled device shows as listed. */
  private async refreshDevices(): Promise<null> {
    const core = this.requireCore();
    const me = this.requireMe();
    const own = await this.parts.refreshOwnDeviceList(core, this.routes, me.userId);
    if (!own.listed) { this.enterRevoked(); return null; }
    const rows = await this.routes.listDevices();
    const entries = core.ownDeviceList().entries;
    const ownHex = toHex(me.deviceId);
    const devices: DeviceSummary[] = rows.map((r) => {
      const id = toHex(r.id);
      return {
        id, tier: r.tier, signerTier: r.signerTier, lastSeen: Number(r.lastSeen),
        revokedAt: r.revokedAt === null ? null : Number(r.revokedAt),
        listed: entries.some((e) => toHex(e.deviceId) === id && e.revokedAt === null),
        own: id === ownHex,
      };
    });
    devices.sort((a, b) => (a.own !== b.own ? (a.own ? -1 : 1)
      : a.lastSeen !== b.lastSeen ? b.lastSeen - a.lastSeen : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.slices.set('devices', devices);
    return null;
  }

  /** The shared part of a revocation (requirement 24): read the root, the state object and the list, and sign the
   *  revoking list and the re-sealed state object. The caller writes them, in its own order (BACKUPS-RECOVERY-01).
   *  An older served list is refreshed and the reads retried once (pre-flight ruling (c)); a second is the list
   *  conflict. */
  private async revoke(ids: Id[], recoveryKey: string): Promise<SignedLists & { served: Uint8Array | null }> {
    const core = this.requireCore();
    const me = this.requireMe();
    for (let attempt = 0; ; attempt += 1) {
      const root = await this.routes.getBackup(0);
      if (root === null) throw new Error('E_NO_BACKUP');
      // A missing state object is not a refusal here (head ruling 28): the re-sealed one repairs it.
      const state = await this.routes.getBackup(1);
      const list = await this.routes.getDeviceList(me.userId);
      if (list === null) throw new Error('E_NO_BACKUP');
      const now = this.nowS();
      const sign = (stateSealed: Uint8Array): SignedLists =>
        core.deviceListRevoke({ recoveryKey, rootSealed: root.object, stateSealed, listBody: list.raw, deviceIds: ids, now });
      let signed: SignedLists;
      try {
        try {
          signed = sign(state?.object ?? new Uint8Array(0));
        } catch (e) {
          // The core accepts a missing or unopenable served state only at list version 1 (core-block security
          // ruling 1): past it, a session that deleted or spoiled the object would block every revocation with
          // the key. This device's own sealed state is authentic, and its list is not newer than the list this
          // device stores, so the floor still holds; the re-sealed object then repairs the instance's copy.
          if (!coreInput(e, STATE_UNUSABLE)) throw e;
          const own = core.sealedObjects().state;
          if (own === null) throw new Error('E_NO_BACKUP');
          try { signed = sign(own); }
          catch (again) { throw coreInput(again, STATE_UNUSABLE) ? new Error('E_NO_BACKUP') : again; }
        }
      } catch (e) {
        if (!coreInput(e, LIST_CONFLICT)) throw e;
        if (attempt > 0) throw new Error('E_LIST_RACE');
        try { await this.parts.refreshOwnDeviceList(core, this.routes, me.userId); } catch { /* the reads below decide */ }
        continue;
      }
      // The state object the instance held before this revocation: a failed sign-out puts it back.
      return { ...signed, served: state?.object ?? null };
    }
  }

  /** BACKUPS-RECOVERY-02: the list another device signed and could not publish, which the core found in the state
   *  object and signed on, goes to the instance first. A 409 is a list there already (published meanwhile, or a
   *  fork the next PUT meets); any other failure drops the new candidate back to it, so a later ready publishes it. */
  private async publishInterrupted(signed: SignedLists): Promise<void> {
    if (signed.interrupted === null) return;
    try {
      await this.routes.putDeviceList(this.requireMe().userId, signed.interrupted);
    } catch (e) {
      if (isStatus(e, 409)) return;
      this.requireCore().deviceListDrop();
      throw e;
    }
  }

  private async listRace(): Promise<never> {
    // The core drops its candidate when the newer list is adopted.
    try { await this.parts.refreshOwnDeviceList(this.requireCore(), this.routes, this.requireMe().userId); }
    catch { /* the next ready refreshes it */ }
    throw new Error('E_LIST_RACE');
  }

  private async revokeDevice(deviceId: string, recoveryKey: string | null): Promise<null> {
    const core = this.requireCore();
    const me = this.requireMe();
    if (deviceId === toHex(me.deviceId)) throw new Refusal('E_BAD_INPUT', 'use signOutRevoke for this browser');
    // Pre-flight ruling (b): decide listed or unlisted from a fresh own list, never a stale one; the server's
    // 409 for a listed device on the key-less DELETE is the backstop and crosses unchanged.
    const own = await this.parts.refreshOwnDeviceList(core, this.routes, me.userId);
    if (!own.listed) { this.enterRevoked(); return null; }
    const listed = core.ownDeviceList().entries.some((e) => toHex(e.deviceId) === deviceId && e.revokedAt === null);
    if (!listed) {
      // Head ruling 30: a row no signed list names needs no list change and no key.
      await this.routes.deleteDevice(fromHex(deviceId));
      await this.refreshDevices();
      return null;
    }
    if (recoveryKey === null || recoveryKey.trim() === '') throw new Refusal('E_BAD_INPUT', 'the recovery key is empty');
    const signed = await this.revoke([fromHex(deviceId)], recoveryKey);
    await this.publishInterrupted(signed);
    // BACKUPS-RECOVERY-01: the revoking list first. The state object's PUT shares the user's upload meter and quota
    // with every session of the account, the stolen one included, so it must not be able to hold the list back.
    try {
      await this.routes.putDeviceList(me.userId, signed.deviceListBody);
    } catch (e) {
      if (isStatus(e, 409)) return this.listRace();
      throw e;
    }
    core.deviceListPublished();
    // A refused state object stays unmarked (state_uploaded 0): ensureBackups uploads it at the next ready, and
    // until then the instance holds a state behind the list, which the rollback floor accepts.
    try {
      await this.routes.putBackup(1, signed.stateSealed);
      core.stateSealedUploaded();
    } catch { /* the next ready uploads it */ }
    await this.refreshDevices();
    return null;
  }

  private async signOutRevoke(recoveryKey: string): Promise<null> {
    const me = this.requireMe();
    const core = this.requireCore();
    const signed = await this.revoke([me.deviceId], recoveryKey);
    // An interrupted publication first, then the state object (architect ruling 17: before the list, so the
    // self-revoking PUT is the last request this device makes); a refusal of either sends nothing more and drops
    // the self-revoking candidate, so no later ready publishes it without the wipe the person asked for
    // (BACKUPS-RECOVERY-02).
    await this.publishInterrupted(signed);
    try {
      await this.routes.putBackup(1, signed.stateSealed);
    } catch (e) {
      core.deviceListDrop();
      throw e;
    }
    // The socket and the engine stop before the self-revoking PUT (head ruling 27).
    this.quiesce();
    try {
      await this.routes.putDeviceList(me.userId, signed.deviceListBody);
    } catch (e) {
      if (isStatus(e, 409)) { this.resume(); return this.listRace(); }
      // Fix-wave review NEW-2: the drop restores this device's state from before the sign-out, and the instance's
      // copy is put back too. Its self-revoking state object is the served list's successor, so the next recovery or
      // revocation (this browser's own included) would publish it as an interrupted publication.
      core.deviceListDrop();
      const previous = signed.served ?? core.sealedObjects().state;
      if (previous !== null) {
        try { await this.routes.putBackup(1, previous); }
        catch { /* the repair at the next ready re-uploads this browser's state when it carries the newest list */ }
      }
      this.resume();
      throw e;
    }
    await this.wipe(null);
    return null;
  }

  private async forgetBrowser(): Promise<null> {
    const core = this.requireCore();
    const identity = core.identity();
    const deviceId = this.me?.deviceId ?? identity.deviceId;
    this.quiesce();
    // BACKUPS-RECOVERY-02: a candidate this device signed and did not publish may already have its state object at
    // the instance; it is published before the store goes. A failure leaves it to the wipe, and the next device that
    // recovers finds it as an interrupted publication.
    if (identity.phase === 2 && !identity.listPublished) {
      try { await this.parts.publishDeviceList(core, this.routes); } catch { /* the wipe drops it */ }
    }
    if (deviceId !== null) {
      try {
        await this.routes.deleteSessions(deviceId);
      } catch (e) {
        // A 401: the sessions are gone already.
        if (!isStatus(e, 401)) { this.resume(); throw e; }
      }
    }
    await this.wipe(null);
    return null;
  }

  /** Stops the engine and the gateway before a server call that ends this device's sessions (head ruling 27). */
  private quiesce(): void {
    if (this.wiping) return;
    this.wiping = true;
    this.sync?.stop();
    this.gateway?.stop();
  }

  /** A refused server call: a fresh engine (a stopped one cannot restart), its expected set, then the socket. */
  private resume(): void {
    this.wiping = false;
    if (this.phase !== 'ready') return;               // a revoked browser had nothing running
    this.startEngine();
    this.updateExpected();
    this.gateway?.start();
  }

  /** Requirement 23: the store is erased and the worker stays inert until the page reloads (phase cleared). */
  private async wipe(error: WorkerError | null): Promise<void> {
    this.quiesce();
    const instance = this.requireInstance();
    try {
      this.core?.pause();                             // releases the OPFS handles; close() would not
      await this.deps.resetDevice(instance);
    } catch (e) {
      this.setAccount({ phase: 'error', error: errorOf(e) });
      throw e;
    }
    const communities = new Set<string>((this.slices.get('communities') ?? []).map((c) => c.id));
    for (const known of this.channels.values()) communities.add(known.communityId);
    const timelines = [...this.open.keys()];
    this.core = null; this.session = null; this.signup = null; this.enrol = null; this.gateway = null; this.sync = null;
    this.me = null; this.selected = null; this.fetched = null; this.noticeFloor = null; this.ticketTime = null;
    this.channels.clear(); this.dms.clear(); this.open.clear(); this.opening.clear(); this.refusedChannels.clear();
    this.notMember.clear(); this.resyncing.clear(); this.lookedUp.clear(); this.lastActivity = new Map();
    this.dropTrays(); this.pinsOpen.clear(); this.roles.clear(); this.purgeAgain = false;
    this.noticesState = { nextId: this.noticesState.nextId, items: [] };
    this.slices.set('communities', []);
    for (const communityId of communities) {
      this.slices.set(`channels:${communityId}`, []);
      this.slices.set(`members:${communityId}`, []);
    }
    for (const channelId of timelines) this.slices.set(`timeline:${channelId}`, { channelId, group: 'none', items: [], hasEarlier: false });
    this.slices.set('dms', []);
    this.slices.set('devices', []);
    this.slices.set('badges', {});
    this.slices.set('settings', {});
    this.slices.set('notices', this.noticesState);
    this.setConnection({ status: 'offline', generation: null });
    this.storeCleared = true;
    this.setAccount({ phase: 'cleared', user: null, deviceId: null, recoveryKey: null, signIn: null, error, rootMismatch: false });
  }

  // ---- channels and timelines ----

  /** A channel lookup that serves community channels and DMs alike (requirement 17). */
  private target(channelId: string): Target | undefined {
    const known = this.channels.get(channelId);
    if (known !== undefined) return { communityId: known.communityId, dm: false, channel: known.row, textGroupId: known.row.textGroupId };
    const dm = this.dms.get(channelId);
    if (dm !== undefined) return { communityId: null, dm: true, channel: { id: fromHex(channelId), kind: 0, mode: 0 }, textGroupId: dm.groupId };
    return undefined;
  }

  private membership(channelId: string): GroupMembership {
    return { refusedChannel: this.refusedChannels.has(channelId), notMember: this.notMember, resyncing: this.resyncing };
  }

  private groupState(channelId: string, groups: readonly GroupInfo[] = this.core?.groups() ?? []): ChannelGroupState {
    const target = this.target(channelId);
    if (target === undefined) return 'none';
    return channelGroupState(target.channel, groups, this.membership(channelId));
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
    const target = this.target(channelId);
    if (target === undefined) throw new Refusal('E_BAD_INPUT', 'unknown channel');
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
        communityId: target.communityId === null ? null : fromHex(target.communityId), channelId: fromHex(channelId),
        textGroupId: target.textGroupId,
      });
      this.refusedChannels.delete(channelId);
      // Pre-flight ruling 1(ii): a channel closed meanwhile gets fresh slices but is not opened again.
      const current = this.open.get(channelId);
      if (current !== undefined) current.groupId = result.groupId;
      const dm = this.dms.get(channelId);
      if (dm !== undefined && dm.groupId === null) {
        dm.groupId = result.groupId;
        this.updateExpected();
      }
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
    this.pinsOpen.delete(channelId);
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
    const target = this.target(channelId);
    if (target === undefined) return;
    if (target.communityId === null) this.publishDms();
    else this.publishChannels(target.communityId);
  }

  /** The group id a channel's timeline is read from: the one its open resolved to, else the local group. */
  private timelineGroup(channelId: string, groups: readonly GroupInfo[], hint?: Id): Id | null {
    return this.open.get(channelId)?.groupId ?? hint ?? channelGroup(fromHex(channelId), groups)?.groupId ?? null;
  }

  private refreshTimeline(channelId: string, hint?: Id): void {
    const target = this.target(channelId);
    const core = this.core;
    const me = this.me;
    if (target === undefined || core === null || me === null) return;
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
    // A DM has no community member list to look senders up in.
    if (target.communityId !== null) this.lookUpMembers(target.communityId, timeline.items);
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
    this.safely(() => { this.reportActivity(groupId, result); });
    // Pre-flight ruling F6: an apply can adopt the own type-2 row (a catch-up) and so record a purge.
    this.runPurges();
  }

  private onMembership(groupId: Id, status: 'resyncing' | 'not-member'): void {
    const hex = toHex(groupId);
    if (status === 'resyncing') { this.resyncing.add(hex); this.notMember.delete(hex); }
    else { this.notMember.add(hex); this.resyncing.delete(hex); }
    this.safely(() => { this.touchGroup(groupId); });
  }

  /** Refreshes the row of every known channel or DM bound to the group and the timeline of every such open one. */
  private touchGroup(groupId: Id): void {
    const hex = toHex(groupId);
    const groups = this.core?.groups() ?? [];
    const bound = (channelId: string, textGroupId: Id | null): boolean => {
      const openGroup = this.open.get(channelId)?.groupId ?? null;
      const local = channelGroup(fromHex(channelId), groups);
      return (textGroupId !== null && toHex(textGroupId) === hex)
        || (openGroup !== null && toHex(openGroup) === hex)
        || (local !== undefined && toHex(local.groupId) === hex);
    };
    const communities = new Set<string>();
    const timelines: string[] = [];
    for (const [channelId, { communityId, row }] of this.channels) {
      if (!bound(channelId, row.textGroupId)) continue;
      communities.add(communityId);
      if (this.open.has(channelId)) timelines.push(channelId);
    }
    let dms = false;
    for (const [channelId, dm] of this.dms) {
      if (!bound(channelId, dm.groupId)) continue;
      dms = true;
      if (this.open.has(channelId)) timelines.push(channelId);
    }
    for (const communityId of communities) this.publishChannels(communityId);
    if (dms) this.publishDms();
    for (const channelId of timelines) this.refreshTimeline(channelId);
    for (const channelId of this.pinsOpen) if (bound(channelId, this.target(channelId)?.textGroupId ?? null)) this.publishPins(channelId);
  }

  // ---- sending ----

  /** The group a command of an open channel sends into: open, and its group active, else E_NOT_READY. */
  private activeGroup(channelId: string): Id {
    const entry = this.open.get(channelId);
    if (entry === undefined) throw new Refusal('E_NOT_READY', 'the channel is not open');
    const groups = this.requireCore().groups();
    const state = this.groupState(channelId, groups);
    const groupId = this.timelineGroup(channelId, groups);
    if (state !== 'active' || groupId === null) throw new Refusal('E_NOT_READY', `the channel's group is ${state}`);
    return groupId;
  }

  /** Requirement 9: the page has already encoded its mentions; the descriptors never enter a slice. */
  private send(c: Extract<Command, { m: 'send' }>): Promise<{ msgId: string }> {
    const groupId = this.activeGroup(c.channelId);
    const ids = c.attachments ?? [];
    let descriptors: AttachmentDescriptor[] = [];
    if (ids.length > 0) {
      const tray = this.trays.get(c.channelId);
      if (tray === undefined) throw new Refusal('E_TRAY_NOT_READY', '');
      try { descriptors = tray.take(ids); }
      catch (e) {
        if (e instanceof Error && e.message === 'E_TRAY_NOT_READY') throw new Refusal('E_TRAY_NOT_READY', '');
        throw e;
      }
      // take reported through onChange already; the store drops the equal value (ruled: worker-ui 8).
      this.publishTray(c.channelId, tray.entries());
    }
    const request: SendRequest = {
      type: 0, replyTo: c.replyTo === undefined || c.replyTo === null ? null : fromHex(c.replyTo), body: c.text, attachments: descriptors,
    };
    let msgId: Id;
    // The core enforces the 4000-byte limit (E_ENVELOPE_LIMIT); the controller does not measure the text.
    try { msgId = this.requireSync().sendRequest(groupId, request); }
    catch (e) {
      // The taken references were never sent; each is deleted now, or expires after pending_ttl (L-HTTP-83).
      const channel = fromHex(c.channelId);
      for (const d of descriptors) void this.routes.deleteBlob(channel, d.blobId).catch(() => undefined);
      throw e;
    }
    this.refreshTimeline(c.channelId);
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

  // ---- say more: folds, purges, pins and files (L-TS-35) ----

  /** Requirement 10: an edit, delete, reaction or pin is queued as its fold type aimed at the message; the page's state
   *  changes only when the core folds it (a pending fold shows as a PendingAction). The core's refusals cross as they are. */
  private fold(channelId: string, msgId: string, type: 1 | 2 | 3 | 4 | 5 | 6, body: string): Promise<null> {
    const groupId = this.activeGroup(channelId);
    this.requireSync().sendRequest(groupId, { type, replyTo: fromHex(msgId), body, attachments: [] });
    this.refreshTimeline(channelId);
    return Promise.resolve(null);
  }

  private editMessage(channelId: string, msgId: string, text: string): Promise<null> { return this.fold(channelId, msgId, 1, text); }

  /** The purge is not started here: the core records it when the type-2 row is confirmed (L-CORE-33, ruling 8). */
  private deleteMessage(channelId: string, msgId: string): Promise<null> { return this.fold(channelId, msgId, 2, ''); }

  /** Ruling 28: the worker does not de-duplicate reactions; the core folds them per user. */
  private react(channelId: string, msgId: string, emoji: string, on: boolean): Promise<null> {
    return this.fold(channelId, msgId, on ? 3 : 4, emoji);
  }

  private pin(channelId: string, msgId: string, on: boolean): Promise<null> { return this.fold(channelId, msgId, on ? 5 : 6, ''); }

  /** A text group targets its channel or DM (web-2a). */
  private channelOfGroup(g: Id): Id {
    const row = this.requireCore().groupRow(g);
    if (row === null) throw new CoreError('E_CORE_STATE', 'unknown group');
    return row.targetId;
  }

  /** Requirement 11: each reference of the row is confirmed, in order, before every upload attempt; the first refusal
   *  propagates to the engine. Only the uploading user can confirm (L-HTTP-82), so a refusal answers this user's own
   *  upload: a 404 means the reference expired or this user deleted it, and the person attaches again. */
  private async beforeSend(g: Id, row: OutboxRow): Promise<void> {
    const channel = this.channelOfGroup(g);
    for (const a of row.attachments) await this.routes.confirmBlob(channel, a.blobId);
  }

  /** A discarded row's references are deleted, not awaited; a failure is left to the pending_ttl sweep (L-HTTP-83). */
  private onDiscarded(g: Id, row: OutboxRow): void {
    let channel: Id;
    try { channel = this.channelOfGroup(g); } catch { return; }
    for (const a of row.attachments) void this.routes.deleteBlob(channel, a.blobId).catch(() => undefined);
  }

  /** Requirement 12, single flight: a call during a run makes the run go once more after it ends. */
  private runPurges(): void {
    if (this.purging !== null) { this.purgeAgain = true; return; }
    const run = (async () => {
      try {
        do { this.purgeAgain = false; await this.purgeOnce(); } while (this.purgeAgain);
      } finally {
        this.purging = null;
      }
    })();
    this.purging = run;
    void run.catch(() => undefined);
  }

  /** Read through a call: a wipe or a revocation can land in any await of a purge run. */
  private purgeable(core: CorePort): boolean {
    return this.core === core && this.me !== null && this.sync !== null && this.phase === 'ready' && !this.wiping && !this.storeCleared;
  }

  /** Carries out this device's own record of its own deletes, in order. A row of a group this device is not an active
   *  member of is kept: the delivery service's 404 to a non-member is its membership refusal, not completion (L-HTTP-80,
   *  FACTS-SECURITY-08), so the row runs once the group is back in state 2. Any other failure keeps the row for the next
   *  trigger and the run moves on. Residual (ruling 8): a device that never rejoins keeps its row until retention. */
  private async purgeOnce(): Promise<void> {
    const core = this.core;
    if (core === null || !this.purgeable(core)) return;
    let rows: ReturnType<CorePort['purges']>;
    try { rows = core.purges(); } catch { return; }
    for (const row of rows) {
      if (!this.purgeable(core)) return;
      try {
        const group = core.groupRow(row.groupId);
        if (group === null || group.state !== 2) continue;
        await this.routes.deleteGroupMessage(row.groupId, row.seq);          // 'deleted' and 'gone' are both done
        for (const blobId of row.blobIds) {
          try { await this.routes.deleteBlob(row.channelId, blobId); }
          catch (e) {
            // 403: the reference is not this user's (another uploader's file); nothing of ours is left to delete.
            if (!(e instanceof DillaHttpError && e.status === 403)) throw e;
          }
        }
        if (!this.purgeable(core)) return;
        core.purgeDone(row.groupId, row.seq);
      } catch { /* this row waits for the next trigger */ }
    }
  }

  /** Requirement 14. */
  private loadPins(channelId: string): Promise<null> {
    if (this.target(channelId) === undefined) throw new Refusal('E_BAD_INPUT', 'unknown channel');
    this.pinsOpen.add(channelId);
    this.publishPins(channelId);
    return Promise.resolve(null);
  }

  /** The pins slice keeps its last value. */
  private closePins(channelId: string): Promise<null> {
    this.pinsOpen.delete(channelId);
    return Promise.resolve(null);
  }

  private publishPins(channelId: string): void {
    const core = this.core;
    if (core === null) return;
    const g = this.timelineGroup(channelId, core.groups());
    const items: PinnedItem[] = g === null ? [] : core.pins(g).map((p) => ({
      msgId: toHex(p.msgId), seq: p.targetSeq.toString(), senderUser: p.author === null ? null : toHex(p.author), excerpt: p.excerpt,
      pinnedBy: toHex(p.byUser), pinnedSeq: p.pinnedSeq.toString(), ts: Number(p.targetTs),
    }));
    this.slices.set(`pins:${channelId}`, items);
  }

  /** The thumbnail seam: a unit test passes its own; else the worker global, when it can draw off screen. */
  private thumbDeps(): ThumbDeps | null {
    if (this.deps.thumbs !== undefined) return this.deps.thumbs;
    const scope = globalThis as { createImageBitmap?: unknown; OffscreenCanvas?: unknown };
    if (typeof scope.createImageBitmap !== 'function' || typeof scope.OffscreenCanvas !== 'function') return null;
    return { createImageBitmap: (b) => createImageBitmap(b), offscreen: (w, h) => new OffscreenCanvas(w, h) };
  }

  /** The slice entry names the file and its phase only: never the descriptor (Global Constraints "Never written"). */
  private publishTray(channelId: string, entries: readonly TrayEntry[]): void {
    const item = (e: TrayEntry): TrayItem => ({ id: e.id, name: e.name, size: e.size, mime: e.mime, image: e.image, phase: e.phase, reason: e.reason });
    this.slices.set(`tray:${channelId}`, entries.map(item));
  }

  private trayFor(channelId: string): Tray {
    const held = this.trays.get(channelId);
    if (held !== undefined) return held;
    const tray: Tray = new Tray({
      channelId: fromHex(channelId), routes: this.routes, thumb: this.thumbDeps(),
      random: (n) => crypto.getRandomValues(new Uint8Array(n)),
      // A tray dropped by a wipe or a reset publishes nothing more.
      onChange: (entries) => { if (this.trays.get(channelId) === tray) this.publishTray(channelId, entries); },
    });
    this.trays.set(channelId, tray);
    return tray;
  }

  /** Requirement 15: wipe and resetOnce drop every tray without a request; the pending references expire (L-HTTP-83). */
  private dropTrays(): void {
    for (const channelId of this.trays.keys()) this.slices.set(`tray:${channelId}`, []);
    this.trays.clear();
  }

  private async attachFiles(channelId: string, files: readonly File[]): Promise<{ trayIds: string[] }> {
    if (this.target(channelId) === undefined) throw new Refusal('E_BAD_INPUT', 'unknown channel');
    return { trayIds: await this.trayFor(channelId).add(files) };
  }

  private async discardAttachment(channelId: string, trayId: string): Promise<null> {
    await this.trays.get(channelId)?.discard(trayId);
    return null;
  }

  /** Requirement 16: the decrypted Blob crosses in the ret (structured clone); the worker keeps no copy and mints no URL. */
  private async openAttachment(channelId: string, seq: string, index: number, thumb: boolean): Promise<{ blob: Blob; name: string; mime: string }> {
    const core = this.requireCore();
    const g = this.timelineGroup(channelId, core.groups());
    if (g === null) throw new Refusal('E_NOT_READY', 'the channel has no group');
    const d = core.attachmentGet(g, BigInt(seq), index);
    if (thumb && d.thumb === null) throw new AttachmentError('E_ATTACHMENT_MISSING', 'no thumbnail');
    const blob = thumb ? await thumbnailBlob(d) : await fetchAttachment(this.routes, fromHex(channelId), d);
    return { blob, name: safeName(d.name, ''), mime: d.mime };
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

  private requireEnrol(): Enrol {
    if (this.enrol === null) throw new CoreError('E_CORE_STATE', 'no enrolment');
    return this.enrol;
  }

  private requireMe(): { userId: Id; deviceId: Id } {
    if (this.me === null) throw new CoreError('E_CORE_NO_IDENTITY', '');
    return this.me;
  }

  private requireSync(): SyncEngine {
    if (this.sync === null) throw new CoreError('E_CORE_STATE', 'no sync');
    return this.sync;
  }
}

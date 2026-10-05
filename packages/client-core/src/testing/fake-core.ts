/** The account half of CorePort for unit tests: identity phases, signup, the session record, the device list flags, KeyPackages, pause/resume/close. Every group, commit, send, outbox and timeline method throws CoreError('E_CORE_STATE', 'not modelled'); the group half is ModelCore (src/sync/testing/model.ts), held to the Rust core by L-CORE-10. Not exported from src/index.ts. */
import { encode } from '../cbor';
import { CoreError, type CorePort, type Id, type IdentityInfo, type SessionRecord, type GroupInfo, type ExpectedGroup,
  type WelcomeOutcome, type ApplyResult, type OutboxRow, type TimelineRow } from '../core-port';

export const FAKE_RECOVERY_KEY = '0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456789ABCDEFGHJK';

export class FakeCore implements CorePort {
  readonly calls: string[] = [];
  private readonly failures = new Map<keyof CorePort, CoreError>();
  readonly tier: number;
  private readonly idSeed: number;
  private counter = 1;
  private preferredDevice: Id | undefined;
  private info: IdentityInfo = { phase: 0, instanceId: null, userId: null, deviceId: null, username: '', listPublished: false };
  private listBody: Uint8Array | null = null;
  private record: SessionRecord | null = null;
  private paused = false;
  private closed = false;

  constructor(opts: { deviceId?: Id; tier?: number; idSeed?: number } = {}) {
    this.preferredDevice = opts.deviceId;
    this.tier = opts.tier ?? 1;
    this.idSeed = opts.idSeed ?? 0xf0;
  }
  static identified(o: { instanceId: Id; userId: Id; deviceId: Id; username: string; tier?: number; listPublished?: boolean }): FakeCore {
    const core = new FakeCore({ deviceId: o.deviceId, tier: o.tier });
    core.info = { phase: 2, instanceId: o.instanceId, userId: o.userId, deviceId: o.deviceId,
      username: o.username, listPublished: o.listPublished ?? true };
    core.listBody = core.makeList(o.userId, o.deviceId, 0n);
    return core;
  }
  failOnce(method: keyof CorePort, error: CoreError): void { this.failures.set(method, error); }
  private enter(method: keyof CorePort): void {
    this.calls.push(method);
    const error = this.failures.get(method);
    if (error !== undefined) { this.failures.delete(method); throw error; }
    if (this.paused || this.closed) throw new CoreError('E_STORE_PAUSED', 'the store is paused');
  }
  private nextId(): Id {
    const id = new Uint8Array(16);
    id[0] = this.idSeed;
    new DataView(id.buffer).setUint32(12, this.counter++);
    return id;
  }
  private requirePending(): void {
    if (this.info.phase !== 1) throw new CoreError('E_CORE_STATE', this.info.phase === 0 ? 'no signup is pending' : 'the identity is complete');
  }
  private requireIdentity(): void {
    if (this.info.phase !== 2) throw new CoreError('E_CORE_NO_IDENTITY');
  }
  private makeList(userId: Id, deviceId: Id, now: bigint): Uint8Array {
    return encode([1, encode(['fake.list', userId, deviceId, now]), new Uint8Array(64).fill(5), new Uint8Array(32)]);
  }
  pause(): void { this.enter('pause'); this.paused = true; }
  resume(): Promise<void> {
    this.calls.push('resume');
    const error = this.failures.get('resume');
    if (error !== undefined) { this.failures.delete('resume'); throw error; }
    if (this.closed) throw new CoreError('E_STORE_PAUSED', 'the store is paused');
    this.paused = false;
    return Promise.resolve();
  }
  close(): void { this.enter('close'); this.closed = true; }
  identity(): IdentityInfo { this.enter('identity'); return { ...this.info }; }
  signupBegin(instanceId: Id): string {
    this.enter('signupBegin');
    if (this.info.phase !== 0) throw new CoreError('E_CORE_STATE', this.info.phase === 1 ? 'a signup is pending' : 'an identity exists');
    this.info = { phase: 1, instanceId, userId: null, deviceId: this.preferredDevice ?? this.nextId(), username: '', listPublished: false };
    return FAKE_RECOVERY_KEY;
  }
  signupRequest(invite: string, username: string, display: string, password: string | null): Uint8Array {
    this.enter('signupRequest'); this.requirePending();
    const deviceId = this.info.deviceId;
    if (deviceId === null) throw new CoreError('E_CORE_NO_IDENTITY');
    return encode([invite, username, display, new Uint8Array(32).fill(1), new Uint8Array(32).fill(2),
      new Uint8Array(64).fill(3), password, [deviceId, new Uint8Array(32).fill(4), 1, 1,
        encode(['fake.cred', new Uint8Array(16), deviceId])]]);
  }
  signupComplete(userId: Id, username: string, now: bigint): Uint8Array {
    this.enter('signupComplete'); this.requirePending();
    const deviceId = this.info.deviceId;
    if (deviceId === null) throw new CoreError('E_CORE_NO_IDENTITY');
    this.listBody = this.makeList(userId, deviceId, now);
    this.info = { ...this.info, phase: 2, userId, username, listPublished: false };
    return this.listBody;
  }
  signupReset(): void {
    this.enter('signupReset'); this.requirePending();
    if (this.record !== null) throw new CoreError('E_CORE_STATE', 'the account is registered');
    this.info = { phase: 0, instanceId: null, userId: null, deviceId: null, username: '', listPublished: false };
    this.listBody = null;
  }
  deviceListBody(): Uint8Array {
    this.enter('deviceListBody'); this.requireIdentity();
    if (this.listBody === null) throw new CoreError('E_CORE_STATE');
    return this.listBody;
  }
  deviceListPublished(): void { this.enter('deviceListPublished'); this.requireIdentity(); this.info.listPublished = true; }
  sessionSign(nonce: Uint8Array, purpose: 0 | 1): Uint8Array {
    this.enter('sessionSign');
    if (this.info.phase === 0) throw new CoreError('E_CORE_NO_IDENTITY');
    if (nonce.length !== 32 || (purpose !== 0 && purpose !== 1)) throw new CoreError('E_CORE_INPUT');
    return encode([nonce, purpose, new Uint8Array(64).fill(6), null, null]);
  }
  sessionStore(s: SessionRecord): void {
    this.enter('sessionStore');
    if (this.info.phase === 0) throw new CoreError('E_CORE_NO_IDENTITY');
    this.record = { ...s };
  }
  session(): SessionRecord | null { this.enter('session'); return this.record === null ? null : { ...this.record }; }
  sessionClear(): void { this.enter('sessionClear'); this.record = null; }
  keyPackages(count: number, lastResort: boolean): Uint8Array {
    this.enter('keyPackages'); this.requireIdentity();
    if (!Number.isInteger(count) || count < 1 || count > 32) throw new CoreError('E_CORE_INPUT');
    const device = this.info.deviceId;
    if (device === null) throw new CoreError('E_CORE_NO_IDENTITY');
    const packages = Array.from({ length: count }, (_, i) => encode(['fake.kp', device, i, 0]));
    return encode([packages, lastResort ? encode(['fake.kp', device, count, 1]) : null]);
  }
  private notModelled(name: keyof CorePort, ...args: unknown[]): never {
    this.enter(name);
    void args;
    throw new CoreError('E_CORE_STATE', 'not modelled');
  }
  groups(): GroupInfo[] { return this.notModelled('groups'); }
  groupCreate(groupId: Id, communityId: Id, channelId: Id, policyVersion: bigint, externalSenderPub: Uint8Array): Uint8Array { return this.notModelled('groupCreate', groupId, communityId, channelId, policyVersion, externalSenderPub); }
  groupRegistered(groupId: Id, nextSeq: bigint): void { return this.notModelled('groupRegistered', groupId, nextSeq); }
  groupDiscard(groupId: Id): void { return this.notModelled('groupDiscard', groupId); }
  groupJoinExternal(g: ExpectedGroup, infoBody: Uint8Array, treeBody: Uint8Array): Uint8Array { return this.notModelled('groupJoinExternal', g, infoBody, treeBody); }
  groupJoined(groupId: Id, seq: bigint): void { return this.notModelled('groupJoined', groupId, seq); }
  welcomesApply(welcomesBody: Uint8Array, expected: ExpectedGroup[]): WelcomeOutcome[] { return this.notModelled('welcomesApply', welcomesBody, expected); }
  groupApply(groupId: Id, handshakes: Uint8Array, messages: Uint8Array, through: bigint): ApplyResult { return this.notModelled('groupApply', groupId, handshakes, messages, through); }
  commitBuild(groupId: Id, proposalsBody: Uint8Array): Uint8Array { return this.notModelled('commitBuild', groupId, proposalsBody); }
  commitConfirm(groupId: Id): ApplyResult { return this.notModelled('commitConfirm', groupId); }
  commitAbort(groupId: Id): void { return this.notModelled('commitAbort', groupId); }
  cursorBody(groupId: Id): Uint8Array | null { return this.notModelled('cursorBody', groupId); }
  cursorAcked(groupId: Id, lastSeq: bigint, lastEpoch: bigint): void { return this.notModelled('cursorAcked', groupId, lastSeq, lastEpoch); }
  messageDeleted(groupId: Id, seq: bigint): ApplyResult { return this.notModelled('messageDeleted', groupId, seq); }
  sendPrepare(groupId: Id, body: string, now: bigint): Id { return this.notModelled('sendPrepare', groupId, body, now); }
  sendEncrypt(msgId: Id): { groupId: Id; messageBody: Uint8Array } { return this.notModelled('sendEncrypt', msgId); }
  sendConfirm(msgId: Id, response: Uint8Array): { groupId: Id; seq: bigint } { return this.notModelled('sendConfirm', msgId, response); }
  sendRequeue(msgId: Id): void { return this.notModelled('sendRequeue', msgId); }
  sendFail(msgId: Id, error: string): void { return this.notModelled('sendFail', msgId, error); }
  sendRetry(msgId: Id): void { return this.notModelled('sendRetry', msgId); }
  sendDiscard(msgId: Id): void { return this.notModelled('sendDiscard', msgId); }
  outbox(groupId: Id): OutboxRow[] { return this.notModelled('outbox', groupId); }
  timeline(groupId: Id, beforeSeq: bigint, limit: number): TimelineRow[] { return this.notModelled('timeline', groupId, beforeSeq, limit); }
}

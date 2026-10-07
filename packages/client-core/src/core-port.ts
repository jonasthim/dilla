import { arr, bin, decode, encode, opt, str, u53, u64, CborError, type CborValue } from './cbor';

export class CoreError extends Error {
  readonly code: string;
  readonly detail: string;
  constructor(code: string, detail = '') {
    super(detail === '' ? code : `${code}: ${detail}`);
    this.name = 'CoreError'; this.code = code; this.detail = detail;
  }
  static from(err: unknown): CoreError {
    if (err instanceof CoreError) return err;
    if (err instanceof Error) {
      const match = /^(E_[A-Z0-9_]+)(?:: ([\s\S]*))?$/.exec(err.message);
      return match ? new CoreError(match[1] ?? '', match[2] ?? '') : new CoreError('E_CORE_WASM', err.message);
    }
    return new CoreError('E_CORE_WASM', String(err));
  }
}
export type Id = Uint8Array;
export interface IdentityInfo { phase: 0 | 1 | 2 | 3; instanceId: Id | null; userId: Id | null; deviceId: Id | null; username: string; listPublished: boolean; }
export interface SessionRecord { token: string; expires: bigint; idleExpires: bigint; }
export const GroupState = { registering: 0, joining: 1, active: 2, needsResync: 3, gone: 4 } as const;
export interface GroupInfo { groupId: Id; kind: number; communityId: Id | null; targetId: Id; state: 0 | 1 | 2 | 3 | 4; epoch: bigint; nextSeq: bigint; proposalsPending: number; pendingCommit: boolean; }
export interface ApplyResult { state: 0 | 1 | 2 | 3 | 4; epoch: bigint; nextSeq: bigint; newSeqs: bigint[]; proposalsPending: number; epochChanged: boolean; ownAdopted: boolean; }
export interface WelcomeOutcome { welcomeId: bigint; groupId: Id; outcome: 0 | 1 | 2 | 3; reason: string; }
export interface ExpectedGroup { groupId: Id; communityId: Id | null; channelId: Id; policyVersion: bigint; }
export interface ActivityRow { groupId: Id; unread: number; mentions: number; lastSeq: bigint; lastTs: bigint; lastReadSeq: bigint; }
export interface DeviceEntryInfo { deviceId: Id; dskPub: Uint8Array; tier: 0 | 1; addedAt: bigint; revokedAt: bigint | null; }
export interface OwnDeviceList { version: bigint; published: boolean; entries: DeviceEntryInfo[]; }
export interface SealedObjects { root: Uint8Array | null; state: Uint8Array | null; stateUploaded: boolean; }
/** What enrol_complete and device_list_revoke sign: the next list's PUT body, the re-sealed state object, and the PUT
 *  body of an interrupted publication the core found in the state object and signed on, to send first
 *  (BACKUPS-RECOVERY-02), else null. */
export interface SignedLists { deviceListBody: Uint8Array; stateSealed: Uint8Array; interrupted: Uint8Array | null; }
export interface OutboxRow { msgId: Id; state: 0 | 1 | 2; error: string; created: bigint; body: string; }
export interface TimelineRow { seq: bigint; epoch: bigint; recvTs: bigint; status: 0 | 1 | 2; reason: string; senderUser: Id | null; senderDevice: Id; senderKind: number | null; senderTier: number | null; msgId: Id | null; type: number | null; body: string; }
export interface CorePort {
  pause(): void; resume(): Promise<void>; close(): void;
  identity(): IdentityInfo;
  signupBegin(instanceId: Id): string;
  signupRequest(invite: string, username: string, display: string, password: string | null): Uint8Array;
  signupComplete(userId: Id, username: string, now: bigint): Uint8Array;
  signupReset(): void;
  deviceListBody(): Uint8Array; deviceListPublished(): void;
  /** BACKUPS-RECOVERY-02: an unpublished candidate is dropped; the accepted list's own body becomes the candidate. */
  deviceListDrop(): void;
  sessionSign(nonce: Uint8Array, purpose: 0 | 1): Uint8Array;
  sessionStore(s: SessionRecord): void; session(): SessionRecord | null; sessionClear(): void;
  keyPackages(count: number, lastResort: boolean): Uint8Array;
  groups(): GroupInfo[];
  groupCreate(groupId: Id, communityId: Id | null, channelId: Id, policyVersion: bigint, externalSenderPub: Uint8Array): Uint8Array;
  groupRegistered(groupId: Id, nextSeq: bigint): void;
  groupDiscard(groupId: Id): void;
  groupJoinExternal(g: ExpectedGroup, infoBody: Uint8Array, treeBody: Uint8Array): Uint8Array;
  groupJoined(groupId: Id, seq: bigint): void;
  welcomesApply(welcomesBody: Uint8Array, expected: ExpectedGroup[]): WelcomeOutcome[];
  groupApply(groupId: Id, handshakes: Uint8Array, messages: Uint8Array, through: bigint): ApplyResult;
  commitBuild(groupId: Id, proposalsBody: Uint8Array): Uint8Array;
  commitConfirm(groupId: Id): ApplyResult; commitAbort(groupId: Id): void;
  cursorBody(groupId: Id): Uint8Array | null; cursorAcked(groupId: Id, lastSeq: bigint, lastEpoch: bigint): void;
  messageDeleted(groupId: Id, seq: bigint): ApplyResult;
  sendPrepare(groupId: Id, body: string, now: bigint): Id;
  sendEncrypt(msgId: Id): { groupId: Id; messageBody: Uint8Array };
  sendConfirm(msgId: Id, response: Uint8Array): { groupId: Id; seq: bigint };
  sendRequeue(msgId: Id): void; sendFail(msgId: Id, error: string): void; sendRetry(msgId: Id): void; sendDiscard(msgId: Id): void;
  outbox(groupId: Id): OutboxRow[];
  timeline(groupId: Id, beforeSeq: bigint, limit: number): TimelineRow[];
  groupRow(groupId: Id): GroupInfo | null;
  markRead(groupId: Id, seq: bigint, now: bigint): void;
  activity(): ActivityRow[];
  settings(): Record<string, string>; settingPut(k: string, v: string): void; settingDelete(k: string): void;
  sealedObjects(): SealedObjects; stateSealedUploaded(): void;
  enrolBegin(instanceId: Id): { deviceId: Id; dskPub: Uint8Array };
  enrolSessionSign(nonce: Uint8Array, login: Uint8Array): Uint8Array;
  enrolRegistered(userId: Id): void;
  /** REGISTRATION-DEVICES-02: the typed key's form (the core's normaliser and strict parse); E_RECOVERY_KEY otherwise. */
  recoveryKeyCheck(recoveryKey: string): void;
  enrolComplete(input: { recoveryKey: string; rootSealed: Uint8Array; stateSealed: Uint8Array; listBody: Uint8Array; username: string; now: bigint }): SignedLists;
  enrolReset(): void;
  deviceListRevoke(input: { recoveryKey: string; rootSealed: Uint8Array; stateSealed: Uint8Array; listBody: Uint8Array; deviceIds: Id[]; now: bigint }): SignedLists;
  ownDeviceListUpdate(historyBody: Uint8Array): { version: bigint; listed: boolean };
  ownDeviceList(): OwnDeviceList;
}

export interface CoreHandle {
      capacity(): number; reserve_capacity(n: number): Promise<void>;
      pause(): void; resume(): Promise<void>; close(): void;
      identity(): Uint8Array;
      signup_begin(instance_id: Uint8Array): string;
      signup_request(invite: string, username: string, display: string, password?: string | null): Uint8Array;
      signup_complete(user_id: Uint8Array, username: string, now: bigint): Uint8Array;
      signup_reset(): void;
      device_list_body(): Uint8Array; device_list_published(): void; device_list_drop(): void;
      session_sign(nonce: Uint8Array, purpose: number): Uint8Array;
      session_store(token: string, expires: bigint, idle_expires: bigint): void;
      session(): Uint8Array; session_clear(): void;
      key_packages(count: number, last_resort: boolean): Uint8Array;
      sealed_objects(): Uint8Array;
      groups(): Uint8Array;
      group_create(group_id: Uint8Array, community_id: Uint8Array | null | undefined, channel_id: Uint8Array, policy_version: bigint, external_sender_pub: Uint8Array): Uint8Array;
      group_registered(group_id: Uint8Array, next_seq: bigint): void;
      group_discard(group_id: Uint8Array): void;
      group_join_external(group_id: Uint8Array, community_id: Uint8Array | null | undefined, channel_id: Uint8Array, policy_version: bigint, info_body: Uint8Array, tree_body: Uint8Array): Uint8Array;
      group_joined(group_id: Uint8Array, seq: bigint): void;
      welcomes_apply(welcomes_body: Uint8Array, expected: Uint8Array): Uint8Array;
      group_apply(group_id: Uint8Array, handshakes: Uint8Array, messages: Uint8Array, through: bigint): Uint8Array;
      commit_build(group_id: Uint8Array, proposals_body: Uint8Array): Uint8Array;
      commit_confirm(group_id: Uint8Array): Uint8Array;
      commit_abort(group_id: Uint8Array): void;
      cursor_body(group_id: Uint8Array): Uint8Array;
      cursor_acked(group_id: Uint8Array, last_seq: bigint, last_epoch: bigint): void;
      message_deleted(group_id: Uint8Array, seq: bigint): Uint8Array;
      send_prepare(group_id: Uint8Array, body: string, now: bigint): Uint8Array;
      send_encrypt(msg_id: Uint8Array): Uint8Array;
      send_confirm(msg_id: Uint8Array, response: Uint8Array): Uint8Array;
      send_requeue(msg_id: Uint8Array): void; send_fail(msg_id: Uint8Array, error: string): void;
      send_retry(msg_id: Uint8Array): void; send_discard(msg_id: Uint8Array): void;
      outbox(group_id: Uint8Array): Uint8Array;
      timeline(group_id: Uint8Array, before_seq: bigint, limit: number): Uint8Array;
      group_row(group_id: Uint8Array): Uint8Array;
      mark_read(group_id: Uint8Array, seq: bigint, now: bigint): void;
      activity(): Uint8Array;
      settings(): Uint8Array; setting_put(k: string, v: string): void; setting_delete(k: string): void;
      enrol_begin(instance_id: Uint8Array): Uint8Array;
      enrol_session_sign(nonce: Uint8Array, login: Uint8Array): Uint8Array;
      enrol_registered(user_id: Uint8Array): void;
      recovery_key_check(recovery_key: string): void;
      enrol_complete(recovery_key: string, root_sealed: Uint8Array, state_sealed: Uint8Array, list_body: Uint8Array, username: string, now: bigint): Uint8Array;
      enrol_reset(): void;
      device_list_revoke(recovery_key: string, root_sealed: Uint8Array, state_sealed: Uint8Array, list_body: Uint8Array, device_ids: Uint8Array, now: bigint): Uint8Array;
      own_device_list_update(history_body: Uint8Array): Uint8Array;
      own_device_list(): Uint8Array;
      state_sealed_uploaded(): void;
    }
    export interface StoreOpenConfigLike { directory: string; db_name: string; kek_hex: string; }
    export interface CoreWasmModule {
      core_open(cfg: StoreOpenConfigLike): Promise<CoreHandle>;
      StoreOpenConfig: new (directory: string, db_name: string, kek_hex: string) => StoreOpenConfigLike;
      is_sah_contention(err: unknown): boolean;
      probe_persistence(): Promise<string>;
    }

function call<T>(fn: () => T): T {
  try { return fn(); } catch (err) { throw CoreError.from(err); }
}
function decoded<T>(method: string, bytes: Uint8Array, read: (v: CborValue) => T): T {
  try { return read(decode(bytes)); }
  catch (err) {
    if (err instanceof CborError || err instanceof RangeError) throw new CoreError('E_CORE_DECODE', `${method}: ${err.message}`);
    throw err;
  }
}
function field(a: CborValue[], i: number): CborValue { return a[i] ?? null; }
function oneOf<T extends number>(v: CborValue, values: readonly T[]): T {
  const n = u53(v);
  if (!values.includes(n as T)) throw new CborError('E_CBOR_RANGE', `unexpected value ${n}`);
  return n as T;
}
function readIdentity(v: CborValue): IdentityInfo {
  const a = arr(v, 6);
  return { phase: oneOf(field(a, 0), [0, 1, 2, 3]), instanceId: opt(field(a, 1), (x) => bin(x, 16)),
    userId: opt(field(a, 2), (x) => bin(x, 16)), deviceId: opt(field(a, 3), (x) => bin(x, 16)),
    username: str(field(a, 4)), listPublished: u64(field(a, 5)) === 1n };
}
function readSession(v: CborValue): SessionRecord | null {
  if (v === null) return null;
  const a = arr(v, 3);
  return { token: str(field(a, 0)), expires: u64(field(a, 1)), idleExpires: u64(field(a, 2)) };
}
function readGroup(v: CborValue): GroupInfo {
  const a = arr(v, 9);
  return { groupId: bin(field(a, 0), 16), kind: u53(field(a, 1)), communityId: opt(field(a, 2), (x) => bin(x, 16)),
    targetId: bin(field(a, 3), 16), state: oneOf(field(a, 4), [0, 1, 2, 3, 4]), epoch: u64(field(a, 5)),
    nextSeq: u64(field(a, 6)), proposalsPending: u53(field(a, 7)), pendingCommit: u64(field(a, 8)) === 1n };
}
function readApply(v: CborValue): ApplyResult {
  const a = arr(v, 6); const flags = u64(field(a, 5));
  return { state: oneOf(field(a, 0), [0, 1, 2, 3, 4]), epoch: u64(field(a, 1)), nextSeq: u64(field(a, 2)),
    newSeqs: arr(field(a, 3)).map(u64), proposalsPending: u53(field(a, 4)),
    epochChanged: (flags & 1n) !== 0n, ownAdopted: (flags & 2n) !== 0n };
}
function readWelcome(v: CborValue): WelcomeOutcome {
  const a = arr(v, 4);
  return { welcomeId: u64(field(a, 0)), groupId: bin(field(a, 1), 16), outcome: oneOf(field(a, 2), [0, 1, 2, 3]), reason: str(field(a, 3)) };
}
function readOutbox(v: CborValue): OutboxRow {
  const a = arr(v, 5);
  return { msgId: bin(field(a, 0), 16), state: oneOf(field(a, 1), [0, 1, 2]), error: str(field(a, 2)), created: u64(field(a, 3)), body: str(field(a, 4)) };
}
function readTimeline(v: CborValue): TimelineRow {
  const a = arr(v, 12);
  return { seq: u64(field(a, 0)), epoch: u64(field(a, 1)), recvTs: u64(field(a, 2)), status: oneOf(field(a, 3), [0, 1, 2]),
    reason: str(field(a, 4)), senderUser: opt(field(a, 5), (x) => bin(x, 16)), senderDevice: bin(field(a, 6), 16),
    senderKind: opt(field(a, 7), u53), senderTier: opt(field(a, 8), u53), msgId: opt(field(a, 9), (x) => bin(x, 16)),
    type: opt(field(a, 10), u53), body: str(field(a, 11)) };
}
function readActivity(v: CborValue): ActivityRow {
  const a = arr(v, 6);
  return { groupId: bin(field(a, 0), 16), unread: u53(field(a, 1)), mentions: u53(field(a, 2)),
    lastSeq: u64(field(a, 3)), lastTs: u64(field(a, 4)), lastReadSeq: u64(field(a, 5)) };
}
function readEntry(v: CborValue): DeviceEntryInfo {
  const a = arr(v, 5);
  return { deviceId: bin(field(a, 0), 16), dskPub: bin(field(a, 1), 32), tier: oneOf(field(a, 2), [0, 1]),
    addedAt: u64(field(a, 3)), revokedAt: opt(field(a, 4), u64) };
}
function readOwnList(v: CborValue): OwnDeviceList {
  const a = arr(v, 3);
  return { version: u64(field(a, 0)), published: oneOf(field(a, 1), [0, 1]) === 1,
    entries: arr(field(a, 2)).map(readEntry) };
}
function readSealed(v: CborValue): SealedObjects {
  const a = arr(v, 3);
  return { root: opt(field(a, 0), bin), state: opt(field(a, 1), bin), stateUploaded: oneOf(field(a, 2), [0, 1]) === 1 };
}
function readSigned(v: CborValue): SignedLists {
  const a = arr(v, 3);
  return { deviceListBody: bin(field(a, 0)), stateSealed: bin(field(a, 1)), interrupted: opt(field(a, 2), bin) };
}

export function wrapCore(handle: CoreHandle): CorePort {
  return {
    pause: () => call(() => handle.pause()),
    resume: () => call(async () => { try { await handle.resume(); } catch (err) { throw CoreError.from(err); } }),
    close: () => call(() => handle.close()),
    identity: () => call(() => decoded('identity', handle.identity(), readIdentity)),
    signupBegin: (instanceId) => call(() => handle.signup_begin(instanceId)),
    signupRequest: (invite, username, display, password) => call(() => handle.signup_request(invite, username, display, password)),
    signupComplete: (userId, username, now) => call(() => handle.signup_complete(userId, username, now)),
    signupReset: () => call(() => handle.signup_reset()),
    deviceListBody: () => call(() => handle.device_list_body()),
    deviceListPublished: () => call(() => handle.device_list_published()),
    deviceListDrop: () => call(() => handle.device_list_drop()),
    sessionSign: (nonce, purpose) => call(() => handle.session_sign(nonce, purpose)),
    sessionStore: (s) => call(() => handle.session_store(s.token, s.expires, s.idleExpires)),
    session: () => call(() => decoded('session', handle.session(), readSession)),
    sessionClear: () => call(() => handle.session_clear()),
    keyPackages: (count, lastResort) => call(() => handle.key_packages(count, lastResort)),
    groups: () => call(() => decoded('groups', handle.groups(), (v) => arr(v).map(readGroup))),
    groupCreate: (groupId, communityId, channelId, policyVersion, externalSenderPub) => call(() => handle.group_create(groupId, communityId, channelId, policyVersion, externalSenderPub)),
    groupRegistered: (groupId, nextSeq) => call(() => handle.group_registered(groupId, nextSeq)),
    groupDiscard: (groupId) => call(() => handle.group_discard(groupId)),
    groupJoinExternal: (g, infoBody, treeBody) => call(() => handle.group_join_external(g.groupId, g.communityId, g.channelId, g.policyVersion, infoBody, treeBody)),
    groupJoined: (groupId, seq) => call(() => handle.group_joined(groupId, seq)),
    welcomesApply: (welcomesBody, expected) => call(() => decoded('welcomesApply', handle.welcomes_apply(welcomesBody,
      encode(expected.map((e) => [e.groupId, e.communityId, e.channelId, e.policyVersion]))), (v) => arr(v).map(readWelcome))),
    groupApply: (groupId, handshakes, messages, through) => call(() => decoded('groupApply', handle.group_apply(groupId, handshakes, messages, through), readApply)),
    commitBuild: (groupId, proposalsBody) => call(() => handle.commit_build(groupId, proposalsBody)),
    commitConfirm: (groupId) => call(() => decoded('commitConfirm', handle.commit_confirm(groupId), readApply)),
    commitAbort: (groupId) => call(() => handle.commit_abort(groupId)),
    cursorBody: (groupId) => call(() => {
      const bytes = handle.cursor_body(groupId);
      return decoded('cursorBody', bytes, (v) => v === null ? null : bytes);
    }),
    cursorAcked: (groupId, lastSeq, lastEpoch) => call(() => handle.cursor_acked(groupId, lastSeq, lastEpoch)),
    messageDeleted: (groupId, seq) => call(() => decoded('messageDeleted', handle.message_deleted(groupId, seq), readApply)),
    sendPrepare: (groupId, body, now) => call(() => decoded('sendPrepare', handle.send_prepare(groupId, body, now), (v) => bin(field(arr(v, 1), 0), 16))),
    sendEncrypt: (msgId) => call(() => decoded('sendEncrypt', handle.send_encrypt(msgId), (v) => {
      const a = arr(v, 2); return { groupId: bin(field(a, 0), 16), messageBody: bin(field(a, 1)) };
    })),
    sendConfirm: (msgId, response) => call(() => decoded('sendConfirm', handle.send_confirm(msgId, response), (v) => {
      const a = arr(v, 2); return { groupId: bin(field(a, 0), 16), seq: u64(field(a, 1)) };
    })),
    sendRequeue: (msgId) => call(() => handle.send_requeue(msgId)),
    sendFail: (msgId, error) => call(() => handle.send_fail(msgId, error)),
    sendRetry: (msgId) => call(() => handle.send_retry(msgId)),
    sendDiscard: (msgId) => call(() => handle.send_discard(msgId)),
    outbox: (groupId) => call(() => decoded('outbox', handle.outbox(groupId), (v) => arr(v).map(readOutbox))),
    timeline: (groupId, beforeSeq, limit) => call(() => decoded('timeline', handle.timeline(groupId, beforeSeq, limit), (v) => arr(v).map(readTimeline))),
    groupRow: (groupId) => call(() => decoded('groupRow', handle.group_row(groupId), (v) => v === null ? null : readGroup(v))),
    markRead: (groupId, seq, now) => call(() => handle.mark_read(groupId, seq, now)),
    activity: () => call(() => decoded('activity', handle.activity(), (v) => arr(v).map(readActivity))),
    settings: () => call(() => decoded('settings', handle.settings(), (v) => Object.fromEntries(arr(v).map((row) => {
      const a = arr(row, 2); return [str(field(a, 0)), str(field(a, 1))];
    })))),
    settingPut: (k, v) => call(() => handle.setting_put(k, v)),
    settingDelete: (k) => call(() => handle.setting_delete(k)),
    sealedObjects: () => call(() => decoded('sealedObjects', handle.sealed_objects(), readSealed)),
    stateSealedUploaded: () => call(() => handle.state_sealed_uploaded()),
    enrolBegin: (instanceId) => call(() => decoded('enrolBegin', handle.enrol_begin(instanceId), (v) => {
      const a = arr(v, 2); return { deviceId: bin(field(a, 0), 16), dskPub: bin(field(a, 1), 32) };
    })),
    enrolSessionSign: (nonce, login) => call(() => handle.enrol_session_sign(nonce, login)),
    enrolRegistered: (userId) => call(() => handle.enrol_registered(userId)),
    recoveryKeyCheck: (recoveryKey) => call(() => handle.recovery_key_check(recoveryKey)),
    enrolComplete: (input) => call(() => decoded('enrolComplete', handle.enrol_complete(input.recoveryKey, input.rootSealed,
      input.stateSealed, input.listBody, input.username, input.now), readSigned)),
    enrolReset: () => call(() => handle.enrol_reset()),
    deviceListRevoke: (input) => call(() => {
      if (input.deviceIds.length < 1 || input.deviceIds.length > 64 || input.deviceIds.some((deviceId) => deviceId.length !== 16))
        throw new CoreError('E_CORE_INPUT', 'device ids must be 1..64 ids of 16 bytes');
      const ids = new Uint8Array(input.deviceIds.length * 16);
      input.deviceIds.forEach((deviceId, index) => ids.set(deviceId, index * 16));
      return decoded('deviceListRevoke', handle.device_list_revoke(input.recoveryKey, input.rootSealed,
        input.stateSealed, input.listBody, ids, input.now), readSigned);
    }),
    ownDeviceListUpdate: (historyBody) => call(() => decoded('ownDeviceListUpdate', handle.own_device_list_update(historyBody), (v) => {
      const a = arr(v, 2); return { version: u64(field(a, 0)), listed: oneOf(field(a, 1), [0, 1]) === 1 };
    })),
    ownDeviceList: () => call(() => decoded('ownDeviceList', handle.own_device_list(), readOwnList)),
  };
}

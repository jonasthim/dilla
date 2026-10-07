/**
 * The group-half model of CorePort. It is held to the Rust core by `parity.test.ts` (L-CORE-10);
 * change a rule here only together with the fixture.
 *
 * Test support for src/sync: a modelled delivery service (ModelDs), a core whose group half
 * follows L-CORE-07..09 over a readable stand-in wire (ModelCore), a scripted gateway
 * (FakeGateway) and a manual clock. Nothing here does any cryptography: an application message
 * is a CBOR array that names its sender, which is enough to test ordering, adoption, commits and
 * joins. Words of the copy lint (scripts/check-ui-copy.mjs) appear nowhere in this file.
 */
import { arr, bin, decode, encode, str, u64, type CborInput, type CborValue } from '../../cbor';
import {
  CoreError,
  type ApplyResult,
  type CorePort,
  type ExpectedGroup,
  type GroupInfo,
  type Id,
  type IdentityInfo,
  type OutboxRow,
  type TimelineRow,
  type WelcomeOutcome,
  type ActivityRow,
  type OwnDeviceList,
  type SealedObjects,
  type SignedLists,
} from '../../core-port';
import type { Frame } from '../../gateway/frames';
import type { GatewayEvent, ReadyInfo } from '../../gateway/gateway';
import { toHex } from '../../hex';
import { DillaHttpError } from '../../http/errors';
import type { Routes } from '../../http/routes';
import { fakeDskPub, fakeListBlob, fakeListNames, readFakeList } from '../../testing/fake-list';

export interface Peer {
  device: Id;
  user: Id;
}

/** A 16-byte id: tag in byte 0, n (0..65535) in bytes 14-15. */
export function idOf(tag: number, n: number): Id {
  const b = new Uint8Array(16);
  b[0] = tag;
  b[14] = (n >> 8) & 0xff;
  b[15] = n & 0xff;
  return b;
}

export const ME: Peer = { device: idOf(0xd0, 1), user: idOf(0xe0, 1) };
export const PEER: Peer = { device: idOf(0xd0, 2), user: idOf(0xe0, 2) };
export const THIRD: Peer = { device: idOf(0xd0, 3), user: idOf(0xe0, 3) };
export const FOURTH: Peer = { device: idOf(0xd0, 4), user: idOf(0xe0, 4) };
export const COMMUNITY = idOf(0xc0, 1);
export const CHANNEL = idOf(0xc1, 1);
export const CHANNEL_2 = idOf(0xc1, 2);

export function at<T>(a: readonly T[], i: number): T {
  const v = a[i];
  if (v === undefined) throw new Error(`index ${String(i)} out of range`);
  return v;
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  return toHex(a) === toHex(b);
}

function bySeq(a: { seq: bigint }, b: { seq: bigint }): number {
  return a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0;
}

/** The DillaHttpError constructor of the L-HTTP-20…45 header (task 13); this is its only call site. */
export function httpError(status: number, code: string, retryAfterMs: number | null = null, extra: CborValue[] = []): DillaHttpError {
  return new DillaHttpError({ status, code, detail: '', retryAfterMs, extra });
}

/** The CoreError constructor of L-TS-03 (task 15); this is its only call site. */
export function coreError(code: string, detail = ''): CoreError {
  return new CoreError(code, detail);
}

/** Lets every pending microtask chain run to its end (no fake here waits on a real timer). */
export async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 0);
    });
  }
}

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** The stand-in tree hash of a group at an epoch: the group id in bytes 0-15, the epoch big-endian in bytes 24-31. */
function treeHashOf(groupId: Id, epoch: bigint): Uint8Array {
  const h = new Uint8Array(32);
  h.set(groupId, 0);
  new DataView(h.buffer).setBigUint64(24, epoch);
  return h;
}

/**
 * The stand-in commitment C of an outbox row's envelope: 0xcc, then the message id. The real C is
 * keyed by the envelope's k_f, fixed when the row is prepared, so it names one outbox row and every
 * upload of it; the message id does the same here.
 */
function commitmentFor(msgId: Id): Uint8Array {
  const c = new Uint8Array(32);
  c[0] = 0xcc;
  c.set(msgId, 1);
  return c;
}

/** The stand-in wire shared by ModelCore and ModelDs. */
export const wire = {
  app: (from: Peer, msgId: Id, body: string): Uint8Array => encode(['app', from.user, from.device, msgId, body]),
  commit: (newEpoch: bigint, committer: Id, adds: readonly Id[], removes: readonly Id[]): Uint8Array =>
    encode(['commit', newEpoch, committer, adds, removes]),
  prop: (ref: Id, op: 'add' | 'remove', device: Id): Uint8Array => encode(['prop', ref, op, device]),
  /** A Welcome into `epoch`; `treeHash` is the joined state's (a forged Welcome passes another). */
  welcome: (groupId: Id, epoch: bigint, treeHash: Uint8Array = treeHashOf(groupId, epoch)): Uint8Array =>
    encode(['welcome', groupId, epoch, treeHash]),
  treeHash: treeHashOf,
  commitment: commitmentFor,
  info: (groupId: Id, epoch: bigint): Uint8Array => encode(['info', groupId, epoch]),
  tree: (groupId: Id, epoch: bigint): Uint8Array => encode(['tree', groupId, epoch]),
  binding: (communityId: Id | null, channelId: Id): Uint8Array => encode(['binding', communityId, channelId]),
};

/**
 * The commitment an application blob carries (the stand-in of its 32-byte authenticated_data):
 * wire.commitment of its message id, or null for a blob that is not an application message.
 */
export function commitmentOf(blob: Uint8Array): Uint8Array | null {
  try {
    const v = arr(decode(blob), 5);
    if (str(at(v, 0)) !== 'app') return null;
    return commitmentFor(bin(at(v, 3), 16));
  } catch {
    return null;
  }
}

export class ManualClock {
  private t = 1_700_000_000_000;
  private ids = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  readonly now = (): number => this.t;

  readonly setTimeout = (fn: () => void, ms: number): number => {
    this.ids += 1;
    this.timers.set(this.ids, { at: this.t + ms, fn });
    return this.ids;
  };

  readonly clearTimeout = (id: number): void => {
    this.timers.delete(id);
  };

  get pending(): number {
    return this.timers.size;
  }

  /** Moves time forward by ms, firing due timers in order and settling after each. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      let nextId = -1;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [id, tm] of this.timers) {
        if (tm.at <= end && tm.at < nextAt) {
          nextId = id;
          nextAt = tm.at;
        }
      }
      if (nextId < 0) break;
      const tm = this.timers.get(nextId);
      this.timers.delete(nextId);
      this.t = nextAt;
      tm?.fn();
      await settle();
    }
    this.t = end;
    await settle();
  }
}

export class FakeGateway {
  readonly acks: { group: string; round: bigint }[] = [];
  readonly frames: Frame[] = [];
  private readonly listeners = new Set<(e: GatewayEvent) => void>();

  readonly subscribe = (listener: (e: GatewayEvent) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly commitAck = (groupId: Uint8Array, round: bigint): void => {
    this.acks.push({ group: toHex(groupId), round });
  };

  get listenerCount(): number {
    return this.listeners.size;
  }

  emit(e: GatewayEvent): void {
    for (const l of [...this.listeners]) l(e);
  }

  ready(info: ReadyInfo): void {
    this.emit({ type: 'ready', info });
  }

  frame(f: Frame): void {
    this.frames.push(f);
    this.emit({ type: 'frame', frame: f });
  }
}

// ---------------------------------------------------------------------------------------------
// ModelCore: the group half of CorePort (L-CORE-07..09) over the stand-in wire.
// ---------------------------------------------------------------------------------------------

interface MProp {
  op: 'add' | 'remove';
  device: Id;
}

interface MGroup {
  groupId: Id;
  communityId: Id | null;
  targetId: Id;
  state: 0 | 1 | 2 | 3 | 4;
  epoch: bigint;
  joinedEpoch: bigint;
  joinEpoch: bigint;
  preJoinEpoch: bigint;
  nextSeq: bigint;
  ackedSeq: bigint;
  ackedEpoch: bigint;
  proposals: Map<string, MProp>;
  pending: { epoch: bigint; removesMe: boolean } | null;
  fromResync: boolean;
  /** app_groups.was_gone: joining over a row that was in state 4. */
  wasGone: boolean;
  /** app_groups.max_epoch: the highest epoch held; only ever raised. */
  maxEpoch: bigint;
  rows: Map<bigint, StoredRow>;
}

type StoredRow = Omit<TimelineRow, 'editedSeq' | 'reply' | 'reactions' | 'pinned' | 'attachments' | 'mention'>;

interface MOut {
  msgId: Id;
  groupId: Id;
  body: string;
  created: bigint;
  state: 0 | 1 | 2;
  error: string;
  epoch: bigint | null;
}

export interface CoreCall {
  m: string;
  g: string;
}

export interface ApplyCall {
  g: string;
  through: bigint;
  handshakes: number;
  messages: number;
}

type HsOutcome = 'ok' | 'skip' | 'changed' | 'stop' | 'gone';

export class ModelCore implements CorePort {
  /** Every group-scoped call except the reads groups/outbox/timeline, in call order. */
  readonly calls: CoreCall[] = [];
  readonly applyCalls: ApplyCall[] = [];
  private readonly gs = new Map<string, MGroup>();
  private readonly out = new Map<string, MOut>();
  private msgs = 0;
  private readonly readState = new Map<string, { lastReadSeq: bigint; lastReadAt: bigint }>();
  private readonly settingsMap = new Map<string, string>();

  constructor(readonly me: Peer) {}

  // The account half is task 15's; the engine never calls it.
  pause(): void {
    this.calls.push({ m: 'pause', g: '' });
  }
  async resume(): Promise<void> {
    await Promise.resolve();
  }
  close(): void {
    this.calls.push({ m: 'close', g: '' });
  }
  identity(): IdentityInfo {
    return { phase: 2, instanceId: null, userId: this.me.user, deviceId: this.me.device, username: 'model', listPublished: true };
  }
  signupBegin(): string {
    throw coreError('E_CORE_STATE', 'not modelled');
  }
  signupRequest(): Uint8Array {
    throw coreError('E_CORE_STATE', 'not modelled');
  }
  signupComplete(): Uint8Array {
    throw coreError('E_CORE_STATE', 'not modelled');
  }
  signupReset(): void {
    throw coreError('E_CORE_STATE', 'not modelled');
  }
  deviceListBody(): Uint8Array {
    throw coreError('E_CORE_STATE', 'not modelled');
  }
  deviceListPublished(): void {
    throw coreError('E_CORE_STATE', 'not modelled');
  }
  deviceListDrop(): void {
    throw coreError('E_CORE_STATE', 'not modelled');
  }
  sessionSign(): Uint8Array {
    throw coreError('E_CORE_STATE', 'not modelled');
  }
  sessionStore(): void {
    throw coreError('E_CORE_STATE', 'not modelled');
  }
  session(): null {
    return null;
  }
  sessionClear(): void {
    throw coreError('E_CORE_STATE', 'not modelled');
  }
  keyPackages(): Uint8Array {
    throw coreError('E_CORE_STATE', 'not modelled');
  }
  sealedObjects(): SealedObjects { throw coreError('E_CORE_STATE', 'not modelled'); }
  stateSealedUploaded(): void { throw coreError('E_CORE_STATE', 'not modelled'); }
  stateSealedCurrent(): boolean { throw coreError('E_CORE_STATE', 'not modelled'); }
  enrolBegin(): { deviceId: Id; dskPub: Uint8Array } { throw coreError('E_CORE_STATE', 'not modelled'); }
  enrolSessionSign(): Uint8Array { throw coreError('E_CORE_STATE', 'not modelled'); }
  enrolRegistered(): void { throw coreError('E_CORE_STATE', 'not modelled'); }
  recoveryKeyCheck(): void { throw coreError('E_CORE_STATE', 'not modelled'); }
  enrolComplete(): SignedLists { throw coreError('E_CORE_STATE', 'not modelled'); }
  enrolReset(): void { throw coreError('E_CORE_STATE', 'not modelled'); }
  deviceListRevoke(): SignedLists { throw coreError('E_CORE_STATE', 'not modelled'); }
  ownDeviceListUpdate(): { version: bigint; listed: boolean } { throw coreError('E_CORE_STATE', 'not modelled'); }
  ownDeviceList(): OwnDeviceList { throw coreError('E_CORE_STATE', 'not modelled'); }

  // --- groups (L-CORE-07) ---

  groups(): GroupInfo[] {
    return [...this.gs.values()]
      .sort((a, b) => (toHex(a.groupId) < toHex(b.groupId) ? -1 : 1))
      .map((g) => this.info(g));
  }
  groupRow(groupId: Id): GroupInfo | null {
    const g = this.gs.get(toHex(groupId));
    return g === undefined ? null : this.info(g);
  }
  markRead(groupId: Id, seq: bigint, now: bigint): void {
    const g = this.must(groupId);
    if (g.state === 4) throw coreError('E_CORE_STATE', 'group state 4');
    const key = toHex(groupId);
    const previous = this.readState.get(key)?.lastReadSeq ?? 0n;
    const clamped = seq < g.nextSeq ? seq : g.nextSeq - 1n;
    this.readState.set(key, { lastReadSeq: clamped > previous ? clamped : previous, lastReadAt: now });
  }
  activity(): ActivityRow[] {
    return [...this.gs.values()].filter((g) => g.state === 2 || g.state === 3)
      .sort((a, b) => toHex(a.groupId).localeCompare(toHex(b.groupId)))
      .map((g) => {
        const lastReadSeq = this.readState.get(toHex(g.groupId))?.lastReadSeq ?? 0n;
        const rows = [...g.rows.values()].filter((r) => r.status === 0 && r.type === 0 &&
          // The core's `sender_user <> ?1` excludes a NULL sender, as SQL does (CORE-ENGINE-03).
          r.senderUser !== null && !same(r.senderUser, this.me.user) && r.seq > lastReadSeq).sort(bySeq);
        const last = rows[rows.length - 1];
        return { groupId: g.groupId, unread: rows.length, mentions: rows.filter((r) => this.mentionsMe(r.body)).length,
          lastSeq: last?.seq ?? 0n, lastTs: last?.recvTs ?? 0n, lastReadSeq };
      });
  }
  private mentionsMe(body: string): boolean {
    return body.includes(`<@${toHex(this.me.user)}>` ) || body.includes('<@everyone>') || body.includes('<@here>');
  }
  settings(): Record<string, string> {
    return Object.fromEntries([...this.settingsMap].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  }
  settingPut(k: string, v: string): void {
    const enc = new TextEncoder();
    if (enc.encode(k).length < 1 || enc.encode(k).length > 128 || enc.encode(v).length > 1024) throw coreError('E_CORE_INPUT');
    this.settingsMap.set(k, v);
  }
  settingDelete(k: string): void {
    const length = new TextEncoder().encode(k).length;
    if (length < 1 || length > 128) throw coreError('E_CORE_INPUT');
    this.settingsMap.delete(k);
  }

  groupCreate(groupId: Id, communityId: Id | null, channelId: Id): Uint8Array {
    this.log('groupCreate', groupId);
    for (const g of this.gs.values()) {
      if (same(g.targetId, channelId) && g.state !== 4) throw coreError('E_CORE_STATE', 'a group exists for the channel');
    }
    this.gs.set(toHex(groupId), this.fresh(groupId, communityId, channelId, 0));
    return encode([groupId, wire.binding(communityId, channelId), wire.info(groupId, 0n), wire.tree(groupId, 0n)]);
  }

  groupRegistered(groupId: Id, nextSeq: bigint): void {
    this.log('groupRegistered', groupId);
    const g = this.must(groupId);
    if (g.state !== 0) throw coreError('E_CORE_STATE', `state ${String(g.state)}`);
    g.state = 2;
    g.nextSeq = nextSeq;
  }

  groupDiscard(groupId: Id): void {
    this.log('groupDiscard', groupId);
    const g = this.must(groupId);
    if (g.state !== 0 && g.state !== 1) throw coreError('E_CORE_STATE', `group state ${String(g.state)}`);
    g.proposals.clear();
    g.pending = null;
    if (g.fromResync) {
      // As the core writes it (groups.rs: state 3, epoch 0): the old group state was already replaced (CORE-ENGINE-03).
      g.state = 3;
      g.epoch = 0n;
      g.fromResync = false;
    } else if (g.wasGone) {
      // A rejoin of a gone row that did not complete: back to gone with its timeline, outbox,
      // nextSeq and floor (history outranks the discard of a fresh join).
      g.state = 4;
      g.epoch = 0n;
      g.wasGone = false;
    } else {
      this.gs.delete(toHex(groupId));
      for (const [k, o] of this.out) if (same(o.groupId, groupId)) this.out.delete(k);
    }
  }

  /** L-CORE-07 `group_join_external`: the checks in the core's order; every refusal writes nothing. */
  groupJoinExternal(eg: ExpectedGroup, infoBody: Uint8Array, treeBody: Uint8Array): Uint8Array {
    this.log('groupJoinExternal', eg.groupId);
    const info = arr(decode(infoBody), 4);
    const epoch = u64(at(info, 0));
    if (epoch !== u64(at(arr(decode(treeBody), 3), 0))) throw coreError('E_CORE_INPUT', 'info_body and tree_body disagree');
    if (!same(bin(at(arr(decode(bin(at(info, 1))), 3), 1), 16), eg.groupId)) {
      throw coreError('E_CORE_INPUT', 'GroupInfo group id does not match');
    }
    const prev = this.gs.get(toHex(eg.groupId));
    if (prev !== undefined && (prev.state === 0 || prev.state === 1)) throw coreError('E_CORE_STATE', `group state ${String(prev.state)}`);
    if (prev !== undefined && !this.boundTo(prev, eg.communityId, eg.channelId)) {
      throw coreError('E_CORE_STATE', 'group is bound to another channel');
    }
    const holder = this.holder(eg.channelId, eg.groupId);
    if (holder !== undefined) throw coreError('E_CORE_STATE', `channel has group ${toHex(holder.groupId)}`);
    // The join lands at epoch + 1: refused when that is not above the highest epoch held.
    if (prev !== undefined && epoch < this.floorOf(prev)) {
      throw coreError('E_CORE_INPUT', 'GroupInfo would rejoin at or below an epoch this device has held');
    }
    const g = this.fresh(eg.groupId, eg.communityId, eg.channelId, 1);
    if (prev !== undefined) {
      // The row is updated, never recreated: its timeline, outbox, cursor and floor stay.
      g.rows = prev.rows;
      g.nextSeq = prev.nextSeq;
      g.ackedSeq = prev.ackedSeq;
      g.ackedEpoch = prev.ackedEpoch;
      g.fromResync = prev.state === 2 || prev.state === 3;
      g.wasGone = prev.state === 4;
      // The floor is not written here: the stale epoch was written when it was reached, and the
      // joined epoch is recorded only by groupJoined.
      g.maxEpoch = prev.maxEpoch;
      g.preJoinEpoch = prev.epoch;
    }
    g.joinEpoch = epoch + 1n;
    g.epoch = g.joinEpoch;
    this.gs.set(toHex(eg.groupId), g);
    return encode([wire.commit(epoch + 1n, this.me.device, [this.me.device], []), wire.info(eg.groupId, epoch + 1n)]);
  }

  groupJoined(groupId: Id, seq: bigint): void {
    this.log('groupJoined', groupId);
    const g = this.must(groupId);
    if (g.state !== 1) throw coreError('E_CORE_STATE', `group state ${String(g.state)}`);
    g.state = 2;
    g.epoch = g.joinEpoch;
    g.joinedEpoch = g.joinEpoch;
    if (seq + 1n > g.nextSeq) g.nextSeq = seq + 1n; // never lowered
    if (g.joinEpoch > g.maxEpoch) g.maxEpoch = g.joinEpoch;
    g.fromResync = false;
    g.wasGone = false;
    g.proposals.clear();
    g.pending = null;
  }

  welcomesApply(welcomesBody: Uint8Array, expected: ExpectedGroup[]): WelcomeOutcome[] {
    const out: WelcomeOutcome[] = [];
    for (const row of arr(decode(welcomesBody))) {
      const w = arr(row, 7);
      const welcomeId = u64(at(w, 0));
      const groupId = bin(at(w, 1), 16);
      const labelEpoch = u64(at(w, 2));
      const commitSeq = u64(at(w, 3));
      const labelTreeHash = bin(at(w, 6), 32);
      this.log('welcomesApply', groupId);
      const refuse = (reason: string): void => {
        out.push({ welcomeId, groupId, outcome: 2, reason });
      };
      const exp = expected.find((e) => same(e.groupId, groupId));
      if (exp === undefined) {
        out.push({ welcomeId, groupId, outcome: 3, reason: '' });
        continue;
      }
      const prev = this.gs.get(toHex(groupId));
      // Outcome 1 only for a working membership: a row in state 0, 1 or 2 (L-CORE-07).
      if (prev !== undefined && (prev.state === 0 || prev.state === 1 || prev.state === 2)) {
        out.push({ welcomeId, groupId, outcome: 1, reason: '' });
        continue;
      }
      // The core's order (groups.rs, mls/group.rs join_from_welcome_labelled): the row's binding, the
      // channel holder, the parse, then on the staged Welcome the binding and the group id
      // (E_BINDING; the stand-in wire carries no binding, so only the id is checked here), the
      // served label (E_CORE_INPUT), and last the floor. Each refusal stores nothing and leaves the
      // floor as it was.
      if (prev !== undefined && !this.boundTo(prev, exp.communityId, exp.channelId)) {
        refuse('E_CORE_STATE');
        continue;
      }
      if (this.holder(exp.channelId, groupId) !== undefined) {
        refuse('E_CORE_STATE');
        continue;
      }
      let joined: CborValue[];
      try {
        joined = arr(decode(bin(at(w, 4))), 4);
        if (str(at(joined, 0)) !== 'welcome') throw new Error('not a welcome');
      } catch {
        refuse('E_CORE_INPUT');
        continue;
      }
      if (!same(bin(at(joined, 1), 16), groupId)) {
        refuse('E_BINDING');
        continue;
      }
      const epoch = u64(at(joined, 2));
      // The joined state must be the one the server labelled (3f26670).
      if (epoch !== labelEpoch || !same(bin(at(joined, 3), 32), labelTreeHash)) {
        refuse('E_CORE_INPUT');
        continue;
      }
      if (prev !== undefined && epoch <= this.floorOf(prev)) {
        refuse('E_CORE_INPUT');
        continue;
      }
      // A row in state 3 or 4 is updated (its stale group state goes; its rows, outbox, cursor and
      // binding stay; nextSeq is never lowered).
      const g = this.fresh(groupId, exp.communityId, exp.channelId, 2);
      g.nextSeq = commitSeq + 1n;
      if (prev !== undefined) {
        g.rows = prev.rows;
        g.ackedSeq = prev.ackedSeq;
        g.ackedEpoch = prev.ackedEpoch;
        g.maxEpoch = prev.maxEpoch;
        if (prev.nextSeq > g.nextSeq) g.nextSeq = prev.nextSeq;
      }
      g.epoch = epoch;
      g.joinedEpoch = epoch;
      if (epoch > g.maxEpoch) g.maxEpoch = epoch;
      this.gs.set(toHex(groupId), g);
      out.push({ welcomeId, groupId, outcome: 0, reason: '' });
    }
    return out;
  }

  // --- ordered processing (L-CORE-08) ---

  groupApply(groupId: Id, handshakes: Uint8Array, messages: Uint8Array, through: bigint): ApplyResult {
    this.log('groupApply', groupId);
    const g = this.must(groupId);
    const hs = arr(decode(handshakes)).map((r) => arr(r, 5));
    const ms = arr(decode(messages)).map((r) => arr(r, 8));
    this.applyCalls.push({ g: toHex(groupId), through, handshakes: hs.length, messages: ms.length });
    if (g.state !== 2) throw coreError('E_CORE_STATE', `state ${String(g.state)}`);
    const rows = new Map<bigint, { seq: bigint; hs: CborValue[] | null; msg: CborValue[] | null }>();
    for (const a of hs) {
      const seq = u64(at(a, 0));
      if (rows.has(seq)) throw coreError('E_CORE_INPUT', 'a seq appears twice');
      rows.set(seq, { seq, hs: a, msg: null });
    }
    for (const a of ms) {
      const seq = u64(at(a, 0));
      if (rows.has(seq)) throw coreError('E_CORE_INPUT', 'a seq appears twice');
      rows.set(seq, { seq, hs: null, msg: a });
    }
    const ordered = [...rows.values()].filter((r) => r.seq >= g.nextSeq && r.seq <= through).sort(bySeq);
    const newSeqs: bigint[] = [];
    let changed = false;
    let adopted = false;
    let stopped = false;
    for (const r of ordered) {
      if (r.hs !== null) {
        const o: HsOutcome = this.applyHandshake(g, r.hs);
        if (o === 'stop') {
          g.state = 3;
          stopped = true;
          break;
        }
        if (o === 'changed' || o === 'gone') changed = true;
        if (o === 'gone') {
          g.nextSeq = r.seq + 1n;
          stopped = true;
          break;
        }
      } else if (r.msg !== null) {
        const m = this.applyMessage(g, r.msg);
        if (m.inserted) newSeqs.push(r.seq);
        if (m.adopted) adopted = true;
      }
      g.nextSeq = r.seq + 1n;
    }
    if (!stopped && through + 1n > g.nextSeq) g.nextSeq = through + 1n;
    return this.result(g, newSeqs, changed, adopted);
  }

  commitBuild(groupId: Id, proposalsBody: Uint8Array): Uint8Array {
    this.log('commitBuild', groupId);
    const g = this.must(groupId);
    if (g.state !== 2) throw coreError('E_CORE_STATE', `state ${String(g.state)}`);
    if (g.pending !== null) throw coreError('E_CORE_STATE', 'a commit is pending');
    for (const row of arr(decode(proposalsBody))) {
      const p = arr(row, 5);
      if (u64(at(p, 4)) === 1n) continue;
      const v = arr(decode(bin(at(p, 3))), 4);
      const ref = toHex(bin(at(v, 1), 16));
      if (!g.proposals.has(ref)) g.proposals.set(ref, { op: str(at(v, 2)) === 'add' ? 'add' : 'remove', device: bin(at(v, 3), 16) });
    }
    const adds = [...g.proposals.values()].filter((p) => p.op === 'add').map((p) => p.device);
    const removes = [...g.proposals.values()].filter((p) => p.op === 'remove').map((p) => p.device);
    g.pending = { epoch: g.epoch + 1n, removesMe: removes.some((d) => same(d, this.me.device)) };
    const welcomes = adds.map((d) => [d, wire.welcome(g.groupId, g.epoch + 1n)]);
    return encode([g.epoch, wire.commit(g.epoch + 1n, this.me.device, adds, removes), wire.info(g.groupId, g.epoch + 1n), welcomes, null]);
  }

  commitConfirm(groupId: Id): ApplyResult {
    this.log('commitConfirm', groupId);
    const g = this.must(groupId);
    if (g.state !== 2) throw coreError('E_CORE_STATE', `state ${String(g.state)}`);
    this.mergePending(g);
    g.proposals.clear();
    return this.result(g, [], true, false);
  }

  commitAbort(groupId: Id): void {
    this.log('commitAbort', groupId);
    this.must(groupId).pending = null;
  }

  cursorBody(groupId: Id): Uint8Array | null {
    this.log('cursorBody', groupId);
    const g = this.must(groupId);
    return g.nextSeq - 1n <= g.ackedSeq ? null : encode([g.nextSeq - 1n, g.epoch]);
  }

  cursorAcked(groupId: Id, lastSeq: bigint, lastEpoch: bigint): void {
    this.log('cursorAcked', groupId);
    const g = this.must(groupId);
    if (lastSeq > g.nextSeq - 1n) throw coreError('E_CORE_INPUT', 'cursor exceeds next seq');
    if (lastSeq <= g.ackedSeq) return;
    g.ackedSeq = lastSeq;
    g.ackedEpoch = lastEpoch;
  }

  /** Op 21 for a stored row (L-CORE-08 `message_deleted`): status 2, body ''; any state but 4. */
  messageDeleted(groupId: Id, seq: bigint): ApplyResult {
    this.log('messageDeleted', groupId);
    const g = this.must(groupId);
    if (g.state === 4) throw coreError('E_CORE_STATE', 'state 4');
    const row = g.rows.get(seq);
    if (row === undefined || row.status === 2) return this.result(g, [], false, false);
    g.rows.set(seq, { ...row, status: 2, reason: '', body: '' });
    return this.result(g, [seq], false, false);
  }

  // --- sending and reading (L-CORE-09) ---

  sendPrepare(groupId: Id, body: string, now: bigint): Id {
    this.log('sendPrepare', groupId);
    const g = this.must(groupId);
    if (g.state !== 2) throw coreError('E_CORE_STATE', `state ${String(g.state)}`);
    if (body.trim() === '') throw coreError('E_CORE_INPUT', 'empty body');
    // The limit is UTF-8 bytes, not characters (MAX_BODY_LONG, envelope/mod.rs:15-16, 362).
    if (new TextEncoder().encode(body).length > 4000) throw coreError('E_ENVELOPE_LIMIT');
    this.msgs += 1;
    const msgId = idOf(0x6d, this.msgs);
    this.out.set(toHex(msgId), { msgId, groupId, body, created: now, state: 0, error: '', epoch: null });
    return msgId;
  }

  sendEncrypt(msgId: Id): { groupId: Id; messageBody: Uint8Array } {
    const o = this.out.get(toHex(msgId));
    if (o === undefined) throw coreError('E_CORE_NOT_FOUND');
    this.log('sendEncrypt', o.groupId);
    const g = this.must(o.groupId);
    if (o.state !== 0) throw coreError('E_CORE_STATE', 'the row is not queued');
    if (g.state !== 2) throw coreError('E_CORE_STATE', `state ${String(g.state)}`);
    for (const x of this.out.values()) {
      if (same(x.groupId, o.groupId) && x.state === 1) throw coreError('E_CORE_STATE', 'a message is in flight');
    }
    // The core frames no application message while a proposal or a commit is pending (L-CORE-09).
    if (g.proposals.size > 0) throw coreError('E_CORE_STATE', 'proposals are pending');
    if (g.pending !== null) throw coreError('E_CORE_STATE', 'a commit is pending');
    o.state = 1;
    o.epoch = g.epoch;
    return { groupId: o.groupId, messageBody: encode([g.epoch, wire.app(this.me, o.msgId, o.body)]) };
  }

  sendConfirm(msgId: Id, response: Uint8Array): { groupId: Id; seq: bigint } {
    const r = arr(decode(response), 3);
    const seq = u64(at(r, 0));
    const recvTs = u64(at(r, 2));
    const o = this.out.get(toHex(msgId));
    if (o !== undefined) {
      this.log('sendConfirm', o.groupId);
      if (o.state !== 1) throw coreError('E_CORE_STATE', `outbox row in state ${String(o.state)}`);
      const g = this.must(o.groupId);
      const held = g.rows.get(seq);
      if (held !== undefined) {
        // The deleted marker of this upload (its deletion was read first) completes the row; any
        // other row contradicts the answer: the row is failed (kept) and the call still throws.
        if (held.status === 2 && same(held.senderDevice, this.me.device) && (held.msgId === null || same(held.msgId, msgId))) {
          g.rows.set(seq, { ...held, msgId });
          this.out.delete(toHex(msgId));
          return { groupId: o.groupId, seq };
        }
        o.state = 2;
        o.error = 'E_CORE_STATE';
        throw coreError('E_CORE_STATE', 'message seq exists');
      }
      g.rows.set(seq, this.ownRow(seq, o.epoch ?? g.epoch, recvTs, o));
      this.out.delete(toHex(msgId));
      return { groupId: o.groupId, seq };
    }
    for (const g of this.gs.values()) {
      for (const row of g.rows.values()) {
        if (row.msgId !== null && same(row.msgId, msgId)) {
          this.log('sendConfirm', g.groupId);
          return { groupId: g.groupId, seq: row.seq };
        }
      }
    }
    throw coreError('E_CORE_NOT_FOUND');
  }

  sendRequeue(msgId: Id): void {
    const o = this.mustOut(msgId, 'sendRequeue');
    if (o.state !== 1) throw coreError('E_CORE_STATE', `outbox state ${String(o.state)}`);
    o.state = 0;
  }

  sendFail(msgId: Id, error: string): void {
    const o = this.mustOut(msgId, 'sendFail');
    if (o.state === 2) throw coreError('E_CORE_STATE', 'outbox state 2');
    if (new TextEncoder().encode(error).length > 64) throw coreError('E_CORE_INPUT', 'error longer than 64 bytes');
    o.state = 2;
    o.error = error;
  }

  sendRetry(msgId: Id): void {
    const o = this.mustOut(msgId, 'sendRetry');
    if (o.state !== 2) throw coreError('E_CORE_STATE', `outbox state ${String(o.state)}`);
    o.state = 0;
    o.error = '';
  }

  sendDiscard(msgId: Id): void {
    const o = this.mustOut(msgId, 'sendDiscard');
    if (o.state === 1) throw coreError('E_CORE_STATE', 'outbox state 1');
    this.out.delete(toHex(msgId));
  }

  outbox(groupId: Id): OutboxRow[] {
    return [...this.out.values()]
      .filter((o) => same(o.groupId, groupId))
      .sort((a, b) => (a.created !== b.created ? (a.created < b.created ? -1 : 1) : toHex(a.msgId) < toHex(b.msgId) ? -1 : 1))
      .map((o) => ({ msgId: o.msgId, state: o.state, error: o.error, created: o.created, body: o.body }));
  }

  timeline(groupId: Id, beforeSeq: bigint, limit: number): TimelineRow[] {
    const rows = [...this.must(groupId).rows.values()]
      .filter((r) => (r.type === null || r.type === 0) && (beforeSeq === 0n || r.seq < beforeSeq)).sort(bySeq);
    return rows.slice(Math.max(0, rows.length - limit)).map((r) => ({
      ...r, editedSeq: 0n, reply: null, reactions: [], pinned: false, attachments: [],
      mention: r.status === 0 && r.type === 0 && r.senderUser !== null && !same(r.senderUser, this.me.user) && this.mentionsMe(r.body),
    }));
  }

  // --- test accessors ---

  group(groupId: Id): GroupInfo | undefined {
    const g = this.gs.get(toHex(groupId));
    return g === undefined ? undefined : this.info(g);
  }

  /** The group's epoch floor (app_groups.max_epoch joined with the stored state's epoch), for the model tests. */
  floor(groupId: Id): bigint | undefined {
    const g = this.gs.get(toHex(groupId));
    return g === undefined ? undefined : this.floorOf(g);
  }

  /** Bodies of the readable rows, ascending by seq. */
  bodies(groupId: Id): string[] {
    const g = this.gs.get(toHex(groupId));
    if (g === undefined) return [];
    return [...g.rows.values()].filter((r) => r.status === 0).sort(bySeq).map((r) => r.body);
  }

  /** The unreadable rows, ascending by seq. */
  unreadable(groupId: Id): { seq: bigint; reason: string }[] {
    const g = this.gs.get(toHex(groupId));
    if (g === undefined) return [];
    return [...g.rows.values()].filter((r) => r.status === 1).sort(bySeq).map((r) => ({ seq: r.seq, reason: r.reason }));
  }

  resetLog(): void {
    this.calls.length = 0;
    this.applyCalls.length = 0;
  }

  // --- internals ---

  private log(m: string, groupId: Id): void {
    this.calls.push({ m, g: toHex(groupId) });
  }

  private must(groupId: Id): MGroup {
    const g = this.gs.get(toHex(groupId));
    if (g === undefined) throw coreError('E_CORE_NOT_FOUND');
    return g;
  }

  private mustOut(msgId: Id, m: string): MOut {
    const o = this.out.get(toHex(msgId));
    if (o === undefined) throw coreError('E_CORE_NOT_FOUND');
    this.log(m, o.groupId);
    return o;
  }

  private fresh(groupId: Id, communityId: Id | null, targetId: Id, state: 0 | 1 | 2): MGroup {
    return {
      groupId, communityId, targetId, state, epoch: 0n, joinedEpoch: 0n, joinEpoch: 0n, preJoinEpoch: 0n, nextSeq: 1n, ackedSeq: 0n, ackedEpoch: 0n,
      proposals: new Map(), pending: null, fromResync: false, wasGone: false, maxEpoch: 0n, rows: new Map(),
    };
  }

  private info(g: MGroup): GroupInfo {
    return {
      groupId: g.groupId, kind: 0, communityId: g.communityId, targetId: g.targetId, state: g.state,
      epoch: g.state === 4 ? 0n : g.epoch, nextSeq: g.nextSeq, proposalsPending: g.proposals.size, pendingCommit: g.pending !== null,
    };
  }

  private result(g: MGroup, newSeqs: bigint[], epochChanged: boolean, ownAdopted: boolean): ApplyResult {
    return {
      state: g.state, epoch: g.state === 4 ? 0n : g.epoch, nextSeq: g.nextSeq, newSeqs,
      proposalsPending: g.proposals.size, epochChanged, ownAdopted,
    };
  }

  /** Rule 1 of L-CORE-08 for one handshake row [seq, epoch, kind, sender, blob]. */
  private applyHandshake(g: MGroup, a: CborValue[]): HsOutcome {
    const framed = u64(at(a, 1));
    const kind = u64(at(a, 2));
    let v: CborValue[];
    try {
      v = arr(decode(bin(at(a, 4))));
    } catch {
      return kind === 0n ? 'skip' : 'stop';
    }
    if (framed < g.epoch) return 'skip';
    const tag = str(at(v, 0));
    if (tag === 'prop') {
      if (framed !== g.epoch) return 'skip';
      const ref = toHex(bin(at(v, 1), 16));
      if (!g.proposals.has(ref)) g.proposals.set(ref, { op: str(at(v, 2)) === 'add' ? 'add' : 'remove', device: bin(at(v, 3), 16) });
      return 'ok';
    }
    if (tag !== 'commit' || framed !== g.epoch) return kind === 0n ? 'skip' : 'stop';
    if (same(bin(at(v, 2), 16), this.me.device)) {
      // An own commit: the pending one (OwnPendingCommit), or one this core no longer holds.
      if (g.pending === null) return 'stop';
      return this.mergePending(g);
    }
    // A staged merge clears any pending commit (openmls 0.9.0 processing.rs:462-463).
    g.proposals.clear();
    g.pending = null;
    if (arr(at(v, 4)).some((d) => same(bin(d, 16), this.me.device))) {
      // Removed: the group state goes without a merge, and the floor is not written (the last
      // epoch held was written when it was reached).
      g.state = 4;
      return 'gone';
    }
    g.epoch = u64(at(v, 1));
    this.raiseFloor(g, g.epoch);
    return 'changed';
  }

  private mergePending(g: MGroup): 'changed' | 'gone' {
    const p = g.pending;
    g.pending = null;
    g.proposals.clear();
    if (p === null) return 'changed';
    g.epoch = p.epoch;
    this.raiseFloor(g, g.epoch);
    if (p.removesMe) {
      g.state = 4;
      return 'gone';
    }
    return 'changed';
  }

  /** Rules 2-5 of L-CORE-08 (as amended) for one message row [seq, epoch, uploader, blob, commitment, franking, recv_ts, deleted]. */
  private applyMessage(g: MGroup, a: CborValue[]): { inserted: boolean; adopted: boolean } {
    const seq = u64(at(a, 0));
    const epoch = u64(at(a, 1));
    const uploader = bin(at(a, 2), 16);
    const blob = at(a, 3);
    const served = at(a, 4) === null ? null : bin(at(a, 4), 32);
    const recvTs = u64(at(a, 6));
    const deleted = u64(at(a, 7)) === 1n;
    const bare = (status: 1 | 2, reason: string): StoredRow => ({
      seq, epoch, recvTs, status, reason, senderUser: null, senderDevice: uploader, senderKind: null, senderTier: null,
      msgId: null, type: null, body: '',
    });
    const stored = g.rows.get(seq);
    // A live row at a stored seq is skipped before anything else: not listed, nothing processed.
    if (!deleted && stored !== undefined) return { inserted: false, adopted: false };
    if (deleted) {
      if (stored !== undefined) {
        g.rows.set(seq, { ...stored, status: 2, reason: '', body: '' });
        return { inserted: true, adopted: false };
      }
      // The deleted upload of an unresolved outbox row: the server stored it, so the row is done.
      const o = same(uploader, this.me.device) && served !== null ? this.unresolvedWith(g, served) : undefined;
      if (o !== undefined) {
        g.rows.set(seq, {
          ...bare(2, ''), senderUser: this.me.user, senderDevice: this.me.device, senderKind: 0, senderTier: 1, msgId: o.msgId, type: 0,
        });
        this.out.delete(toHex(o.msgId));
        return { inserted: true, adopted: true };
      }
      g.rows.set(seq, bare(2, ''));
      return { inserted: true, adopted: false };
    }
    if (blob === null) {
      g.rows.set(seq, bare(1, 'E_PRUNED'));
      return { inserted: true, adopted: false };
    }
    if (same(uploader, this.me.device)) {
      // Adopted only as the upload of the outbox row (any state) whose commitment the row carries:
      // the served field, else the blob's; when both are there and differ it carries none.
      const carried = commitmentOf(bin(blob));
      const c = served !== null && carried !== null && !same(served, carried) ? null : served ?? carried;
      const o = c === null ? undefined : this.unresolvedWith(g, c);
      if (o !== undefined) {
        g.rows.set(seq, this.ownRow(seq, epoch, recvTs, o));
        this.out.delete(toHex(o.msgId));
        return { inserted: true, adopted: true };
      }
      g.rows.set(seq, bare(1, 'E_OWN_UNKNOWN'));
      return { inserted: true, adopted: false };
    }
    let v: CborValue[];
    try {
      v = arr(decode(bin(blob)), 5);
      if (str(at(v, 0)) !== 'app') throw new Error('not an application message');
    } catch {
      g.rows.set(seq, bare(1, 'E_CORE_MLS'));
      return { inserted: true, adopted: false };
    }
    if (epoch > g.epoch || epoch < g.joinedEpoch) {
      g.rows.set(seq, bare(1, 'E_CORE_MLS'));
      return { inserted: true, adopted: false };
    }
    const device = bin(at(v, 2), 16);
    if (!same(device, uploader)) {
      g.rows.set(seq, bare(1, 'E_SENDER_MISMATCH'));
      return { inserted: true, adopted: false };
    }
    g.rows.set(seq, {
      seq, epoch, recvTs, status: 0, reason: '', senderUser: bin(at(v, 1), 16), senderDevice: device, senderKind: 0, senderTier: 0,
      msgId: bin(at(v, 3), 16), type: 0, body: str(at(v, 4)),
    });
    return { inserted: true, adopted: false };
  }

  private ownRow(seq: bigint, epoch: bigint, recvTs: bigint, o: MOut): StoredRow {
    return {
      seq, epoch, recvTs, status: 0, reason: '', senderUser: this.me.user, senderDevice: this.me.device, senderKind: 0, senderTier: 1,
      msgId: o.msgId, type: 0, body: o.body,
    };
  }

  /** The matching outbox row of L-CORE-08: the group's first row (created, msgId), in any state, whose commitment is c. */
  private unresolvedWith(g: MGroup, c: Uint8Array): MOut | undefined {
    return [...this.out.values()]
      .filter((o) => same(o.groupId, g.groupId))
      .sort((x, y) => (x.created !== y.created ? (x.created < y.created ? -1 : 1) : toHex(x.msgId) < toHex(y.msgId) ? -1 : 1))
      .find((o) => same(wire.commitment(o.msgId), c));
  }

  /** The row is the text group of channelId in communityId (a join never rebinds a row). */
  private boundTo(g: MGroup, communityId: Id | null, channelId: Id): boolean {
    return (g.communityId === null ? communityId === null : communityId !== null && same(g.communityId, communityId)) &&
      same(g.targetId, channelId);
  }

  /** Another non-gone group that holds channelId. */
  private holder(channelId: Id, except: Id): MGroup | undefined {
    return [...this.gs.values()].find((x) => !same(x.groupId, except) && same(x.targetId, channelId) && x.state !== 4);
  }

  /** The epoch floor of L-CORE-07: maxEpoch, and the epoch of the group state still stored (states 2 and 3). */
  private floorOf(g: MGroup): bigint {
    const stored = g.state === 2 || g.state === 3 ? g.epoch : 0n;
    return stored > g.maxEpoch ? stored : g.maxEpoch;
  }

  private raiseFloor(g: MGroup, epoch: bigint): void {
    if (epoch > g.maxEpoch) g.maxEpoch = epoch;
  }
}

// ---------------------------------------------------------------------------------------------
// ModelDs: the delivery-service routes of L-HTTP-31, 33..43 and the fan-out of ops 16, 17, 19, 20.
// ---------------------------------------------------------------------------------------------

export type RouteName = 'listChannels' | 'postGroup' | 'getGroupInfo' | 'getGroupTree' | 'getHandshakes' | 'getMessages'
  | 'getProposals' | 'postCommit' | 'postMessage' | 'postCursor' | 'postResync' | 'getWelcomes' | 'deleteWelcome'
  | 'getChannel' | 'postDm' | 'listDms' | 'putDeviceList' | 'getDeviceList' | 'getDeviceListHistory';
export type ModelRoutes = Pick<Routes, RouteName>;
/** fail: throw before acting; lose: act, then throw a network error; before/after: run fn around acting; gate: wait first. */
export type Injection = { fail: Error } | { lose: true } | { before: () => void } | { after: () => void } | { gate: Promise<void> };

export interface DsCall {
  dev: string;
  route: RouteName;
  group: string;
  from: bigint | null;
}

export interface DsView {
  epoch: bigint;
  members: string[];
  messages: { seq: bigint; epoch: bigint; uploader: string; body: string }[];
  commits: { seq: bigint; kind: number; committer: string }[];
}

interface DsEntry {
  seq: bigint;
  epoch: bigint;
  hs: { kind: number; sender: bigint | null } | null;
  uploader: Id | null;
  blob: Uint8Array | null;
  /** mls_app_messages.commitment_c: read from the upload, kept when the message is deleted; null for handshakes. */
  commitment: Uint8Array | null;
  deleted: boolean;
  franking: Uint8Array;
  recvTs: bigint;
}

interface DsProposal {
  ref: Id;
  blob: Uint8Array;
  epoch: bigint;
  void: boolean;
}

interface DsGroup {
  id: Id;
  channelId: Id;
  epoch: bigint;
  next: bigint;
  log: DsEntry[];
  members: Set<string>;
  proposals: DsProposal[];
  prunedBelow: bigint;
}

interface DsWelcome {
  id: bigint;
  dev: string;
  groupId: Id;
  epoch: bigint;
  commitSeq: bigint;
  blob: Uint8Array;
}

export class ModelDs {
  /**
   * Rows of the parity cases (L-CORE-10) at a given seq and epoch, named after the fixture's `what`
   * values (static, so they do not collide with the instance methods that append to a group's log).
   */
  static readonly row = {
    /** peer-message: a type-0 message by PEER, framed in `epoch`. */
    peerMessage: (seq: bigint, epoch: bigint): CborInput[] => [
      seq, epoch, PEER.device, wire.app(PEER, idOf(0x7e, Number(seq)), `parity ${String(seq)}`), new Uint8Array(32), new Uint8Array(32),
      1_700_000_000n + seq, 0,
    ],
    /**
     * peer-commit: a self-update commit by PEER (kind 1), framed in `epoch`. Stand-in convention
     * (CORE-ENGINE-02): element 1 is the pre-commit epoch here and in appendCommit, while dillad and the
     * Rust relay label a commit row with the post-commit epoch; the Rust core reads the epoch from the
     * handshake blob itself and the engine never reads the label, so no rule may key on it without
     * changing both.
     */
    peerCommit: (seq: bigint, epoch: bigint): CborInput[] => [seq, epoch, 1, 1n, wire.commit(epoch + 1n, PEER.device, [], [])],
    /** bad-commit: a kind-1 row whose blob no core can process. */
    badCommit: (seq: bigint, epoch: bigint): CborInput[] => [seq, epoch, 1, 1n, new Uint8Array([0xff])],
    /**
     * own-echo: a message row uploaded by ME, carrying the private message `blob` of ME's sendEncrypt
     * and, in element 4, the commitment the delivery service read from that upload.
     */
    ownEcho: (seq: bigint, epoch: bigint, blob: Uint8Array): CborInput[] => [
      seq, epoch, ME.device, blob, commitmentOf(blob), new Uint8Array(32), 1_700_000_000n + seq, 0,
    ],
    /** pruned: blob null, deleted 0. */
    pruned: (seq: bigint, epoch: bigint): CborInput[] => [seq, epoch, PEER.device, null, null, new Uint8Array(32), 1_700_000_000n + seq, 0],
    /** deleted: deleted 1. */
    deleted: (seq: bigint, epoch: bigint): CborInput[] => [seq, epoch, PEER.device, null, null, new Uint8Array(32), 1_700_000_000n + seq, 1],
    /** add-proposal: an Add of THIRD by the instance's external sender (kind 0, sender null). */
    addProposal: (seq: bigint, epoch: bigint): CborInput[] => [seq, epoch, 0, null, wire.prop(idOf(0x5e, Number(seq)), 'add', THIRD.device)],
  };

  readonly calls: DsCall[] = [];
  /** `${device hex}/${group hex}` -> the last acknowledged [last_seq, last_epoch]. */
  readonly cursors = new Map<string, readonly [bigint, bigint]>();
  /** Device hexes whose external commits are refused with 403 E_FORBIDDEN. */
  readonly denyJoin = new Set<string>();
  /**
   * Device hexes the community's ACL does not admit (a kicked user's devices until the user joins
   * again): getGroupInfo, getGroupTree and postResync answer 404 E_NOT_FOUND, as the delivery
   * service's requireReader does (internal/ds/registry.go).
   */
  readonly aclDeny = new Set<string>();
  /** `${group hex}/${device hex}` of leaves a kick took: getProposals answers 404 E_NOT_FOUND too (requireMember). */
  private readonly removed = new Set<string>();
  private readonly groups = new Map<string, DsGroup>();
  private readonly channels = new Map<string, { communityId: Id; channelId: Id }>();
  private readonly owners = new Map<string, string>();
  private readonly devices = new Map<string, Id>();
  private readonly users = new Map<string, Id>();
  private readonly keyPackageDevs = new Set<string>();
  private readonly lists = new Map<string, { version: bigint; blob: Uint8Array; sig: Uint8Array; prev: Uint8Array }[]>();
  private readonly revokedDevs = new Set<string>();
  private readonly dms = new Map<string, { channelId: Id; users: Id[] }>();
  private readonly welcomes: DsWelcome[] = [];
  private readonly sinks = new Map<string, (f: Frame) => void>();
  private readonly parked = new Map<string, (f: Frame) => void>();
  private readonly drops = new Map<string, number>();
  private readonly injections = new Map<RouteName, Injection[]>();
  private readonly messageHooks = new Map<string, () => void>();
  private readonly proposalHooks = new Map<string, () => void>();
  private counter = 0;
  private frameN = 0n;
  private welcomeIds = 0n;
  private clockS = 1_700_000_000n;

  // --- test controls ---

  addChannel(communityId: Id, channelId: Id): void {
    this.channels.set(toHex(channelId), { communityId, channelId });
  }
  own(user: Id, device: Id): void {
    this.owners.set(toHex(device), toHex(user));
    this.devices.set(toHex(device), device);
    this.users.set(toHex(user), user);
    this.keyPackageDevs.add(toHex(device));
  }
  publishList(user: Id, entries: readonly { device: Id; revokedAt?: bigint | null }[]): bigint {
    const key = toHex(user);
    const version = BigInt((this.lists.get(key)?.length ?? 0) + 1);
    const blob = fakeListBlob(user, entries.map((entry) => ({ deviceId: entry.device, revokedAt: entry.revokedAt ?? null })), this.clockS);
    this.storeList(key, version, blob, new Uint8Array(64), new Uint8Array(32));
    return version;
  }
  addDm(channelId: Id, participants: readonly Peer[]): void {
    participants.forEach((p) => this.own(p.user, p.device));
    const users = [...new Map(participants.map((p) => [toHex(p.user), p.user])).values()]
      .sort((a, b) => toHex(a).localeCompare(toHex(b)));
    this.dms.set(toHex(channelId), { channelId, users });
  }
  private unlisted(device: string): boolean {
    const owner = this.owners.get(device);
    if (owner === undefined) return false;
    const rows = this.lists.get(owner);
    if (rows === undefined || rows.length === 0) return false;
    const list = readFakeList(at(rows, rows.length - 1).blob);
    const id = this.devices.get(device);
    // Invariant 4 judges the (device_id, dsk_pub) pair; every ModelDs device holds its default key.
    return list === null || id === undefined || !fakeListNames(list, id, fakeDskPub(id));
  }
  private storeList(user: string, version: bigint, blob: Uint8Array, sig: Uint8Array, prev: Uint8Array): void {
    const rows = this.lists.get(user) ?? [];
    rows.push({ version, blob, sig, prev });
    this.lists.set(user, rows);
    const list = readFakeList(blob);
    if (list === null) return;
    for (const entry of list.entries) {
      const key = toHex(entry.deviceId);
      if (entry.revokedAt !== null && this.owners.get(key) === user && !this.revokedDevs.has(key)) {
        this.revokedDevs.add(key);
        for (const g of this.groups.values()) if (g.members.has(key)) this.propose(g.id, 'remove', entry.deviceId);
      }
    }
  }

  attach(dev: Id, sink: (f: Frame) => void): void {
    this.sinks.set(toHex(dev), sink);
  }

  /** Stops fan-out to dev (frames are lost, as for a dropped connection) until reattach. */
  detach(dev: Id): void {
    const k = toHex(dev);
    const s = this.sinks.get(k);
    if (s !== undefined) {
      this.parked.set(k, s);
      this.sinks.delete(k);
    }
  }

  reattach(dev: Id): void {
    const k = toHex(dev);
    const s = this.parked.get(k);
    if (s !== undefined) {
      this.sinks.set(k, s);
      this.parked.delete(k);
    }
  }

  /** Loses the next count frames addressed to dev. */
  dropNext(dev: Id, count: number): void {
    this.drops.set(toHex(dev), count);
  }

  /** Queues a fault for the next call of route (injections of one route are used in order). */
  inject(route: RouteName, injection: Injection): void {
    const list = this.injections.get(route) ?? [];
    list.push(injection);
    this.injections.set(route, list);
  }

  /**
   * One-shot: runs fn right after the next getMessages for groupId has produced its answer and
   * before any further request is served (a row stored between the two reads of a catch-up round).
   */
  afterNextMessagesRead(groupId: Id, fn: () => void): void {
    this.messageHooks.set(toHex(groupId), fn);
  }

  /** One-shot race: remove a leaf after its proposal read and before its commit upload. */
  afterNextProposalsRead(groupId: Id, fn: () => void): void {
    this.proposalHooks.set(toHex(groupId), fn);
  }

  resetCalls(): void {
    this.calls.length = 0;
  }

  callsOf(dev: Id, route: RouteName): DsCall[] {
    const d = toHex(dev);
    return this.calls.filter((c) => c.dev === d && c.route === route);
  }

  welcomesFor(dev: Id): { id: bigint; groupId: string }[] {
    const d = toHex(dev);
    return this.welcomes.filter((w) => w.dev === d).map((w) => ({ id: w.id, groupId: toHex(w.groupId) }));
  }

  view(groupId: Id): DsView {
    const g = this.must(groupId);
    const messages: DsView['messages'] = [];
    const commits: DsView['commits'] = [];
    for (const e of g.log) {
      if (e.hs === null) {
        if (e.blob === null || e.uploader === null) continue;
        messages.push({ seq: e.seq, epoch: e.epoch, uploader: toHex(e.uploader), body: str(at(arr(decode(e.blob), 5), 4)) });
      } else if (e.hs.kind !== 0) {
        let committer = '';
        try {
          committer = e.blob === null ? '' : toHex(bin(at(arr(decode(e.blob), 5), 2), 16));
        } catch {
          committer = '';
        }
        commits.push({ seq: e.seq, kind: e.hs.kind, committer });
      }
    }
    return { epoch: g.epoch, members: [...g.members].sort(), messages, commits };
  }

  // --- peers and the instance ---

  peerCreate(peer: Peer, channelId: Id): Id {
    this.counter += 1;
    const id = idOf(0x9a, this.counter);
    this.groups.set(toHex(id), this.newGroup(id, channelId, toHex(peer.device)));
    return id;
  }

  /** An external commit (kind 2, sender null) by peer that adds it, framed at the current epoch. */
  peerJoin(groupId: Id, peer: Peer): bigint {
    const g = this.must(groupId);
    return this.appendCommit(g, 2, null, wire.commit(g.epoch + 1n, peer.device, [peer.device], []), [peer.device], []);
  }

  /** Model shortcut: makes dev a member without a commit (the core models no roster). */
  join(groupId: Id, dev: Id): void {
    this.must(groupId).members.add(toHex(dev));
  }

  /** Model shortcut: takes dev's leaf away without a commit (its next upload meets 403). */
  evict(groupId: Id, dev: Id): void {
    this.must(groupId).members.delete(toHex(dev));
  }

  /**
   * The kick (internal/api/communities.go removeMember): the member row goes, so the ACL refuses the
   * device, and its leaf goes, so every requireMember read (messages, handshakes, proposals) answers
   * 404 E_NOT_FOUND. No frame tells the device: the gateway's roster no longer holds it.
   */
  kick(groupId: Id, dev: Id): void {
    this.must(groupId).members.delete(toHex(dev));
    this.removed.add(`${toHex(groupId)}/${toHex(dev)}`);
    this.aclDeny.add(toHex(dev));
  }

  /** The kicked user joins the community again: the ACL admits the device; its leaf stays gone. */
  readmit(dev: Id): void {
    this.aclDeny.delete(toHex(dev));
  }

  peerSend(groupId: Id, from: Peer, body: string): bigint {
    this.counter += 1;
    return this.appendMessage(this.must(groupId), from.device, wire.app(from, idOf(0x7e, this.counter), body)).seq;
  }

  /** An instance proposal (sender null) for the current epoch. */
  propose(groupId: Id, op: 'add' | 'remove', device: Id): bigint {
    const g = this.must(groupId);
    this.counter += 1;
    const ref = idOf(0x5e, this.counter);
    const blob = wire.prop(ref, op, device);
    g.proposals.push({ ref, blob, epoch: g.epoch, void: false });
    const e: DsEntry = {
      seq: g.next, epoch: g.epoch, hs: { kind: 0, sender: null }, uploader: null, blob, commitment: null, deleted: false,
      franking: new Uint8Array(32), recvTs: this.tick(),
    };
    g.next += 1n;
    g.log.push(e);
    for (const m of [...g.members]) this.emit(m, 16, g.id, [e.seq, e.epoch, 0n, null, blob]);
    return e.seq;
  }

  /** A member commit covering every outstanding proposal plus adds; Welcomes go to every added device. */
  peerCommit(groupId: Id, committer: Peer, adds: readonly Id[] = []): bigint {
    const g = this.must(groupId);
    const allAdds: Id[] = [...adds];
    const removes: Id[] = [];
    for (const p of g.proposals) {
      if (p.epoch !== g.epoch || p.void) continue;
      const v = arr(decode(p.blob), 4);
      (str(at(v, 2)) === 'add' ? allAdds : removes).push(bin(at(v, 3), 16));
    }
    const blob = wire.commit(g.epoch + 1n, committer.device, allAdds, removes);
    const seq = this.appendCommit(g, 1, 0n, blob, allAdds, removes);
    for (const a of allAdds) this.addWelcome(toHex(a), g, seq, wire.welcome(g.id, g.epoch));
    return seq;
  }

  /** A commit no core can process (its blob is not CBOR). */
  garbageCommit(groupId: Id): bigint {
    return this.appendCommit(this.must(groupId), 1, 0n, new Uint8Array([0xff]), [], []);
  }

  /**
   * Deletes the stored message at seq as the delivery service does: the blob goes, seq, epoch, uploader,
   * commitment, franking tag and recv_ts stay, later pages serve it with deleted = 1, and op 21 fans out.
   */
  deleteMessage(groupId: Id, seq: bigint): void {
    const g = this.must(groupId);
    const e = g.log.find((x) => x.seq === seq && x.hs === null);
    if (e === undefined || e.deleted) return;
    e.blob = null;
    e.deleted = true;
    const deletedAt = this.tick();
    for (const m of [...g.members]) this.emit(m, 21, g.id, [seq, deletedAt]);
  }

  /** Sends mls.commit_needed to dev. */
  elect(groupId: Id, dev: Id, round: bigint): void {
    const g = this.must(groupId);
    const refs = g.proposals.filter((p) => p.epoch === g.epoch && !p.void).map((p) => p.ref);
    this.emit(toHex(dev), 17, g.id, [g.epoch, refs, 2000n, round]);
  }

  prune(groupId: Id, below: bigint): void {
    this.must(groupId).prunedBelow = below;
  }

  // --- routes ---

  routesFor(dev: Id): ModelRoutes {
    const d = toHex(dev);
    return {
      listChannels: (communityId) => this.call(d, 'listChannels', null, null, () => this.channelRows(communityId)),
      postGroup: (body) => this.call(d, 'postGroup', null, null, () => this.postGroup(d, body)),
      getGroupInfo: (id) =>
        this.call(d, 'getGroupInfo', id, null, () => {
          const g = this.must(id);
          if (this.aclDeny.has(d)) throw httpError(404, 'E_NOT_FOUND');
          return encode([g.epoch, wire.info(g.id, g.epoch), new Uint8Array(32), g.next]);
        }),
      getGroupTree: (id) =>
        this.call(d, 'getGroupTree', id, null, () => {
          const g = this.must(id);
          if (this.aclDeny.has(d)) throw httpError(404, 'E_NOT_FOUND');
          return encode([g.epoch, wire.tree(g.id, g.epoch), new Uint8Array(32)]);
        }),
      getHandshakes: (id, from, limit) => this.call(d, 'getHandshakes', id, from, () => this.page(d, id, from, limit, true)),
      getMessages: (id, from, limit) =>
        this.call(d, 'getMessages', id, from, () => {
          const answer = this.page(d, id, from, limit, false);
          const hook = this.messageHooks.get(toHex(id));
          if (hook !== undefined) {
            this.messageHooks.delete(toHex(id));
            hook();
          }
          return answer;
        }),
      getProposals: (id) =>
        this.call(d, 'getProposals', id, null, () => {
          const g = this.must(id);
          if (!g.members.has(d)) throw httpError(404, 'E_NOT_FOUND');
          const answer = encode(g.proposals.filter((p) => p.epoch === g.epoch).map((p) => [p.ref, 0, null, p.blob, p.void ? 1 : 0]));
          const hook = this.proposalHooks.get(toHex(id));
          if (hook !== undefined) {
            this.proposalHooks.delete(toHex(id));
            hook();
          }
          return answer;
        }),
      postCommit: (id, body) => this.call(d, 'postCommit', id, null, () => this.postCommit(d, id, body)),
      postMessage: (id, body) => this.call(d, 'postMessage', id, null, () => this.postMessage(dev, id, body)),
      postCursor: (id, body) =>
        this.call(d, 'postCursor', id, null, () => {
          const v = arr(decode(body), 2);
          this.cursors.set(`${d}/${toHex(id)}`, [u64(at(v, 0)), u64(at(v, 1))]);
        }),
      postResync: (id, body) => this.call(d, 'postResync', id, null, () => this.postResync(dev, id, body)),
      getWelcomes: (after) => this.call(d, 'getWelcomes', null, after, () => this.welcomePage(d, after)),
      deleteWelcome: (welcomeId) =>
        this.call(d, 'deleteWelcome', null, null, () => {
          const i = this.welcomes.findIndex((w) => w.dev === d && w.id === welcomeId);
          if (i >= 0) this.welcomes.splice(i, 1);
        }),
      getChannel: (id) => this.call(d, 'getChannel', id, null, () => {
        const dm = this.dms.get(toHex(id));
        if (dm !== undefined) {
          if (!dm.users.some((user) => toHex(user) === this.owners.get(d))) throw httpError(404, 'E_NOT_FOUND');
          return { id, kind: dm.users.length === 2 ? 3 : 4, mode: 0, visibility: 0, parentId: null,
            name: '', topic: '', position: 0, seq: 0n, textGroupId: this.openGroupOf(id)?.id ?? null };
        }
        const channel = this.channels.get(toHex(id));
        if (channel === undefined) throw httpError(404, 'E_NOT_FOUND');
        return this.channelRows(channel.communityId).find((row) => same(row.id, id))!;
      }),
      postDm: (recipients) => this.call(d, 'postDm', null, null, () => {
        const owner = this.owners.get(d);
        if (owner === undefined) throw httpError(400, 'E_INVALID_REQUEST');
        const users = [...new Set([owner, ...recipients.map(toHex)])].sort();
        if (users.length < 2) throw httpError(400, 'E_INVALID_REQUEST');
        for (const dm of this.dms.values()) if (dm.users.map(toHex).join('/') === users.join('/'))
          return { channelId: dm.channelId, created: false };
        if (users.some((user) => !this.users.has(user))) throw httpError(404, 'E_NOT_FOUND');
        const channelId = idOf(0xd3, this.dms.size + 1);
        this.dms.set(toHex(channelId), { channelId, users: users.map((user) => this.users.get(user)!) });
        return { channelId, created: true };
      }),
      listDms: () => this.call(d, 'listDms', null, null, () => [...this.dms.values()]
        .filter((dm) => dm.users.some((user) => toHex(user) === this.owners.get(d)))
        .map((dm) => ({ channelId: dm.channelId, kind: dm.users.length === 2 ? 3 as const : 4 as const, members: dm.users }))),
      putDeviceList: (userId, body) => this.call(d, 'putDeviceList', null, null, () => {
        const user = toHex(userId);
        if (this.owners.get(d) !== user) throw httpError(403, 'E_FORBIDDEN');
        const a = arr(decode(body), 4);
        const version = u64(at(a, 0));
        if (version !== BigInt((this.lists.get(user)?.length ?? 0) + 1)) throw httpError(409, 'E_INVALID_REQUEST');
        this.storeList(user, version, bin(at(a, 1)), bin(at(a, 2)), bin(at(a, 3)));
      }),
      getDeviceList: (userId) => this.call(d, 'getDeviceList', null, null, () => {
        const rows = this.lists.get(toHex(userId));
        const last = rows?.[rows.length - 1];
        return last === undefined ? null : { version: last.version, blob: last.blob,
          raw: encode([last.version, last.blob, last.sig, last.prev]) };
      }),
      getDeviceListHistory: (userId, after) => this.call(d, 'getDeviceListHistory', null, after, () => {
        const rows = (this.lists.get(toHex(userId)) ?? []).filter((row) => row.version > after).slice(0, 64);
        return { raw: encode(rows.map((row) => [row.version, row.blob, row.sig, row.prev])),
          count: rows.length, lastVersion: rows.length ? at(rows, rows.length - 1).version : null };
      }),
    };
  }

  private async call<T>(dev: string, route: RouteName, group: Id | null, from: bigint | null, run: () => T): Promise<T> {
    this.calls.push({ dev, route, group: group === null ? '' : toHex(group), from });
    if (this.revokedDevs.has(dev)) throw httpError(401, 'E_UNAUTHENTICATED');
    const injection = this.injections.get(route)?.shift();
    await (injection !== undefined && 'gate' in injection ? injection.gate : Promise.resolve());
    if (injection !== undefined && 'fail' in injection) throw injection.fail;
    if (injection !== undefined && 'before' in injection) injection.before();
    const out = run();
    if (injection !== undefined && 'after' in injection) injection.after();
    if (injection !== undefined && 'lose' in injection) throw httpError(0, 'E_NETWORK');
    return out;
  }

  private channelRows(communityId: Uint8Array): {
    id: Uint8Array; kind: number; mode: number; visibility: number; parentId: Uint8Array | null; name: string; topic: string;
    position: number; seq: bigint; textGroupId: Uint8Array | null;
  }[] {
    return [...this.channels.values()]
      .filter((c) => same(c.communityId, communityId))
      .map((c, i) => ({
        id: c.channelId, kind: 0, mode: 0, visibility: 0, parentId: null, name: `channel-${String(i)}`, topic: '', position: i,
        seq: 1n, textGroupId: this.openGroupOf(c.channelId)?.id ?? null,
      }));
  }

  private postGroup(d: string, body: Uint8Array): { nextSeq: bigint } {
    const v = arr(decode(body), 4);
    const id = bin(at(v, 0), 16);
    const binding = arr(decode(bin(at(v, 1))), 3);
    const channelId = bin(at(binding, 2), 16);
    if (this.unlisted(d)) throw httpError(400, 'E_INVALID_REQUEST');
    if (this.openGroupOf(channelId) !== undefined) throw httpError(409, 'E_GROUP_EXISTS');
    this.groups.set(toHex(id), this.newGroup(id, channelId, d));
    const dm = this.dms.get(toHex(channelId));
    if (dm !== undefined) {
      const g = this.must(id);
      for (const user of dm.users) {
        for (const [device, owner] of this.owners) {
          if (owner === toHex(user) && !g.members.has(device) && !this.revokedDevs.has(device) && this.keyPackageDevs.has(device))
            this.propose(id, 'add', this.devices.get(device)!);
        }
      }
    }
    return { nextSeq: 1n };
  }

  private page(d: string, id: Id, from: bigint, limit: number, handshakes: boolean): { raw: Uint8Array; count: number; lastSeq: bigint | null } {
    const g = this.must(id);
    if (!g.members.has(d)) throw httpError(404, 'E_NOT_FOUND');
    if (from < g.prunedBelow) throw httpError(410, 'E_PRUNED');
    const rows = g.log.filter((e) => e.seq >= from && (e.hs !== null) === handshakes).slice(0, limit);
    const raw = encode(
      rows.map((e) =>
        e.hs !== null
          ? [e.seq, e.epoch, e.hs.kind, e.hs.sender, e.blob]
          : [e.seq, e.epoch, e.uploader, e.blob, e.commitment, e.franking, e.recvTs, e.deleted ? 1 : 0],
      ),
    );
    const last = rows[rows.length - 1];
    return { raw, count: rows.length, lastSeq: last === undefined ? null : last.seq };
  }

  private postCommit(d: string, id: Id, body: Uint8Array): { seq: bigint; epoch: bigint } {
    const g = this.must(id);
    if (!g.members.has(d)) throw httpError(403, 'E_LEAF_NOT_CURRENT');
    const v = arr(decode(body), 5);
    if (u64(at(v, 0)) !== g.epoch) throw httpError(409, 'E_COMMIT_CONFLICT');
    const commit = bin(at(v, 1));
    const c = arr(decode(commit), 5);
    const adds = arr(at(c, 3)).map((x) => bin(x, 16));
    const removes = arr(at(c, 4)).map((x) => bin(x, 16));
    const seq = this.appendCommit(g, 1, 0n, commit, adds, removes);
    for (const w of arr(at(v, 3))) {
      const p = arr(w, 2);
      this.addWelcome(toHex(bin(at(p, 0), 16)), g, seq, bin(at(p, 1)));
    }
    return { seq, epoch: g.epoch };
  }

  private postMessage(dev: Id, id: Id, body: Uint8Array): { raw: Uint8Array; seq: bigint } {
    const g = this.must(id);
    if (!g.members.has(toHex(dev))) throw httpError(403, 'E_LEAF_NOT_CURRENT');
    if (g.proposals.some((p) => p.epoch === g.epoch && !p.void)) throw httpError(425, 'E_COMMIT_REQUIRED', 2000);
    const v = arr(decode(body), 2);
    const blob = bin(at(v, 1));
    if (blob.length > 131072) throw httpError(413, 'E_TOO_LARGE');
    if (u64(at(v, 0)) !== g.epoch) throw httpError(422, 'E_COMMIT_INVALID', null, ['epoch']);
    const e = this.appendMessage(g, dev, blob);
    return { raw: encode([e.seq, e.franking, e.recvTs]), seq: e.seq };
  }

  private postResync(dev: Id, id: Id, body: Uint8Array): { seq: bigint; epoch: bigint } {
    const g = this.must(id);
    if (this.aclDeny.has(toHex(dev))) throw httpError(404, 'E_NOT_FOUND');
    if (this.denyJoin.has(toHex(dev))) throw httpError(403, 'E_FORBIDDEN');
    if (this.unlisted(toHex(dev))) throw httpError(422, 'E_COMMIT_INVALID', null, ['external_joiner']);
    const v = arr(decode(body), 2);
    const commit = bin(at(v, 0));
    if (u64(at(arr(decode(commit), 5), 1)) !== g.epoch + 1n) throw httpError(409, 'E_COMMIT_CONFLICT');
    const seq = this.appendCommit(g, 2, null, commit, [dev], []);
    return { seq, epoch: g.epoch };
  }

  private welcomePage(d: string, after: bigint): { raw: Uint8Array; count: number; lastId: bigint | null } {
    const rows = this.welcomes.filter((w) => w.dev === d && w.id > after).slice(0, 64);
    const last = rows[rows.length - 1];
    return {
      raw: encode(rows.map((w) => [w.id, w.groupId, w.epoch, w.commitSeq, w.blob, wire.tree(w.groupId, w.epoch), wire.treeHash(w.groupId, w.epoch)])),
      count: rows.length,
      lastId: last === undefined ? null : last.id,
    };
  }

  private newGroup(id: Id, channelId: Id, member: string): DsGroup {
    return { id, channelId, epoch: 0n, next: 1n, log: [], members: new Set([member]), proposals: [], prunedBelow: 0n };
  }

  private openGroupOf(channelId: Id): DsGroup | undefined {
    for (const g of this.groups.values()) if (same(g.channelId, channelId)) return g;
    return undefined;
  }

  private must(id: Id): DsGroup {
    const g = this.groups.get(toHex(id));
    if (g === undefined) throw httpError(404, 'E_NOT_FOUND');
    return g;
  }

  private tick(): bigint {
    this.clockS += 1n;
    return this.clockS;
  }

  private appendMessage(g: DsGroup, uploader: Id, blob: Uint8Array): DsEntry {
    // The commitment is read from the upload itself (protocol/02: the stored value of C), never sent beside it.
    const e: DsEntry = {
      seq: g.next, epoch: g.epoch, hs: null, uploader, blob, commitment: commitmentOf(blob), deleted: false,
      franking: new Uint8Array(32).fill(Number(g.next % 256n)), recvTs: this.tick(),
    };
    g.next += 1n;
    g.log.push(e);
    for (const m of [...g.members]) this.emit(m, 19, g.id, [e.seq, e.epoch, uploader, blob, e.franking, e.recvTs]);
    return e;
  }

  /**
   * Appends a commit framed at the current epoch, advances the epoch, voids its proposals, fans out op 16.
   * The row is labelled with the pre-commit epoch, unlike dillad (see ModelDs.row.peerCommit, CORE-ENGINE-02).
   */
  private appendCommit(g: DsGroup, kind: number, sender: bigint | null, blob: Uint8Array, adds: readonly Id[], removes: readonly Id[]): bigint {
    const e: DsEntry = {
      seq: g.next, epoch: g.epoch, hs: { kind, sender }, uploader: null, blob, commitment: null, deleted: false,
      franking: new Uint8Array(32), recvTs: this.tick(),
    };
    g.next += 1n;
    g.log.push(e);
    for (const p of g.proposals) if (p.epoch === g.epoch) p.void = true;
    g.epoch += 1n;
    const audience = new Set(g.members);
    for (const a of adds) {
      g.members.add(toHex(a));
      audience.add(toHex(a));
      this.removed.delete(`${toHex(g.id)}/${toHex(a)}`);
    }
    for (const r of removes) g.members.delete(toHex(r));
    for (const m of audience) this.emit(m, 16, g.id, [e.seq, e.epoch, BigInt(kind), sender, blob]);
    return e.seq;
  }

  private addWelcome(dev: string, g: DsGroup, commitSeq: bigint, blob: Uint8Array): void {
    this.welcomeIds += 1n;
    const w: DsWelcome = { id: this.welcomeIds, dev, groupId: g.id, epoch: g.epoch, commitSeq, blob };
    this.welcomes.push(w);
    // Labelled truthfully: the epoch after the commit that added dev and that epoch's tree hash.
    this.emit(dev, 20, g.id, [w.id, w.epoch, commitSeq, blob, wire.tree(g.id, g.epoch), wire.treeHash(g.id, g.epoch)]);
  }

  private emit(dev: string, op: number, groupId: Id, payload: CborValue[]): void {
    const sink = this.sinks.get(dev);
    if (sink === undefined) return;
    const left = this.drops.get(dev) ?? 0;
    if (left > 0) {
      this.drops.set(dev, left - 1);
      return;
    }
    this.frameN += 1n;
    sink({ op, n: this.frameN, groupId, payload });
  }
}

// The join of a call (L-TS-56 step 1), modelled on sync/channel.ts externalJoin: find the channel's call group
// (L-HTTP-100), register one or join it by external commit, settle pending leaves before anything is posted (RV-1),
// derive the join epoch's key through the core's gate, and start the call. Nothing is posted for a tree the gate refuses,
// and the join commit is posted only after call_join_check passes.
import { CoreError, isTrustBlock, type CallMediaEpoch, type CorePort, type ExpectedGroup, type Id } from '../core-port';
import { toHex } from '../hex';
import { DillaHttpError } from '../http/errors';
import type { CallStarted, ChannelCall, Routes } from '../http/routes';

export type JoinRoutes = Pick<Routes, 'getChannelCall' | 'postGroup' | 'getGroupInfo' | 'getGroupTree' | 'postResync' | 'startCall'>;

export interface JoinDeps {
  core: CorePort;
  routes: JoinRoutes;
  policyVersion: bigint;
  externalSenderPub: Uint8Array;
  randomId(): Id;
  /** The worker's trust refresh of the group's leaves (bounded by WAIT_LIST_MS); it never throws. */
  refreshLeaves(groupId: Id): Promise<void>;
  /** Resolves after `ms` on the worker's clock (the rejoin's wait for its own Remove). */
  wait(ms: number): Promise<void>;
  /** A monotonic clock (ms; performance.now in the worker, task-10 fix review N2): the rejoin's wait is bounded by
   *  elapsed time, not by a count of its steps, and a wall-clock step neither stretches nor cuts it. */
  now(): number;
  /** True once the join was cancelled (a leave, sign-out or revocation): a wait stops there. */
  cancelled(): boolean;
  /** The join has begun waiting for this device's earlier Remove (the page says so in its status region). */
  rejoining(): void;
  /** UP6 (R-UP6): catches the held call group up on its lane (its commits applied); true while this device still holds
   *  it active as the held group (no applied commit removed its leaf, and no read found it gone). */
  catchUp(groupId: Id): Promise<boolean>;
  /** UP6c (protocol/05 N1): commits a fresh epoch of the held call group on its lane (call_rotate, POST commit,
   *  confirm) and answers the epoch it moved to. A refused post is aborted and thrown as it came; a confirm that throws
   *  is thrown as CommitUnconfirmed, with the pending commit kept. */
  commitFresh(groupId: Id): Promise<bigint>;
}

/**
 * A rejoin while this device's own Remove is still outstanding (web-3 task 10, concern 2): the instance refuses the
 * resync of a Remove's target with 409 E_REMOVE_PENDING (R25's guard 1, kept whole; its own code since the fix round,
 * so every other refusal, a 403 included, fails at once), and the join waits until another member has committed the
 * Remove (the device then joins afresh) or the call has ended and its group closed (the device registers a fresh one).
 * Each step, REJOIN_STEP_MS apart, reads the call and the group's GroupInfo (two requests: at most one a second) and
 * tries the join again only when either has changed; the wait ends REJOIN_WAIT_MS after the first refusal, on the
 * worker's clock, which outlasts the room's departure timeout (20 s) and its webhook. A person alone ends the call as
 * they leave (controller.leaveLive), so only a leave that could not (a page that went away) waits here that long.
 */
export const REJOIN_STEP_MS = 2_000;
export const REJOIN_WAIT_MS = 30_000;
/** The most reads of a call group's GroupInfo and tree (a pair each) one external join makes when the core finds the
 *  pair disagreeing (a commit landed between the two reads). */
export const JOIN_READS_MAX = 3;
/** UP6c: the most own-leaf Update commits one resume tries; each 409 E_COMMIT_CONFLICT before the last catches the group
 *  up first (the existing rotation's path, UP6b). */
export const RESUME_COMMIT_TRIES = 3;

/** `held` (UP6): the call group this device holds for the channel (a lost room, an update reload), or null. */
export interface JoinTarget { channelId: Id; communityId: Id | null; vdec: string; held?: Id | null }
/** `resumed` (UP6): the held group was taken up again, with no external commit (UP6c: with a commit of its own,
 *  so `media` is of a fresh epoch). */
export interface Joined { groupId: Id; media: CallMediaEpoch; started: CallStarted; resumed?: boolean }

/** A join that ended without a call. `leave` names an active call group this device must leave (a self-Remove and a
 *  forget); `cause` is the error to answer the command with. */
export class JoinRefused extends Error {
  /** The users the last call read named in the call (review M4: the only candidates of a changedUser). */
  users: string[] = [];
  /** WB client I4: `leave` is a group whose tree holds only this device (it registered it, or the join epoch's roster
   *  is its own leaf alone). Nobody can commit a self-Remove there, so the controller ends it conditionally instead. */
  constructor(readonly code: string, readonly phase: 'blocked' | 'failed', readonly cause: unknown, readonly leave: Id | null,
    readonly alone = false) {
    super(code);
    this.name = 'JoinRefused';
  }
}

/** Task-10 fix review N1: a join cancelled (a leave, sign-out or revocation) posts nothing more. `leave` is the group it
 *  already joined, if any (the controller sends its self-Remove). */
function stopped(leave: Id | null, alone = false): JoinRefused {
  return new JoinRefused('E_NO_CALL', 'failed', new CoreError('E_NO_CALL', 'the join was cancelled'), leave, alone);
}

const codeOf = (e: unknown): string => (e instanceof CoreError || e instanceof DillaHttpError ? e.code : 'E_INTERNAL');
const isHttp = (e: unknown, status: number, code: string): boolean => e instanceof DillaHttpError && e.status === status && e.code === code;
/** A gate refusal: a trust block (E_BINDING included) is `blocked`; anything else, a pending list included, `failed`. */
function refused(e: unknown, leave: Id | null, alone = false): JoinRefused {
  const code = codeOf(e);
  return new JoinRefused(code, isTrustBlock(code) ? 'blocked' : 'failed', e, leave, alone);
}

export async function joinCall(d: JoinDeps, t: JoinTarget): Promise<Joined> {
  const seen: { read: ChannelCall | null } = { read: null };
  try {
    return await joinLoop(d, t, seen);
  } catch (e) {
    if (e instanceof JoinRefused) e.users = [...new Set((seen.read?.participants ?? []).map((p) => toHex(p.userId)))];
    throw e;
  }
}

async function joinLoop(d: JoinDeps, t: JoinTarget, seen: { read: ChannelCall | null }): Promise<Joined> {
  let reread = { exists: true, closed: true };
  let waitSince: number | null = null;
  let read: ChannelCall = await d.routes.getChannelCall(t.channelId);
  seen.read = read;
  let held = t.held ?? null;
  for (;;) {
    seen.read = read;
    forgetStale(d.core, t.channelId, read.groupId);
    // UP6 (R-UP6): the instance still names the held group, so it is resumed; once only. Otherwise forgetStale above has
    // forgotten it (a different group, or none: it is closed), and the join goes on as today.
    if (held !== null && read.groupId !== null && toHex(read.groupId) === toHex(held)) {
      const groupId = held;
      held = null;
      const resumed = await resume(d, t, groupId);
      if (resumed !== null) return resumed;
    }
    let groupId: Id;
    let created = false;
    if (read.groupId === null) {
      groupId = d.randomId();
      let body: Uint8Array;
      try { body = d.core.callGroupCreate(groupId, t.communityId, t.channelId, d.policyVersion, d.externalSenderPub); }
      catch (e) { throw refused(e, null); }
      if (d.cancelled()) { d.core.groupDiscard(groupId); throw stopped(null); }
      let nextSeq: bigint;
      try { ({ nextSeq } = await d.routes.postGroup(body)); }
      catch (e) {
        d.core.groupDiscard(groupId);
        // Another device registered the channel's call group first: read the call once more and join theirs.
        if (isHttp(e, 409, 'E_GROUP_EXISTS') && reread.exists) {
          reread = { ...reread, exists: false };
          read = await d.routes.getChannelCall(t.channelId);
          continue;
        }
        throw refused(e, null);
      }
      d.core.groupRegistered(groupId, nextSeq);
      created = true;
    } else {
      groupId = read.groupId;
      const tried: { info: Uint8Array | null } = { info: null };
      try {
        await joinExisting(d, t, groupId, tried);
      } catch (e) {
        if (!(e instanceof JoinRefused && isHttp(e.cause, 409, 'E_REMOVE_PENDING')) || tried.info === null || d.cancelled()) throw e;
        if (waitSince === null) { waitSince = d.now(); d.rejoining(); }
        read = await waitForRemove(d, t, e, waitSince, groupId, tried.info);
        continue;
      }
    }
    const media = await mediaEpoch(d, groupId);
    if (d.cancelled()) { new Uint8Array(media.baseKey).fill(0); throw stopped(groupId); }
    try {
      return { groupId, media, started: await d.routes.startCall(t.channelId, t.vdec) };
    } catch (e) {
      // Any failure zero-fills the held key and posts nothing.
      new Uint8Array(media.baseKey).fill(0);
      // L-HTTP-105: the start raced the idle close of the group; it is gone at the instance, so it is forgotten here and
      // the call is read once more (a fresh registration, or a newer group).
      if (isHttp(e, 503, 'E_UNAVAILABLE') && reread.closed) {
        reread = { ...reread, closed: false };
        d.core.callGroupForget(groupId);
        read = await d.routes.getChannelCall(t.channelId);
        continue;
      }
      const alone = created || (media.roster.length === 1 && media.roster[0]?.leaf === media.ownLeaf);
      throw new JoinRefused(codeOf(e), 'failed', e, groupId, alone);
    }
  }
}

/** HTTP refusals a resume waits out with the hold kept (the page tries again): the instance unreachable, a start it
 *  cannot serve now (503, R-UP7), or a rate limit. */
const transient = (e: unknown): boolean => e instanceof DillaHttpError && (e.status === 0 || e.status === 503 || e.status === 429);

/**
 * UP6 (R-UP6): the resume of the held call group, with no external commit. It catches the group up on its lane, passes
 * the gate, starts the call, then commits a fresh epoch of its own (call_rotate; UP6c, N1) and takes that epoch's key.
 * The instance's leaf check at the start (requireCurrentLeaf) decides whether the leaf is still current. Null when the leaf is gone (an applied Remove, a group read the instance refused,
 * or a start answered 403 E_LEAF_NOT_CURRENT for a removed or epoch-unknown leaf): the group is then forgotten here
 * without a Remove (the leaf is already gone, or the room sweep removes it, the only authority), and the caller joins
 * afresh. A transient failure keeps the hold (no leave). Any key derived is zero-filled on every failure.
 */
async function resume(d: JoinDeps, t: JoinTarget, groupId: Id): Promise<Joined | null> {
  const still = await d.catchUp(groupId);
  if (d.cancelled()) throw stopped(groupId);
  if (!still) { forgetHeld(d.core, groupId); return null; }
  // The gate decides before anything is posted. The held epoch's key is never handed on (UP6c below): it is zero-filled
  // at once, and only its roster is kept (whether this device is alone, for a refused start).
  const held = await mediaEpoch(d, groupId);
  new Uint8Array(held.baseKey).fill(0);
  if (d.cancelled()) throw stopped(groupId);
  const alone = held.roster.length === 1 && held.roster[0]?.leaf === held.ownLeaf;
  let started: CallStarted;
  try {
    started = await d.routes.startCall(t.channelId, t.vdec);
  } catch (e) {
    if (isHttp(e, 403, 'E_LEAF_NOT_CURRENT')) { forgetHeld(d.core, groupId); return null; }
    if (transient(e)) throw new JoinRefused(codeOf(e), 'failed', e, null);
    throw new JoinRefused(codeOf(e), 'failed', e, groupId, alone);
  }
  if (d.cancelled()) throw stopped(groupId, alone);
  // UP6c (protocol/05 N1): the page that resumes runs a fresh media worker whose SFrame counters start at 0; under the
  // held epoch's key and this leaf's KID its frames would repeat nonces the previous worker sealed with. So the device
  // commits a fresh epoch, and the page is given no key (and publishes nothing) until that commit has landed. It comes
  // after the start: the start withdraws this device's own absence Remove (UP6b), which a commit could not leave out.
  const fresh = await freshEpoch(d, groupId, alone);
  if (fresh === null) { forgetHeld(d.core, groupId); return null; }
  const media = await mediaEpoch(d, groupId, alone);
  if (d.cancelled()) { new Uint8Array(media.baseKey).fill(0); throw stopped(groupId, alone); }
  // The key handed on is never of an epoch before the one this device just committed (N1's guard itself).
  if (media.epoch < fresh) {
    new Uint8Array(media.baseKey).fill(0);
    throw new JoinRefused('E_INTERNAL', 'failed', new CoreError('E_INTERNAL', 'the resume key is not of the fresh epoch'), groupId, alone);
  }
  return { groupId, media, started, resumed: true };
}

/** UP6c: refusals of the resume's commit that say this device's view of the group is behind the instance's: a commit
 *  that lost the race (409 E_COMMIT_CONFLICT, `withdrawn` among them), one that leaves out a proposal the instance holds
 *  (422 E_COMMIT_INVALID, `outstanding_proposals`: one that landed while the commit was on its way), or a proposal the
 *  instance requires committed first (425 E_COMMIT_REQUIRED). The engine catches up on each of them; so does the resume. */
const behind = (e: unknown): boolean => isHttp(e, 409, 'E_COMMIT_CONFLICT') || isHttp(e, 422, 'E_COMMIT_INVALID')
  || isHttp(e, 425, 'E_COMMIT_REQUIRED');

/** UP6c: the resume's commit was accepted by the instance but its confirm threw. The pending commit is kept (aborting
 *  it would make its echo a stranger's commit, as for the rotation): the engine adopts it as this device's own when it
 *  arrives, and the resume's next try commits again on top of it. */
export class CommitUnconfirmed extends Error {
  constructor(readonly reason: unknown) {
    super('E_INTERNAL');
    this.name = 'CommitUnconfirmed';
  }
}

/**
 * UP6c: the resume's commit (call_rotate: an empty commit with an UpdatePath of this device's own leaf, which also
 * commits every proposal this device holds), after an accepted start. Only a definitive answer gives the leaf up:
 * - null when the leaf is gone (a catch-up applied its Remove, or the commit is refused 403 E_LEAF_NOT_CURRENT): the
 *   caller forgets the group and joins afresh;
 * - a trust or gate block of the core leaves (the self-Remove, `alone` kept for the controller's conditional end).
 * A refusal that says this device is behind (`behind`) catches up and tries again, at most RESUME_COMMIT_TRIES commits.
 * Every other refusal (transient, behind after the last try, any other HTTP refusal, a core refusal, a confirm that
 * threw) keeps the hold with no leave and no key: the page tries again, and the instance's absence Remove of this
 * device, which the start withdrew, re-arms after WithdrawnStandWindow if it never does.
 */
async function freshEpoch(d: JoinDeps, groupId: Id, alone: boolean): Promise<bigint | null> {
  for (let tries = 1; ; tries++) {
    let epoch: bigint;
    try {
      epoch = await d.commitFresh(groupId);
    } catch (e) {
      if (e instanceof JoinRefused) throw e;
      if (d.cancelled()) throw stopped(groupId, alone);
      if (isHttp(e, 403, 'E_LEAF_NOT_CURRENT')) return null;
      if (behind(e) && tries < RESUME_COMMIT_TRIES) {
        const still = await d.catchUp(groupId);
        if (d.cancelled()) throw stopped(groupId, alone);
        if (!still) return null;
        continue;
      }
      if (e instanceof CoreError && isTrustBlock(e.code)) throw refused(e, groupId, alone);
      const cause = e instanceof CommitUnconfirmed ? e.reason : e;
      throw new JoinRefused(codeOf(cause), 'failed', cause, null);
    }
    if (d.cancelled()) throw stopped(groupId, alone);
    return epoch;
  }
}

/** The held group's state goes, with no Remove (UP6). */
function forgetHeld(core: CorePort, groupId: Id): void {
  try {
    const state = core.groupRow(groupId)?.state;
    if (state === 2 || state === 3) core.callGroupForget(groupId);
  } catch { /* forgotten already */ }
}

/** The rejoin's wait (REJOIN_WAIT_MS from `since`): each step reads the call, and while it still names the refused
 *  group, its GroupInfo; it answers the call read once either has changed (the call ended or moved on, or a commit
 *  landed: perhaps the Remove), and throws `refusal` once the bound has passed or the join is cancelled. */
async function waitForRemove(d: JoinDeps, t: JoinTarget, refusal: JoinRefused, since: number, groupId: Id,
  info: Uint8Array): Promise<ChannelCall> {
  for (;;) {
    const left = since + REJOIN_WAIT_MS - d.now();
    if (left <= 0 || d.cancelled()) throw refusal;
    await d.wait(Math.min(REJOIN_STEP_MS, left));
    if (d.cancelled()) throw refusal;
    const read = await d.routes.getChannelCall(t.channelId);
    // N1: a leave during a read stops the wait there; the join goes no further.
    if (d.cancelled()) throw refusal;
    if (read.groupId === null || toHex(read.groupId) !== toHex(groupId)) return read;
    const now = await d.routes.getGroupInfo(groupId);
    if (d.cancelled()) throw refusal;
    if (toHex(now) !== toHex(info)) return read;
  }
}

/** The external join: a hard verdict refuses at the core's join and nothing is posted; a pending leaf is settled by one
 *  bounded list refresh, and the commit is posted only after call_join_check passes (RV-1). `tried.info` is the
 *  GroupInfo the commit was built on (the rejoin's wait compares it). */
async function joinExisting(d: JoinDeps, t: JoinTarget, groupId: Id, tried: { info: Uint8Array | null }): Promise<void> {
  const eg: ExpectedGroup = { groupId, communityId: t.communityId, channelId: t.channelId, policyVersion: d.policyVersion };
  let body: Uint8Array;
  for (let reads = 1; ; reads++) {
    const info = await d.routes.getGroupInfo(groupId);
    tried.info = info;
    const tree = await d.routes.getGroupTree(groupId);
    try {
      body = d.core.callGroupJoinExternal(eg, info, tree);
      break;
    } catch (e) {
      // The two reads are not one: a commit that lands between them (another member committing a Remove, a rotation)
      // serves a GroupInfo and a tree of different epochs, which the core refuses as E_CORE_INPUT before anything is
      // staged. Both are read again, a bounded number of times, as the text group's external join does.
      if (codeOf(e) === 'E_CORE_INPUT' && reads < JOIN_READS_MAX && !d.cancelled()) continue;
      throw refused(e, null);
    }
  }
  try {
    try { d.core.callJoinCheck(groupId); }
    catch (e) {
      if (codeOf(e) !== 'E_DEVICE_LIST_STALE') throw e;
      await d.refreshLeaves(groupId);
      d.core.callJoinCheck(groupId);
    }
  } catch (e) {
    discard(d.core, groupId);
    throw refused(e, null);
  }
  if (d.cancelled()) { discard(d.core, groupId); throw stopped(null); }
  let seq: bigint;
  try { ({ seq } = await d.routes.postResync(groupId, body)); }
  catch (e) {
    discard(d.core, groupId);
    throw refused(e, null);
  }
  d.core.groupJoined(groupId, seq);
}

/** The join epoch's key through the gate; a pending leaf is read once more, any refusal leaves the joined group. */
async function mediaEpoch(d: JoinDeps, groupId: Id, alone = false): Promise<CallMediaEpoch> {
  try { return d.core.callMediaEpoch(groupId); }
  catch (e) {
    if (codeOf(e) !== 'E_DEVICE_LIST_STALE') throw refused(e, groupId, alone);
  }
  await d.refreshLeaves(groupId);
  try { return d.core.callMediaEpoch(groupId); }
  catch (e) { throw refused(e, groupId, alone); }
}

function discard(core: CorePort, groupId: Id): void {
  try { if (core.groupRow(groupId)?.state === 1) core.groupDiscard(groupId); } catch { /* nothing left to discard */ }
}

/** A call group of this channel that this device still holds, other than the one the instance names now, is gone at the
 *  instance (closed, or the call moved on): its state goes, so the core's one-group-per-channel rule lets the next in. */
function forgetStale(core: CorePort, channelId: Id, current: Id | null): void {
  const channel = toHex(channelId);
  for (const g of core.groups()) {
    if (g.kind !== 1 || g.state === 4 || toHex(g.targetId) !== channel || (current !== null && toHex(g.groupId) === toHex(current))) continue;
    try {
      if (g.state === 0 || g.state === 1) core.groupDiscard(g.groupId);
      else core.callGroupForget(g.groupId);
    } catch { /* the core refuses; the join below reports it */ }
  }
}

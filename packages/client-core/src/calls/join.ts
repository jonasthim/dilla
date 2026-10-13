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
}

export interface JoinTarget { channelId: Id; communityId: Id | null; vdec: string }
export interface Joined { groupId: Id; media: CallMediaEpoch; started: CallStarted }

/** A join that ended without a call. `leave` names an active call group this device must leave (a self-Remove and a
 *  forget); `cause` is the error to answer the command with. */
export class JoinRefused extends Error {
  constructor(readonly code: string, readonly phase: 'blocked' | 'failed', readonly cause: unknown, readonly leave: Id | null) {
    super(code);
    this.name = 'JoinRefused';
  }
}

const codeOf = (e: unknown): string => (e instanceof CoreError || e instanceof DillaHttpError ? e.code : 'E_INTERNAL');
const isHttp = (e: unknown, status: number, code: string): boolean => e instanceof DillaHttpError && e.status === status && e.code === code;
/** A gate refusal: a trust block (E_BINDING included) is `blocked`; anything else, a pending list included, `failed`. */
function refused(e: unknown, leave: Id | null): JoinRefused {
  const code = codeOf(e);
  return new JoinRefused(code, isTrustBlock(code) ? 'blocked' : 'failed', e, leave);
}

export async function joinCall(d: JoinDeps, t: JoinTarget): Promise<Joined> {
  let reread = { exists: true, closed: true };
  let read: ChannelCall = await d.routes.getChannelCall(t.channelId);
  for (;;) {
    forgetStale(d.core, t.channelId, read.groupId);
    let groupId: Id;
    if (read.groupId === null) {
      groupId = d.randomId();
      let body: Uint8Array;
      try { body = d.core.callGroupCreate(groupId, t.communityId, t.channelId, d.policyVersion, d.externalSenderPub); }
      catch (e) { throw refused(e, null); }
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
    } else {
      groupId = read.groupId;
      await joinExisting(d, t, groupId);
    }
    const media = await mediaEpoch(d, groupId);
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
      throw new JoinRefused(codeOf(e), 'failed', e, groupId);
    }
  }
}

/** The external join: a hard verdict refuses at the core's join and nothing is posted; a pending leaf is settled by one
 *  bounded list refresh, and the commit is posted only after call_join_check passes (RV-1). */
async function joinExisting(d: JoinDeps, t: JoinTarget, groupId: Id): Promise<void> {
  const info = await d.routes.getGroupInfo(groupId);
  const tree = await d.routes.getGroupTree(groupId);
  const eg: ExpectedGroup = { groupId, communityId: t.communityId, channelId: t.channelId, policyVersion: d.policyVersion };
  let body: Uint8Array;
  try { body = d.core.callGroupJoinExternal(eg, info, tree); }
  catch (e) { throw refused(e, null); }
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
  let seq: bigint;
  try { ({ seq } = await d.routes.postResync(groupId, body)); }
  catch (e) {
    discard(d.core, groupId);
    throw refused(e, null);
  }
  d.core.groupJoined(groupId, seq);
}

/** The join epoch's key through the gate; a pending leaf is read once more, any refusal leaves the joined group. */
async function mediaEpoch(d: JoinDeps, groupId: Id): Promise<CallMediaEpoch> {
  try { return d.core.callMediaEpoch(groupId); }
  catch (e) {
    if (codeOf(e) !== 'E_DEVICE_LIST_STALE') throw refused(e, groupId);
  }
  await d.refreshLeaves(groupId);
  try { return d.core.callMediaEpoch(groupId); }
  catch (e) { throw refused(e, groupId); }
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

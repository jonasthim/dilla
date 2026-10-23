// The boot sweep of leftover call groups (web3.7 3a-client, R32): a page that went away mid-call (a reload, a crash, a
// closed tab) leaves this device's leaf in the call group and its state in the store. At the next ready, before any join
// is served, every call group this device still holds active (kind 1, state 2) that the call controller does not hold
// is left through the controller's own leave rules: a call this device is alone in is ended conditionally (ended, or a
// 404: forgotten only, as teardown does); any other outcome sends leaveGroup's self-Remove, then the forget, on the
// group's lane. A group the instance no longer names for its channel is only forgotten.
//
// UP6 (R-UP6): a held call group (a room lost, or an update reload's callKeep marker) is spared while its hold has not
// passed `until`. `until` is wall-clock, so it is never trusted alone: an expired hold is acted on like any leftover,
// and that needs the instance to answer first (its call read); offline, nothing is posted or forgotten.
import type { CorePort, GroupInfo, Id } from '../core-port';
import { toHex } from '../hex';
import { DillaHttpError } from '../http/errors';
import type { ChannelCall, Routes } from '../http/routes';

export interface SweepDeps {
  core(): CorePort | null;
  me(): { userId: Id; deviceId: Id } | null;
  routes: Pick<Routes, 'getChannelCall' | 'endCallIfAlone' | 'postProposal'>;
  serial<T>(g: Id, run: () => Promise<T>): Promise<T>;
  /** The live or joining call group, never swept. */
  heldGroup(): Id | null;
  /** True once the sweep must stop (a sign-out, the core detached, a handover): it sends nothing more. */
  stopped(): boolean;
  /** The signal every request for a group of this channel carries (review I3): the controller aborts it on a stop, and
   *  when a join of the channel passes its wait's bound. None: the requests cannot be cancelled. */
  signal?(channelId: Id): AbortSignal;
  /** UP6: the held call group (the callKeep marker, or a lost room's hold), spared while now() < until. */
  keep?(): { groupId: Id; until: number } | null;
  /** The wall clock (ms) the hold's `until` is read against. */
  now?(): number;
  /** UP6: only this group is swept (a hold that expired), every other leftover is left as it is. */
  only?: Id;
}

/** UP6 (R-UP6): how long a held call group is kept for a resume: the page's restore window (RESTORE_WAIT_MS, 120 s,
 *  packages/web useCall) plus 60 s. Wall-clock, so never trusted alone: an expired hold is acted on only once the
 *  instance answers, and a resume after it is still tried (the instance's leaf check decides). */
export const HOLD_MS = 120_000 + 60_000;

/** Whether a hold's `until` still runs at `now`: not passed, and not beyond the longest hold that can have been made at
 *  `now` (a later `until` was written before the wall clock stepped back, or is forged: it is invalid, never kept). */
export const holdRuns = (until: number, now: number): boolean => now < until && until <= now + HOLD_MS;

/** The status of a failed request (0: the instance could not be reached), else null. */
export const statusOf = (e: unknown): number | null => (e instanceof DillaHttpError ? e.status : null);
/** A request the sweep's signal cancelled. */
const aborted = (e: unknown): boolean => e instanceof Error && e.name === 'AbortError';

export async function sweepStaleCalls(d: SweepDeps): Promise<void> {
  const core = d.core();
  if (core === null || d.me() === null || d.stopped()) return;
  let leftover: GroupInfo[];
  try { leftover = core.groups().filter((g) => g.kind === 1 && g.state === 2 && (d.only === undefined || toHex(g.groupId) === toHex(d.only))); }
  catch { return; }
  for (const g of leftover) {
    if (!live(d, core, g.groupId)) { if (d.stopped()) return; continue; }
    const signal = d.signal?.(g.targetId);
    let read: ChannelCall;
    try { read = await d.routes.getChannelCall(g.targetId, signal); }
    catch (e) {
      // Cancelled: this group is left to whoever cancelled it (a join of its channel, or a stop).
      if (aborted(e)) continue;
      // Offline (status 0): nothing is forgotten and nothing more is read; the next sweep takes the group up.
      if (statusOf(e) === 0) return;
      // Review I2: a 404 (the channel is gone, or no longer visible) never names another group, so it is forgotten
      // locally. Any other refusal leaves this group as it is.
      if (statusOf(e) === 404) { await forget(d, core, g.groupId); continue; }
      continue;
    }
    if (!live(d, core, g.groupId)) { if (d.stopped()) return; continue; }
    // The instance names another group for the channel, or none: this one is closed there, so it is only forgotten.
    if (read.groupId === null || toHex(read.groupId) !== toHex(g.groupId)) {
      await forget(d, core, g.groupId);
      continue;
    }
    const me = d.me();
    if (me === null) return;
    const own = toHex(me.deviceId);
    if (read.participants.every((p) => toHex(p.deviceId) === own)) {
      // Alone: the conditional end (the call id is its channel's id, protocol/09 § Voice). Only an ended call, or a 404
      // (no call to end), is forgotten without a self-Remove (teardown's N-m3 rule).
      let ended: boolean;
      try { ended = await d.routes.endCallIfAlone(read.callId ?? g.targetId, signal); }
      catch (e) {
        if (aborted(e)) continue;
        ended = statusOf(e) === 404;
      }
      // forget and leave check on the lane that the sweep runs and the group is not held (review m2: no check here).
      if (ended) { await forget(d, core, g.groupId); continue; }
    }
    await leave(d, core, g.groupId, signal);
  }
}

/** The group is still one to sweep: the sweep runs, the core is the one it started with, the controller does not hold the
 *  group, and the core still holds it active. */
function live(d: SweepDeps, core: CorePort, groupId: Id): boolean {
  if (d.stopped() || d.core() !== core) return false;
  const held = d.heldGroup();
  if (held !== null && toHex(held) === toHex(groupId)) return false;
  // UP6: an unexpired hold is spared; an expired one is swept, and only after the instance answered its call read (an
  // offline read returns before anything is posted or forgotten).
  const keep = d.keep?.() ?? null;
  if (keep !== null && toHex(keep.groupId) === toHex(groupId) && holdRuns(keep.until, d.now?.() ?? Date.now())) return false;
  try { return core.groupRow(groupId)?.state === 2; } catch { return false; }
}

/** The forget alone, on the group's lane. */
async function forget(d: SweepDeps, core: CorePort, groupId: Id): Promise<void> {
  await d.serial(groupId, () => {
    if (live(d, core, groupId)) { try { core.callGroupForget(groupId); } catch { /* forgotten already */ } }
    return Promise.resolve();
  });
}

/** leaveGroup's self-Remove (a refusal leaves the leaf to the instance) and the forget, on the group's lane. */
async function leave(d: SweepDeps, core: CorePort, groupId: Id, signal: AbortSignal | undefined): Promise<void> {
  await d.serial(groupId, async () => {
    if (!live(d, core, groupId)) return;
    try { await d.routes.postProposal(groupId, core.callLeaveProposal(groupId), signal); }
    catch { /* E_REMOVE_PENDING, cancelled, or the instance removes the leaf when the call ends */ }
    // Review I1: a join that took the group up while the self-Remove was in flight keeps it.
    if (!live(d, core, groupId)) return;
    try { core.callGroupForget(groupId); } catch { /* forgotten already */ }
  });
}

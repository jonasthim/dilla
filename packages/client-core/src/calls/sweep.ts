// The boot sweep of leftover call groups (web3.7 3a-client, R32): a page that went away mid-call (a reload, a crash, a
// closed tab) leaves this device's leaf in the call group and its state in the store. At the next ready, before any join
// is served, every call group this device still holds active (kind 1, state 2) that the call controller does not hold
// is left through the controller's own leave rules: a call this device is alone in is ended conditionally (ended, or a
// 404: forgotten only, as teardown does); any other outcome sends leaveGroup's self-Remove, then the forget, on the
// group's lane. A group the instance no longer names for its channel is only forgotten.
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
}

/** The status of a failed request (0: the instance could not be reached), else null. */
export const statusOf = (e: unknown): number | null => (e instanceof DillaHttpError ? e.status : null);

export async function sweepStaleCalls(d: SweepDeps): Promise<void> {
  const core = d.core();
  if (core === null || d.me() === null || d.stopped()) return;
  let leftover: GroupInfo[];
  try { leftover = core.groups().filter((g) => g.kind === 1 && g.state === 2); }
  catch { return; }
  for (const g of leftover) {
    if (!live(d, core, g.groupId)) { if (d.stopped()) return; continue; }
    let read: ChannelCall;
    try { read = await d.routes.getChannelCall(g.targetId); }
    catch (e) {
      // Offline (status 0): nothing is forgotten and nothing more is read; the next sweep takes the group up. Any other
      // refusal leaves this group as it is.
      if (statusOf(e) === 0) return;
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
      try { ended = await d.routes.endCallIfAlone(read.callId ?? g.targetId); }
      catch (e) { ended = statusOf(e) === 404; }
      if (d.stopped()) return;
      if (ended) { await forget(d, core, g.groupId); continue; }
    }
    await leave(d, core, g.groupId);
  }
}

/** The group is still one to sweep: the sweep runs, the core is the one it started with, the controller does not hold the
 *  group, and the core still holds it active. */
function live(d: SweepDeps, core: CorePort, groupId: Id): boolean {
  if (d.stopped() || d.core() !== core) return false;
  const held = d.heldGroup();
  if (held !== null && toHex(held) === toHex(groupId)) return false;
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
async function leave(d: SweepDeps, core: CorePort, groupId: Id): Promise<void> {
  await d.serial(groupId, async () => {
    if (!live(d, core, groupId)) return;
    try { await d.routes.postProposal(groupId, core.callLeaveProposal(groupId)); }
    catch { /* E_REMOVE_PENDING, or the instance removes the leaf when the call ends */ }
    if (d.stopped() || d.core() !== core) return;
    try { core.callGroupForget(groupId); } catch { /* forgotten already */ }
  });
}

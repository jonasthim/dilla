import { CoreError, type Id, type OutboxRow, type SendRequest } from '../core-port';
import { toHex } from '../hex';
import { DillaHttpError } from '../http/errors';
import { resyncGroup } from './channel';
import { SYNC } from './engine';
import { SyncError } from './errors';
import type { SyncInternals } from './internals';

function owner(s: SyncInternals, msgId: Id): Id | undefined {
  const id = toHex(msgId);
  return s.deps.core.groups().find((g) => s.deps.core.outbox(g.groupId).some((x) => toHex(x.msgId) === id))?.groupId;
}
/** Queues any envelope type (L-TS-34): the core's refusal propagates synchronously and nothing else runs. */
export function sendRequest(s: SyncInternals, g: Id, request: SendRequest): Id {
  if (s.stopped()) throw new SyncError('E_SYNC_STOPPED');
  const id = s.deps.core.sendPrepare(g, request, BigInt(Math.floor(s.deps.now() / 1000)));
  s.deps.onOutboxChanged(g); s.requestDrain(g); return id;
}
export function sendMessage(s: SyncInternals, g: Id, text: string): Id {
  return sendRequest(s, g, { type: 0, replyTo: null, body: text, attachments: [] });
}
export function retrySend(s: SyncInternals, msgId: Id): void {
  s.deps.core.sendRetry(msgId);
  const g = owner(s, msgId);
  s.count425.delete(toHex(msgId));
  if (g !== undefined) s.reframedOnce.delete(`${toHex(g)}:${toHex(msgId)}`);
  if (g === undefined) return;
  // A person's retry asks for the group's duties again, as a ready does: a membership refused earlier in
  // this ready is tried once more, and a commit-quiet group commits once more.
  s.resyncTried.delete(toHex(g)); s.quiet.delete(toHex(g));
  s.deps.onOutboxChanged(g); s.requestDrain(g);
}
export function discardSend(s: SyncInternals, msgId: Id): void {
  const g = owner(s, msgId);
  // A message id no outbox holds calls nothing (web-1 pre-flight ruling 1(iv)); the core would refuse it E_CORE_NOT_FOUND.
  if (g === undefined) return;
  const row = s.deps.core.outbox(g).find((x) => toHex(x.msgId) === toHex(msgId));
  s.deps.core.sendDiscard(msgId);
  // The row's attachment references are the controller's to delete (L-TS-34).
  if (row !== undefined) s.deps.onDiscarded(g, row);
  s.reframedOnce.delete(`${toHex(g)}:${toHex(msgId)}`);
  s.deps.onOutboxChanged(g);
}
async function afterLostResponse(s: SyncInternals, g: Id, msgId: Id): Promise<void> {
  await s.catchUpNow(g, 'catch-up');
  const row = s.deps.core.outbox(g).find((x) => toHex(x.msgId) === toHex(msgId));
  if (row?.state !== 1) { s.deps.onOutboxChanged(g); s.requestDrain(g); return; }
  if (!s.echoWait.has(toHex(g))) armEchoWait(s, g, msgId);
}
/** Waits echoWaitMs, catches up once more, and requeues the row only when that catch-up reached the server
 *  and did not see the upload; a catch-up that did not reach it proves nothing, so the row stays in flight
 *  and the wait starts again (TS-01: a resend after it would store a second copy). */
function armEchoWait(s: SyncInternals, g: Id, msgId: Id): void {
  const hex = toHex(g); const msgHex = toHex(msgId);
  const timer = s.armTimer(SYNC.echoWaitMs, () => {
    void s.queues.run(`g:${hex}`, async () => {
      const reached = await s.catchUpNow(g, 'catch-up');
      const fresh = s.deps.core.outbox(g).find((x) => toHex(x.msgId) === msgHex);
      if (fresh?.state === 1 && !reached) {
        // A group that left state 2 drains its in-flight row again when it is activated (drainOne).
        s.echoWait.delete(hex); if (!s.stopped() && s.row(g)?.state === 2) armEchoWait(s, g, msgId);
        return;
      }
      if (fresh?.state === 1) { s.deps.core.sendRequeue(msgId); s.deps.onOutboxChanged(g); }
      s.echoWait.delete(hex); s.requestDrain(g);
    }).catch(() => undefined);
  });
  s.echoWait.set(hex, { msgHex, timer });
}
export async function drainOne(s: SyncInternals, g: Id): Promise<void> {
  const hex = toHex(g);
  if (s.stopped() || s.echoWait.has(hex) || s.row(g)?.state !== 2) return;
  const rows = s.deps.core.outbox(g);
  const inFlight = rows.find((x) => x.state === 1);
  if (inFlight !== undefined) { await afterLostResponse(s, g, inFlight.msgId); return; }
  const row: OutboxRow | undefined = rows.find((x) => x.state === 0);
  if (row === undefined) return;
  const msgId = row.msgId; const msgHex = toHex(msgId);
  const reframeKey = `${hex}:${msgHex}`;
  if (row.attachments.length > 0) {
    // Ruling 7 (Q17): every attempt confirms the row's references before its upload, so a sent attachment is never pending.
    try { await s.deps.beforeSend(g, row); }
    catch (e) {
      if (s.stopped()) return;
      // Pre-flight ruling F5: a confirm that did not reach a verdict (no answer, 401, 429, 5xx) leaves the row queued, as a
      // text row stays queued across network loss; the next ready drains it again (no timer of its own).
      if (e instanceof DillaHttpError && (e.status === 0 || e.status === 401 || e.status === 429 || e.status >= 500)) return;
      // A discard or a retry that ran meanwhile owns the row now.
      if (!s.deps.core.outbox(g).some((x) => toHex(x.msgId) === msgHex && x.state === 0)) { s.requestDrain(g); return; }
      const code = e instanceof DillaHttpError ? (e.status === 404 ? 'E_ATTACHMENT_MISSING' : e.code)
        : e instanceof CoreError ? e.code : 'E_INTERNAL';
      s.deps.core.sendFail(msgId, code); s.reframedOnce.delete(reframeKey); s.deps.onOutboxChanged(g); s.requestDrain(g);
      return;
    }
    if (s.stopped()) return;
    if (!s.deps.core.outbox(g).some((x) => toHex(x.msgId) === msgHex && x.state === 0)) { s.requestDrain(g); return; }
  }
  let messageBody: Uint8Array;
  try { messageBody = s.deps.core.sendEncrypt(msgId).messageBody; }
  catch (e) {
    if (e instanceof CoreError && e.code === 'E_CORE_STATE') {
      const group = s.row(g);
      if (group?.pendingCommit) return;
      if ((group?.proposalsPending ?? 0) > 0) {
        if (s.quiet.has(hex)) return;
        const ok = await s.commitNow(g, 0);
        if (!ok) s.quiet.add(hex);
        s.requestDrain(g);
      }
      return;
    }
    if (e instanceof CoreError) { s.deps.core.sendFail(msgId, e.code); s.reframedOnce.delete(reframeKey); s.deps.onOutboxChanged(g); s.requestDrain(g); return; }
    throw e;
  }
  try {
    const answer = await s.deps.routes.postMessage(g, messageBody);
    if (s.stopped()) return;
    try { s.deps.core.sendConfirm(msgId, answer.raw); }
    catch (e) {
      if (!(e instanceof CoreError)) throw e;
      if (!s.deps.core.outbox(g).some((x) => toHex(x.msgId) === msgHex && x.state !== 2)) s.reframedOnce.delete(reframeKey);
      s.deps.onOutboxChanged(g); s.count425.delete(msgHex); s.requestCatchUp(g); s.requestDrain(g); return;
    }
    s.reframedOnce.delete(reframeKey); s.deps.onOutboxChanged(g); s.count425.delete(msgHex); s.requestDrain(g);
  } catch (e) {
    if (s.stopped()) return;
    const status = e instanceof DillaHttpError ? e.status : 0;
    const code = e instanceof DillaHttpError ? e.code : 'E_NETWORK';
    if (status === 422 && code === 'E_COMMIT_INVALID' && e instanceof DillaHttpError && e.extra[0] === 'epoch' && !s.reframedOnce.has(reframeKey)) {
      // The instance rejected this upload before storing it. Re-frame the same outbox row at the
      // current epoch, once; this is separate from the lost-response path, where storage is unknown.
      const reached = await s.catchUpNow(g, 'catch-up');
      const current = s.deps.core.outbox(g).find((x) => toHex(x.msgId) === msgHex);
      if (!reached || current?.state !== 1 || s.row(g)?.state !== 2) {
        if (current?.state === 1) { s.deps.core.sendFail(msgId, code); s.reframedOnce.delete(reframeKey); }
        s.deps.onOutboxChanged(g); s.requestDrain(g);
        return;
      }
      s.deps.core.sendRequeue(msgId);
      s.reframedOnce.add(reframeKey);
      s.deps.onOutboxChanged(g); s.requestDrain(g);
      return;
    }
    if (status === 425) {
      s.deps.core.sendRequeue(msgId); s.deps.onOutboxChanged(g);
      const n = (s.count425.get(msgHex) ?? 0) + 1; s.count425.set(msgHex, n);
      if (n >= SYNC.commitRetryMax) {
        s.deps.core.sendFail(msgId, 'E_COMMIT_REQUIRED'); s.reframedOnce.delete(reframeKey); s.deps.onOutboxChanged(g); s.requestDrain(g);
      } else {
        const old = s.epochWait.get(hex); if (old !== undefined) s.cancelTimer(old);
        s.epochWait.set(hex, s.armTimer(SYNC.membershipWaitMs, () => {
          s.epochWait.delete(hex); s.requestCommit(g, 0); s.requestDrain(g);
        }));
      }
    } else if (status === 403 && code === 'E_LEAF_NOT_CURRENT') {
      s.deps.core.sendRequeue(msgId); s.deps.onOutboxChanged(g);
      if (!s.resyncTried.has(hex)) await resyncGroup(s, g, false);
    } else if (status === 401) {
      s.deps.core.sendRequeue(msgId); s.deps.onOutboxChanged(g);
    } else if (status === 0 || status === 500 || status === 502 || status === 504) {
      // 502/504 come from the operator's proxy (L-HTTP-10) and say nothing about whether dillad stored it.
      await afterLostResponse(s, g, msgId);
    } else {
      s.deps.core.sendFail(msgId, code); s.reframedOnce.delete(reframeKey); s.deps.onOutboxChanged(g); s.requestDrain(g);
    }
  }
}

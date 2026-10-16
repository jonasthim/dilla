import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreError, type AttachmentDescriptor, type Id } from '../core-port';
import { toHex } from '../hex';
import { SYNC } from './engine';
import { catchSync, coreCalls, device, openRegistered, readyInfo, type Device } from './testing/harness';
import { CHANNEL, CHANNEL_2, COMMUNITY, ME, ManualClock, ModelDs, PEER, THIRD, deferred, httpError, idOf, settle, textRequest } from './testing/model';
import { fakeDskPub } from '../testing/fake-list';

let ds: ModelDs;
let clock: ManualClock;
let d: Device;
let g: Id;

beforeEach(async () => {
  ds = new ModelDs();
  clock = new ManualClock();
  ds.addChannel(COMMUNITY, CHANNEL);
  d = device(ds, clock, ME);
  g = await openRegistered(ds, d);
});

const posts = (): number => ds.callsOf(ME.device, 'postMessage').length;
const commits = (): number => ds.callsOf(ME.device, 'postCommit').length;
const sent = (): string[] => ds.view(g).messages.map((m) => m.body);
const states = (): number[] => d.core.outbox(g).map((r) => r.state);

describe('sending (rule 5)', () => {
  it('sends oldest first with one message of a group in flight, and confirms each', async () => {
    const gate = deferred();
    ds.inject('postMessage', { gate: gate.promise });
    const m1 = d.engine.send(g, 'first');
    const m2 = d.engine.send(g, 'second');
    await settle();
    expect(posts()).toBe(1);
    expect(d.core.outbox(g).map((r) => [toHex(r.msgId), r.state])).toEqual([
      [toHex(m1), 1],
      [toHex(m2), 0],
    ]);
    gate.resolve();
    await settle();
    expect(sent()).toEqual(['first', 'second']);
    expect(d.core.outbox(g)).toEqual([]);
    expect(d.core.bodies(g)).toEqual(['first', 'second']);
    expect(d.outboxChanges.filter((x) => x === toHex(g)).length).toBeGreaterThanOrEqual(4);
  });

  it('throws the core refusal of an empty message synchronously', () => {
    expect(catchSync(() => d.engine.send(g, '   '))).toMatchObject({ code: 'E_CORE_INPUT' });
    expect(d.core.outbox(g)).toEqual([]);
  });

  it('re-frames the same message once after a rule epoch refusal following a peer commit', async () => {
    ds.inject('postMessage', { before: () => { ds.peerCommit(g, PEER); } });
    const msgId = d.engine.send(g, 'after peer joined');
    await settle();
    expect(posts()).toBe(2);
    expect(sent()).toEqual(['after peer joined']);
    expect(d.core.outbox(g)).toEqual([]);
    expect(d.core.calls.filter((c) => c.m === 'sendPrepare')).toHaveLength(1);
    expect(d.core.calls.filter((c) => c.m === 'sendEncrypt')).toHaveLength(2);
    expect(d.core.bodies(g)).toEqual(['after peer joined']);
    expect(toHex(msgId)).toHaveLength(32);
  });

  it('fails the same row after a second rule epoch refusal', async () => {
    ds.inject('postMessage', { before: () => { ds.peerCommit(g, PEER); } });
    ds.inject('postMessage', { fail: httpError(422, 'E_COMMIT_INVALID', null, ['epoch']) });
    const msgId = d.engine.send(g, 'twice refused');
    await settle();
    expect(posts()).toBe(2);
    expect(d.core.outbox(g)).toMatchObject([{ msgId, state: 2, error: 'E_COMMIT_INVALID', body: 'twice refused' }]);
    expect(sent()).toEqual([]);
  });

  it('adopts a stored re-framed message when the second response is lost, without a third post', async () => {
    ds.detach(ME.device);
    ds.inject('postMessage', { before: () => { ds.peerCommit(g, PEER); } });
    ds.inject('postMessage', { lose: true });
    const msgId = d.engine.send(g, 'stored after re-frame');
    await settle();
    expect(posts()).toBe(2);
    expect(sent()).toEqual(['stored after re-frame']);
    expect(d.core.outbox(g)).toEqual([]);
    expect(d.core.bodies(g)).toEqual(['stored after re-frame']);
    expect(d.core.calls.filter((c) => c.m === 'sendPrepare')).toHaveLength(1);
    expect(toHex(msgId)).toHaveLength(32);
    await clock.advance(30_000);
    expect(posts()).toBe(2);
  });

  it('commits a proposal learned after the peer commit before re-framing the queued message', async () => {
    ds.detach(ME.device);
    ds.inject('postMessage', { before: () => { ds.peerCommit(g, PEER); } });
    ds.inject('getMessages', { before: () => { ds.propose(g, 'add', THIRD.device); } });
    const msgId = d.engine.send(g, 'after proposal');
    await settle();
    expect(commits()).toBe(1);
    expect(posts()).toBe(2);
    expect(sent()).toEqual(['after proposal']);
    expect(d.core.outbox(g)).toEqual([]);
    expect(d.core.calls.filter((c) => c.m === 'sendPrepare')).toHaveLength(1);
    expect(toHex(msgId)).toHaveLength(32);
  });

  it('never resends after a lost response: the catch-up adopts the stored copy', async () => {
    ds.detach(ME.device);
    ds.inject('postMessage', { lose: true });
    d.engine.send(g, 'once');
    await settle();
    expect(posts()).toBe(1);
    expect(ds.view(g).messages.filter((m) => m.uploader === toHex(ME.device))).toHaveLength(1);
    expect(d.core.outbox(g)).toEqual([]);
    expect(d.core.bodies(g)).toEqual(['once']);
    await clock.advance(30_000);
    expect(posts()).toBe(1);
    expect(sent()).toEqual(['once']);
  });

  const lost: [number, string][] = [
    [0, 'E_NETWORK'],
    [500, 'E_INTERNAL'],
  ];
  it.each(lost)('resends a message that never arrived (%i %s) only after the echo wait and a second catch-up', async (status, code) => {
    ds.detach(ME.device);
    ds.inject('postMessage', { fail: httpError(status, code) });
    d.engine.send(g, 'retry me');
    await settle();
    expect(posts()).toBe(1);
    expect(states()).toEqual([1]);
    expect(ds.callsOf(ME.device, 'getMessages')).toHaveLength(1);
    await clock.advance(SYNC.echoWaitMs - 1);
    expect(posts()).toBe(1);
    await clock.advance(1);
    expect(ds.callsOf(ME.device, 'getMessages')).toHaveLength(2);
    expect(posts()).toBe(2);
    expect(sent()).toEqual(['retry me']);
    expect(d.core.outbox(g)).toEqual([]);
  });

  it('keeps a lost upload in flight while the catch-ups cannot reach the server: one stored copy (CLIENT-CORE-TS-01)', async () => {
    ds.detach(ME.device);
    ds.inject('postMessage', { lose: true });
    for (let i = 0; i < 4; i++) ds.inject('getMessages', { fail: httpError(0, 'E_NETWORK') });
    d.engine.send(g, 'once');
    await settle();
    expect(posts()).toBe(1);
    expect(states()).toEqual([1]);
    await clock.advance(SYNC.echoWaitMs);
    expect(ds.callsOf(ME.device, 'getMessages')).toHaveLength(2);
    expect(posts()).toBe(1);
    expect(sent()).toEqual(['once']);
    expect(states()).toEqual([1]);
  });

  it('a later catch-up that reaches the server adopts the lost upload without a resend (CLIENT-CORE-TS-01)', async () => {
    ds.detach(ME.device);
    ds.inject('postMessage', { lose: true });
    for (let i = 0; i < 4; i++) ds.inject('getMessages', { fail: httpError(0, 'E_NETWORK') });
    d.engine.send(g, 'once');
    await settle();
    for (let i = 0; i < 3; i++) await clock.advance(SYNC.echoWaitMs);
    expect(ds.callsOf(ME.device, 'getMessages')).toHaveLength(4);
    expect(states()).toEqual([1]);
    await clock.advance(SYNC.echoWaitMs);
    expect(ds.callsOf(ME.device, 'getMessages')).toHaveLength(5);
    expect(posts()).toBe(1);
    expect(sent()).toEqual(['once']);
    expect(d.core.outbox(g)).toEqual([]);
    expect(d.core.bodies(g)).toEqual(['once']);
  });

  it('does not requeue after a catch-up that ended in a resync (410 E_PRUNED): the resync cannot see an earlier copy (CLIENT-CORE-TS-01)', async () => {
    ds.detach(ME.device);
    ds.inject('postMessage', { fail: httpError(0, 'E_NETWORK') });
    d.engine.send(g, 'unknown fate');
    await settle();
    expect(states()).toEqual([1]);
    ds.inject('getMessages', { fail: httpError(410, 'E_PRUNED') });
    await clock.advance(SYNC.echoWaitMs);
    expect(ds.callsOf(ME.device, 'postResync')).toHaveLength(1);
    expect(d.core.group(g)?.state).toBe(2);
    expect(posts()).toBe(1);
    expect(states()).toEqual([1]);
  });

  const proxy: [number][] = [[502], [504]];
  it.each(proxy)("takes a proxy's %i (E_HTTP) as a lost response: the stored upload is adopted, never sent twice (CLIENT-CORE-TS-03)", async (status) => {
    ds.detach(ME.device);
    ds.inject('postMessage', { after: () => { throw httpError(status, 'E_HTTP'); } });
    d.engine.send(g, 'behind a proxy');
    await settle();
    await clock.advance(30_000);
    expect(posts()).toBe(1);
    expect(sent()).toEqual(['behind a proxy']);
    expect(d.core.outbox(g)).toEqual([]);
    expect(d.core.bodies(g)).toEqual(['behind a proxy']);
  });

  it('settles a row left in flight by an earlier page through a catch-up, not a resend', async () => {
    ds.detach(ME.device);
    const earlier = d.core.sendPrepare(g, textRequest('earlier'), 1n);
    const enc = d.core.sendEncrypt(earlier);
    await ds.routesFor(ME.device).postMessage(enc.groupId, enc.messageBody); // its response died with the page
    d.engine.send(g, 'next');
    await settle();
    expect(sent()).toEqual(['earlier', 'next']);
    expect(posts()).toBe(2);
    expect(d.core.outbox(g)).toEqual([]);
    expect(d.core.bodies(g)).toEqual(['earlier', 'next']);
  });

  it('on 425 waits membershipWaitMs, then commits the outstanding proposals itself and resends', async () => {
    ds.detach(ME.device);
    ds.propose(g, 'add', THIRD.device); // seq 1: this device never sees it
    d.engine.send(g, 'after membership');
    await settle();
    expect(posts()).toBe(1);
    expect(states()).toEqual([0]);
    await clock.advance(SYNC.membershipWaitMs - 1);
    expect(commits()).toBe(0);
    await clock.advance(1);
    expect(commits()).toBe(1);
    expect(posts()).toBe(2);
    expect(ds.view(g).messages).toEqual([{ seq: 3n, epoch: 1n, uploader: toHex(ME.device), body: 'after membership' }]);
    expect(d.core.outbox(g)).toEqual([]);
  });

  it('a queued message behind a locally known proposal is sent after this device commits', async () => {
    ds.propose(g, 'add', THIRD.device); // seq 1, applied live: proposalsPending 1, no op 17
    await settle();
    expect(d.core.group(g)).toMatchObject({ proposalsPending: 1, pendingCommit: false });
    d.core.resetLog();
    ds.resetCalls();
    d.engine.send(g, 'hello');
    await settle();
    expect(coreCalls(d, g, ['sendEncrypt', 'commitBuild', 'commitConfirm', 'sendConfirm'])).toEqual([
      'sendEncrypt', 'commitBuild', 'commitConfirm', 'sendEncrypt', 'sendConfirm',
    ]);
    const routes = ds.calls
      .filter((c) => c.dev === toHex(ME.device) && (c.route === 'getProposals' || c.route === 'postCommit' || c.route === 'postMessage'))
      .map((c) => c.route);
    expect(routes).toEqual(['getProposals', 'postCommit', 'postMessage']);
    expect(posts()).toBe(1);
    expect(d.core.outbox(g)).toEqual([]);
    expect(d.core.timeline(g, 0n, 200)).toMatchObject([{ seq: 3n, status: 0, body: 'hello' }]);
    expect(d.core.group(g)).toMatchObject({ epoch: 1n, proposalsPending: 0, pendingCommit: false });
    expect(d.gateway.acks).toEqual([]);
  });

  it('on 425 resends without committing when another member commits inside the wait', async () => {
    ds.detach(ME.device);
    ds.propose(g, 'add', THIRD.device); // seq 1
    ds.reattach(ME.device);
    d.engine.send(g, 'membership settled');
    await settle();
    expect(posts()).toBe(1);
    ds.peerCommit(g, PEER); // seq 2, a gap for this device: catch-up, epoch 1
    await settle();
    expect(commits()).toBe(0);
    expect(posts()).toBe(2);
    expect(ds.view(g).messages).toEqual([{ seq: 3n, epoch: 1n, uploader: toHex(ME.device), body: 'membership settled' }]);
    await clock.advance(10_000);
    expect(commits()).toBe(0);
  });

  it('fails a row after commitRetryMax consecutive 425 refusals', async () => {
    for (let i = 0; i < SYNC.commitRetryMax; i++) ds.inject('postMessage', { fail: httpError(425, 'E_COMMIT_REQUIRED', 2000) });
    const m = d.engine.send(g, 'stuck');
    await settle();
    for (let i = 0; i < SYNC.commitRetryMax - 1; i++) await clock.advance(SYNC.membershipWaitMs);
    expect(posts()).toBe(SYNC.commitRetryMax);
    expect(d.core.outbox(g)).toMatchObject([{ msgId: m, state: 2, error: 'E_COMMIT_REQUIRED', body: 'stuck' }]);
    expect(commits()).toBe(0);
    await clock.advance(10_000);
    expect(posts()).toBe(SYNC.commitRetryMax);
  });

  it('on 403 E_LEAF_NOT_CURRENT resyncs, then sends at the new epoch', async () => {
    ds.evict(g, ME.device);
    d.engine.send(g, 'still here');
    await settle();
    expect(ds.callsOf(ME.device, 'postResync')).toHaveLength(1);
    expect(d.membership).toEqual([{ group: toHex(g), status: 'resyncing' }]);
    expect(ds.view(g).messages).toEqual([{ seq: 2n, epoch: 1n, uploader: toHex(ME.device), body: 'still here' }]);
    expect(d.core.group(g)?.epoch).toBe(1n);
    expect(d.core.outbox(g)).toEqual([]);
  });

  it('on 401 puts the row back and does not try again on its own', async () => {
    ds.inject('postMessage', { fail: httpError(401, 'E_UNAUTHENTICATED') });
    d.engine.send(g, 'later');
    await settle();
    expect(states()).toEqual([0]);
    expect(posts()).toBe(1);
    await clock.advance(60_000);
    expect(posts()).toBe(1);
  });

  const refusals: [number, string][] = [
    [413, 'E_TOO_LARGE'],
    [422, 'E_COMMITMENT_INVALID'],
    [404, 'E_NOT_FOUND'],
    [403, 'E_FORBIDDEN'],
    [503, 'E_UNAVAILABLE'],
  ];
  it.each(refusals)('marks the row failed on %i %s and moves on to the next row', async (status, code) => {
    ds.inject('postMessage', { fail: httpError(status, code) });
    const bad = d.engine.send(g, 'refused');
    d.engine.send(g, 'accepted');
    await settle();
    expect(d.core.outbox(g)).toMatchObject([{ msgId: bad, state: 2, error: code, body: 'refused' }]);
    expect(sent()).toEqual(['accepted']);
    expect(ds.callsOf(ME.device, 'postResync')).toHaveLength(0);
  });

  it('retry puts a failed row back in the queue and discard removes one', async () => {
    ds.inject('postMessage', { fail: httpError(413, 'E_TOO_LARGE') });
    ds.inject('postMessage', { fail: httpError(413, 'E_TOO_LARGE') });
    const a = d.engine.send(g, 'first');
    const b = d.engine.send(g, 'second');
    await settle();
    expect(states()).toEqual([2, 2]);
    d.engine.retry(a);
    await settle();
    expect(sent()).toEqual(['first']);
    d.engine.discard(b);
    expect(d.core.outbox(g)).toEqual([]);
    await settle();
    expect(sent()).toEqual(['first']);
    expect(d.outboxChanges.filter((x) => x === toHex(g)).length).toBeGreaterThanOrEqual(6);
    expect(catchSync(() => d.engine.retry(b))).toMatchObject({ code: 'E_CORE_NOT_FOUND' });
  });
});

/** A descriptor as the tray hands it over (L-TS-30); the model checks shape, not cryptography. */
function desc(n: number): AttachmentDescriptor {
  return {
    blobId: new Uint8Array(32).fill(n), key: new Uint8Array(32).fill(0x44), nonce: new Uint8Array(12).fill(0x45),
    size: 10 + n, mime: 'text/plain', w: null, h: null, thumb: null, name: `f${String(n)}.txt`,
  };
}
const withFiles = (body: string, ...n: number[]) => ({ type: 0 as const, replyTo: null, body, attachments: n.map(desc) });

describe('sending with attachments and folds (L-TS-34)', () => {
  it('confirms the attachments of a row before its upload, once per attempt', async () => {
    const order: string[] = [];
    d.hooks.beforeSend = () => { order.push('confirm'); return Promise.resolve(); };
    ds.inject('postMessage', { before: () => { order.push('message'); } });
    const msgId = d.engine.sendRequest(g, withFiles('two files', 1, 2));
    await settle();
    expect(order).toEqual(['confirm', 'message']);
    expect(d.beforeSends).toEqual([toHex(msgId)]);
    expect(posts()).toBe(1);
    expect(d.core.outbox(g)).toEqual([]);
  });

  it('confirms again when the same row is re-framed after an epoch refusal', async () => {
    ds.inject('postMessage', { before: () => { ds.peerCommit(g, PEER); } });
    const msgId = d.engine.sendRequest(g, withFiles('', 3));
    await settle();
    expect(posts()).toBe(2);
    expect(d.beforeSends).toEqual([toHex(msgId), toHex(msgId)]);
    expect(d.core.outbox(g)).toEqual([]);
  });

  it('a confirm answered 404 fails the row with E_ATTACHMENT_MISSING and uploads nothing', async () => {
    d.hooks.beforeSend = () => Promise.reject(httpError(404, 'E_NOT_FOUND'));
    const msgId = d.engine.sendRequest(g, withFiles('gone file', 4));
    await settle();
    expect(posts()).toBe(0);
    expect(d.core.calls.filter((c) => c.m === 'sendEncrypt')).toHaveLength(0);
    expect(d.core.outbox(g)).toMatchObject([{ msgId, state: 2, error: 'E_ATTACHMENT_MISSING', body: 'gone file' }]);
  });

  it('another refusal fails the row with its own code; a thrown non-HTTP error with E_INTERNAL', async () => {
    d.hooks.beforeSend = () => Promise.reject(httpError(403, 'E_NOT_UPLOADER'));
    const a = d.engine.sendRequest(g, withFiles('not mine', 5));
    await settle();
    expect(d.core.outbox(g)).toMatchObject([{ msgId: a, state: 2, error: 'E_NOT_UPLOADER' }]);
    d.hooks.beforeSend = () => Promise.reject(new CoreError('E_CORE_STATE', 'unknown group'));
    const b = d.engine.sendRequest(g, withFiles('no group', 6));
    await settle();
    expect(d.core.outbox(g).find((r) => toHex(r.msgId) === toHex(b))).toMatchObject({ state: 2, error: 'E_CORE_STATE' });
    d.hooks.beforeSend = () => Promise.reject(new Error('boom'));
    const c = d.engine.sendRequest(g, withFiles('odd', 7));
    await settle();
    expect(d.core.outbox(g).find((r) => toHex(r.msgId) === toHex(c))).toMatchObject({ state: 2, error: 'E_INTERNAL' });
    expect(posts()).toBe(0);
  });

  it('a row without attachments never calls beforeSend', async () => {
    d.engine.send(g, 'plain');
    await settle();
    expect(d.beforeSends).toEqual([]);
    expect(sent()).toEqual(['plain']);
  });

  it('a row discarded while its confirm runs is not uploaded, and its references are reported', async () => {
    const gate = deferred();
    d.hooks.beforeSend = () => gate.promise;
    const msgId = d.engine.sendRequest(g, withFiles('changed my mind', 8, 9));
    await settle();
    expect(d.beforeSends).toEqual([toHex(msgId)]);
    d.engine.discard(msgId);
    gate.resolve();
    await settle();
    expect(posts()).toBe(0);
    expect(d.core.outbox(g)).toEqual([]);
    expect(d.discarded).toEqual([{ group: toHex(g), msgId: toHex(msgId), blobIds: [toHex(desc(8).blobId), toHex(desc(9).blobId)] }]);
  });

  it('discarding a failed row reports it once; an unknown msg id reports nothing', async () => {
    d.hooks.beforeSend = () => Promise.reject(httpError(404, 'E_NOT_FOUND'));
    const msgId = d.engine.sendRequest(g, withFiles('', 10));
    await settle();
    d.engine.discard(msgId);
    d.engine.discard(new Uint8Array(16).fill(0xee));
    expect(d.discarded).toEqual([{ group: toHex(g), msgId: toHex(msgId), blobIds: [toHex(desc(10).blobId)] }]);
    expect(d.core.outbox(g)).toEqual([]);
  });

  it('sendRequest sends a fold with its type and reply_to, and the folded view shows it', async () => {
    const target = d.engine.send(g, 'first words');
    await settle();
    const edit = d.engine.sendRequest(g, { type: 1, replyTo: target, body: 'better words', attachments: [] });
    expect(d.core.outbox(g)).toMatchObject([{ msgId: edit, type: 1, replyTo: target, body: 'better words', attachments: [] }]);
    await settle();
    expect(posts()).toBe(2);
    expect(d.core.outbox(g)).toEqual([]);
    const rows = d.core.timeline(g, 0n, 100);
    expect(rows.map((r) => [toHex(r.msgId as Id), r.body, r.editedSeq > 0n])).toEqual([[toHex(target), 'better words', true]]);
  });

  it('throws the core refusal of a fold synchronously and queues nothing', () => {
    expect(catchSync(() => d.engine.sendRequest(g, { type: 1, replyTo: null, body: 'x', attachments: [] })))
      .toMatchObject({ code: 'E_CORE_INPUT', detail: 'reply_to is required' });
    expect(d.core.outbox(g)).toEqual([]);
  });

  // Pre-flight ruling F5: a confirm that cannot reach the instance (status 0, 429, 5xx) is not a refusal of the file;
  // the row stays queued, as a text row does across network loss, and the next ready drains it (no timer of its own).
  const transient: [number, string][] = [
    [0, 'E_NETWORK'],
    [429, 'E_RATE_LIMITED'],
    [503, 'E_UNAVAILABLE'],
  ];
  it.each(transient)('a confirm failing with %i %s keeps the row queued; the next ready uploads it once (F5)', async (status, code) => {
    d.hooks.beforeSend = () => Promise.reject(httpError(status, code));
    const msgId = d.engine.sendRequest(g, withFiles('offline', 11));
    await settle();
    expect(posts()).toBe(0);
    expect(d.core.outbox(g)).toMatchObject([{ msgId, state: 0, error: '' }]);
    await clock.advance(60_000);
    expect(d.beforeSends).toEqual([toHex(msgId)]);
    d.hooks.beforeSend = () => Promise.resolve();
    d.gateway.ready(readyInfo(ME));
    await settle();
    expect(d.beforeSends).toEqual([toHex(msgId), toHex(msgId)]);
    expect(posts()).toBe(1);
    expect(d.core.outbox(g)).toEqual([]);
  });

  it('a confirm answered 410 (the bytes were purged) fails the row with its code (F5)', async () => {
    d.hooks.beforeSend = () => Promise.reject(httpError(410, 'E_PRUNED'));
    const msgId = d.engine.sendRequest(g, withFiles('purged', 12));
    await settle();
    expect(posts()).toBe(0);
    expect(d.core.outbox(g)).toMatchObject([{ msgId, state: 2, error: 'E_PRUNED' }]);
  });
});

describe('a queued row refused at send_encrypt by a leaf verdict (client I1, security F8)', () => {
  const JOINED = idOf(0xd0, 22);
  /** The row is queued; the verdict of a device that joined before its list was ingested lands before the drain runs. */
  function queuedThenRefused(code: string): Id {
    d.core.addPendingLeaf(g, 1, PEER.user, JOINED, fakeDskPub(JOINED), 1);
    const msgId = d.engine.send(g, 'queued before the verdict');
    d.core.setLeafVerdict(g, 1, code);
    return msgId;
  }

  it('stays queued, refreshes the group trust once and is sent when the refresh clears the verdict', async () => {
    d.hooks.refreshGroupTrust = () => { d.core.setLeafVerdict(g, 1, null); return Promise.resolve(); };
    queuedThenRefused('E_DEVICE_UNLISTED');
    await settle();
    expect(d.refreshes).toEqual([toHex(g)]);
    expect(sent()).toEqual(['queued before the verdict']);
    expect(d.core.outbox(g)).toEqual([]);
  });

  it('is not failed by a drain that runs while the refresh is still out', async () => {
    const gate = deferred();
    d.hooks.refreshGroupTrust = () => gate.promise.then(() => { d.core.setLeafVerdict(g, 1, null); });
    queuedThenRefused('E_DEVICE_UNLISTED');
    await settle();
    d.engine.requestDrain(g);
    await settle();
    expect(states()).toEqual([0]);
    gate.resolve();
    await settle();
    expect(sent()).toEqual(['queued before the verdict']);
  });

  it('fails with the verdict when it is refused again after the one refresh', async () => {
    const msgId = queuedThenRefused('E_CREDENTIAL');
    await settle();
    expect(d.refreshes).toEqual([toHex(g)]);
    expect(posts()).toBe(0);
    expect(d.core.outbox(g)).toMatchObject([{ msgId, state: 2, error: 'E_CREDENTIAL' }]);
  });

  it('a changed key is never retried', async () => {
    const msgId = queuedThenRefused('E_UMK_CHANGED');
    await settle();
    expect(d.refreshes).toEqual([]);
    expect(d.core.outbox(g)).toMatchObject([{ msgId, state: 2, error: 'E_UMK_CHANGED' }]);
  });

  it('a retry of a row a verdict failed refreshes the group trust before it is sealed again', async () => {
    const msgId = queuedThenRefused('E_DEVICE_UNLISTED');
    await settle();
    expect(states()).toEqual([2]);
    const encrypts = d.core.calls.filter((c) => c.m === 'sendEncrypt').length;
    d.hooks.refreshGroupTrust = () => {
      expect(d.core.calls.filter((c) => c.m === 'sendEncrypt').length).toBe(encrypts);
      d.core.setLeafVerdict(g, 1, null);
      return Promise.resolve();
    };
    d.engine.retry(msgId);
    await settle();
    expect(d.refreshes).toEqual([toHex(g), toHex(g)]);
    expect(sent()).toEqual(['queued before the verdict']);
  });
});

// CB2: a 429 (slow mode, or any other) requeues the row and arms a timer; the group's lane is never held (R6, R38).
describe('slow mode in the send lane (CB2)', () => {
  const slowed = (ms: number | null = 5000) => httpError(429, 'E_RATE_LIMITED', ms);
  const coreOf = (m: string): number => d.core.calls.filter((c) => c.m === m && c.g === toHex(g)).length;
  const reaction = (target: Id) => ({ type: 3 as const, replyTo: target, body: '👍', attachments: [] });

  it('a 429 requeues the row instead of failing it', async () => {
    ds.inject('postMessage', { fail: slowed() });
    const t0 = clock.now();
    const msgId = d.engine.send(g, 'slow');
    await settle();
    expect(coreOf('sendRequeue')).toBe(1);
    expect(coreOf('sendFail')).toBe(0);
    expect(d.core.outbox(g)).toMatchObject([{ msgId, state: 0, error: '' }]);
    expect(d.slow).toEqual([{ group: toHex(g), until: t0 + 5000, queued: true }]);
  });

  it('the timer drains again after retryAfterMs', async () => {
    ds.inject('postMessage', { fail: slowed() });
    d.engine.send(g, 'slow');
    await settle();
    expect(posts()).toBe(1);
    await clock.advance(4999);
    expect(posts()).toBe(1);
    await clock.advance(1);
    expect(posts()).toBe(2);
    expect(sent()).toEqual(['slow']);
    expect(d.core.outbox(g)).toEqual([]);
    expect(d.slow.at(-1)).toEqual({ group: toHex(g), until: 0, queued: false });
    expect(d.slow).toHaveLength(2);
  });

  it('the lane never sleeps', async () => {
    const wait = vi.spyOn(d.engine, 'wait');
    ds.inject('postMessage', { fail: slowed() });
    d.engine.send(g, 'slow');
    await settle();
    await clock.advance(5000);
    expect(sent()).toEqual(['slow']);
    expect(wait).not.toHaveBeenCalled();
  });

  it('other groups drain while one waits', async () => {
    ds.addChannel(COMMUNITY, CHANNEL_2);
    const b = await openRegistered(ds, d, CHANNEL_2);
    ds.inject('postMessage', { fail: slowed() });
    d.engine.send(g, 'in A');
    await settle();
    d.engine.send(b, 'in B');
    await settle();
    expect(ds.view(b).messages.map((m) => m.body)).toEqual(['in B']);
    expect(sent()).toEqual([]);
    expect(d.core.outbox(g)).toMatchObject([{ state: 0 }]);
    await clock.advance(5000);
    expect(sent()).toEqual(['in A']);
  });

  it('a 429 without retryAfterMs waits 1000 ms', async () => {
    ds.inject('postMessage', { fail: slowed(null) });
    const t0 = clock.now();
    d.engine.send(g, 'slow');
    await settle();
    expect(d.slow).toEqual([{ group: toHex(g), until: t0 + 1000, queued: true }]);
    await clock.advance(999);
    expect(posts()).toBe(1);
    await clock.advance(1);
    expect(posts()).toBe(2);
  });

  it('stop cancels the wait', async () => {
    ds.inject('postMessage', { fail: slowed() });
    d.engine.send(g, 'slow');
    await settle();
    expect(d.core.outbox(g)).toMatchObject([{ state: 0 }]);
    d.engine.stop();
    await clock.advance(10_000);
    expect(posts()).toBe(1);
    expect(clock.pending).toBe(0);
  });

  it('a confirmed post reports onPosted', async () => {
    const target = d.engine.send(g, 'first');
    await settle();
    expect(d.posted).toEqual([{ group: toHex(g), type: 0 }]);
    d.engine.sendRequest(g, reaction(target));
    await settle();
    expect(d.posted).toEqual([{ group: toHex(g), type: 0 }, { group: toHex(g), type: 3 }]);
    expect(d.slow).toEqual([]);
  });

  it('a reaction drains while a post waits (R38)', async () => {
    const earlier = d.engine.send(g, 'earlier');
    await settle();
    ds.inject('postMessage', { fail: slowed() });
    // Queued behind P before P's upload is answered: the 429 itself must let it drain.
    const p = d.engine.send(g, 'waiting');
    const r = d.engine.sendRequest(g, reaction(earlier));
    await settle();
    expect(posts()).toBe(3);
    expect(d.core.outbox(g).map((x) => [toHex(x.msgId), x.state])).toEqual([[toHex(p), 0]]);
    expect(d.posted.map((x) => x.type)).toEqual([0, 3]);
    expect(toHex(r)).toHaveLength(32);
    await clock.advance(5000);
    expect(posts()).toBe(4);
    expect(sent()).toEqual(['earlier', '👍', 'waiting']);
    expect(d.core.outbox(g)).toEqual([]);
  });

  it('a fold refused 429 waits for the timer too (R6: every 429)', async () => {
    const earlier = d.engine.send(g, 'earlier');
    await settle();
    ds.inject('postMessage', { fail: slowed(2000) });
    d.engine.sendRequest(g, reaction(earlier));
    await settle();
    expect(posts()).toBe(2);
    expect(d.core.outbox(g)).toMatchObject([{ type: 3, state: 0 }]);
    await clock.advance(1999);
    expect(posts()).toBe(2);
    await clock.advance(1);
    expect(posts()).toBe(3);
    expect(d.core.outbox(g)).toEqual([]);
    expect(d.posted.map((x) => x.type)).toEqual([0, 3]);
  });

  // The brief's fixture (an edit queued on a post still in the outbox) is unreachable: the core (messages.rs
  // send_prepare, fold::resolve) and the model refuse a fold whose target is not held, and a queued post is not held
  // until it is confirmed. So the fold can never reach the host before its post; drainOne's target check is a belt.
  it('a fold on the waiting post waits with it', async () => {
    ds.inject('postMessage', { fail: slowed() });
    const p = d.engine.send(g, 'waiting');
    await settle();
    expect(catchSync(() => d.engine.sendRequest(g, { type: 1, replyTo: p, body: 'edited', attachments: [] })))
      .toMatchObject({ code: 'E_CORE_NOT_FOUND', detail: 'target is not held' });
    expect(catchSync(() => d.engine.sendRequest(g, reaction(p)))).toMatchObject({ code: 'E_CORE_NOT_FOUND' });
    expect(d.core.outbox(g).map((x) => [x.type, x.state])).toEqual([[0, 0]]);
    await clock.advance(5000);
    expect(posts()).toBe(2);
    // Once P is confirmed, a fold on it queues and uploads.
    d.engine.sendRequest(g, { type: 1, replyTo: p, body: 'edited', attachments: [] });
    await settle();
    expect(posts()).toBe(3);
    expect(d.posted.map((x) => x.type)).toEqual([0, 1]);
    expect(d.core.timeline(g, 0n, 100).map((x) => [toHex(x.msgId as Id), x.body])).toEqual([[toHex(p), 'edited']]);
  });

  // Fix round 1.
  it('two edits on one target keep their order when the first is refused 429', async () => {
    const earlier = d.engine.send(g, 'earlier');
    await settle();
    ds.inject('postMessage', { fail: slowed(5000) });
    d.engine.sendRequest(g, { type: 1, replyTo: earlier, body: 'one', attachments: [] });
    await settle();
    await clock.advance(1500);
    d.engine.sendRequest(g, { type: 1, replyTo: earlier, body: 'two', attachments: [] });
    await settle();
    expect(posts()).toBe(2);
    await clock.advance(5000);
    expect(sent()).toEqual(['earlier', 'one', 'two']);
  });

  it('a fold 429 in a slow-mode group does not shorten a post wait or publish', async () => {
    const earlier = d.engine.send(g, 'earlier');
    await settle();
    ds.inject('postMessage', { fail: slowed(9000) });
    const t0 = clock.now();
    d.engine.send(g, 'P');
    await settle();
    ds.inject('postMessage', { fail: slowed(1000) });
    d.engine.sendRequest(g, reaction(earlier));
    await settle();
    expect(d.slow.map((x) => [x.until - t0, x.queued])).toEqual([[9000, true]]);
    await clock.advance(8999);
    expect(sent()).toEqual(['earlier']);
    await clock.advance(1);
    expect(sent()).toEqual(['earlier', 'P', '👍']);
    expect(d.slow.map((x) => [x.until === 0 ? 0 : x.until - t0, x.queued])).toEqual([[9000, true], [0, false]]);
  });

  it('a later deadline replaces the wait: the earlier timer never drains', async () => {
    const earlier = d.engine.send(g, 'earlier');
    await settle();
    ds.inject('postMessage', { fail: slowed(1000) });
    d.engine.send(g, 'P');
    await settle();
    ds.inject('postMessage', { fail: slowed(5000) });
    d.engine.sendRequest(g, reaction(earlier));
    await settle();
    await clock.advance(1000);
    expect(sent()).toEqual(['earlier']);
    await clock.advance(4000);
    expect(sent()).toEqual(['earlier', 'P', '👍']);
  });

  it('a slowed fold that then fails is no longer held once it is retried', async () => {
    const earlier = d.engine.send(g, 'earlier');
    await settle();
    ds.inject('postMessage', { fail: slowed(2000) });
    const f = d.engine.sendRequest(g, { type: 1, replyTo: earlier, body: 'edit', attachments: [] });
    await settle();
    ds.inject('postMessage', { fail: httpError(403, 'E_FORBIDDEN') });
    await clock.advance(2000);
    expect(d.core.outbox(g)).toMatchObject([{ msgId: f, state: 2 }]);
    ds.inject('postMessage', { fail: slowed(5000) });
    d.engine.send(g, 'P');
    await settle();
    d.engine.retry(f);
    await settle();
    expect(sent()).toEqual(['earlier', 'edit']);
  });


  // Fix round 2.
  // Unreachable through the engine today: drainOne never uploads a post while a wait is armed, and one upload per group
  // is in flight. The armed wait is planted during P's upload to pin the rule that the countdown is the later deadline.
  it('a post refused 429 under a later armed deadline publishes that deadline', async () => {
    const t0 = clock.now();
    const hex = toHex(g);
    ds.inject('postMessage', { before: () => {
      d.engine.slowWait.set(hex, { timer: d.engine.armTimer(9000, () => { d.engine.slowWait.delete(hex); d.engine.requestDrain(g); }), until: t0 + 9000 });
      throw slowed(1000);
    } });
    d.engine.send(g, 'P');
    await settle();
    expect(d.slow).toEqual([{ group: hex, until: t0 + 9000, queued: true }]);
    await clock.advance(1000);
    expect(sent()).toEqual([]);
    await clock.advance(8000);
    expect(sent()).toEqual(['P']);
  });

  it('a refused resync fails the waiting rows and ends the wait: a retried post goes at once', async () => {
    const earlier = d.engine.send(g, 'earlier');
    await settle();
    ds.inject('postMessage', { fail: slowed(5000) });
    const p = d.engine.send(g, 'P');
    await settle();
    ds.inject('postMessage', { fail: httpError(403, 'E_LEAF_NOT_CURRENT') });
    ds.inject('getGroupInfo', { fail: httpError(404, 'E_NOT_FOUND') });
    d.engine.sendRequest(g, reaction(earlier));
    await settle();
    expect(d.core.outbox(g).map((x) => [x.type, x.state])).toEqual([[0, 2], [3, 2]]);
    expect(d.engine.slowWait.size).toBe(0);
    expect(d.engine.slowed.size).toBe(0);
    d.engine.retry(p);
    await settle();
    expect(sent()).toEqual(['earlier', 'P']);
  });

});

import { beforeEach, describe, expect, it } from 'vitest';
import type { Id } from '../core-port';
import { toHex } from '../hex';
import { SYNC } from './engine';
import { catchSync, coreCalls, device, openRegistered, type Device } from './testing/harness';
import { CHANNEL, COMMUNITY, ME, ManualClock, ModelDs, PEER, THIRD, deferred, httpError, settle } from './testing/model';

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
    const earlier = d.core.sendPrepare(g, 'earlier', 1n);
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
    [429, 'E_RATE_LIMITED'],
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

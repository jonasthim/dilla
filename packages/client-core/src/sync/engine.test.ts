import { beforeEach, describe, expect, it } from 'vitest';
import { toHex } from '../hex';
import { SYNC, throughOf, type PageInfo } from './engine';
import { catchSync, coreCalls, device, openRegistered, readyInfo } from './testing/harness';
import {
  CHANNEL_2, COMMUNITY, CHANNEL, FOURTH, ME, ManualClock, ModelDs, PEER, THIRD, at, deferred, httpError, idOf, settle, type RouteName,
} from './testing/model';

let ds: ModelDs;
let clock: ManualClock;

beforeEach(() => {
  ds = new ModelDs();
  clock = new ManualClock();
  ds.addChannel(COMMUNITY, CHANNEL);
  ds.addChannel(COMMUNITY, CHANNEL_2);
});

function count(route: RouteName): number {
  return ds.callsOf(ME.device, route).length;
}

function fromArgs(route: RouteName): (bigint | null)[] {
  return ds.callsOf(ME.device, route).map((c) => c.from);
}

function cursorOf(groupId: Uint8Array): readonly [bigint, bigint] | undefined {
  return ds.cursors.get(`${toHex(ME.device)}/${toHex(groupId)}`);
}

const COMMIT_CALLS = ['commitBuild', 'commitAbort', 'commitConfirm', 'groupApply'] as const;

describe('constants and the through bound', () => {
  it('fixes the sync constants', () => {
    expect(SYNC).toEqual({
      handshakePage: 512, messagePage: 256, commitRetryMax: 5, commitJitterMs: 400, membershipWaitMs: 2000, echoWaitMs: 5000,
      registerRetryMax: 3, cursorDebounceMs: 30000,
    });
  });

  // [name, message page (256), handshake page (512), carry, through]
  const cases: [string, PageInfo, PageInfo, bigint | null, bigint][] = [
    ['both short, only messages', { count: 1, lastSeq: 10n }, { count: 0, lastSeq: null }, null, 10n],
    ['both short, only a handshake, first round', { count: 0, lastSeq: null }, { count: 1, lastSeq: 11n }, null, 0n],
    ['both short, only a handshake, carried', { count: 0, lastSeq: null }, { count: 1, lastSeq: 11n }, 11n, 11n],
    ['both short, handshake above the messages', { count: 3, lastSeq: 10n }, { count: 1, lastSeq: 12n }, null, 10n],
    ['both short, carried up to the handshake', { count: 1, lastSeq: 11n }, { count: 1, lastSeq: 12n }, 12n, 12n],
    ['messages full, handshakes short', { count: 256, lastSeq: 300n }, { count: 1, lastSeq: 5n }, null, 300n],
    ['messages short, handshakes full', { count: 40, lastSeq: 40n }, { count: 512, lastSeq: 600n }, null, 40n],
    ['both full', { count: 256, lastSeq: 300n }, { count: 512, lastSeq: 600n }, null, 300n],
    ['nothing', { count: 0, lastSeq: null }, { count: 0, lastSeq: null }, null, 0n],
  ];
  it.each(cases)('%s', (_name, ms, hs, carry, want) => {
    expect(throughOf(ms, hs, carry)).toBe(want);
  });
});

describe('catch-up on every ready (rule 2)', () => {
  it('applies a commit before the messages of the epoch it opens when only the message page is full', async () => {
    const d = device(ds, clock, ME);
    const g = await openRegistered(ds, d);
    ds.detach(ME.device);
    for (let i = 0; i < 200; i++) ds.peerSend(g, PEER, `a${String(i)}`); // seq 1..200, epoch 0
    expect(ds.peerCommit(g, PEER)).toBe(201n); // epoch 0 -> 1
    for (let i = 0; i < 100; i++) ds.peerSend(g, PEER, `b${String(i)}`); // seq 202..301, epoch 1
    d.gateway.ready(readyInfo(ME));
    await settle();
    // Round 1 (from 1): messages full, m = 257 → boundM 257; handshakes short, h = 201 → boundH max(201, 257) = 257;
    //   through 257, carry 201. Round 2 (from 258): m = 301 short → boundM max(301, 201) = 301; h null → boundH 301;
    //   through 301; neither page full and no handshake above 301 → done.
    expect(d.core.applyCalls.map((c) => c.through)).toEqual([257n, 301n]);
    expect(fromArgs('getHandshakes')).toEqual([1n, 258n]);
    expect(fromArgs('getMessages')).toEqual([1n, 258n]);
    expect(d.core.bodies(g)).toEqual([
      ...Array.from({ length: 200 }, (_, i) => `a${String(i)}`),
      ...Array.from({ length: 100 }, (_, i) => `b${String(i)}`),
    ]);
    expect(d.core.unreadable(g)).toEqual([]);
    expect(d.core.group(g)).toMatchObject({ state: 2, epoch: 1n, nextSeq: 302n });
    expect(cursorOf(g)).toEqual([301n, 1n]);
  });

  it('takes the lower lastSeq when both pages are full, so no handshake is skipped', async () => {
    const d = device(ds, clock, ME);
    const g = await openRegistered(ds, d);
    ds.detach(ME.device);
    for (let i = 0; i < 520; i++) ds.propose(g, 'add', idOf(0xaa, i + 1)); // seq 1..520
    for (let i = 0; i < 260; i++) ds.peerSend(g, PEER, `m${String(i)}`); // seq 521..780
    d.gateway.ready(readyInfo(ME));
    await settle();
    // Round 1 (from 1): messages full, m = 776; handshakes full, h = 512 → through min(776, 512) = 512, carry 512.
    // Round 2 (from 513): messages full, m = 776; handshakes short, h = 520 → boundH max(520, 776) = 776 → through 776,
    //   carry 520. Round 3 (from 777): m = 780 short → boundM max(780, 520) = 780; h null → boundH 780 → through 780.
    expect(d.core.applyCalls.map((c) => c.through)).toEqual([512n, 776n, 780n]);
    expect(fromArgs('getHandshakes')).toEqual([1n, 513n, 777n]);
    expect(d.core.group(g)?.proposalsPending).toBe(520);
    expect(d.core.bodies(g)).toHaveLength(260);
    expect(d.core.group(g)?.nextSeq).toBe(781n);
  });

  it('a message stored between the two reads, below a later commit, is not skipped', async () => {
    const d = device(ds, clock, ME);
    const g = await openRegistered(ds, d);
    for (let i = 0; i < 10; i++) ds.peerSend(g, PEER, `live${String(i)}`); // seq 1..10, applied live
    await settle();
    expect(d.core.group(g)).toMatchObject({ state: 2, epoch: 0n, nextSeq: 11n });
    ds.resetCalls();
    ds.afterNextMessagesRead(g, () => {
      ds.peerSend(g, PEER, 'between'); // seq 11, epoch 0: stored after the message read
      ds.peerCommit(g, PEER); // seq 12: a self-update, epoch 0 -> 1, seen by the handshake read
    });
    d.gateway.ready(readyInfo(ME));
    await settle();
    // Round 1: m null, h 12, carry null → through 0, nothing applied, carry 12; h 12 > 0 → round 2:
    // m 11, h 12 → boundM max(11, 12) = 12, boundH max(12, 11) = 12 → through 12.
    expect(d.core.timeline(g, 0n, 200).find((r) => r.seq === 11n)).toMatchObject({ seq: 11n, status: 0, body: 'between' });
    expect(d.core.group(g)).toMatchObject({ state: 2, epoch: 1n, nextSeq: 13n });
    expect(count('getMessages')).toBe(2);
    expect(count('getHandshakes')).toBe(2);
  });

  it('a commit stored between the two reads is applied before the message of its epoch', async () => {
    const d = device(ds, clock, ME);
    const g = await openRegistered(ds, d);
    for (let i = 0; i < 10; i++) ds.peerSend(g, PEER, `live${String(i)}`); // seq 1..10, applied live
    await settle();
    expect(d.core.group(g)).toMatchObject({ state: 2, epoch: 0n, nextSeq: 11n });
    d.core.resetLog();
    ds.resetCalls();
    ds.afterNextMessagesRead(g, () => {
      ds.peerCommit(g, PEER); // seq 11: epoch 0 -> 1
      ds.peerSend(g, PEER, 'new epoch'); // seq 12, framed in epoch 1
    });
    d.gateway.ready(readyInfo(ME));
    await settle();
    // Round 1: m null, h 11 → through 0: no groupApply. Round 2: m 12, h 11, carry 11 → through 12.
    expect(d.core.applyCalls).toEqual([{ g: toHex(g), through: 12n, handshakes: 1, messages: 1 }]);
    expect(d.core.timeline(g, 0n, 200).find((r) => r.seq === 12n)).toMatchObject({ seq: 12n, status: 0, body: 'new epoch' });
    expect(d.core.group(g)).toMatchObject({ state: 2, epoch: 1n, nextSeq: 13n });
    expect(count('getMessages')).toBe(2);
    expect(count('getHandshakes')).toBe(2);
  });

  it('acknowledges the cursor after a catch-up and only when something new was applied', async () => {
    const d = device(ds, clock, ME);
    const g = await openRegistered(ds, d);
    ds.detach(ME.device);
    ds.peerSend(g, PEER, 'x');
    ds.peerSend(g, PEER, 'y');
    ds.peerSend(g, PEER, 'z');
    d.gateway.ready(readyInfo(ME));
    await settle();
    expect(cursorOf(g)).toEqual([3n, 0n]);
    expect(count('postCursor')).toBe(1);
    const routes = ds.calls.filter((c) => c.dev === toHex(ME.device)).map((c) => c.route);
    expect(routes.lastIndexOf('getMessages')).toBeLessThan(routes.lastIndexOf('postCursor'));
    d.gateway.ready(readyInfo(ME));
    await settle();
    expect(count('postCursor')).toBe(1);
    ds.peerSend(g, PEER, 'w');
    d.gateway.ready(readyInfo(ME));
    await settle();
    expect(cursorOf(g)).toEqual([4n, 0n]);
    expect(count('postCursor')).toBe(2);
    expect(d.core.cursorBody(g)).toBeNull();
  });

  it('polls Welcomes first, joins by a waiting Welcome, deletes it and catches the new group up', async () => {
    const d = device(ds, clock, ME);
    const w = ds.peerCreate(PEER, CHANNEL_2);
    ds.detach(ME.device);
    ds.peerCommit(w, PEER, [ME.device]); // seq 1, epoch 1, a Welcome for ME
    ds.peerSend(w, PEER, 'after'); // seq 2, epoch 1
    d.engine.setChannels([{ groupId: w, communityId: COMMUNITY, channelId: CHANNEL_2, policyVersion: 1n }]);
    ds.resetCalls();
    d.gateway.ready(readyInfo(ME));
    await settle();
    expect(at(ds.calls.filter((c) => c.dev === toHex(ME.device)), 0).route).toBe('getWelcomes');
    expect(d.core.group(w)).toMatchObject({ state: 2, epoch: 1n, nextSeq: 3n });
    expect(ds.welcomesFor(ME.device)).toEqual([]);
    expect(count('deleteWelcome')).toBe(1);
    expect(count('postResync')).toBe(0);
    expect(d.core.bodies(w)).toEqual(['after']);
  });
});

describe('live frames (rule 3)', () => {
  it('applies the next frame with through = seq and drops a frame it already applied', async () => {
    const d = device(ds, clock, ME);
    const g = await openRegistered(ds, d);
    const s = ds.peerSend(g, PEER, 'live');
    await settle();
    expect(s).toBe(1n);
    expect(d.core.applyCalls).toEqual([{ g: toHex(g), through: 1n, handshakes: 0, messages: 1 }]);
    expect(d.core.bodies(g)).toEqual(['live']);
    expect(count('getMessages')).toBe(0);
    d.gateway.frame(at(d.gateway.frames, d.gateway.frames.length - 1));
    await settle();
    expect(d.core.applyCalls).toHaveLength(1);
  });

  it('catches up over HTTP when a frame arrives ahead of next_seq, instead of applying it', async () => {
    const d = device(ds, clock, ME);
    const g = await openRegistered(ds, d);
    ds.dropNext(ME.device, 2);
    ds.peerSend(g, PEER, 'one');
    ds.peerSend(g, PEER, 'two');
    ds.peerSend(g, PEER, 'three');
    await settle();
    expect(d.core.bodies(g)).toEqual(['one', 'two', 'three']);
    expect(fromArgs('getMessages')).toEqual([1n]);
    expect(d.core.applyCalls).toEqual([{ g: toHex(g), through: 3n, handshakes: 0, messages: 3 }]);
    expect(cursorOf(g)).toEqual([3n, 0n]);
  });

  it('ignores op 18 and frames of unknown groups, and catches up after a malformed frame', async () => {
    const d = device(ds, clock, ME);
    const g = await openRegistered(ds, d);
    d.gateway.frame({ op: 18, n: 51n, groupId: g, payload: [1n, 1n] });
    d.gateway.frame({ op: 19, n: 52n, groupId: idOf(0x99, 9), payload: [1n, 0n, PEER.device, new Uint8Array([1]), new Uint8Array(32), 1n] });
    await settle();
    expect(d.core.calls).toEqual([]);
    expect(ds.calls).toEqual([]);
    d.gateway.frame({ op: 19, n: 53n, groupId: g, payload: [1n] });
    await settle();
    expect(d.core.applyCalls).toEqual([]);
    expect(count('getHandshakes')).toBe(1);
  });

  it('holds back the frames of a group while its queue is busy, but not those of another group', async () => {
    const d = device(ds, clock, ME);
    const g1 = await openRegistered(ds, d, CHANNEL);
    const g2 = await openRegistered(ds, d, CHANNEL_2);
    const gate = deferred();
    ds.inject('postMessage', { gate: gate.promise });
    d.engine.send(g1, 'mine');
    await settle();
    ds.peerSend(g1, PEER, 'held back');
    ds.peerSend(g2, PEER, 'not held');
    await settle();
    expect(d.core.bodies(g2)).toEqual(['not held']);
    expect(d.core.bodies(g1)).toEqual([]);
    gate.resolve();
    await settle();
    expect(d.core.bodies(g1)).toEqual(['held back', 'mine']);
    expect(coreCalls(d, g1, ['sendEncrypt', 'sendConfirm', 'groupApply']).slice(0, 3)).toEqual(['sendEncrypt', 'sendConfirm', 'groupApply']);
  });

  it('stop() unsubscribes, clears its timers and refuses to send', async () => {
    const d = device(ds, clock, ME);
    const g = await openRegistered(ds, d);
    ds.propose(g, 'add', THIRD.device);
    await settle();
    expect(clock.pending).toBe(2); // the volunteer timer and the cursor timer of the live frame
    d.engine.stop();
    expect(clock.pending).toBe(0);
    expect(d.gateway.listenerCount).toBe(0);
    ds.peerSend(g, PEER, 'late');
    await clock.advance(10_000);
    expect(d.core.bodies(g)).toEqual([]);
    expect(count('postCommit')).toBe(0);
    expect(catchSync(() => d.engine.send(g, 'after stop'))).toMatchObject({ code: 'E_SYNC_STOPPED' });
    await expect(d.engine.openChannel({ communityId: COMMUNITY, channelId: CHANNEL_2, textGroupId: null })).rejects.toMatchObject({
      code: 'E_SYNC_STOPPED',
    });
  });

  it('a deleted frame clears a stored message', async () => {
    const d = device(ds, clock, ME);
    const g = await openRegistered(ds, d);
    const s = ds.peerSend(g, PEER, 'soon gone');
    await settle();
    expect(d.core.timeline(g, 0n, 200)).toMatchObject([{ seq: s, status: 0, body: 'soon gone' }]);
    const before = d.changes.length;
    d.gateway.frame({ op: 21, n: 90n, groupId: g, payload: [s, 1_700_000_000n] });
    await settle();
    expect(d.core.timeline(g, 0n, 200)).toMatchObject([{ seq: s, status: 2, body: '' }]);
    expect(d.changes).toHaveLength(before + 1);
    expect(at(d.changes, before)).toMatchObject({ group: toHex(g), result: { newSeqs: [s], epochChanged: false, ownAdopted: false } });
  });

  it('a deleted frame for a seq this device does not hold changes nothing', async () => {
    const d = device(ds, clock, ME);
    const g = await openRegistered(ds, d);
    ds.peerSend(g, PEER, 'kept'); // seq 1
    await settle();
    const before = d.changes.length;
    d.gateway.frame({ op: 21, n: 91n, groupId: g, payload: [99n, 1_700_000_000n] });
    d.gateway.frame({ op: 21, n: 92n, groupId: g, payload: [1n] }); // malformed: dropped before the core
    await settle();
    expect(coreCalls(d, g, ['messageDeleted'])).toEqual(['messageDeleted']);
    expect(d.changes).toHaveLength(before);
    expect(d.core.bodies(g)).toEqual(['kept']);
  });

  it('posts the cursor once, cursorDebounceMs after the first live frame, and not per frame', async () => {
    const d = device(ds, clock, ME);
    const g = await openRegistered(ds, d);
    for (let i = 0; i < 3; i++) {
      ds.peerSend(g, PEER, `f${String(i)}`); // seq 1..3, three live frames within one second
      await clock.advance(400);
    }
    expect(d.core.bodies(g)).toEqual(['f0', 'f1', 'f2']);
    expect(count('postCursor')).toBe(0);
    await clock.advance(SYNC.cursorDebounceMs);
    expect(count('postCursor')).toBe(1);
    expect(cursorOf(g)).toEqual([3n, 0n]);
    expect(coreCalls(d, g, ['cursorBody', 'cursorAcked'])).toEqual(['cursorBody', 'cursorAcked']);
    await clock.advance(60_000);
    expect(count('postCursor')).toBe(1);
  });

  it('a ready before the cursor timer fires posts the cursor through the catch-up and cancels the timer', async () => {
    const d = device(ds, clock, ME);
    const g = await openRegistered(ds, d);
    ds.peerSend(g, PEER, 'one'); // seq 1, applied live: the cursor timer is armed
    await settle();
    expect(clock.pending).toBe(1);
    d.gateway.ready(readyInfo(ME));
    await settle();
    expect(count('postCursor')).toBe(1);
    expect(cursorOf(g)).toEqual([1n, 0n]);
    expect(clock.pending).toBe(0);
    await clock.advance(60_000);
    expect(count('postCursor')).toBe(1);
  });
});

describe('commit duty (rule 4)', () => {
  it('acknowledges commit_needed at once, commits once and cancels the volunteer timer', async () => {
    const d = device(ds, clock, ME);
    const g = await openRegistered(ds, d);
    ds.propose(g, 'add', THIRD.device);
    await settle();
    expect(d.core.group(g)?.proposalsPending).toBe(1);
    ds.elect(g, ME.device, 7n);
    expect(d.gateway.acks).toEqual([{ group: toHex(g), round: 7n }]);
    await settle();
    expect(count('postCommit')).toBe(1);
    expect(ds.view(g).epoch).toBe(1n);
    expect(d.core.group(g)).toMatchObject({ state: 2, epoch: 1n, proposalsPending: 0, pendingCommit: false });
    expect(ds.welcomesFor(THIRD.device)).toHaveLength(1);
    await clock.advance(10_000);
    expect(count('postCommit')).toBe(1);
  });

  it('volunteers after backoff_ms + random() x jitter when a ready reports outstanding proposals', async () => {
    const d = device(ds, clock, ME);
    const g = await openRegistered(ds, d);
    ds.detach(ME.device);
    ds.propose(g, 'add', THIRD.device);
    ds.reattach(ME.device);
    d.gateway.ready(readyInfo(ME, [{ groupId: g, epoch: 0n, lastSeq: 0n, proposalsOutstanding: 1 }]));
    await settle();
    expect(d.core.group(g)?.proposalsPending).toBe(1);
    await clock.advance(449);
    expect(count('postCommit')).toBe(0);
    await clock.advance(1);
    expect(count('postCommit')).toBe(1);
    expect(ds.view(g).epoch).toBe(1n);
    expect(d.gateway.acks).toEqual([]);
  });

  it('does not volunteer when commit_needed arrives inside the back-off window', async () => {
    const d = device(ds, clock, ME);
    const g = await openRegistered(ds, d);
    ds.detach(ME.device);
    ds.propose(g, 'add', THIRD.device);
    ds.reattach(ME.device);
    d.gateway.ready(readyInfo(ME, [{ groupId: g, epoch: 0n, lastSeq: 0n, proposalsOutstanding: 1 }]));
    await settle();
    await clock.advance(200);
    ds.elect(g, ME.device, 1n);
    await settle();
    expect(count('postCommit')).toBe(1);
    await clock.advance(5_000);
    expect(count('postCommit')).toBe(1);
  });

  it('on a lost commit race aborts first, catches up, and commits again after random() x commitJitterMs', async () => {
    const d = device(ds, clock, ME);
    const g = await openRegistered(ds, d);
    ds.propose(g, 'add', THIRD.device); // seq 1
    await settle();
    d.core.resetLog();
    ds.inject('postCommit', {
      before: () => {
        ds.peerCommit(g, PEER); // seq 2: the winner, epoch 0 -> 1
        ds.propose(g, 'add', FOURTH.device); // seq 3, epoch 1
      },
    });
    ds.elect(g, ME.device, 1n);
    await settle();
    expect(count('postCommit')).toBe(1);
    expect(coreCalls(d, g, COMMIT_CALLS)).toEqual(['commitBuild', 'commitAbort', 'groupApply']);
    expect(d.core.group(g)).toMatchObject({ epoch: 1n, proposalsPending: 1, pendingCommit: false });
    await clock.advance(199);
    expect(count('postCommit')).toBe(1);
    await clock.advance(1);
    expect(count('postCommit')).toBe(2);
    expect(coreCalls(d, g, COMMIT_CALLS)).toEqual(['commitBuild', 'commitAbort', 'groupApply', 'commitBuild', 'commitConfirm', 'groupApply']);
    expect(ds.view(g).commits).toEqual([
      { seq: 2n, kind: 1, committer: toHex(PEER.device) },
      { seq: 4n, kind: 1, committer: toHex(ME.device) },
    ]);
    expect(d.core.group(g)).toMatchObject({ epoch: 2n, proposalsPending: 0, pendingCommit: false });
  });

  it('gives up after commitRetryMax retries and stays quiet until the next ready', async () => {
    const d = device(ds, clock, ME);
    const g = await openRegistered(ds, d);
    ds.propose(g, 'add', THIRD.device);
    await settle();
    for (let i = 0; i < 7; i++) {
      ds.inject('postCommit', {
        before: () => {
          ds.peerCommit(g, PEER);
          ds.propose(g, 'add', idOf(0xbb, i + 1));
        },
      });
    }
    ds.elect(g, ME.device, 1n);
    await settle();
    for (let i = 0; i < SYNC.commitRetryMax; i++) await clock.advance(200);
    expect(count('postCommit')).toBe(1 + SYNC.commitRetryMax);
    await clock.advance(10_000);
    expect(count('postCommit')).toBe(1 + SYNC.commitRetryMax);
    expect(d.core.group(g)?.pendingCommit).toBe(false);
  });

  const failures: [number, string, boolean][] = [
    [425, 'E_COMMIT_REQUIRED', true],
    [422, 'E_COMMIT_INVALID', true],
    [500, 'E_INTERNAL', false],
    [0, 'E_NETWORK', false],
  ];
  it.each(failures)('aborts the pending commit on %i %s (catch-up: %s)', async (status, code, catchesUp) => {
    const d = device(ds, clock, ME);
    const g = await openRegistered(ds, d);
    ds.propose(g, 'add', THIRD.device);
    await settle();
    d.core.resetLog();
    ds.resetCalls();
    ds.inject('postCommit', { fail: httpError(status, code) });
    ds.elect(g, ME.device, 1n);
    await settle();
    expect(coreCalls(d, g, COMMIT_CALLS).slice(0, 2)).toEqual(['commitBuild', 'commitAbort']);
    expect(d.core.group(g)?.pendingCommit).toBe(false);
    expect(count('getHandshakes')).toBe(catchesUp ? 1 : 0);
    expect(ds.view(g).epoch).toBe(0n);
  });

  it('a 422 refuses the commit for good: the group is commit-quiet until op 17 asks again', async () => {
    const d = device(ds, clock, ME);
    const g = await openRegistered(ds, d);
    ds.propose(g, 'add', THIRD.device);
    await settle();
    ds.inject('postCommit', { fail: httpError(422, 'E_COMMIT_INVALID') }); // e.g. rule group_info (hardening G)
    ds.elect(g, ME.device, 1n);
    await settle();
    expect(count('postCommit')).toBe(1);
    ds.propose(g, 'add', FOURTH.device); // applied live with proposals pending: no volunteer while quiet
    await settle();
    await clock.advance(10_000);
    expect(count('postCommit')).toBe(1);
    ds.elect(g, ME.device, 2n);
    await settle();
    expect(count('postCommit')).toBe(2);
    expect(ds.view(g).epoch).toBe(1n);
  });

  it('answers 403 E_LEAF_NOT_CURRENT on a commit with a resync', async () => {
    const d = device(ds, clock, ME);
    const g = await openRegistered(ds, d);
    ds.propose(g, 'add', THIRD.device);
    await settle();
    ds.evict(g, ME.device);
    ds.elect(g, ME.device, 1n);
    await settle();
    expect(coreCalls(d, g, COMMIT_CALLS).slice(-2)).toEqual(['commitBuild', 'commitAbort']);
    expect(d.membership).toEqual([{ group: toHex(g), status: 'resyncing' }]);
    expect(count('postResync')).toBe(1);
    expect(d.core.group(g)).toMatchObject({ state: 2, epoch: 1n });
  });
});

describe('resync (rule 7)', () => {
  it('resyncs a group whose commit cannot be processed and keeps receiving', async () => {
    const d = device(ds, clock, ME);
    const g = await openRegistered(ds, d);
    ds.garbageCommit(g); // seq 1, epoch 0 -> 1
    await settle();
    expect(d.membership).toEqual([{ group: toHex(g), status: 'resyncing' }]);
    expect(count('postResync')).toBe(1);
    expect(d.core.group(g)).toMatchObject({ state: 2, epoch: 2n, nextSeq: 3n });
    ds.peerSend(g, PEER, 'after resync');
    await settle();
    expect(d.core.bodies(g)).toEqual(['after resync']);
  });

  it('leaves a refused group in state 3, reports not-member, and tries again on the next ready', async () => {
    const d = device(ds, clock, ME);
    const g = await openRegistered(ds, d);
    ds.denyJoin.add(toHex(ME.device));
    ds.garbageCommit(g);
    await settle();
    expect(d.core.group(g)?.state).toBe(3);
    expect(d.membership).toEqual([
      { group: toHex(g), status: 'resyncing' },
      { group: toHex(g), status: 'not-member' },
    ]);
    expect(count('postResync')).toBe(1);
    expect(at(d.changes, d.changes.length - 1).result.state).toBe(3);
    ds.denyJoin.clear();
    d.gateway.ready(readyInfo(ME));
    await settle();
    expect(count('postResync')).toBe(2);
    expect(d.core.group(g)?.state).toBe(2);
  });

  it('resyncs a group whose history below next_seq was pruned (410 E_PRUNED)', async () => {
    const d = device(ds, clock, ME);
    const g = await openRegistered(ds, d);
    ds.detach(ME.device);
    for (let i = 0; i < 6; i++) ds.peerSend(g, PEER, `old${String(i)}`);
    ds.prune(g, 5n);
    ds.reattach(ME.device);
    d.gateway.ready(readyInfo(ME));
    await settle();
    expect(d.membership).toEqual([{ group: toHex(g), status: 'resyncing' }]);
    expect(count('postResync')).toBe(1);
    expect(d.core.group(g)).toMatchObject({ state: 2, epoch: 1n, nextSeq: 8n });
    expect(d.core.bodies(g)).toEqual([]);
  });
});

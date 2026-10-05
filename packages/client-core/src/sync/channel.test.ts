import { beforeEach, describe, expect, it } from 'vitest';
import type { Id } from '../core-port';
import { toHex } from '../hex';
import { SYNC, SyncError } from './engine';
import { coreCalls, device, readyInfo, type Device } from './testing/harness';
import { CHANNEL, COMMUNITY, ME, ManualClock, ModelDs, PEER, at, deferred, httpError, idOf, settle, type RouteName } from './testing/model';

let ds: ModelDs;
let clock: ManualClock;
let d: Device;

beforeEach(() => {
  ds = new ModelDs();
  clock = new ManualClock();
  ds.addChannel(COMMUNITY, CHANNEL);
  d = device(ds, clock, ME);
});

const open = (textGroupId: Id | null): Promise<{ groupId: Id; state: 0 | 1 | 2 | 3 | 4 }> =>
  d.engine.openChannel({ communityId: COMMUNITY, channelId: CHANNEL, textGroupId });
const count = (route: RouteName): number => ds.callsOf(ME.device, route).length;

describe('opening a channel (rule 6)', () => {
  it('registers a group for a channel that has none', async () => {
    const r = await open(null);
    expect(r.state).toBe(2);
    expect(ds.view(r.groupId).members).toEqual([toHex(ME.device)]);
    const rows = await ds.routesFor(PEER.device).listChannels(COMMUNITY);
    expect(rows.find((c) => toHex(c.id) === toHex(CHANNEL))?.textGroupId).toEqual(r.groupId);
    expect(d.core.group(r.groupId)).toMatchObject({ state: 2, epoch: 0n, nextSeq: 1n });
    expect(at(d.changes, d.changes.length - 1).result.state).toBe(2);
    expect(count('getWelcomes')).toBe(0);
    expect(count('postResync')).toBe(0);
  });

  it('loses a registration race, discards its own group and joins the winner', async () => {
    const winners: Id[] = [];
    ds.inject('postGroup', {
      before: () => {
        winners.push(ds.peerCreate(PEER, CHANNEL));
      },
    });
    const r = await open(null);
    const winner = at(winners, 0);
    expect(r).toEqual({ groupId: winner, state: 2 });
    expect(d.core.groups().map((x) => toHex(x.groupId))).toEqual([toHex(winner)]);
    expect(count('postGroup')).toBe(1);
    expect(count('listChannels')).toBe(1);
    expect(count('postResync')).toBe(1);
    expect(ds.view(winner).members).toContain(toHex(ME.device));
  });

  it('gives up with E_REGISTER_RACE after registerRetryMax registrations', async () => {
    for (let i = 0; i < SYNC.registerRetryMax + 1; i++) ds.inject('postGroup', { fail: httpError(409, 'E_GROUP_EXISTS') });
    const err: unknown = await open(null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncError);
    expect(err).toMatchObject({ code: 'E_REGISTER_RACE' });
    expect(count('postGroup')).toBe(SYNC.registerRetryMax);
    expect(count('listChannels')).toBe(SYNC.registerRetryMax);
    expect(d.core.groups()).toEqual([]);
  });

  it('propagates a refused registration (400 E_INVALID_REQUEST) once and leaves no group', async () => {
    // The answer to a registration that is not this device's one leaf, or before its device list is published (hardening G).
    ds.inject('postGroup', { fail: httpError(400, 'E_INVALID_REQUEST') });
    const err: unknown = await open(null).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400, code: 'E_INVALID_REQUEST' });
    expect(count('postGroup')).toBe(1);
    expect(count('listChannels')).toBe(0);
    expect(d.core.groups()).toEqual([]);
    await clock.advance(60_000);
    expect(count('postGroup')).toBe(1);
  });

  it('adopts a waiting Welcome instead of joining by external commit', async () => {
    const pg = ds.peerCreate(PEER, CHANNEL);
    ds.detach(ME.device);
    ds.peerCommit(pg, PEER, [ME.device]); // seq 1, a Welcome for ME
    ds.peerSend(pg, PEER, 'after welcome'); // seq 2
    ds.reattach(ME.device);
    const r = await open(pg);
    expect(r).toEqual({ groupId: pg, state: 2 });
    await settle();
    expect(count('postResync')).toBe(0);
    expect(count('deleteWelcome')).toBe(1);
    expect(ds.welcomesFor(ME.device)).toEqual([]);
    expect(d.core.bodies(pg)).toEqual(['after welcome']);
  });

  it('joins by external commit, applies the frames that arrived during the join, then catches up', async () => {
    const pg = ds.peerCreate(PEER, CHANNEL);
    ds.peerSend(pg, PEER, 'before'); // seq 1, before this device was a member
    ds.inject('postResync', {
      after: () => {
        ds.peerSend(pg, PEER, 'during'); // seq 3, fanned out before the 200 is read
      },
    });
    const r = await open(pg);
    expect(r).toEqual({ groupId: pg, state: 2 });
    await settle();
    expect(count('getWelcomes')).toBe(1);
    expect(count('postResync')).toBe(1);
    expect(at(d.core.applyCalls, 0)).toEqual({ g: toHex(pg), through: 3n, handshakes: 0, messages: 1 });
    expect(ds.callsOf(ME.device, 'getMessages').map((c) => c.from)).toEqual([4n]);
    expect(d.core.bodies(pg)).toEqual(['during']);
    expect(d.core.group(pg)).toMatchObject({ state: 2, epoch: 1n, nextSeq: 4n });
  });

  it('propagates a refused external join and leaves no local group', async () => {
    const pg = ds.peerCreate(PEER, CHANNEL);
    ds.denyJoin.add(toHex(ME.device));
    const err: unknown = await open(pg).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 403, code: 'E_FORBIDDEN' });
    expect(d.core.groups()).toEqual([]);
    expect(d.membership).toEqual([]);
  });

  it('keeps an accepted external join when stopped during postResync', async () => {
    const pg = ds.peerCreate(PEER, CHANNEL);
    const gate = deferred();
    ds.inject('postResync', { gate: gate.promise });
    const opening = open(pg).catch((e: unknown) => e);
    await settle();
    expect(count('postResync')).toBe(1);
    d.engine.stop();
    gate.resolve();
    await opening;
    expect(coreCalls(d, pg, ['groupDiscard'])).toEqual([]);
    expect(d.core.group(pg)?.state).toBe(2);
    expect(ds.view(pg).members).toContain(toHex(ME.device));
  });

  it('keeps an accepted registration when stopped during postGroup', async () => {
    const gate = deferred();
    ds.inject('postGroup', { gate: gate.promise });
    const opening = open(null).catch((e: unknown) => e);
    await settle();
    expect(count('postGroup')).toBe(1);
    d.engine.stop();
    gate.resolve();
    const result = await opening;
    expect(d.core.calls.filter((c) => c.m === 'groupDiscard')).toEqual([]);
    expect(result).toMatchObject({ state: 2 });
    expect(d.core.groups()).toMatchObject([{ state: 2 }]);
  });

  it('waits and starts again from the Welcome step when the join meets the 425 freeze', async () => {
    const pg = ds.peerCreate(PEER, CHANNEL);
    ds.inject('postResync', { fail: httpError(425, 'E_COMMIT_REQUIRED', 2000) });
    const opening = open(pg);
    await settle();
    expect(count('postResync')).toBe(1);
    expect(d.core.groups()).toEqual([]);
    ds.detach(ME.device);
    ds.peerCommit(pg, PEER, [ME.device]); // a member commits the Add: the Welcome waits on the server
    ds.reattach(ME.device);
    await clock.advance(SYNC.membershipWaitMs);
    expect(await opening).toEqual({ groupId: pg, state: 2 });
    expect(count('postResync')).toBe(1);
    expect(count('getWelcomes')).toBe(2);
    expect(ds.welcomesFor(ME.device)).toEqual([]);
  });

  it('starts the join again at once when it raced a commit (409 E_COMMIT_CONFLICT)', async () => {
    const pg = ds.peerCreate(PEER, CHANNEL);
    ds.inject('postResync', { fail: httpError(409, 'E_COMMIT_CONFLICT') });
    expect(await open(pg)).toEqual({ groupId: pg, state: 2 });
    expect(count('getWelcomes')).toBe(2);
    expect(count('getGroupInfo')).toBe(2);
    expect(count('getGroupTree')).toBe(2);
    expect(count('postResync')).toBe(2);
    expect(coreCalls(d, pg, ['groupDiscard'])).toEqual(['groupDiscard']);
    expect(ds.view(pg).members).toContain(toHex(ME.device));
  });

  it('re-reads info and tree when a commit lands between the two join reads', async () => {
    const pg = ds.peerCreate(PEER, CHANNEL);
    ds.inject('getGroupTree', { before: () => { ds.peerCommit(pg, PEER); } });
    expect(await open(pg)).toEqual({ groupId: pg, state: 2 });
    expect(count('getGroupInfo')).toBe(2);
    expect(count('getGroupTree')).toBe(2);
    expect(count('postResync')).toBe(1);
    expect(d.core.group(pg)).toMatchObject({ state: 2, epoch: 2n });
  });

  it('gives up after commitRetryMax joins that each raced a commit', async () => {
    const pg = ds.peerCreate(PEER, CHANNEL);
    for (let i = 0; i < SYNC.commitRetryMax + 1; i++) ds.inject('postResync', { fail: httpError(409, 'E_COMMIT_CONFLICT') });
    const err: unknown = await open(pg).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, code: 'E_COMMIT_CONFLICT' });
    expect(count('postResync')).toBe(SYNC.commitRetryMax);
    expect(coreCalls(d, pg, ['groupDiscard'])).toHaveLength(SYNC.commitRetryMax);
    expect(d.core.groups()).toEqual([]);
  });

  it('a Welcome is kept while the join is in flight', async () => {
    const pg = ds.peerCreate(PEER, CHANNEL);
    const gate = deferred();
    ds.inject('postResync', { gate: gate.promise });
    const opening = open(pg).catch((e: unknown) => e);
    await settle();
    expect(count('postResync')).toBe(1);
    expect(d.core.group(pg)?.state).toBe(1);
    ds.peerCommit(pg, PEER, [ME.device]); // seq 1, epoch 0 -> 1: a Welcome for ME, fanned out as op 20
    await settle();
    expect(d.gateway.frames.filter((f) => f.op === 20)).toHaveLength(1);
    expect(count('deleteWelcome')).toBe(0);
    expect(ds.welcomesFor(ME.device)).toHaveLength(1);
    ds.denyJoin.add(toHex(ME.device));
    gate.resolve();
    expect(await opening).toMatchObject({ status: 403, code: 'E_FORBIDDEN' });
    expect(coreCalls(d, pg, ['groupDiscard'])).toEqual(['groupDiscard']);
    expect(d.core.group(pg)).toBeUndefined();
    d.gateway.ready(readyInfo(ME));
    await settle();
    expect(d.core.group(pg)).toMatchObject({ state: 2, epoch: 1n, nextSeq: 2n });
    expect(count('deleteWelcome')).toBe(1);
    expect(ds.welcomesFor(ME.device)).toEqual([]);
  });

  it('returns at once, without a request, for a group that is already active', async () => {
    const first = await open(null);
    await settle();
    ds.resetCalls();
    expect(await open(first.groupId)).toEqual({ groupId: first.groupId, state: 2 });
    expect(ds.calls).toEqual([]);
  });

  it('registers once when the same channel is opened twice at the same time', async () => {
    const [a, b] = await Promise.all([open(null), open(null)]);
    expect(toHex(a.groupId)).toBe(toHex(b.groupId));
    expect(count('postGroup')).toBe(1);
  });

  it('discards a registration an earlier page never finished, then registers', async () => {
    const stale = idOf(0x77, 1);
    d.core.groupCreate(stale, COMMUNITY, CHANNEL); // ModelCore ignores policy_version and the sender key
    const r = await open(null);
    expect(r.state).toBe(2);
    expect(toHex(r.groupId)).not.toBe(toHex(stale));
    expect(d.core.groups().map((x) => toHex(x.groupId))).toEqual([toHex(r.groupId)]);
  });

  it('resyncs a group in state 3 on open, answering state 3 while refused and 2 once admitted', async () => {
    const r = await open(null);
    await settle();
    ds.join(r.groupId, PEER.device);
    ds.denyJoin.add(toHex(ME.device));
    ds.garbageCommit(r.groupId);
    await settle();
    expect(d.core.group(r.groupId)?.state).toBe(3);
    expect(await open(r.groupId)).toEqual({ groupId: r.groupId, state: 3 });
    expect(d.membership.map((m) => m.status)).toEqual(['resyncing', 'not-member', 'resyncing', 'not-member']);
    ds.denyJoin.clear();
    expect(await open(r.groupId)).toEqual({ groupId: r.groupId, state: 2 });
    d.gateway.ready(readyInfo(ME));
    await settle();
    expect(d.core.group(r.groupId)?.state).toBe(2);
  });
});

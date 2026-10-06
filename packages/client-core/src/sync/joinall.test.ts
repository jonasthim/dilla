  import { beforeEach, describe, expect, it, vi } from 'vitest';
  import { encode } from '../cbor';
  import type { ExpectedGroup, Id } from '../core-port';
  import { toHex } from '../hex';
  import { judgeWelcomes } from './channel';
  import { SYNC } from './engine';
  import { joinOrder } from './joinall';
  import { device, readyInfo, type Device } from './testing/harness';
  import { COMMUNITY, ME, ManualClock, ModelDs, PEER, at, deferred, idOf, settle, wire, type RouteName } from './testing/model';

  let ds: ModelDs;
  let clock: ManualClock;

  beforeEach(() => {
    ds = new ModelDs();
    clock = new ManualClock();
  });

  const count = (route: RouteName, group?: Id): number =>
    ds.callsOf(ME.device, route).filter((c) => group === undefined || c.group === toHex(group)).length;

  /** n channels of COMMUNITY, each with a group PEER registered, as expected rows in channel order. */
  function channels(n: number, tag = 0xc2): ExpectedGroup[] {
    const out: ExpectedGroup[] = [];
    for (let i = 1; i <= n; i++) {
      const channelId = idOf(tag, i);
      ds.addChannel(COMMUNITY, channelId);
      out.push({ groupId: ds.peerCreate(PEER, channelId), communityId: COMMUNITY, channelId, policyVersion: 1n });
    }
    return out;
  }

  const active = (d: Device, eg: readonly ExpectedGroup[]): boolean => eg.every((g) => d.core.group(g.groupId)?.state === 2);

  /** Settles until done() holds; the bound is a count of settle rounds, never a duration (lesson c). */
  async function until(done: () => boolean, rounds = 400): Promise<void> {
    for (let i = 0; i < rounds && !done(); i++) await settle();
    if (!done()) throw new Error('the condition was not reached');
  }

  describe('joinOrder', () => {
    it('puts channels before DMs and keeps the given order inside each', () => {
      const dm1 = { groupId: idOf(0x91, 1), communityId: null, channelId: idOf(0xd3, 1), policyVersion: 1n };
      const ch1 = { groupId: idOf(0x91, 2), communityId: COMMUNITY, channelId: idOf(0xc2, 1), policyVersion: 1n };
      const dm2 = { groupId: idOf(0x91, 3), communityId: null, channelId: idOf(0xd3, 2), policyVersion: 1n };
      const ch2 = { groupId: idOf(0x91, 4), communityId: COMMUNITY, channelId: idOf(0xc2, 2), policyVersion: 1n };
      expect(joinOrder([dm1, ch1, dm2, ch2])).toEqual([ch1, ch2, dm1, dm2]);
    });
  });

  describe('join-all (L-TS-22 rule 4)', () => {
    it('joins every expected group after the ready sweep, one group at a time, in order, and registers nothing', async () => {
      const d = device(ds, clock, ME);
      const eg = channels(50);
      d.engine.setExpected(eg);
      expect(ds.calls).toEqual([]);
      d.gateway.ready(readyInfo(ME));
      await until(() => active(d, eg));
      expect(count('postGroup')).toBe(0);
      expect(d.core.calls.filter((c) => c.m === 'groupCreate')).toEqual([]);
      expect(count('postResync')).toBe(50);
      expect(ds.callsOf(ME.device, 'getGroupInfo').map((c) => c.group)).toEqual(eg.map((g) => toHex(g.groupId)));
      // One at a time: a group's join and its catch-up end before the next group's first request.
      const mine = ds.calls.filter((c) => c.dev === toHex(ME.device) && c.group !== '').map((c) => c.group);
      for (let i = 1; i < eg.length; i++) {
        expect(mine.lastIndexOf(toHex(at(eg, i - 1).groupId))).toBeLessThan(mine.indexOf(toHex(at(eg, i).groupId)));
      }
      expect(d.joinAll).toHaveLength(51);
      expect(at(d.joinAll, 0)).toEqual({ done: 0, total: 50, failed: 0 });
      expect(at(d.joinAll, 50)).toEqual({ done: 50, total: 50, failed: 0 });
    });

    it('at 200 groups: at most 5 reads and exactly one commit per join, and groups() once per ready', async () => {
      const d = device(ds, clock, ME);
      const eg = channels(200);
      d.engine.setExpected(eg);
      const groups = vi.spyOn(d.core, 'groups');
      d.gateway.ready(readyInfo(ME));
      await until(() => active(d, eg), 4000);
      const readRoutes: RouteName[] = ['getWelcomes', 'getGroupInfo', 'getGroupTree', 'getMessages', 'getHandshakes', 'getProposals', 'getChannel', 'listChannels'];
      const reads = readRoutes.reduce((n, r) => n + count(r), 0);
      expect(reads).toBeLessThanOrEqual(5 * 200);
      expect([count('getGroupInfo'), count('getGroupTree'), count('getMessages'), count('getHandshakes')]).toEqual([200, 200, 200, 200]);
      expect(count('getWelcomes')).toBe(2); // the ready's Welcome step and the pass's
      expect(count('postResync')).toBe(200);
      expect(count('postCommit')).toBe(0);
      expect(count('postGroup')).toBe(0);
      expect(groups).toHaveBeenCalledTimes(1);
    }, 30_000);

    it('an open of another group during a join-all join does not wait for the pass', async () => {
      const d = device(ds, clock, ME);
      const eg = channels(3);
      const gate = deferred();
      ds.inject('getGroupInfo', { gate: gate.promise }); // the pass's first join waits here
      d.engine.setExpected(eg);
      d.gateway.ready(readyInfo(ME));
      await settle();
      expect(ds.callsOf(ME.device, 'getGroupInfo').map((c) => c.group)).toEqual([toHex(at(eg, 0).groupId)]);
      const third = at(eg, 2);
      const r = await d.engine.openChannel({ communityId: COMMUNITY, channelId: third.channelId, textGroupId: third.groupId });
      expect(r).toEqual({ groupId: third.groupId, state: 2 });
      expect(d.core.group(at(eg, 0).groupId)).toBeUndefined();
      gate.resolve();
      await until(() => active(d, eg));
      expect(count('postResync', third.groupId)).toBe(1);
      expect(count('postResync')).toBe(3);
    });

    it('an open of the same group awaits its join-all join and does not join a second time', async () => {
      const d = device(ds, clock, ME);
      const [first] = channels(1);
      if (first === undefined) throw new Error('no channel');
      const gate = deferred();
      ds.inject('getGroupInfo', { gate: gate.promise });
      d.engine.setExpected([first]);
      d.gateway.ready(readyInfo(ME));
      await settle();
      const opened = d.engine.openChannel({ communityId: COMMUNITY, channelId: first.channelId, textGroupId: first.groupId });
      await settle();
      gate.resolve();
      expect(await opened).toEqual({ groupId: first.groupId, state: 2 });
      await settle();
      expect(count('postResync')).toBe(1);
      expect(count('getGroupInfo')).toBe(1);
    });

    it('skips a group this device holds and leaves a group in state 3 to the sweep', async () => {
      const d = device(ds, clock, ME);
      const eg = channels(2);
      const [held, broken] = eg;
      if (held === undefined || broken === undefined) throw new Error('no channels');
      await d.engine.openChannel({ communityId: COMMUNITY, channelId: held.channelId, textGroupId: held.groupId });
      await d.engine.openChannel({ communityId: COMMUNITY, channelId: broken.channelId, textGroupId: broken.groupId });
      ds.denyJoin.add(toHex(ME.device));
      ds.garbageCommit(broken.groupId);
      await settle();
      expect(d.core.group(broken.groupId)?.state).toBe(3);
      ds.resetCalls();
      d.engine.setExpected(eg);
      d.gateway.ready(readyInfo(ME));
      await settle();
      await settle();
      expect(count('postResync', held.groupId)).toBe(0);
      expect(count('postResync', broken.groupId)).toBe(1); // the sweep's resync, refused; join-all does not try again
      expect(count('getGroupInfo', held.groupId)).toBe(0);
      expect(at(d.joinAll, d.joinAll.length - 1)).toEqual({ done: 2, total: 2, failed: 0 });
    });

    it('a refused join is counted and tried again on the next ready', async () => {
      const d = device(ds, clock, ME);
      const eg = channels(2);
      ds.denyJoin.add(toHex(ME.device));
      d.engine.setExpected(eg);
      d.gateway.ready(readyInfo(ME));
      await settle();
      await settle();
      expect(at(d.joinAll, d.joinAll.length - 1)).toEqual({ done: 0, total: 2, failed: 2 });
      expect(d.core.groups()).toEqual([]);
      expect(count('postResync')).toBe(2);
      ds.denyJoin.clear();
      d.gateway.ready(readyInfo(ME));
      await until(() => active(d, eg));
      expect(count('postResync')).toBe(4);
      expect(at(d.joinAll, d.joinAll.length - 1)).toEqual({ done: 2, total: 2, failed: 0 });
    });

    it('a refused join is tried again after joinAllRetryMs without a ready', async () => {
      const d = device(ds, clock, ME);
      const eg = channels(1);
      ds.denyJoin.add(toHex(ME.device));
      d.engine.setExpected(eg);
      d.gateway.ready(readyInfo(ME));
      await settle();
      await settle();
      expect(count('postResync')).toBe(1);
      ds.denyJoin.clear();
      await clock.advance(SYNC.joinAllRetryMs - 1);
      expect(count('postResync')).toBe(1);
      await clock.advance(1);
      await until(() => active(d, eg));
      expect(count('postResync')).toBe(2);
    });

    it('stop() ends the pass: no further group is started and nothing is reported', async () => {
      const d = device(ds, clock, ME);
      const eg = channels(3);
      const gate = deferred();
      ds.inject('getGroupInfo', { gate: gate.promise });
      d.engine.setExpected(eg);
      d.gateway.ready(readyInfo(ME));
      await settle();
      const reports = d.joinAll.length;
      d.engine.stop();
      gate.resolve();
      await settle();
      await settle();
      expect(count('getGroupInfo')).toBe(1);
      expect(d.joinAll).toHaveLength(reports);
      expect(clock.pending).toBe(0);
    });

    it('joins channels before DMs, and a DM with a null community', async () => {
      const d = device(ds, clock, ME);
      const eg = channels(2);
      const dmChannel = idOf(0xd3, 1);
      const dm: ExpectedGroup = { groupId: ds.peerCreate(PEER, dmChannel), communityId: null, channelId: dmChannel, policyVersion: 1n };
      d.engine.setExpected([dm, ...eg]);
      d.gateway.ready(readyInfo(ME));
      await until(() => active(d, [dm, ...eg]));
      expect(ds.callsOf(ME.device, 'getGroupInfo').map((c) => c.group)).toEqual([...eg, dm].map((g) => toHex(g.groupId)));
      expect(d.core.group(dm.groupId)).toMatchObject({ state: 2, communityId: null, targetId: dmChannel });
    });

    it('joins a DM by the Welcome that waits for it, before any external join', async () => {
      const d = device(ds, clock, ME);
      const dmChannel = idOf(0xd3, 2);
      const g = ds.peerCreate(PEER, dmChannel);
      ds.detach(ME.device);
      ds.peerCommit(g, PEER, [ME.device]); // seq 1, a Welcome for ME
      ds.peerSend(g, PEER, 'dm hello'); // seq 2
      ds.reattach(ME.device);
      d.engine.setExpected([{ groupId: g, communityId: null, channelId: dmChannel, policyVersion: 1n }]);
      d.gateway.ready(readyInfo(ME));
      await until(() => d.core.group(g)?.state === 2);
      await settle();
      expect(count('postResync')).toBe(0);
      expect(count('deleteWelcome')).toBe(1);
      expect(d.core.group(g)).toMatchObject({ state: 2, communityId: null, targetId: dmChannel });
      expect(d.core.bodies(g)).toEqual(['dm hello']);
    });

    // card 29 (Q25)
    it('deletes a Welcome that can never apply, then joins by external commit', async () => {
      const d = device(ds, clock, ME);
      const [eg] = channels(1);
      if (eg === undefined) throw new Error('no channel');
      ds.detach(ME.device);
      const forged = idOf(0x99, 9);
      await ds.routesFor(PEER.device).postCommit(eg.groupId, encode([
        0n, wire.commit(1n, PEER.device, [ME.device], []), wire.info(eg.groupId, 1n),
        [[ME.device, wire.welcome(forged, 1n)]], null,
      ])); // a Welcome whose joined group is another group: outcome 2 E_BINDING
      ds.reattach(ME.device);
      d.engine.setExpected([eg]);
      d.gateway.ready(readyInfo(ME));
      await until(() => d.core.group(eg.groupId)?.state === 2);
      expect(count('deleteWelcome')).toBe(1);
      expect(ds.welcomesFor(ME.device)).toEqual([]);
      expect(count('postResync')).toBe(1);
    });

    it('a Welcome for a group not yet expected is reported and kept; once expected, the welcome step joins it with no external commit (rule 7)', async () => {
      const d = device(ds, clock, ME);
      d.gateway.ready(readyInfo(ME));
      await settle();
      const dmChannel = idOf(0xd3, 3);
      const g = ds.peerCreate(PEER, dmChannel);
      ds.peerCommit(g, PEER, [ME.device]); // ME is attached: the instance serves the Welcome and fans out its mls.welcome frame
      await settle();
      expect(d.unexpected).toEqual([toHex(g)]);
      expect(count('deleteWelcome')).toBe(0);
      expect(ds.welcomesFor(ME.device)).toHaveLength(1);
      expect(d.core.group(g)).toBeUndefined();
      d.engine.setExpected([{ groupId: g, communityId: null, channelId: dmChannel, policyVersion: 1n }]);
      await until(() => d.core.group(g)?.state === 2);
      await settle();
      expect(count('postResync', g)).toBe(0);
      expect(count('getGroupInfo', g)).toBe(0);
      expect(count('deleteWelcome')).toBe(1);
      expect(ds.welcomesFor(ME.device)).toEqual([]);
      expect(d.core.group(g)).toMatchObject({ state: 2, communityId: null, targetId: dmChannel });
      expect(d.unexpected).toEqual([toHex(g)]);
      expect(at(d.joinAll, d.joinAll.length - 1)).toEqual({ done: 1, total: 1, failed: 0 });
    });

    it('judgeWelcomes reports each unexpected group once per pass and deletes none of them', async () => {
      const d = device(ds, clock, ME);
      const g = idOf(0x91, 7);
      const h = idOf(0x91, 8);
      await judgeWelcomes(d.engine, [
        { welcomeId: 1n, groupId: g, outcome: 3, reason: '' },
        { welcomeId: 2n, groupId: g, outcome: 3, reason: '' },
        { welcomeId: 3n, groupId: h, outcome: 3, reason: '' },
      ]);
      expect(d.unexpected).toEqual([toHex(g), toHex(h)]);
      expect(count('deleteWelcome')).toBe(0);
    });
  });

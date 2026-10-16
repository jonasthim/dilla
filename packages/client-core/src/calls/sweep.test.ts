// The boot sweep of leftover call groups (web3.7 3a-client, R32): sweepStaleCalls over a fake core and fake routes, and
// the CallController's memo and the join's bounded wait on the controller's own clock.
import { describe, expect, it } from 'vitest';
import type { CorePort, GroupInfo, Id } from '../core-port';
import { toHex } from '../hex';
import { DillaHttpError } from '../http/errors';
import type { ChannelCall } from '../http/routes';
import { ManualClock, settle } from '../sync/testing/model';
import { CallController, SWEEP_JOIN_WAIT_MS, type CallDeps } from './controller';
import { sweepStaleCalls, type SweepDeps } from './sweep';

const id = (b: number, n = 1): Id => { const x = new Uint8Array(16); x[0] = b; x[15] = n; return x; };
const ME = { userId: id(0x11), deviceId: id(0x12) };
const OTHER = id(0x22);
const G = id(0x9c, 1);
const CHANNEL = id(0xc5, 1);
const G2 = id(0x9c, 2);
const CHANNEL2 = id(0xc5, 2);
const httpError = (status: number, code = 'E_X'): DillaHttpError => new DillaHttpError({ status, code, detail: '', retryAfterMs: null, extra: [] });

/** A core holding call groups, logging what the sweep does to them (and whether it ran on the group's lane). */
class SweepCore {
  readonly log: string[] = [];
  lane: string | null = null;
  readonly rows: GroupInfo[] = [];
  hold(groupId: Id, targetId: Id, kind = 1, state: GroupInfo['state'] = 2): void {
    this.rows.push({ groupId, kind, communityId: id(0xcc), targetId, state, epoch: 3n, nextSeq: 1n, proposalsPending: 0, pendingCommit: false });
  }
  groups(): GroupInfo[] { this.log.push('groups'); return this.rows.map((r) => ({ ...r })); }
  groupRow(groupId: Id): GroupInfo | null { return this.rows.find((r) => toHex(r.groupId) === toHex(groupId)) ?? null; }
  callLeaveProposal(groupId: Id): Uint8Array { return new Uint8Array([0xaa, groupId[15]]); }
  callGroupForget(groupId: Id): void {
    this.log.push(`forget ${toHex(groupId)}${this.lane === toHex(groupId) ? ' on its lane' : ''}`);
    const row = this.groupRow(groupId);
    if (row !== null) row.state = 4;
  }
  sendBlockCode(): string | null { return null; }
}

interface Fakes {
  core: SweepCore;
  deps: SweepDeps;
  calls: { read: (channel: Id) => Promise<ChannelCall>; end: (call: Id) => Promise<boolean> };
  held: { group: Id | null };
  stop: { value: boolean };
  current: { core: SweepCore | null };
}

function fakes(): Fakes {
  const core = new SweepCore();
  const current: { core: SweepCore | null } = { core };
  const held: { group: Id | null } = { group: null };
  const stop = { value: false };
  const calls: Fakes['calls'] = {
    read: (channel: Id): Promise<ChannelCall> => Promise.resolve({ groupId: toHex(channel) === toHex(CHANNEL) ? G : G2, callId: channel,
      participants: [{ userId: ME.userId, deviceId: ME.deviceId, flags: 1 }] }),
    end: (): Promise<boolean> => Promise.resolve(true),
  };
  const deps: SweepDeps = {
    core: () => current.core as unknown as CorePort | null,
    me: () => ME,
    routes: {
      getChannelCall: (channel) => { core.log.push(`GET call ${toHex(channel)}`); return calls.read(channel); },
      endCallIfAlone: (call) => { core.log.push(`DELETE call ${toHex(call)}`); return calls.end(call); },
      postProposal: (groupId, body) => {
        core.log.push(`POST proposal ${toHex(groupId)} [${Array.from(body).join(',')}]${core.lane === toHex(groupId) ? ' on its lane' : ''}`);
        return Promise.resolve({ seq: 1n });
      },
    },
    serial: async <T>(groupId: Id, run: () => Promise<T>): Promise<T> => {
      core.lane = toHex(groupId);
      try { return await run(); } finally { core.lane = null; }
    },
    heldGroup: () => held.group,
    stopped: () => stop.value,
  };
  return { core, deps, calls, held, stop, current };
}

const routesOf = (log: string[]): string[] => log.filter((l) => l !== 'groups');
const g = toHex(G);
const c = toHex(CHANNEL);
const LEAVE = `POST proposal ${g} [170,1] on its lane`;
const FORGET = `forget ${g} on its lane`;

describe('sweepStaleCalls (web3.7 3a-client, R32)', () => {
  it('a leftover call that ends is only forgotten', async () => {
    const f = fakes();
    f.core.hold(G, CHANNEL);
    await sweepStaleCalls(f.deps);
    expect(routesOf(f.core.log)).toEqual([`GET call ${c}`, `DELETE call ${c}`, FORGET]);
  });

  it('a leftover call whose end answers 404 is only forgotten', async () => {
    const f = fakes();
    f.core.hold(G, CHANNEL);
    f.calls.end = () => Promise.reject(httpError(404, 'E_NOT_FOUND'));
    await sweepStaleCalls(f.deps);
    expect(routesOf(f.core.log)).toEqual([`GET call ${c}`, `DELETE call ${c}`, FORGET]);
  });

  it('a leftover call that does not end is left with a self-Remove', async () => {
    for (const end of [() => Promise.resolve(false), () => Promise.reject(httpError(409, 'E_CALL_NOT_ALONE'))]) {
      const f = fakes();
      f.core.hold(G, CHANNEL);
      f.calls.end = end;
      await sweepStaleCalls(f.deps);
      expect(routesOf(f.core.log)).toEqual([`GET call ${c}`, `DELETE call ${c}`, LEAVE, FORGET]);
    }
  });

  it('a failed end still sends the self-Remove', async () => {
    for (const status of [500, 0]) {
      const f = fakes();
      f.core.hold(G, CHANNEL);
      f.calls.end = () => Promise.reject(httpError(status));
      await sweepStaleCalls(f.deps);
      expect(routesOf(f.core.log)).toEqual([`GET call ${c}`, `DELETE call ${c}`, LEAVE, FORGET]);
    }
  });

  it('a leftover group with others in the call is left without ending it', async () => {
    const f = fakes();
    f.core.hold(G, CHANNEL);
    f.calls.read = () => Promise.resolve({ groupId: G, callId: CHANNEL, participants: [
      { userId: ME.userId, deviceId: ME.deviceId, flags: 1 }, { userId: id(0x21), deviceId: OTHER, flags: 1 }] });
    await sweepStaleCalls(f.deps);
    expect(routesOf(f.core.log)).toEqual([`GET call ${c}`, LEAVE, FORGET]);
  });

  it('a group the instance no longer names is forgotten', async () => {
    for (const named of [G2, null]) {
      const f = fakes();
      f.core.hold(G, CHANNEL);
      f.calls.read = () => Promise.resolve({ groupId: named, callId: null, participants: [] });
      await sweepStaleCalls(f.deps);
      expect(routesOf(f.core.log)).toEqual([`GET call ${c}`, FORGET]);
    }
  });

  it('the held group is never swept', async () => {
    const f = fakes();
    f.core.hold(G, CHANNEL);
    f.held.group = G;
    await sweepStaleCalls(f.deps);
    expect(routesOf(f.core.log)).toEqual([]);
  });

  it('a group the controller takes up while its read is in flight is not swept', async () => {
    const f = fakes();
    f.core.hold(G, CHANNEL);
    let answer: (read: ChannelCall) => void = () => {};
    f.calls.read = () => new Promise((resolve) => { answer = resolve; });
    const run = sweepStaleCalls(f.deps);
    await settle();
    f.held.group = G;
    answer({ groupId: G, callId: CHANNEL, participants: [] });
    await run;
    expect(routesOf(f.core.log)).toEqual([`GET call ${c}`]);
  });

  it('only active call groups are swept: text groups, and call groups not active, are left alone', async () => {
    const f = fakes();
    f.core.hold(id(0x70), CHANNEL, 0, 2);
    f.core.hold(id(0x71), CHANNEL, 1, 1);
    f.core.hold(id(0x72), CHANNEL, 1, 4);
    await sweepStaleCalls(f.deps);
    expect(routesOf(f.core.log)).toEqual([]);
  });

  it('sign-out during the sweep stops it', async () => {
    const f = fakes();
    f.core.hold(G, CHANNEL);
    f.core.hold(G2, CHANNEL2);
    let answer: (read: ChannelCall) => void = () => {};
    f.calls.read = () => new Promise((resolve) => { answer = resolve; });
    const run = sweepStaleCalls(f.deps);
    await settle();
    f.current.core = null;
    answer({ groupId: G, callId: CHANNEL, participants: [] });
    await expect(run).resolves.toBeUndefined();
    expect(routesOf(f.core.log)).toEqual([`GET call ${c}`]);
  });

  it('a stop between the end and the forget sends nothing more', async () => {
    const f = fakes();
    f.core.hold(G, CHANNEL);
    f.calls.end = () => { f.stop.value = true; return Promise.resolve(false); };
    await sweepStaleCalls(f.deps);
    expect(routesOf(f.core.log)).toEqual([`GET call ${c}`, `DELETE call ${c}`]);
  });

  it('an offline boot forgets nothing', async () => {
    const f = fakes();
    f.core.hold(G, CHANNEL);
    f.core.hold(G2, CHANNEL2);
    f.calls.read = () => Promise.reject(httpError(0, 'E_NETWORK'));
    await expect(sweepStaleCalls(f.deps)).resolves.toBeUndefined();
    // Offline: the first read fails and nothing more is read, ended, proposed or forgotten.
    expect(routesOf(f.core.log)).toEqual([`GET call ${c}`]);
  });

  it('a read refused for one group leaves that group and sweeps the next', async () => {
    const f = fakes();
    f.core.hold(G, CHANNEL);
    f.core.hold(G2, CHANNEL2);
    const read = f.calls.read;
    f.calls.read = (channel) => (toHex(channel) === c ? Promise.reject(httpError(500)) : read(channel));
    await sweepStaleCalls(f.deps);
    const g2 = toHex(G2);
    expect(routesOf(f.core.log)).toEqual([`GET call ${c}`, `GET call ${toHex(CHANNEL2)}`, `DELETE call ${toHex(CHANNEL2)}`, `forget ${g2} on its lane`]);
  });
});

// ---- the controller: the memo, the join's wait ----

function controller(f: Fakes, clock: ManualClock): { calls: CallController; tracked: Promise<unknown>[] } {
  const tracked: Promise<unknown>[] = [];
  const deps = {
    core: () => f.deps.core(),
    routes: {
      getChannelCall: (channel: Id) => f.deps.routes.getChannelCall(channel),
      endCallIfAlone: (call: Id) => f.deps.routes.endCallIfAlone(call),
      postProposal: (groupId: Id, body: Uint8Array) => f.deps.routes.postProposal(groupId, body),
    },
    post: () => {}, publish: () => {},
    errorOf: (e: unknown) => ({ code: e instanceof DillaHttpError ? e.code : 'E_INTERNAL', status: e instanceof DillaHttpError ? e.status : 0 }),
    now: clock.now, monotonic: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    randomId: () => id(0x55), me: () => ME, instance: () => ({ policyVersion: 1n, externalSenderPub: new Uint8Array(32) }),
    settings: () => ({}), nameOf: (u: string) => u,
    participant: () => { throw new Error('unused'); }, voiceChannels: () => [], known: () => true,
    callTarget: () => ({ communityId: toHex(id(0xcc)), members: [] }), communityListed: () => true,
    refreshLeaves: () => Promise.resolve(),
    serial: (groupId: Id, job: () => Promise<void>) => f.deps.serial(groupId, job),
    onCommitted: () => {}, afterJoin: () => {}, callEnded: () => {},
    track: (job: Promise<unknown>) => { tracked.push(job); },
  } as unknown as CallDeps;
  return { calls: new CallController(deps), tracked };
}

/** A join that, once past its wait, reads the channel's call and is refused there (500): what it reached is logged. */
function joinRefusedAtItsRead(f: Fakes, sweepRead: (channel: Id) => Promise<ChannelCall>): void {
  let n = 0;
  f.calls.read = (channel) => { n += 1; return n === 1 ? sweepRead(channel) : Promise.reject(httpError(500)); };
}

describe('CallController.startSweep and the join (web3.7 3a-client)', () => {
  it('a rejoin during the sweep waits', async () => {
    const f = fakes();
    const clock = new ManualClock();
    f.core.hold(G, CHANNEL);
    let answer: (read: ChannelCall) => void = () => {};
    joinRefusedAtItsRead(f, () => new Promise((resolve) => { answer = resolve; }));
    const { calls } = controller(f, clock);
    calls.startSweep();
    await settle();
    let settled = false;
    const join = calls.join(toHex(CHANNEL), 'vp8').finally(() => { settled = true; });
    join.catch(() => undefined);
    await settle();
    expect(settled).toBe(false);
    expect(routesOf(f.core.log)).toEqual([`GET call ${c}`]);
    answer({ groupId: G, callId: CHANNEL, participants: [] });
    await settle();
    await expect(join).rejects.toMatchObject({ status: 500 });
    // The sweep ended the call and forgot G before the join read anything.
    expect(routesOf(f.core.log)).toEqual([`GET call ${c}`, `DELETE call ${c}`, FORGET, `GET call ${c}`]);
  });

  it('the join waits at most 5 s', async () => {
    const f = fakes();
    const clock = new ManualClock();
    f.core.hold(G, CHANNEL);
    joinRefusedAtItsRead(f, () => new Promise(() => {}));
    const { calls } = controller(f, clock);
    calls.startSweep();
    await settle();
    const join = calls.join(toHex(CHANNEL), 'vp8');
    join.catch(() => undefined);
    await clock.advance(SWEEP_JOIN_WAIT_MS - 1);
    expect(routesOf(f.core.log)).toEqual([`GET call ${c}`]);
    await clock.advance(1);
    await settle();
    await expect(join).rejects.toMatchObject({ status: 500 });
    expect(SWEEP_JOIN_WAIT_MS).toBe(5000);
    // Past the bound the join reads on its own; the stuck sweep's read is still in flight.
    expect(routesOf(f.core.log)).toEqual([`GET call ${c}`, `GET call ${c}`]);
    expect(clock.pending).toBe(0);
  });

  it('a join after the sweep, or with none, does not wait', async () => {
    const f = fakes();
    const clock = new ManualClock();
    joinRefusedAtItsRead(f, () => Promise.reject(httpError(500)));
    const { calls } = controller(f, clock);
    const first = calls.join(toHex(CHANNEL), 'vp8');
    await expect(first).rejects.toMatchObject({ status: 500 });
    expect(clock.pending).toBe(0);
  });

  it('a leave during the wait cancels the join at once, and nothing of the join is sent', async () => {
    const f = fakes();
    const clock = new ManualClock();
    f.core.hold(G, CHANNEL);
    joinRefusedAtItsRead(f, () => new Promise(() => {}));
    const { calls } = controller(f, clock);
    calls.startSweep();
    await settle();
    const join = calls.join(toHex(CHANNEL), 'vp8');
    join.catch(() => undefined);
    await settle();
    await calls.leave();
    await expect(join).rejects.toMatchObject({ code: 'E_NO_CALL' });
    expect(routesOf(f.core.log)).toEqual([`GET call ${c}`]);
    expect(clock.pending).toBe(0);
  });

  it('a late pagehide leave does nothing more', async () => {
    const f = fakes();
    const clock = new ManualClock();
    f.core.hold(G, CHANNEL);
    f.calls.end = () => Promise.resolve(false);
    const { calls } = controller(f, clock);
    calls.startSweep();
    await settle();
    expect(routesOf(f.core.log)).toEqual([`GET call ${c}`, `DELETE call ${c}`, LEAVE, FORGET]);
    await calls.leave();
    await settle();
    expect(routesOf(f.core.log).filter((l) => l.startsWith('POST proposal'))).toHaveLength(1);
  });

  it('sign-out during the sweep stops it', async () => {
    const f = fakes();
    const clock = new ManualClock();
    f.core.hold(G, CHANNEL);
    let answer: (read: ChannelCall) => void = () => {};
    f.calls.read = () => new Promise((resolve) => { answer = resolve; });
    const { calls } = controller(f, clock);
    calls.startSweep();
    await settle();
    await calls.shutdown();
    answer({ groupId: G, callId: CHANNEL, participants: [] });
    await settle();
    expect(routesOf(f.core.log)).toEqual([`GET call ${c}`]);
  });

  it('a reset (the core detached) during the sweep stops it', async () => {
    const f = fakes();
    const clock = new ManualClock();
    f.core.hold(G, CHANNEL);
    let answer: (read: ChannelCall) => void = () => {};
    f.calls.read = () => new Promise((resolve) => { answer = resolve; });
    const { calls } = controller(f, clock);
    calls.startSweep();
    await settle();
    calls.reset();
    answer({ groupId: G, callId: CHANNEL, participants: [] });
    await settle();
    expect(routesOf(f.core.log)).toEqual([`GET call ${c}`]);
  });

  it('an offline boot forgets nothing; the next start sweeps again, and the join is not held by the deferred sweep', async () => {
    const f = fakes();
    const clock = new ManualClock();
    f.core.hold(G, CHANNEL);
    const read = f.calls.read;
    f.calls.read = () => Promise.reject(httpError(0, 'E_NETWORK'));
    const { calls } = controller(f, clock);
    calls.startSweep();
    await settle();
    expect(routesOf(f.core.log)).toEqual([`GET call ${c}`]);
    // The deferred sweep holds no join: it reads at once.
    f.calls.read = () => Promise.reject(httpError(500));
    await expect(calls.join(toHex(CHANNEL), 'vp8')).rejects.toMatchObject({ status: 500 });
    expect(clock.pending).toBe(0);
    // The first online: the sweep runs again and leaves G.
    f.calls.read = read;
    calls.startSweep();
    await settle();
    expect(routesOf(f.core.log)).toEqual([`GET call ${c}`, `GET call ${c}`, `GET call ${c}`, `DELETE call ${c}`, FORGET]);
  });

  it('the new leader sweeps after a handover, once', async () => {
    const f = fakes();
    const clock = new ManualClock();
    const { calls } = controller(f, clock);
    calls.startSweep();
    calls.startSweep();
    await settle();
    calls.startSweep();
    await settle();
    expect(f.core.log.filter((l) => l === 'groups')).toHaveLength(1);
    // A re-ready (the core detached and attached again: a handover, a forced factor set-up) sweeps again (contract 6).
    calls.reset();
    calls.startSweep();
    calls.startSweep();
    await settle();
    expect(f.core.log.filter((l) => l === 'groups')).toHaveLength(2);
  });

  it('a sweep error does not fail the join', async () => {
    const f = fakes();
    const clock = new ManualClock();
    f.core.hold(G, CHANNEL);
    // The sweep's read names no group, so it forgets G on G's lane, which fails.
    joinRefusedAtItsRead(f, () => {
      f.deps.serial = () => Promise.reject(new Error('the lane broke'));
      return Promise.resolve({ groupId: null, callId: null, participants: [] });
    });
    const { calls } = controller(f, clock);
    calls.startSweep();
    const join = calls.join(toHex(CHANNEL), 'vp8');
    // The join's own refusal (its read's 500), never the sweep's error.
    await expect(join).rejects.toMatchObject({ status: 500 });
    expect(clock.pending).toBe(0);
  });
});

/** Test support for src/sync: one engine wired to ModelCore, ModelDs and FakeGateway. */
import type { ApplyResult, Id } from '../../core-port';
import type { ReadyInfo } from '../../gateway/gateway';
import { toHex } from '../../hex';
import type { Instance } from '../../http/routes';
import { SyncEngine } from '../engine';
import { CHANNEL, COMMUNITY, FakeGateway, ModelCore, PEER, idOf, settle, type ManualClock, type ModelDs, type Peer } from './model';

export const INSTANCE: Instance = {
  instanceId: idOf(0xa0, 1), generation: 1n, name: 'model', registrationMode: 0, authMethods: [0], policyVersion: 1n,
  externalSenderPub: new Uint8Array(32).fill(7),
};

export interface Device {
  readonly me: Peer;
  readonly core: ModelCore;
  readonly gateway: FakeGateway;
  readonly engine: SyncEngine;
  readonly changes: { group: string; result: ApplyResult }[];
  readonly outboxChanges: string[];
  readonly membership: { group: string; status: 'resyncing' | 'not-member' }[];
}

/** An engine for me, started, with its gateway attached to ds's fan-out. random() always answers `random`. */
export function device(ds: ModelDs, clock: ManualClock, me: Peer, random = 0.5): Device {
  const core = new ModelCore(me);
  const gateway = new FakeGateway();
  const changes: Device['changes'] = [];
  const outboxChanges: string[] = [];
  const membership: Device['membership'] = [];
  ds.attach(me.device, (f) => {
    gateway.frame(f);
  });
  const engine = new SyncEngine({
    core,
    routes: ds.routesFor(me.device),
    gateway,
    instance: INSTANCE,
    deviceId: me.device,
    now: clock.now,
    random: () => random,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onGroupChanged: (groupId, result) => {
      changes.push({ group: toHex(groupId), result });
    },
    onOutboxChanged: (groupId) => {
      outboxChanges.push(toHex(groupId));
    },
    onMembership: (groupId, status) => {
      membership.push({ group: toHex(groupId), status });
    },
  });
  engine.start();
  return { me, core, gateway, engine, changes, outboxChanges, membership };
}

export function readyInfo(me: Peer, groups: ReadyInfo['groups'] = []): ReadyInfo {
  return {
    deviceId: me.device, userId: me.user, generation: 1n, keypackagesRemaining: 32, groups, heartbeatMs: 30000, maxFrameBytes: 131584,
    backoffMs: 300, backoffJitterMs: 300,
  };
}

/** Registers the channel's group through the engine, makes PEER a member, and clears both call logs. */
export async function openRegistered(ds: ModelDs, d: Device, channelId: Id = CHANNEL): Promise<Id> {
  const r = await d.engine.openChannel({ communityId: COMMUNITY, channelId, textGroupId: null });
  if (r.state !== 2) throw new Error(`registration left state ${String(r.state)}`);
  await settle();
  ds.join(r.groupId, PEER.device);
  d.core.resetLog();
  ds.resetCalls();
  return r.groupId;
}

/** The names of d's core calls for groupId that are in names, in call order. */
export function coreCalls(d: Device, groupId: Id, names: readonly string[]): string[] {
  const g = toHex(groupId);
  return d.core.calls.filter((c) => c.g === g && names.includes(c.m)).map((c) => c.m);
}

export function catchSync(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

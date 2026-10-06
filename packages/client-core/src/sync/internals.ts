import type { ApplyResult, ExpectedGroup, GroupInfo, Id } from '../core-port';
import type { SyncDeps } from './engine';
import type { SerialQueues } from './group-queue';

export interface SyncInternals {
  readonly deps: SyncDeps;
  readonly queues: SerialQueues;
  stopped(): boolean;
  row(groupId: Id): GroupInfo | undefined;
  snapshot(groupId: Id): ApplyResult | null;
  expected(): ExpectedGroup[];
  addExpected(g: ExpectedGroup): void;
  catchUpNow(groupId: Id, source: 'catch-up' | 'commit'): Promise<boolean>;
  applyHook(groupId: Id, result: ApplyResult, source: 'frame' | 'catch-up' | 'commit'): Promise<void>;
  requestCatchUp(groupId: Id): void;
  requestDrain(groupId: Id): void;
  requestCommit(groupId: Id, attempt: number): void;
  commitNow(groupId: Id, attempt: number): Promise<boolean>;
  activate(groupId: Id): Promise<void>;
  pollWelcomes(): Promise<void>;
  armTimer(ms: number, fn: () => void): number;
  cancelTimer(id: number): void;
  echoWait: Map<string, { msgHex: string; timer: number }>;
  epochWait: Map<string, number>;
  count425: Map<string, number>;
  resyncTried: Set<string>;
  quiet: Set<string>;
}

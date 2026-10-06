// The messages between the page and the core worker (L-TS-09).
import type { SliceName, WorkerError } from '../state/types';

export type Command =
  | { m: 'start' }
  | { m: 'signupBegin' }
  | { m: 'signupSubmit'; invite: string; username: string; display: string; password: string | null; recoveryKeyAcknowledged: true }
  | { m: 'signupReset' }
  | { m: 'resetDevice' }
  | { m: 'joinCommunity'; invite: string }
  | { m: 'selectCommunity'; communityId: string }
  | { m: 'openChannel'; channelId: string }
  | { m: 'closeChannel'; channelId: string }
  | { m: 'loadEarlier'; channelId: string }
  | { m: 'send'; channelId: string; text: string }
  | { m: 'retrySend'; msgId: string }
  | { m: 'discardSend'; msgId: string };
export type ToWorker = { t: 'call'; id: number; command: Command };
export type FromWorker =
  | { t: 'ret'; id: number; ok: true; value: unknown }
  | { t: 'ret'; id: number; ok: false; error: WorkerError }
  | { t: 'slice'; name: SliceName; rev: number; value: unknown };
/** Not part of ToWorker. Honoured only by a worker started with { testHooks: true }, which only
 *  packages/client-core/harness/worker.ts does; src/worker/entry.ts (what createCoreWorker() loads) passes false. */
export type TestHook = { t: 'test'; op: 'gateway-stop' | 'gateway-start' };
export const LOCK_PREFIX = 'dilla-core:';        // + instance id hex

function isRecord(data: unknown): data is Record<string, unknown> {
  return typeof data === 'object' && data !== null;
}

/** A call envelope: t 'call', a non-negative safe integer id and a command object with a string m. The
 *  command's own fields are checked by the controller. */
export function isToWorker(data: unknown): data is ToWorker {
  if (!isRecord(data) || data.t !== 'call') return false;
  const { id, command } = data;
  return typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 && isRecord(command) && typeof command.m === 'string';
}

export function isTestHook(data: unknown): data is TestHook {
  return isRecord(data) && data.t === 'test' && (data.op === 'gateway-stop' || data.op === 'gateway-start');
}

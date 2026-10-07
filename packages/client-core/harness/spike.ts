// The SP-W201 messages between the harness page and the harness worker (plan web-2a task 13). Test-only:
// the production worker (src/worker/entry.ts) never posts or reads them. No DOM or WebWorker type is used
// here, so both TypeScript programs (tsconfig.json, tsconfig.worker.json) can import this file.
export const SPIKE_GROUPS_RUNS = 20;
export type SpikeRequest = { t: 'spike'; op: 'time-groups' };
export type SpikeEvent =
  | { t: 'spike'; kind: 'join-all'; done: number; total: number; failed: number }
  | { t: 'spike'; kind: 'sweep'; groups: number; ms: number }
  | { t: 'spike'; kind: 'groups'; ok: boolean; rows: number; medianMs: number; maxMs: number; routeCalls: { before: number; after: number } };

function isRecord(data: unknown): data is Record<string, unknown> {
  return typeof data === 'object' && data !== null;
}
export function isSpikeRequest(data: unknown): data is SpikeRequest {
  return isRecord(data) && data.t === 'spike' && data.op === 'time-groups';
}
export function isSpikeEvent(data: unknown): data is SpikeEvent {
  return isRecord(data) && data.t === 'spike' && (data.kind === 'join-all' || data.kind === 'sweep' || data.kind === 'groups');
}

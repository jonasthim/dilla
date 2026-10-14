// The call’s connection report (protocol/09 § Call stats, L-TS-50 callStats): the selected candidate’s type, the
// relay transport, the round-trip time, the loss, and the frames that failed to decrypt and that were encrypted
// since the previous report. Counts only: no key, no identity, no address.
import type { CallStatsReport } from '@dilla/client-core';
import type { DillaMediaStats } from '@dilla/media';

/** One report per 10 s while connected (the instance accepts one per 5 s, 429 above). */
export const STATS_EVERY_MS = 10_000;
const FRAMES_MAX = 1_048_576;
const RTT_MAX = 60_000;
const CANDIDATE: Record<string, number> = { host: 0, srflx: 1, prflx: 2, relay: 3 };
const RELAY: Record<string, number> = { udp: 0, tcp: 1, tls: 2 };
/** The drops that mean a frame failed authentication; an unknown KID is an epoch race, not a failure. */
const DECRYPT_FAILURES = ['aeadFail', 'foreignLeaf', 'senderMismatch'] as const;

export interface Connection { candidateType: number; relayProtocol: number | null; rttMs: number; lossPermille: number }
export interface MediaTotals { sent: number; failed: number }

type Entry = Record<string, unknown>;
type StatsLike = { forEach(fn: (value: unknown, key: string) => void): void; get(key: string): unknown };

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function connectionOf(report: StatsLike | null | undefined): Connection {
  const out: Connection = { candidateType: 0, relayProtocol: null, rttMs: 0, lossPermille: 0 };
  if (!report) return out;
  const entries: Entry[] = [];
  report.forEach((v) => { if (typeof v === 'object' && v !== null) entries.push(v as Entry); });
  const byId = (id: unknown): Entry | undefined => (typeof id === 'string' ? (report.get(id) as Entry | undefined) : undefined);
  const transport = entries.find((e) => e.type === 'transport' && typeof e.selectedCandidatePairId === 'string');
  const pair = byId(transport?.selectedCandidatePairId)
    ?? entries.find((e) => e.type === 'candidate-pair' && e.nominated === true && e.state === 'succeeded')
    ?? entries.find((e) => e.type === 'candidate-pair' && e.selected === true);
  if (pair) {
    const rtt = num(pair.currentRoundTripTime);
    if (rtt !== null) out.rttMs = Math.min(RTT_MAX, Math.max(0, Math.round(rtt * 1000)));
    const local = byId(pair.localCandidateId);
    const type = typeof local?.candidateType === 'string' ? CANDIDATE[local.candidateType] : undefined;
    if (type !== undefined) out.candidateType = type;
    if (type === 3 && typeof local?.relayProtocol === 'string') out.relayProtocol = RELAY[local.relayProtocol] ?? null;
  }
  const losses = entries.filter((e) => e.type === 'remote-inbound-rtp').map((e) => num(e.fractionLost)).filter((v): v is number => v !== null);
  if (losses.length > 0) out.lossPermille = Math.min(1000, Math.max(0, Math.round(Math.max(...losses) * 1000)));
  return out;
}

export function mediaTotals(s: DillaMediaStats | null | undefined): MediaTotals {
  let sent = 0;
  let failed = 0;
  for (const slots of Object.values(s?.encrypted ?? {})) for (const n of Object.values(slots ?? {})) sent += num(n) ?? 0;
  const dropped = (s?.dropped ?? {}) as Partial<Record<string, number>>;
  for (const reason of DECRYPT_FAILURES) failed += num(dropped[reason]) ?? 0;
  return { sent, failed };
}

const since = (now: number, before: number): number => Math.min(FRAMES_MAX, Math.max(0, now >= before ? now - before : now));

/** The report and the totals the next report counts from. A counter that went down (a fresh worker) counts from 0. */
export function callStatsReport(c: Connection, totals: MediaTotals, previous: MediaTotals): { report: CallStatsReport; totals: MediaTotals } {
  return {
    report: [c.candidateType, c.relayProtocol, c.rttMs, c.lossPermille, since(totals.failed, previous.failed), since(totals.sent, previous.sent)],
    totals,
  };
}

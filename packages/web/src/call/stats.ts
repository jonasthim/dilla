// The call’s connection report (protocol/09 § Call stats, L-TS-50 callStats): the selected candidate’s type, the
// relay transport, the round-trip time, the loss, and the frames that failed to decrypt and that were encrypted
// since the previous report. Counts only: no key, no identity, no address.
import type { CallStatsReport } from '@dilla/client-core';
import type { DillaMediaStats } from '@dilla/media';

/** One report per 10 s while connected (the instance accepts one per 5 s, 429 above). */
export const STATS_EVERY_MS = 10_000;
/** The dock’s own link read (MP5): the ping and the rates, every 2 s while connected; apart from the server report. */
export const LINK_EVERY_MS = 2_000;
/** A link read that has not settled after this long takes the stats away until it does. */
export const LINK_STALL_MS = 5_000;
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

export const connectionOf = (report: StatsLike | null | undefined): Connection => inspect(report).connection;
/** The round-trip time of the selected candidate pair in ms; null without a pair or a reading. */
const rttOf = (report: StatsLike | null | undefined): number | null => { const r = inspect(report); return r.rttKnown ? r.connection.rttMs : null; };

function inspect(report: StatsLike | null | undefined): { connection: Connection; rttKnown: boolean } {
  const out: Connection = { candidateType: 0, relayProtocol: null, rttMs: 0, lossPermille: 0 };
  let rttKnown = false;
  if (!report) return { connection: out, rttKnown };
  const entries: Entry[] = [];
  report.forEach((v) => { if (typeof v === 'object' && v !== null) entries.push(v as Entry); });
  const byId = (id: unknown): Entry | undefined => (typeof id === 'string' ? (report.get(id) as Entry | undefined) : undefined);
  const transport = entries.find((e) => e.type === 'transport' && typeof e.selectedCandidatePairId === 'string');
  const pair = byId(transport?.selectedCandidatePairId)
    ?? entries.find((e) => e.type === 'candidate-pair' && e.nominated === true && e.state === 'succeeded')
    ?? entries.find((e) => e.type === 'candidate-pair' && e.selected === true);
  if (pair) {
    const rtt = num(pair.currentRoundTripTime);
    if (rtt !== null) { out.rttMs = Math.min(RTT_MAX, Math.max(0, Math.round(rtt * 1000))); rttKnown = true; }
    const local = byId(pair.localCandidateId);
    const type = typeof local?.candidateType === 'string' ? CANDIDATE[local.candidateType] : undefined;
    if (type !== undefined) out.candidateType = type;
    if (type === 3 && typeof local?.relayProtocol === 'string') out.relayProtocol = RELAY[local.relayProtocol] ?? null;
  }
  const losses = entries.filter((e) => e.type === 'remote-inbound-rtp').map((e) => num(e.fractionLost)).filter((v): v is number => v !== null);
  if (losses.length > 0) out.lossPermille = Math.min(1000, Math.max(0, Math.round(Math.max(...losses) * 1000)));
  return { connection: out, rttKnown };
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

/** What the dock shows of the link (MP5): the ping, what this device sends and receives in kb/s, and the loss. */
export interface LinkSample { rttMs: number; upKbps: number; downKbps: number; lossPct: number }
interface InboundTotals { bytes: number; recv: number; lost: number }
/** One peer connection’s RTP counters per stream id, and how many reads in a row gave no data for it. */
interface SideTotals { out: Record<string, number>; inn: Record<string, InboundTotals>; gap: number }
/** What the next link read counts from, per peer connection and per stream; null before the first read. */
export interface LinkTotals { pub: SideTotals | null; sub: SideTotals | null }

/** The dock’s quality word: good under 150 ms; poor from 150 to 300 ms; bad above 300 ms or above 5 % loss. */
export function linkQuality(rttMs: number, lossPct: number): 'good' | 'poor' | 'bad' {
  return rttMs > 300 || lossPct > 5 ? 'bad' : rttMs >= 150 ? 'poor' : 'good';
}

function countersOf(report: StatsLike): Omit<SideTotals, 'gap'> {
  const out: Record<string, number> = {};
  const inn: Record<string, InboundTotals> = {};
  report.forEach((v, key) => {
    if (typeof v !== 'object' || v === null) return;
    const e = v as Entry;
    const id = typeof e.id === 'string' ? e.id : key;
    if (e.type === 'outbound-rtp') out[id] = num(e.bytesSent) ?? 0;
    else if (e.type === 'inbound-rtp') inn[id] = { bytes: num(e.bytesReceived) ?? 0, recv: num(e.packetsReceived) ?? 0, lost: Math.max(0, num(e.packetsLost) ?? 0) };
  });
  return { out, inn };
}

/** A counter that went down (a new stream under the same id) counts from 0. */
const delta = (now: number, before: number): number => (now >= before ? now - before : now);

/**
 * One local link read (the dock’s 2 s poll, not the 10 s server report). Up is all outbound RTP, down all inbound RTP, as
 * kb/s from the byte deltas per stream id over `dtMs`: a stream that appears or disappears adds no delta, and a missing
 * report (a failed getStats) is no data for that side, so its previous totals stay and the next read spans the gap. The first
 * read, with no previous totals, is only a baseline: no sample. The ping is the publisher’s selected pair, else the
 * subscriber’s. Loss is the worse of what the server reports of our upstream (remote-inbound-rtp) and the packets lost of
 * each incoming stream over the interval.
 */
export function linkSample(
  previous: LinkTotals | null, publisher: StatsLike | null | undefined, subscriber: StatsLike | null | undefined, dtMs: number,
): { sample: LinkSample | null; totals: LinkTotals } {
  let upBits = 0;
  let downBits = 0;
  let inLoss = 0;
  let based = false;
  const next = (before: SideTotals | null | undefined, report: StatsLike | null | undefined): SideTotals | null => {
    const prev = before ?? null;
    if (!report) return prev === null ? null : { ...prev, gap: prev.gap + 1 };
    const now = countersOf(report);
    if (prev !== null) {
      based = true;
      const ms = dtMs * (1 + prev.gap);
      let sent = 0;
      let received = 0;
      for (const [id, bytes] of Object.entries(now.out)) if (id in prev.out) sent += delta(bytes, prev.out[id] ?? 0);
      for (const [id, s] of Object.entries(now.inn)) {
        const was = prev.inn[id];
        if (was === undefined) continue;
        received += delta(s.bytes, was.bytes);
        if (s.recv >= was.recv && s.lost >= was.lost) {
          const lost = s.lost - was.lost;
          const total = s.recv - was.recv + lost;
          if (total > 0) inLoss = Math.max(inLoss, (lost / total) * 100);
        }
      }
      if (ms > 0) { upBits += sent * 8 / ms; downBits += received * 8 / ms; }
    }
    return { ...now, gap: 0 };
  };
  const totals: LinkTotals = { pub: next(previous?.pub, publisher), sub: next(previous?.sub, subscriber) };
  const rttMs = rttOf(publisher) ?? rttOf(subscriber);
  if (!based || rttMs === null) return { sample: null, totals };
  const outLoss = Math.max(connectionOf(publisher).lossPermille, connectionOf(subscriber).lossPermille) / 10;
  return {
    sample: { rttMs, lossPct: Math.round(Math.max(outLoss, inLoss) * 10) / 10, upKbps: Math.round(upBits), downKbps: Math.round(downBits) },
    totals,
  };
}
